/**
 * ACQUISITION ENGINE V3 (MERGED) — LANE VALUATION + OFFER (binding owner rules, 2026-10-07).
 *
 * Root cause fixed: 1311 Conway (11 units) resolved to the 5+ lane, then priced
 * its offer with the SFR formula (0.72 x value - $35/sqft x 10,476 sqft repairs).
 * Every lane now has its own math, and NO lane subtracts repairs from an
 * as-is / investor price. Repairs are subtracted in exactly one place: the
 * retail ARV lane (ARV x factor - repairs).
 *
 * LANE 1   SFR / condo / townhome — INVESTOR CLUSTER PRIMARY. Entity buyers
 *          (recorded company, LLC/Inc/...; or the entity owner of record linked
 *          to the sale), cash weighted up. Institutional / iBuyer buyers form a
 *          separate universe (they pay more). Individual non-MLS and MLS sales
 *          are retail and never set the investor price. MAD outliers removed.
 * LANE 1b  RETAIL / MLS ARV — secondary: cross-check and fallback rung.
 * LANE 2   MF 2–4 — same unit count (duplex vs duplex), investor preference,
 *          radius widened stepwise when thin.
 * LANE 3   MF 5+ = commercial — price per door x real units; radius stepwise
 *          1 → 3 → 5 → 10 mi → metro; unit bands 5–20 / 21–99 / 100+; condition
 *          moves the position inside the per-door band; NOI/cap cross-check only
 *          with real operating evidence (never assumed rents or opex).
 *
 * NEVER BLANK — fallback ladder (lower rung = lower grade + larger haircut):
 *   R1 priced comps in the lane radius → R2 widened radius / recency →
 *   R3 retail ARV lane → R4 tract / ZIP investor medians (rows; MI rollups in
 *   production) → R5 all arm's-length sales x local investor ratio, then county
 *   MI medians → R6 subject AVM x investor discount (last resort).
 * Autonomous quoting stays gated (execution state + flags + negotiation); the
 * engine always returns value + ceiling + offer with a grade and a rung.
 *
 * Offer:  ceiling = investor_price x (1 - calibration[lane]) x (1 - margin[market x lane])
 *                   x (1 - haircut[rung, confidence]);  offer = ceiling (negotiation anchors lower).
 * Margin: configurable per market x lane (ACQUISITION_ENGINE_V3_MARGINS), default 13%,
 *         recorded on every offer; tuneMarginsFromOutcomes() is the hook for
 *         closing_cases / buyer-disposition outcomes (suggestions only, never auto-applied).
 * Pure and deterministic.
 */

import {
  INVESTOR_RULES_SFR,
  INVESTOR_RULES_MF24,
  INVESTOR_RULES_MF5,
  valueInvestorUniverse,
  repairEvidence,
  repairRate,
  mf5UnitBand,
} from './investorCompRules.js';

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pos = (v) => (num(v) !== null && num(v) > 0 ? num(v) : null);
const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
const round = (v, d = 0) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const round100 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v / 100) * 100);
const MF_TYPE_RE = /multi|apartment|duplex|triplex|quad|fourplex/i;

export const LANE_POLICY = Object.freeze({
  version: 'acq-v3m-lanes-1 (owner rules 2026-10-07)',
  buyer: Object.freeze({
    recorded_entity: 1, inferred_entity: 0.85, inferred_strong: 0.6, inferred_likely: 0.45,
    cash_unknown: 0.6, cash_individual: 0.5, institutional: 1, retail_mls: 1, retail_individual: 0.8, public_other: 0.3,
  }),
  cashBoost: 1.25,
  sfr: Object.freeze({ radii: [2.5, 4], wideMonths: 36 }),
  mf24: Object.freeze({ radii: [5, 10], wideMonths: 36 }),
  mf5: Object.freeze({ radii: [1, 3, 5, 10, 25], minComps: 3, wideMonths: 48 }),
  arvFactor: 0.7,
  avmInvestorDiscount: 0.75,
  // Estimator calibration = the measured median bias of the lane's investor
  // price vs recorded off-market investor purchases (backtest, tmp/acq-os/D).
  calibration: Object.freeze({ sfr: 0.1, mf24: 0.15, mf5: 0.12 }),
  defaultMargin: 0.13,
  // Final defaults per lane: SFR / 2-4 13% (owner starting margin). 5+ 6%: the
  // v3.1 5+ fee, which reproduces the owner's manual 1311 Conway offer
  // ($825K = $75K/door on a $92.9K/door investor price). Override per market x lane.
  defaultMarginByLane: Object.freeze({ sfr: 0.13, mf24: 0.13, mf5: 0.06 }),
  rungHaircut: Object.freeze({ R1: 0, R2: 0.04, R3: 0.06, R4: 0.08, R5: 0.1, R6: 0.15 }),
  confidenceHaircut: Object.freeze([[70, 0], [50, 0.03], [0, 0.06]]),
  sanity: Object.freeze({ minOfferToValue: 0.35, maxOfferToValue: 0.9 }),
  flipperSpread: 1.3,
});

export const RUNGS = Object.freeze({
  R1: 'priced_comps_lane_radius',
  R2: 'priced_comps_widened',
  R3: 'retail_arv_lane',
  R4: 'area_investor_median',
  R5: 'area_all_sales_x_investor_ratio',
  R6: 'subject_avm_last_resort',
});

// ── margin config + outcome hook ────────────────────────────────────────────
function parseMargins(env) {
  try {
    const raw = env?.ACQUISITION_ENGINE_V3_MARGINS;
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
const normMarket = (m) => text(m).toLowerCase().replace(/\s+/g, ' ');
const validMargin = (m) => Number.isFinite(Number(m)) && Number(m) >= 0 && Number(m) < 0.5;

/**
 * Margin for a market x lane. Order: explicit overrides (outcome-tuned, owner
 * approved) → env ACQUISITION_ENGINE_V3_MARGINS {"default":{"sfr":0.13},
 * "Dallas, TX":{"sfr":0.12}} → policy default 13%. Always returns its source.
 */
export function resolveMargin({ market = null, lane = 'sfr', env = process.env, overrides = null, policy = LANE_POLICY } = {}) {
  const cfg = { ...parseMargins(env), ...(overrides ?? {}) };
  const byMarket = Object.entries(cfg).find(([k]) => k !== 'default' && normMarket(k) === normMarket(market));
  if (byMarket && validMargin(byMarket[1]?.[lane])) return { margin: Number(byMarket[1][lane]), source: overrides && byMarket[0] in overrides ? 'outcome_tuned_override' : 'market_lane_config', key: `${byMarket[0]}|${lane}` };
  if (validMargin(cfg.default?.[lane])) return { margin: Number(cfg.default[lane]), source: 'default_lane_config', key: `default|${lane}` };
  return { margin: policy.defaultMarginByLane?.[lane] ?? policy.defaultMargin, source: 'policy_default', key: `policy|${lane}` };
}

/**
 * HOOK (not wired to any write): realized spreads from closed outcomes
 * (closing_cases / buyer dispositions: contract price we paid vs the price the
 * end buyer paid) -> suggested margin per market x lane. Suggestions only; an
 * owner-approved result is passed back as resolveMargin({ overrides }).
 * @param {Array<{market, lane, contract_price, end_buyer_price}>} outcomes
 */
export function tuneMarginsFromOutcomes(outcomes = [], { minN = 8, floor = 0.06, cap = 0.25 } = {}) {
  const cells = new Map();
  for (const o of outcomes) {
    const c = pos(o.contract_price);
    const e = pos(o.end_buyer_price);
    if (!c || !e || c > e * 1.2) continue;
    const key = `${text(o.market)}|${text(o.lane)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push((e - c) / e);
  }
  const out = {};
  const suggestions = [];
  for (const [key, xs] of cells) {
    const [market, lane] = key.split('|');
    const v = [...xs].sort((a, b) => a - b);
    const median = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
    const ok = v.length >= minN;
    suggestions.push({ market, lane, n: v.length, median_realized_spread: round(median, 4), suggested_margin: ok ? round(Math.min(cap, Math.max(floor, median)), 3) : null, reason: ok ? 'median_realized_spread' : `insufficient_outcomes_lt_${minN}` });
    if (ok) out[market] = { ...(out[market] ?? {}), [lane]: round(Math.min(cap, Math.max(floor, median)), 3) };
  }
  return { overrides: out, suggestions, source: 'closing_outcomes', applied: false };
}

// ── lane + identity resolution ──────────────────────────────────────────────
/**
 * Deterministic lane from the evidence. A multifamily label with units <= 1
 * (627 Ontario pattern) is resolved from building sqft and bedrooms to the most
 * likely unit count; units inferred this way are labelled and grade-capped.
 */
export function resolveSubjectLane(subject = {}, raw = {}) {
  const type = text(raw.property_type ?? subject.property_type);
  const recorded = pos(raw.units_count ?? subject.units);
  const mfLabel = MF_TYPE_RE.test(type);
  const sqft = pos(subject.sqft ?? raw.building_square_feet);
  const beds = pos(subject.beds ?? raw.total_bedrooms);
  if (recorded !== null && recorded >= 2) {
    return { lane: recorded >= 5 ? 'mf5' : 'mf24', units: recorded, units_source: 'recorded', identity_conflict: false, basis: 'recorded_unit_count' };
  }
  if (!mfLabel) return { lane: 'sfr', units: 1, units_source: recorded ? 'recorded' : 'single_family_type', identity_conflict: false, basis: 'single_family_record' };
  // MF label with no real count (or <= 1): infer from the building.
  const est = [beds ? Math.round(beds / 2.5) : null, sqft ? Math.round(sqft / 950) : null].filter((x) => x !== null);
  const inferred = est.length ? Math.round(est.reduce((s, x) => s + x, 0) / est.length) : null;
  if (inferred === null) {
    return { lane: 'mf24', units: 2, units_source: 'mf_label_minimum_no_building_evidence', identity_conflict: true, basis: 'mf_label_units_le_1_no_sqft_or_beds' };
  }
  if (inferred <= 1) {
    return { lane: 'sfr', units: 1, units_source: 'inferred_from_beds_sqft', identity_conflict: true, basis: `mf_label_but_building_reads_single_unit(beds=${beds ?? 'na'},sqft=${sqft ?? 'na'})` };
  }
  return { lane: inferred >= 5 ? 'mf5' : 'mf24', units: inferred, units_source: 'inferred_from_beds_sqft', identity_conflict: true, basis: `mf_label_units_le_1_inferred_${inferred}_from_beds_sqft` };
}

function laneParams(lane, policy, over = {}) {
  const base = lane === 'mf5' ? INVESTOR_RULES_MF5 : lane === 'mf24' ? INVESTOR_RULES_MF24 : INVESTOR_RULES_SFR;
  return {
    ...base,
    buyerPolicy: 'entity_primary',
    buyer: policy.buyer,
    cashBoost: policy.cashBoost,
    allowFallback: false,
    ...(lane === 'mf24' ? { sameUnitCount: true } : {}),
    ...(lane === 'mf5' ? { unitBands: true } : {}),
    version: `${policy.version}|${lane}`,
    ...over,
  };
}

function gradeFor(rung, confidence, identityConflict) {
  let g;
  if (rung === 'R1') g = confidence >= 70 ? 'A' : confidence >= 50 ? 'B' : 'C';
  else if (rung === 'R2') g = confidence >= 50 ? 'C' : 'D';
  else if (rung === 'R3') g = 'D';
  else if (rung === 'R4') g = 'D';
  else if (rung === 'R5') g = 'E';
  else g = 'F';
  if (identityConflict && g < 'C') g = 'C';
  return g;
}

function attempt(subject, rows, asOf, gate, bulkOf, bulkRows, params) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const res = valueInvestorUniverse({ subject, rows, bulkRows, bulkOf, asOf, params, gate });
  return res.value.mid ? res : { ...res, empty: true };
}

/** NOI/cap only from REAL operating evidence (recorded NOI + recorded cap rate). */
export function noiCrossCheck(raw = {}) {
  const noi = pos(raw.noi_estimate ?? raw.net_operating_income ?? raw.noi);
  const cap = num(raw.cap_rate);
  if (!noi) return { available: false, reason: 'no_real_operating_evidence' };
  if (!(cap > 0.02 && cap < 0.2)) return { available: false, reason: 'no_recorded_cap_rate', noi };
  return { available: true, value: round100(noi / cap), noi, cap_rate: cap, basis: 'recorded_noi_div_recorded_cap' };
}

/**
 * @param {object} p
 * @param {object} p.subject    investor-rules subject (investorSubjectFrom)
 * @param {object} p.raw        subject property row (identity, condition, AVM, NOI)
 * @param {object[]} p.rows     canonical rows in the base lane radius / window
 * @param {object[]|null} p.wideRows  canonical rows for the widened rungs (optional)
 * @param {object|null} p.areaMedians  production MI rollups { zip, city, county }: { median_ppsf, median_ppu, median_inv_price, median_price, qualified_sale_count }
 */
export function valueLaneModel({
  subject = {}, raw = {}, rows = [], wideRows = null, bulkRows = [], bulkOf = null, asOf, gate = null,
  areaMedians = null, market = null, env = process.env, marginOverrides = null, policy = LANE_POLICY,
} = {}) {
  const identity = resolveSubjectLane(subject, raw);
  const lane = identity.lane;
  const s = { ...subject, units: lane === 'sfr' ? null : identity.units };
  const lanePolicy = policy[lane];
  const radii = lanePolicy.radii;
  const baseRadius = (lane === 'mf5' ? INVESTOR_RULES_MF5 : lane === 'mf24' ? INVESTOR_RULES_MF24 : INVESTOR_RULES_SFR).radiusMiles;
  const tried = [];
  let rung = null;
  let chosen = null;
  let radiusUsed = null;

  // R1 / R2: priced (investor) comps, stepwise radius.
  for (const r of radii) {
    const wide = r > baseRadius;
    const pool = wide ? wideRows : rows;
    const months = wide ? lanePolicy.wideMonths : undefined;
    const res = attempt(s, pool, asOf, gate, bulkOf, bulkRows, laneParams(lane, policy, { radiusMiles: r, ...(months ? { months } : {}) }));
    tried.push({ rung: wide ? 'R2' : 'R1', radius_miles: r, rows: Array.isArray(pool) ? pool.length : null, ok: Boolean(res && !res.empty), method: res?.value?.method ?? 'no_rows' });
    if (res && !res.empty && res.value.selected >= (lane === 'mf5' ? lanePolicy.minComps : 1)) { rung = wide ? 'R2' : 'R1'; chosen = res; radiusUsed = r; break; }
  }
  // R2b: relax the unit band (2-4 any count / 5+ 0.5x-2x) inside the widest available rows.
  if (!chosen && lane !== 'sfr') {
    const pool = wideRows ?? rows;
    const r = wideRows ? radii[radii.length - 1] : baseRadius;
    const res = attempt(s, pool, asOf, gate, bulkOf, bulkRows, laneParams(lane, policy, { radiusMiles: r, sameUnitCount: false, unitBands: false }));
    tried.push({ rung: 'R2', radius_miles: r, relaxed_unit_band: true, ok: Boolean(res && !res.empty), method: res?.value?.method ?? 'no_rows' });
    if (res && !res.empty) { rung = 'R2'; chosen = res; radiusUsed = r; }
  }

  // Companion universes (always computed when rows exist): institutional + retail.
  const instRes = attempt(s, rows, asOf, gate, bulkOf, bulkRows, laneParams(lane, policy, { buyerPolicy: 'institutional_primary', minInvestorComps: 2, minInvestorNeff: 1 }));
  const retailRes = lane === 'mf5' ? null : attempt(s, rows, asOf, gate, bulkOf, bulkRows, laneParams(lane, policy, { buyerPolicy: 'retail_primary' }));
  const retailMid = retailRes && !retailRes.empty ? retailRes.value.mid : null;
  const repairs = repairEvidence({ estimated_repairs: num(raw.estimated_repair_cost), sqft: subject.sqft, condition: raw.building_condition ?? subject.condition });
  const arv = retailMid
    ? {
        arv: retailMid,
        factor: policy.arvFactor,
        repairs: pos(repairs.amount) ?? 0,
        repairs_confidence: repairs.confidence,
        investor_price_implied: round100(Math.max(0, retailMid * policy.arvFactor - (pos(repairs.amount) ?? 0))),
        n: retailRes.value.selected,
        basis: 'retail_mls_and_individual_non_mls_sales_as_arv_proxy',
      }
    : null;

  let investorPrice = null;
  let confidence = 0;
  let method = null;
  let evidenceIds = [];
  let perDoor = null;
  if (chosen) {
    investorPrice = chosen.value.mid;
    confidence = chosen.value.confidence;
    method = chosen.value.method;
    evidenceIds = chosen.comps.filter((c) => c.status === 'selected').map((c) => c.comp_id);
    perDoor = chosen.value.per_door ?? null;
  }
  // R3: retail ARV lane (SFR and 2-4 only; the ONLY lane that subtracts repairs).
  if (!investorPrice && arv && arv.investor_price_implied > 0) {
    rung = 'R3'; investorPrice = arv.investor_price_implied; confidence = Math.min(45, retailRes.value.confidence); method = 'retail_arv_x_factor_minus_repairs';
    evidenceIds = retailRes.comps.filter((c) => c.status === 'selected').map((c) => c.comp_id);
  }
  // R4: tract, then ZIP investor medians from the rows (production adds MI rollups).
  if (!investorPrice) {
    for (const [key, match] of [
      ['tract', (r) => text(r.census_tract) && text(r.census_tract) === text(s.census_tract) && text(r.fips) === text(s.fips)],
      ['zip', (r) => text(r.zip).slice(0, 5) && text(r.zip).slice(0, 5) === text(raw.property_address_zip ?? raw.zip).slice(0, 5)],
    ]) {
      const pool = (wideRows ?? rows).filter(match);
      const res = attempt(s, pool, asOf, gate, bulkOf, bulkRows, laneParams(lane, policy, { radiusMiles: 1e6, distanceHalfLifeMiles: 1e6, sameUnitCount: false, unitBands: false, months: lanePolicy.wideMonths }));
      tried.push({ rung: 'R4', area: key, rows: pool.length, ok: Boolean(res && !res.empty) });
      if (res && !res.empty) {
        rung = 'R4'; investorPrice = res.value.mid; confidence = Math.min(35, res.value.confidence); method = `area_investor_median_${key}`;
        evidenceIds = res.comps.filter((c) => c.status === 'selected').map((c) => c.comp_id);
        break;
      }
    }
  }
  if (!investorPrice && areaMedians) {
    const sqft = pos(subject.sqft);
    for (const level of ['zip', 'city']) {
      const m = areaMedians[level];
      if (!m) continue;
      const ratio = pos(m.median_inv_price) && pos(m.median_price) ? Math.min(1, m.median_inv_price / m.median_price) : 0.85;
      const v = lane === 'sfr' ? (pos(m.median_ppsf) && sqft ? m.median_ppsf * sqft * ratio : null) : (pos(m.median_ppu) ? m.median_ppu * identity.units * ratio : null);
      if (v) { rung = 'R4'; investorPrice = round100(v); confidence = 25; method = `mi_rollup_${level}_median_x_investor_ratio`; break; }
    }
  }
  // R5: all arm's-length sales x local investor ratio (rows), then county MI medians.
  if (!investorPrice) {
    const res = attempt(s, wideRows ?? rows, asOf, gate, bulkOf, bulkRows, laneParams(lane, policy, { allowFallback: true, sameUnitCount: false, unitBands: false, radiusMiles: wideRows ? radii[radii.length - 1] : baseRadius, months: wideRows ? lanePolicy.wideMonths : undefined }));
    tried.push({ rung: 'R5', ok: Boolean(res && !res.empty), method: res?.value?.method ?? 'no_rows' });
    if (res && !res.empty) {
      rung = 'R5'; investorPrice = res.value.mid; confidence = Math.min(30, res.value.confidence); method = res.value.method;
      evidenceIds = res.comps.filter((c) => c.status === 'selected').map((c) => c.comp_id);
    } else if (areaMedians?.county) {
      const m = areaMedians.county;
      const sqft = pos(subject.sqft);
      const ratio = pos(m.median_inv_price) && pos(m.median_price) ? Math.min(1, m.median_inv_price / m.median_price) : 0.85;
      const v = lane === 'sfr' ? (pos(m.median_ppsf) && sqft ? m.median_ppsf * sqft * ratio : null) : (pos(m.median_ppu) ? m.median_ppu * identity.units * ratio : null);
      if (v) { rung = 'R5'; investorPrice = round100(v); confidence = 20; method = 'mi_rollup_county_median_x_investor_ratio'; }
    }
  }
  // R6: the subject's own AVM x investor discount (last resort; never authorized).
  if (!investorPrice && pos(raw.estimated_value)) {
    rung = 'R6'; investorPrice = round100(raw.estimated_value * policy.avmInvestorDiscount); confidence = 10; method = 'subject_avm_x_investor_discount';
  }

  // MF 5+: condition positions inside the per-door band; NOI/cap cross-check (real evidence only).
  let conditionPosition = null;
  if (lane === 'mf5' && perDoor && identity.units) {
    const poor = /poor|fair|distress|heavy|gut|fire|condemn|needs work|major/i.test(text(raw.building_condition ?? subject.condition));
    if (poor && perDoor.low) {
      conditionPosition = 'band_low_poor_condition';
      investorPrice = round100(perDoor.low * identity.units);
    } else conditionPosition = 'band_mid_condition_not_poor_or_unknown';
  }
  const noi = lane === 'mf5' ? noiCrossCheck(raw) : null;

  // Flipper signal: entity buys well below nearby retail are the right investor price (evidence).
  const flipper = investorPrice && retailMid && retailMid / investorPrice >= policy.flipperSpread && (rung === 'R1' || rung === 'R2')
    ? { retail_mid: retailMid, investor_price: investorPrice, ratio: round(retailMid / investorPrice, 3), entity_comp_ids: evidenceIds.slice(0, 8), note: 'entity buys priced as flip/rental acquisitions; investor price kept' }
    : null;

  const grade = investorPrice ? gradeFor(rung, confidence, identity.identity_conflict) : null;
  const offer = buildLaneOffer({ investorPrice, lane, rung, confidence, grade, units: identity.units, unitsSource: identity.units_source, market, env, marginOverrides, policy, retailMid });
  return {
    version: policy.version,
    lane,
    identity,
    rung,
    rung_name: rung ? RUNGS[rung] : null,
    radius_miles: radiusUsed,
    // Ring: 1 = the nearest radius of the lane ladder (autonomy starts at grade A + ring 1).
    ring: radiusUsed != null ? radii.indexOf(radiusUsed) + 1 : null,
    method,
    investor_price: investorPrice,
    confidence: investorPrice ? Math.round(confidence) : 0,
    confidence_grade: grade,
    per_door: perDoor,
    condition_position: conditionPosition,
    evidence_ids: evidenceIds.slice(0, 25),
    ladder: tried,
    institutional: instRes && !instRes.empty ? { mid: instRes.value.mid, n: instRes.value.selected, note: 'institutional / iBuyer buyers: separate universe, not the investor price' } : null,
    retail_arv: arv,
    flipper_signal: flipper,
    noi_cross_check: noi,
    repairs_evidence: repairs,
    priced: chosen ?? null,
    offer,
  };
}

/** Lane offer: never subtracts repairs (the ARV rung already netted them inside its implied investor price). */
export function buildLaneOffer({ investorPrice, lane = 'sfr', rung = 'R1', confidence = 0, grade = null, units = null, unitsSource = null, market = null, env = process.env, marginOverrides = null, policy = LANE_POLICY, retailMid = null } = {}) {
  const P = pos(investorPrice);
  const marginInfo = resolveMargin({ market, lane, env, overrides: marginOverrides, policy });
  if (!P) return { available: false, reasons: ['no_value_from_any_rung'], margin: marginInfo, policy_version: policy.version };
  const comparable = ['R1', 'R2', 'R4', 'R5'].includes(rung);
  const calibration = comparable ? policy.calibration[lane] ?? 0 : 0;
  const confHaircut = rung === 'R1' || rung === 'R2' ? policy.confidenceHaircut.find(([min]) => confidence >= min)[1] : 0;
  const haircut = (policy.rungHaircut[rung] ?? 0.15) + confHaircut;
  const ceilingRaw = P * (1 - calibration) * (1 - marginInfo.margin) * (1 - haircut);
  const reasons = [];
  if (pos(retailMid) && P > retailMid) reasons.push('investor_price_above_retail_context_review');
  const ratio = ceilingRaw / P;
  const withinBounds = ratio >= policy.sanity.minOfferToValue && ratio <= policy.sanity.maxOfferToValue;
  if (!withinBounds) reasons.push('offer_outside_sanity_bounds_review');
  const realUnits = Number.isInteger(Number(units)) && Number(units) >= 2 ? Number(units) : null;
  const ceiling = round100(ceilingRaw);
  const out = {
    available: true,
    offer_model: 'lane_v1',
    policy_version: policy.version,
    lane,
    rung,
    confidence_grade: grade,
    investor_price: round100(P),
    calibration_pct: round(calibration * 100, 1),
    margin_pct: round(marginInfo.margin * 100, 1),
    margin_source: marginInfo.source,
    margin_key: marginInfo.key,
    haircut_pct: round(haircut * 100, 1),
    ceiling,
    recommended_cash_offer: ceiling,
    opening_hint: round100(Math.max(0, ceilingRaw - Math.max(5_000, P * 0.03))),
    offer_to_investor_price: round(ratio, 3),
    repairs_basis: rung === 'R3' ? 'arv_lane_only: arv_x_factor_minus_repairs' : 'as_is_investor_price_repairs_never_subtracted',
    sanity: { within_bounds: withinBounds, ...policy.sanity },
    bridge: [
      { step: 'investor_price', amount: round100(P), rung },
      { step: 'less_calibration', amount: -round100(P * calibration), pct: round(calibration, 4) },
      { step: 'less_margin', amount: -round100(P * (1 - calibration) * marginInfo.margin), pct: round(marginInfo.margin, 4), source: marginInfo.source },
      { step: 'less_haircut', amount: -round100(P * (1 - calibration) * (1 - marginInfo.margin) * haircut), pct: round(haircut, 4) },
      { step: 'ceiling', amount: ceiling },
      { step: 'recommended_cash_offer', amount: ceiling, note: 'offer = ceiling; negotiation anchors below it' },
    ],
    reasons,
  };
  if (realUnits && lane !== 'sfr') {
    out.per_unit = { units: realUnits, units_source: unitsSource, value: round100(P / realUnits), offer: round100(ceilingRaw / realUnits), ceiling: round100(ceilingRaw / realUnits) };
  }
  return out;
}

/** Repair-rate helper re-export (tests/diagnostics). */
export { repairRate, mf5UnitBand };
