// READ-ONLY fixture extractor for Entity Graph captures.
//
// Runs the REAL Entity Graph services (browse, search, counts, KPIs, composition,
// filter catalog, columns, network) against production through ONE read-only
// Postgres connection: a minimal supabase-js stand-in translates each builder
// chain (select / filters / order / range / count / rpc) to parameterised SQL —
// the filter predicates reuse the facet recorder, so they are the same
// translation the grouped facets run. Every statement runs inside BEGIN READ
// ONLY with SET LOCAL statement_timeout ≤ 30 s. Nothing is written.
//
// Usage (from apps/api):
//   node --import ./tests/alias-loader-register.mjs scripts/entity-graph-fixtures.mjs <out.json> <urls.json>
//   urls.json = ["/api/cockpit/entity-graph/counts", "/api/cockpit/entity-graph/browse?tab=properties&…", …]
// Output: { "<path>?<sorted query>": <response body> } — labelled fixtures for the
// capture server, which answers only GETs it finds here.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const url = readFileSync('/tmp/.dburl', 'utf8').trim()
process.env.SUPABASE_URL ||= 'http://127.0.0.1:1'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'harness'
// The services' direct pool (grouped facets, keyset sort) reads through the same URL, read-only.
process.env.DATABASE_URL = url
process.env.PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=30000'

const pg = createRequire(import.meta.url)('pg')
// PostgREST's JSON shapes: numeric/bigint as numbers, dates/timestamps as text.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)))
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)))
for (const oid of [1082, 1114, 1184]) pg.types.setTypeParser(oid, (v) => v)
const pool = new pg.Pool({ connectionString: url, ssl: url.includes('localhost') ? false : { rejectUnauthorized: false }, max: 2 })
const query = async (sql, params = []) => {
  const c = await pool.connect()
  try {
    await c.query('BEGIN READ ONLY')
    await c.query('SET LOCAL statement_timeout = 30000')
    const r = await c.query(sql, params)
    await c.query('COMMIT')
    return r
  } catch (e) {
    try { await c.query('ROLLBACK') } catch { /* ignore */ }
    throw e
  } finally {
    c.release()
  }
}

const { createSqlRecorder } = await import('../src/lib/domain/entity-graph/entity-graph-facet-sql.js')
const IDENT = /^[a-z_][a-z0-9_]*$/
const q = (c) => { if (!IDENT.test(c)) throw new Error(`shim: unsafe identifier ${c}`); return `"${c}"` }

function from(table) {
  const rec = createSqlRecorder()
  const state = { cols: '*', count: null, head: false, order: [], from: null, to: null, limit: null, single: null }
  const chain = new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return (res, rej) => run().then(res, rej)
      if (prop === 'select') return (cols = '*', opts = {}) => {
        const list = String(cols).split(',').map((s) => s.trim()).filter(Boolean)
        for (const c of list) if (c !== '*' && !IDENT.test(c)) throw new Error(`shim: select syntax ${c}`)
        state.cols = list.length && !list.includes('*') ? list.map(q).join(', ') : '*'
        state.count = opts.count || null
        state.head = Boolean(opts.head)
        return chain
      }
      if (prop === 'order') return (col, opts = {}) => { state.order.push(`${q(col)} ${opts.ascending === false ? 'desc' : 'asc'} nulls ${opts.nullsFirst ? 'first' : 'last'}`); return chain }
      if (prop === 'range') return (a, b) => { state.from = a; state.to = b; return chain }
      if (prop === 'limit') return (n) => { state.limit = n; return chain }
      if (prop === 'maybeSingle' || prop === 'single') return () => { state.single = prop; return chain }
      if (prop === 'abortSignal') return () => chain
      const fn = rec.builder[prop]
      if (!fn) throw new Error(`shim: unsupported builder method ${String(prop)}`)
      return (...args) => { fn(...args); return chain }
    },
  })
  async function run() {
    try {
      const where = rec.clauses.length ? `where ${rec.clauses.join(' and ')}` : ''
      const src = `public.${q(table)}`
      let count = null
      if (state.count) count = Number((await query(`select count(*)::bigint as n from ${src} ${where}`, rec.params)).rows[0].n)
      if (state.head) return { data: null, count, error: null }
      const order = state.order.length ? `order by ${state.order.join(', ')}` : ''
      const lim = state.from !== null ? `limit ${Math.trunc(state.to - state.from + 1)} offset ${Math.trunc(state.from)}` : state.limit !== null ? `limit ${Math.trunc(state.limit)}` : ''
      const rows = (await query(`select ${state.cols} from ${src} ${where} ${order} ${lim}`, rec.params)).rows
      if (state.single) {
        if (state.single === 'single' && rows.length !== 1) return { data: null, count, error: { message: 'not single' } }
        return { data: rows[0] ?? null, count, error: null }
      }
      return { data: rows, count, error: null }
    } catch (error) {
      return { data: null, count: null, error: { message: error.message } }
    }
  }
  return chain
}

async function rpc(name, args = {}) {
  try {
    if (!IDENT.test(name)) throw new Error('shim: unsafe rpc')
    const keys = Object.keys(args)
    for (const k of keys) if (!IDENT.test(k)) throw new Error('shim: unsafe rpc arg')
    const r = await query(`select * from public.${q(name)}(${keys.map((k, i) => `${q(k)} => $${i + 1}`).join(', ')})`, keys.map((k) => args[k]))
    if (r.fields.length === 1 && r.fields[0].name === name) return { data: r.rows[0]?.[name] ?? null, error: null }
    return { data: r.rows, error: null }
  } catch (error) {
    return { data: null, error: { message: error.message } }
  }
}

const supabase = { from, rpc, schema: () => ({ from, rpc }) }
const deps = { supabase }

const svc = await import('../src/lib/domain/entity-graph/entity-graph-service.js')
const comp = await import('../src/lib/domain/entity-graph/entity-graph-composition.js')
const kpis = await import('../src/lib/domain/entity-graph/entity-graph-kpis.js')
const ff = await import('../src/lib/domain/entity-graph/entity-graph-field-filters.js')
const cols = await import('../src/lib/domain/entity-graph/entity-graph-column-enrichment.js')
const net = await import('../src/lib/domain/entity-graph/entity-network-service.js')

const BASE = '/api/cockpit/entity-graph'
async function answer(path, params) {
  const sub = path.slice(BASE.length)
  if (sub === '/counts') return { ok: true, counts: await svc.getEntityGraphCounts(deps) }
  if (sub === '/kpis') return { ok: true, kpis: await kpis.getEntityGraphKpis(deps) }
  if (sub === '/browse') return { ok: true, ...(await svc.browseEntityGraph(params, deps)) }
  if (sub === '/search') return { ok: true, ...(await svc.searchEntityGraph(params, deps)) }
  if (sub === '/composition') {
    if (params.catalog) return { ok: true, ...comp.getCompositionCatalog(params.tab || 'properties') }
    return { ok: true, composition: await comp.buildEntityGraphComposition(params, deps) }
  }
  if (sub === '/filter-catalog') {
    const catalog = ff.getEntityGraphFilterCatalog((params.tab || 'properties').toLowerCase())
    return catalog.source ? { ok: true, ...catalog, filterable_tabs: ff.ENTITY_GRAPH_FILTERABLE_TABS } : { ok: false, error: 'tab_does_not_support_field_filters' }
  }
  if (sub === '/columns') return { ok: true, ...(await cols.getEntityGraphColumnEnrichment(params, deps)) }
  if (sub === '/networks') return { ok: true, data: await net.getTopEntityNetworks({ limit: Number(params.limit) || 16, market: params.market || '' }, deps) }
  const m = /^\/network\/(property|owner|person)\/(.+)$/.exec(sub)
  if (m) {
    const data = await net.getEntityNetwork(m[1], decodeURIComponent(m[2]), deps)
    return data ? { ok: true, data } : { ok: false, error: 'entity_not_found' }
  }
  return null
}

export const fixtureKey = (u) => {
  const parsed = new URL(u, 'http://x')
  const qs = new URLSearchParams()
  for (const k of [...new Set([...parsed.searchParams.keys()])].sort()) qs.set(k, parsed.searchParams.get(k))
  const s = qs.toString()
  return s ? `${parsed.pathname}?${s}` : parsed.pathname
}

const [out, urlFile] = process.argv.slice(2)
const urls = JSON.parse(readFileSync(urlFile, 'utf8'))
let prev = {}
try { prev = JSON.parse(readFileSync(out, 'utf8')) } catch { /* new */ }
const res = { ...prev }
for (const u of urls) {
  const key = fixtureKey(u)
  if (key in res && !process.env.REFRESH) continue
  const parsed = new URL(u, 'http://x')
  const t0 = performance.now()
  try {
    const body = await answer(parsed.pathname, Object.fromEntries(parsed.searchParams))
    if (!body) { console.log(`skip (no handler) ${key}`); continue }
    res[key] = body
    console.log(`${(performance.now() - t0).toFixed(0).padStart(6)} ms ok=${body.ok} ${key.slice(0, 140)}`)
  } catch (error) {
    console.log(`FAIL ${key.slice(0, 140)} ${error.message}`)
  }
}
writeFileSync(out, JSON.stringify(res))
await pool.end()
process.exit(0)
