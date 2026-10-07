/**
 * Entity Graph facets + property search (owner defects, 2026-10-07).
 *
 *   - categorical facets are ONE exact GROUP BY over the list's own WHERE:
 *     every value, no sample, no top-N cap when asked for all
 *   - the WHERE is recorded from the list's filter appliers, never rewritten
 *   - anything the recorder cannot translate falls back, it never guesses
 *   - a term naming a canonical market ORs in the whole market
 *   - a searched property carries the same details as a browsed one
 *
 * No network: the Postgres query and Supabase are injected.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FacetUntranslatable,
  compileFacetWhere,
  groupedFacetCounts,
  __facetCacheTest,
} from '../../src/lib/domain/entity-graph/entity-graph-facet-sql.js'
import { buildEntityGraphComposition } from '../../src/lib/domain/entity-graph/entity-graph-composition.js'
import {
  applyPropertyFilters,
  marketForSearchTerm,
  parseBrowseFilters,
  searchEntityGraph,
} from '../../src/lib/domain/entity-graph/entity-graph-service.js'
import {
  applyEntityGraphFieldFilters,
  resolveEntityGraphFieldFilters,
} from '../../src/lib/domain/entity-graph/entity-graph-field-filters.js'

test('the facet WHERE is recorded from the list appliers and fully parameterised', () => {
  const filters = parseBrowseFilters({ market: 'Atlanta', state: 'ga', units_min: '2' })
  const { resolved } = resolveEntityGraphFieldFilters('properties', [
    { field_key: 'records.has_probate', operator: 'is_true' },
    { field_key: 'properties.equity_percent', operator: 'between', value: [40, 80] },
    { field_key: 'properties.property_address_county_name', operator: 'is_any_of', value: ['Fulton', 'DeKalb'] },
  ])
  const { where, params } = compileFacetWhere((b) => applyEntityGraphFieldFilters(applyPropertyFilters(b, filters), resolved))
  assert.match(where, /^where /)
  assert.match(where, /\("market" ilike \$1 or "market_region" ilike \$2\)/)
  assert.match(where, /"property_address_state"::text = \$3/)
  assert.match(where, /"units_count" >= \$4::numeric/)
  assert.match(where, /"rec_has_probate" is true/)
  assert.match(where, /"equity_percent" >= \$\d+::numeric and "equity_percent" <= \$\d+::numeric/)
  assert.match(where, /"property_address_county_name"::text = any\(\$\d+::text\[\]\)/)
  assert.deepEqual(params.slice(0, 4), ['%Atlanta%', '%Atlanta%', 'GA', 2])
  assert.ok(params.some((p) => Array.isArray(p) && p.join() === 'Fulton,DeKalb'))
  // no value is ever spliced into the SQL text
  assert.ok(!where.includes('Atlanta') && !where.includes('Fulton'))
})

test('an unknown builder call or an unsafe identifier is untranslatable, not guessed', () => {
  assert.throws(() => compileFacetWhere((b) => b.textSearch('x', 'y')), FacetUntranslatable)
  assert.throws(() => compileFacetWhere((b) => b.eq('market; drop table x', 'a')), FacetUntranslatable)
  assert.throws(() => compileFacetWhere((b) => b.not('market', 'like', 'a')), FacetUntranslatable)
})

test('grouped counts fold blanks into one "not recorded" value and cache per WHERE', async () => {
  __facetCacheTest.reset()
  let calls = 0
  const query = async (sql, params) => {
    calls += 1
    assert.match(sql, /group by 1$/)
    assert.match(sql, /from public\."v_entity_graph_properties" where "property_address_state"::text = \$1/)
    assert.deepEqual(params, ['GA'])
    return { rows: [{ value: 'Fulton', n: '3190' }, { value: null, n: '4' }, { value: 'DeKalb', n: '1200' }] }
  }
  const run = () => groupedFacetCounts({ source: 'v_entity_graph_properties', column: 'property_address_county_name', applyFilters: (b) => b.eq('property_address_state', 'GA'), query })
  const rows = await run()
  assert.deepEqual(rows, [{ value: 'Fulton', count: 3190 }, { value: null, count: 4 }, { value: 'DeKalb', count: 1200 }])
  await run()
  assert.equal(calls, 1)
})

const MARKETS = Array.from({ length: 58 }, (_, i) => ({ value: `Market ${String(i).padStart(2, '0')}`, count: 1000 - i }))

test('composition: all=1 returns EVERY market with exact counts (Atlanta is no longer behind "Everything else")', async () => {
  const rows = [...MARKETS, { value: 'Atlanta, GA', count: 6397 }, { value: null, count: 8 }]
  const deps = { facetsAvailable: () => true, groupedFacetCounts: async ({ column }) => { assert.equal(column, 'market'); return rows } }
  const all = await buildEntityGraphComposition({ tab: 'properties', dimension: 'market', all: '1' }, deps)
  assert.equal(all.exhaustive, true)
  assert.equal(all.distinct, 59)
  assert.equal(all.total, rows.reduce((s, r) => s + r.count, 0))
  const atlanta = all.buckets.find((b) => b.key === 'Atlanta, GA')
  assert.equal(atlanta.value, 6397)
  assert.deepEqual(atlanta.filter, { field_key: 'properties.market', operator: 'is_any_of', value: ['Atlanta, GA'] })
  assert.ok(!all.buckets.some((b) => b.key === '__other'))
  assert.equal(all.buckets.at(-1).key, '__blank')
  assert.equal(all.buckets.at(-1).value, 8)

  // Default: the nine largest and an EXACT remainder.
  const top = await buildEntityGraphComposition({ tab: 'properties', dimension: 'market' }, deps)
  assert.equal(top.buckets[0].key, 'Atlanta, GA')
  const other = top.buckets.find((b) => b.key === '__other')
  const shown = top.buckets.filter((b) => !b.key.startsWith('__')).reduce((s, b) => s + b.value, 0)
  assert.equal(shown + other.value + 8, top.total)
})

test('composition: county runs as one grouped query under the cohort filters', async () => {
  const seen = []
  const deps = {
    facetsAvailable: () => true,
    groupedFacetCounts: async ({ source, column, applyFilters }) => {
      seen.push({ source, column, where: compileFacetWhere(applyFilters) })
      return [{ value: 'Fulton', count: 3190 }, { value: 'Cobb', count: 900 }]
    },
  }
  const c = await buildEntityGraphComposition({ tab: 'properties', dimension: 'county', state: 'GA', field_filters: JSON.stringify([{ field_key: 'records.has_probate', operator: 'is_true' }]) }, deps)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].source, 'v_entity_graph_properties')
  assert.equal(seen[0].column, 'property_address_county_name')
  assert.match(seen[0].where.where, /"rec_has_probate" is true/)
  assert.deepEqual(c.buckets.map((b) => b.key), ['Fulton', 'Cobb'])
})

test('composition: without a direct database url the sampled path still answers, flagged not exhaustive', async () => {
  const client = {
    from: () => {
      const q = new Proxy({}, {
        get: (_, op) => (op === 'then'
          ? (res, rej) => Promise.resolve({ count: 10, data: [{ property_id: '1', market: 'Miami, FL' }] }).then(res, rej)
          : () => q),
      })
      return q
    },
  }
  const c = await buildEntityGraphComposition({ tab: 'properties', dimension: 'market' }, { supabase: client, facetsAvailable: () => false })
  assert.equal(c.exhaustive, false)
})

test('a term that names a canonical market resolves to it; partial words do not', () => {
  const labels = ['Atlanta, GA', 'Kansas City, MO', 'Miami, FL']
  assert.equal(marketForSearchTerm('atlanta', labels), 'Atlanta, GA')
  assert.equal(marketForSearchTerm('Kansas City, MO', labels), 'Kansas City, MO')
  assert.equal(marketForSearchTerm('atl', labels), null)
  assert.equal(marketForSearchTerm('123 Atlanta Ave', labels), null)
})

function recordingClient(rows, count) {
  const calls = []
  const client = {
    from(table) {
      const q = {}
      for (const op of ['select', 'or', 'ilike', 'eq', 'order', 'range', 'limit']) q[op] = (...args) => { calls.push([table, op, ...args]); return q }
      q.then = (res, rej) => Promise.resolve({ data: rows, count, error: null }).then(res, rej)
      return q
    },
  }
  return { client, calls }
}

test('property search reads the browse view, ORs the whole market, and rows carry their details', async () => {
  const row = {
    property_id: '239333984', property_address_full: '10 Peachtree St, Atlanta, GA 30303', property_address_city: 'Atlanta',
    property_address_state: 'GA', property_address_zip: '30303', market: 'Atlanta, GA', estimated_value: 410000,
    equity_percent: 62, owner_name: 'JANE DOE', rec_mortgage_count: 1, rec_mortgage_balance: 150000, rec_first_rate: 3.25,
    rec_first_lender: 'Wells Fargo', rec_lien_count: 0, rec_last_sale_date: '2015-06-01', rec_last_sale_price: 210000,
  }
  const { client, calls } = recordingClient([row], 6471)
  const res = await searchEntityGraph({ tab: 'properties', q: 'Atlanta' }, { supabase: client, marketLabels: async () => ['Atlanta, GA'] })
  const select = calls.find(([, op]) => op === 'select')
  assert.equal(select[0], 'v_entity_graph_properties')
  assert.match(select[2], /rec_mortgage_count/)
  const or = calls.find(([, op]) => op === 'or')
  assert.equal(or[2], 'property_address_full.ilike."%atlanta%",market.eq."Atlanta, GA"')
  assert.equal(res.pagination.total, 6471)
  const d = res.results[0].details
  assert.equal(d.value, 410000)
  assert.equal(d.ownerName, 'JANE DOE')
  assert.equal(d.records.mortgageCount, 1)
  assert.equal(d.records.firstLender, 'Wells Fargo')
})

test('a street search with no market name stays a plain address probe', async () => {
  const { client, calls } = recordingClient([], 0)
  await searchEntityGraph({ tab: 'properties', q: '10419 Quebec' }, { supabase: client, marketLabels: async () => ['Atlanta, GA'] })
  assert.ok(!calls.some(([, op]) => op === 'or'))
  assert.ok(calls.some(([table, op, col]) => table === 'v_entity_graph_properties' && op === 'ilike' && col === 'property_address_full'))
})
