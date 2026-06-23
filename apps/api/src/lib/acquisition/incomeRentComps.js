/**
 * Acquisition Engine V3 — Item 5C: rental-comparable pipeline (mission §4).
 *
 * Builds market-rent evidence from EXISTING data only, keeping the rent universes
 * strictly separate so asking rent is never treated as executed rent:
 *   - ACTUAL rent (signed/executed lease)
 *   - ASKING rent (listing ask)
 *   - OWNER_REPORTED property-specific rent
 *   - PROVIDER estimate
 *   - MODELED market rent (priors)
 *
 * Returns low/mid/high, effective sample size, dispersion, confidence, source
 * lineage and an unavailable reason per universe. Pure & deterministic. Does NOT
 * scrape or call any external provider.
 */

import { EVIDENCE_BASIS } from './incomeSnapshotContract.js';
import { num, lower, clean, clamp, round, roundMoney } from './modelConstants.js';
import { median, stddev } from './acquisitionMath.js';

export const RENT_UNIVERSE = Object.freeze({
  ACTUAL: 'ACTUAL_RENT',
  ASKING: 'ASKING_RENT',
  OWNER_REPORTED: 'OWNER_REPORTED_RENT',
  PROVIDER_ESTIMATE: 'PROVIDER_ESTIMATE_RENT',
  MODELED_MARKET: 'MODELED_MARKET_RENT',
});

/** Map a rent record's kind → universe + evidence basis. */
function classifyRentKind(rec) {
  const k = lower(rec.rent_kind ?? rec.kind ?? '');
  if (/(signed|executed|actual|lease)/.test(k)) return { universe: RENT_UNIVERSE.ACTUAL, basis: EVIDENCE_BASIS.ACTUAL };
  if (/(asking|listing|ask|advertised)/.test(k)) return { universe: RENT_UNIVERSE.ASKING, basis: EVIDENCE_BASIS.LISTING_REPORTED };
  if (/(owner|seller|reported)/.test(k)) return { universe: RENT_UNIVERSE.OWNER_REPORTED, basis: EVIDENCE_BASIS.OWNER_REPORTED };
  if (/(provider|estimate|avm)/.test(k)) return { universe: RENT_UNIVERSE.PROVIDER_ESTIMATE, basis: EVIDENCE_BASIS.PROVIDER_REPORTED };
  return { universe: RENT_UNIVERSE.MODELED_MARKET, basis: EVIDENCE_BASIS.MARKET_MODELED };
}

/**
 * Compatibility of a rent comp with the subject. Returns a 0..100 score and the
 * factors considered; below `minScore` the comp is excluded.
 */
export function rentCompCompatibility(subject, rec) {
  const factors = {};
  let score = 100;
  // canonical lane / unit type
  if (clean(subject.lane) && clean(rec.lane) && subject.lane !== rec.lane) { score -= 40; factors.lane = 'mismatch'; }
  // beds/baths
  const sb = num(subject.beds); const cb = num(rec.beds);
  if (sb !== null && cb !== null) { const d = Math.abs(sb - cb); score -= clamp(d * 12, 0, 30); factors.beds_delta = d; }
  else { score -= 6; factors.beds = 'unknown'; }
  const sba = num(subject.baths); const cba = num(rec.baths);
  if (sba !== null && cba !== null) { score -= clamp(Math.abs(sba - cba) * 8, 0, 16); }
  // unit square feet
  const ss = num(subject.unit_sqft); const cs = num(rec.unit_sqft);
  if (ss && cs) { score -= clamp(Math.abs(1 - cs / ss) * 60, 0, 24); factors.sqft_ratio = round(cs / ss, 2); }
  // age / class
  const sy = num(subject.year_built); const cy = num(rec.year_built);
  if (sy && cy) score -= clamp(Math.abs(sy - cy) / 3, 0, 12);
  // geography (same subdivision/zip best; else penalize)
  if (clean(subject.subdivision) && clean(subject.subdivision) === clean(rec.subdivision)) { /* best */ }
  else if (clean(subject.zip) && clean(subject.zip) === clean(rec.zip)) score -= 6;
  else score -= 18;
  // utilities-included parity
  if (subject.utilities_included != null && rec.utilities_included != null && subject.utilities_included !== rec.utilities_included) score -= 8;
  return { score: clamp(score, 0, 100), factors };
}

function summarizeUniverse(universe, recs, basis) {
  if (!recs.length) {
    return { universe, available: false, unavailable_reason: 'no_records_in_universe', low: null, mid: null, high: null, effective_sample_size: 0, dispersion: null, confidence: 0, source_lineage: [], basis };
  }
  const vals = recs.map((r) => num(r.monthly_rent)).filter((v) => v !== null && v > 0).sort((a, b) => a - b);
  if (!vals.length) {
    return { universe, available: false, unavailable_reason: 'no_numeric_rents', low: null, mid: null, high: null, effective_sample_size: 0, dispersion: null, confidence: 0, source_lineage: [], basis };
  }
  const mid = median(vals);
  const disp = mid ? round(stddev(vals) / mid, 4) : null;
  const ess = vals.length;
  const avgCompat = round(recs.reduce((s, r) => s + (r._compat ?? 60), 0) / recs.length, 1);
  const confidence = clamp((ess / 6) * 60 + avgCompat * 0.3 - (disp ?? 0) * 40, 0, 100);
  return {
    universe, available: true, unavailable_reason: null, basis,
    low: roundMoney(vals[0]), mid: roundMoney(mid), high: roundMoney(vals[vals.length - 1]),
    effective_sample_size: ess, dispersion: disp, avg_compatibility: avgCompat,
    confidence: Math.round(confidence),
    source_lineage: [...new Set(recs.map((r) => clean(r.source)).filter(Boolean))],
  };
}

/**
 * @param {object} subject  { lane, beds, baths, unit_sqft, year_built, subdivision, zip, utilities_included }
 * @param {object[]} rentRecords  [{ monthly_rent, rent_kind, beds, baths, unit_sqft, year_built, subdivision, zip, source, utilities_included }]
 */
export function buildRentComparables(subject = {}, rentRecords = [], { minCompat = 45 } = {}) {
  const byUniverse = {
    [RENT_UNIVERSE.ACTUAL]: [], [RENT_UNIVERSE.ASKING]: [], [RENT_UNIVERSE.OWNER_REPORTED]: [],
    [RENT_UNIVERSE.PROVIDER_ESTIMATE]: [], [RENT_UNIVERSE.MODELED_MARKET]: [],
  };
  const basisOf = {};
  let excluded = 0;
  for (const rec of rentRecords) {
    const { universe, basis } = classifyRentKind(rec);
    basisOf[universe] = basis;
    const compat = rentCompCompatibility(subject, rec);
    if (compat.score < minCompat) { excluded += 1; continue; }
    byUniverse[universe].push({ ...rec, _compat: compat.score });
  }

  const universes = {};
  for (const u of Object.values(RENT_UNIVERSE)) {
    universes[u] = summarizeUniverse(u, byUniverse[u], basisOf[u] ?? EVIDENCE_BASIS.UNKNOWN);
  }

  // Selected market rent for downstream: prefer ACTUAL, then OWNER_REPORTED,
  // then PROVIDER, then MODELED. ASKING is NEVER selected as executed rent.
  const order = [RENT_UNIVERSE.ACTUAL, RENT_UNIVERSE.OWNER_REPORTED, RENT_UNIVERSE.PROVIDER_ESTIMATE, RENT_UNIVERSE.MODELED_MARKET];
  const selected = order.map((u) => universes[u]).find((x) => x.available) ?? null;

  return {
    universes,
    selected_market_monthly_rent: selected ? selected.mid : null,
    selected_universe: selected ? selected.universe : null,
    selected_basis: selected ? selected.basis : EVIDENCE_BASIS.UNKNOWN,
    asking_excluded_from_actual: true,
    excluded_low_compatibility: excluded,
    unavailable_reason: selected ? null : 'no_qualified_rent_universe',
  };
}
