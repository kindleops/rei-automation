/**
 * Entity Graph property facts (owner, 2026-10-09: "ALL the columns up top —
 * you should be able to click and sort and filter"):
 *   - the registry computes with the cells' own functions (SMS readiness,
 *     latestContact, equityTruth, recorded-document split, signals…);
 *   - keyed and sequential-scan input reads produce identical facts;
 *   - the generated PROPOSED migration is exactly what is committed;
 *   - the company registry status normalisation is one table, tested;
 *   - a header filter is an ordinary chip in the same AST, compiled by the
 *     same recorder (round trip), and computed-fact clauses split cleanly;
 *   - the live order equals SQL ORDER BY semantics (db-ranked values, nulls
 *     last by property_id), and pages continue exactly.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMPUTED_FACTS,
  FACT_BY_COL,
  PLAIN_FACT_COLUMNS,
  SIGNAL_TABLE,
  NOT_SIGNALS,
  baseColumnsFor,
  computeFacts,
  inputsFor,
  propertySignalsFromRow,
  widenToFamilies,
  WITHHELD_FACT_COLUMNS,
} from '../../src/lib/domain/entity-graph/entity-graph-facts.js'
import { generateFactsMigrationSql, generateFactsPretestSql, generateFactsRollbackSql, factsTableColumns, FACTS_SORT_INDEXES } from '../../src/lib/domain/entity-graph/entity-graph-facts-ddl.js'
import { COMPANY_STATUS_CLASSES, classifyCompanyStatus, propertyCompanyStatus } from '../../src/lib/domain/entity-graph/entity-graph-company-status.js'
import { compileFacetWhere, selectClauses } from '../../src/lib/domain/entity-graph/entity-graph-facet-sql.js'
import {
  applyEntityGraphFieldFilters,
  ENTITY_GRAPH_WITHHELD_FIELDS,
  getEntityGraphFilterFields,
  isComputedFactFilter,
  resolveEntityGraphFieldFilters,
} from '../../src/lib/domain/entity-graph/entity-graph-field-filters.js'
import { applyPropertyFilters, browseEntityGraph, parseBrowseFilters } from '../../src/lib/domain/entity-graph/entity-graph-service.js'
import { headerFieldFor } from '../../src/lib/domain/entity-graph/entity-graph-header-values.js'
import { propertySmsEligibility, latestContact } from '../../src/lib/domain/entity-graph/entity-graph-outreach-state.js'
import { equityTruth } from '../../src/lib/domain/entity-graph/entity-graph-truth.js'
import {
  __factsListCacheTest,
  __factsUniverseMemoTest,
  decodeFactsAfter,
  factsColumnSupported,
  factsSortedPage,
} from '../../src/lib/domain/entity-graph/entity-graph-facts-query.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../../..')

/* ── registry ─────────────────────────────────────────────────────────────── */

test('every computed fact declares a pg type and a filter kind; columns are unique and never collide with plain columns', () => {
  const seen = new Set()
  for (const f of COMPUTED_FACTS) {
    assert.ok(f.pg, `${f.col} has a pg type`)
    assert.ok(['categorical', 'numeric', 'date', 'boolean', 'text', 'tokens'].includes(f.kind), `${f.col} kind ${f.kind}`)
    assert.ok(!seen.has(f.col), `${f.col} unique`)
    assert.ok(!PLAIN_FACT_COLUMNS.includes(f.col), `${f.col} is not also a plain column`)
    seen.add(f.col)
  }
  for (const col of ['sms_eligible', 'sms_status', 'sms_sort', 'last_contact_at', 'pipeline_stage', 'pipeline_status', 'conversation_stage', 'conversation_status',
    'equity_known_pct', 'lien_count', 'filing_types', 'signal_labels', 'company_status_class', 'company_status_raw', 'company_inactive',
    'company_dissolution_date', 'company_incorporation_date', 'company_jurisdiction', 'owner_display_name', 'person_age', 'contact_line_type',
    'scores_aos_score', 'zip_sales_1y', 'contact_candidate_phones', 'campaign_count']) {
    assert.ok(FACT_BY_COL.has(col), `fact ${col} exists`)
  }
})

test('SMS facts are the campaign builder readiness verdict (propertySmsEligibility), never a second rule', async () => {
  const graph = [
    { property_id: 'p1', queue_eligible: true, seller_person_key: 'k1', canonical_e164: '+15550000001', timezone: 'America/Chicago', identity_alignment: 'verified', best_phone_score: 80 },
    { property_id: 'p2', queue_eligible: false, queue_block_reason: 'missing_phone', seller_person_key: 'k2' },
    { property_id: 'p2', queue_eligible: true, seller_person_key: 'k2', canonical_e164: '+15550000002', timezone: 'America/Chicago', identity_alignment: 'unknown' },
    { property_id: 'p4', queue_eligible: true, seller_person_key: 'k4', canonical_e164: '+15550000004', timezone: 'America/Chicago', identity_alignment: 'verified' },
  ]
  const query = fakeInputs({ graph, review: [{ property_id: 'p4' }] })
  const base = ['p1', 'p2', 'p3', 'p4'].map((id) => ({ property_id: id }))
  const facts = await computeFacts(base, ['sms_eligible', 'sms_status', 'sms_sort'], { query })
  for (const id of ['p1', 'p2', 'p3', 'p4']) {
    const expect = propertySmsEligibility(graph.filter((g) => g.property_id === id), id === 'p4')
    assert.equal(facts.get(id).sms_eligible, expect.eligible, id)
    assert.equal(facts.get(id).sms_status, expect.eligible ? 'eligible' : expect.reason, id)
  }
  assert.equal(facts.get('p1').sms_sort, '0')
  assert.equal(facts.get('p3').sms_status, 'not_in_campaign_audience')
  assert.equal(facts.get('p4').sms_status, 'entity_contact_requires_review')
  assert.equal(facts.get('p2').sms_sort, `1 ${facts.get('p2').sms_status}`)
})

test('keyed and sequential-scan reads give identical facts (large cohorts scan once, small ones probe)', async () => {
  const graph = [
    { property_id: 'a', queue_eligible: true, seller_person_key: 'k', canonical_e164: '+1', timezone: 'x', identity_alignment: 'probable', last_inbound_at: '2026-10-02T00:00:00Z' },
    { property_id: 'b', queue_eligible: false, queue_block_reason: 'pending_prior_touch', last_outbound_at: '2026-10-05T00:00:00Z' },
  ]
  const thread = [{ property_id: 'a', latest_message_at: '2026-10-07T00:00:00Z', latest_direction: 'outbound', seller_stage: 'ownership_check', conversation_status: 'waiting', last_outbound_at: '2026-10-07T00:00:00Z' }]
  const opp = [{ property_id: 'b', id: 'd1', acquisition_stage: 'offer_interest', opportunity_status: 'active' }]
  const cols = ['sms_status', 'last_contact_at', 'last_contact_direction', 'pipeline_stage', 'pipeline_status', 'conversation_stage', 'conversation_status']
  const base = [{ property_id: 'a' }, { property_id: 'b' }, { property_id: 'c' }]
  const keyed = await computeFacts(base, cols, { query: fakeInputs({ graph, thread, opp }), keyedMax: 10 })
  const scanned = await computeFacts(base, cols, { query: fakeInputs({ graph, thread, opp, extra: [{ property_id: 'zzz', queue_eligible: true }] }), keyedMax: 0 })
  assert.deepEqual([...scanned.entries()], [...keyed.entries()])
  const lc = latestContact({ thread: thread[0], graphRows: graph.filter((g) => g.property_id === 'a') })
  assert.equal(keyed.get('a').last_contact_at, new Date(lc.at).toISOString())
  assert.equal(keyed.get('a').last_contact_direction, 'outbound')
  assert.equal(keyed.get('b').pipeline_stage, 'offer_interest')
  assert.equal(keyed.get('a').pipeline_stage, null)
  assert.equal(keyed.get('a').conversation_stage, 'ownership_check')
})

test('equity, liens vs filings and signals use the grid functions; unknown equity is null, never 0 / 100', async () => {
  const rows = [
    { property_id: 'e1', estimated_value: 200000, total_loan_balance: 50000, property_flags_text: 'Vacant Home; Corner Lot', rec_mortgage_count: 1, rec_lien_categories: ['FINANCING STATEMENT', 'LIEN <GENERAL>'], tax_delinquent: true },
    { property_id: 'e2', estimated_value: 200000, total_loan_balance: 0, property_flags_text: '', rec_mortgage_count: null, rec_lien_categories: null },
  ]
  const f = await computeFacts(rows, ['equity_known_pct', 'equity_known_amount', 'equity_rule', 'lien_count', 'filing_count', 'lien_types', 'filing_types', 'signal_labels', 'distress_signal_count'], { query: fakeInputs({}) })
  assert.equal(f.get('e1').equity_known_pct, equityTruth(rows[0]).percent)
  assert.equal(f.get('e2').equity_known_pct, null)
  assert.equal(f.get('e2').equity_rule, 'unknown')
  assert.equal(f.get('e1').lien_count, 1)
  assert.deepEqual(f.get('e1').filing_types, ['UCC financing statement'])
  assert.equal(f.get('e2').lien_count, null, 'no record summary row = not captured, not zero')
  assert.deepEqual(f.get('e1').signal_labels, ['Vacant', 'Tax delinquent'])
  assert.equal(f.get('e1').distress_signal_count, 2)
  assert.equal(f.get('e2').distress_signal_count, null)
})

test('the server signal table is the dashboard property-signals.ts table (one signal system)', () => {
  const ts = fs.readFileSync(path.join(repo, 'apps/dashboard/src/modules/entity-graph/mobile/property-signals.ts'), 'utf8')
  const body = ts.slice(ts.indexOf('const T: Record'), ts.indexOf('/** Property facts, not signals'))
  const entries = [...body.matchAll(/^\s*(?:'([^']+)'|"([^"]+)"|([a-z-]+)):\s*\[(?:'([^']+)'|"([^"]+)"),\s*'([a-z]+)'\]/gm)]
    .map((m) => [m[1] ?? m[2] ?? m[3], [m[4] ?? m[5], m[6]]])
  assert.ok(entries.length >= 35, `parsed ${entries.length} TS entries`)
  assert.deepEqual(Object.fromEntries(entries), { ...SIGNAL_TABLE })
  const notSignals = /NOT_SIGNALS = new Set\(\[([^\]]+)\]/.exec(ts)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1))
  assert.deepEqual(notSignals.sort(), [...NOT_SIGNALS].sort())
  assert.deepEqual(propertySignalsFromRow({ property_flags_text: 'Probate; High Equity', rec_mortgage_count: 0, rec_has_probate: true }).map((s) => s.label), ['Probate', 'High equity'])
})

test('base columns are read only for the derivations a column needs', () => {
  assert.deepEqual(baseColumnsFor(['sms_sort']), ['property_id'])
  assert.ok(baseColumnsFor(['equity_known_pct']).includes('rec_mortgage_balance'))
  assert.ok(baseColumnsFor(['company_status_class']).includes('is_corporate_owner'))
  assert.ok(inputsFor(['person_age']).has('graph'))
  assert.deepEqual(widenToFamilies(['sms_sort']), ['sms_eligible', 'sms_graph_rows', 'sms_sort', 'sms_status'])
})

/* ── company registry status ──────────────────────────────────────────────── */

test('company registry status: one normalisation for the registries’ free text (prod wording)', () => {
  const cases = {
    Active: 'active', 'In Existence': 'active', Goodstanding: 'active', 'Active/Compliance': 'active', 'Current Active': 'active',
    'Active And In Good Standing': 'active', 'Restored To Good Standing': 'active', Reinstated: 'active', 'Pending Admin Dissolution': 'active',
    'Statement Of Intent To Dissolve': 'active', 'Active (Voluntary Withdrawal Pending)': 'active', 'Active   Pending Termination': 'active',
    Inactive: 'inactive', 'Suspended   Ftb': 'inactive', 'Merged Out': 'inactive', Converted: 'inactive', Delinquent: 'inactive', Ngs: 'inactive',
    'In Existence But Not In Good Standing': 'inactive', 'Active   Not In Good Standing For Failure To File': 'inactive', 'Otc Suspension': 'inactive',
    Dissolved: 'dissolved', 'Admin. Dissolved': 'dissolved', 'Voluntarily Dissolved': 'dissolved', 'Admin Diss/Cancel   Repor': 'dissolved',
    'Voluntary Diss./Terminated': 'dissolved', 'Involuntary Dissolution': 'dissolved', 'Inactive   Dissolved (Administrative)': 'dissolved',
    'Forfeited Existence': 'forfeited', Forfeited: 'forfeited', 'Forfeited   Failed To Timely File A/R': 'forfeited', Forfeiture: 'forfeited',
    Terminated: 'terminated_cancelled', Cancelled: 'terminated_cancelled', Canceled: 'terminated_cancelled', 'Term/Cancel': 'terminated_cancelled',
    Revoked: 'terminated_cancelled', 'Permanently Revoked': 'terminated_cancelled', Expired: 'terminated_cancelled', Dead: 'terminated_cancelled',
    'Inactive   Revoked (Administrative)': 'terminated_cancelled', Void: 'terminated_cancelled',
    Withdrawn: 'withdrawn', 'Withdrawn By Merger': 'withdrawn', 'Inactive   Withdrawn   Consolidated Inactive': 'withdrawn',
    Reservation: 'unknown', 'Used Name Reservation': 'unknown', Multiple: 'unknown', '1': 'unknown', X: 'unknown', 'rauls logistics \\l l c\\': 'unknown',
  }
  for (const [raw, cls] of Object.entries(cases)) assert.equal(classifyCompanyStatus({ current_status: raw }).class, cls, raw)
  // the registry's words win over its flag; the flag / dissolution date decide only for blank or unrecognised text
  assert.equal(classifyCompanyStatus({ current_status: 'Active And In Good Standing', inactive: true, dissolution_date: '2020-01-01' }).class, 'active')
  assert.equal(classifyCompanyStatus({ current_status: '', inactive: true, dissolution_date: '2020-01-01' }).class, 'dissolved')
  assert.equal(classifyCompanyStatus({ current_status: '  ', inactive: true }).class, 'inactive')
  assert.equal(classifyCompanyStatus({ current_status: 'Sop', inactive: false }).class, 'unknown')
  assert.equal(classifyCompanyStatus({ current_status: 'County Orphan', inactive: true }).class, 'inactive')
  assert.equal(classifyCompanyStatus({ current_status: 'Admin. Dissolved' }).raw, 'Admin. Dissolved', 'the raw wording is the reason')
  for (const c of Object.values(cases)) assert.ok(COMPANY_STATUS_CLASSES.includes(c))
})

test('property company status: individual owners are not a company; a name with no registry record is unknown', () => {
  assert.deepEqual(propertyCompanyStatus(null, { corporate: false }), { class: 'not_a_company', raw: null, registryMatch: 'individual', name: null })
  assert.equal(propertyCompanyStatus(null, { corporate: true }).class, 'unknown')
  assert.equal(propertyCompanyStatus({ owning_entity_id: 'name_only', owning_entity_name: 'ACME LLC' }).registryMatch, 'name_only')
  const m = propertyCompanyStatus({ owning_entity_id: '1151411:us_nc', company_number: '1151411', current_status: 'Admin. Dissolved', inactive: true })
  assert.equal(m.class, 'dissolved')
  assert.equal(m.registryMatch, 'matched')
})

/* ── generated migration ─────────────────────────────────────────────────── */

test('the committed PROPOSED migration, rollback and pretest are exactly the generator output', () => {
  const dir = path.join(repo, 'supabase/migrations')
  assert.equal(fs.readFileSync(path.join(dir, 'PROPOSED_20261009180000_eg_property_facts.sql'), 'utf8'), generateFactsMigrationSql())
  assert.equal(fs.readFileSync(path.join(dir, 'PROPOSED_20261009180000_eg_property_facts_rollback.sql'), 'utf8'), generateFactsRollbackSql())
  assert.equal(fs.readFileSync(path.join(dir, 'PROPOSED_20261009180000_eg_property_facts_pretest.sql'), 'utf8'), generateFactsPretestSql())
  const sql = generateFactsMigrationSql()
  assert.match(sql, /^-- PROPOSED — NOT APPLIED/)
  assert.match(sql, /revoke all on public\.eg_property_facts from anon, authenticated/)
  for (const c of FACTS_SORT_INDEXES) assert.match(sql, new RegExp(`\\("${c}", "property_id"\\)`))
  assert.match(generateFactsPretestSql(), /\nrollback;\n$/)
})

test('every property filter field and every composition column exists on the facts table (column contract)', () => {
  const cols = new Set(factsTableColumns().map((c) => c.col))
  for (const f of getEntityGraphFilterFields('properties')) {
    if (f.derived === 'known_equity' || f.derived === 'tax_delinquent_any') continue // compile to other columns, checked below
    assert.ok(cols.has(f.source_column), `${f.key} → ${f.source_column} on eg_property_facts`)
  }
  for (const c of ['equity_percent', 'total_loan_balance', 'estimated_value', 'property_flags_text', 'rec_mortgage_count', 'tax_delinquent', 'rec_lien_categories']) assert.ok(cols.has(c), c)
})

/* ── header filter → AST → SQL ───────────────────────────────────────────── */

test('a header filter is an ordinary chip: catalog field first, fact field otherwise; same recorder compiles it', () => {
  assert.equal(headerFieldFor('year_built').key, 'properties.year_built')
  assert.equal(headerFieldFor('rec_mortgage_count').key, 'records.mortgage_count')
  assert.equal(headerFieldFor('sms_status').key, 'facts.sms_status')
  assert.equal(headerFieldFor('company_status_class').key, 'facts.company_status_class')
  const chips = [
    { field_key: 'facts.sms_status', operator: 'is_any_of', value: ['eligible', 'missing_phone'] },
    { field_key: 'facts.company_status_class', operator: 'is_any_of', value: ['dissolved'] },
    { field_key: 'facts.last_contact_at', operator: 'between', value: ['2026-09-01', '2026-10-01'] },
    { field_key: 'facts.signal_labels', operator: 'is_any_of', value: ['Probate'] },
    { field_key: 'properties.year_built', operator: 'between', value: [1950, 1980] },
  ]
  // PostgREST consumers refuse computed facts (fail closed), the facts path accepts them
  const refused = resolveEntityGraphFieldFilters('properties', chips)
  assert.deepEqual(refused.unsupported.map((u) => u.reason), ['fact_filter_needs_facts_path', 'fact_filter_needs_facts_path', 'fact_filter_needs_facts_path', 'fact_filter_needs_facts_path'])
  const { resolved, unsupported } = resolveEntityGraphFieldFilters('properties', chips, { allowComputedFacts: true })
  assert.deepEqual(unsupported, [])
  assert.deepEqual(resolved.map(isComputedFactFilter), [true, true, true, true, false])
  const filters = parseBrowseFilters({ market: 'Atlanta' })
  const compiled = compileFacetWhere((b) => applyEntityGraphFieldFilters(applyPropertyFilters(b, filters), resolved))
  assert.match(compiled.where, /"sms_status" = any\(\$\d+\)/)
  assert.match(compiled.where, /"company_status_class" = any\(\$\d+\)/)
  assert.match(compiled.where, /"last_contact_at" >= \$\d+/)
  assert.match(compiled.where, /"signal_labels" && \$\d+::text\[\]/)
  assert.match(compiled.where, /"year_built" >= \$\d+::numeric/)
  // computed-fact clauses split from plain clauses, parameters renumbered and carried
  const factCols = new Set(['sms_status', 'company_status_class', 'last_contact_at', 'signal_labels'])
  const plain = selectClauses(compiled, (cols) => ![...cols].some((c) => factCols.has(c)))
  const fact = selectClauses(compiled, (cols) => [...cols].some((c) => factCols.has(c)), 1)
  assert.doesNotMatch(plain.sql, /sms_status|company_status_class|signal_labels/)
  assert.match(plain.sql, /"market" ilike \$\d+/)
  assert.match(fact.sql, /^"sms_status" = any\(\$2\)/)
  assert.deepEqual(fact.params[0], ['eligible', 'missing_phone'])
  assert.equal(fact.params.length, 5)
  const used = [...fact.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))
  assert.equal(Math.min(...used), 2)
  assert.equal(Math.max(...used), 1 + fact.params.length)
})

test('every property grid column key the dashboard can sort is on the facts relation', () => {
  for (const col of ['sms_sort', 'last_contact_at', 'pipeline_stage', 'company_status_class', 'zoning', 'legal_description', 'rec_first_lender', 'owner_markets_text', 'scores_aos_score', 'zip_median_price', 'person_language_preference']) {
    assert.ok(factsColumnSupported(col), col)
  }
  assert.equal(factsColumnSupported('estimated_repair_cost'), false, 'the vendor repair estimate is never a sort')
  for (const key of ENTITY_GRAPH_WITHHELD_FIELDS) {
    if (key.startsWith('properties.')) assert.ok(WITHHELD_FACT_COLUMNS.has(key.slice('properties.'.length)), `${key} withheld from facts`)
  }
})

/* ── live order + paging ─────────────────────────────────────────────────── */

test('live sort: whole cohort ordered by db-ranked values, nulls last by property_id, pages continue exactly; ids then rows by id', async () => {
  __factsListCacheTest.reset()
  __factsUniverseMemoTest.reset()
  const ids = Array.from({ length: 23 }, (_, i) => `p${String(i).padStart(3, '0')}`)
  const statuses = ['eligible', 'missing_phone', null, 'pending_prior_touch']
  const graph = ids.flatMap((id, i) => {
    const s = statuses[i % 4]
    if (s === null) return []
    if (s === 'eligible') return [{ property_id: id, queue_eligible: true, seller_person_key: 'k', canonical_e164: '+1', timezone: 'x', identity_alignment: 'verified' }]
    return [{ property_id: id, queue_eligible: false, queue_block_reason: s }]
  })
  const query = fakeInputs({ graph, cohort: ids.map((id) => ({ property_id: id })) })
  const deps = { query, factsState: async () => ({ mode: 'live' }), entityRoleMode: 'off' }
  const apply = (b) => applyPropertyFilters(b, parseBrowseFilters({}))
  const expected = await computeFacts(ids.map((id) => ({ property_id: id })), ['sms_sort'], { query })
  const order = [...expected.entries()].sort((a, b) => (a[1].sms_sort < b[1].sms_sort ? -1 : a[1].sms_sort > b[1].sms_sort ? 1 : a[0] < b[0] ? -1 : 1)).map(([id]) => id)
  const walked = []
  let after = null
  for (let n = 0; n < 10; n += 1) {
    const page = await factsSortedPage({ sortBy: 'sms_sort', ascending: true, applyFilters: apply, after, pageSize: 5, deps })
    assert.equal(page.total, 23)
    assert.equal(page.mode, 'live')
    walked.push(...page.ids)
    after = page.nextAfter
    if (!page.hasMore) break
    assert.equal(decodeFactsAfter(after).m, 'live')
  }
  assert.deepEqual(walked, order)
  // descending: values reversed, ties by property_id descending — never a partial order
  const desc = await factsSortedPage({ sortBy: 'sms_sort', ascending: false, applyFilters: apply, pageSize: 50, deps })
  const expDesc = [...expected.entries()].sort((a, b) => (a[1].sms_sort > b[1].sms_sort ? -1 : a[1].sms_sort < b[1].sms_sort ? 1 : a[0] > b[0] ? -1 : 1)).map(([id]) => id)
  assert.deepEqual(desc.ids, expDesc)
})

test('browse routes an unindexed / computed sort through the facts path and keeps the order when reading rows by id', async () => {
  __factsListCacheTest.reset()
  const ids = ['p3', 'p1', 'p2']
  const factsDeps = {
    factsState: async () => ({ mode: 'table', asOf: '2026-10-09T09:31:00.000Z' }),
    query: async (sql) => {
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: 3 }] }
      if (/from public\.eg_property_facts/.test(sql) && /is not null/.test(sql) && !/is null and/.test(sql)) return { rows: ids.map((id, i) => ({ property_id: id, k: `1 r${i}` })) }
      return { rows: [] }
    },
  }
  const supabase = rowsClient(['p1', 'p2', 'p3'].map((id) => ({ property_id: id, property_address_full: `${id} Main St, Atlanta, GA 30301` })))
  const res = await browseEntityGraph({ tab: 'properties', sort_by: 'sms_sort', ascending: '1', page_size: '25' }, { supabase, propertySortIndexes: async () => new Set(), factsDeps, factsEnabled: () => true })
  assert.deepEqual(res.results.map((r) => r.entityId), ids)
  assert.equal(res.pagination.sort.mode, 'facts_table')
  assert.equal(res.pagination.sort.sortApplied, true)
  assert.equal(res.pagination.sort.asOf, '2026-10-09T09:31:00.000Z')
  assert.equal(res.pagination.total, 3)
})

test('a computed-fact filter without a facts path fails closed (422), never an unfiltered page', async () => {
  const supabase = rowsClient([])
  await assert.rejects(
    browseEntityGraph({ tab: 'properties', field_filters: JSON.stringify([{ field_key: 'facts.sms_eligible', operator: 'is_true' }]) }, { supabase, propertySortIndexes: async () => new Set(), factsEnabled: () => false }),
    (e) => e.code === 'unsupported_entity_graph_filters' && e.unsupported_filters[0].reason === 'fact_filter_needs_facts_path',
  )
})

/* ── fakes ──────────────────────────────────────────────────────────────── */

/**
 * A direct-PG fake for the fact inputs. Answers keyed (`= any($1)`) and
 * sequential-scan (`where true`) forms; for the live relation it implements
 * the two statements the live path runs (the cohort read and the value rank).
 */
function fakeInputs({ graph = [], review = [], thread = [], opp = [], cohort = null, extra = [] } = {}) {
  const keyedOrAll = (rows, params, key = 'property_id') => (params && params[0] && Array.isArray(params[0]) ? rows.filter((r) => params[0].includes(r[key])) : rows)
  return async (sql, params = []) => {
    if (/from public\.campaign_target_graph/.test(sql)) return { rows: keyedOrAll([...graph, ...extra], params) }
    if (/from seller\.property_entity_contact_v1 ec\s+where/.test(sql) && /requires_review/.test(sql)) return { rows: keyedOrAll(review, params) }
    if (/from public\.inbox_thread_state/.test(sql)) return { rows: keyedOrAll(thread, params) }
    if (/from public\.acquisition_opportunities/.test(sql)) return { rows: keyedOrAll(opp, params) }
    if (/from public\.v_entity_graph_properties/.test(sql)) return { rows: cohort ? cohort.map((r) => ({ ...r })) : [] }
    if (/row_number\(\) over \(order by d\.v asc\)/.test(sql)) {
      // the database ranks the distinct values (text: plain ordering in this fake)
      const vals = [...new Set(params[0])].sort()
      return { rows: vals.map((v, i) => ({ v, r: i + 1 })) }
    }
    if (/select x as raw/.test(sql)) return { rows: params[0].map((x) => ({ raw: x, v: x })) }
    return { rows: [] }
  }
}

/** PostgREST-ish fake: `.in('property_id', ids)` reads on the browse view. */
function rowsClient(rows) {
  const from = () => {
    const st = { ids: null }
    const b = {
      select: () => b,
      in: (col, ids) => { st.ids = ids; return b },
      not: () => b,
      or: () => b,
      eq: () => b,
      order: () => b,
      range: () => b,
      limit: () => b,
      then: (res, rej) => Promise.resolve({ data: rows.filter((r) => !st.ids || st.ids.includes(r.property_id)), error: null, count: rows.length }).then(res, rej),
    }
    return b
  }
  return { from }
}

test('every dashboard property column sorts / filters on a column the facts relation carries (reads the TS registry)', () => {
  const ts = fs.readFileSync(path.join(repo, 'apps/dashboard/src/modules/entity-graph/mobile/entity-graph-table-columns.ts'), 'utf8')
  const map = ts.slice(ts.indexOf('export const PROPERTY_COLUMN_FACTS'), ts.indexOf('for (const c of SCOPE_TABLE_COLUMNS.properties)'))
  const hand = [...map.matchAll(/sortBy: '([a-z0-9_]+)'(?:, filterColumn: '([a-z0-9_]+)')?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean)
  assert.ok(hand.length >= 25, `parsed ${hand.length} hand-built column keys`)
  const extras = ts.slice(ts.indexOf('const EXTRA_PROPERTY_COLUMNS: Extra[] = ['), ts.indexOf('// recorded_mortgage_balance is excluded'))
  const extraCols = [...extras.matchAll(/\{ key: '([a-z0-9_.]+)'[^}]*?(vendorEquity: true)?[^}]*\}/g)].map((m) => {
    const key = m[1]
    if (m[2]) return key === 'equity_amount' ? 'equity_known_amount' : 'equity_known_pct'
    return key.startsWith('fact.') ? key.slice(5) : key.replace('.', '_')
  })
  assert.ok(extraCols.length >= 150, `parsed ${extraCols.length} picker columns`)
  const missing = [...new Set([...hand, ...extraCols])].filter((c) => c !== 'property_id' && !factsColumnSupported(c))
  assert.deepEqual(missing, [], `columns the facts relation cannot sort / filter: ${missing.join(', ')}`)
})
