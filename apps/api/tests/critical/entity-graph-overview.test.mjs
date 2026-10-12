/**
 * Entity Graph OVERVIEW (spec 9 §4; owner 2026-10-09: "an overview section
 * where it shows the advanced metrics and the graph and the charts and
 * basically a breakdown of all the fields filtered").
 *
 *   - the cohort WHERE is the list's own (recorded from the browse appliers) —
 *     the Overview total is the grid total for the same params
 *   - every bucket carries the rail's own filter AST, and that filter resolves
 *     (clicking a bar can never 422 or widen the cohort)
 *   - a flag token's grouped count is the flag filter's own match rule
 *   - protected-class-adjacent fields are charted WITH a sensitive marker (owner + counsel 2026-10-10);
 *     identifiers are coverage only
 *   - computed facts are read from the property facts read model only (a
 *     same-named legacy view column is NOT the fact)
 *   - a filter the tab cannot execute fails closed
 *
 * No network: the Postgres query is injected. The prod parity probe
 * (scripts/entity-graph/overview-parity-probe.mjs) checks the same buckets
 * against hand-written SQL on a market slice.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEntityGraphOverview,
  chooseRelation,
  columnsIn,
  compileCohort,
  paramList,
  sanitizeToken,
  __overviewTest,
} from '../../src/lib/domain/entity-graph/entity-graph-overview-service.js'
import {
  buildOverviewRegistry,
  bandsFromEdges,
  getOverviewCatalog,
  isProtectedField,
  OVERVIEW_SECTION_IDS,
  overviewRegistry,
} from '../../src/lib/domain/entity-graph/entity-graph-overview-catalog.js'
import { OVERVIEW_COLUMN_PROFILE } from '../../src/lib/domain/entity-graph/entity-graph-overview-profile.js'
import { compileFacetWhere } from '../../src/lib/domain/entity-graph/entity-graph-facet-sql.js'
import { applyPropertyFilters, parseBrowseFilters } from '../../src/lib/domain/entity-graph/entity-graph-service.js'
import {
  applyEntityGraphFieldFilters,
  flagTokenPatterns,
  resolveEntityGraphFieldFilters,
} from '../../src/lib/domain/entity-graph/entity-graph-field-filters.js'

const VIEW_COLUMNS = Object.entries(OVERVIEW_COLUMN_PROFILE).map(([column_name, p]) => ({ table_name: 'v_entity_graph_properties', column_name, data_type: p.type }))
  .concat([
    { table_name: 'v_entity_graph_properties', column_name: 'property_flags_text', data_type: 'text' },
    { table_name: 'v_entity_graph_properties', column_name: 'rec_lien_categories', data_type: 'ARRAY' },
  ])

/** A fake direct-PG query: schema, engagement, and one cohort statement row with the given aggregate values. */
function fakeQuery({ total = 1000, aggValue = 7, groups = [], tokens = [], extraTables = [] } = {}) {
  const seen = []
  const query = async (sql, params) => {
    seen.push({ sql, params })
    if (/information_schema\.columns|pg_attribute/.test(sql)) return { rows: [...VIEW_COLUMNS, ...extraTables] }
    if (/from public\.inbox_thread_state/.test(sql)) return { rows: [{ property_id: 'p1', contacted: true, replied: true, positive: false, inbox_bucket: null }] }
    if (/from public\.campaign_target_graph\s+where last_outbound_at/.test(sql)) return { rows: [] }
    if (/from public\.acquisition_opportunities/.test(sql)) return { rows: [{ property_id: 'p1', acquisition_stage: 'offer_interest', opportunity_status: 'active' }] }
    if (/with c as materialized/.test(sql)) {
      const aliases = [...sql.matchAll(/ as "(a\d+|h_[a-z0-9_]+)"/g)].map((m) => m[1])
      const agg = { t: total }
      for (const a of aliases) agg[a] = aggValue
      const row = { agg }
      for (const m of sql.matchAll(/ as "(g\d+)"/g)) row[m[1]] = groups
      for (const m of sql.matchAll(/ as "(k\d+)"/g)) row[m[1]] = tokens
      return { rows: [row] }
    }
    if (/select property_id from public\./.test(sql)) return { rows: [{ property_id: 'p1' }] }
    if (/count\(distinct/.test(sql)) return { rows: [{}] }
    if (/from public\.eg_refresh_log/.test(sql)) return { rows: [{ at: '2026-10-09T09:30:00Z' }] }
    return { rows: [] }
  }
  return { query, seen }
}

const DALLAS = JSON.stringify([{ field_key: 'properties.market', operator: 'is_any_of', value: ['Dallas, TX'] }])
const deps = (q) => ({ query: q, skipSnapshot: true, fetchEntityContactReviewBlocks: async () => ({ ok: true, blocked: new Set() }) })

test('the Overview cohort WHERE is the list WHERE (recorded from the browse appliers), so its total is the grid total', () => {
  const params = { tab: 'properties', field_filters: DALLAS, units_min: '2' }
  const cohort = compileCohort(params)
  const { resolved } = resolveEntityGraphFieldFilters('properties', JSON.parse(DALLAS))
  const facet = compileFacetWhere((b) => applyEntityGraphFieldFilters(applyPropertyFilters(b, parseBrowseFilters(params)), resolved))
  assert.equal(`where ${cohort.clauses.join(' and ')}`, facet.where)
  assert.deepEqual(cohort.params, facet.params)
})

test('the cohort statement scans the relation ONCE under exactly that WHERE', async () => {
  __overviewTest.reset()
  const { query, seen } = fakeQuery()
  const out = await buildEntityGraphOverview({ tab: 'properties', field_filters: DALLAS, sections: 'pinned,headline' }, deps(query))
  const cohortSql = seen.filter((s) => /with c as materialized/.test(s.sql))
  // pinned (+ the headline riding on it); the market card's ghost would be the WHOLE universe — never scanned live
  assert.equal(cohortSql.length, 1, 'one scan: pinned + headline; no live universe ghost')
  const cohort = compileCohort({ field_filters: DALLAS })
  const P = paramList()
  const where = P.embed(cohort.clauses, cohort.params)
  assert.ok(cohortSql[0].sql.includes(`from public."v_entity_graph_properties" where ${where})`))
  assert.equal(out.total, 1000)
  assert.equal(out.source.relation, 'v_entity_graph_properties')
})

test('every bucket carries a click filter the rail resolves — no 422, never a wider cohort', async () => {
  __overviewTest.reset()
  const { query } = fakeQuery({ groups: [{ gi: 0, k: 'Value A', n: 5, cnt: 2 }, { gi: 0, k: null, n: 3, cnt: 2 }], tokens: [{ k: 'vacant home', label: 'Vacant Home', n: 4 }] })
  const out = await buildEntityGraphOverview({ tab: 'properties', field_filters: DALLAS, sections: 'pinned,headline,geography,property,distress,value,debt,ownership' }, deps(query))
  let checked = 0
  for (const section of out.sections) {
    for (const f of section.fields) {
      for (const b of [...(f.buckets || []), ...(f.windows || [])]) {
        if (!b.filter) continue
        const { resolved, unsupported } = resolveEntityGraphFieldFilters('properties', [b.filter], { allowComputedFacts: true })
        assert.deepEqual(unsupported, [], `${f.key} ${b.key}`)
        assert.equal(resolved.length, 1)
        assert.equal(b.filter.field_key, f.key, 'a bar filters its own field')
        checked += 1
      }
    }
  }
  assert.ok(checked > 300, `checked ${checked} bucket filters`)
  for (const m of out.headline.metrics.filter((x) => x.filter)) assert.deepEqual(resolveEntityGraphFieldFilters('properties', [m.filter], { allowComputedFacts: true }).unsupported, [])
  for (const d of out.headline.distress) assert.deepEqual(resolveEntityGraphFieldFilters('properties', [d.filter]).unsupported, [])
})

test('a flag token grouped by the split rule matches exactly the rows its chip (ilike whole-token patterns) matches', () => {
  // ilike, as Postgres evaluates the four patterns flagTokenPatterns emits
  const ilike = (text, pattern) => new RegExp(`^${pattern.split('%').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'is').test(text)
  const chip = (text, token) => flagTokenPatterns(token).some((p) => ilike(text, p))
  // the SQL in tokenSql: split on ';', first piece as is, later pieces must start with ' ' (the lead), compared lower-case
  const split = (text) => new Set(String(text).split(';').map((p, i) => (i === 0 ? p : p.startsWith(' ') ? p.slice(1) : null)).filter((t) => t).map((t) => t.toLowerCase()))
  const pieces = ['Vacant Home', 'vacant home', ' Vacant Home', 'Vacant Home ', 'Tax Delinquent', 'Preforeclosure', 'Foreclosure', 'High Equity', '']
  const seps = ['; ', ';', ';  ', ' ; ']
  let rows = 0
  for (const a of pieces) for (const b of pieces) for (const c of pieces) for (const s1 of seps) for (const s2 of seps) {
    const text = `${a}${s1}${b}${s2}${c}`
    for (const token of ['Vacant Home', 'Foreclosure', 'Tax Delinquent', 'High Equity']) {
      assert.equal(split(text).has(token.toLowerCase()), chip(text, token), JSON.stringify({ text, token }))
    }
    rows += 1
  }
  assert.ok(rows > 5000)
  assert.equal(sanitizeToken("Mechanic's (lien)"), "Mechanic's lien")
})

test('protected-class-adjacent fields are charted with a sensitive marker; names, addresses, phones and identifiers are coverage only', () => {
  const registry = overviewRegistry()
  assert.ok(registry.length > 100, `registry has ${registry.length} fields`)
  for (const f of registry) {
    // policy (owner + counsel, 2026-10-10): every prospect field is a live targeting input; charted as descriptive
    // analytics, MARKED, never priced
    if (/gender|marital|(^|_)age(_|$)|race|ethnic|religio|national|disab|familial|language|(^|_)mob$/.test(f.column)) assert.equal(f.sensitive, true, `sensitive ${f.key}`)
    assert.ok(OVERVIEW_SECTION_IDS.includes(f.section), `${f.key} section ${f.section}`)
  }
  for (const col of ['owner_name', 'property_address_full', 'apn_parcel_id', 'legal_description', 'latitude', 'owner_1_name', 'owner_address_full']) {
    const f = registry.find((x) => x.column === col)
    if (f) assert.equal(f.privacy, 'coverage_only', col)
  }
  // a person-age / gender / language field is charted and marked sensitive
  const fake = buildOverviewRegistry('properties', { fields: [
    { key: 'facts.person_gender', source_column: 'person_gender', type: 'enum', category: 'People / entity', operators: [] },
    { key: 'facts.person_age', source_column: 'person_age', type: 'number', category: 'People / entity', operators: [] },
    { key: 'facts.owner_best_language', source_column: 'owner_best_language', type: 'enum', category: 'Owner record', operators: [] },
    { key: 'facts.contact_phone_count', source_column: 'contact_phone_count', type: 'number', category: 'Contacts', operators: [] },
  ] })
  assert.deepEqual(fake.filter((f) => f.sensitive).map((f) => f.key), ['facts.person_gender', 'facts.person_age', 'facts.owner_best_language'])
  const count = fake.find((f) => f.key === 'facts.contact_phone_count')
  assert.equal(count.sensitive, false)
  assert.equal(count.kind, 'numeric', 'a phone COUNT is a number, not an identifier')
  assert.ok(isProtectedField({ source_column: 'person_marital_status' }))
  const catalog = getOverviewCatalog('properties')
  assert.ok(catalog.sections.some((s) => s.id === 'company' && s.fields.some((f) => f.key === 'facts.company_status_class')))
})

test('a computed fact is read from the facts read model only — never from a same-named legacy view column', async () => {
  __overviewTest.reset()
  const { query } = fakeQuery()
  const out = await buildEntityGraphOverview({ tab: 'properties', field_filters: DALLAS, sections: 'outreach' }, deps(query))
  const sms = out.sections[0].fields.find((f) => f.key === 'facts.sms_eligible')
  if (sms) {
    assert.ok(sms.unavailable, 'v_entity_graph_properties.sms_eligible is a Podio-era copy, not the readiness verdict')
    assert.equal(sms.buckets, undefined)
  }
})

test('the facts read model is used once it exists AND a refresh logged ok; include_test always reads the view', () => {
  const facts = new Map([['property_id', 'text'], ['market', 'text']])
  const view = new Map([['property_id', 'text'], ['market', 'text'], ['zoning', 'text']])
  const schema = { v_entity_graph_properties: view, eg_property_facts: facts }
  assert.deepEqual(chooseRelation(schema, new Set(['market'])), { relation: 'eg_property_facts', mode: 'facts' })
  assert.deepEqual(chooseRelation(schema, new Set(['zoning'])), { relation: 'v_entity_graph_properties', mode: 'view' })
  assert.deepEqual(chooseRelation(schema, new Set(['market']), { includeTest: true }), { relation: 'v_entity_graph_properties', mode: 'view' })
  assert.equal(chooseRelation({ v_entity_graph_properties: view }, new Set(['sms_eligible_fact'])), null)
  assert.deepEqual([...columnsIn('"a" = $1 and "b_c" is null')], ['a', 'b_c'])
})

test('numeric bands close one unit (integers) or one cent (money) under the next edge, so adjacent chips never overlap', () => {
  const ints = bandsFromEdges([1, 2, 3, 5], { integer: true })
  assert.deepEqual(ints.map((b) => [b.lo, b.hi]), [[null, 0], [1, 1], [2, 2], [3, 4], [5, null]])
  const money = bandsFromEdges([100000, 250000], { format: 'money' })
  assert.deepEqual(money.map((b) => [b.lo, b.hi]), [[null, 99999.99], [100000, 249999.99], [250000, null]])
})

test('fails closed: an unexecutable filter throws (422 upstream), a search term is refused, never a silent universe', async () => {
  __overviewTest.reset()
  const { query } = fakeQuery()
  await assert.rejects(
    buildEntityGraphOverview({ tab: 'properties', field_filters: JSON.stringify([{ field_key: 'properties.no_such_column', operator: 'is_true' }]) }, deps(query)),
    (e) => e.code === 'unsupported_entity_graph_filters',
  )
  await assert.rejects(buildEntityGraphOverview({ tab: 'properties', q: 'main st' }, deps(query)), (e) => e.code === 'overview_search_unsupported')
  // every desk scope is supported now; an aggregate tab (zips) is not
  const other = await buildEntityGraphOverview({ tab: 'zips' }, deps(query))
  assert.equal(other.supported, false)
})
