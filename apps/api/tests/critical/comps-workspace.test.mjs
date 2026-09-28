/**
 * COMPS INTELLIGENCE workspace — pure builders. The workspace judges every
 * candidate with the engine's scoreComparable (covered by the engine suites);
 * these tests pin what this layer adds: observable subject-vs-comp facts,
 * measured sufficiency, set statistics, per-asset dimensions and complete
 * reason labels for every engine code.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { compareToSubject, dimensionsFor, evidenceSufficiency, REASON_LABELS, setStats } from '../../src/lib/domain/comp-intelligence/comps-workspace-service.js'

const DAY = 86_400_000
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10)

test('subject-vs-comp facts are deltas, not a composite score', () => {
  const s = { sqft: 1842, beds: 3, baths: 2, yearBuilt: 1987, lotSqft: 6000, units: 1 }
  const c = { sqft: 1920, beds: 3, baths: 2.5, yearBuilt: 1989, lotSqft: 5400, units: 1, saleDate: iso(38), assetMatch: true }
  const d = compareToSubject(s, c)
  assert.equal(d.sqftPct, 4)
  assert.equal(d.beds, 0)
  assert.equal(d.baths, 0.5)
  assert.equal(d.years, 2)
  assert.equal(d.lotPct, -10)
  assert.equal(d.days, 38)
  assert.equal(compareToSubject(s, { saleDate: null }).days, null) // an undated sale is never "recent"
})

test('sufficiency is counted from same-type sales within a mile in the last year', () => {
  const near = (n, over = {}) => Array.from({ length: n }, (_, i) => ({ state: 'candidate', distanceMiles: 0.4, assetMatch: true, saleDate: iso(60 + i), ...over }))
  assert.equal(evidenceSufficiency(near(6)).level, 'strong')
  assert.equal(evidenceSufficiency(near(3)).level, 'moderate')
  assert.equal(evidenceSufficiency(near(1)).level, 'limited')
  assert.equal(evidenceSufficiency(near(5, { assetMatch: false })).level, 'thin')
  assert.equal(evidenceSufficiency(near(5, { state: 'excluded' })).level, 'thin')
  assert.equal(evidenceSufficiency(near(5, { saleDate: iso(500) })).level, 'thin')
})

test('set statistics: medians and observed range, adjusted from engine prices', () => {
  const st = setStats([
    { salePrice: 385000, ppsf: 210, distanceMiles: 0.3, saleDate: iso(30), engine: { adjustedPrice: 390000 } },
    { salePrice: 412000, ppsf: 228, distanceMiles: 0.5, saleDate: iso(60), engine: { adjustedPrice: 405000 } },
    { salePrice: 438000, ppsf: 240, distanceMiles: 0.9, saleDate: iso(90), engine: { adjustedPrice: 430000 } },
  ])
  assert.equal(st.count, 3)
  assert.equal(st.medianPrice, 412000)
  assert.equal(st.low, 385000)
  assert.equal(st.high, 438000)
  assert.equal(st.medianPpsf, 228)
  assert.equal(st.medianAdjusted, 405000)
  assert.equal(st.medianDistance, 0.5)
})

test('comparability dimensions follow the asset class', () => {
  assert.ok(dimensionsFor('residential').includes('beds'))
  assert.ok(dimensionsFor('multifamily').includes('units'))
  assert.ok(!dimensionsFor('multifamily').includes('beds'))
  assert.deepEqual(dimensionsFor('land').slice(0, 1), ['lot_sqft'])
})

test('every engine and recorded-deed reason code has operator language', () => {
  for (const code of [
    'invalid_sale_price', 'nominal_non_arms_length_transfer', 'package_consideration_unresolved', 'same_property',
    'asset_type_mismatch', 'sale_too_old', 'outside_radius', 'outside_zip_without_coordinates', 'square_feet_outside_range',
    'unit_count_outside_range', 'building_size_outside_range', 'comp_score_below_30', 'missing_adjusted_price',
    'adjusted_price_outlier', 'outside_top_comp_limit', 'nominal_price', 'non_arms_length', 'distress_or_transfer_deed',
  ]) assert.ok(REASON_LABELS[code], code)
})
