/**
 * ASSET-FAMILY GATES. Automated offers are priced from comps; a multifamily
 * subject must never be priced from single-family sales (or the reverse), on
 * the engine path or the legacy Comps path, whatever the corpus contains.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assetFamilyInvariantHolds, normalizePropertyFeatures, scoreComparable, unitCountCredible } from '../../src/lib/acquisition/acquisitionDecisionEngine.js'
import { assetGate, compAssetFamily } from '../../src/lib/domain/comp-intelligence/comp-discovery.js'

const mf = (units) => ({ asset_type: 'multifamily', asset_family: 'multifamily', units })
const sfr = { asset_type: 'single_family', asset_family: 'residential', units: 1 }

test('engine invariant: multifamily never prices from single family, and respects the unit band', () => {
  assert.equal(assetFamilyInvariantHolds(mf(2), sfr), false)
  assert.equal(assetFamilyInvariantHolds(sfr, mf(2)), false)
  assert.equal(assetFamilyInvariantHolds(mf(2), mf(3)), true)
  assert.equal(assetFamilyInvariantHolds(mf(2), mf(12)), false) // 6× the subject's units
  assert.equal(assetFamilyInvariantHolds(sfr, { ...sfr }), true)
})

test('legacy Comps gate: cross-family and out-of-band comps are hard-excluded', () => {
  const subject = { asset_type: 'multifamily', property_type: 'Multi-Family', units: 2 }
  assert.equal(assetGate(subject, { asset_type: 'single_family', property_subtype: 'Single Family', units: 1 }).ok, false)
  assert.equal(assetGate(subject, { asset_type: 'multifamily', property_subtype: 'Multi-Family', units: 3 }).ok, true)
  assert.equal(assetGate(subject, { asset_type: 'apartment', property_subtype: 'Apartment', units: 20 }).reason, 'Unit count too different')
  assert.equal(assetGate(subject, { asset_type: null, property_subtype: null, units: null }).ok, false) // unknown can't be confirmed multifamily
  assert.equal(assetGate({ asset_type: 'single_family', property_type: 'Single Family', units: 1 }, { asset_type: 'multifamily', property_subtype: 'Duplex', units: 2 }).ok, false)
  assert.equal(compAssetFamily('single_family', 'Single Family', 2), 'multi') // a 2-unit "single family" record is multifamily by units
})

// Houston, 2026-09-27: a 24-unit apartment (405 Hawthorne St) was offered a
// recorded-deed "comp" at 912 Lovett Blvd Unit H — typed Single Family, 2,468 sf,
// 3 bd, recorded with units_count 12 (the complex's count). The taxonomy's
// unit-count rule made it multifamily_5_plus, and it priced the building at
// $56K/unit. A unit count that contradicts the record's vocabulary must be
// carried by the floor area before the sale counts as building evidence.
test('a single-family record carrying a complex unit count is not multifamily evidence', () => {
  const unitSale = normalizePropertyFeatures({ property_type: 'Single Family', units_count: 12, building_square_feet: 2468, total_bedrooms: 3, sale_price: 667000, sale_date: '2026-05-20' })
  assert.equal(unitSale.unit_count_promoted_from, 'single_family')
  assert.equal(unitCountCredible(unitSale), false)
  const subject = normalizePropertyFeatures({ property_id: 's', property_type: 'Apartment', units_count: 24, building_square_feet: 13625, latitude: 29.745, longitude: -95.39 })
  assert.equal(assetFamilyInvariantHolds(subject, unitSale), false)
  const scored = scoreComparable(subject, { property_type: 'Single Family', units_count: 12, building_square_feet: 2468, sale_price: 667000, sale_date: '2026-05-20', latitude: 29.747, longitude: -95.393 })
  assert.equal(scored.eligible, false)
  assert.ok(scored.reasons.includes('unit_count_implausible'))

  // A mis-typed building whose floor area holds its count still counts…
  const building = normalizePropertyFeatures({ property_type: 'Single Family', units_count: 4, building_square_feet: 3600 })
  assert.equal(unitCountCredible(building), true)
  // …an uncorroborated count on a single-unit record does not…
  assert.equal(unitCountCredible(normalizePropertyFeatures({ property_type: 'Single Family', units_count: 3 })), false)
  // …and a record with no vocabulary at all is still read by its count.
  assert.equal(unitCountCredible(normalizePropertyFeatures({ units_count: 4 })), true)
  assert.equal(unitCountCredible(normalizePropertyFeatures({ property_type: 'Apartment', units_count: 24, building_square_feet: 6000 })), true)
})

test('legacy Comps gate applies the same floor-area rule to comps', () => {
  const subject = { asset_type: 'multifamily', property_type: 'Apartment', units: 24 }
  assert.equal(assetGate(subject, { asset_type: null, property_subtype: 'Single Family', units: 12, square_feet: 2468 }).ok, false)
  assert.equal(assetGate({ ...subject, units: 12 }, { asset_type: null, property_subtype: 'Single Family', units: 12, square_feet: 9000 }).ok, true)
  assert.equal(compAssetFamily(null, 'Single Family', 12, 2468), 'single')
  assert.equal(compAssetFamily(null, 'Single Family', 12, null), 'single')
})
