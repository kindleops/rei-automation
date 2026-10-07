#!/usr/bin/env node
/**
 * INVESTOR VALUATION v3 — SHADOW DIAGNOSIS + BACKTEST (read-only).
 *
 * Owner brief 2026-10-06: offers are far below what off-market investors pay.
 * This script measures production, v2.1 and v3 side by side. It writes
 * nothing to the database, never calls a persister, and is not wired into any
 * cron or route.
 *
 *   --mode=diagnose  the most recently scored SFR subjects in Dallas, Houston,
 *                    Minneapolis and Tampa (stored production score vs v3 today).
 *   --mode=backtest  recorded OFF-MARKET INVESTOR SFR purchases after the pool
 *                    freeze (2026-05-08). Each subject is valued AS OF its sale
 *                    date (sales strictly before it) by: production (frozen pool,
 *                    get_comp_candidates_for_subject verbatim as of the date),
 *                    v2.1 (canonical sales) and v3. The sale itself and anything
 *                    on/after it never enter a comp set (leakage checked per row).
 *
 * Safety: Supabase client wrapped in a write guard; SQL runs BEGIN READ ONLY,
 * statement_timeout 30s, concurrency 1, pauses between subjects, backs off when
 * > --max-active sessions or any query > 10 s. Run under `nice -n 15`.
 *
 * USAGE (from apps/api):
 *   nice -n 15 node scripts/valuation-v3-shadow-backtest.mjs --mode=backtest --out-dir=<dir> [--resume] [--frame-file=<f>]
 *   nice -n 15 node scripts/valuation-v3-shadow-backtest.mjs --mode=diagnose --out-dir=<dir>
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'
import pg from 'pg'

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(apiRoot)
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
const DB_URL = process.env.SUPABASE_DB_URL || (existsSync('/tmp/.dburl') ? readFileSync('/tmp/.dburl', 'utf8').trim() : fileEnv.SUPABASE_DB_URL)
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !DB_URL) { console.error('missing database configuration'); process.exit(2) }
register('./tests/alias-loader.mjs', pathToFileURL(`${apiRoot}/`))

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'] }))
const MODE = args.mode ?? 'backtest'
const PAUSE = Math.max(0, Number(args['pause-ms'] ?? 600))
const MAX_ACTIVE = Number(args['max-active'] ?? 12)
const MAX_LONG = Number(args['max-long'] ?? 0) // other sessions' queries running > 10 s
const OUT_DIR = args['out-dir']
const FREEZE = args.freeze ?? '2026-05-08'
const PER_MARKET = Number(args['per-market'] ?? 12)
const SUBJECT_TIMEOUT_MS = Number(args['subject-timeout-ms'] ?? 180000)
if (!OUT_DIR) { console.error('--out-dir required'); process.exit(2) }
mkdirSync(resolve(OUT_DIR, 'subjects'), { recursive: true })

const { supabase: rawSupabase } = await import('../src/lib/supabase/client.js')
const engine = await import('../src/lib/acquisition/acquisitionDecisionEngine.js')
const v2 = await import('../src/lib/acquisition/shadow/currentSalesValuationV2.js')
const v3 = await import('../src/lib/acquisition/shadow/investorValuationV3.js')
const { engineRulesFor } = await import('../src/lib/domain/comp-intelligence/comps-engine-rules.js')

// ── write guard ──
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

const pgc = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
await pgc.connect()
await pgc.query("SET statement_timeout = '30s'")
await pgc.query('SET default_transaction_read_only = on')
async function sql(q, params = []) {
  tally('sql')
  await pgc.query('BEGIN READ ONLY')
  try { await pgc.query("SET LOCAL statement_timeout = '30s'"); return (await pgc.query(q, params)).rows } finally { await pgc.query('ROLLBACK') }
}
async function dbLoad() {
  const [r] = await sql(`select count(*) filter (where state = 'active' and backend_type = 'client backend' and pid <> pg_backend_pid() and application_name <> 'realtime_replication_connection')::int active,
    count(*) filter (where state = 'active' and backend_type = 'client backend' and pid <> pg_backend_pid() and application_name <> 'realtime_replication_connection' and now() - query_start > interval '10 seconds')::int long_q
    from pg_stat_activity where datname = current_database()`)
  return r
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const day = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null)
const addDays = (d, n) => { const x = new Date(`${day(d)}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x }
const monthsBefore = (d, m) => { const x = new Date(`${day(d)}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() - m); return x.toISOString().slice(0, 10) }

function engineSummary(d) {
  const sel = d.selected_comps ?? []
  return {
    mid: num(d.valuation?.mid), method: d.valuation?.calculation?.method ?? null, n: sel.length, confidence: num(d.valuation?.confidence),
    repairs: num(d.repairs?.amount ?? d.offer?.summary?.estimated_repairs), ceiling: num(d.offer?.effective_buyer_ceiling), offer: num(d.offer?.recommended_cash_offer),
    fee: num(d.offer?.expected_assignment_fee), tier: d.decision?.tier ?? null,
    newest: sel.map((s) => day(s.comp?.sale_date)).filter(Boolean).sort().pop() ?? null,
  }
}

// The production engine's comp gates, applied to every v3 candidate (asset family,
// unit-count credibility, nominal / non-arm's-length ratio, size range, same
// property). Radius and age are the v3 lane's own rules, so those two reasons are
// not taken from the engine (its SFR radius is wider than the 2.5 mi owner rule
// and its MF radius narrower than the MF lane).
const ENGINE_GATE_IGNORED = new Set(['outside_radius', 'sale_too_old', 'outside_zip_without_coordinates'])
function engineGate(subject, nowDate) {
  return (row) => {
    const comp = engine.normalizePropertyFeatures(v2.toEngineComp(row, subject), { source: 'mv_map_market_sales', distance_miles: row.distance_miles, now: nowDate })
    return engine.evaluateCompEligibility(subject, comp, nowDate).reasons.filter((r) => !ENGINE_GATE_IGNORED.has(r))
  }
}

async function v3For({ raw, subject, asOf, nowDate = addDays(asOf, -1) }) {
  const lat = num(subject.latitude); const lng = num(subject.longitude)
  const neighbors = await sql(v3.SUBJECT_GEO_SQL, [lat, lng])
  const [own] = await sql(`select situs_census_tract census_tract, subdivision_name, coalesce(property_address_county_name, property_county_name) county_name,
    lot_square_feet::float8 lot_sqft, units_count::float8 units, property_type from public.properties where property_id = $1`, [String(raw.property_id)])
  const geo = v3.resolveSubjectGeography({ own: own ?? {}, neighbors })
  const mfType = ['Multi-Family', 'Apartment', 'Duplex', 'Triplex', 'Quadruplex'].includes(own?.property_type)
  const units = num(own?.units) > 0 ? num(own.units) : null
  const s3 = { property_id: String(raw.property_id), latitude: lat, longitude: lng, sqft: subject.sqft, beds: subject.beds, baths: subject.baths,
    year_built: subject.year_built, estimated_repairs: subject.estimated_repairs, census_tract: geo.census_tract, fips: geo.fips, subdivision_name: geo.subdivision_name,
    lot_sqft: num(own?.lot_sqft), units: mfType || (units ?? 0) >= 2 ? units : null, condition: raw.building_condition ?? null }
  const lane = v3.laneFor(s3)
  const rows = await sql(lane.lane === 'sfr' ? v3.CANDIDATE_ROWS_SQL : v3.CANDIDATE_ROWS_MF_SQL, [lat, lng, lane.radiusMiles, monthsBefore(asOf, lane.months), asOf, lane.readCap])
  const gate = engineGate(subject, nowDate)
  const pre = v3.valueSubjectV3({ subject: s3, rows, asOf, gate })
  // Multi-parcel consideration check only for rows that otherwise survived.
  // Every row that passed the deed-level rules (set-level exclusions like top-K or an
  // outlier can change once a multi-parcel deed leaves the set, so those are checked too).
  const SET_LEVEL = new Set([v3.V3_REASONS.outsideTopK, v3.V3_REASONS.outlierLow, v3.V3_REASONS.outlierHigh, v3.V3_REASONS.dominantOutlier])
  const live = new Set(pre.comps.filter((c) => c.status !== 'excluded' || (c.reasons ?? []).every((x) => SET_LEVEL.has(x))).map((c) => c.comp_id))
  const pairs = rows.filter((r) => live.has(r.comp_id)).slice(0, 800)
  const bulkRows = pairs.length ? await sql(v2.BULK_CONSIDERATION_SQL, [pairs.map((p) => day(p.sold_on)), pairs.map((p) => num(p.price))]) : []
  const res = v3.valueSubjectV3({ subject: s3, rows, bulkRows, asOf, gate })
  return { ...res, geo, lane: lane.lane, truncated: rows.length >= lane.readCap }
}

async function prodAsOf({ pid, subject, asOf, nowDate }) {
  const rules = engineRulesFor(subject.asset_family)
  const rows = await sql(v2.OLD_POOL_AS_OF_SQL, [pid, rules.radiusMiles, rules.months, 100, asOf])
  const d = engine.calculateAcquisitionDecision({ subject, comps: rows.map(v2.oldPoolRowToEngineComp), buyerPurchases: [], now: nowDate, v3Enabled: false })
  return d
}
async function v21AsOf({ raw, subject, asOf, nowDate }) {
  const rules = engineRulesFor(subject.asset_family)
  const rows = await sql(v2.CURRENT_SALES_ROWS_SQL, [subject.latitude, subject.longitude, rules.radiusMiles, monthsBefore(asOf, rules.months), asOf, v2.CURRENT_SALES_V2.readCap])
  const pass1 = v2.selectCurrentSalesCandidates({ rows, subject, rawSubject: raw, radiusMiles: rules.radiusMiles })
  const pairs = pass1.needsBulkCheck.filter((p) => p.price > 0)
  const bulkRows = pairs.length ? await sql(v2.BULK_CONSIDERATION_SQL, [pairs.map((p) => p.sold_on), pairs.map((p) => p.price)]) : []
  return v2.valueWithCurrentSalesV2({ rawSubject: raw, subject, rows, bulkRows, radiusMiles: rules.radiusMiles, buyerPurchases: [], now: nowDate }).decision
}

async function backtestSubject(frame) {
  const pid = String(frame.property_id)
  const saleDate = day(frame.sold_on)
  const nowDate = addDays(saleDate, -1)
  const raw = await engine.loadSubjectProperty(pid, { supabase })
  if (!raw) return { property_id: pid, frame, error: 'subject_not_found' }
  const subject = engine.normalizePropertyFeatures(raw, { source: 'properties', now: nowDate })
  if (!num(subject.latitude) || !num(subject.longitude)) return { property_id: pid, frame, error: 'subject_no_coordinates' }
  const baseFile = args['base-dir'] ? resolve(args['base-dir'], 'subjects', `${pid}.json`) : null
  const base = baseFile && existsSync(baseFile) ? JSON.parse(readFileSync(baseFile, 'utf8')) : null
  const r3 = await v3For({ raw, subject, asOf: saleDate })
  if (base && !base.error) {
    // --base-dir: production and v2.1 are reused from the earlier run of the identical frame (they do not depend on v3).
    const sel3b = r3.comps.filter((c) => c.status === 'selected')
    return { ...base, subject: { ...base.subject, geo: r3.geo, lane: r3.lane },
      leakage_check: { ...base.leakage_check, v3: sel3b.filter((c) => c.sold_on >= saleDate || String(c.property_id) === pid).length },
      v3: { value: r3.value, offer: r3.offer, retail_context: r3.retail_context, census: r3.census, truncated: r3.truncated, selected: sel3b,
        excluded_reason_counts: r3.comps.filter((c) => c.status !== 'selected').reduce((o, c) => { for (const k of c.reasons ?? []) o[k] = (o[k] ?? 0) + 1; return o }, {}) } }
  }
  const prod = await prodAsOf({ pid, subject, asOf: saleDate, nowDate })
  const v21 = await v21AsOf({ raw, subject, asOf: saleDate, nowDate })
  const leak = (d) => (d.selected_comps ?? []).filter((s) => day(s.comp.sale_date) >= saleDate || String(s.comp.property_id) === pid).length
  const sel3 = r3.comps.filter((c) => c.status === 'selected')
  return {
    property_id: pid, frame, sale: { comp_id: frame.comp_id, sold_on: saleDate, price: num(frame.price), doc_type: frame.doc_type, buyer_basis: frame.buyer_basis },
    subject: { market: raw.market ?? null, address: subject.address, sqft: subject.sqft, beds: subject.beds, baths: subject.baths, year_built: subject.year_built,
      units: subject.units ?? null, estimated_repairs: subject.estimated_repairs, geo: r3.geo, lane: r3.lane },
    leakage_check: { prod: leak(prod), v21: leak(v21), v3: sel3.filter((c) => c.sold_on >= saleDate || String(c.property_id) === pid).length },
    prod: engineSummary(prod), v21: engineSummary(v21),
    v3: { value: r3.value, offer: r3.offer, retail_context: r3.retail_context, census: r3.census, truncated: r3.truncated,
      selected: sel3, excluded_reason_counts: r3.comps.filter((c) => c.status !== 'selected').reduce((o, c) => { for (const k of c.reasons ?? []) o[k] = (o[k] ?? 0) + 1; return o }, {}) },
  }
}

async function diagnoseSubject(frame) {
  const pid = String(frame.property_id)
  const NOW = new Date()
  const raw = await engine.loadSubjectProperty(pid, { supabase })
  if (!raw) return { property_id: pid, frame, error: 'subject_not_found' }
  const subject = engine.normalizePropertyFeatures(raw, { source: 'properties', now: NOW })
  const asOf = day(addDays(NOW, 1))
  const r3 = await v3For({ raw, subject, asOf, nowDate: NOW })
  return {
    property_id: pid, frame, lane: r3.lane, subject: { market: raw.market, address: subject.address, sqft: subject.sqft, beds: subject.beds, baths: subject.baths, year_built: subject.year_built, estimated_repairs: subject.estimated_repairs, avm: subject.estimated_value, geo: r3.geo },
    v3: { value: r3.value, offer: r3.offer, retail_context: r3.retail_context, census: r3.census, selected: r3.comps.filter((c) => c.status === 'selected'),
      excluded_reason_counts: r3.comps.filter((c) => c.status !== 'selected').reduce((o, c) => { for (const k of c.reasons ?? []) o[k] = (o[k] ?? 0) + 1; return o }, {}) },
  }
}

// Truth: the FIRST off-market (no MLS record) arm's-length SFR purchase by an
// investor buyer after the freeze per properties-backed parcel. Investor = the
// deed's buyer class / investor flag, a recorded cash purchase, or the owner
// model (latest sale, no recorded buyer, entity owner of record today).
const BACKTEST_FRAME_SQL = `
with s as (
  select distinct on (m.property_id) m.property_id, m.comp_id, m.sold_on::text sold_on, m.price::float8 price, m.doc_type, p.market,
    case when m.is_investor then 'recorded_investor' when m.is_cash_purchase then 'recorded_cash' else 'inferred_owner_entity' end buyer_basis
  from public.mv_map_market_sales m join public.properties p using (property_id)
  where m.sold_on > $1::date and m.source = 'public_record' and m.price >= 30000 and m.is_arms_length is not false and coalesce(m.portfolio_size, 1) < 2
    and (m.is_investor or m.is_cash_purchase or m.investor_inferred_current_owner)
    and coalesce(m.buyer_class, '') not in ('builder', 'bank', 'government')
    and coalesce(m.doc_type, '') !~* '(trustee|sheriff|in lieu|foreclos|certificate of transfer|public action|correction|re-recorded|mortgage|gift|intrafamily|transfer on death|distribution|affidavit|quit ?claim)'
    and p.property_type in ('Single Family', 'SFR', 'Townhouse') and coalesce(p.units_count, 1) <= 1 and p.latitude is not null
    and coalesce(p.year_built, 0) < 2025
  order by m.property_id, m.sold_on asc
),
r as (select s.*, row_number() over (partition by market order by md5(property_id || 'v3bt1006')) rn from s)
select * from r
where rn <= case when market in ('Dallas, TX', 'Houston, TX', 'Minneapolis, MN', 'Tampa, FL') then 60 else $2::int end
order by rn, market`

// Multifamily truth: the same definition for 2-4 and 5+ unit parcels with a real unit count.
const BACKTEST_MF_FRAME_SQL = `
with s as (
  select distinct on (m.property_id) m.property_id, m.comp_id, m.sold_on::text sold_on, m.price::float8 price, m.doc_type, p.market,
    case when coalesce(p.units_count, 0) >= 5 then 'mf5' else 'mf24' end lane,
    case when m.is_investor then 'recorded_investor' when m.is_cash_purchase then 'recorded_cash' else 'inferred_owner_entity' end buyer_basis
  from public.mv_map_market_sales m join public.properties p using (property_id)
  where m.sold_on > $1::date and m.source = 'public_record' and m.price >= 50000 and m.is_arms_length is not false and coalesce(m.portfolio_size, 1) < 2
    and (m.is_investor or m.is_cash_purchase or m.investor_inferred_current_owner)
    and coalesce(m.buyer_class, '') not in ('builder', 'bank', 'government')
    and coalesce(m.doc_type, '') !~* '(trustee|sheriff|in lieu|foreclos|certificate of transfer|public action|correction|re-recorded|mortgage|gift|intrafamily|transfer on death|distribution|affidavit|quit ?claim)'
    and (p.property_type in ('Multi-Family', 'Apartment') or p.units_count >= 2) and p.units_count >= 2 and p.latitude is not null
  order by m.property_id, m.sold_on asc
)
select * from s order by lane, market, property_id`

const DIAGNOSE_EXTRA_SQL = `
select s.property_id, p.market, s.valuation_mid::float8 valuation_mid, s.estimated_repairs::float8 estimated_repairs, s.recommended_cash_offer::float8 offer,
  (s.evidence->'offer_calculation'->>'effective_buyer_ceiling')::float8 mao, (s.evidence->'offer_calculation'->>'target_assignment_fee')::float8 fee, s.comp_count, s.computed_at::text computed_at,
  s.investor_ceiling_mid::float8 investor_ceiling_mid, p.units_count::float8 units, p.cash_offer::float8 legacy_cash_offer
from public.property_acquisition_scores s join public.properties p using (property_id) where s.property_id = any($1::text[])`

const DIAGNOSE_FRAME_SQL = `
select * from (
  select s.property_id, p.market, s.valuation_mid::float8 valuation_mid, s.estimated_repairs::float8 estimated_repairs, s.recommended_cash_offer::float8 offer,
    (s.evidence->'offer_calculation'->>'effective_buyer_ceiling')::float8 mao, (s.evidence->'offer_calculation'->>'target_assignment_fee')::float8 fee, s.comp_count, s.computed_at::text computed_at,
    (select percentile_cont(0.5) within group (order by (c->>'distance_miles')::float8) from jsonb_array_elements(s.evidence->'selected_comps') c) prod_comp_median_distance,
    (select percentile_cont(0.5) within group (order by (c->>'sale_price')::float8) from jsonb_array_elements(s.evidence->'selected_comps') c) prod_comp_median_price,
    row_number() over (partition by p.market order by s.computed_at desc) rn
  from public.property_acquisition_scores s join public.properties p using (property_id)
  where p.market in ('Dallas, TX', 'Houston, TX', 'Minneapolis, MN', 'Tampa, FL') and p.property_type in ('Single Family', 'SFR', 'Townhouse')
    and coalesce(p.units_count, 1) <= 1 and s.valuation_mid > 0 and p.latitude is not null) x
where (market = 'Dallas, TX' and rn <= 6) or (market = 'Houston, TX' and rn <= 5) or (market = 'Minneapolis, MN' and rn <= 5) or (market = 'Tampa, FL' and rn <= 4)
order by market, rn`

let frames
if (args['frame-file']) frames = JSON.parse(readFileSync(args['frame-file'], 'utf8')).subjects
else if (MODE === 'backtest') {
  frames = await sql(BACKTEST_FRAME_SQL, [FREEZE, PER_MARKET])
  writeFileSync(resolve(OUT_DIR, 'backtest-frame.json'), JSON.stringify({ generated: new Date().toISOString(), definition: 'first off-market arms-length investor SFR purchase after the freeze per properties-backed parcel; <=60 per focus market, <=per-market elsewhere; md5 seed v3bt1006', subjects: frames }, null, 1))
} else if (MODE === 'backtest-mf') {
  frames = await sql(BACKTEST_MF_FRAME_SQL, [FREEZE])
  writeFileSync(resolve(OUT_DIR, 'backtest-frame.json'), JSON.stringify({ generated: new Date().toISOString(), definition: 'first off-market arms-length investor purchase after the freeze per properties-backed 2+ unit parcel (real unit count)', subjects: frames }, null, 1))
} else if (MODE === 'diagnose') {
  frames = await sql(DIAGNOSE_FRAME_SQL)
  if (args['extra-ids']) frames.push(...await sql(DIAGNOSE_EXTRA_SQL, [String(args['extra-ids']).split(',')]))
  writeFileSync(resolve(OUT_DIR, 'diagnose-frame.json'), JSON.stringify({ generated: new Date().toISOString(), subjects: frames }, null, 1))
} else { console.error('unknown --mode'); process.exit(2) }

let done = 0
let pauses = 0
for (const frame of frames) {
  const file = resolve(OUT_DIR, 'subjects', `${frame.property_id}.json`)
  if (args.resume && existsSync(file)) { done += 1; continue }
  if (done % 3 === 0) {
    let load = await dbLoad()
    while (load.active > MAX_ACTIVE || load.long_q > MAX_LONG) {
      pauses += 1
      console.error(`[load] active=${load.active} long=${load.long_q} pause ${pauses}`)
      if (pauses > 60) break
      await sleep(60000)
      load = await dbLoad()
    }
    if (pauses > 60) { console.error('[load] stopping'); break }
  }
  const watchdog = setTimeout(() => { console.error(`\n[watchdog] ${frame.property_id} exceeded ${SUBJECT_TIMEOUT_MS}ms; exiting for resume`); process.exit(3) }, SUBJECT_TIMEOUT_MS)
  let r
  try { r = MODE === 'diagnose' ? await diagnoseSubject(frame) : await backtestSubject(frame) } catch (e) { r = { property_id: String(frame.property_id), frame, error: String(e?.message || e).slice(0, 300) } }
  clearTimeout(watchdog)
  writeFileSync(file, JSON.stringify(r))
  done += 1
  process.stdout.write(r.error ? 'E' : '.')
  if (done % 50 === 0) process.stdout.write(`${done}\n`)
  if (PAUSE) await sleep(PAUSE)
}
await pgc.end()
const summary = { mode: MODE, finishedAt: new Date().toISOString(), subjects: frames.length, done, loadPauses: pauses, writeAudit: AUDIT }
writeFileSync(resolve(OUT_DIR, 'run-summary.json'), JSON.stringify(summary, null, 2))
console.log(`\n${JSON.stringify(summary)}`)
