/**
 * Entity Graph OVERVIEW on the 8.5.6 canonical fields (release 8.5.7, 2026-10-11).
 *
 *   - "Property type" in the pinned band is the canonical class (facts.property_type_class),
 *     the rail's own Property type facet; the vendor string stays "Property type (vendor raw)"
 *   - the 8.5.6 sensitive marker (personal_attribute) travels to the Overview card
 *   - an ADDENDUM fact column is read from eg_property_facts only once a successful refresh
 *     wrote it (eg_refresh_log.detail.addenda) — the 8.5.6 tableServes rule; until then the
 *     card is counted on the rail's facet path (factsHeaderValues), never read as blanks
 *   - a canonical-type chip in the cohort is resolved to its exact ids on the facet path, so
 *     every other section still reads the facts table in one scan
 *   - the unfiltered universe is "Computing" until the snapshot exists — the facts table too
 *     (measured on prod: pinned + headline over 176,603 rows ran past the 8 s budget)
 *
 * No network: Postgres and the facet path are injected.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEntityGraphOverview,
  LIVE_FACT_PENDING,
  LIVE_FACT_UNIVERSE,
  servedFactsColumns,
  UNIVERSE_COMPUTING,
  __overviewTest,
} from '../../src/lib/domain/entity-graph/entity-graph-overview-service.js'
import { OVERVIEW_PINNED, overviewRegistry } from '../../src/lib/domain/entity-graph/entity-graph-overview-catalog.js'
import { OVERVIEW_COLUMN_PROFILE } from '../../src/lib/domain/entity-graph/entity-graph-overview-profile.js'
import { PTYPE_ADDENDUM } from '../../src/lib/domain/entity-graph/entity-graph-facts.js'

const FACTS = 'eg_property_facts'
const VIEW = 'v_entity_graph_properties'
const BASE_COLUMNS = Object.entries(OVERVIEW_COLUMN_PROFILE).map(([column_name, p]) => ({ column_name, data_type: p.type }))
  .concat([{ column_name: 'property_flags_text', data_type: 'text' }, { column_name: 'rec_lien_categories', data_type: 'ARRAY' }])

const DALLAS = [{ field_key: 'properties.market', operator: 'is_any_of', value: ['Dallas, TX'] }]
const SF = { field_key: 'facts.property_type_class', operator: 'is_any_of', value: ['Residential SF'] }

function fakeDb({ withPtypeColumn = false, addenda = [] } = {}) {
  const seen = []
  const tables = [
    ...BASE_COLUMNS.map((c) => ({ table_name: VIEW, ...c })),
    ...BASE_COLUMNS.map((c) => ({ table_name: FACTS, ...c })),
    ...(withPtypeColumn ? [{ table_name: FACTS, column_name: 'property_type_class', data_type: 'text' }] : []),
    { table_name: 'eg_refresh_log', column_name: 'finished_at', data_type: 'timestamp with time zone' },
  ]
  const query = async (sql, params) => {
    seen.push({ sql, params })
    if (/information_schema\.columns|pg_attribute/.test(sql)) return { rows: tables }
    if (/from public\.eg_refresh_log/.test(sql)) return { rows: [{ at: '2026-10-11T04:24:04Z', detail: { batches: 89, ...(addenda.length ? { addenda } : {}) } }] }
    if (/with c as materialized/.test(sql)) {
      const agg = { t: 7738 }
      for (const m of sql.matchAll(/ as "(a\d+|h_[a-z0-9_]+|d\d+)"/g)) agg[m[1]] = 3
      const row = { agg }
      for (const m of sql.matchAll(/ as "(g\d+)"/g)) row[m[1]] = [{ gi: 0, k: 'Residential SF', n: 6745, cnt: 2 }, { gi: 0, k: null, n: 5, cnt: 2 }]
      for (const m of sql.matchAll(/ as "(k\d+)"/g)) row[m[1]] = []
      return { rows: [row] }
    }
    return { rows: [] }
  }
  return { query, seen }
}

/** The rail's facet path, injected: the canonical type's exact value counts for whatever cohort it is handed. */
function facetPath({ delayMs = 0 } = {}) {
  const calls = []
  const factsHeaderValues = async ({ column, applyFilters }) => {
    calls.push({ column, applyFilters })
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    return { column, kind: 'categorical', mode: 'live', source: 'memo', total: 7738, known: 7733, values: [{ value: 'Residential SF', count: 6745 }, { value: 'Residential Duplex', count: 988 }, { value: null, count: 5 }], truncated: false }
  }
  return { calls, factsHeaderValues }
}

const deps = (query, extra = {}) => ({ query, skipSnapshot: true, fetchEntityContactReviewBlocks: async () => ({ ok: true, blocked: new Set() }), ...extra })
const pinnedOf = (out) => out.sections.find((s) => s.id === 'pinned').fields

test('the pinned "Property type" is the canonical class (facts.property_type_class); the vendor string is labelled raw', () => {
  assert.ok(OVERVIEW_PINNED.includes('facts.property_type_class'))
  assert.ok(!OVERVIEW_PINNED.includes('properties.property_type'))
  const reg = overviewRegistry('properties')
  const ptype = reg.find((f) => f.key === 'facts.property_type_class')
  assert.equal(ptype.label, 'Property type')
  assert.equal(ptype.kind, 'categorical')
  assert.equal(ptype.pinned, true)
  assert.equal(reg.find((f) => f.key === 'properties.property_type')?.label, 'Property type (vendor raw)')
})

test('the 8.5.6 personal-attribute marker travels to the Overview card (income, NAV …)', () => {
  const people = overviewRegistry('people')
  const income = people.find((f) => f.key === 'prospects.est_household_income')
  assert.ok(income, 'income is charted on the people scope')
  assert.equal(income.sensitive, true)
})

test('an addendum column is served by the facts table only once a refresh logged it', () => {
  const cols = new Map([['market', 'text'], ['property_type_class', 'text']])
  assert.equal(servedFactsColumns(cols, new Set()).has('property_type_class'), false)
  assert.equal(servedFactsColumns(cols, new Set()).has('market'), true)
  assert.equal(servedFactsColumns(cols, new Set([PTYPE_ADDENDUM])).has('property_type_class'), true)
})

test('Dallas: Property type is counted on the rail facet path while the read model does not serve it; the rest reads eg_property_facts', async () => {
  for (const withPtypeColumn of [false, true]) {
    __overviewTest.reset()
    const { query, seen } = fakeDb({ withPtypeColumn })
    const facet = facetPath()
    const out = await buildEntityGraphOverview({ tab: 'properties', field_filters: JSON.stringify(DALLAS), sections: 'pinned' }, deps(query, { factsHeaderValues: facet.factsHeaderValues }))
    const stmts = seen.filter((s) => /with c as materialized/.test(s.sql))
    assert.equal(stmts.length, 1)
    assert.ok(stmts[0].sql.includes(`from public."${FACTS}"`), 'the section scan reads the facts table')
    assert.ok(!/"property_type_class"/.test(stmts[0].sql), 'an unwritten addendum column is never read as blanks')
    assert.equal(facet.calls.length, 1)
    assert.equal(facet.calls[0].column, 'property_type_class')
    const fields = pinnedOf(out)
    assert.equal(fields[1].key, 'facts.property_type_class', 'registry order: market, then Property type')
    const ptype = fields[1]
    assert.equal(ptype.liveFact, true)
    assert.equal(ptype.coverage.total, 7738)
    assert.deepEqual(ptype.buckets[0], { key: 'Residential SF', label: 'Residential SF', count: 6745, filter: { field_key: 'facts.property_type_class', operator: 'is_any_of', value: ['Residential SF'] }, tone: 'value' })
    assert.ok(ptype.buckets.some((b) => b.key === '__none' && b.count === 5))
  }
})

test('once a refresh wrote the addendum, Property type is one more column of the section scan (no facet call)', async () => {
  __overviewTest.reset()
  const { query, seen } = fakeDb({ withPtypeColumn: true, addenda: [PTYPE_ADDENDUM] })
  const facet = facetPath()
  const out = await buildEntityGraphOverview({ tab: 'properties', field_filters: JSON.stringify(DALLAS), sections: 'pinned' }, deps(query, { factsHeaderValues: facet.factsHeaderValues }))
  assert.equal(facet.calls.length, 0)
  const stmt = seen.find((s) => /with c as materialized/.test(s.sql))
  assert.ok(/"property_type_class"/.test(stmt.sql))
  assert.equal(pinnedOf(out).find((f) => f.key === 'facts.property_type_class').liveFact, undefined)
})

test('a canonical-type chip is resolved to its exact ids on the facet path; the scan carries property_id = any(ids), never the unserved column', async () => {
  __overviewTest.reset()
  const { query, seen } = fakeDb()
  const facet = facetPath()
  const relCalls = []
  const factsCohortRelation = async (args) => { relCalls.push(args); return { from: 'jsonb_to_recordset($1::jsonb) as f("property_id" text, "property_type_class" text)', where: 'where "property_type_class" = any($2)', params: ['[]', ['Residential SF']], mode: 'live', source: 'memo', records: [] } }
  const factsQuery = async (sql) => (/select f\."property_id"/.test(sql) ? { rows: [{ property_id: 'p1' }, { property_id: 'p2' }] } : { rows: [] })
  const out = await buildEntityGraphOverview(
    { tab: 'properties', field_filters: JSON.stringify([...DALLAS, SF]), sections: 'pinned' },
    deps(query, { factsHeaderValues: facet.factsHeaderValues, factsCohortRelation, factsDeps: { query: factsQuery } }),
  )
  assert.ok(relCalls.length >= 1)
  const stmt = seen.find((s) => /with c as materialized/.test(s.sql))
  assert.ok(stmt.sql.includes(`from public."${FACTS}"`))
  assert.ok(/"property_id" = any\(\$\d+\)/.test(stmt.sql))
  assert.ok(!/"property_type_class"/.test(stmt.sql))
  assert.ok(stmt.params.some((p) => Array.isArray(p) && p.join() === 'p1,p2'))
  assert.deepEqual(out.liveChips, { fields: ['facts.property_type_class'], ids: 2, mode: 'memo' })
})

test('an empty chip match is an empty cohort, never the market', async () => {
  __overviewTest.reset()
  const { query, seen } = fakeDb()
  const facet = facetPath()
  const factsCohortRelation = async () => ({ from: 'x f', where: 'where false', params: [], mode: 'live', records: [] })
  await buildEntityGraphOverview(
    { tab: 'properties', field_filters: JSON.stringify([...DALLAS, SF]), sections: 'pinned' },
    deps(query, { factsHeaderValues: facet.factsHeaderValues, factsCohortRelation, factsDeps: { query: async () => ({ rows: [] }) } }),
  )
  const stmt = seen.find((s) => /with c as materialized/.test(s.sql))
  assert.ok(stmt.params.some((p) => Array.isArray(p) && p.length === 1 && p[0] === '__no_property__'))
})

test('the unfiltered universe is "Computing" on the facts table too until the snapshot exists — no live scan, no facet-path universe', async () => {
  __overviewTest.reset()
  const { query, seen } = fakeDb()
  const facet = facetPath()
  const out = await buildEntityGraphOverview({ tab: 'properties', sections: 'pinned,headline,property' }, deps(query, { factsHeaderValues: facet.factsHeaderValues }))
  assert.equal(out.computing, true)
  assert.equal(seen.filter((s) => /with c as materialized/.test(s.sql)).length, 0)
  assert.equal(facet.calls.length, 0)
  assert.ok(out.sections.every((s) => s.computing && s.unavailable === UNIVERSE_COMPUTING))
  assert.ok(out.unavailable.some((u) => u.section === 'headline' && u.computing))
  assert.equal(typeof LIVE_FACT_UNIVERSE, 'string')
})

test('a facet-path read past the section budget says retry (and keeps warming) — never an estimate', async () => {
  __overviewTest.reset()
  const { query } = fakeDb()
  const facet = facetPath({ delayMs: 80 })
  const out = await buildEntityGraphOverview({ tab: 'properties', field_filters: JSON.stringify(DALLAS), sections: 'pinned' }, deps(query, { factsHeaderValues: facet.factsHeaderValues, timeoutMs: 20 }))
  const ptype = pinnedOf(out).find((f) => f.key === 'facts.property_type_class')
  assert.equal(ptype.unavailable, LIVE_FACT_PENDING)
  assert.equal(ptype.retry, true)
  assert.deepEqual(ptype.buckets, [])
})
