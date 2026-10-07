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
  browseEntityGraph,
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
  assert.match(where, /^where not \("property_id" like \$1\) and /)
  assert.match(where, /\("market" ilike \$2 or "market_region" ilike \$3\)/)
  assert.match(where, /"property_address_state"::text = \$4/)
  assert.match(where, /"units_count" >= \$5::numeric/)
  assert.match(where, /"rec_has_probate" is true/)
  assert.match(where, /"equity_percent" >= \$\d+::numeric and "equity_percent" <= \$\d+::numeric/)
  assert.match(where, /"property_address_county_name"::text = any\(\$\d+::text\[\]\)/)
  assert.deepEqual(params.slice(0, 5), ['canaryprop%', '%Atlanta%', '%Atlanta%', 'GA', 2])
  assert.ok(params.some((p) => Array.isArray(p) && p.join() === 'Fulton,DeKalb'))
  // no value is ever spliced into the SQL text
  assert.ok(!where.includes('Atlanta') && !where.includes('Fulton'))
})

test('an unknown builder call or an unsafe identifier is untranslatable, not guessed', () => {
  assert.throws(() => compileFacetWhere((b) => b.textSearch('x', 'y')), FacetUntranslatable)
  assert.throws(() => compileFacetWhere((b) => b.eq('market; drop table x', 'a')), FacetUntranslatable)
  assert.throws(() => compileFacetWhere((b) => b.not('market', 'cs', 'a')), FacetUntranslatable)
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
      for (const op of ['select', 'or', 'ilike', 'eq', 'not', 'order', 'range', 'limit']) q[op] = (...args) => { calls.push([table, op, ...args]); return q }
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

test('header KPIs are exact head counts; a failed count is null, never 0', async () => {
  const { getEntityGraphKpis } = await import('../../src/lib/domain/entity-graph/entity-graph-kpis.js')
  const seen = []
  const client = {
    from(table) {
      const filters = []
      const q = {
        select(col, opts) { assert.deepEqual(opts, { count: 'exact', head: true }); return q },
        not(c, op, v) { if (op !== 'like') filters.push(`${c} not ${op} ${v}`); else filters.push('notest'); return q },
        gte(c, v) { filters.push(`${c}>=${v}`); return q },
        then(res, rej) {
          seen.push(`${table}${filters.length ? `|${filters.join('&')}` : ''}`)
          if (table === 'sub_owners') return Promise.resolve({ count: null, error: { message: 'timeout' } }).then(res, rej)
          return Promise.resolve({ count: table === 'properties' ? (filters.length > 1 ? 41533 : 176603) : 102252, error: null }).then(res, rej)
        },
      }
      return q
    },
  }
  const k = await getEntityGraphKpis({ supabase: client })
  assert.equal(k.properties, 176603)
  assert.equal(k.linkedProperties, 41533)
  assert.equal(k.entities, null)
  assert.ok(seen.includes('master_owners|notest&property_count>=2'))
  assert.ok(seen.includes('master_owners|notest&best_phone_1 not is null'))
  assert.ok(seen.includes('properties|notest'), 'the universe excludes internal canary fixtures')
  assert.match(k.definitions.ownersWithPhone, /eligibility is decided at send/i)
})

test('an owner whose joined ids are property EXPORT ids still draws its portfolio (read by master_owner_id)', async () => {
  const { getEntityNetwork } = await import('../../src/lib/domain/entity-graph/entity-network-service.js')
  const reads = []
  const from = (name) => {
    const filters = []
    const q = {
      select() { return q }, neq() { return q }, gt() { return q }, ilike() { return q }, order() { return q }, limit() { return q },
      eq(c, v) { filters.push(['eq', c, v]); return q },
      in(c, v) { filters.push(['in', c, v]); return q },
      maybeSingle() {
        if (name === 'master_owners') return Promise.resolve({ data: { master_owner_id: 'mo_e3', display_name: 'Chandler Stonebridge LP', property_count: 1, joined_property_ids_json: '["prop_875d0ee2eacd14798bb4adf4"]' } })
        return Promise.resolve({ data: null })
      },
      then(res, rej) {
        reads.push([name, ...filters.map((f) => f.join(':'))].join('|'))
        let data = []
        if (name === 'properties' && filters.some(([op, c, v]) => op === 'eq' && c === 'master_owner_id' && v === 'mo_e3')) {
          data = [{ property_id: '24507162', master_owner_id: 'mo_e3', property_address_full: '575 W Pecos Rd', estimated_value: 111363200, units_count: 392 }]
        }
        return Promise.resolve({ data }).then(res, rej)
      },
    }
    return q
  }
  const n = await getEntityNetwork('owner', 'mo_e3', { supabase: { from, rpc: async () => ({ data: null }) } })
  assert.equal(n.properties.length, 1)
  assert.equal(n.properties[0].id, '24507162')
  assert.ok(n.graph.nodes.some((x) => x.id === 'property:24507162'))
  assert.ok(reads.some((r) => r.startsWith('properties|in:property_id:prop_875d0ee2eacd14798bb4adf4')))
  assert.ok(reads.some((r) => r === 'properties|eq:master_owner_id:mo_e3'))
})

test('network people carry their vendor contact-matching tags verbatim', async () => {
  const { getEntityNetwork } = await import('../../src/lib/domain/entity-graph/entity-network-service.js')
  const from = (name) => {
    const q = {
      select() { return q }, neq() { return q }, gt() { return q }, ilike() { return q }, order() { return q }, limit() { return q }, eq() { return q }, in() { return q },
      maybeSingle() { return Promise.resolve({ data: name === 'master_owners' ? { master_owner_id: 'mo1', display_name: 'A', joined_property_ids_json: '[]' } : null }) },
      then(res, rej) {
        const data = name === 'prospects' ? [{ prospect_id: 'pr1', full_name: 'JANE DOE', matching_flags: 'Likely Owner, Family' }, { prospect_id: 'pr2', full_name: 'JOHN DOE', matching_flags: null }] : []
        return Promise.resolve({ data }).then(res, rej)
      },
    }
    return q
  }
  const n = await getEntityNetwork('owner', 'mo1', { supabase: { from, rpc: async () => ({ data: null }) } })
  assert.deepEqual(n.people.map((p) => p.matchingTags), [['Likely Owner', 'Family'], []])
})

test('equity is known only with evidence: no loan on file is UNKNOWN, never 100%', async () => {
  const { equityTruth, isTestPropertyId } = await import('../../src/lib/domain/entity-graph/entity-graph-truth.js')
  assert.deepEqual(equityTruth({ estimated_value: 200000, total_loan_balance: 50000 }), { known: true, percent: 75, amount: 150000, class: 'high', rule: 'loan_and_value' })
  // Rocky Mount: vendor equity_percent 100, loan 0, no flag → unknown
  assert.equal(equityTruth({ estimated_value: 135000, total_loan_balance: 0, equity_percent: 100 }).known, false)
  assert.equal(equityTruth({ estimated_value: 135000, total_loan_balance: null }).rule, 'unknown')
  assert.equal(equityTruth({ estimated_value: 135000, total_loan_balance: 0, property_flags_text: 'Cash Buyer; Free And Clear; High Equity' }).rule, 'free_and_clear')
  const he = equityTruth({ estimated_value: 135000, total_loan_balance: 0, property_flags_text: 'High Equity; Absentee Owner' })
  assert.deepEqual([he.known, he.percent, he.class], [false, null, 'high'])
  assert.equal(isTestPropertyId('canaryprop_offerauth_75060_01'), true)
  assert.equal(isTestPropertyId('24507162'), false)
})

test('browsed property rows carry the equity truth, and test fixtures are excluded from the cohort', async () => {
  const calls = []
  const make = () => {
    const q = {
      select() { return q }, order() { return q },
      not(c, op, v) { calls.push([c, op, v]); return q },
      range() { return Promise.resolve({ data: [{ property_id: 'P1', property_address_full: '1 Main St', estimated_value: 135000, total_loan_balance: 0, equity_percent: 100 }], error: null }) },
      then(resolve) { return Promise.resolve({ count: 1, error: null }).then(resolve) },
    }
    return q
  }
  const out = await browseEntityGraph({ tab: 'properties' }, { supabase: { from: () => make() }, propertySortIndexes: async () => new Set() })
  assert.equal(out.results[0].details.equity, null)
  assert.equal(out.results[0].details.equityRule, 'unknown')
  assert.ok(calls.some(([c, op, v]) => c === 'property_id' && op === 'like' && v === 'canaryprop%'))
})
