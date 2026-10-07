#!/usr/bin/env node
/**
 * ACQUISITION ENGINE V3 (MERGED: V3 structure + v3.1 corpus/comp rules/offer) —
 * READ-ONLY SHADOW BACKTEST.
 *
 * Two phases so the database is read ONCE and every iteration is offline:
 *   --mode=fetch  read-only: for each subject cache (gzip JSON) the subject row
 *                 (engine.loadSubjectProperty), its geography, the canonical
 *                 candidate rows (public.mv_map_market_sales 't:' rows =
 *                 comp_private.comp_canonical_transactions, the read v3.1 uses,
 *                 plus the recorded buyer name), the multi-parcel consideration
 *                 rows and the engine's buyer-demand rows strictly before the
 *                 as-of date. Same frames as the v3.1 / V3 runs.
 *   --mode=run    offline: runs the PRODUCTION calculateAcquisitionDecision with
 *                 v3Enabled=true + v3ShadowMode=true and the merged candidates,
 *                 never scoreProperty, never a persister; writes per-subject JSON.
 *
 * Safety (fetch): Supabase client behind a write guard (rpc/insert/update/upsert/
 * delete throw); SQL BEGIN READ ONLY, statement_timeout 30s, one connection,
 * pause between subjects, load back-off, --stop-at-utc window. Run under nice -n 15.
 *
 * USAGE (from apps/api):
 *   nice -n 15 node scripts/acquisition-v3-merged-shadow-backtest.mjs --mode=fetch --frame-file=<f> --kind=sfr|mf|current --cache-dir=<d> [--stop-at-utc=04:58]
 *   nice -n 15 node scripts/acquisition-v3-merged-shadow-backtest.mjs --mode=run --frame-file=<f> --kind=sfr|mf|current --cache-dir=<d> --out-dir=<o>
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'
import { gzipSync, gunzipSync } from 'node:zlib'

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(apiRoot)
// Never let a run inherit an enabled persist/auto flag from the shell.
for (const k of ['ACQUISITION_ENGINE_V3_ALLOW_PERSIST', 'ACQUISITION_ENGINE_V3_ALLOW_QUEUE_PRIORITY', 'ACQUISITION_ENGINE_V3_ALLOW_AUTO_OFFER', 'ACQUISITION_ENGINE_V3_ALLOW_AUTO_CREATIVE']) process.env[k] = 'false'
process.env.ACQUISITION_ENGINE_V3_SHADOW_MODE = 'true'
register('./tests/alias-loader.mjs', pathToFileURL(`${apiRoot}/`))

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'] }))
const MODE = args.mode ?? 'run'
const KIND = args.kind ?? 'sfr'
const CACHE = args['cache-dir']
if (!CACHE) { console.error('--cache-dir required'); process.exit(2) }
mkdirSync(CACHE, { recursive: true })

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const day = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null)
const addDays = (d, n) => { const x = new Date(`${day(d)}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x }
const monthsBefore = (d, m) => { const x = new Date(`${day(d)}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() - m); return x.toISOString().slice(0, 10) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cacheFile = (pid) => resolve(CACHE, `${pid}.json.gz`)
const wideFile = (pid) => resolve(CACHE, `${pid}.wide.json.gz`)
export const readCache = (pid) => {
  const c = JSON.parse(gunzipSync(readFileSync(cacheFile(pid))).toString('utf8'))
  if (existsSync(wideFile(pid))) c.wideRows = JSON.parse(gunzipSync(readFileSync(wideFile(pid))).toString('utf8')).rows
  return c
}

let frames
if (args['frame-file']) {
  const f = JSON.parse(readFileSync(args['frame-file'], 'utf8'))
  frames = Array.isArray(f) ? f : f.subjects
} else if (args.ids) frames = String(args.ids).split(',').map((property_id) => ({ property_id }))
else { console.error('--frame-file or --ids required'); process.exit(2) }

const engine = await import('../src/lib/acquisition/acquisitionDecisionEngine.js')
const v2 = await import('../src/lib/acquisition/shadow/currentSalesValuationV2.js')
const v31 = await import('../src/lib/acquisition/shadow/investorValuationV3.js')

// The production engine's comp gates on every candidate (radius/age come from the lane).
const ENGINE_GATE_IGNORED = new Set(['outside_radius', 'sale_too_old', 'outside_zip_without_coordinates'])
const engineGate = (subject, nowDate) => (row) => {
  const comp = engine.normalizePropertyFeatures(v2.toEngineComp(row, subject), { source: 'mv_map_market_sales', distance_miles: row.distance_miles, now: nowDate })
  return engine.evaluateCompEligibility(subject, comp, nowDate).reasons.filter((r) => !ENGINE_GATE_IGNORED.has(r))
}
const asOfFor = (frame) => (KIND === 'current' ? day(addDays(new Date(args.now ?? Date.now()), 1)) : day(frame.sold_on))

if (MODE === 'fetch' || MODE === 'fetch-wide') {
  const pg = (await import('pg')).default
  function loadEnv(p) {
    if (!existsSync(p)) return {}
    const out = {}
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (!m) continue
      let v = m[2].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      out[m[1]] = v
    }
    return out
  }
  const fileEnv = loadEnv(resolve(apiRoot, '.env.local'))
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) if (!process.env[k] && fileEnv[k]) process.env[k] = fileEnv[k]
  const DB_URL = existsSync('/tmp/.dburl') ? readFileSync('/tmp/.dburl', 'utf8').trim() : (process.env.SUPABASE_DB_URL || fileEnv.SUPABASE_DB_URL)
  if (!DB_URL) { console.error('missing database configuration'); process.exit(2) }
  const pgc = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
  await pgc.connect()
  await pgc.query("SET statement_timeout = '30s'")
  await pgc.query('SET default_transaction_read_only = on')
  // One connection, strictly serialized (the engine's loaders issue Promise.all reads).
  let chain = Promise.resolve()
  const sqlOnce = async (q, params) => {
    tally('sql')
    await pgc.query('BEGIN READ ONLY')
    try { await pgc.query("SET LOCAL statement_timeout = '30s'"); return (await pgc.query(q, params)).rows } finally { await pgc.query('ROLLBACK') }
  }
  const sql = (q, params = []) => { const p = chain.then(() => sqlOnce(q, params)); chain = p.catch(() => {}); return p }
  // Read-only PostgREST-shaped shim over the pg connection (from/select/eq/in/order/limit/
  // maybeSingle/single). Only SELECT is ever generated; it exists so the engine's own
  // loaders run unchanged without an HTTPS client.
  const quoteId = (c) => `"${String(c).trim().replace(/"/g, '')}"`
  const rawSupabase = {
    from(table) {
      const st = { cols: '*', where: [], params: [], order: [], limit: null, mode: 'many' }
      const b = {
        select(cols = '*') { st.cols = String(cols).split(',').map((c) => c.trim()).filter(Boolean).map((c) => (c === '*' ? '*' : quoteId(c))).join(', ') || '*'; return b },
        eq(c, v) { st.params.push(v); st.where.push(`${quoteId(c)} = $${st.params.length}`); return b },
        in(c, arr) { st.params.push((arr ?? []).map(String)); st.where.push(`${quoteId(c)}::text = any($${st.params.length}::text[])`); return b },
        order(c, o = {}) { st.order.push(`${quoteId(c)} ${o.ascending === false ? 'desc' : 'asc'}`); return b },
        limit(n) { st.limit = Math.max(1, Math.trunc(Number(n) || 1)); return b },
        maybeSingle() { st.mode = 'maybe'; return b },
        single() { st.mode = 'single'; return b },
        then(res, rej) {
          const q = `select ${st.cols} from public.${quoteId(table)}${st.where.length ? ` where ${st.where.join(' and ')}` : ''}${st.order.length ? ` order by ${st.order.join(', ')}` : ''}${st.limit ? ` limit ${st.limit}` : st.mode !== 'many' ? ' limit 2' : ''}`
          return sql(q, st.params).then((rows) => {
            if (st.mode === 'many') return { data: rows, error: null }
            if (st.mode === 'single' && rows.length !== 1) return { data: null, error: { message: 'single_row_expected' } }
            return { data: rows[0] ?? null, error: null }
          }, (e) => ({ data: null, error: { code: e?.code ?? null, message: String(e?.message || e) } })).then(res, rej)
        },
      }
      return b
    },
  }
  const AUDIT = { calls: {}, blocked: [] }
  const tally = (k) => { AUDIT.calls[k] = (AUDIT.calls[k] ?? 0) + 1 }
  const WRITE = new Set(['insert', 'upsert', 'update', 'delete'])
  const guardBuilder = (b, t) => new Proxy(b, { get(target, prop, recv) {
    if (WRITE.has(prop)) return () => { AUDIT.blocked.push(`${t}.${String(prop)}`); throw new Error(`read_only_guard:${t}.${String(prop)}`) }
    const v = Reflect.get(target, prop, recv); return typeof v === 'function' ? v.bind(target) : v
  } })
  const supabase = new Proxy(rawSupabase, { get(target, prop, recv) {
    if (prop === 'from') return (t) => { tally(`from:${t}`); return guardBuilder(target.from(t), t) }
    if (['rpc', 'schema', 'storage', 'functions', 'channel'].includes(prop)) return () => { AUDIT.blocked.push(String(prop)); throw new Error(`read_only_guard:${String(prop)}`) }
    const v = Reflect.get(target, prop, recv); return typeof v === 'function' ? v.bind(target) : v
  } })
  const CANON_SQL = v31.CANDIDATE_ROWS_SQL.replace('m.buyer_kind, m.doc_type', 'm.buyer_kind, m.buyer, m.doc_type')
  const CANON_MF_SQL = v31.CANDIDATE_ROWS_MF_SQL.replace('m.buyer_kind, m.doc_type', 'm.buyer_kind, m.buyer, m.doc_type')
  const SET_LEVEL = new Set([v31.V3_REASONS.outsideTopK, v31.V3_REASONS.outlierLow, v31.V3_REASONS.outlierHigh, v31.V3_REASONS.dominantOutlier])
  let done = 0
  let pauses = 0
  const { valueLaneModel, resolveSubjectLane, LANE_POLICY } = await import('../src/lib/acquisition/v3LaneValuation.js')
  const { investorSubjectFrom } = await import('../src/lib/acquisition/v3CanonicalCandidates.js')
  for (const frame of frames) {
    const pid = String(frame.property_id)
    if (MODE === 'fetch-wide') {
      // Widened-rung read only for subjects whose R1 (lane radius) fails, decided offline.
      if (!existsSync(cacheFile(pid)) || existsSync(wideFile(pid))) continue
      const c = JSON.parse(gunzipSync(readFileSync(cacheFile(pid))).toString('utf8'))
      if (c.error) continue
      const nowDate = new Date(c.now)
      const subject = engine.normalizePropertyFeatures(c.raw, { source: 'properties', now: nowDate })
      const s = investorSubjectFrom({ subject, raw: c.raw, own: c.own, neighbors: c.neighbors })
      const lm = valueLaneModel({ subject: s, raw: c.raw, rows: c.rows, bulkRows: c.bulkRows, asOf: c.as_of, gate: engineGate(subject, nowDate), env: {} })
      if (lm.rung === 'R1') continue
      const hhmm2 = new Date().toISOString().slice(11, 16)
      if (args['stop-at-utc'] && hhmm2 >= args['stop-at-utc'] && hhmm2 < (args['resume-after-utc'] ?? '09:00')) { console.error(`\n[window] stop at ${hhmm2} UTC`); break }
      const lane = resolveSubjectLane(s, c.raw).lane
      const radius = LANE_POLICY[lane].radii[LANE_POLICY[lane].radii.length - 1]
      const months = LANE_POLICY[lane].wideMonths
      try {
        const rowsW = await sql(lane === 'sfr' ? CANON_SQL : CANON_MF_SQL, [s.latitude, s.longitude, radius, monthsBefore(c.as_of, months), c.as_of, 9000])
        const inW = rowsW.filter((r) => { const d = v31.haversineMiles(s.latitude, s.longitude, num(r.lat), num(r.lng)); return d !== null && d < radius })
        writeFileSync(wideFile(pid), gzipSync(JSON.stringify({ property_id: pid, lane, radius, months, rows: inW, read_rows: rowsW.length })))
      } catch (e) { console.error(`\n[error-wide] ${pid}: ${String(e?.message || e).slice(0, 160)}`) }
      done += 1
      process.stdout.write('w')
      await sleep(Number(args['pause-ms'] ?? 250))
      continue
    }
    if (existsSync(cacheFile(pid))) { done += 1; continue }
    const hhmm = new Date().toISOString().slice(11, 16)
    if (args['stop-at-utc'] && hhmm >= args['stop-at-utc'] && hhmm < (args['resume-after-utc'] ?? '09:00')) { console.error(`\n[window] stop at ${hhmm} UTC; resume later`); break }
    if (done % 5 === 0) {
      let [load] = await sql(`select count(*) filter (where state = 'active' and backend_type = 'client backend' and pid <> pg_backend_pid() and application_name <> 'realtime_replication_connection')::int active from pg_stat_activity where datname = current_database()`)
      while (load.active > 12 && pauses <= 30) { pauses += 1; console.error(`[load] active=${load.active} pause ${pauses}`); await sleep(60000); [load] = await sql(`select count(*) filter (where state = 'active' and backend_type = 'client backend' and pid <> pg_backend_pid() and application_name <> 'realtime_replication_connection')::int active from pg_stat_activity where datname = current_database()`) }
      if (pauses > 30) { console.error('[load] stopping'); break }
    }
    const watchdog = setTimeout(() => { console.error(`\n[watchdog] ${pid}; exiting for resume`); process.exit(3) }, 180000)
    try {
      const asOf = asOfFor(frame)
      const nowDate = KIND === 'current' ? new Date(args.now ?? Date.now()) : addDays(asOf, -1)
      const raw = await engine.loadSubjectProperty(pid, { supabase })
      if (!raw) { writeFileSync(cacheFile(pid), gzipSync(JSON.stringify({ property_id: pid, frame, error: 'subject_not_found' }))); continue }
      const subject = engine.normalizePropertyFeatures(raw, { source: 'properties', now: nowDate })
      const lat = num(subject.latitude); const lng = num(subject.longitude)
      if (!lat || !lng) { writeFileSync(cacheFile(pid), gzipSync(JSON.stringify({ property_id: pid, frame, error: 'subject_no_coordinates' }))); continue }
      const neighbors = await sql(v31.SUBJECT_GEO_SQL, [lat, lng])
      const [own] = await sql(`select situs_census_tract census_tract, subdivision_name, coalesce(property_address_county_name, property_county_name) county_name,
        lot_square_feet::float8 lot_sqft, units_count::float8 units, property_type from public.properties where property_id = $1`, [pid])
      const geo = v31.resolveSubjectGeography({ own: own ?? {}, neighbors })
      const mfType = ['Multi-Family', 'Apartment', 'Duplex', 'Triplex', 'Quadruplex'].includes(own?.property_type)
      const units = num(own?.units) > 0 ? num(own.units) : null
      const s3 = { property_id: pid, latitude: lat, longitude: lng, sqft: subject.sqft, beds: subject.beds, baths: subject.baths,
        year_built: subject.year_built, estimated_repairs: subject.estimated_repairs, census_tract: geo.census_tract, fips: geo.fips, subdivision_name: geo.subdivision_name,
        lot_sqft: num(own?.lot_sqft), units: mfType || (units ?? 0) >= 2 ? units : null, condition: raw.building_condition ?? null }
      const lane = v31.laneFor(s3)
      const rows = await sql(lane.lane === 'sfr' ? CANON_SQL : CANON_MF_SQL, [lat, lng, lane.radiusMiles, monthsBefore(asOf, lane.months), asOf, lane.readCap])
      const gate = engineGate(subject, nowDate)
      const pre = v31.valueSubjectV3({ subject: s3, rows, asOf, gate })
      const live = new Set(pre.comps.filter((c) => c.status !== 'excluded' || (c.reasons ?? []).every((x) => SET_LEVEL.has(x))).map((c) => c.comp_id))
      const pairs = rows.filter((r) => live.has(r.comp_id)).slice(0, 800)
      const bulkRows = pairs.length ? await sql(v2.BULK_CONSIDERATION_SQL, [pairs.map((p) => day(p.sold_on)), pairs.map((p) => num(p.price))]) : []
      const buyerPurchases = ((await engine.loadBuyerPurchases(subject, { supabase, now: nowDate })) ?? []).filter((e) => !e.purchase_date || day(e.purchase_date) < asOf)
      // Keep only rows inside the lane radius (the SQL reads a bounding box).
      const inRadius = rows.filter((r) => { const d = v31.haversineMiles(lat, lng, num(r.lat), num(r.lng)); return d !== null && d < lane.radiusMiles })
      writeFileSync(cacheFile(pid), gzipSync(JSON.stringify({ property_id: pid, frame, as_of: asOf, now: nowDate.toISOString(), raw, own: own ?? null, neighbors, geo, s3, lane: lane.lane,
        rows: inRadius, read_rows: rows.length, truncated: rows.length >= lane.readCap, bulkRows, buyerPurchases })))
    } catch (e) {
      console.error(`\n[error] ${pid}: ${String(e?.message || e).slice(0, 200)}`)
    } finally { clearTimeout(watchdog) }
    done += 1
    process.stdout.write('.')
    if (done % 50 === 0) process.stdout.write(`${done}\n`)
    await sleep(Number(args['pause-ms'] ?? 250))
  }
  await pgc.end()
  const summary = { mode: MODE, kind: KIND, finishedAt: new Date().toISOString(), subjects: frames.length, done, loadPauses: pauses, writeAudit: AUDIT }
  writeFileSync(resolve(CACHE, `fetch-summary-${KIND}.json`), JSON.stringify(summary, null, 2))
  console.log(`\n${JSON.stringify(summary)}`)
  process.exit(0)
}

// ── run (offline) ── implemented below by the merged-engine harness.
const { runMergedSubject } = await import('./lib/acquisition-v3-merged-harness.mjs')
const OUT_DIR = args['out-dir']
if (!OUT_DIR) { console.error('--out-dir required'); process.exit(2) }
mkdirSync(resolve(OUT_DIR, 'subjects'), { recursive: true })
let ok = 0
for (const frame of frames) {
  const pid = String(frame.property_id)
  if (!existsSync(cacheFile(pid))) continue
  const c = readCache(pid)
  let r
  try { r = c.error ? { property_id: pid, frame, error: c.error } : runMergedSubject(c, { engine, v31, engineGate }) } catch (e) { r = { property_id: pid, frame, error: String(e?.stack || e).slice(0, 600) } }
  writeFileSync(resolve(OUT_DIR, 'subjects', `${pid}.json`), JSON.stringify(r))
  if (!r.error) ok += 1
}
console.log(JSON.stringify({ mode: MODE, kind: KIND, subjects: frames.length, ok }))
