/**
 * EG · the Universe Overview PAGE (owner 2026-10-12: "I meant an OVERVIEW
 * PAGE … it says 'Computing the universe' and nothing is loaded").
 *
 *   - global filters map to each scope's own field (or are named as not
 *     applying — never silently dropped, never silently applied)
 *   - properties / pipeline / contacts: indexed GROUP BYs on
 *     eg_property_facts under the list's own WHERE; every bucket and KPI is a
 *     rail chip that compiles (drill-down = that scope's grid, exact cohort)
 *   - the other scopes: the snapshot when it exists, else their own Overview
 *     LIVE (never "computing"); a filtered cohort is never served a universe
 *   - the as-of is always stated (facts refresh / snapshot / computed-at)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FACT_STATEMENTS,
  GLOBAL_FILTER_FIELDS,
  UNIVERSE_SCOPES,
  buildEntityGraphUniverse,
  factCards,
  globalFiltersFor,
  overviewCard,
  parseGlobals,
  parseList,
  __universeTest,
} from '../../src/lib/domain/entity-graph/entity-graph-universe-service.js'
import { compileCohort } from '../../src/lib/domain/entity-graph/entity-graph-overview-service.js'

const REFRESHED = '2026-10-11T04:24:04.500Z'
const FACT_COLS = ['property_id', ...new Set(FACT_STATEMENTS.map((s) => s.column))]
const GROUPS = {
  market: [{ k: 'Miami, FL', n: 20 }, { k: 'Dallas, TX', n: 10 }, { k: null, n: 2 }],
  property_address_state: [{ k: 'FL', n: 20 }, { k: 'TX', n: 12 }],
  asset_type: [{ k: 'SFR', n: 25 }, { k: 'Duplex', n: 7 }],
  sms_status: [{ k: 'eligible', n: 15 }, { k: 'missing_phone', n: 9 }, { k: 'suppressed', n: 8 }],
  distress_signal_count: [{ k: null, n: 20 }, { k: 1, n: 6 }, { k: 2, n: 4 }, { k: 4, n: 2 }],
  pipeline_stage: [{ k: null, n: 26 }, { k: 'offer', n: 3 }, { k: 'offer_interest', n: 2 }, { k: 'closed', n: 1 }],
  contact_candidate_phones: [{ k: 0, n: 30 }, { k: 2, n: 2 }],
}

function factsQuery({ refreshed = REFRESHED } = {}) {
  const seen = []
  const query = async (sql, params) => {
    seen.push({ sql, params })
    if (/eg_refresh_log/.test(sql)) return { rows: refreshed ? [{ at: refreshed }] : [] }
    if (/pg_attribute/.test(sql)) return { rows: FACT_COLS.map((c) => ({ c })) }
    if (/"equity_known_pct" >= 60/.test(sql)) return { rows: [{ n: 11 }] }
    if (/"last_contact_at" is not null/.test(sql)) return { rows: [{ n: 7 }] }
    for (const [col, rows] of Object.entries(GROUPS)) if (new RegExp(`^select (case when )?"${col}"`).test(sql.trim())) return { rows }
    return { rows: [] }
  }
  return { query, seen }
}

test('global filters: each scope applies only a field that means the same thing; the rest are named', () => {
  assert.deepEqual(parseList('["Miami, FL","Dallas, TX"]'), ['Miami, FL', 'Dallas, TX'], 'market names carry commas: a list is JSON')
  assert.deepEqual(parseList('Miami, FL'), ['Miami, FL'])
  assert.deepEqual(parseList('[not json'), [])
  const g = parseGlobals({ markets: '["Miami, FL"]', states: '["fl"]' })
  assert.deepEqual(g, { markets: ['Miami, FL'], states: ['FL'] })

  const p = globalFiltersFor('properties', g)
  assert.deepEqual(p.applied.map((a) => [a.field_key, a.value]), [['properties.market', ['Miami, FL']], ['properties.property_address_state', ['FL']]])
  assert.equal(p.ignored.length, 0)
  const people = globalFiltersFor('people', g)
  assert.equal(people.applied.length, 0)
  assert.deepEqual(people.ignored.map((i) => i.key), ['markets', 'states'])
  assert.ok(people.ignored.every((i) => /has no/.test(i.reason)))
  const buyers = globalFiltersFor('buyers', g)
  assert.deepEqual(buyers.applied.map((a) => [a.field_key, a.means]), [['buyers.states', 'bought in']])
  assert.deepEqual(buyers.ignored.map((i) => i.key), ['markets'])
  // every mapped field is that scope's own rail field (compiles, no 422)
  for (const [scope, map] of Object.entries(GLOBAL_FILTER_FIELDS)) {
    for (const t of Object.values(map)) assert.doesNotThrow(() => compileCohort({ tab: scope, field_filters: JSON.stringify([{ field_key: t.field_key, operator: 'is_any_of', value: ['X'] }]) }, { tab: scope }), `${scope} ${t.field_key}`)
  }
})

test('properties family: indexed GROUP BYs under the list WHERE; totals, KPIs and buckets from them; as-of = facts refresh', async () => {
  __universeTest.reset()
  const { query, seen } = factsQuery()
  const out = await buildEntityGraphUniverse({ scope: 'properties', markets: '["Miami, FL"]' }, { query })
  const [props, pipe, contacts] = out.cards
  assert.deepEqual(out.cards.map((c) => c.id), ['properties', 'pipeline', 'contacts'])
  assert.equal(props.total, 32, 'total = the market GROUP BY, summed')
  assert.equal(props.source, 'facts')
  assert.equal(props.as_of, REFRESHED)
  assert.deepEqual(props.applied, [{ field_key: 'properties.market', operator: 'is_any_of', value: ['Miami, FL'] }])
  assert.equal(props.kpis.find((k) => k.key === 'sms').value, 15)
  assert.equal(props.kpis.find((k) => k.key === 'equity60').value, 11)
  assert.equal(props.kpis.find((k) => k.key === 'distress2').value, 6, '2 signals + 4-or-more')
  assert.equal(pipe.total, 5, 'open deals exclude closed-lost and not-in-pipeline')
  assert.deepEqual(pipe.totalFilter.value.sort(), ['offer', 'offer_interest'])
  assert.equal(contacts.total, 23, 'a phone on file = every SMS status but missing_phone')

  // every statement carries the cohort's WHERE exactly as the list compiles it
  const cohort = compileCohort({ tab: 'properties', field_filters: JSON.stringify(props.applied) }, { tab: 'properties' })
  const factStmts = seen.filter((s) => /from public\."eg_property_facts"/.test(s.sql))
  assert.equal(factStmts.length, FACT_STATEMENTS.length)
  for (const s of factStmts) {
    assert.deepEqual(s.params, cohort.params)
    for (const clause of cohort.clauses) assert.ok(s.sql.includes(clause), `${clause} in ${s.sql.slice(0, 80)}`)
    assert.ok(!/with c as materialized/.test(s.sql), 'one GROUP BY per indexed column, never the wide FILTER scan')
  }
  // capped bins keep NULL out of "4 or more" (least() ignores NULL)
  assert.ok(factStmts.some((s) => /case when "distress_signal_count" is null then null else least/.test(s.sql)))
})

test('drill-down: every bucket / KPI / total chip compiles on its scope, and global ∧ chip is that grid’s cohort', async () => {
  __universeTest.reset()
  const { query } = factsQuery()
  const out = await buildEntityGraphUniverse({ scope: 'properties', states: '["FL"]' }, { query })
  let checked = 0
  for (const card of out.cards) {
    const chips = [card.totalFilter, ...card.kpis.map((k) => k.filter), ...card.charts.flatMap((c) => (c.buckets || []).map((b) => b.filter))].filter(Boolean)
    for (const f of chips) {
      const ff = [...card.applied, f]
      assert.doesNotThrow(() => compileCohort({ tab: card.scope, field_filters: JSON.stringify(ff) }, { tab: card.scope }), `${card.id} ${f.field_key}`)
      checked += 1
    }
  }
  assert.ok(checked > 20, `${checked} chips checked`)
  const distress = out.cards[0].charts.find((c) => c.key === 'distress')
  assert.deepEqual(distress.buckets.find((b) => b.key === '4').filter, { field_key: 'facts.distress_signal_count', operator: 'gte', value: 4 })
  assert.deepEqual(distress.buckets.find((b) => b.key === '2').filter, { field_key: 'facts.distress_signal_count', operator: 'between', value: [2, 2] })
  assert.equal(distress.buckets.find((b) => b.key === '__none').filter, null, '"No signals" is context, not a chip')
})

test('the unfiltered universe is served live from the facts table (never "computing"), cached, with the filter options', async () => {
  __universeTest.reset()
  const { query, seen } = factsQuery()
  const a = await buildEntityGraphUniverse({ scope: 'properties' }, { query })
  assert.ok(a.cards.every((c) => !c.computing && !c.unavailable))
  assert.ok(a.options.markets.length === 2 && a.options.states.length === 2)
  const n = seen.length
  const b = await buildEntityGraphUniverse({ scope: 'properties' }, { query })
  assert.equal(seen.length, n, 'served from the cache')
  assert.equal(b.cache, 'fresh')
  // without a successful facts refresh: an honest unavailable card, never a wider or stale answer
  __universeTest.reset()
  const none = await buildEntityGraphUniverse({ scope: 'properties' }, { query: factsQuery({ refreshed: null }).query })
  assert.match(none.cards[0].unavailable, /no successful refresh/)
})

test('other scopes: snapshot first (as-of = its refresh); else their own Overview LIVE; filtered never reads the universe snapshot', async () => {
  __universeTest.reset()
  const snapQuery = async (sql) => {
    if (/eg_overview_snapshot/.test(sql)) {
      return { rows: [
        { section: 'pinned', refreshed_at: '2026-10-12T03:45:10Z', payload: { id: 'pinned', fields: [{ key: 'master_owners.priority_tier', label: 'Priority tier', kind: 'categorical', buckets: [{ key: 'A', label: 'A', count: 9, filter: { field_key: 'master_owners.priority_tier', operator: 'is_any_of', value: ['A'] } }] }] } },
        { section: 'headline', refreshed_at: '2026-10-12T03:45:12Z', payload: { total: 102251, headline: { metrics: [{ key: 'cohort', label: 'Owners', value: 102251 }, { key: 'multi', label: 'Portfolio owners', value: 4005, filter: { field_key: 'master_owners.property_count', operator: 'gte', value: 2 } }] } } },
      ] }
    }
    return { rows: [] }
  }
  const calls = []
  const buildOverview = async (params, deps) => { calls.push({ params, deps }); return { supported: true, total: 7, headline: { metrics: [] }, sections: [{ id: 'pinned', fields: [] }], unavailable: [] } }
  const snap = await buildEntityGraphUniverse({ scope: 'master_owners' }, { query: snapQuery, buildOverview })
  assert.equal(snap.cards[0].source, 'snapshot')
  assert.equal(snap.cards[0].as_of, '2026-10-12T03:45:10.000Z')
  assert.equal(snap.cards[0].total, 102251)
  assert.deepEqual(snap.cards[0].kpis.map((k) => k.key), ['multi'], 'the cohort metric is the total, not a KPI')
  assert.equal(calls.length, 0)

  __universeTest.reset()
  const live = await buildEntityGraphUniverse({ scope: 'people' }, { query: async () => ({ rows: [] }), buildOverview })
  assert.equal(live.cards[0].source, 'live')
  assert.ok(live.cards[0].as_of)
  assert.equal(calls.at(-1).deps.allowUniverseScan, true, 'no snapshot → the base-table universe, live')

  __universeTest.reset()
  await buildEntityGraphUniverse({ scope: 'buyers', states: '["FL"]' }, { query: snapQuery, buildOverview })
  assert.equal(calls.at(-1).deps.allowUniverseScan, false)
  assert.deepEqual(JSON.parse(calls.at(-1).params.field_filters), [{ field_key: 'buyers.states', operator: 'is_any_of', value: ['FL'] }])
})

test('a cached universe still states the global filters it does not apply (per request)', async () => {
  __universeTest.reset()
  const buildOverview = async () => ({ supported: true, total: 3, headline: { metrics: [] }, sections: [{ id: 'pinned', fields: [] }], unavailable: [] })
  const deps = { query: async () => ({ rows: [] }), buildOverview }
  await buildEntityGraphUniverse({ scope: 'people' }, deps)
  const withMarket = await buildEntityGraphUniverse({ scope: 'people', markets: '["Miami, FL"]' }, deps)
  assert.equal(withMarket.cache, 'fresh')
  assert.deepEqual(withMarket.cards[0].ignored.map((i) => i.key), ['markets'])
})

test('cards: sensitive metrics / fields never become page KPIs or charts; every scope is on the page', () => {
  const card = overviewCard('people', {
    total: 10,
    headline: { metrics: [{ key: 'cohort', value: 10 }, { key: 'age', label: 'Age', value: 3, sensitive: true }, { key: 'sms', label: 'SMS eligible', value: 4 }] },
    pinned: { fields: [{ key: 'prospects.age_years', sensitive: true, buckets: [{ key: 'a', label: 'a', count: 1 }] }, { key: 'prospects.language_preference', label: 'Language', kind: 'categorical', buckets: [{ key: 'en', label: 'English', count: 4, filter: { field_key: 'prospects.language_preference', operator: 'is_any_of', value: ['en'] } }] }] },
  })
  assert.deepEqual(card.kpis.map((k) => k.key), ['sms'])
  assert.deepEqual(card.charts.map((c) => c.key), ['prospects.language_preference'])
  assert.deepEqual([...UNIVERSE_SCOPES], ['properties', 'master_owners', 'people', 'contact_methods', 'buyers', 'organizations'])
  const cards = factCards({ market: { error: 'Took longer than the 8 s budget — retry.' } })
  assert.equal(cards[0].total, null, 'a failed count is unavailable, never 0')
  assert.match(cards[0].charts[0].unavailable, /retry/)
})
