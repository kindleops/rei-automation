// ─── negotiation-signal-opening.js ──────────────────────────────────────────
// SIGNAL-BASED NEGOTIATION OPENING + CONCESSION LADDER (owner goal 2026-10-06:
// "open below our offer range and work up toward MAO based on seller signals").
//
// SHADOW ONLY. Behind NEGOTIATION_SIGNAL_OPENING (default OFF). There is no
// live mode: every caller gets a number to LOG (negotiation_shadow, PROPOSED),
// never one to send. Pure module: no I/O, no clock unless injected, no AI.
//
// Extends the July engine (negotiation-policy.js): asset classes come from
// normalizeAssetClass; MAO is offerReadiness.authoritativeMaxOffer (the
// engine's effective_authorized_ceiling, as Autopilot v2). It does not touch
// Decision Engine scoring or the Autopilot v2 files.
//
// INPUT DISCIPLINE. Every input is read by collectSignalInputs() from an
// explicit allow-list of keys. Protected characteristics and their proxies are
// never read (EXCLUDED_PRICING_FIELDS in the config; enforced by a Proxy test
// and a static scan of this file). Tag tokens that proxy a protected class are
// dropped; tag tokens that proxy AGE route only to the guarded age signal.

import { normalizeAssetClass, ASSET_CLASSES } from "./negotiation-policy.js";
import { resolveAskingPriceSignal } from "./monetary-understanding.js";
import {
  SIGNAL_OPENING_CONFIG_VERSION,
  SPREAD_BOUNDS,
  FAIR_OFFER_FLOOR,
  LADDER,
  ROUNDING,
  SIGNALS,
  FIELD_STATE_POLICY,
  FIELD_MODES,
  EXCLUDED_TAG_TOKENS,
  AGE_PROXY_TAG_TOKENS,
  STATE_LAW,
} from "./negotiation-signal-opening-config.js";

export const NEGOTIATION_SIGNAL_OPENING_FLAG = "NEGOTIATION_SIGNAL_OPENING";
export const SIGNAL_OPENING_ENGINE_VERSION = "negotiation_signal_opening_v1";

/** "off" (default) | "shadow". There is no live mode — any truthy value is shadow. */
export function resolveSignalOpeningMode(env = process.env) {
  const raw = String(env?.[NEGOTIATION_SIGNAL_OPENING_FLAG] ?? "").trim().toLowerCase();
  if (!raw || ["0", "false", "off", "no"].includes(raw)) return "off";
  return "shadow";
}

// ─── helpers ────────────────────────────────────────────────────────────────
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,\s]/g, "");
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
const lower = (v) => String(v ?? "").trim().toLowerCase();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r4 = (v) => (v == null ? null : Math.round(v * 10_000) / 10_000);
function truthy(v) {
  if (v === true) return true;
  const s = lower(v);
  return ["true", "t", "yes", "y", "1"].includes(s);
}
/** "$55,000-$59,999" → 57,499.5; "$250,000+" → 250,000; "0" → null (vendor "unknown"). */
export function parseRangeMidpoint(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value > 0 ? value : null;
  const parts = String(value).match(/\d[\d,]*/g);
  if (!parts) return null;
  const nums = parts.map((p) => Number(p.replace(/,/g, ""))).filter(Number.isFinite);
  if (!nums.length) return null;
  const mid = nums.length >= 2 ? (nums[0] + nums[1]) / 2 : nums[0];
  return mid > 0 ? mid : null;
}
function tagTokens(...texts) {
  const tokens = [];
  for (const t of texts) {
    if (!t) continue;
    for (const part of String(t).split(/[;,|]/)) {
      const tok = lower(part);
      if (tok) tokens.push(tok);
    }
  }
  return tokens;
}

// ═══════════════════════════════════════════════════════════════════════════
// INPUT COLLECTION — the ONLY place source records are read.
// ═══════════════════════════════════════════════════════════════════════════
const URGENCY_PATTERNS = Object.freeze([
  /\basap\b/i,
  /\bas soon as possible\b/i,
  /\b(need|have|want) to sell (it )?(fast|quick(ly)?|soon|now)\b/i,
  /\bsell (it )?(fast|quick(ly)?)\b/i,
  /\bbehind on (the )?(payments?|mortgage|taxes)\b/i,
  /\bforeclos(e|ure|ing)\b/i,
  /\b(moving|relocating|relocation)\b/i,
  /\b(tired of|done with) (it|the house|the property|tenants?|renting|being a landlord)\b/i,
  /\bcan'?t afford\b/i,
  /\bneed (the )?(cash|money)\b/i,
  /\b(this|next) (week|month)\b/i,
]);
// Stated divorce / separation (marital status — guarded field).
const MARITAL_EVENT_PATTERNS = Object.freeze([/\bdivorc(e|ed|ing)\b/i, /\bseparat(ed|ion|ing)\b/i, /\bsplitting up\b/i]);
const INHERITED_PATTERNS = Object.freeze([/\binherit(ed|ance)\b/i, /\bpassed away\b/i, /\bprobate\b/i, /\b(estate|heirs?)\b/i]);
const CODE_VIOLATION_PATTERNS = Object.freeze([/\bcode (violation|enforcement)\b/i, /\bcondemned\b/i, /\bcity (fined|citation)\b/i]);
const DODGE_PATTERNS = Object.freeze([
  /\bmake (me|us) an offer\b/i,
  /\byou tell me\b/i,
  /\bwhat('?s| is| would be) (your|the) (offer|number|best)\b/i,
  /\bwhat (will|would|can) you (pay|offer|give)\b/i,
  /\bnot sure\b/i,
  /\bmake an offer\b/i,
]);
const PRICE_QUESTION_RE = /\b(price|how much|number|asking|looking to get|what would you take)\b/i;

/**
 * Normalise a conversation to [{ direction, body, at }] reading ONLY those
 * three keys from each message.
 */
function readMessages(conversation) {
  const out = [];
  const list = Array.isArray(conversation?.messages) ? conversation.messages : [];
  for (const m of list) {
    const direction = lower(m?.direction);
    const body = String(m?.body ?? "");
    const at = m?.at ?? null;
    if (direction !== "inbound" && direction !== "outbound") continue;
    out.push({ direction, body, at: at instanceof Date ? at.toISOString() : at });
  }
  out.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  return out;
}

function conversationFacts(messages, { reference = null } = {}) {
  const inbound = messages.filter((m) => m.direction === "inbound");
  const text = inbound.map((m) => m.body).join("\n");
  const urgency_hits = URGENCY_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
  const marital_event = MARITAL_EVENT_PATTERNS.some((re) => re.test(text));
  const inherited = INHERITED_PATTERNS.some((re) => re.test(text));
  const code_violation = CODE_VIOLATION_PATTERNS.some((re) => re.test(text));

  // Reply latency: outbound → the next inbound.
  const latencies = [];
  let lastOut = null;
  for (const m of messages) {
    const t = Date.parse(m.at || "");
    if (!Number.isFinite(t)) continue;
    if (m.direction === "outbound") lastOut = t;
    else if (lastOut != null) {
      latencies.push((t - lastOut) / 60_000);
      lastOut = null;
    }
  }
  latencies.sort((a, b) => a - b);
  const median_reply_minutes = latencies.length ? latencies[Math.floor((latencies.length - 1) / 2)] : null;

  // Price question: asked by us, then answered with a number or dodged.
  let price_question = null;
  const seller_positions = [];
  let asked = false;
  for (const m of messages) {
    if (m.direction === "outbound") {
      if (PRICE_QUESTION_RE.test(m.body)) asked = true;
      continue;
    }
    const sig = resolveAskingPriceSignal(m.body, { reference });
    const value = num(sig?.asking_price?.value);
    if (value != null && value >= 10_000) seller_positions.push({ value, at: m.at });
    if (asked && price_question == null) {
      if (value != null) price_question = "answered";
      else if (DODGE_PATTERNS.some((re) => re.test(m.body))) price_question = "dodged";
    }
  }
  if (asked && price_question == null && inbound.length) price_question = "unanswered";
  return {
    inbound_count: inbound.length,
    urgency_hits,
    marital_event,
    inherited,
    code_violation,
    median_reply_minutes,
    price_question,
    seller_positions,
  };
}

/**
 * Collect every pricing input from the source records. Reads ONLY the keys
 * named here. Returns a plain object (no references to the sources).
 */
export function collectSignalInputs({ property = null, owner = null, prospect = null, score = null, conversation = null, now = null, owner_overrides = null } = {}) {
  const p = property || {};
  const o = owner || {};
  const pr = prospect || {};
  const s = score || {};
  const offerCalc = s.evidence?.offer_calculation || {};
  const nf = s.evidence?.subject?.normalized_features || {};

  const rawTags = tagTokens(p.property_flags_text, p.seller_tags_text, o.seller_tags_text);
  const tags = rawTags.filter((t) => !EXCLUDED_TAG_TOKENS.some((x) => t === x || t.includes(x)));
  const ageProxyTags = tags.filter((t) => AGE_PROXY_TAG_TOKENS.some((x) => t === x));
  const signalTags = tags.filter((t) => !ageProxyTags.includes(t));
  const has = (...needles) => signalTags.some((t) => needles.some((n) => t.includes(n)));

  const state = String(p.property_state ?? p.property_address_state ?? "").trim().toUpperCase() || null;
  const market = lower(p.canonical_market_id) || null;

  const mao = num(offerCalc.effective_authorized_ceiling);
  const valuation_mid = num(s.valuation_mid);
  const estimated_repairs = num(s.estimated_repairs ?? p.estimated_repair_cost);
  const messages = readMessages(conversation);
  const convo = conversationFacts(messages, { reference: mao });
  const statedFacts = conversation?.facts || {};

  // Guarded fields: a field whose mode is "off" for this state/market is NOT
  // READ AT ALL (not merely zero-weighted).
  const maritalMode = resolveFieldMode("marital_status", { state, market, owner_overrides }).mode;
  const ageMode = resolveFieldMode("age", { state, market, owner_overrides }).mode;

  // Age (guarded): birth month YYYYMM → whole years at `now`; tag proxy as fallback.
  let age = null;
  const mob = ageMode === FIELD_MODES.OFF ? "" : String(pr.mob ?? "").trim();
  const nowMs = now == null ? null : typeof now === "number" ? now : Date.parse(now);
  if (/^\d{6}$/.test(mob) && nowMs != null) {
    const y = Number(mob.slice(0, 4));
    const m = Math.max(1, Number(mob.slice(4, 6)) || 1);
    const d = new Date(nowMs);
    const years = d.getUTCFullYear() - y - (d.getUTCMonth() + 1 < m ? 1 : 0);
    if (years >= 18 && years <= 110) age = { years, source: "prospects.mob" };
  }
  if (!age && ageProxyTags.length && ageMode !== FIELD_MODES.OFF) age = { years: null, band: "senior_tag", source: "tag" };

  const maritalOn = maritalMode !== FIELD_MODES.OFF;
  const maritalRaw = maritalOn ? lower(pr.marital_status) : "";
  const marital = !maritalOn
    ? null
    : convo.marital_event || statedFacts.divorce === true || has("divorce")
    ? { status: "divorce_or_separation", source: convo.marital_event ? "conversation" : statedFacts.divorce === true ? "stated_fact" : "tag" }
    : maritalRaw
      ? { status: maritalRaw.includes("married") ? "married" : maritalRaw.includes("single") ? "single" : "other", source: "prospects.marital_status" }
      : null;

  return {
    state,
    market,
    asset: {
      property_type: p.property_type ?? null,
      units_count: num(p.units_count),
      asset_class: normalizeAssetClass(p.normalized_asset_class || p.property_type, { unitCount: num(p.units_count) }),
    },
    authority: {
      mao,
      recommended_cash_offer: num(s.recommended_cash_offer),
      valuation_mid,
      estimated_repairs,
      assignment_margin_floor: num(offerCalc.assignment_margin_floor ?? offerCalc.protected_margin),
      decision_tier: s.decision_tier ?? null,
      computed_at: s.computed_at instanceof Date ? s.computed_at.toISOString() : s.computed_at ?? null,
      score_snapshot_id: s.evidence?.immutable_snapshot_id ?? s.id ?? null,
    },
    property: {
      condition: lower(p.building_condition) || lower(nf.condition) || null,
      rehab_level: lower(p.rehab_level) || null,
      vacant: truthy(nf.vacant) || has("vacant") ? true : nf.vacant === false ? false : null,
      listing_status: lower(p.mls_market_status) || lower(p.market_status_label) || (has("off market") ? "off market" : null),
      days_on_market: num(statedFacts.days_on_market),
      flood_zone: String(p.flood_zone ?? "").trim().toUpperCase() || null,
      year_built: num(p.year_built),
    },
    financial: {
      equity_percent: num(p.equity_percent),
      loan_balance: num(p.total_loan_balance),
      active_lien: truthy(p.active_lien) || num(o.active_lien_count) > 0 || has("active lien"),
      tax_delinquent: truthy(p.tax_delinquent) || has("tax delinquent"),
      tax_delinquent_year: num(p.tax_delinquent_year ?? o.oldest_tax_delinquent_year),
      ownership_years: num(p.ownership_years ?? o.max_ownership_years),
      free_and_clear: has("free and clear"),
    },
    situation: {
      out_of_state: truthy(p.out_of_state_owner) || has("out of state"),
      absentee: has("absentee"),
      tired_landlord: has("tired landlord", "landlord fatigue") || num(s.landlord_fatigue_score) >= 60,
      probate: truthy(nf.probate) || has("probate", "inherited", "heir") || convo.inherited,
      trust: lower(p.owner_type_guess).includes("trust") || lower(o.owner_type_guess).includes("trust"),
      code_violation: has("code violation", "condemned") || convo.code_violation || statedFacts.code_violation === true,
      portfolio_size: num(o.property_count),
      distress:
        truthy(p.is_preforeclosure) || truthy(p.is_pre_foreclosure) || truthy(p.is_foreclosure) || truthy(p.is_auction) ||
        Boolean(String(p.preforeclosure_status ?? "").trim()) || Boolean(String(p.foreclosure_status ?? "").trim()) ||
        has("preforeclosure", "pre-foreclosure", "foreclosure", "auction"),
    },
    conversation: convo,
    prospect_financial: {
      household_income: parseRangeMidpoint(pr.est_household_income),
      net_asset_value: parseRangeMidpoint(pr.net_asset_value),
      buying_power: lower(pr.buying_power) || null,
    },
    guarded: { marital_status: marital, age },
    ignored_tag_count: rawTags.length - tags.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL SCORERS — each returns { score ∈ [-1,1] | null, value }
// ═══════════════════════════════════════════════════════════════════════════
const NONE = (value = null) => ({ score: null, value });
const FLOOD_HIGH = /^(A|AE|AH|AO|AR|A99|V|VE)\b/;
const BUYING_POWER_SCORES = [
  [/very high risk/, 1],
  [/high risk/, 0.8],
  [/caution|potential but/, 0.5],
  [/emerging/, 0.2],
  [/moderate/, 0],
  [/strong|elite|prime|affluent/, -0.5],
];

export const SIGNAL_SCORERS = Object.freeze({
  condition(i) {
    const rehab = i.property.rehab_level;
    const cond = i.property.condition;
    if (rehab && rehab !== "unknown") {
      if (/structural|tear|demo/.test(rehab)) return { score: 1, value: rehab };
      if (/full/.test(rehab)) return { score: 0.7, value: rehab };
      if (/moderate|medium/.test(rehab)) return { score: 0.3, value: rehab };
      if (/light|cosmetic/.test(rehab)) return { score: 0, value: rehab };
      if (/none|turnkey/.test(rehab)) return { score: -0.3, value: rehab };
    }
    if (cond && cond !== "unknown") {
      if (/unsound|very poor|poor/.test(cond)) return { score: 1, value: cond };
      if (/fair/.test(cond)) return { score: 0.4, value: cond };
      if (/average/.test(cond)) return { score: 0, value: cond };
      if (/excellent/.test(cond)) return { score: -0.5, value: cond };
      if (/good/.test(cond)) return { score: -0.3, value: cond };
    }
    return NONE(rehab || cond);
  },
  repair_ratio(i) {
    const { valuation_mid: v, estimated_repairs: r } = i.authority;
    if (v == null || v <= 0 || r == null || r < 0 || r >= v) return NONE();
    const ratio = r / (v - r);
    const score = ratio >= 0.3 ? 1 : ratio >= 0.15 ? 0.5 : ratio < 0.05 ? -0.3 : 0;
    return { score, value: r4(ratio) };
  },
  vacancy(i) {
    if (i.property.vacant === true) return { score: 1, value: true };
    if (i.property.vacant === false) return { score: 0, value: false };
    return NONE();
  },
  listing_status(i) {
    const s = i.property.listing_status;
    if (!s) return NONE();
    if (/^(active|for sale|listed|pending|coming soon)/.test(s)) return { score: -1, value: s };
    if (/expired|withdrawn|cancel|delisted|terminated/.test(s)) return { score: 1, value: s };
    return { score: 0, value: s };
  },
  days_on_market(i) {
    const d = i.property.days_on_market;
    if (d == null) return NONE();
    return { score: d >= 120 ? 1 : d >= 60 ? 0.5 : 0, value: d };
  },
  flood_risk(i) {
    const z = i.property.flood_zone;
    if (!z) return NONE();
    return { score: FLOOD_HIGH.test(z) ? 1 : 0, value: z };
  },
  building_age(i, ctx) {
    const y = i.property.year_built;
    if (y == null || y < 1700 || ctx.year == null) return NONE(y);
    const age = ctx.year - y;
    return { score: age >= 80 ? 1 : age >= 50 ? 0.5 : age < 20 ? -0.3 : 0, value: age };
  },
  equity(i) {
    const e = i.financial.equity_percent;
    if (e == null) return i.financial.free_and_clear ? { score: 1, value: "free_and_clear" } : NONE();
    return { score: e >= 70 ? 1 : e >= 40 ? 0.4 : e < 20 ? -1 : 0, value: e };
  },
  loan_to_mao(i) {
    const loan = i.financial.loan_balance;
    const mao = i.authority.mao;
    if (loan == null || mao == null || mao <= 0) return NONE();
    if (loan <= 0) return { score: 0, value: 0 };
    const ratio = loan / mao;
    return { score: ratio >= 0.9 ? -1 : ratio >= 0.7 ? -0.5 : 0, value: r4(ratio) };
  },
  liens(i) {
    return { score: i.financial.active_lien ? 1 : 0, value: i.financial.active_lien };
  },
  tax_delinquency(i, ctx) {
    if (!i.financial.tax_delinquent) return { score: 0, value: false };
    const y = i.financial.tax_delinquent_year;
    const years = y && ctx.year ? ctx.year - y : null;
    return { score: years != null && years >= 2 ? 1 : 0.6, value: years ?? true };
  },
  years_owned(i) {
    const y = i.financial.ownership_years;
    if (y == null) return NONE();
    return { score: y >= 20 ? 1 : y >= 10 ? 0.5 : y < 3 ? -0.5 : 0, value: y };
  },
  absentee(i) {
    if (i.situation.out_of_state) return { score: 1, value: "out_of_state" };
    if (i.situation.absentee) return { score: 0.6, value: "absentee" };
    return { score: 0, value: false };
  },
  tired_landlord(i) {
    return { score: i.situation.tired_landlord ? 1 : 0, value: i.situation.tired_landlord };
  },
  inherited_probate_trust(i) {
    if (i.situation.probate) return { score: 1, value: "probate_or_inherited" };
    if (i.situation.trust) return { score: 0.5, value: "trust" };
    return { score: 0, value: false };
  },
  code_violations(i) {
    return { score: i.situation.code_violation ? 1 : 0, value: i.situation.code_violation };
  },
  portfolio_size(i) {
    const n = i.situation.portfolio_size;
    if (n == null) return NONE();
    return { score: n >= 10 ? -1 : n >= 3 ? -0.4 : 0, value: n };
  },
  distress(i) {
    return { score: i.situation.distress ? 1 : 0, value: i.situation.distress };
  },
  urgency_language(i) {
    if (!i.conversation.inbound_count) return NONE();
    const n = i.conversation.urgency_hits.length;
    return { score: n >= 2 ? 1 : n === 1 ? 0.6 : 0, value: n };
  },
  reply_latency(i) {
    const m = i.conversation.median_reply_minutes;
    if (m == null) return NONE();
    return { score: m <= 15 ? 1 : m <= 120 ? 0.4 : m > 1440 ? -0.5 : 0, value: Math.round(m) };
  },
  price_question(i) {
    const q = i.conversation.price_question;
    if (!q) return NONE();
    return { score: q === "dodged" ? 0.5 : 0, value: q };
  },
  counter_behaviour(i) {
    const pos = i.conversation.seller_positions;
    if (!pos.length) return NONE();
    if (pos.length === 1) return { score: 0, value: "single_position" };
    const first = pos[0].value;
    const last = pos[pos.length - 1].value;
    const dropPct = ((first - last) / first) * 100;
    return { score: dropPct >= 10 ? 1 : dropPct >= 3 ? 0.5 : dropPct <= 0 ? -0.5 : 0, value: r4(dropPct) };
  },
  household_income(i) {
    const v = i.prospect_financial.household_income;
    if (v == null) return NONE();
    return { score: v < 35_000 ? 1 : v < 75_000 ? 0.3 : v > 150_000 ? -0.5 : 0, value: v };
  },
  net_asset_value(i) {
    const v = i.prospect_financial.net_asset_value;
    if (v == null) return NONE();
    return { score: v < 25_000 ? 1 : v < 100_000 ? 0.3 : v > 500_000 ? -0.5 : 0, value: v };
  },
  buying_power(i) {
    const v = i.prospect_financial.buying_power;
    if (!v) return NONE();
    const hit = BUYING_POWER_SCORES.find(([re]) => re.test(v));
    return { score: hit ? hit[1] : 0, value: v };
  },
  marital_status(i) {
    const m = i.guarded.marital_status;
    if (!m) return NONE();
    return { score: m.status === "divorce_or_separation" ? 1 : 0, value: m.status };
  },
  age(i) {
    const a = i.guarded.age;
    if (!a) return NONE();
    if (a.years == null) return { score: 0.5, value: a.band };
    return { score: a.years >= 70 ? 1 : a.years >= 60 ? 0.5 : 0, value: a.years };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// PER-STATE × PER-FIELD POLICY
// ═══════════════════════════════════════════════════════════════════════════
export function resolveFieldMode(field, { state = null, market = null, owner_overrides = null } = {}) {
  const policy = FIELD_STATE_POLICY[field];
  if (!policy) return { mode: FIELD_MODES.ENABLED, basis: "unguarded" };
  const ov = owner_overrides?.[field] || {};
  const st = String(state ?? "").trim().toUpperCase();
  const mk = lower(market);
  if (mk && ov[mk]) return { mode: ov[mk], basis: `owner_override_market:${mk}` };
  if (st && ov[st]) return { mode: ov[st], basis: `owner_override_state:${st}` };
  if (!st) return { mode: policy.unknown_state_mode, basis: "unknown_state" };
  if (policy.covered_states.includes(st)) return { mode: policy.covered_mode, basis: `state_law:${st}` };
  if (mk && policy.covered_markets.includes(mk)) return { mode: policy.covered_mode, basis: `local_ordinance:${mk}` };
  if (ov.default) return { mode: ov.default, basis: "owner_override_default" };
  return { mode: policy.default_mode, basis: "default" };
}

// ═══════════════════════════════════════════════════════════════════════════
// OPENING
// ═══════════════════════════════════════════════════════════════════════════
export function roundOpeningDown(value) {
  const rule = ROUNDING.find((r) => value >= r.at_or_above) || ROUNDING[ROUNDING.length - 1];
  return Math.floor(value / rule.step) * rule.step;
}
function roundUp(value) {
  const rule = ROUNDING.find((r) => value >= r.at_or_above) || ROUNDING[ROUNDING.length - 1];
  return Math.ceil(value / rule.step) * rule.step;
}

export const HOLD_REASONS = Object.freeze({
  NOT_SFR: "not_sfr_human_review",
  NO_MAO: "no_authoritative_mao",
  NO_VALUATION: "no_as_is_value_for_floor",
  FLOOR_ABOVE_WALK_AWAY: "fair_floor_above_walk_away_human_review",
});

/**
 * Compute the shadow opening, walk-away and planned ladder from collected
 * inputs. Deterministic: same inputs + config ⇒ same output.
 */
export function computeSignalOpening(inputs, { owner_overrides = null, now = null, config = {} } = {}) {
  const bounds = { ...(SPREAD_BOUNDS[inputs?.asset?.asset_class] || {}), ...(config.spread_bounds || {}) };
  const floorCfg = { ...FAIR_OFFER_FLOOR, ...(config.floor || {}) };
  const ladderCfg = { ...LADDER, ...(config.ladder || {}) };
  const nowMs = now == null ? null : typeof now === "number" ? now : Date.parse(now);
  // The clock is injected; without it the engine snapshot's computed_at dates the run.
  const clockMs = nowMs ?? Date.parse(inputs?.authority?.computed_at || "");
  const ctx = { year: Number.isFinite(clockMs) ? new Date(clockMs).getUTCFullYear() : null };
  const base = {
    engine_version: SIGNAL_OPENING_ENGINE_VERSION,
    config_version: SIGNAL_OPENING_CONFIG_VERSION,
    mode: "shadow",
    state: inputs?.state ?? null,
    market: inputs?.market ?? null,
    asset_class: inputs?.asset?.asset_class ?? null,
  };
  const hold = (reason, extra = {}) => ({ ...base, status: "hold", reason, opening: null, walk_away: null, ladder: [], ...extra });

  // SFR only — multifamily (and every other class) stays human.
  if (inputs?.asset?.asset_class !== ASSET_CLASSES.SFR || !SPREAD_BOUNDS.sfr) return hold(HOLD_REASONS.NOT_SFR);

  const a = inputs.authority;
  const mao = a.mao;
  if (mao == null || mao <= 0) return hold(HOLD_REASONS.NO_MAO);
  if (a.valuation_mid == null || a.valuation_mid <= 0) return hold(HOLD_REASONS.NO_VALUATION, { mao });

  const repairs = a.estimated_repairs != null && a.estimated_repairs > 0 && a.estimated_repairs < a.valuation_mid ? a.estimated_repairs : 0;
  const as_is_value = a.valuation_mid - repairs;
  const floor = Math.round(floorCfg.floor_pct * as_is_value);
  const margin = a.assignment_margin_floor;
  const walk_away =
    ladderCfg.walk_away_basis === "margin_protected" && margin != null && margin > 0 && margin < mao ? mao - margin : mao;

  // ── signals ─────────────────────────────────────────────────────────────
  const signals = [];
  let sum = 0;
  for (const def of SIGNALS) {
    const fm = def.class === "personal_attribute"
      ? resolveFieldMode(def.key, { state: inputs.state, market: inputs.market, owner_overrides })
      : { mode: FIELD_MODES.ENABLED, basis: "unguarded" };
    let scored = { score: null, value: null };
    if (fm.mode !== FIELD_MODES.OFF) scored = SIGNAL_SCORERS[def.key](inputs, ctx);
    const captured = scored.score != null;
    const effective_weight = fm.mode === FIELD_MODES.ENABLED ? def.weight : 0;
    const score = captured ? clamp(scored.score, -1, 1) : 0;
    const contribution = r4(effective_weight * score);
    sum += contribution;
    signals.push({
      key: def.key,
      group: def.group,
      class: def.class || "permitted",
      direction: def.direction,
      mode: fm.mode,
      mode_basis: fm.basis,
      captured,
      value: fm.mode === FIELD_MODES.OFF ? null : scored.value ?? null,
      score: captured ? r4(score) : null,
      weight: def.weight,
      effective_weight,
      contribution,
      // What it WOULD contribute at full weight (shadow-only / off fields), for review.
      shadow_contribution: captured ? r4(def.weight * score) : 0,
    });
  }

  const raw_spread = r4(bounds.base_spread + sum);
  // Owner goal: open BELOW the offer range [recommended, MAO].
  const rec = a.recommended_cash_offer;
  const below_range_min = bounds.open_at_or_below_recommended && rec != null && rec > 0 && rec < mao ? 1 - rec / mao : null;
  const effective_min_spread = r4(Math.min(bounds.max_spread, Math.max(bounds.min_spread, below_range_min ?? 0)));
  const spread = r4(clamp(raw_spread, effective_min_spread, bounds.max_spread));
  const raw_opening = mao * (1 - spread);
  const extra = { mao, walk_away, floor, as_is_value, recommended_cash_offer: a.recommended_cash_offer, signals, base_spread: bounds.base_spread, raw_spread, effective_min_spread, spread, bounds };

  if (floor > walk_away) return hold(HOLD_REASONS.FLOOR_ABOVE_WALK_AWAY, extra);

  let opening = roundOpeningDown(raw_opening);
  let floor_applied = false;
  if (opening < floor) {
    opening = Math.min(roundUp(floor), walk_away);
    floor_applied = true;
  }
  if (opening > walk_away) opening = walk_away;
  const ladder = planConcessionLadder({ opening, walk_away, config: ladderCfg });

  return {
    ...base,
    status: "ok",
    reason: floor_applied ? "opening_raised_to_fair_floor" : spread !== raw_spread ? "spread_clamped" : "signal_spread",
    ...extra,
    opening,
    floor_applied,
    spread_clamped: spread !== raw_spread,
    effective_spread: r4(1 - opening / mao),
    vs_recommended: a.recommended_cash_offer != null ? opening - a.recommended_cash_offer : null,
    ladder,
    authority: {
      decision_tier: a.decision_tier,
      computed_at: a.computed_at,
      score_snapshot_id: a.score_snapshot_id,
      assignment_margin_floor: margin,
      walk_away_basis: ladderCfg.walk_away_basis,
    },
    state_law: inputs.state ? STATE_LAW[inputs.state] || null : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CONCESSION LADDER
// ═══════════════════════════════════════════════════════════════════════════
/** Planned rungs with no counters: decreasing shares of the gap, last rung = walk-away. */
export function planConcessionLadder({ opening, walk_away, config = LADDER } = {}) {
  const o = num(opening);
  const w = num(walk_away);
  if (o == null || w == null || o > w) return [];
  const gap = w - o;
  const shares = config.rung_shares.slice(0, config.max_rounds);
  const rungs = [{ round: 0, amount: o, kind: "opening" }];
  let cum = 0;
  let prev = o;
  shares.forEach((share, idx) => {
    cum += share;
    const last = idx === shares.length - 1;
    let amount = last ? w : Math.max(prev, Math.min(w, o + Math.floor((gap * cum) / 500) * 500));
    if (amount < prev) amount = prev;
    rungs.push({ round: idx + 1, amount, kind: last ? "walk_away" : "concession", step: amount - prev });
    prev = amount;
  });
  return rungs;
}

export const LADDER_ACTIONS = Object.freeze({
  HOLD: "hold",
  CONCEDE: "concede",
  ACCEPT_COUNTER: "accept_seller_counter",
  FINAL: "final_offer_at_walk_away",
  ESCALATE: "escalate_human",
});

/**
 * Next move given the seller's latest counter. Pure + deterministic.
 *   our_offers      amounts we have put (first = opening), ascending
 *   seller_positions the seller's price positions in order (latest last)
 */
export function nextConcession({ opening, walk_away, floor = null, our_offers = [], seller_positions = [], holds = 0, config = LADDER } = {}) {
  const cfg = { ...LADDER, ...(config || {}) };
  const o = num(opening);
  const w = num(walk_away);
  if (o == null || w == null || o > w) return { action: LADDER_ACTIONS.ESCALATE, reason: "invalid_ladder_bounds", amount: null };
  const offers = (our_offers || []).map(num).filter((v) => v != null);
  const current = offers.length ? Math.max(...offers) : o;
  const concessions = Math.max(0, offers.length - 1);
  const positions = (seller_positions || []).map((p) => num(p?.value ?? p)).filter((v) => v != null);
  const counter = positions.length ? positions[positions.length - 1] : null;
  const prior = positions.length >= 2 ? positions[positions.length - 2] : null;
  const out = (action, reason, amount = null, extra = {}) => ({ action, reason, amount, current, walk_away: w, concessions, ...extra });

  if (counter != null && counter <= current) {
    if (floor != null && counter < floor) return out(LADDER_ACTIONS.ESCALATE, "seller_counter_below_fair_floor");
    return out(LADDER_ACTIONS.ACCEPT_COUNTER, "seller_at_or_below_our_offer", counter);
  }
  if (current >= w) return out(LADDER_ACTIONS.ESCALATE, "walk_away_reached");
  if (concessions >= cfg.max_rounds) return out(LADDER_ACTIONS.ESCALATE, "max_rounds_reached");
  if (counter == null) return out(LADDER_ACTIONS.HOLD, "no_counter");

  const moved_pct = prior != null && prior > 0 ? ((prior - counter) / prior) * 100 : null;
  const gap_pct = ((counter - current) / current) * 100;
  let behaviour;
  let mult;
  if (gap_pct <= cfg.closing_gap_pct) {
    behaviour = "closing";
    mult = cfg.closing_multiplier;
  } else if (moved_pct == null) {
    behaviour = "first_position";
    mult = 1;
  } else if (moved_pct <= 0) {
    behaviour = "no_movement";
    mult = 0;
  } else if (moved_pct >= cfg.flexible_move_pct) {
    behaviour = "flexible";
    mult = cfg.firm_multiplier;
  } else {
    behaviour = "small_movement";
    mult = 1;
  }
  if (mult === 0) {
    if (holds + 1 >= cfg.max_consecutive_holds) return out(LADDER_ACTIONS.ESCALATE, "seller_not_moving", null, { behaviour });
    return out(LADDER_ACTIONS.HOLD, "seller_not_moving", null, { behaviour });
  }

  const share = cfg.rung_shares[Math.min(concessions, cfg.rung_shares.length - 1)];
  const remaining = w - current;
  let step = Math.round((w - o) * share * mult);
  step = Math.max(cfg.min_step, step);
  step = Math.min(step, remaining); // never larger than the remaining gap
  let amount = current + step;
  if (amount < w) amount = Math.max(current + Math.min(cfg.min_step, remaining), Math.floor(amount / 500) * 500);
  amount = Math.min(amount, w);
  if (amount >= counter) return out(LADDER_ACTIONS.ACCEPT_COUNTER, "counter_within_step", counter, { behaviour });
  if (amount >= w) return out(LADDER_ACTIONS.FINAL, "walk_away_offer", w, { behaviour, step: w - current });
  return out(LADDER_ACTIONS.CONCEDE, `concede_${behaviour}`, amount, { behaviour, step: amount - current, moved_pct: moved_pct == null ? null : r4(moved_pct) });
}

export default computeSignalOpening;
