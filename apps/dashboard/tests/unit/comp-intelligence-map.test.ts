import test from 'node:test'
import assert from 'node:assert/strict'
import {
  enrichEvidenceWithDiscoveryCoordinates,
  evidenceWithValidCoordinates,
  filterEvidenceByMapMode,
} from '../../src/views/comp-intelligence/adapters/transactionEvidenceAdapter'
import { isValidCoord } from '../../src/views/comp-intelligence/utils/mapGeo'

test('isValidCoord rejects null island and zero coordinates', () => {
  assert.equal(isValidCoord(0, 0), false)
  assert.equal(isValidCoord(29.65, -95.5), true)
})

test('enrichEvidenceWithDiscoveryCoordinates fills missing lat/lng from discovery', () => {
  const enriched = enrichEvidenceWithDiscoveryCoordinates(
    [{
      candidate_id: 'h1',
      source_record_id: 'h1',
      transaction_cluster_id: null,
      property_id: 'h1',
      address: '6300 Cambridge Glen Ln',
      canonical_asset_lane: 'SFR',
      sale_price: 165000,
      sale_date: '2025-09-01',
      buyer: null,
      buyer_archetype: null,
      transaction_channel: null,
      evidence_role: 'PRICING_EVIDENCE',
      routed_universe: 'LOCAL_INVESTOR_VALUE',
      pricing_eligibility: true,
      demand_eligibility: false,
      package_probability: null,
      parcel_count: null,
      raw_row_count: 1,
      peer_classification: null,
      qualification_score: 80,
      similarity: 80,
      recency: '2025-09-01',
      geography: { distance_miles: 0.2, zip: '77035', city: 'Houston', state: 'TX', latitude: null, longitude: null },
      independence_weight: null,
      ess_contribution: 1,
      rejection_review_reasons: [],
      source_lineage: { source_table: 'rpc', source_record_id: 'h1', identity_unresolved: false, source_completeness: 80, channel_reasons: [] },
      evidence_list_role: 'accepted',
      qualification_status: 'ACCEPTED',
    }],
    [{
      comp_property_id: 'h1',
      property_id: 'h1',
      latitude: 29.651,
      longitude: -95.5012,
      distance_miles: 0.2,
      address: '6300 Cambridge Glen Ln',
      sale_list_price: 165000,
      selected: true,
      excluded: false,
    }],
  )

  assert.equal(enriched[0].geography.latitude, 29.651)
  assert.equal(enriched[0].geography.longitude, -95.5012)
  assert.equal(evidenceWithValidCoordinates(enriched).length, 1)
})

test('filterEvidenceByMapMode keeps pricing and demand evidence separate', () => {
  const rows = [
    { pricing_eligibility: true, demand_eligibility: false, qualification_status: 'ACCEPTED', evidence_role: 'PRICING', rejection_review_reasons: [] },
    { pricing_eligibility: false, demand_eligibility: true, qualification_status: 'ACCEPTED', evidence_role: 'DEMAND', rejection_review_reasons: [] },
    { pricing_eligibility: false, demand_eligibility: false, qualification_status: 'REJECTED', evidence_role: 'REJECTED', rejection_review_reasons: ['bad'] },
  ] as Parameters<typeof filterEvidenceByMapMode>[0]

  assert.equal(filterEvidenceByMapMode(rows, 'PRICING').length, 1)
  assert.equal(filterEvidenceByMapMode(rows, 'DEMAND').length, 1)
  assert.equal(filterEvidenceByMapMode(rows, 'RISK').length, 1)
})

test('workspace preserves map-first split classes', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/views/comp-intelligence/CompIntelligenceWorkspace.tsx'),
    'utf8',
  )
  assert.match(source, /ci-workspace--v3-mapfirst/)
  assert.match(source, /ci-workspace__map-col/)
  assert.match(source, /ci-panel--v3/)
  assert.equal(source.includes('ci-body'), false)
})