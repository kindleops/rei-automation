/**
 * Entity Graph table columns (owner report, RC 8.3.1: "nothing is showing at
 * all"). The picker's property fields render from details.row, which browse
 * never returned; they now load through a keyed, whitelisted enrichment read.
 * Also: browse pages carry a unique tie-break, and an uncaptured record
 * summary is flagged instead of reading as "0 loans".
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ENTITY_GRAPH_PROPERTY_COLUMNS,
  MAX_IDS,
  getEntityGraphColumnEnrichment,
  parseEntityGraphColumnFields,
} from '../../src/lib/domain/entity-graph/entity-graph-column-enrichment.js'
import { browseEntityGraph } from '../../src/lib/domain/entity-graph/entity-graph-service.js'

function keyedClient(rows) {
  const calls = []
  return {
    calls,
    from(table) {
      const call = { table, select: null, key: null, ids: null }
      calls.push(call)
      const q = {
        select(cols) { call.select = cols; return q },
        in(key, ids) {
          call.key = key
          call.ids = ids
          return Promise.resolve({ data: rows.filter((r) => ids.includes(String(r[key]))), error: null })
        },
      }
      return q
    },
  }
}

test('owner-named columns are whitelisted; internal / unknown columns are dropped', () => {
  for (const c of ['year_built', 'zoning', 'units_count', 'effective_year_built', 'estimated_repair_cost', 'total_bedrooms', 'total_baths', 'building_square_feet', 'sale_date']) {
    if (c === 'units_count') continue // Units is on the browse row itself
    assert.ok(ENTITY_GRAPH_PROPERTY_COLUMNS.has(c), c)
  }
  assert.deepEqual(
    parseEntityGraphColumnFields('year_built,raw_payload_json,row_hash,zoning;drop table,year_built, zoning '),
    ['year_built', 'zoning'],
  )
})

test('one keyed read on properties.property_id with only the visible columns; absent stays absent', async () => {
  const client = keyedClient([
    { property_id: 'P1', year_built: 1958, zoning: 'R-1', total_bedrooms: null },
    { property_id: 'P2', year_built: null, zoning: '', total_bedrooms: 0 },
  ])
  const out = await getEntityGraphColumnEnrichment({ fields: 'year_built,zoning,total_bedrooms', property_ids: 'P1,P2,P3' }, { supabase: client })
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].table, 'properties')
  assert.equal(client.calls[0].key, 'property_id')
  assert.equal(client.calls[0].select, 'property_id,year_built,zoning,total_bedrooms')
  assert.deepEqual(client.calls[0].ids, ['P1', 'P2', 'P3'])
  assert.deepEqual(out.values.P1, { year_built: 1958, zoning: 'R-1' })
  // A real 0 survives; null / '' do not become 0.
  assert.deepEqual(out.values.P2, { total_bedrooms: 0 })
  assert.equal(out.values.P3, undefined)
})

test('nothing visible or no ids: no read at all; ids are capped and chunked', async () => {
  const none = keyedClient([])
  await getEntityGraphColumnEnrichment({ fields: 'raw_payload_json', property_ids: 'P1' }, { supabase: none })
  await getEntityGraphColumnEnrichment({ fields: 'year_built', property_ids: '' }, { supabase: none })
  assert.equal(none.calls.length, 0)

  const ids = Array.from({ length: MAX_IDS + 50 }, (_, i) => `P${i}`)
  const many = keyedClient([])
  await getEntityGraphColumnEnrichment({ fields: 'year_built', property_ids: ids.join(',') }, { supabase: many })
  assert.equal(many.calls.reduce((n, c) => n + c.ids.length, 0), MAX_IDS)
  assert.ok(many.calls.every((c) => c.ids.length <= 150))
})

test('a failed read surfaces as an error (the route answers 500, cells stay "—")', async () => {
  const client = { from: () => ({ select: () => ({ in: () => Promise.resolve({ data: null, error: new Error('boom') }) }) }) }
  await assert.rejects(() => getEntityGraphColumnEnrichment({ fields: 'year_built', property_ids: 'P1' }, { supabase: client }), /boom/)
})

function browseClient(rows) {
  const orders = []
  const make = () => {
    const q = {
      _head: false,
      select(_cols, opts) { q._head = Boolean(opts?.head); return q },
      order(col, opts) { orders.push([col, opts?.ascending]); return q },
      not() { return q }, // the shared test-record exclusion (entity-graph-truth.js)
      range() { return Promise.resolve({ data: rows, error: null }) },
      then(resolve) { return Promise.resolve({ count: rows.length, error: null }).then(resolve) },
    }
    return q
  }
  return { orders, from: () => make() }
}

test('properties browse orders by the chosen column, then property_id (stable pages)', async () => {
  const client = browseClient([{ property_id: 'P1', property_address_full: '1 Main St', rec_mortgage_count: null }])
  const out = await browseEntityGraph({ tab: 'properties', sort_by: 'estimated_value', ascending: '0' }, { supabase: client, propertySortIndexes: async () => new Set() })
  assert.deepEqual(client.orders, [['estimated_value', false], ['property_id', true]])
  // No record-summary row: flagged uncaptured so the table renders "—", not "0 loans".
  assert.equal(out.results[0].details.records.captured, false)
})

test('only index-backed property sorts run; any other order falls back and says so', async () => {
  const { resolvePropertySort } = await import('../../src/lib/domain/entity-graph/entity-graph-service.js')
  for (const [col, asc] of [['estimated_value', false], ['equity_percent', true], ['market', true], ['property_address_full', true]]) {
    assert.equal(resolvePropertySort(col, asc).sortApplied, true, `${col} ${asc ? 'asc' : 'desc'}`)
  }
  // RC 8.3.2 visual pass: Value ↑ (full Sort over the joined view) timed the browse out.
  for (const [col, asc] of [['estimated_value', true], ['equity_percent', false], ['market', false], ['property_address_full', false], ['rec_mortgage_balance', false], ['rec_last_sale_date', true], ['raw_payload_json', true]]) {
    const s = resolvePropertySort(col, asc)
    assert.equal(s.sortApplied, false, `${col} ${asc ? 'asc' : 'desc'}`)
    assert.deepEqual(s.applied, { column: 'property_address_full', ascending: true })
  }

  const client = browseClient([{ property_id: 'P1', property_address_full: '1 Main St' }])
  const out = await browseEntityGraph({ tab: 'properties', sort_by: 'estimated_value', ascending: '1' }, { supabase: client, propertySortIndexes: async () => new Set() })
  assert.deepEqual(client.orders, [['property_address_full', true], ['property_id', true]])
  assert.equal(out.pagination.sort.sortApplied, false)
  assert.deepEqual(out.pagination.sort.requested, { column: 'estimated_value', ascending: true })
})
