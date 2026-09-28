/**
 * ASSET-FAMILY GATES. Automated offers are priced from comps; a multifamily
 * subject must never be priced from single-family sales (or the reverse), on
 * the engine path or the legacy Comps path, whatever the corpus contains.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assetFamilyInvariantHolds } from '../../src/lib/acquisition/acquisitionDecisionEngine.js'
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
