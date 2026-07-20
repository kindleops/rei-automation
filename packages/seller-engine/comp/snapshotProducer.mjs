// P3-8: the ACTUAL immutable comp/market snapshot producer implementing
// comp/SNAPSHOT_INTERFACE.md. Consumes candidates from the acquisition-engine
// adapter (or fixtures), freezes every selection/exclusion decision, and emits
// a validated snapshot document. Pure function of its inputs.
import { deterministicId, sha256 } from '../lib/hash.mjs';
import { toMs } from '../lib/timeSafety.mjs';
import { validateSnapshot } from './snapshotAdapter.mjs';
import { eligibilityWindow, assetFamilyOf, transactionReliability, SOURCE_QUERY_VERSION } from './acquisitionEngineAdapter.mjs';

const DAY = 86_400_000;

export function produceSnapshot({ subject, candidates, asOf, buyerStats = null,
  inventoryStats = null, rentStats = null,
  sourceQueryVersion = SOURCE_QUERY_VERSION }) {
  const fam = assetFamilyOf(subject.asset_class);
  const win = eligibilityWindow(fam);
  const asOfMs = toMs(asOf);
  const warnings = [];

  const eligibility = {};
  const exclusions = {};
  const eligible = [];
  for (const c of candidates) {
    const reasons = [];
    const rel = transactionReliability(c);
    const saleMs = toMs(c.sale_date);
    if (saleMs === null) reasons.push('undated_sale');
    else if (saleMs > asOfMs) reasons.push('post_as_of_sale (time safety)');
    else if (asOfMs - saleMs > win.monthsBack * 30.44 * DAY) reasons.push(`stale>${win.monthsBack}m`);
    if (c.distance_miles !== null && c.distance_miles > win.radiusMiles) reasons.push(`distance>${win.radiusMiles}mi`);
    if (!['valuation', 'valuation_caution'].includes(rel)) reasons.push(`price_reliability:${rel}`);
    if (!c.sale_price || c.sale_price < 1000) reasons.push('implausible_price');
    const sizeSim = similarity(c.building_square_feet, subject.building_square_feet, 0.5);
    if (subject.building_square_feet && c.building_square_feet && sizeSim < 0.2) reasons.push('size_dissimilar');
    if (reasons.length) {
      exclusions[c.comp_id] = reasons.join('; ');
      continue;
    }
    const recencySim = 1 - Math.min(1, (asOfMs - saleMs) / (win.monthsBack * 30.44 * DAY));
    const distSim = c.distance_miles === null ? 0.5 : 1 - Math.min(1, c.distance_miles / win.radiusMiles);
    const ageSim = similarity(c.year_built, subject.year_built, 40);
    const condSim = conditionSimilarity(c.condition_raw, subject.condition_raw);
    const weight = Math.round(100 * (0.30 * distSim + 0.25 * recencySim + 0.25 * sizeSim + 0.10 * ageSim + 0.10 * condSim)) / 100;
    eligibility[c.comp_id] = {
      distance_miles: c.distance_miles, days_old: Math.round((asOfMs - saleMs) / DAY),
      price_reliability: rel, size_similarity: round2(sizeSim), age_similarity: round2(ageSim),
      condition_similarity: round2(condSim), weight,
    };
    eligible.push({ ...c, weight });
  }

  // valuation range from weighted eligible comps
  let valuationLow = null; let valuationHigh = null; let valuationConfidence = 0; let weightedScore = null;
  if (eligible.length >= 3) {
    const unitPrices = eligible
      .map((c) => ({ v: c.building_square_feet && subject.building_square_feet
        ? (c.sale_price / c.building_square_feet) * subject.building_square_feet
        : c.sale_price, w: c.weight }))
      .sort((a, b) => a.v - b.v);
    const totW = unitPrices.reduce((s, x) => s + x.w, 0);
    const q = (p) => {
      let acc = 0;
      for (const x of unitPrices) { acc += x.w; if (acc / totW >= p) return x.v; }
      return unitPrices[unitPrices.length - 1].v;
    };
    valuationLow = Math.round(q(0.25));
    valuationHigh = Math.round(q(0.75));
    weightedScore = round2(totW / eligible.length);
    const spreadRel = (valuationHigh - valuationLow) / Math.max(valuationLow, 1);
    valuationConfidence = round2(Math.max(0.1, Math.min(0.9,
      0.3 + 0.05 * Math.min(eligible.length, 8) - 0.4 * Math.min(spreadRel, 1))));
    if (eligible.length < 6) warnings.push(`thin_comp_set:${eligible.length}`);
    if (spreadRel > 0.5) warnings.push('wide_valuation_spread');
  } else {
    warnings.push(`insufficient_eligible_comps:${eligible.length}`);
  }

  // market velocity from eligible comp dates (sales/month inside window)
  const saleVelocity = eligible.length
    ? round2(eligible.length / Math.max(1, win.monthsBack)) : null;
  const cohortN = eligible.length;
  const cohortRung = cohortN >= 12 ? 2 : cohortN >= 3 ? 4 : 7;
  if (cohortRung >= 7) warnings.push('cohort_degraded_national_rung');
  else if (cohortN < 12) warnings.push(`cohort_degraded_thin:${cohortN}`);

  const buyerVelocity = buyerStats?.buyer_velocity ?? null;
  const buyerConfidence = buyerStats?.confidence ?? 0;
  if (buyerVelocity === null) warnings.push('buyer_stats_unavailable');

  // ---------------- interface v2 ----------------
  // Renovated-vs-as-is spread: condition_raw exists on comps, so the spread is
  // MEASURED from good-condition vs poor-condition comp unit prices — never
  // invented. Requires >=2 comps on each side of the condition split.
  const rank = { Excellent: 1, 'Very Good': 2, Good: 3, Average: 4, Fair: 5, Poor: 6, Unsound: 7 };
  const subjSqft = subject.building_square_feet ?? null;
  const unitPrice = (c) => (c.building_square_feet && subjSqft
    ? (c.sale_price / c.building_square_feet) * subjSqft : c.sale_price);
  const goodComps = eligible.filter((c) => (rank[c.condition_raw] ?? 99) <= 3);
  const poorComps = eligible.filter((c) => (rank[c.condition_raw] ?? 0) >= 5);
  const median = (arr) => {
    const a = [...arr].sort((x, y) => x - y);
    return a.length ? a[Math.floor((a.length - 1) / 2)] : null;
  };
  let renovatedSpread = null;
  if (goodComps.length >= 2 && poorComps.length >= 2) {
    const goodMed = median(goodComps.map(unitPrice));
    const poorMed = median(poorComps.map(unitPrice));
    renovatedSpread = {
      good_n: goodComps.length, poor_n: poorComps.length,
      good_condition_value_median: Math.round(goodMed),
      as_is_condition_value_median: Math.round(poorMed),
      spread_abs_for_subject: Math.round(goodMed - poorMed),
      confidence: round2(Math.min(0.7, 0.2 + 0.05 * Math.min(goodComps.length + poorComps.length, 8))),
    };
    if (renovatedSpread.spread_abs_for_subject <= 0) warnings.push('renovated_spread_nonpositive (condition gradient not observed)');
  } else {
    warnings.push('renovated_spread_unavailable (needs >=2 good-condition and >=2 poor-condition comps)');
  }

  // cohort value percentiles + subject percentile (comp-implied distribution)
  let cohortValuePercentiles = null;
  let subjectValuePercentile = null;
  if (eligible.length >= 3) {
    const values = eligible.map(unitPrice).sort((a, b) => a - b);
    const pct = (p) => Math.round(values[Math.min(values.length - 1, Math.floor(p * values.length))]);
    cohortValuePercentiles = { p10: pct(0.10), p25: pct(0.25), p50: pct(0.50), p75: pct(0.75), p90: pct(0.90) };
    const sv = subject.estimated_value ?? null;
    if (sv !== null && sv > 0) {
      subjectValuePercentile = round2(values.filter((v2) => v2 <= sv).length / values.length);
    } else warnings.push('subject_value_missing_for_percentile');
  }

  // repair burden context: vendor repair baseline (rule 9: baseline-comparison
  // only) relative to value and to the MEASURED renovated spread
  const repairCost = subject.estimated_repair_cost ?? null;
  const subjValue = subject.estimated_value ?? null;
  let repairBurden = null;
  if (repairCost !== null && repairCost > 0 && subjValue !== null && subjValue > 0) {
    repairBurden = {
      repair_cost_baseline: repairCost,
      repair_to_value: round2(repairCost / subjValue),
      repair_to_renovated_spread: renovatedSpread && renovatedSpread.spread_abs_for_subject > 0
        ? round2(repairCost / renovatedSpread.spread_abs_for_subject) : null,
      baseline_quality: 'vendor_baseline_rule9_never_canonical',
    };
  } else warnings.push('repair_burden_unavailable (no vendor baseline or value)');

  // rent context: NO rent source exists in the corpus — stays null + warned,
  // never synthesized (F-008 remains blocked)
  const rentContext = rentStats ?? null;
  if (rentContext === null) warnings.push('rent_context_unavailable');
  const absorption = inventoryStats?.inventory_absorption ?? null;
  if (absorption === null) warnings.push('inventory_absorption_unavailable');

  const cohortSufficiency = {
    eligible: cohortN,
    sufficient_for_valuation: cohortN >= 3,
    sufficient_for_spread: Boolean(renovatedSpread),
    sufficient_for_percentiles: cohortN >= 3,
    required_full_confidence: 12,
  };

  const doc = {
    id: deterministicId('mfs', subject.property_id, asOf, sourceQueryVersion,
      sha256(JSON.stringify(candidates.map((c) => c.comp_id).sort()))),
    subject_property_id: subject.property_id,
    as_of: asOf,
    asset_class: subject.asset_class ?? 'single_family',
    asset_subtype: subject.asset_subtype ?? null,
    cohort_rung: cohortRung,
    cohort_key: `${subject.fips ?? subject.situs_state ?? 'unk'}|${fam}|r${win.radiusMiles}mi_${win.monthsBack}m`,
    cohort_n: cohortN,
    selected_comp_ids: eligible.map((c) => c.comp_id),
    comp_eligibility: eligibility,
    comp_exclusions: exclusions,
    weighted_comp_score: weightedScore,
    valuation_low: valuationLow,
    valuation_high: valuationHigh,
    valuation_confidence: valuationConfidence,
    sale_velocity: saleVelocity,
    inventory_absorption: absorption,
    buyer_velocity: buyerVelocity,
    buyer_demand_confidence: buyerConfidence,
    // -------- interface v2 fields --------
    snapshot_interface_version: 2,
    renovated_spread: renovatedSpread,
    cohort_value_percentiles: cohortValuePercentiles,
    subject_value_percentile: subjectValuePercentile,
    repair_burden: repairBurden,
    rent_context: rentContext,
    cohort_sufficiency: cohortSufficiency,
    warnings,
    source_engine: `seller-engine snapshotProducer@p4-v2 over ${sourceQueryVersion}`,
    subject_facts_frozen: {
      building_square_feet: subject.building_square_feet ?? null,
      year_built: subject.year_built ?? null,
      condition_raw: subject.condition_raw ?? null,
      situs_state: subject.situs_state ?? null,
      estimated_value: subject.estimated_value ?? null,
      estimated_repair_cost: subject.estimated_repair_cost ?? null,
    },
  };
  const v = validateSnapshot(doc);
  if (!v.valid && !(cohortN < 12)) throw new Error(`producer emitted invalid snapshot: ${v.errors.join('; ')}`);
  return doc;
}

function similarity(a, b, halfRange) {
  if (a === null || a === undefined || b === null || b === undefined) return 0.5;
  // halfRange <= 1: fraction of the subject value (e.g. 0.5 = ±50% size band);
  // halfRange  > 1: absolute units (e.g. 40 years for age similarity)
  const denom = halfRange <= 1 ? Math.max(Math.abs(b) * halfRange, 1) : halfRange;
  return Math.max(0, 1 - Math.abs(a - b) / denom);
}
function conditionSimilarity(a, b) {
  const rank = { Excellent: 1, 'Very Good': 2, Good: 3, Average: 4, Fair: 5, Poor: 6, Unsound: 7 };
  if (!rank[a] || !rank[b]) return 0.5;
  return Math.max(0, 1 - Math.abs(rank[a] - rank[b]) / 4);
}
const round2 = (x) => Math.round(x * 100) / 100;
