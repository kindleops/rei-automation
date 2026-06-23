/**
 * Deterministic comp similarity scoring — mirrors Comp Intelligence workspace logic.
 */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export const INCLUSION_THRESHOLD = 45;

export const EXCLUSION_REASONS = {
  wrong_asset_type: 'Wrong asset type',
  excessive_distance: 'Excessive distance',
  stale_sale: 'Stale sale',
  size_mismatch: 'Size mismatch',
  unit_mismatch: 'Unit count mismatch',
  missing_sale_price: 'Missing sale price',
  invalid_coordinates: 'Invalid coordinates',
  extreme_outlier: 'Extreme price outlier',
  low_similarity: 'Similarity below inclusion threshold',
  manual_excluded: 'Manually excluded',
};

export function calculateCompMatchScore(comp = {}, subject = {}) {
  let score = 0;

  let distanceScore = 0;
  const dist = comp.distance_miles ?? comp.distanceMiles ?? 99;
  if (dist <= 0.25) distanceScore = 20;
  else if (dist <= 0.5) distanceScore = 18;
  else if (dist <= 1.0) distanceScore = 15;
  else if (dist <= 1.5) distanceScore = 12;
  else if (dist <= 3.0) distanceScore = 8;
  else distanceScore = 4;
  score += distanceScore;

  let assetTypeScore = 0;
  const compAsset = comp.asset_type ?? comp.assetClass ?? comp.normalized_asset_class;
  const subjectAsset = subject.asset_type ?? subject.assetClass ?? subject.normalized_asset_class;
  if (compAsset && subjectAsset && compAsset === subjectAsset) assetTypeScore = 20;
  else if (
    ['single_family', 'multifamily'].includes(compAsset) &&
    ['single_family', 'multifamily'].includes(subjectAsset)
  ) {
    assetTypeScore = 12;
  }
  score += assetTypeScore;

  let propertyTypeScore = 0;
  const compType = comp.property_type ?? comp.propertyType;
  const subjectType = subject.property_type ?? subject.propertyType;
  if (compType && subjectType && compType === subjectType) propertyTypeScore = 10;
  else if (compType && subjectType && String(compType).includes(String(subjectType))) propertyTypeScore = 6;
  else if (!compType || !subjectType) propertyTypeScore = 3;
  score += propertyTypeScore;

  let sqftUnitsScore = 0;
  const subjectUnits = num(subject.units ?? subject.units_count);
  const compUnits = num(comp.units ?? comp.units_count);
  const subjectSqft = num(subject.square_feet ?? subject.sqft ?? subject.building_square_feet);
  const compSqft = num(comp.sqft ?? comp.building_square_feet);
  if (subjectAsset === 'multifamily') {
    const sUnits = subjectUnits ?? 1;
    const cUnits = compUnits ?? 1;
    const diff = Math.abs(sUnits - cUnits);
    if (diff === 0) sqftUnitsScore = 15;
    else if (diff <= 1) sqftUnitsScore = 12;
    else if (diff <= 4) sqftUnitsScore = 8;
    else sqftUnitsScore = 3;
  } else if (subjectSqft && compSqft) {
    const diffPct = Math.abs(subjectSqft - compSqft) / subjectSqft;
    if (diffPct <= 0.1) sqftUnitsScore = 15;
    else if (diffPct <= 0.2) sqftUnitsScore = 12;
    else if (diffPct <= 0.3) sqftUnitsScore = 8;
    else sqftUnitsScore = 3;
  } else sqftUnitsScore = 3;
  score += sqftUnitsScore;

  let bedsBathsScore = 0;
  const sBeds = num(subject.bedrooms ?? subject.beds ?? subject.total_bedrooms) ?? 0;
  const cBeds = num(comp.beds ?? comp.total_bedrooms) ?? 0;
  const sBaths = num(subject.bathrooms ?? subject.baths ?? subject.total_baths) ?? 0;
  const cBaths = num(comp.baths ?? comp.total_baths) ?? 0;
  if (sBeds > 0 && cBeds > 0) {
    if (sBeds === cBeds && sBaths === cBaths) bedsBathsScore = 10;
    else if (Math.abs(sBeds - cBeds) <= 1 && Math.abs(sBaths - cBaths) <= 0.5) bedsBathsScore = 6;
  } else bedsBathsScore = 3;
  score += bedsBathsScore;

  let yearBuiltScore = 0;
  const sYear = num(subject.year_built ?? subject.yearBuilt) ?? 0;
  const cYear = num(comp.year_built ?? comp.yearBuilt) ?? 0;
  if (sYear > 0 && cYear > 0) {
    const diff = Math.abs(sYear - cYear);
    if (diff <= 5) yearBuiltScore = 10;
    else if (diff <= 10) yearBuiltScore = 8;
    else if (diff <= 20) yearBuiltScore = 5;
    else yearBuiltScore = 2;
  } else yearBuiltScore = 3;
  score += yearBuiltScore;

  let saleRecencyScore = 0;
  const soldDateRaw = comp.sold_date ?? comp.sale_date ?? comp.mls_sold_date ?? comp.soldDate;
  const soldDate = soldDateRaw ? new Date(soldDateRaw) : null;
  if (soldDate && !Number.isNaN(soldDate.getTime())) {
    const daysAgo = (Date.now() - soldDate.getTime()) / 86400000;
    if (daysAgo <= 30) saleRecencyScore = 10;
    else if (daysAgo <= 90) saleRecencyScore = 8;
    else if (daysAgo <= 180) saleRecencyScore = 6;
    else if (daysAgo <= 365) saleRecencyScore = 4;
    else saleRecencyScore = 1;
  } else saleRecencyScore = 1;
  score += saleRecencyScore;

  let conditionScore = 0;
  const compCondition = comp.condition ?? comp.building_condition ?? 'Unknown';
  const subjectCondition = subject.condition ?? subject.building_condition ?? 'Unknown';
  if (compCondition === subjectCondition && compCondition !== 'Unknown') conditionScore = 5;
  else if (compCondition === 'Unknown' || subjectCondition === 'Unknown') conditionScore = 2;
  else conditionScore = 1;
  score += conditionScore;

  let isOutlier = false;
  let outlierReason = null;
  const soldPrice = num(comp.sold_price ?? comp.sale_price ?? comp.mls_sold_price ?? comp.soldPrice);
  const subjectEstimate = num(subject.estimated_value ?? subject.estimatedValue);
  if (soldPrice && subjectEstimate && subjectEstimate > 25000) {
    const diff = Math.abs(soldPrice - subjectEstimate) / subjectEstimate;
    if (diff > 0.85) {
      isOutlier = true;
      outlierReason = 'Price varies >85% from subject estimate';
    }
  }

  let label = 'Exclude / Review';
  if (score >= 90) label = 'Elite Match';
  else if (score >= 80) label = 'Strong Match';
  else if (score >= 70) label = 'Usable Match';
  else if (score >= 55) label = 'Weak Match';

  const exclusionReasons = [];
  if (!soldPrice) exclusionReasons.push(EXCLUSION_REASONS.missing_sale_price);
  if (!num(comp.latitude ?? comp.lat) || !num(comp.longitude ?? comp.lng)) {
    exclusionReasons.push(EXCLUSION_REASONS.invalid_coordinates);
  }
  if (compAsset && subjectAsset && compAsset !== subjectAsset && assetTypeScore < 12) {
    exclusionReasons.push(EXCLUSION_REASONS.wrong_asset_type);
  }
  if (dist > 3) exclusionReasons.push(EXCLUSION_REASONS.excessive_distance);
  if (isOutlier) exclusionReasons.push(EXCLUSION_REASONS.extreme_outlier);
  if (score < INCLUSION_THRESHOLD) exclusionReasons.push(EXCLUSION_REASONS.low_similarity);

  const autoIncluded = score >= INCLUSION_THRESHOLD && !!soldPrice && !isOutlier;

  return {
    score,
    label,
    reasoning: {
      distanceScore,
      assetTypeScore,
      propertyTypeScore,
      sqftUnitsScore,
      bedsBathsScore,
      yearBuiltScore,
      saleRecencyScore,
      conditionScore,
      isOutlier,
      outlierReason,
    },
    exclusion_reasons: exclusionReasons,
    auto_included: autoIncluded,
    auto_excluded: !autoIncluded,
  };
}

export function detectOutliers(comps = [], subject = {}) {
  const prices = comps
    .map((c) => num(c.sold_price ?? c.sale_price ?? c.mls_sold_price ?? c.soldPrice))
    .filter((p) => p && p > 0)
    .sort((a, b) => a - b);
  if (prices.length < 4) return comps;

  const q1 = prices[Math.floor(prices.length * 0.25)];
  const q3 = prices[Math.floor(prices.length * 0.75)];
  const iqr = q3 - q1;
  const low = q1 - 1.5 * iqr;
  const high = q3 + 1.5 * iqr;

  return comps.map((comp) => {
    const price = num(comp.sold_price ?? comp.sale_price ?? comp.mls_sold_price ?? comp.soldPrice);
    const ppsf = num(comp.computed_ppsf ?? comp.ppsf);
    const isPriceOutlier = price ? price < low || price > high : false;
    const scoring = comp.scoring ?? calculateCompMatchScore(comp, subject);
    if (!isPriceOutlier) return { ...comp, scoring };
    return {
      ...comp,
      scoring: {
        ...scoring,
        reasoning: {
          ...scoring.reasoning,
          isOutlier: true,
          outlierReason: 'IQR price outlier',
        },
        exclusion_reasons: [...new Set([...(scoring.exclusion_reasons ?? []), EXCLUSION_REASONS.extreme_outlier])],
        auto_included: false,
        auto_excluded: true,
      },
    };
  });
}

export default { calculateCompMatchScore, detectOutliers, INCLUSION_THRESHOLD, EXCLUSION_REASONS };