/**
 * Acquisition Engine V3 — repair & stabilization model (mission Item 4 §8).
 *
 * Returns repair RANGES with labeled assumptions and missing inputs. Distinguishes
 * one-time rehab (used by the cash-offer / buyer-exit bridge) from recurring
 * operating repairs and replacement reserves (used by income / creative models),
 * so costs are never double-counted across offer / exit / novation / income.
 */

import { ASSET_FAMILIES, lower, num, roundMoney, clamp, round } from './modelConstants.js';

function conditionRatePerSqft(conditionText, family) {
  const c = lower(conditionText);
  if (/heavy|gut|tear|condemn|poor|distress|fire|major/.test(c)) return 65;
  if (/moderate|fixer|fair|needs work|dated|average-/.test(c)) return 38;
  if (/light|good|updated|turnkey|renovated|excellent|new/.test(c)) return 14;
  if (family === ASSET_FAMILIES.COMMERCIAL) return 22;
  if (family === ASSET_FAMILIES.MULTIFAMILY || family === ASSET_FAMILIES.SMALL_MULTI) return 28;
  return 24;
}

export function estimateRepairs(subjectRow = {}, { family = ASSET_FAMILIES.UNKNOWN } = {}) {
  const sqft = num(subjectRow.building_square_feet) ?? num(subjectRow.sqft) ?? 0;
  const conditionText = `${subjectRow.building_condition ?? ''} ${subjectRow.rehab_level ?? ''} ${subjectRow.condition ?? ''} ${subjectRow.renovation_level_classification ?? ''}`;
  const assumptions = [];
  const missing = [];

  let mid;
  let confidence;
  let source;
  const known = num(subjectRow.estimated_repair_cost);
  if (known !== null && known >= 0) {
    mid = known;
    confidence = 85;
    source = 'subject_estimated_repair_cost';
  } else if (family === ASSET_FAMILIES.LAND) {
    mid = 0;
    confidence = 70;
    source = 'land_no_structure';
  } else {
    const rate = conditionRatePerSqft(conditionText, family);
    const hasCondition = lower(conditionText).trim().length > 0;
    if (!sqft) missing.push('building_square_feet');
    if (!hasCondition) missing.push('building_condition');
    mid = Math.max(5_000, sqft * rate);
    confidence = hasCondition && sqft ? 55 : 32;
    source = hasCondition ? 'condition_rate_per_sqft' : 'asset_default_rate_per_sqft';
    assumptions.push(`rate_per_sqft=${rate}`);
    // Age penalty when no explicit cost.
    const yr = num(subjectRow.effective_year_built) ?? num(subjectRow.year_built);
    if (yr && yr < 1985) {
      mid *= 1.15;
      assumptions.push('pre_1985_age_uplift_15pct');
    }
  }

  mid = roundMoney(mid);
  const low = roundMoney(mid * 0.7);
  const high = roundMoney(mid * 1.45);
  const isIncome =
    family === ASSET_FAMILIES.MULTIFAMILY || family === ASSET_FAMILIES.COMMERCIAL;

  return {
    repair_low: low,
    repair_mid: mid,
    repair_high: high,
    immediate_repairs: roundMoney(mid * 0.6),
    deferred_maintenance: roundMoney(mid * 0.4),
    // Recurring items — NOT added to the one-time rehab in the cash bridge.
    stabilization_capex: isIncome ? roundMoney(mid * 0.5) : 0,
    operating_repairs_annual: isIncome ? roundMoney(sqft * 1.5) : roundMoney(mid * 0.05),
    replacement_reserve_annual: roundMoney((sqft || 0) * 0.6),
    repair_confidence: confidence,
    repair_source: source,
    repair_assumptions: assumptions,
    missing_repair_inputs: missing,
  };
}
