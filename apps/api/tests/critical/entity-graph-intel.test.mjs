/**
 * Entity Graph intelligence: recorded documents, buyers, composition.
 *
 * Pure logic + stubbed Supabase only — no network. Guards the promises the
 * surface makes to an operator:
 *   - legacy Podio-era scores cannot be filtered on (fail closed)
 *   - record/buyer filters compile to the read-model columns, arrays overlap
 *   - a natural-person buyer never leaves the server with a name
 *   - the buyer on a sale who IS the current owner is one node, not two
 *   - composition bucket taps become the same field filters the builder speaks
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEntityGraphFieldFilters,
  getEntityGraphFilterFields,
  resolveEntityGraphFieldFilters,
  ENTITY_GRAPH_WITHHELD_FIELDS,
} from '../../src/lib/domain/entity-graph/entity-graph-field-filters.js'
import { shapeBuyerProfile, evidenceTier } from '../../src/lib/domain/entity-graph/entity-graph-buyer-service.js'
import { getEntityNetwork, shapeRecords, nameKey } from '../../src/lib/domain/entity-graph/entity-network-service.js'
import { getCompositionCatalog, buildEntityGraphComposition } from '../../src/lib/domain/entity-graph/entity-graph-composition.js'

test('legacy screening scores are withheld from Entity Graph and fail closed', () => {
  const offered = getEntityGraphFilterFields('properties').map((f) => f.key)
  for (const key of ENTITY_GRAPH_WITHHELD_FIELDS) assert.ok(!offered.includes(key), `${key} is offered`)
  const { unsupported, resolved } = resolveEntityGraphFieldFilters('properties', [
    { field_key: 'properties.final_acquisition_score', operator: 'gte', value: 50 },
  ])
  assert.equal(resolved.length, 0)
  assert.equal(unsupported[0].reason, 'field_withheld_from_entity_graph')
})

test('record filters resolve to the property view columns; buyer filters to the buyer index', () => {
  const { resolved, unsupported } = resolveEntityGraphFieldFilters('properties', [
    { field_key: 'records.has_probate', operator: 'is_true' },
    { field_key: 'records.first_rate', operator: 'gte', value: 7 },
    { field_key: 'records.owner_buyer_status', operator: 'is_any_of', value: ['active'] },
  ])
  assert.deepEqual(unsupported, [])
  assert.deepEqual(resolved.map((r) => r.source_column), ['rec_has_probate', 'rec_first_rate', 'rec_owner_buyer_status'])

  // A buyer field on the properties tab is not executable there.
  const cross = resolveEntityGraphFieldFilters('properties', [{ field_key: 'buyers.acquisition_count', operator: 'gte', value: 5 }])
  assert.equal(cross.unsupported[0].reason, 'field_not_on_entity_graph_source')

  const buyers = resolveEntityGraphFieldFilters('buyers', [{ field_key: 'buyers.states', operator: 'is_any_of', value: ['TX', 'OK'] }])
  assert.deepEqual(buyers.unsupported, [])
})

test('array fields compile to an OVERLAP, scalar fields to the shared compiler', () => {
  const calls = []
  const q = new Proxy({}, { get: (_, op) => (...args) => { calls.push([op, ...args]); return q } })
  const { resolved } = resolveEntityGraphFieldFilters('buyers', [
    { field_key: 'buyers.states', operator: 'is_any_of', value: ['TX'] },
    { field_key: 'buyers.acquisition_count', operator: 'gte', value: 5 },
  ])
  applyEntityGraphFieldFilters(q, resolved)
  assert.ok(calls.some(([op, col, v]) => op === 'overlaps' && col === 'states' && v[0] === 'TX'))
  assert.ok(calls.some(([op, col, v]) => op === 'gte' && col === 'acquisition_count' && v === 5))
})

test('a person buyer never carries a name out of the server', () => {
  const shaped = shapeBuyerProfile({
    index: { buyer_id: 'person:abc123', display_name: null, entity_type: 'person', acquisition_count: 3 },
    aliases: [],
    purchases: [{ canonical_transaction_id: 1, date: '2025-01-01', price: 200000, method: 'property_linked_contact_tokenset', confidence: 0.9 }],
  })
  assert.equal(shaped.kind, 'person')
  assert.equal(shaped.nameWithheld, true)
  assert.equal(shaped.name, 'Individual buyer')
  assert.equal(shaped.purchases[0].evidence.tier, 'inferred')
  assert.equal(evidenceTier({ basis: 'registry' }), 'resolved')
  assert.equal(evidenceTier({ basis: 'name' }), 'observed')
})

test('the normalised name key matches the SQL eg_name_key', () => {
  assert.equal(nameKey('Grumman Properties, LLC'), 'GRUMMAN PROPERTIES LLC')
  assert.equal(nameKey('  reo nationwide llc. '), 'REO NATIONWIDE LLC')
  assert.equal(nameKey(''), null)
})

test('records shape: open mortgages totalled, distress liens flagged, sale parties carried', () => {
  const r = shapeRecords({
    mortgages: [
      { slot: 'mtg1', lien_position: 1, lender_name: 'KLEIN BANK', loan_amount: 300000, est_balance: 200000, est_payment: 1500, interest_rate: 6.5 },
      { slot: 'prev1', lender_name: 'OLD BANK', loan_amount: 100000 },
    ],
    liens: [{ doc_category: 'LIS PENDENS', recording_date: '2024-02-02' }, { doc_category: 'EASEMENT' }],
    sales: [{ canonical_transaction_id: 9, slot: 'current', event_date: '2020-01-01', price: 400000, buyer: { buyer_id: 'company:us_mn:1', name: 'ACME LLC', basis: 'registry' } }],
    foreclosures: [],
    owner_buyer: null,
  })
  assert.equal(r.totals.openMortgages, 1)
  assert.equal(r.totals.balance, 200000)
  assert.equal(r.totals.distressLiens, 1)
  assert.equal(r.sales[0].buyer.id, 'company:us_mn:1')
  assert.equal(r.sales[0].current, true)
})

test('a sale bought by the CURRENT owner points at the owner node, not a duplicate buyer', async () => {
  const tables = {
    properties: [{ property_id: 'p1', master_owner_id: 'mo1', property_address_full: '1 A ST', owner_name: 'ACME LLC' }],
    master_owners: [{ master_owner_id: 'mo1', display_name: 'ACME LLC', property_count: 1, joined_property_ids_json: '["p1"]' }],
    eg_property_owner_buyer: [{ buyer_entity_id: 'company:us_mn:1', basis: 'registry' }],
    eg_buyer_index: [{ buyer_id: 'company:us_mn:1', display_name: 'ACME LLC', entity_type: 'company', acquisition_count: 4 }],
  }
  const from = (name) => {
    const rows = tables[name === 'v_entity_graph_properties' ? 'properties' : name] ?? []
    const q = {
      select() { return q }, eq() { return q }, neq() { return q }, in() { return q }, gt() { return q }, ilike() { return q }, or() { return q },
      order() { return q }, limit() { return q },
      maybeSingle() { return Promise.resolve({ data: rows[0] ?? null }) },
      then(res, rej) { return Promise.resolve({ data: rows }).then(res, rej) },
    }
    return q
  }
  const rpc = async () => ({
    data: {
      mortgages: [{ slot: 'mtg1', lender_name: 'KLEIN BANK', loan_amount: 1, est_balance: 1 }],
      liens: [],
      sales: [
        { canonical_transaction_id: 7, slot: 'current', event_date: '2021-01-01', price: 300000, buyer: { buyer_id: 'company:us_mn:1', name: 'ACME LLC', basis: 'link', confidence: 1 }, seller_entity: { buyer_id: 'company:us_mn:2', name: 'OTHER LLC', basis: 'name' } },
      ],
      foreclosures: [],
      owner_buyer: { buyer_id: 'company:us_mn:1', name: 'ACME LLC', basis: 'registry' },
    },
    error: null,
  })
  const n = await getEntityNetwork('property', 'p1', { supabase: { from, rpc } })
  const ids = n.graph.nodes.map((x) => x.id)
  assert.ok(!ids.includes('buyer:company:us_mn:1'), 'current owner duplicated as a buyer node')
  assert.ok(ids.includes('buyer:company:us_mn:2'), 'the seller entity is its own node')
  assert.ok(n.graph.edges.some((e) => e.from === 'sale:7' && e.to === 'owner:mo1' && e.kind === 'purchased_by'))
  assert.ok(n.graph.nodes.some((x) => x.type === 'mortgage'))
  assert.equal(n.ownerBuyer.id, 'company:us_mn:1')
})

test('composition: exact counts per band, and a tap becomes a builder field filter', async () => {
  const counts = []
  const client = {
    from: () => {
      const filters = []
      const q = {
        select() { return q }, eq(c, v) { filters.push(['eq', c, v]); return q }, gte(c, v) { filters.push(['gte', c, v]); return q },
        lt(c, v) { filters.push(['lt', c, v]); return q }, lte() { return q }, ilike() { return q }, or() { return q }, not() { return q },
        is() { return q }, in() { return q }, overlaps() { return q }, contains() { return q }, order() { return q }, range() { return q }, limit() { return q },
        then(res, rej) {
          counts.push(filters.slice())
          const n = filters.length === 0 ? 100 : 20
          return Promise.resolve({ count: n, data: [] }).then(res, rej)
        },
      }
      return q
    },
  }
  const c = await buildEntityGraphComposition({ tab: 'properties', dimension: 'equity' }, { supabase: client })
  assert.equal(c.total, 100)
  assert.equal(c.dimension.kind, 'banded')
  const band = c.buckets.find((b) => b.key === '20_40')
  assert.deepEqual(band.filter, { field_key: 'properties.equity_percent', operator: 'between', value: [20, 39.9999] })
  assert.ok(getCompositionCatalog('buyers').dimensions.some((d) => d.key === 'roles'))
})
