/**
 * COMPS INTELLIGENCE — the acquisition engine's comparable-selection rules,
 * described for the operator.
 *
 * This module DESCRIBES; it never decides. Every number mirrors
 * lib/acquisition/acquisitionDecisionEngine.js:
 *
 *   eligibilityLimits        radius / sale-age window per asset family
 *   evaluateCompEligibility  price floor, nominal ratio, size / unit bands
 *   calculateAcquisitionDecision  score floor, MAD outlier rule, top-N cut
 *   scoreComparable          weight = score × confidence × recency × source
 *   recencyScore             the calendar-month recency steps
 *   calculateValuation       the valuation-confidence blend
 *
 * tests/critical/comps-engine-rules.test.mjs probes the engine's own exported
 * functions at every boundary below, so this description cannot drift from
 * the logic it describes without a failing test.
 */

/**
 * The detail columns the engine reads for an engine-pool comp
 * (acquisitionDecisionEngine.js RPC_COMP_DETAIL_SELECT, verbatim). Scoring a
 * candidate from a narrower row is not the engine's verdict: measured
 * 2026-10-01, the workspace's 16-field row scored a Minneapolis candidate at
 * data completeness 30 where the engine's row gives 62. The contract test
 * asserts this list equals the engine's.
 */
export const ENGINE_COMP_DETAIL_COLUMNS = Object.freeze([
  'id', 'property_id', 'property_address_full', 'property_address_city', 'property_address_state', 'property_address_zip',
  'property_address_county_name', 'latitude', 'longitude', 'normalized_asset_class', 'property_type', 'property_class',
  'total_bedrooms', 'total_baths', 'building_square_feet', 'lot_square_feet', 'units_count', 'year_built',
  'effective_year_built', 'building_condition', 'construction_type', 'estimated_repair_cost',
  'renovation_level_classification', 'sale_price', 'sale_date', 'mls_sold_price', 'mls_sold_date', 'estimated_value',
  'computed_ppsf', 'comp_confidence_score', 'deal_grade',
  'subdivision_name', 'school_district_name', 'zoning', 'flood_zone', 'building_quality', 'exterior_walls',
  'interior_walls', 'floor_cover', 'roof_cover', 'roof_type', 'basement', 'garage', 'pool', 'porch', 'patio', 'deck',
  'driveway', 'stories', 'style', 'air_conditioning', 'heating_type', 'heating_fuel_type', 'sewer', 'water',
])

const LIMITS = Object.freeze({
  land: { radiusMiles: 20, months: 48 },
  commercial: { radiusMiles: 15, months: 48 },
  multifamily: { radiusMiles: 7, months: 36 },
  residential: { radiusMiles: 4, months: 30 },
})

/** Size band the engine enforces, per family (ratio = comp ÷ subject). */
const SIZE_BANDS = Object.freeze({
  residential: { field: 'sqft', label: 'Building sq ft', min: 0.5, max: 1.9, reason: 'square_feet_outside_range' },
  multifamily: { field: 'units', label: 'Unit count', min: 0.35, max: 2.75, reason: 'unit_count_outside_range' },
  commercial: { field: 'sqft', label: 'Building sq ft', min: 0.3, max: 3.5, reason: 'building_size_outside_range' },
})

/** recencyScore(): the sale's age in calendar months → recency factor. */
export const RECENCY_STEPS = Object.freeze([
  { maxMonths: 3, score: 100 },
  { maxMonths: 6, score: 94 },
  { maxMonths: 12, score: 82 },
  { maxMonths: 18, score: 68 },
  { maxMonths: 24, score: 52 },
  { maxMonths: 36, score: 30 },
  { maxMonths: null, score: 10 },
])

/** The engine's comparable rules for one asset family. Unknown families use the engine's default (residential) window. */
export function engineRulesFor(family) {
  const f = String(family ?? '').trim().toLowerCase()
  const limits = LIMITS[f] ?? LIMITS.residential
  return {
    family: f || null,
    radiusMiles: limits.radiusMiles,
    months: limits.months,
    size: SIZE_BANDS[f] ?? null,
    minSalePrice: 10_000,
    nominalPriceToValue: 0.25,
    minCompScore: 30,
    maxSelected: 12,
    pool: { source: 'engine pool (recent sold comps)', limit: 100 },
    outlier: { method: 'median_absolute_deviation', minObservations: 5, madMultiple: 3.5, floorShareOfMedian: 0.28 },
    weight: { formula: 'comparability score × comp confidence × recency × source', mlsFactor: 1, otherFactor: 0.92 },
    recency: RECENCY_STEPS,
    confidence: {
      formula: '32% depth + 25% comparability + 18% completeness + 20% consistency + 5% source diversity',
      depthFullAt: 8,
      weights: { depth: 0.32, compScore: 0.25, completeness: 0.18, consistency: 0.2, sourceDiversity: 0.05 },
    },
  }
}

/**
 * The search window the review opens on: the engine's own window, clamped to
 * what the workspace serves (≤ 10 mi, ≤ 60 mo). Opening on the engine's
 * window makes the review universe the universe the engine priced from.
 */
export function engineSearchWindow(family, caps = { radiusMiles: 10, months: 60 }) {
  const r = engineRulesFor(family)
  return {
    radiusMiles: Math.min(caps.radiusMiles, r.radiusMiles),
    months: Math.min(caps.months, r.months),
    clamped: r.radiusMiles > caps.radiusMiles || r.months > caps.months,
  }
}
