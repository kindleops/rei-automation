#!/usr/bin/env node
/**
 * Entity Graph property facts — READ-ONLY prod parity + timing probe.
 * Run from apps/api (statement_timeout 30 s, default_transaction_read_only on):
 *   node --import ./tests/register-aliases.mjs ../../scripts/entity-graph/facts-parity-probe.mjs
 * DATABASE_URL comes from /tmp/.dburl and is never printed. No names / phones are printed:
 * ids are compared as sets / sequences and only counts and timings are reported.
 *
 * Checks (interim LIVE mode; TABLE mode runs the same assertions once the read model exists):
 *   1. sort parity      whole-cohort order (db-ranked values + JS placement) == SQL ORDER BY over the same values
 *   2. paging           walking every page via nextAfter == the one-shot order (no gaps, no repeats)
 *   3. counts           header value counts sum to the cohort total; facts total == SQL count of the same WHERE
 *   4. read strategies  keyed (small cohort) facts == universe-memo facts for the same ids
 *   5. timings          first sort / page 2 / header values, cold process
 */
import fs from 'node:fs'

process.env.DATABASE_URL = process.env.DATABASE_URL || fs.readFileSync('/tmp/.dburl', 'utf8').trim()
const { getPgPool, queryWithTimeout } = await import('@/lib/postgres/client.js')
const pool = getPgPool()
pool.on('connect', (c) => { c.query("set default_transaction_read_only = on; set statement_timeout = '30s'") })
const facts = await import('@/lib/domain/entity-graph/entity-graph-facts-query.js')
const { computeFacts, baseColumnsFor } = await import('@/lib/domain/entity-graph/entity-graph-facts.js')
const { applyPropertyFilters, parseBrowseFilters } = await import('@/lib/domain/entity-graph/entity-graph-service.js')
const { applyEntityGraphFieldFilters, resolveEntityGraphFieldFilters } = await import('@/lib/domain/entity-graph/entity-graph-field-filters.js')

const deps = { entityRoleMode: 'off' }
const apply = (params, ff = []) => {
  const filters = parseBrowseFilters(params)
  const { resolved, unsupported } = resolveEntityGraphFieldFilters('properties', ff, { allowComputedFacts: true })
  if (unsupported.length) throw new Error(`unsupported ${JSON.stringify(unsupported)}`)
  return (b) => applyEntityGraphFieldFilters(applyPropertyFilters(b, filters), resolved)
}
const q = (c) => `"${c}"`
const orderSql = (col, asc) => `(f.${q(col)} is null), f.${q(col)} ${asc ? 'asc' : 'desc'}, case when f.${q(col)} is null then f."property_id" end asc, case when f.${q(col)} is not null then f."property_id" end ${asc ? 'asc' : 'desc'}`
const out = { ranAt: new Date().toISOString(), mode: null, cases: [] }

const CASES = [
  { label: 'Atlanta · SMS eligible ↑', params: { market: 'Atlanta' }, sort: 'sms_sort', asc: true },
  { label: 'Atlanta · last contact ↓', params: { market: 'Atlanta' }, sort: 'last_contact_at', asc: false },
  { label: 'Atlanta · company status ↑', params: { market: 'Atlanta' }, sort: 'company_status_class', asc: true },
  { label: 'Atlanta · zoning ↑ (plain, unindexed)', params: { market: 'Atlanta' }, sort: 'zoning', asc: true },
  { label: 'Atlanta + SMS eligible = yes · value ↓', params: { market: 'Atlanta' }, ff: [{ field_key: 'facts.sms_eligible', operator: 'is_true' }], sort: 'estimated_value', asc: false },
  { label: 'universe · SMS eligible ↓', params: {}, sort: 'sms_sort', asc: false },
]

for (const c of CASES) {
  facts.__factsListCacheTest.reset()
  const row = { label: c.label }
  try {
    const t0 = Date.now()
    const first = await facts.factsSortedPage({ sortBy: c.sort, ascending: c.asc, applyFilters: apply(c.params, c.ff), pageSize: 60, deps })
    row.firstSortMs = Date.now() - t0
    out.mode = first.mode
    row.total = first.total
    row.source = first.source
    const t1 = Date.now()
    const second = first.nextAfter ? await facts.factsSortedPage({ sortBy: c.sort, ascending: c.asc, applyFilters: apply(c.params, c.ff), after: first.nextAfter, pageSize: 60, deps }) : null
    row.page2Ms = Date.now() - t1
    // 2. paging: walk up to 20 pages
    const walked = [...first.ids, ...(second?.ids || [])]
    let after = second?.nextAfter || null
    for (let i = 0; i < 18 && after; i += 1) {
      const p = await facts.factsSortedPage({ sortBy: c.sort, ascending: c.asc, applyFilters: apply(c.params, c.ff), after, pageSize: 60, deps })
      walked.push(...p.ids)
      after = p.nextAfter
    }
    const full = await facts.factsSortedPage({ sortBy: c.sort, ascending: c.asc, applyFilters: apply(c.params, c.ff), pageSize: 250_000, deps })
    row.pagingIdentical = JSON.stringify(walked) === JSON.stringify(full.ids.slice(0, walked.length))
    row.noRepeats = new Set(full.ids).size === full.ids.length
    // 1. sort parity: the same values ordered by SQL ORDER BY
    const rel = await facts.factsCohortRelation({ applyFilters: apply(c.params, c.ff), columns: c.sort === 'property_id' ? [] : [c.sort], deps })
    const sqlOrder = await queryWithTimeout(`select f."property_id" from ${rel.from} ${rel.where} order by ${orderSql(c.sort, c.asc)}`, rel.params, 30_000)
    const sqlIds = sqlOrder.rows.map((r) => String(r.property_id))
    row.sortParityWithSqlOrderBy = JSON.stringify(sqlIds) === JSON.stringify(full.ids)
    if (!row.sortParityWithSqlOrderBy) {
      const firstDiff = sqlIds.findIndex((id, i) => id !== full.ids[i])
      row.firstDiffAt = firstDiff
    }
    // 3. counts: SQL count of the same WHERE, and header value counts sum to the total
    const counted = await queryWithTimeout(`select count(*)::bigint n from ${rel.from} ${rel.where}`, rel.params, 30_000)
    row.countMatches = Number(counted.rows[0].n) === full.total
    const t2 = Date.now()
    const valuesCol = c.sort === 'sms_sort' ? 'sms_status' : c.sort
    const hv = await facts.factsHeaderValues({ column: valuesCol, applyFilters: apply(c.params, c.ff), deps })
    row.headerValuesMs = Date.now() - t2
    if (hv.values) {
      row.headerValuesSumEqualsTotal = hv.values.reduce((n, v) => n + v.count, 0) === hv.total || Boolean(hv.truncated)
      row.headerTop = hv.values.slice(0, 8).map((v) => `${v.value ?? '∅'}=${v.count}`).join(' ')
    } else row.headerRange = hv.range
    row.headerTotalEqualsCohort = hv.total === full.total
  } catch (e) {
    row.error = String(e?.message || e).slice(0, 240)
  }
  out.cases.push(row)
  console.log(JSON.stringify(row))
}

// 4. read strategies: keyed (live, small cohort) vs universe memo for the same 300 ids
try {
  const sample = await queryWithTimeout(`select property_id from public.properties where property_id not like 'canaryprop%' and property_id > md5(random()::text) order by property_id limit 300`, [], 30_000)
  const ids = sample.rows.map((r) => String(r.property_id))
  const cols = ['sms_status', 'last_contact_at', 'pipeline_stage', 'conversation_stage', 'company_status_class', 'equity_known_pct', 'lien_count', 'signal_labels', 'asset_type', 'owner_display_name', 'person_age', 'contact_phone_count']
  const base = await queryWithTimeout(`select ${baseColumnsFor(cols).map(q).join(', ')} from public.v_entity_graph_properties where property_id = any($1::text[])`, [ids], 30_000)
  const keyed = await computeFacts(base.rows, cols, { query: queryWithTimeout, keyedMax: 5_000 })
  const scanned = await computeFacts(base.rows, cols, { query: queryWithTimeout, keyedMax: 0 })
  let diffs = 0
  for (const id of ids) if (JSON.stringify(keyed.get(id)) !== JSON.stringify(scanned.get(id))) diffs += 1
  out.readStrategies = { ids: ids.length, cols: cols.length, differing: diffs }
  console.log(JSON.stringify({ readStrategies: out.readStrategies }))
} catch (e) {
  console.log(JSON.stringify({ readStrategiesError: String(e?.message || e).slice(0, 240) }))
}
await pool.end()
fs.writeFileSync('/tmp/egfacts/parity-probe.json', JSON.stringify(out, null, 1))
