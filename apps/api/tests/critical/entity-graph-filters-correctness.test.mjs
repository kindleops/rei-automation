/**
 * ENTITY GRAPH FILTER CORRECTNESS (audit 2026-10-09, owner: "All the filters
 * are actually fucked"). Every rail filter was compiled through the list's own
 * appliers and counted on prod TABLESAMPLE slices against an independently
 * written predicate (1,252 field × operator cases + 80 presets/toggles). These
 * pin the defects that sweep found. No network: queries are recorded.
 *
 *   1. The facet/count SQL recorder compared numeric columns as TEXT:
 *      total_loan_balance = 0 is stored '0.00', so the known-equity no-loan
 *      branch matched nothing in facet counts (7,639 → 3,363 on the slice).
 *   2. "Is not any of" wrote not.in.(Miami, FL) — two values — so a market
 *      with a comma excluded nothing; NOT IN also dropped every blank row.
 *   3. A search ignored every filter (header still read "· N filters").
 *   4. "Liens ≥ 1" counted UCC filings, affidavits, probate, contracts: 1,266
 *      matched, 406 carry a lien.
 *   5. "Tax delinquent" read the column only; the Signals badge reads the
 *      column OR the vendor flag (453 vs 765 on the slice).
 *   6. The vendor repair estimate was a filter and a sort (owner rule: never).
 *   7. prospects.mob was offered as "Age" with text operators.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEntityGraphFieldFilters,
  getEntityGraphFilterCatalog,
  getEntityGraphFilterFields,
  resolveEntityGraphFieldFilters,
} from '../../src/lib/domain/entity-graph/entity-graph-field-filters.js'
import { compileFacetWhere } from '../../src/lib/domain/entity-graph/entity-graph-facet-sql.js'
import { KEYSET_SORT_COLUMNS } from '../../src/lib/domain/entity-graph/entity-graph-property-sort.js'
import { LIEN_CATEGORIES } from '../../src/lib/domain/entity-graph/entity-graph-recorded-docs.js'
import { applyPropertyFilters, parseBrowseFilters, searchEntityGraph } from '../../src/lib/domain/entity-graph/entity-graph-service.js'

const where = (tab, filters) => {
  const { resolved, unsupported } = resolveEntityGraphFieldFilters(tab, filters)
  assert.deepEqual(unsupported, [])
  return compileFacetWhere((b) => applyEntityGraphFieldFilters(tab === 'properties' ? applyPropertyFilters(b, parseBrowseFilters({})) : b, resolved))
}

test('recorder compares in the column type, never its text form (numeric 0 is stored 0.00)', () => {
  const { where: w, params } = where('properties', [{ field_key: 'properties.known_equity_percent', operator: 'gte', value: 60 }])
  assert.ok(!w.includes('::text'), w)
  assert.match(w, /"total_loan_balance" is null or "total_loan_balance" = \$\d+/)
  assert.match(w, /"rec_mortgage_count" = \$\d+/)
  assert.ok(params.includes('0'))
  const list = where('properties', [{ field_key: 'properties.market', operator: 'is_any_of', value: ['Dallas, TX', 'Houston, TX'] }])
  assert.match(list.where, /"market" = any\(\$\d+\)/)
  assert.deepEqual(list.params.at(-1), ['Dallas, TX', 'Houston, TX'])
})

test('"is not any of" keeps blanks and quotes a value with a comma', () => {
  const { resolved } = resolveEntityGraphFieldFilters('properties', [{ field_key: 'properties.market', operator: 'is_not_any_of', value: ['Miami, FL', 'Dallas, TX'] }])
  const calls = []
  const q = { or: (expr) => { calls.push(expr); return q } }
  applyEntityGraphFieldFilters(q, resolved)
  assert.deepEqual(calls, ['market.is.null,market.not.in.("Miami, FL","Dallas, TX")'])
  const { where: w, params } = where('properties', [{ field_key: 'properties.market', operator: 'is_not_any_of', value: ['Miami, FL'] }])
  assert.match(w, /\("market" is null or not \("market" = any\(\$\d+\)\)\)/)
  assert.deepEqual(params.at(-1), ['Miami, FL'])
})

test('the vendor repair estimate is neither a filter nor a sort', () => {
  const offered = new Set(getEntityGraphFilterFields('properties').map((f) => f.key))
  for (const key of ['properties.estimated_repair_cost', 'properties.estimated_repair_cost_per_sqft']) {
    assert.ok(!offered.has(key), `${key} offered`)
    const { unsupported } = resolveEntityGraphFieldFilters('properties', [{ field_key: key, operator: 'gte', value: 1 }])
    assert.equal(unsupported[0]?.reason, 'field_withheld_from_entity_graph')
  }
  assert.equal(KEYSET_SORT_COLUMNS.estimated_repair_cost, undefined)
  assert.ok(!JSON.stringify(getEntityGraphFilterCatalog('properties')).includes('estimated_repair_cost'))
})

test('month of birth is not offered as "Age"; plumbing hashes are not filters', () => {
  const people = getEntityGraphFilterFields('people').map((f) => f.key)
  assert.ok(!people.includes('prospects.mob'))
  assert.ok(people.includes('prospects.age_years'))
  assert.ok(!getEntityGraphFilterFields('properties').some((f) => f.key === 'properties.search_profile_hash'))
})

test('a recorded lien is a lien category — not a UCC filing, affidavit, probate or contract', () => {
  const { resolved } = resolveEntityGraphFieldFilters('properties', [{ field_key: 'records.has_lien', operator: 'is_true' }])
  const calls = []
  const q = { overlaps: (col, values) => { calls.push([col, values]); return q } }
  applyEntityGraphFieldFilters(q, resolved)
  assert.equal(calls[0][0], 'rec_lien_categories')
  assert.deepEqual(calls[0][1], [...LIEN_CATEGORIES])
  for (const notLien of ['FINANCING STATEMENT', 'AFFIDAVIT', 'AFFIDAVIT OF DEATH', 'PROBATE', 'LIS PENDENS', 'AGREEMENT', 'CONTRACT', 'ORDER']) {
    assert.ok(!calls[0][1].includes(notLien), notLien)
  }
  const count = getEntityGraphFilterFields('properties').find((f) => f.key === 'records.lien_count')
  assert.doesNotMatch(count.label, /lien/i, 'a document count is not labelled as liens')
  assert.match(count.description, /UCC/)
})

test('tax delinquent = the vendor column OR the vendor flag (the Signals badge rule)', () => {
  const { where: w, params } = where('properties', [{ field_key: 'properties.tax_delinquent_any', operator: 'is_true' }])
  assert.match(w, /\("tax_delinquent" is true or "property_flags_text" ilike \$\d+/)
  assert.ok(params.includes('Tax Delinquent'))
})

function recordingClient() {
  const calls = []
  const client = {
    from(table) {
      const q = {}
      for (const op of ['select', 'or', 'ilike', 'eq', 'not', 'order', 'range', 'limit', 'gte', 'lte', 'gt', 'in', 'is', 'overlaps']) q[op] = (...args) => { calls.push([table, op, ...args]); return q }
      q.then = (res, rej) => Promise.resolve({ data: [], count: 0, error: null }).then(res, rej)
      return q
    },
  }
  return { client, calls }
}

test('a search inside a filtered cohort applies the cohort filters', async () => {
  const filters = JSON.stringify([{ field_key: 'records.has_probate', operator: 'is_true' }, { field_key: 'properties.out_of_state_owner', operator: 'is_true' }])
  const { client, calls } = recordingClient()
  await searchEntityGraph({ tab: 'properties', q: '10419 Quebec', field_filters: filters }, { supabase: client, marketLabels: async () => [] })
  assert.ok(calls.some(([t, op, col, v]) => t === 'v_entity_graph_properties' && op === 'eq' && col === 'rec_has_probate' && v === true))
  assert.ok(calls.some(([, op, col, v]) => op === 'eq' && col === 'out_of_state_owner' && v === true))

  const owners = recordingClient()
  await searchEntityGraph({ tab: 'master_owners', q: 'smith', field_filters: JSON.stringify([{ field_key: 'master_owners.property_count', operator: 'gte', value: 2 }]) }, { supabase: owners.client })
  assert.ok(owners.calls.some(([t, op, col, v]) => t === 'master_owners' && op === 'gte' && col === 'property_count' && v === 2))

  const people = recordingClient()
  await searchEntityGraph({ tab: 'people', q: 'smith', field_filters: JSON.stringify([{ field_key: 'prospects.language_preference', operator: 'is_any_of', value: ['Spanish'] }]) }, { supabase: people.client })
  assert.ok(people.calls.some(([t, op, col, v]) => t === 'prospects' && op === 'in' && col === 'language_preference' && v.includes('Spanish')))
})

test('a search that cannot apply the filters fails closed instead of ignoring them', async () => {
  const { client } = recordingClient()
  await assert.rejects(
    searchEntityGraph({ tab: 'contact_methods', subtype: 'email', q: 'a@b.co', field_filters: JSON.stringify([{ field_key: 'phones.phone_type', operator: 'is_any_of', value: ['W'] }]) }, { supabase: client }),
    (e) => e.code === 'unsupported_entity_graph_filters',
  )
  await assert.rejects(
    searchEntityGraph({ tab: 'properties', q: 'x st', field_filters: JSON.stringify([{ field_key: 'properties.estimated_repair_cost', operator: 'gte', value: 1 }]) }, { supabase: client }),
    (e) => e.code === 'unsupported_entity_graph_filters',
  )
})

test('every rail preset, toggle and facet field the dashboard ships is a field its tab executes', async () => {
  const fs = await import('node:fs')
  const url = (p) => new URL(`../../../dashboard/src/modules/entity-graph/${p}`, import.meta.url)
  const text = fs.readFileSync(url('mobile/entity-graph-presets.ts'), 'utf8') + fs.readFileSync(url('desk/desk-model.ts'), 'utf8')
  const keys = [...new Set([...text.matchAll(/['"]((?:properties|records|master_owners|prospects|phones|buyers)\.[a-z0-9_]+)['"]/g)].map((m) => m[1]))]
  assert.ok(keys.length > 40, `found ${keys.length} keys`)
  const tabOf = { properties: 'properties', records: 'properties', master_owners: 'master_owners', prospects: 'people', phones: 'contact_methods', buyers: 'buyers' }
  const missing = keys.filter((k) => !getEntityGraphFilterFields(tabOf[k.split('.')[0]]).some((f) => f.key === k))
  assert.deepEqual(missing, [])
  assert.ok(keys.includes('properties.tax_delinquent_any') && keys.includes('records.has_lien'))
  assert.ok(!keys.includes('properties.tax_delinquent'), 'the tax-delinquent preset reads one source only')
})
