#!/usr/bin/env node
/**
 * CURRENT-SALES VALUATION v2 — SHADOW COMPARISON + BACKTEST (read-only).
 *
 * Owner decision 2026-10-04: the quick connector is killed for underwriting;
 * v2 (lib/acquisition/shadow/currentSalesValuationV2.js) runs in SHADOW ONLY.
 * This script measures it. It writes nothing to the database, never calls a
 * persister, and is not wired into any cron or route.
 *
 *   --mode=compare   the 259-subject frame: old engine pool (production loader)
 *                    vs v2, each with and without the 5+ unit comp guard; also
 *                    re-prices the old pool through OLD_POOL_AS_OF_SQL at today
 *                    to prove the backtest's old-pool path equals production.
 *   --mode=backtest  recorded arm's-length sales after the pool freeze: value
 *                    each subject AS OF its sale date (sales strictly before it,
 *                    recency measured from the day before) in BOTH pools, then
 *                    compare to the actual price. No leakage of the sale itself
 *                    or of anything after it into either comp set.
 *
 * Safety: the Supabase client is wrapped in a guard (insert/upsert/update/delete
 * and non-allowlisted RPCs throw; audit emitted). SQL runs BEGIN READ ONLY,
 * statement_timeout 30s. Concurrency 1 with --pause-ms between subjects; backs
 * off while > --max-active sessions or any query > 10s. Run under `nice -n 15`.
 *
 * USAGE (from apps/api):
 *   nice -n 15 node scripts/comps-current-sales-v2-shadow.mjs --mode=compare --subjects-file=frame-final.json --out-dir=/tmp/v2
 *   nice -n 15 node scripts/comps-current-sales-v2-shadow.mjs --mode=backtest --limit=260 --out-dir=/tmp/v2bt
 *   (re-run an identical deed sample: --frame-file=<out-dir>/backtest-frame.json; back-off: --backoff-ms, --check-every)
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
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL']) if (!process.env[k] && fileEnv[k]) process.env[k] = fileEnv[k]
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_DB_URL) {
  console.error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL (apps/api/.env.local)')
  process.exit(2)
}
register('./tests/alias-loader.mjs', pathToFileURL(`${apiRoot}/`))

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true']
}))
const MODE = args.mode ?? 'compare'
const PAUSE = Math.max(0, Number(args['pause-ms'] ?? 800))
const MAX_ACTIVE = Number(args['max-active'] ?? 12)
const OUT_DIR = args['out-dir']
const FREEZE = args.freeze ?? '2026-05-08'
const LIMIT = Math.max(1, Math.min(400, Number(args.limit ?? 260)))
const BACKOFF_MS = Math.max(10000, Number(args['backoff-ms'] ?? 60000))
const CHECK_EVERY = Math.max(1, Number(args['check-every'] ?? 3))
if (!OUT_DIR) { console.error('--out-dir required'); process.exit(2) }
mkdirSync(resolve(OUT_DIR, 'subjects'), { recursive: true })

const { supabase: rawSupabase } = await import('../src/lib/supabase/client.js')
const engine = await import('../src/lib/acquisition/acquisitionDecisionEngine.js')
const v2 = await import('../src/lib/acquisition/shadow/currentSalesValuationV2.js')
const { engineRulesFor } = await import('../src/lib/domain/comp-intelligence/comps-engine-rules.js')

// ── write guard ──
const AUDIT = { calls: {}, blocked: [] }
const tally = (k) => { AUDIT.calls[k] = (AUDIT.calls[k] ?? 0) + 1 }
const WRITE = new Set(['insert', 'upsert', 'update', 'delete'])
const RPC_ALLOW = new Set(['get_comp_candidates_for_subject'])
const guardBuilder = (b, t) => new Proxy(b, { get(target, prop, recv) {
  if (WRITE.has(prop)) return () => { AUDIT.blocked.push(`${t}.${String(prop)}`); throw new Error(`read_only_guard:${t}.${String(prop)}`) }
  const v = Reflect.get(target, prop, recv); return typeof v === 'function' ? v.bind(target) : v
} })
const supabase = new Proxy(rawSupabase, { get(target, prop, recv) {
  if (prop === 'from') return (t) => { tally(`from:${t}`); return guardBuilder(target.from(t), t) }
  if (prop === 'rpc') return (n, p, o) => { tally(`rpc:${n}`); if (!RPC_ALLOW.has(n)) { AUDIT.blocked.push(`rpc:${n}`); throw new Error(`read_only_guard:rpc:${n}`) } return target.rpc(n, p, o) }
  if (['schema', 'storage', 'functions', 'channel'].includes(prop)) return () => { AUDIT.blocked.push(String(prop)); throw new Error(`read_only_guard:${String(prop)}`) }
  const v = Reflect.get(target, prop, recv); return typeof v === 'function' ? v.bind(target) : v
} })

// ── read-only SQL ──
const pgc = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
await pgc.connect()
await pgc.query("SET statement_timeout = '30s'")
await pgc.query('SET default_transaction_read_only = on')
async function sql(textQ, params = []) {
  tally('sql')
  await pgc.query('BEGIN READ ONLY')
  try { await pgc.query("SET LOCAL statement_timeout = '30s'"); return (await pgc.query(textQ, params)).rows } finally { await pgc.query('ROLLBACK') }
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
const median = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2 }
const addDays = (d, n) => { const x = new Date(`${day(d)}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x }
const monthsBefore = (d, m) => { const x = new Date(d.getTime()); x.setUTCMonth(x.getUTCMonth() - m); return x.toISOString().slice(0, 10) }

// ── per-comp records ──
function compRecord(entry, status) {
  const c = entry.comp ?? {}
  const raw = c.raw ?? {}
  const meta = raw._v2 ?? null
  const repair = (entry.price_adjustments ?? []).find((a) => a.basis === 'repair_difference')
  return {
    id: c.source_id ?? null, property_id: c.property_id ?? null, zip: c.zip ?? null,
    source: raw.source ?? null, sale_source: c.sale_source ?? null, sale_date: day(c.sale_date), price: c.sale_price ?? null,
    distance_miles: c.distance_miles ?? null, rpc_similarity: num(raw.similarity_score) ?? meta?.rpc_similarity ?? null,
    comp_score: entry.comp_score ?? null, comp_confidence: entry.comp_confidence ?? null, data_completeness: entry.data_completeness ?? null,
    weight: entry.weight ?? null, ppsf: num(c.sale_price) && num(c.sqft) ? Math.round(c.sale_price / c.sqft) : null,
    property_type: raw.property_type ?? null, asset_type: c.asset_type ?? null, beds: c.beds ?? null, baths: c.baths ?? null,
    sqft: c.sqft ?? null, year_built: c.year_built ?? null, units: c.units ?? null, estimated_value: c.estimated_value ?? null,
    repair_basis: meta?.repair_basis ?? (num(c.estimated_repairs) !== null ? 'comp_estimate' : 'unknown_read_as_zero'),
    condition_adjustment: repair ? repair.amount : null, adjusted_price: entry.adjusted_price ?? null,
    dedupe_group: meta ? { comp_id: c.source_id, txn_id: meta.txn_id } : { pool_id: c.source_id },
    deed: meta ? { doc_type: meta.doc_type, is_arms_length: meta.is_arms_length, portfolio_size: meta.portfolio_size, price_source: meta.price_source, v2_rank: meta.rank } : null,
    status, reasons: status === 'selected' ? ['selected_top_weight'] : (entry.reasons ?? []),
  }
}
function ledgerRecord(l) {
  const r = l.row
  return { id: r.comp_id, property_id: r.property_id, zip: r.zip, source: 'mv_map_market_sales', sale_source: r.source, sale_date: day(r.sold_on), price: num(r.price),
    distance_miles: r.distance_miles ?? null, rpc_similarity: r.rpc_similarity ?? null, v2_rank: r.v2_rank ?? null, property_type: r.property_type, beds: r.beds, baths: r.baths,
    sqft: r.sqft, year_built: r.year_built, units: r.units, estimated_value: num(r.estimated_value),
    ppsf: num(r.price) && num(r.sqft) ? Math.round(r.price / r.sqft) : null,
    deed: { doc_type: r.doc_type, is_arms_length: r.is_arms_length, portfolio_size: r.portfolio_size, price_source: r.price_source, txn_id: r.txn_id },
    kept_id: l.kept_id ?? null, status: 'excluded_pre_engine', reasons: l.reasons }
}
function summarize(d, guard = null) {
  const sel = d.selected_comps ?? []
  const recs = sel.map((e) => compRecord(e, 'selected'))
  return {
    mid: num(d.valuation?.mid), low: num(d.valuation?.low), high: num(d.valuation?.high), offer: num(d.offer?.recommended_cash_offer),
    valuation_confidence: num(d.valuation?.confidence), confidence: num(d.confidence), tier: d.decision?.tier ?? null,
    method: d.valuation?.calculation?.method ?? null, selected: sel.length,
    newest: recs.map((r) => r.sale_date).filter(Boolean).sort().pop() ?? null,
    median_distance: median(recs.map((r) => r.distance_miles)), median_similarity: median(recs.map((r) => r.rpc_similarity)),
    median_ppsf: median(recs.map((r) => r.ppsf)), guard: guard ?? undefined,
  }
}
const rejectionCounts = (d) => { const o = {}; for (const r of d.rejected_comps ?? []) for (const why of r.reasons ?? []) o[why] = (o[why] ?? 0) + 1; return o }
function fullComps(d, ledger = null) {
  const recs = [...(d.selected_comps ?? []).map((e) => compRecord(e, 'selected')), ...(d.rejected_comps ?? []).map((e) => compRecord(e, 'rejected'))]
  if (!ledger) return { comps: recs }
  const counts = {}
  for (const l of ledger) for (const r of l.reasons) counts[r] = (counts[r] ?? 0) + 1
  const limitRows = ledger.filter((l) => l.reasons[0] === v2.V2_REASONS.outsideLimit)
  return { comps: [...recs, ...ledger.filter((l) => l.reasons[0] !== v2.V2_REASONS.outsideLimit).map(ledgerRecord), ...limitRows.slice(0, 50).map(ledgerRecord)],
    pre_engine_exclusion_counts: counts, outside_limit_recorded: Math.min(50, limitRows.length), outside_limit_total: limitRows.length }
}

/** v2 for one subject: rows -> bulk check -> value. */
async function runV2({ raw, subject, radius, months, asOf, nowDate, buyerPurchases }) {
  const since = monthsBefore(new Date(`${asOf}T00:00:00Z`), months)
  const rows = await sql(v2.CURRENT_SALES_ROWS_SQL, [subject.latitude, subject.longitude, radius, since, asOf, v2.CURRENT_SALES_V2.readCap])
  const pass1 = v2.selectCurrentSalesCandidates({ rows, subject, rawSubject: raw, radiusMiles: radius })
  const pairs = pass1.needsBulkCheck.filter((p) => p.price > 0)
  const bulkRows = pairs.length ? await sql(v2.BULK_CONSIDERATION_SQL, [pairs.map((p) => p.sold_on), pairs.map((p) => p.price)]) : []
  const res = v2.valueWithCurrentSalesV2({ rawSubject: raw, subject, rows, bulkRows, radiusMiles: radius, buyerPurchases, now: nowDate })
  return { ...res, truncated: rows.length >= v2.CURRENT_SALES_V2.readCap, since }
}

async function oldAsOf({ pid, subject, radius, months, asOf, nowDate, buyerPurchases }) {
  const rows = await sql(v2.OLD_POOL_AS_OF_SQL, [pid, radius, months, 100, asOf])
  const comps = rows.map(v2.oldPoolRowToEngineComp)
  const d = engine.calculateAcquisitionDecision({ subject, comps, buyerPurchases, now: nowDate, v3Enabled: false })
  const g = v2.withMinCompGuard({ subject, buyerPurchases, now: nowDate, decision: d })
  return { d, g }
}

async function compareSubject(frame) {
  const pid = String(frame.property_id)
  const NOW = new Date()
  const raw = await engine.loadSubjectProperty(pid, { supabase })
  if (!raw) return { property_id: pid, frame, error: 'subject_not_found' }
  const subject = engine.normalizePropertyFeatures(raw, { source: 'properties', now: NOW })
  if (!num(subject.latitude) || !num(subject.longitude)) return { property_id: pid, frame, error: 'subject_no_coordinates' }
  const rules = engineRulesFor(subject.asset_family)
  const deps = { supabase, now: NOW }
  const oldComps = await engine.loadComparableProperties(subject, deps)
  const buyerPurchases = await engine.loadBuyerPurchases(subject, deps)
  const oldD = engine.calculateAcquisitionDecision({ subject, comps: oldComps, buyerPurchases, now: NOW, v3Enabled: false })
  const oldG = v2.withMinCompGuard({ subject, buyerPurchases, now: NOW, decision: oldD })
  const asOf = day(addDays(NOW, 1))
  const nv = await runV2({ raw, subject, radius: rules.radiusMiles, months: rules.months, asOf, nowDate: NOW, buyerPurchases })
  const parity = await oldAsOf({ pid, subject, radius: rules.radiusMiles, months: rules.months, asOf, nowDate: NOW, buyerPurchases })
  return {
    property_id: pid, frame,
    subject: { market: raw.market ?? null, address: subject.address, zip: subject.zip, asset_type: subject.asset_type, family: subject.asset_family,
      property_type: raw.property_type ?? null, units: num(raw.units_count), sqft: subject.sqft, beds: subject.beds, baths: subject.baths, year_built: subject.year_built,
      estimated_value: subject.estimated_value, estimated_repairs: subject.estimated_repairs },
    window: { radius_miles: rules.radiusMiles, months: rules.months, v2_since: nv.since, v2_truncated: nv.truncated },
    v2_census: nv.census,
    parity_old_as_of_equals_prod_loader: parity.d.valuation?.mid === oldD.valuation?.mid && (parity.d.selected_comps?.length ?? 0) === (oldD.selected_comps?.length ?? 0),
    variants: {
      old: { summary: summarize(oldD), rejection_counts: rejectionCounts(oldD), ...fullComps(oldD) },
      old_guarded: { summary: summarize(oldG.decision, oldG.guard) },
      v2: { summary: summarize(nv.decision), rejection_counts: rejectionCounts(nv.decision), ...fullComps(nv.decision, nv.ledger) },
      v2_guarded: { summary: summarize(nv.guarded, nv.guard) },
    },
  }
}

async function backtestSubject(frame) {
  const pid = String(frame.property_id)
  const saleDate = day(frame.sold_on)
  const nowDate = addDays(saleDate, -1) // valued as of the day before the sale
  const raw = await engine.loadSubjectProperty(pid, { supabase })
  if (!raw) return { property_id: pid, frame, error: 'subject_not_found' }
  const subject = engine.normalizePropertyFeatures(raw, { source: 'properties', now: nowDate })
  if (!num(subject.latitude) || !num(subject.longitude)) return { property_id: pid, frame, error: 'subject_no_coordinates' }
  const rules = engineRulesFor(subject.asset_family)
  const old = await oldAsOf({ pid, subject, radius: rules.radiusMiles, months: rules.months, asOf: saleDate, nowDate, buyerPurchases: [] })
  const nv = await runV2({ raw, subject, radius: rules.radiusMiles, months: rules.months, asOf: saleDate, nowDate, buyerPurchases: [] })
  const leak = (d) => (d.selected_comps ?? []).filter((s) => day(s.comp.sale_date) >= saleDate).length
  return {
    property_id: pid, frame, sale: { comp_id: frame.comp_id, sold_on: saleDate, price: num(frame.price), doc_type: frame.doc_type },
    subject: { market: raw.market ?? null, family: subject.asset_family, asset_type: subject.asset_type, property_type: raw.property_type ?? null, units: num(raw.units_count),
      sqft: subject.sqft, estimated_value: subject.estimated_value, estimated_repairs: subject.estimated_repairs },
    leakage_check: { old_selected_on_or_after_sale: leak(old.d), v2_selected_on_or_after_sale: leak(nv.decision) },
    v2_census: nv.census,
    variants: {
      old: { summary: summarize(old.d), selected: (old.d.selected_comps ?? []).map((e) => compRecord(e, 'selected')), rejection_counts: rejectionCounts(old.d) },
      old_guarded: { summary: summarize(old.g.decision, old.g.guard) },
      v2: { summary: summarize(nv.decision), selected: (nv.decision.selected_comps ?? []).map((e) => compRecord(e, 'selected')), rejection_counts: rejectionCounts(nv.decision) },
      v2_guarded: { summary: summarize(nv.guarded, nv.guard) },
    },
  }
}

const BACKTEST_FRAME_SQL = `
with s as (
  select distinct on (m.property_id) m.property_id, m.comp_id, m.sold_on::text sold_on, m.price::float8 price, m.doc_type, p.market,
    case when coalesce(p.units_count, 0) >= 5 or p.property_type = 'Apartment' then 'mf5'
         when coalesce(p.units_count, 0) between 2 and 4 or p.property_type = 'Multi-Family' then 'mf24'
         when p.property_type in ('Single Family', 'Townhouse', 'SFR') then 'sfr' else 'other' end ptype
  from public.mv_map_market_sales m join public.properties p using (property_id)
  where m.sold_on > $1::date and m.price > 10000 and m.is_arms_length is not false and coalesce(m.portfolio_size, 1) < 2
    and m.comp_id like 't:%' and p.latitude is not null
  order by m.property_id, m.sold_on asc
),
r as (select s.*, row_number() over (partition by market, ptype order by md5(property_id || 'bt1004')) rn from s)
select * from r where ptype <> 'other' and ((ptype = 'sfr' and rn <= 10) or (ptype in ('mf24', 'mf5') and rn <= 6))
order by rn, market`

// ── main ──
let frames
if (MODE === 'compare') {
  const f = JSON.parse(readFileSync(args['subjects-file'], 'utf8'))
  frames = (Array.isArray(f) ? f : f.subjects)
} else if (MODE === 'backtest' && args['frame-file']) {
  frames = JSON.parse(readFileSync(args['frame-file'], 'utf8')).subjects // re-run the identical deed sample
} else if (MODE === 'backtest') {
  frames = (await sql(BACKTEST_FRAME_SQL, [FREEZE])).slice(0, LIMIT)
  writeFileSync(resolve(OUT_DIR, 'backtest-frame.json'), JSON.stringify({ generated: new Date().toISOString(), definition: 'first arms-length priced recorded deed (t:) after the freeze per properties-backed parcel; <=10 SFR and <=6 each of MF2-4 / MF5+ per market, md5 seed bt1004', subjects: frames }, null, 1))
} else { console.error('unknown --mode'); process.exit(2) }

let done = 0
let pauses = 0
for (const frame of frames) {
  const file = resolve(OUT_DIR, 'subjects', `${frame.property_id}.json`)
  if (args.resume && existsSync(file)) { done += 1; continue }
  if (done % CHECK_EVERY === 0) {
    let load = await dbLoad()
    while (load.active > MAX_ACTIVE || load.long_q > 0) {
      pauses += 1
      console.error(`[load] active=${load.active} long=${load.long_q} pause ${pauses}`)
      if (pauses > 60) break
      await sleep(BACKOFF_MS)
      load = await dbLoad()
    }
    if (pauses > 60) { console.error('[load] stopping'); break }
  }
  let r
  try { r = MODE === 'compare' ? await compareSubject(frame) : await backtestSubject(frame) } catch (e) { r = { property_id: String(frame.property_id), frame, error: String(e?.message || e).slice(0, 300) } }
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
