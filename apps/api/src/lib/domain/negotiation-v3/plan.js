// ─── negotiation-v3/plan.js ─────────────────────────────────────────────────
// Negotiation Intelligence v3 (§41–58). Pure, deterministic, no I/O.
//   buildNegotiationPlan(ctx)                → ceiling / target / anchor / ladder / autonomous limit
//   nextNegotiationMove(plan, state, event)  → QUOTE | HOLD | HUMAN | CLOSE_UNREALISTIC | NO_NUMBER
// Formulas and parameters: config.js. Authority: authority.js (never computes value).

import { NEGOTIATION_V3_DEFAULTS, NEGOTIATION_V3_VERSION, NEGOTIATION_V3_CONFIG_VERSION } from "./config.js";
import { resolvePlanAuthority } from "./authority.js";
import { resolveNegotiationFlags } from "./flags.js";
import { LANGUAGE_BRANCHES, sellerFacingReply, supportiveComps } from "./disclosure.js";

export const NEGOTIATION_ACTIONS = Object.freeze({
  QUOTE: "QUOTE",
  HOLD: "HOLD",
  HUMAN: "HUMAN",
  CLOSE_UNREALISTIC: "CLOSE_UNREALISTIC",
  NO_NUMBER: "NO_NUMBER",
});

export const QUOTE_TYPES_V3 = Object.freeze({
  NEGOTIATION_ANCHOR: "NEGOTIATION_ANCHOR",
  CONCESSION: "CONCESSION",
  FORMAL_OFFER: "FORMAL_OFFER",
  NO_NUMBER: "NO_NUMBER",
});

export { LANGUAGE_BRANCHES };

const A = NEGOTIATION_ACTIONS;
const Q = QUOTE_TYPES_V3;
const L = LANGUAGE_BRANCHES;

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function clean(value) {
  return String(value ?? "").trim();
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r4 = (v) => Math.round(v * 10_000) / 10_000;

function mergeConfig(overrides = null) {
  const o = overrides || {};
  const d = NEGOTIATION_V3_DEFAULTS;
  return {
    ...d,
    ...o,
    anchor: { ...d.anchor, ...(o.anchor || {}) },
    ladder: { ...d.ladder, ...(o.ladder || {}), shares: o.ladder?.shares || d.ladder.shares },
    comp_claim: { ...d.comp_claim, ...(o.comp_claim || {}) },
    mf: { ...d.mf, ...(o.mf || {}) },
    autonomy: { ...d.autonomy, ...(o.autonomy || {}) },
    anchor_floor: { ...d.anchor_floor, ...(o.anchor_floor || {}), by_lane: { ...d.anchor_floor.by_lane, ...(o.anchor_floor?.by_lane || {}) }, by_market_lane: { ...d.anchor_floor.by_market_lane, ...(o.anchor_floor?.by_market_lane || {}) } },
    lanes: { ...d.lanes, ...Object.fromEntries(Object.entries(o.lanes || {}).map(([k, v]) => [k, { ...(d.lanes[k] || {}), ...v }])) },
    lane_backtest_passed: { ...d.lane_backtest_passed, ...(o.lane_backtest_passed || {}) },
    rounding: o.rounding || d.rounding,
  };
}

function stepFor(value, rounding) {
  const rule = rounding.find((r) => value >= r.at_or_above) || rounding[rounding.length - 1];
  return rule.step;
}
export function roundDownMoney(value, rounding = NEGOTIATION_V3_DEFAULTS.rounding) {
  const v = num(value);
  if (v == null || v <= 0) return null;
  const s = stepFor(v, rounding);
  return Math.floor(v / s) * s;
}
export function roundUpMoney(value, rounding = NEGOTIATION_V3_DEFAULTS.rounding) {
  const v = num(value);
  if (v == null || v <= 0) return null;
  const s = stepFor(v, rounding);
  return Math.ceil(v / s) * s;
}

// ═══════════════════════════════════════════════════════════════════════════
// ASSET + UNITS (§52–54)
// ═══════════════════════════════════════════════════════════════════════════
const MF_TYPE_RE = /multi|duplex|triplex|fourplex|quadplex|apartment|2-4|5\+/i;
const SFR_TYPE_RE = /single|sfr|residential|house|condo|town/i;

/**
 * Per-unit math needs a valid POSITIVE INTEGER unit count ≥ 2 from a source that
 * does not contradict another (§54). Unknown or conflicting units ⇒ units:null
 * ⇒ no per-unit math, no guessed units, no money.
 */
export function resolvePlanAsset({ property = {}, authority = {} } = {}) {
  const out = resolveAssetKind({ property, authority });
  const laneFromUnits = out.units != null ? (out.units >= 5 ? "mf5" : "mf24") : null;
  const lane = authority?.lane || (out.asset === "sfr" ? "sfr" : laneFromUnits);
  return { ...out, lane: lane || null };
}

function resolveAssetKind({ property = {}, authority = {} } = {}) {
  const type = clean(property?.property_type);
  const pUnits = num(property?.units_count ?? property?.unit_count);
  const eUnits = num(authority?.units);
  const family = clean(authority?.asset_family).toLowerCase();
  const aType = clean(authority?.asset_type).toLowerCase();
  const mfSignal =
    family === "multifamily" || aType === "multifamily" || MF_TYPE_RE.test(type) || (pUnits != null && pUnits > 1) || (eUnits != null && eUnits > 1);
  if (mfSignal) {
    const reasons = [];
    if (authority?.asset_identity_conflict) reasons.push("asset_identity_conflict");
    const candidates = [pUnits, eUnits].filter((u) => u != null);
    const valid = candidates.filter((u) => Number.isInteger(u) && u >= 2);
    if (!candidates.length) reasons.push("unit_count_unknown");
    else if (valid.length !== candidates.length) reasons.push("unit_count_invalid_for_multifamily");
    else if (new Set(valid).size > 1) reasons.push("unit_count_sources_disagree");
    const units = reasons.length ? null : valid[0];
    return {
      asset: "multifamily",
      units,
      unit_source: units == null ? null : pUnits != null && eUnits != null ? "property_and_engine_agree" : pUnits != null ? "property_record" : "engine_subject",
      reasons,
    };
  }
  if (aType === "single_family" || SFR_TYPE_RE.test(type) || family === "residential") {
    return { asset: "sfr", units: null, unit_source: null, reasons: [] };
  }
  return { asset: "unknown", units: null, unit_source: null, reasons: ["asset_class_unknown"] };
}

// ═══════════════════════════════════════════════════════════════════════════
// SITUATION → STRATEGY (§56, §57) — A1 contract CONTRACT_seller_situation.md
// ═══════════════════════════════════════════════════════════════════════════
const SITUATION_ANGLES = Object.freeze({
  FATIGUED_LANDLORD: "TENANT_RELIEF",
  FINANCIALLY_PRESSURED: "SPEED_CERTAINTY",
  TAX_DISTRESSED: "SPEED_CERTAINTY",
  INHERITED_PROBATE: "CONVENIENCE",
  HIGH_REPAIR_BURDEN: "AS_IS_NO_REPAIRS",
  EQUITY_RICH_ABSENTEE: "CONVENIENCE",
  WEALTH_PRESERVATION: "SELLER_FINANCE",
  NO_CLEAR_SITUATION: null,
});
const CREATIVE_ANGLES = new Set(["SELLER_FINANCE", "LEASE_OPTION", "TAX_FLEXIBILITY"]);

function pressureOf(situation = null) {
  const c = situation?.components || {};
  const vals = [c.forced_sale_pressure, c.tax_pain, c.debt_pressure].map(num).filter((v) => v != null);
  return vals.length ? Math.max(...vals) : null;
}

/**
 * Strategy is for template choice (angle) and for shaping the anchor / step
 * size. It is never seller-visible ("we know you're behind on taxes" is never
 * said) and it never touches ceiling, target, autonomous limit or floor.
 */
export function resolveStrategy({ situation = null, seller = {}, config = NEGOTIATION_V3_DEFAULTS } = {}) {
  const code = clean(situation?.seller_situation).toUpperCase() || null;
  const pressure = pressureOf(situation);
  const fatigue = num(situation?.components?.landlord_fatigue);
  const equity = num(situation?.components?.equity_unlock);
  const stated = (Array.isArray(seller?.stated_motivation) ? seller.stated_motivation : []).map((s) => clean(s).toLowerCase());
  const reasons = [];
  // A1's angle is evidence-gated; prefer it. Fall back to the situation map.
  let angle = clean(situation?.conversation_angle).toUpperCase() || (code ? SITUATION_ANGLES[code] ?? null : null);
  const sellerCreative = stated.some((s) => /capital_gains|tax|cash_flow|income|monthly/.test(s));
  // Creative only with SUPPORTING evidence (§55): A1 angle, or the seller's own words.
  const creative_probe = sellerCreative || (angle != null && CREATIVE_ANGLES.has(angle) && (code === "WEALTH_PRESERVATION" || sellerCreative));
  if (angle && CREATIVE_ANGLES.has(angle) && !creative_probe) {
    reasons.push("creative_angle_without_supporting_evidence_dropped");
    angle = null;
  }
  const high_pressure = pressure != null && pressure >= config.anchor.pressure_threshold;
  const equity_rich_low_urgency =
    (code === "EQUITY_RICH_ABSENTEE" || code === "WEALTH_PRESERVATION" || (equity != null && equity >= 60)) && !high_pressure;
  if (high_pressure) reasons.push(`pressure_${pressure}`);
  if (equity_rich_low_urgency) reasons.push("equity_rich_low_urgency_no_distress_assumed");
  return {
    situation: code,
    score_version: clean(situation?.score_version) || null,
    angle,
    creative_probe,
    pressure,
    fatigue,
    high_pressure,
    equity_rich_low_urgency,
    evidence_codes: (Array.isArray(situation?.evidence) ? situation.evidence : []).map((e) => clean(e?.code)).filter(Boolean).slice(0, 12),
    reasons,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ANCHOR (§44–45)
// ═══════════════════════════════════════════════════════════════════════════
/**
 * d = clamp(d_base + Σ adj, d_min, d_max);  O = roundDown(T × (1 − d));
 * O = max(O, roundUp(AF));  O ≤ T;  O < ask (if an ask is known). AF = investor-price floor (may be null).
 * Returns null amount when no anchor below the ask exists (ask ≤ floor/anchor).
 */
export function computeAnchor({ target, anchor_floor = null, ask = null, strategy = {}, seller = {}, market = {}, config = NEGOTIATION_V3_DEFAULTS } = {}) {
  const cfg = config.anchor;
  const T = num(target);
  const F = num(anchor_floor);
  if (T == null || T <= 0) return { amount: null, d: null, adjustments: [], reason: "no_target" };
  const adjustments = [];
  const add = (code, value) => {
    if (value) adjustments.push({ code, value: r4(value) });
  };
  const a = num(ask);
  if (a != null && a > T) add("ask_gap", cfg.ask_gap_k * Math.min((a - T) / T, cfg.ask_gap_cap));
  if (strategy.high_pressure && strategy.pressure != null) {
    add("seller_pressure", cfg.pressure_k * clamp((strategy.pressure - cfg.pressure_threshold) / (100 - cfg.pressure_threshold), 0, 1));
  }
  if (strategy.fatigue != null && strategy.fatigue >= cfg.pressure_threshold) {
    add("landlord_fatigue", cfg.fatigue_k * clamp((strategy.fatigue - cfg.pressure_threshold) / (100 - cfg.pressure_threshold), 0, 1));
  }
  if (strategy.equity_rich_low_urgency) add("equity_rich_low_urgency", cfg.equity_rich_low_urgency);
  const depth = clean(market?.buyer_depth).toLowerCase();
  if (depth === "strong") add("buyer_depth_strong", cfg.buyer_depth_strong);
  if (depth === "weak") add("buyer_depth_weak", cfg.buyer_depth_weak);
  if (!clean(seller?.condition)) add("condition_unknown", cfg.condition_unknown);
  if (/tenant|occupied|rented/i.test(clean(seller?.occupancy))) add("tenant_occupied", cfg.tenant_occupied);
  const raw = cfg.d_base + adjustments.reduce((s, x) => s + x.value, 0);
  const d = r4(clamp(raw, cfg.d_min, cfg.d_max));
  let amount = roundDownMoney(T * (1 - d), config.rounding);
  let floor_applied = false;
  const floorUp = F != null ? roundUpMoney(F, config.rounding) : null;
  if (floorUp != null && amount < floorUp) {
    amount = floorUp;
    floor_applied = true;
  }
  if (amount > T) amount = T;
  if (a != null && amount >= a) return { amount: null, d, raw_d: r4(raw), adjustments, floor_applied, reason: "ask_at_or_below_anchor" };
  return { amount, d, raw_d: r4(raw), adjustments, floor_applied, reason: floor_applied ? "anchor_raised_to_investor_floor" : "anchor_depth" };
}

/** anchor → c1 → c2 → final autonomous (= AL). Decreasing, non-uniform, monotone, ≤ AL. */
export function planLadder({ anchor, autonomous_limit, config = NEGOTIATION_V3_DEFAULTS } = {}) {
  const O = num(anchor);
  const AL = num(autonomous_limit);
  if (O == null || AL == null || O > AL) return [];
  const shares = config.ladder.shares;
  const gap = AL - O;
  const rungs = [{ step: 0, kind: "anchor", amount: O, share: 0 }];
  let cum = 0;
  let prev = O;
  shares.forEach((share, i) => {
    cum += share;
    const last = i === shares.length - 1;
    let amount = last ? AL : roundDownMoney(O + gap * cum, config.rounding) ?? prev;
    amount = Math.min(AL, Math.max(prev, amount));
    rungs.push({ step: i + 1, kind: last ? "final_autonomous" : "concession", amount, share, delta: amount - prev });
    prev = amount;
  });
  return rungs;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMP SUPPORT — "no false comp claim"
// ═══════════════════════════════════════════════════════════════════════════
const PACKAGE_HINTS = ["package", "portfolio", "bulk", "multi_parcel", "multi-parcel"];

function screenComps(comps = [], { asset, now, config }) {
  const cc = config.comp_claim;
  const mf = asset === "multifamily";
  const radius = mf ? cc.mf_radius_miles : cc.sfr_radius_miles;
  const maxAge = mf ? cc.mf_max_age_months : cc.sfr_max_age_months;
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const out = [];
  for (const c of comps || []) {
    const price = num(c?.sale_price);
    const dist = num(c?.distance_miles);
    const t = Date.parse(c?.sale_date || "");
    const units = num(c?.units);
    if (price == null || price < cc.min_sale_price) continue;
    if (dist == null || dist > radius) continue;
    if (!Number.isFinite(t) || (nowMs - t) / (86_400_000 * 30.44) > maxAge) continue;
    if (PACKAGE_HINTS.some((h) => clean(c?.source).includes(h))) continue;
    if (mf && !(units != null && Number.isInteger(units) && units >= 2)) continue;
    out.push({ id: c.id, sale_price: price, units, per_unit: mf ? price / units : null });
  }
  return out;
}


// ═══════════════════════════════════════════════════════════════════════════
// AUTONOMY GATE (owner 10-07): by grade, never by blankness
// ═══════════════════════════════════════════════════════════════════════════
const LANE_BACKTEST_KEY = Object.freeze({ sfr: "sfr", mf24: "2_4", mf5: "5_plus" });

/**
 * Autonomy ladder + lane gates (owner 10-07). Returns eligible + every reason
 * it is not. Never touches a number; a denied plan keeps all its numbers.
 */
export function resolveAutonomy({ authority = {}, asset = {}, config = NEGOTIATION_V3_DEFAULTS, like_unit_comps = 0, extra = [] } = {}) {
  const g = config.autonomy;
  const reasons = [];
  if (authority.authorized !== true) reasons.push("not_authorized");
  if (authority.fresh !== true) reasons.push("authority_not_fresh");
  const grade = authority.confidence_grade ?? null;
  const rung = authority.fallback_rung ?? null;
  if (grade == null) {
    if (g.ungraded !== "authorized_only") reasons.push("ungraded_review");
  } else if (!g.grades.includes(grade)) reasons.push(`grade_${grade}_review`);
  if (rung != null && rung > g.max_fallback_rung) reasons.push(`fallback_rung_${rung}_review`);
  if (authority.fallback_geography === true) reasons.push("fallback_geography_review");
  const lane = asset.lane || null;
  const laneCfg = lane ? config.lanes?.[lane] : null;
  if (!laneCfg?.enabled) reasons.push(`lane_${lane || "unknown"}_closed`);
  if (lane && config.lane_backtest_passed?.[LANE_BACKTEST_KEY[lane]] !== true) reasons.push(`lane_${lane}_backtest_not_passed`);
  if (lane === "mf24") {
    if (asset.unit_source !== "property_and_engine_agree") reasons.push("mf24_unit_count_not_confirmed");
    if (grade !== "A") reasons.push("mf24_requires_grade_A");
    if (rung == null || rung > 0) reasons.push("mf24_requires_nearest_ring");
    if (like_unit_comps < config.mf24_min_like_unit_comps) reasons.push("mf24_like_unit_count_comps_insufficient");
  }
  if (lane === "mf5" && config.mf5_requires_noi_corroboration && authority.noi_corroborated !== true) reasons.push("mf5_noi_cap_not_corroborated");
  reasons.push(...(asset.reasons || []), ...extra);
  const uniq = [...new Set(reasons)];
  return {
    eligible: uniq.length === 0,
    grade,
    fallback_rung: rung,
    lane,
    basis: grade == null ? `ungraded_${g.ungraded}` : "grade",
    // Ladder position for the operator: autonomous | proposal_review.
    ladder_position: uniq.length === 0 ? "autonomous" : "proposal_review",
    reasons: uniq,
  };
}

/** The max opening discount actually used: market×lane → lane → default (recorded in evidence). */
export function resolveAnchorFloorPolicy({ config = NEGOTIATION_V3_DEFAULTS, market = null, lane = null } = {}) {
  const af = config.anchor_floor;
  const key = market && lane ? `${market}|${lane}` : null;
  if (key && af.by_market_lane?.[key] != null) return { discount: Number(af.by_market_lane[key]), basis: "market_lane", key, source: af.source };
  if (lane && af.by_lane?.[lane] != null) return { discount: Number(af.by_lane[lane]), basis: "lane", key: lane, source: af.source };
  return { discount: af.default_discount, basis: "default_temporary", key: null, source: af.source };
}

// ═══════════════════════════════════════════════════════════════════════════
// PLAN — never blank when the authority supplies a ceiling and an offer
// ═══════════════════════════════════════════════════════════════════════════
function emptyPlan(base, reasons, explain) {
  return {
    ...base,
    ok: false,
    money_allowed: false,
    autonomy: { eligible: false, grade: base.authority.confidence_grade, fallback_rung: base.authority.fallback_rung, lane: base.lane, reasons },
    ceiling: null,
    target: null,
    opening_anchor: null,
    autonomous_limit: null,
    anchor_floor: null,
    ladder: [],
    per_unit: null,
    screened_comps: [],
    reasons,
    explain: [...explain, { code: "no_numbers", text: `The authority supplied no ceiling/offer: ${reasons.join(", ")}` }],
  };
}

export function buildNegotiationPlan(ctx = {}) {
  const config = mergeConfig(ctx.config);
  const now = ctx.now ?? Date.now();
  const flags = ctx.flags || resolveNegotiationFlags(ctx.env || process.env);
  const authority = resolvePlanAuthority({ offer_authority: ctx.offer_authority, authority: ctx.authority, ade_snapshot: ctx.ade_snapshot, spendability: ctx.spendability, now });
  const assetInfo = resolvePlanAsset({ property: ctx.property || {}, authority });
  const seller = ctx.seller || {};
  const strategy = resolveStrategy({ situation: ctx.situation, seller, config });
  const explain = [];
  const base = {
    version: NEGOTIATION_V3_VERSION,
    config_version: NEGOTIATION_V3_CONFIG_VERSION,
    config,
    flags,
    asset: assetInfo.asset,
    lane: assetInfo.lane,
    property_id: clean(ctx.property?.property_id ?? authority.property_id) || null,
    seller_ask: num(seller.asking_price),
    valuation_mid: authority.valuation_mid ?? null,
    investor_price: authority.investor_price ?? null,
    authority: {
      source: authority.source,
      engine_version: authority.engine_version ?? null,
      score_version: authority.score_version ?? null,
      snapshot_id: authority.snapshot_id ?? null,
      computed_at: authority.computed_at ?? null,
      decision_tier: authority.decision_tier ?? null,
      fresh: authority.fresh === true,
      ok: authority.authorized === true,
      authorized: authority.authorized === true,
      confidence_grade: authority.confidence_grade ?? null,
      fallback_rung: authority.fallback_rung ?? null,
      reasons: authority.reasons || [],
    },
    strategy,
    market: ctx.market ? { buyer_depth: clean(ctx.market.buyer_depth) || null, source: clean(ctx.market.source) || null } : null,
    seller_evidence: { condition: clean(seller.condition) || null, occupancy: clean(seller.occupancy) || null },
  };

  if (!authority.has_numbers) return emptyPlan(base, ["no_ceiling_or_offer", ...(authority.reasons || [])], explain);

  const C = authority.ceiling;
  const R = authority.recommended;
  const I = authority.investor_price ?? null;
  const grade = authority.confidence_grade;
  explain.push({ code: "ceiling", value: C, text: `Ceiling = authority max (${authority.source || "unknown"} ${authority.engine_version || ""})${grade ? ` · grade ${grade}` : " · ungraded"}${authority.fallback_rung != null ? ` · fallback rung ${authority.fallback_rung}` : ""}`.replace(/\s+/g, " ") });
  if (I != null) explain.push({ code: "investor_price", value: I, text: "Investor price = the authority's investor purchase cluster (entity/LLC off-market)" });

  const alRaw = R + config.autonomy_share_of_reserve * (C - R);
  const alCap = C * (1 - config.min_reserve_pct);
  const AL = Math.min(roundDownMoney(Math.min(alRaw, alCap), config.rounding) ?? R, C);
  explain.push({ code: "autonomous_limit", value: AL, text: `Autonomous limit = offer + ${config.autonomy_share_of_reserve} × (ceiling − offer), ≤ ceiling − ${config.min_reserve_pct * 100}%` });
  const T = Math.min(roundDownMoney(R, config.rounding) ?? R, AL);
  explain.push({ code: "target", value: T, text: "Target = the authority's offer" });
  const floorPolicy = resolveAnchorFloorPolicy({ config, market: clean(ctx.property?.market) || null, lane: assetInfo.lane });
  const AF = I != null ? roundUpMoney(I * (1 - floorPolicy.discount), config.rounding) : null;
  const floorIssue = AF != null && AF > T ? ["investor_floor_above_target"] : [];
  explain.push(
    AF != null
      ? { code: "anchor_floor", value: AF, text: `Anchor floor = investor price × (1 − ${floorPolicy.discount}) [${floorPolicy.basis}${floorPolicy.key ? ` ${floorPolicy.key}` : ""}, ${floorPolicy.source}]` }
      : { code: "anchor_floor", value: null, text: `No investor price: anchor bounded only by ${config.anchor.d_max * 100}% below target` },
  );

  const anchor = computeAnchor({ target: T, anchor_floor: AF, ask: base.seller_ask, strategy, seller, market: ctx.market || {}, config });
  const ladderAnchor = anchor.amount ?? computeAnchor({ target: T, anchor_floor: AF, strategy, seller, market: ctx.market || {}, config }).amount;
  explain.push({
    code: "opening_anchor",
    value: anchor.amount,
    text: `Anchor = target × (1 − ${anchor.d}) [${anchor.adjustments.map((x) => `${x.code} ${x.value > 0 ? "+" : ""}${x.value}`).join(", ") || "base only"}]${anchor.floor_applied ? ", raised to investor floor" : ""}`,
  });
  const ladder = planLadder({ anchor: ladderAnchor, autonomous_limit: AL, config });
  explain.push({ code: "ladder", text: `Ladder ${ladder.map((r) => r.amount).join(" → ")} (shares ${config.ladder.shares.join("/")} of the anchor→limit gap); above the limit is human approval` });

  let per_unit = null;
  if (assetInfo.asset === "multifamily" && assetInfo.units != null) {
    const u = assetInfo.units;
    const pu = (v) => (v == null ? null : Math.floor(v / u));
    const band = authority.per_unit_band;
    per_unit = {
      units: u,
      unit_source: assetInfo.unit_source,
      ceiling: pu(C),
      target: pu(T),
      anchor: pu(ladderAnchor),
      autonomous_limit: pu(AL),
      anchor_floor: pu(AF),
      investor_price: pu(I),
      band_low: band?.low ?? null,
      band_high: band?.high ?? null,
    };
    explain.push({ code: "per_unit", text: `${u} units (${assetInfo.unit_source}), ${assetInfo.lane}: target $${per_unit.target}/door, ceiling $${per_unit.ceiling}/door${band?.low ? `, investor band $${band.low}–${band.high}/door` : ""}` });
  } else if (assetInfo.asset === "multifamily") {
    explain.push({ code: "per_unit", text: `No per-unit math: ${assetInfo.reasons.join(", ")}` });
  }

  const screenedForGate = screenComps(authority.comps, { asset: assetInfo.asset, now, config });
  const like_unit_comps = assetInfo.units != null ? screenedForGate.filter((c) => c.units === assetInfo.units).length : 0;
  const autonomy = resolveAutonomy({ authority, asset: assetInfo, config, like_unit_comps, extra: floorIssue });
  explain.push({ code: "autonomy", text: autonomy.eligible ? `Autonomous sending eligible (${autonomy.basis})` : `Operator approval required: ${autonomy.reasons.join(", ")}` });

  const screened_comps = screenedForGate;
  const plan = {
    ...base,
    ok: true,
    money_allowed: autonomy.eligible,
    autonomy,
    ceiling: C,
    target: T,
    recommended: R,
    opening_anchor: anchor.amount,
    ladder_anchor: ladderAnchor,
    anchor_detail: anchor,
    autonomous_limit: AL,
    anchor_floor: AF,
    anchor_floor_policy: floorPolicy,
    ladder,
    per_unit,
    screened_comps,
    reasons: autonomy.reasons,
    explain,
  };
  // Operator-only: would comp evidence support our anchor on pushback? (disclosure.js)
  const support = supportiveComps(plan, ladderAnchor);
  plan.pushback_comp_support = { allowed: support.allowed, reason: support.reason, ids: support.ids, figure: support.figure };
  return plan;
}

// ═══════════════════════════════════════════════════════════════════════════
// NEXT MOVE
// ═══════════════════════════════════════════════════════════════════════════
export function isFarAboveReality(amount, value, config = NEGOTIATION_V3_DEFAULTS) {
  const a = num(amount);
  const v = num(value);
  if (a == null || v == null || v <= 0) return false;
  return a > v * config.far_above_ratio || a > v + config.far_above_delta;
}

function eventAmount(plan, event) {
  const total = num(event?.amount);
  if (total != null && total > 0) return total;
  const ppu = num(event?.per_unit);
  if (ppu != null && ppu > 0) return plan?.per_unit?.units ? ppu * plan.per_unit.units : NaN; // NaN = per-unit ask without units
  return null;
}

function moveOut(plan, action, { amount = null, quote_type = null, language_branch = null, rule_branch, explain = [], proposal = null } = {}) {
  let per_unit = null;
  if (amount != null && plan?.asset === "multifamily" && plan?.per_unit?.units) {
    // Seller-facing: our per-unit POSITION only. Investor bands never leave the operator desk.
    const u = plan.per_unit.units;
    per_unit = { units: u, door: Math.floor(amount / u / plan.config.mf.per_unit_step) * plan.config.mf.per_unit_step };
  }
  const out = { action, amount, per_unit, quote_type, language_branch, rule_branch, proposal, requires_log: action === A.QUOTE || quote_type === Q.NO_NUMBER, explain };
  if (amount != null && plan?.ok) {
    out.reply = sellerFacingReply(plan, out);
    out.language_branch = out.reply.branch; // comps_support only when truthful + supportive, else position
  }
  return out;
}

/**
 * The final authority gate every move passes through. Whatever the branch
 * computed, money leaves only when: plan ok, amount ≤ ceiling, amount ≤
 * autonomous limit, amount ≥ fair floor, asset policy allows autonomous money,
 * and AUTONOMOUS_MONETARY_QUOTES is on. Otherwise HUMAN with the proposal.
 */
export function guardMove(plan, move) {
  if (move.amount == null) return move;
  const toHuman = (why) => ({
    ...move,
    action: A.HUMAN,
    // Grade B / C / fallback / closed lane: full numbers + the pre-populated reply for the operator.
    proposal: { amount: move.amount, per_unit: move.per_unit, quote_type: move.quote_type, rule_branch: move.rule_branch, language_branch: move.language_branch, reply: move.reply || null },
    amount: null,
    reply: null,
    per_unit: null,
    quote_type: null,
    requires_log: false,
    rule_branch: `${move.rule_branch}:${why}`,
    explain: [...move.explain, { code: "human_gate", text: why }],
  });
  if (!plan?.ok) {
    return { ...move, reply: null, action: A.NO_NUMBER, amount: null, per_unit: null, quote_type: Q.NO_NUMBER, requires_log: true, rule_branch: `${move.rule_branch}:no_authority`, language_branch: L.DISCOVERY };
  }
  if (move.amount > plan.ceiling) {
    // Unreachable by construction; clamp the proposal too so no number above C ever exists.
    return { ...toHuman("above_ceiling_blocked"), proposal: { amount: plan.ceiling, quote_type: move.quote_type, rule_branch: move.rule_branch, reply: null } };
  }
  if (move.action !== A.QUOTE) return move;
  if (move.amount > plan.autonomous_limit) return toHuman("above_autonomous_limit");
  if (plan.anchor_floor != null && move.amount < plan.anchor_floor) return toHuman("below_investor_floor");
  if (!plan.autonomy?.eligible) return toHuman(`autonomy:${(plan.autonomy?.reasons || ["denied"]).join("|")}`);
  if (!plan.flags?.autonomous_monetary_quotes) return toHuman("autonomous_monetary_quotes_off");
  return move;
}

function quoteBranch(plan) {
  return plan.asset === "multifamily" && plan.per_unit ? L.POSITION_PER_UNIT : L.POSITION;
}

/**
 * @param plan   buildNegotiationPlan() output
 * @param state  { lc_positions: number[] (ascending, what WE quoted), seller_positions: number[], holds }
 * @param event  { kind, amount?, per_unit?, new_value_evidence? }
 */
export function nextNegotiationMove(plan, state = {}, event = {}) {
  const raw = decideMove(plan, state, event);
  const guarded = guardMove(plan, raw);
  return { ...guarded, engine_version: NEGOTIATION_V3_VERSION, config_version: NEGOTIATION_V3_CONFIG_VERSION };
}

function decideMove(plan, state = {}, event = {}) {
  const kind = clean(event?.kind).toLowerCase() || "other";
  const lc = (state?.lc_positions || []).map(num).filter((v) => v != null && v > 0);
  const current = lc.length ? Math.max(...lc) : null;
  const holds = num(state?.holds) || 0;
  const sellerPrior = (state?.seller_positions || []).map(num).filter((v) => v != null && v > 0);
  const ex = [];

  // Creative structures: approved probe wording, no number; terms are human (§55).
  if (kind === "capital_gains" || (plan?.strategy?.creative_probe && kind === "creative")) {
    return moveOut(plan, A.NO_NUMBER, { quote_type: Q.NO_NUMBER, language_branch: L.CREATIVE, rule_branch: "creative_probe_approved_wording" });
  }
  if (kind === "creative_terms") return moveOut(plan, A.HUMAN, { rule_branch: "creative_terms_need_human" });

  if (!plan?.ok) {
    // The authority supplied NO numbers at all (D is "never blank"; this is the defensive path).
    if (plan?.asset === "multifamily") return moveOut(plan, A.HUMAN, { rule_branch: "multifamily_without_numbers_human", explain: ex });
    const amt = eventAmount(plan, event);
    if (amt != null && plan?.valuation_mid != null && plan?.authority?.fresh && isFarAboveReality(amt, plan.valuation_mid, plan?.config || NEGOTIATION_V3_DEFAULTS)) {
      return moveOut(plan, A.CLOSE_UNREALISTIC, { quote_type: Q.NO_NUMBER, language_branch: L.UNREALISTIC_CLOSE, rule_branch: "far_above_reality_no_authority" });
    }
    return moveOut(plan, A.NO_NUMBER, { quote_type: Q.NO_NUMBER, language_branch: L.DISCOVERY, rule_branch: "no_authoritative_money", explain: ex });
  }

  const cfg = plan.config;
  const AL = plan.autonomous_limit;
  const C = plan.ceiling;
  const F = plan.anchor_floor; // may be null (no investor price)
  const amt = eventAmount(plan, event);
  if (Number.isNaN(amt)) return moveOut(plan, A.HUMAN, { rule_branch: "per_unit_ask_without_unit_count" });

  // §58: far outside reality ⇒ polite approved close, unless new value evidence arrived.
  if (amt != null && isFarAboveReality(amt, plan.valuation_mid, cfg)) {
    if (event?.new_value_evidence) return moveOut(plan, A.HUMAN, { rule_branch: "far_above_with_new_value_evidence_reunderwrite" });
    // Closing a seller on a low-confidence value is an operator call.
    const g = plan.autonomy?.grade;
    if ((g != null && !cfg.autonomy.grades.includes(g)) || !plan.authority?.fresh) {
      return moveOut(plan, A.HUMAN, { rule_branch: "far_above_on_low_confidence_value" });
    }
    return moveOut(plan, A.CLOSE_UNREALISTIC, { quote_type: Q.NO_NUMBER, language_branch: L.UNREALISTIC_CLOSE, rule_branch: "far_above_reality_close" });
  }

  // The seller accepts our number.
  if (kind === "accept") {
    if (current == null) return moveOut(plan, A.NO_NUMBER, { quote_type: Q.NO_NUMBER, language_branch: L.DISCOVERY, rule_branch: "accept_without_lc_number" });
    return moveOut(plan, A.QUOTE, { amount: current, quote_type: Q.FORMAL_OFFER, language_branch: quoteBranch(plan), rule_branch: "seller_accepted_lc_position" });
  }

  // Pushback ("too low", "others pay more"): restate our position; comp evidence only
  // here, and only when truthful + supportive (disclosure.js). Never a concession by itself.
  if (kind === "pushback") {
    if (current == null) return moveOut(plan, A.HOLD, { rule_branch: "pushback_before_any_number" });
    return moveOut(plan, A.QUOTE, { amount: current, quote_type: lc.length > 1 ? Q.CONCESSION : Q.NEGOTIATION_ANCHOR, language_branch: L.COMPS_SUPPORT, rule_branch: "pushback_restate_position" });
  }

  // ── FIRST NUMBER ────────────────────────────────────────────────────────
  if (current == null) {
    if (["price", "counter", "make_offer", "no_price"].includes(kind) === false) {
      return moveOut(plan, A.HOLD, { rule_branch: "no_price_event" });
    }
    if (amt != null && F != null && amt < F) return moveOut(plan, A.HUMAN, { rule_branch: "ask_below_investor_floor" });
    if (amt != null && amt <= plan.target) {
      return moveOut(plan, A.NO_NUMBER, { quote_type: Q.NO_NUMBER, language_branch: L.CONFIRM, rule_branch: "ask_within_target_confirm_basics" });
    }
    if (cfg.require_condition_before_number && !plan.seller_evidence?.condition) {
      return moveOut(plan, A.NO_NUMBER, { quote_type: Q.NO_NUMBER, language_branch: L.DISCOVERY, rule_branch: "collect_condition_before_number" });
    }
    const anchor =
      amt != null
        ? computeAnchor({ target: plan.target, anchor_floor: F, ask: amt, strategy: plan.strategy, seller: plan.seller_evidence, market: plan.market || {}, config: cfg })
        : { amount: plan.ladder_anchor, reason: "ask_unknown_base_anchor", d: null, adjustments: [] };
    if (anchor.amount == null) {
      return moveOut(plan, A.NO_NUMBER, { quote_type: Q.NO_NUMBER, language_branch: L.CONFIRM, rule_branch: "ask_at_or_below_anchor_confirm_basics" });
    }
    return moveOut(plan, A.QUOTE, {
      amount: anchor.amount,
      quote_type: Q.NEGOTIATION_ANCHOR,
      language_branch: quoteBranch(plan),
      rule_branch: amt != null ? "opening_anchor_vs_ask" : "opening_anchor_no_ask",
      explain: [{ code: "anchor", text: `d=${anchor.d} ${anchor.adjustments.map((x) => x.code).join(",")}` }],
    });
  }

  // ── LATER ROUNDS ────────────────────────────────────────────────────────
  if (amt == null) {
    if (holds + 1 >= cfg.ladder.max_consecutive_holds) return moveOut(plan, A.HUMAN, { rule_branch: "no_counter_repeated" });
    return moveOut(plan, A.HOLD, { rule_branch: "no_counter_hold_position" });
  }
  if (amt <= current) {
    if (F != null && amt < F) return moveOut(plan, A.HUMAN, { rule_branch: "counter_below_investor_floor" });
    return moveOut(plan, A.QUOTE, { amount: amt, quote_type: Q.FORMAL_OFFER, language_branch: quoteBranch(plan), rule_branch: "accept_counter_at_or_below_lc" });
  }
  if (current >= AL) {
    if (amt <= C) return moveOut(plan, A.HUMAN, { rule_branch: "above_autonomous_limit_needs_approval", proposal: { amount: amt } });
    if (holds + 1 >= cfg.ladder.max_consecutive_holds) return moveOut(plan, A.HUMAN, { rule_branch: "final_position_held_seller_above_ceiling" });
    return moveOut(plan, A.HOLD, { rule_branch: "final_autonomous_position_held" });
  }

  // Behaviour multiplier (§47): gap, seller movement, pressure.
  const prior = sellerPrior.length ? sellerPrior[sellerPrior.length - 1] : null;
  const moved_pct = prior != null && prior > 0 ? ((prior - amt) / prior) * 100 : null;
  const gap_pct = ((amt - current) / current) * 100;
  let behaviour;
  let mult;
  if (gap_pct <= cfg.ladder.closing_gap_pct) [behaviour, mult] = ["closing", cfg.ladder.closing_multiplier];
  else if (moved_pct == null) [behaviour, mult] = ["first_position", 1];
  else if (moved_pct <= 0) [behaviour, mult] = ["no_movement", 0];
  else if (moved_pct >= cfg.ladder.flexible_move_pct) [behaviour, mult] = ["flexible", cfg.ladder.firm_multiplier];
  else [behaviour, mult] = ["small_movement", 1];
  if (mult === 0) {
    if (holds + 1 >= cfg.ladder.max_consecutive_holds) return moveOut(plan, A.HUMAN, { rule_branch: "seller_not_moving" });
    return moveOut(plan, A.HOLD, { rule_branch: "seller_not_moving_hold" });
  }
  if (plan.strategy?.high_pressure) mult *= cfg.ladder.high_pressure_multiplier;

  const concessions = Math.max(0, lc.length - 1);
  const share = cfg.ladder.shares[Math.min(concessions, cfg.ladder.shares.length - 1)];
  const remaining = AL - current;
  const anchorBase = plan.ladder_anchor ?? lc[0];
  let step = Math.round(Math.max(AL - anchorBase, remaining) * share * mult);
  step = Math.min(Math.max(cfg.ladder.min_step, step), remaining);
  let next = current + step;
  if (next < AL) next = Math.max(current + Math.min(cfg.ladder.min_step, remaining), roundDownMoney(next, cfg.rounding) ?? next);
  next = Math.min(next, AL);
  const why = [{ code: "concession", text: `${behaviour} ×${r4(mult)}, share ${share}, step $${next - current}, remaining authority $${AL - next}` }];
  if (next >= amt) return moveOut(plan, A.QUOTE, { amount: amt, quote_type: Q.FORMAL_OFFER, language_branch: quoteBranch(plan), rule_branch: `accept_counter_within_step_${behaviour}`, explain: why });
  return moveOut(plan, A.QUOTE, {
    amount: next,
    quote_type: Q.CONCESSION,
    language_branch: quoteBranch(plan),
    rule_branch: next >= AL ? `final_autonomous_position_${behaviour}` : `concession_${behaviour}`,
    explain: why,
  });
}

export default buildNegotiationPlan;
