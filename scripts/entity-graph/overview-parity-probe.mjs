#!/usr/bin/env node
/**
 * OVERVIEW PARITY PROBE (read-only, prod). Two checks on a market slice:
 *
 *   1. every Overview bucket == an INDEPENDENT hand-written SQL count
 *      (GROUP BY for categorical values / years, plain comparisons for bands
 *      and booleans, the flag filter's own ilike patterns for tokens);
 *   2. click → filter AST round trip: adding a bucket's click filter to the
 *      cohort (the rail's AST) gives a cohort whose total == the bar's count.
 *
 * Usage (from apps/api, so '@/…' resolves):
 *   node --import ./tests/register-aliases.mjs ../scripts/entity-graph/overview-parity-probe.mjs "Dallas, TX"
 * Credential: LC_RO_ENTITY_GRAPH_DB_URL_FILE (the role-enforced read-only diagnostics credential; scripts/lib/prod-db-credentials.mjs);
 * every session is also read-only with an 8 s / 30 s timeout. Prints counts only.
 */
import { openReadOnlyPool } from '../lib/prod-db-credentials.mjs'

const { buildEntityGraphOverview, __overviewTest } = await import('@/lib/domain/entity-graph/entity-graph-overview-service.js')
const { flagTokenPatterns } = await import('@/lib/domain/entity-graph/entity-graph-field-filters.js')

const market = process.argv[2] || 'Dallas, TX'
const sections = (process.argv[3] || 'pinned,geography,property,distress,value,debt,ownership').split(',')
const pool = await openReadOnlyPool({ purpose: 'entity_graph', applicationName: 'lc-eg-overview-parity', max: 4 })
const query = async (sql, params = [], ms = 30_000) => {
  const c = await pool.connect()
  try { await c.query(`set statement_timeout = ${Math.trunc(ms)}`); return await c.query(sql, params) } finally { c.release() }
}
const deps = { query, skipSnapshot: true, timeoutMs: 30_000, fetchEntityContactReviewBlocks: async () => ({ ok: true, blocked: new Set() }) }
const marketFilter = { field_key: 'properties.market', operator: 'is_any_of', value: [market] }
const params = (extra = []) => ({ tab: 'properties', field_filters: JSON.stringify([marketFilter, ...extra]) })

const t0 = Date.now()
const overview = await buildEntityGraphOverview({ ...params(), sections: sections.join(',') }, deps)
const tOverview = Date.now() - t0

// independent SQL — hand-written, not compiled by the recorder
const BASE = `from public.v_entity_graph_properties where market = $1 and property_id not like 'canaryprop%'`
const one = async (sql, p = []) => Number((await query(`select count(*)::bigint as n ${BASE} and (${sql})`, [market, ...p])).rows[0].n)
const { rows: [{ n: total }] } = await query(`select count(*)::bigint as n ${BASE}`, [market])

let checked = 0
let mismatches = 0
const report = []
const expect = (label, got, want) => {
  checked += 1
  if (Number(got) !== Number(want)) { mismatches += 1; report.push(`MISMATCH ${label}: overview ${got} vs sql ${want}`) }
}
expect('total', overview.total, total)

const roundTrips = []
for (const section of overview.sections) {
  for (const f of section.fields) {
    if (f.unavailable || !f.buckets) continue
    if (!/^[a-z_][a-z0-9_]*$/.test(f.column || '')) continue
    const column = `"${f.column}"`
    if (f.kind === 'categorical') {
      const { rows } = await query(`select ${column}::text as k, count(*)::bigint as n ${BASE} group by 1`, [market])
      const by = new Map(rows.map((r) => [r.k, Number(r.n)]))
      for (const b of f.buckets) {
        if (b.key === '__other' || b.key === '__blank_text') continue
        expect(`${f.key}=${b.key === '__none' ? 'NULL' : '<value>'}`, b.count, b.key === '__none' ? (by.get(null) || 0) : (by.get(b.key) || 0))
      }
    } else if (f.kind === 'boolean') {
      for (const b of f.buckets) {
        if (b.key === 'yes') expect(`${f.key}=yes`, b.count, await one(`${column} is true`))
        if (b.key === 'no') expect(`${f.key}=no`, b.count, await one(`${column} is false`))
      }
    } else if (f.kind === 'numeric') {
      for (const b of f.buckets) {
        if (b.key === '__none') { expect(`${f.key}=null`, b.count, await one(`${column} is null`)); continue }
        const parts = []
        const p = []
        if (b.lo !== null && b.lo !== undefined) { p.push(b.lo); parts.push(`${column} >= $${p.length + 1}::numeric`) }
        if (b.hi !== null && b.hi !== undefined) { p.push(b.hi); parts.push(`${column} <= $${p.length + 1}::numeric`) }
        expect(`${f.key}[${b.key}]`, b.count, await one(parts.join(' and '), p))
      }
    } else if (f.kind === 'tokens') {
      for (const b of f.buckets.filter((x) => x.filter)) {
        const pats = flagTokenPatterns(b.label)
        expect(`${f.key}~token`, b.count, await one(pats.map((_, i) => `property_flags_text ilike $${i + 2}`).join(' or '), pats))
      }
    } else if (f.kind === 'date' && f.grain === 'year') {
      const { rows } = await query(`select extract(year from ${column})::int::text as k, count(*)::bigint as n ${BASE} group by 1`, [market])
      const by = new Map(rows.map((r) => [r.k, Number(r.n)]))
      for (const b of f.buckets.filter((x) => /^\d{4}$/.test(x.key))) expect(`${f.key}[${b.key}]`, b.count, by.get(b.key) || 0)
    }
    // up to two clickable buckets per field go through the click → AST → cohort round trip
    for (const b of f.buckets.filter((x) => x.filter && x.count > 0).slice(0, 2)) roundTrips.push({ key: f.key, bucket: b.key, count: b.count, filter: b.filter })
  }
}

// click → filter AST round trip (the cohort total with the chip added == the bar)
let rtChecked = 0
let rtMismatch = 0
const sample = roundTrips.filter((_, i) => i % Math.max(1, Math.floor(roundTrips.length / 40)) === 0).slice(0, 40)
for (const r of sample) {
  __overviewTest.reset()
  const o = await buildEntityGraphOverview({ ...params([r.filter]), sections: 'headline' }, { ...deps, fetchEntityContactReviewBlocks: async () => ({ ok: true, blocked: new Set() }) })
  rtChecked += 1
  if (o.total !== r.count) { rtMismatch += 1; report.push(`ROUNDTRIP ${r.key}[${r.bucket}]: bar ${r.count} vs cohort ${o.total}`) }
}

await pool.end()
console.log(JSON.stringify({
  market, relation: overview.source?.relation, sections: overview.sections.map((s) => `${s.id}:${s.fields.length}`),
  overview_ms: tOverview, total: overview.total, sql_total: Number(total),
  bucket_checks: checked, bucket_mismatches: mismatches,
  roundtrip_checks: rtChecked, roundtrip_mismatches: rtMismatch,
}, null, 1))
for (const line of report.slice(0, 40)) console.log(line)
