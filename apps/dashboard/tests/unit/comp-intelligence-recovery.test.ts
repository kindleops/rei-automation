import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveCanonicalProperty } from '../../src/domain/canonical-property/resolver'
import { mapCandidateToDegradedEvidence } from '../../src/domain/comp-intelligence/degraded-evidence'
import { mergeMapEvidence } from '../../src/views/comp-intelligence/adapters/transactionEvidenceAdapter'

test('property record hydration resolves Lake Worth coordinates', () => {
  const canonical = resolveCanonicalProperty({
    dealContext: {
      propertyId: '234334277',
      propertyAddress: '1021 S N St, Lake Worth Beach, FL 33460',
      propertyZip: '33460',
    } as never,
    propertyRecord: {
      property_id: '234334277',
      property_address_full: '1021 S N St, Lake Worth Beach, Fl 33460',
      latitude: 26.602867,
      longitude: -80.053624,
      property_address_zip: '33460',
    },
  })

  assert.ok(canonical)
  assert.equal(canonical.property_id, '234334277')
  assert.equal(canonical.is_subject_resolved, true)
  assert.ok(canonical.latitude && canonical.longitude)
})

test('degraded evidence preserves coordinates and marks non-authoritative', () => {
  const row = mapCandidateToDegradedEvidence({
    comp_property_id: '234330526',
    property_id: '234330526',
    sale_list_price: 500000,
    sale_list_date: '2025-01-01',
    latitude: 26.61051,
    longitude: -80.051485,
    distance_miles: 0.5,
    address: 'Sample Comp',
    source: 'MLS SOLD',
    selected: true,
    excluded: false,
  }, 'DIRECT_RPC')

  assert.equal(row.evidence_authority, 'DEGRADED_NON_AUTHORITATIVE')
  assert.equal(row.display_eligible, true)
  assert.equal(row.pricing_eligibility, false)
  assert.equal(row.ess_contribution, 0)
  assert.equal(row.geography.latitude, 26.61051)
})

test('mergeMapEvidence uses discovery when transaction evidence empty', () => {
  const merged = mergeMapEvidence([], [{
    comp_property_id: 'c1',
    property_id: 'c1',
    sale_list_price: 100000,
    latitude: 26.61,
    longitude: -80.05,
    address: 'Comp 1',
    selected: true,
    excluded: false,
  }])

  assert.equal(merged.length, 1)
  assert.equal(merged[0].display_eligible, true)
  assert.equal(merged[0].geography.latitude, 26.61)
})