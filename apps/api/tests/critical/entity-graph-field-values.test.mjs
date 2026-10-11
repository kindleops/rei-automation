/**
 * "ALL FIELDS" VALUE PICKERS (owner P0 2026-10-10: "it adds a filter where you
 * must TYPE a value — I want a DROPDOWN of real values with counts").
 *
 *   - one endpoint: the header filters' /entity-graph/header-values, ?field=
 *     any tab; properties read the facts relation (factsHeaderValues — the
 *     header filters' own function), other tabs the composition's exact GROUP BY
 *   - the field's own filter is left out of its counts
 *   - checklist / range (+ histogram hints) / boolean; free text only for
 *     names, addresses and ids (server rule == dashboard rule)
 *   - SQL forms (histogram buckets, delimited tokens, value search) == the JS
 *     forms over live records — proven on a scratch Postgres when
 *     EG_PG_TEST_DB_URL is set (skipped otherwise)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FREE_TEXT_FIELD, fieldControl, foldValueVariants, getEntityGraphFieldValues, getEntityGraphHeaderValues } from '../../src/lib/domain/entity-graph/entity-graph-header-values.js'
import { getEntityGraphFilterFields, SENSITIVE_NOTE } from '../../src/lib/domain/entity-graph/entity-graph-field-filters.js'
import { __factsListCacheTest, __factsUniverseMemoTest, factsHeaderValues, histogramOf } from '../../src/lib/domain/entity-graph/entity-graph-facts-query.js'
import { groupedFacetCounts, groupedRangeStats, groupedTokenCounts } from '../../src/lib/domain/entity-graph/entity-graph-facet-sql.js'
import { PTYPE_ADDENDUM } from '../../src/lib/domain/entity-graph/entity-graph-facts.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../../..')
const field = (tab, key) => getEntityGraphFilterFields(tab).find((f) => f.key === key)
const ff = (arr) => JSON.stringify(arr)

test('picker per field: checklist for categorical / lists, range for numbers + dates, Yes/No for booleans, free text only for names / addresses / ids', () => {
  const p = (k) => fieldControl(field('properties', k))
  for (const k of ['properties.market', 'properties.property_address_city', 'properties.property_address_county_name', 'properties.property_address_zip', 'properties.property_address_state', 'properties.zoning', 'properties.building_condition', 'facts.property_type_class', 'properties.flags', 'facts.sms_status']) assert.equal(p(k), 'checklist', k)
  for (const k of ['properties.estimated_value', 'properties.year_built', 'properties.units_count', 'records.mortgage_balance', 'facts.person_age', 'properties.known_equity_percent']) assert.equal(p(k), 'range', k)
  for (const k of ['properties.tax_delinquent', 'properties.is_corporate_owner', 'facts.sms_eligible', 'properties.tax_delinquent_any']) assert.equal(p(k), 'boolean', k)
  for (const k of ['properties.property_id', 'properties.master_owner_id', 'facts.company_name', 'facts.contact_person', 'facts.entity_name', 'records.first_lender']) assert.equal(p(k), 'text', k)
  assert.equal(fieldControl(field('people', 'prospects.gender')), 'checklist')
  assert.equal(fieldControl(field('people', 'prospects.age_years')), 'range')
  assert.equal(fieldControl(field('master_owners', 'master_owners.property_count')), 'range')
  assert.equal(fieldControl(field('buyers', 'buyers.states')), 'checklist')
  // nothing outside the free-text rule is typed
  const typed = getEntityGraphFilterFields('properties').filter((f) => fieldControl(f) === 'text').map((f) => f.key)
  assert.ok(typed.every((k) => FREE_TEXT_FIELD.test(k)))
  assert.ok(typed.length <= 20, typed.join(' '))
})

test('the dashboard picker uses the SAME free-text rule as the server', () => {
  const ts = fs.readFileSync(path.join(repo, 'apps/dashboard/src/modules/entity-graph/desk/desk-field-values.ts'), 'utf8')
  const m = ts.match(/export const FREE_TEXT_FIELD = (\/.*\/)\n/)
  assert.ok(m, 'FREE_TEXT_FIELD not found in desk-field-values.ts')
  assert.equal(m[1], String(FREE_TEXT_FIELD))
})

test('personal attributes carry the sensitive marker (display / targeting only, never pricing); company age does not', () => {
  for (const k of ['prospects.gender', 'prospects.marital_status', 'prospects.age_years', 'prospects.language_preference', 'prospects.est_household_income', 'prospects.net_asset_value', 'prospects.occupation_group']) {
    assert.equal(field('people', k).sensitive, 'personal_attribute', k)
    assert.equal(field('people', k).sensitive_note, SENSITIVE_NOTE)
  }
  for (const k of ['facts.person_gender', 'facts.person_age', 'facts.person_net_asset_value']) assert.equal(field('properties', k).sensitive, 'personal_attribute', k)
  assert.equal(field('properties', 'facts.company_age_years').sensitive, undefined)
  assert.equal(field('properties', 'properties.estimated_value').sensitive, undefined)
})

test('people / owners / phones: exact GROUP BY on the tab table, own filter left out, search server-side', async () => {
  const calls = []
  const deps = {
    groupedFacetCounts: async (a) => { calls.push(['facet', a]); return [{ value: 'Female', count: 7 }, { value: 'Male', count: 9 }, { value: null, count: 4 }] },
    groupedTokenCounts: async (a) => { calls.push(['tokens', a]); return { tokens: [{ value: 'Likely Owner', count: 5 }, { value: 'Linked To Company', count: 2 }], total: 11 } },
    groupedRangeStats: async (a) => { calls.push(['range', a]); return { total: 20, known: 12, range: { min: '1', max: '40' }, histogram: { quantiles: { p50: 2 }, buckets: [] } } },
  }
  const filters = ff([{ field_key: 'prospects.gender', operator: 'is_any_of', value: ['Male'] }, { field_key: 'prospects.language_preference', operator: 'is_any_of', value: ['Spanish'] }])
  const g = await getEntityGraphFieldValues({ tab: 'people', field: 'prospects.gender', field_filters: filters, search: 'ma' }, deps)
  assert.equal(g.control, 'checklist')
  assert.equal(g.field.sensitive, 'personal_attribute')
  assert.deepEqual(g.values.map((v) => v.value), ['Male', 'Female', null])
  const facetCall = calls.find((c) => c[0] === 'facet')[1]
  assert.equal(facetCall.source, 'prospects')
  assert.equal(facetCall.column, 'gender')
  assert.equal(facetCall.search, 'ma')
  // the applier: language filter applied, gender (the field itself) left out
  const rec = []
  const builder = new Proxy({}, { get: (_, m) => (...args) => { rec.push([m, ...args]); return builder } })
  facetCall.applyFilters(builder)
  assert.ok(rec.some((r) => JSON.stringify(r).includes('language_preference')))
  assert.ok(!rec.some((r) => JSON.stringify(r).includes('"gender"')))
  const t = await getEntityGraphFieldValues({ tab: 'people', field: 'prospects.matching_flags' }, deps)
  assert.equal(t.kind, 'tokens')
  assert.equal(calls.find((c) => c[0] === 'tokens')[1].split, ', ')
  const r = await getEntityGraphFieldValues({ tab: 'master_owners', field: 'master_owners.property_count' }, deps)
  assert.equal(r.control, 'range')
  assert.equal(calls.find((c) => c[0] === 'range')[1].source, 'master_owners')
  const b = await getEntityGraphFieldValues({ tab: 'buyers', field: 'buyers.states' }, deps)
  assert.equal(calls.filter((c) => c[0] === 'tokens')[1][1].array, true, 'buyer text[] columns unnest')
  assert.equal(b.control, 'checklist')
})

test('the header-values endpoint answers ?field= (one path for the rail and the headers); unknown fields say so', async () => {
  const deps = { groupedFacetCounts: async () => [{ value: 'W', count: 3 }] }
  const v = await getEntityGraphHeaderValues({ tab: 'contact_methods', field: 'phones.phone_type' }, deps)
  assert.equal(v.supported, true)
  assert.equal(v.values[0].value, 'W')
  const u = await getEntityGraphHeaderValues({ tab: 'people', field: 'prospects.nope' }, deps)
  assert.equal(u.supported, false)
  assert.equal(u.reason, 'unknown_field')
  const txt = await getEntityGraphHeaderValues({ tab: 'properties', field: 'facts.company_name' }, deps)
  assert.equal(txt.control, 'text')
  assert.equal(txt.values, undefined, 'free-text fields read nothing')
})

/** live facts fake: the cohort from the view, the use observations, facts computed in JS */
function liveFake({ cohort, uses = [] }) {
  return async (sql, params = []) => {
    if (/from seller\.property_use_observation/.test(sql)) return { rows: params[0] && Array.isArray(params[0]) ? uses.filter((u) => params[0].includes(u.property_id)) : uses }
    if (/from public\.v_entity_graph_properties/.test(sql)) return { rows: cohort.map((r) => ({ ...r })) }
    return { rows: [] }
  }
}

test('properties: the canonical type values are the facts registry computed over the WHOLE cohort (live), counted exactly', async () => {
  __factsListCacheTest.reset(); __factsUniverseMemoTest.reset()
  const cohort = [
    { property_id: 'a', property_type: 'Apartment', units_count: 2 },
    { property_id: 'b', property_type: 'Multi-family', units_count: 2 },
    { property_id: 'c', property_type: 'SFR', units_count: 1 },
    { property_id: 'd', property_type: 'Other', property_class: 'Commercial' },
    { property_id: 'e', property_type: 'Other' },
  ]
  const uses = [{ property_id: 'a', property_use: 'Apartments (generic)' }, { property_id: 'd', property_use: 'Mini-Warehouse, Self-Storage' }]
  const deps = { factsDeps: { query: liveFake({ cohort, uses }), factsState: async () => ({ mode: 'live' }), entityRoleMode: 'off' } }
  const v = await getEntityGraphFieldValues({ tab: 'properties', field: 'facts.property_type_class' }, deps)
  assert.equal(v.control, 'checklist')
  assert.equal(v.total, 5)
  assert.deepEqual(Object.fromEntries(v.values.map((x) => [x.value ?? '(none)', x.count])), { Duplex: 2, 'Single Family': 1, 'Self Storage': 1, '(none)': 1 })
  const s = await getEntityGraphFieldValues({ tab: 'properties', field: 'facts.property_type_class', search: 'dup' }, deps)
  assert.deepEqual(s.values.map((x) => x.value), ['Duplex'])
})

test('case / spacing variants fold into ONE option that filters every spelling (data untouched, filter exact)', async () => {
  const f = foldValueVariants([{ value: 'Multi-Family', count: 32164 }, { value: 'Single Family', count: 133416 }, { value: 'Multi-family', count: 278 }, { value: null, count: 4 }, { value: 'INDIVIDUAL', count: 3375 }, { value: 'Individual', count: 87860 }])
  assert.deepEqual(f, [
    { value: 'Single Family', count: 133416 },
    { value: 'Individual', count: 91235, variants: ['Individual', 'INDIVIDUAL'] },
    { value: 'Multi-Family', count: 32442, variants: ['Multi-Family', 'Multi-family'] },
    { value: null, count: 4 },
  ])
  // owner type through the endpoint: the folded option carries both spellings
  const v = await getEntityGraphFieldValues({ tab: 'master_owners', field: 'master_owners.owner_type_guess' }, { groupedFacetCounts: async () => [{ value: 'Individual', count: 9 }, { value: 'INDIVIDUAL', count: 2 }] })
  assert.deepEqual(v.values, [{ value: 'Individual', count: 11, variants: ['Individual', 'INDIVIDUAL'] }])
})

test('JS histogram: 12 equal buckets between p1 and p99, tails counted, every value counted once', () => {
  const xs = Array.from({ length: 1000 }, (_, i) => i + 1).concat([1e7])
  const h = histogramOf(xs)
  const sum = h.buckets.reduce((n, b) => n + b.count, 0)
  assert.equal(sum, xs.length)
  assert.ok(h.buckets.some((b) => b.tail === 'above'))
  assert.equal(h.buckets.filter((b) => !b.tail).length, 12)
  assert.ok(h.quantiles.p50 > 450 && h.quantiles.p50 < 550)
  assert.equal(histogramOf([]), null)
})

/* ── SQL forms on a scratch Postgres (skipped without EG_PG_TEST_DB_URL) ─────────── */

const PG_URL = process.env.EG_PG_TEST_DB_URL || ''
test('SQL == JS: histogram buckets, delimited tokens, value search, range stats — facts table and tab tables', { skip: PG_URL ? false : 'EG_PG_TEST_DB_URL not set' }, async () => {
  const { default: pg } = await import('pg')
  const admin = new pg.Client({ connectionString: PG_URL })
  await admin.connect()
  const db = `egfv_${process.pid}_${Date.now()}`
  await admin.query(`create database ${db}`)
  const url = PG_URL.replace(/\/[^/?]*(\?|$)/, `/${db}$1`)
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try {
    await c.query(`create table public.eg_property_facts (property_id text primary key, market text, estimated_value numeric, property_flags_text text, last_sale_on text, property_type_class text)`)
    await c.query(`create table public.prospects (prospect_id text primary key, gender text, est_household_income text, mob text, age numeric)`)
    const rows = []
    for (let i = 0; i < 400; i += 1) {
      rows.push([`p${String(i).padStart(4, '0')}`, i % 3 ? 'Dallas, TX' : 'Miami, FL', i % 17 === 0 ? null : (i * 1250 + (i % 7) * 33), ['High Equity; Vacant Home', 'Tax Delinquent', '', null, 'Vacant Home;Probate'][i % 5], i % 9 === 0 ? null : `${2000 + (i % 20)}-0${1 + (i % 9)}-15`, i % 4 ? 'Single Family' : 'Duplex'])
    }
    rows.push(['p9999', 'Dallas, TX', 99000000, 'High Equity', '2025-01-01', 'Self Storage'])
    for (const r of rows) await c.query('insert into public.eg_property_facts values ($1,$2,$3,$4,$5,$6)', r)
    for (let i = 0; i < 60; i += 1) await c.query('insert into public.prospects values ($1,$2,$3,$4,$5)', [`x${i}`, i % 3 ? 'Female' : i % 2 ? 'Male' : null, ['$50-75K', '$75-100K', null][i % 3], null, i % 5 ? 30 + i : null])
    const query = (sql, params) => c.query(sql, params)
    // the property-type addendum written by a full refresh (else its columns take the live path — asserted below)
    const table = { query, factsState: async () => ({ mode: 'table', asOf: '2026-10-10T00:00:00Z', columns: null, addenda: new Set([PTYPE_ADDENDUM]) }) }
    const dallas = (b) => b.eq('market', 'Dallas, TX')
    const kept = rows.filter((r) => r[1] === 'Dallas, TX')

    // numeric histogram: SQL buckets == histogramOf on the same values
    const num = await factsHeaderValues({ column: 'estimated_value', applyFilters: dallas, histogram: true, deps: table })
    const js = histogramOf(kept.map((r) => r[2]).filter((v) => v !== null).map(Number))
    assert.equal(num.total, kept.length)
    assert.equal(num.known, kept.filter((r) => r[2] !== null).length)
    for (const k of Object.keys(js.quantiles)) assert.ok(Math.abs(num.histogram.quantiles[k] - js.quantiles[k]) < 1e-6, k)
    assert.deepEqual(num.histogram.buckets.map((b) => b.count), js.buckets.map((b) => b.count))
    assert.equal(num.histogram.buckets.reduce((n, b) => n + b.count, 0), num.known)

    // date histogram per year
    const d = await factsHeaderValues({ column: 'last_sale_on', applyFilters: dallas, histogram: true, deps: { ...table } })
    assert.equal(d.histogram.years.reduce((n, y) => n + y.count, 0), kept.filter((r) => r[4] !== null).length)

    // delimited tokens ("; " with or without the space) == the JS split, once per property; search narrows
    const tok = await factsHeaderValues({ column: 'property_flags_text', applyFilters: dallas, split: '; ', deps: table })
    const want = new Map()
    for (const r of kept) {
      const list = [...new Set(String(r[3] ?? '').split(/\s*;\s*/).map((x) => x.trim()).filter(Boolean))]
      if (!list.length) want.set(null, (want.get(null) || 0) + 1)
      for (const t of list) want.set(t, (want.get(t) || 0) + 1)
    }
    assert.deepEqual(Object.fromEntries(tok.values.map((v) => [v.value ?? '(none)', v.count])), Object.fromEntries([...want].map(([k, v]) => [k ?? '(none)', v])))
    const vac = await factsHeaderValues({ column: 'property_flags_text', applyFilters: dallas, split: '; ', search: 'vacant', deps: table })
    assert.deepEqual(vac.values.map((v) => v.value), ['Vacant Home'])

    // categorical search on the facts table
    const ty = await factsHeaderValues({ column: 'property_type_class', applyFilters: (b) => b, search: 'stor', deps: table })
    assert.deepEqual(ty.values, [{ value: 'Self Storage', count: 1 }])
    assert.equal(ty.mode, 'table')
    // the addendum not yet written by a full refresh: never read from the table (its column may be empty) → live path
    const notReady = { query, factsState: async () => ({ mode: 'table', asOf: '2026-10-10T00:00:00Z', columns: null, addenda: new Set() }) }
    await assert.rejects(factsHeaderValues({ column: 'property_type_class', applyFilters: (b) => b, deps: notReady }), /v_entity_graph_properties/)

    // other tabs: exact GROUP BY with search; range stats with the same bucket rule
    const g = await groupedFacetCounts({ source: 'prospects', column: 'gender', query, now: 1 })
    assert.equal(g.reduce((n, r) => n + r.count, 0), 60)
    const gs = await groupedFacetCounts({ source: 'prospects', column: 'gender', search: 'fem', query, now: 2 })
    assert.deepEqual(gs.map((r) => r.value), ['Female'])
    const rs = await groupedRangeStats({ source: 'prospects', column: 'age', query })
    const ages = Array.from({ length: 60 }, (_, i) => (i % 5 ? 30 + i : null)).filter((v) => v !== null)
    assert.equal(rs.known, ages.length)
    assert.deepEqual(rs.histogram.buckets.map((b) => b.count), histogramOf(ages).buckets.map((b) => b.count))
    const tk = await groupedTokenCounts({ source: 'eg_property_facts', column: 'property_flags_text', split: '; ', query, now: 3 })
    assert.equal(tk.total, rows.length)
  } finally {
    await c.end()
    await admin.query(`drop database if exists ${db}`)
    await admin.end()
  }
})
