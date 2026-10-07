// READ-ONLY fixture extractor for Market Intelligence captures. Runs the real MI service in SUMMARY
// mode (production read path) against prod with one read-only connection (BEGIN READ ONLY +
// SET LOCAL statement_timeout ≤ 30 s). Writes { "<op=…&…>": responseBody } so a capture server can
// stub GET /api/cockpit/market-intel without touching the database. Run in a quiet window.
// Usage (from apps/api):
//   node --import ./tests/alias-loader-register.mjs scripts/market-intel-fixtures.mjs <out.json> <requests.json>
//   requests.json = [{ "op": "dossier", "id": "nation:US", ... }, …]  (string params, as the UI sends)
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
process.env.SUPABASE_URL ||= 'http://127.0.0.1:1'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'harness'
const pg = createRequire(import.meta.url)('pg')
const url = readFileSync('/tmp/.dburl', 'utf8').trim()
const pool = new pg.Pool({ connectionString: url, ssl: url.includes('localhost') ? false : { rejectUnauthorized: false }, max: 1 })
pool.on('connect', (c) => { c.query('SET default_transaction_read_only = on').catch(() => {}) })
const query = async (sql, params = [], timeoutMs = 30_000) => {
  const c = await pool.connect()
  try { await c.query('BEGIN READ ONLY'); await c.query(`SET LOCAL statement_timeout = ${Math.min(30_000, Math.trunc(timeoutMs))}`); const r = await c.query(sql, params); await c.query('COMMIT'); return r }
  catch (e) { try { await c.query('ROLLBACK') } catch {} throw e } finally { c.release() }
}
// The boundary reader's RPC, answered by the same SQL function over the read-only connection.
const rpcSupabase = {
  rpc: async (name, a) => {
    if (name !== 'map_boundaries_in_bbox') return { error: { code: 'PGRST202', message: 'could not find the function' }, status: 404 }
    try {
      const r = await query('select * from public.map_boundaries_in_bbox($1, $2, $3, $4, $5, $6)', [a.p_level, a.p_min_lng, a.p_min_lat, a.p_max_lng, a.p_max_lat, a.p_tolerance], 20_000)
      return { data: r.rows }
    } catch (e) { return { error: { message: e.message } } }
  },
}
const { createMarketIntelLoader } = await import('../src/lib/domain/market-intelligence/mi-loader.js')
const { createMarketIntelService } = await import('../src/lib/domain/market-intelligence/mi-service.js')
const { createMapBoundaryReader } = await import('../src/lib/domain/map/map-boundaries-service.js')
const boundaryReader = createMapBoundaryReader({ supabase: rpcSupabase })
const loader = createMarketIntelLoader({ query, connect: () => pool.connect() })
const svc = createMarketIntelService({ loader, query, warmWaitMs: 120_000, universeWaitMs: 25_000, readBoundaries: boundaryReader.read, prewarm: false, env: { NODE_ENV: 'production' } })
const [out, reqFile] = process.argv.slice(2)
const reqs = JSON.parse(readFileSync(reqFile, 'utf8'))
const keyOf = (p) => { const q = new URLSearchParams(); for (const k of Object.keys(p).sort()) q.set(k, String(p[k])); return q.toString() }
let prev = {}
try { prev = JSON.parse(readFileSync(out, 'utf8')) } catch { /* new file */ }
const res = { ...prev }
const act = await query(`select count(*) filter (where state='active' and backend_type='client backend')::int a from pg_stat_activity`)
console.log('active sessions before:', act.rows[0].a)
for (const p of reqs) {
  const { op, ...rest } = p
  const t0 = performance.now()
  const r = await svc.run(op, rest)
  const ms = performance.now() - t0
  res[keyOf(p)] = r
  console.log(`${keyOf(p).slice(0, 110).padEnd(110)} ${ms.toFixed(0).padStart(6)} ms ok=${r.ok}${r.status && typeof r.status === 'string' ? ` ${r.status}` : ''}${r.error ? ` ${r.error} ${r.message ?? ''}` : ''}`)
}
writeFileSync(out, JSON.stringify(res))
await pool.end()
