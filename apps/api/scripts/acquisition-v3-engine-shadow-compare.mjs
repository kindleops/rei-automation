#!/usr/bin/env node
/**
 * ACQUISITION ENGINE V3 (the June-Sept rebuild) — READ-ONLY SHADOW COMPARISON.
 *
 * Runs the production engine's own calculateAcquisitionDecision with
 * v3Enabled=true IN PROCESS (never scoreProperty, never a persister) on:
 *   --mode=backtest   the v3.1 SFR backtest frame (as-of the day before each
 *                     recorded off-market investor sale; comps strictly before)
 *   --mode=backtest-mf the v3.1 multifamily frame (same rule)
 *   --mode=current    the scored active-campaign properties + golden cases (as of now)
 * twice per subject:
 *   native    = the V3 loader contract: get_comp_candidates_for_subject candidates
 *               (as-of replica of the frozen v_recent_sold_comps pool, V3 window
 *               4 mi/30 mo SFR, 7 mi/36 mo MF, top 100) + buyer_comp_raw_v2 identity +
 *               buyer_entities_v2, normalised by compIdentityEnrichment.normalizeCandidate
 *   canonical = the same normalizeCandidate contract fed from the canonical corpus
 *               (public.mv_map_market_sales 't:' rows = comp_private.comp_canonical_transactions,
 *               the read v3.1 uses). Contained adapter: canonicalRowToCandidate below.
 * In --mode=current it also runs v3.1 (shadow/investorValuationV3) for the same subjects.
 *
 * Safety: Supabase client behind a write guard (rpc/insert/update/upsert/delete throw);
 * SQL BEGIN READ ONLY, statement_timeout 30s, one connection, pause between subjects,
 * load back-off. Run under `nice -n 15`. Engine code is not modified.
 *
 * USAGE (from apps/api):
 *   nice -n 15 node scripts/acquisition-v3-engine-shadow-compare.mjs --mode=backtest --frame-file=<f> --out-dir=<d> [--resume]
 *   nice -n 15 node scripts/acquisition-v3-engine-shadow-compare.mjs --mode=current --ids=<a,b,...> --out-dir=<d>
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
// Never let the run inherit an enabled persist/auto flag from the shell.
for (const k of ['ACQUISITION_ENGINE_V3_ALLOW_PERSIST', 'ACQUISITION_ENGINE_V3_ALLOW_QUEUE_PRIORITY', 'ACQUISITION_ENGINE_V3_ALLOW_AUTO_OFFER', 'ACQUISITION_ENGINE_V3_ALLOW_AUTO_CREATIVE']) process.env[k] = 'false'
process.env.ACQUISITION_ENGINE_V3_SHADOW_MODE = 'true'
register('./tests/alias-loader.mjs', pathToFileURL(`${apiRoot}/`))

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'] }))
const MODE = args.mode ?? 'backtest'
const PAUSE = Math.max(0, Number(args['pause-ms'] ?? 300))
const MAX_ACTIVE = Number(args['max-active'] ?? 12)
const OUT_DIR = args['out-dir']
const SUBJECT_TIMEOUT_MS = Number(args['subject-timeout-ms'] ?? 180000)
if (!OUT_DIR) { console.error('--out-dir required'); process.exit(2) }
mkdirSync(resolve(OUT_DIR, 'subjects'), { recursive: true })

const { supabase: rawSupabase } = await import('../src/lib/supabase/client.js')
const engine = await import('../src/lib/acquisition/acquisitionDecisionEngine.js')
const v2 = await import('../src/lib/acquisition/shadow/currentSalesValuationV2.js')
const v31 = await import('../src/lib/acquisition/shadow/investorValuationV3.js')
const { loadV3CompCandidates } = await import('../src/lib/acquisition/compCandidateLoader.js')
const { normalizeCandidate } = await import('../src/lib/acquisition/compIdentityEnrichment.js')
const { normalizeEntityName } = await import('../src/lib/acquisition/transactionClustering.js')

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const day = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null)
const addDays = (d, n) => { const x = new Date(`${day(d)}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x }
const monthsBefore = (d, m) => { const x = new Date(`${day(d)}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() - m); return x.toISOString().slice(0, 10) }
const miles = (a, b, c, d) => 3958.8 * 2 * Math.asin(Math.sqrt(Math.sin(((c - a) * Math.PI) / 360) ** 2 + Math.cos((a * Math.PI) / 180) * Math.cos((c * Math.PI) / 180) * Math.sin(((d - b) * Math.PI) / 360) ** 2))

// The V3 loader's own window (compCandidateLoader.eligibilityWindow).
const v3Window = (s) => (s?.asset_family === 'multifamily' ? { radius: 7, months: 36 } : s?.asset_family === 'land' ? { radius: 20, months: 48 } : s?.asset_family === 'commercial' ? { radius: 15, months: 48 } : { radius: 4, months: 30 })

// OLD_POOL_AS_OF_SQL row (engine column names) -> get_comp_candidates_for_subject row shape.
const oldPoolRowToRpcShape = (r) => ({ ...r, asset_class: r.normalized_asset_class, beds: r.total_bedrooms, baths: r.total_baths, sqft: r.building_square_feet })

async function identityDeps() {
  return {
    fetchRawIdentity: async (ids) => {
      const uuids = ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x))
      if (!uuids.length) return []
      return sql(`select id::text id, property_id, apn_parcel_id, owner_name, owner_1_name, is_corporate_owner, out_of_state_owner, owner_address_full, document_type, last_sale_doc_type,
        recording_date::text recording_date, sale_price::float8 sale_price, mls_sold_price::float8 mls_sold_price, subdivision_name, school_district_name, effective_year_built,
        total_loan_amt::float8 total_loan_amt, total_loan_balance::float8 total_loan_balance, total_loan_payment::float8 total_loan_payment, lienholder_name
        from public.buyer_comp_raw_v2 where id = any($1::uuid[])`, [uuids])
    },
    fetchEntities: async (names) => (names.length ? sql(`select buyer_key, normalized_buyer_name, markets_active, purchase_count, avg_purchase_price::float8 avg_purchase_price, preferred_asset_classes
        from public.buyer_entities_v2 where normalized_buyer_name = any($1::text[])`, [names]).catch(() => []) : []),
  }
}

/** NATIVE: the production V3 loader, its RPC replaced by the as-of replica (rpc is blocked by the guard). */
async function nativeCandidates(subject, asOf) {
  const win = v3Window(subject)
  const rows = await sql(v2.OLD_POOL_AS_OF_SQL, [String(subject.property_id), win.radius, win.months, 100, asOf])
  const deps = await identityDeps()
  return loadV3CompCandidates(subject, { db: supabase, runRpc: async () => rows.map(oldPoolRowToRpcShape), ...deps })
}

// ── CANONICAL adapter ──
const CANON_SQL = v31.CANDIDATE_ROWS_SQL.replace('m.buyer_kind, m.doc_type', 'm.buyer_kind, m.buyer, m.doc_type')
const CANON_MF_SQL = v31.CANDIDATE_ROWS_MF_SQL.replace('m.buyer_kind, m.doc_type', 'm.buyer_kind, m.buyer, m.doc_type')
const assetClassOf = (r) => {
  const u = num(r.units) ?? 0
  if (r.property_type === 'Apartment' && u >= 5) return 'apartment'
  if (['Multi-Family', 'Apartment', 'Duplex', 'Triplex', 'Quadruplex'].includes(r.property_type) || u >= 2) return 'multifamily'
  return 'single_family'
}
/**
 * mv_map_market_sales row -> (candidate, identity) for normalizeCandidate.
 * Buyer identity: the recorded deed buyer name when present; otherwise a labelled
 * synthetic entity name ONLY where the canonical corpus itself records an investor
 * (deed investor flag), a cash purchase, or an entity owner of record linked to that
 * sale (the same three bases v3.1 and its truth set use). Anything else stays
 * identity-unresolved (V3 then demotes it from pricing unless MLS).
 */
export function canonicalRowToCandidate(r, subject) {
  const mls = r.source === 'mls'
  const ownerEntity = r.owner_linked === true && r.owner_corporate === true
  let name = r.buyer ? String(r.buyer) : null
  let basis = name ? 'recorded_buyer_name' : null
  if (!name && r.is_investor) { name = 'RECORDED INVESTOR BUYER LLC'; basis = 'synthetic_recorded_investor_flag' }
  else if (!name && ownerEntity) { name = 'OWNER OF RECORD ENTITY LLC'; basis = 'synthetic_owner_entity_linked_to_sale' }
  else if (!name && r.is_cash_purchase) { name = 'RECORDED CASH BUYER LLC'; basis = 'synthetic_recorded_cash_purchase' }
  const corporate = Boolean(r.is_investor || ownerEntity || r.is_cash_purchase || (r.buyer_kind && /corp|llc|company|entity|trust/i.test(r.buyer_kind)))
  const c = {
    comp_id: r.comp_id, property_id: r.property_id, address: r.address, zip: r.zip, city: r.city, state: r.state,
    latitude: num(r.lat), longitude: num(r.lng), asset_class: assetClassOf(r), property_type: r.property_type,
    units_count: num(r.units) > 0 ? num(r.units) : null, sqft: num(r.sqft), beds: num(r.beds), baths: num(r.baths), year_built: num(r.year_built),
    sale_price: num(r.price), sale_date: day(r.sold_on), mls_sold_price: mls ? num(r.price) : null, mls_sold_date: mls ? day(r.sold_on) : null,
    building_condition: null, distance_miles: Math.round(miles(num(subject.latitude), num(subject.longitude), num(r.lat), num(r.lng)) * 100) / 100,
    similarity_score: null,
  }
  const raw = name || r.doc_type ? { id: r.comp_id, owner_name: name, is_corporate_owner: corporate, document_type: r.doc_type ?? '', sale_price: num(r.price), mls_sold_price: c.mls_sold_price, subdivision_name: r.subdivision_name ?? null } : null
  const out = normalizeCandidate(c, raw, null)
  out.estimated_repair_cost = num(r.estimated_repair_cost)
  out.estimated_value = num(r.estimated_value)
  out._canonical = { buyer_basis: basis, source: r.source, buyer_class: r.buyer_class ?? null }
  return out
}
// Rank like the RPC (asset band, similarity, recency) and keep its 100-candidate contract.
function rpcLikeRank(subject, cands) {
  const s = subject
  const sim = (c) => 100 - Math.min(35, (Math.abs((c.building_square_feet ?? 0) - (s.sqft ?? 0)) / Math.max(s.sqft ?? 1, 1)) * 35)
    - Math.min(15, Math.abs((c.total_bedrooms ?? 0) - (s.beds ?? 0)) * 5) - Math.min(15, Math.abs((c.total_baths ?? 0) - (s.baths ?? 0)) * 5)
    - Math.min(20, Math.abs((c.year_built ?? 0) - (s.year_built ?? 0)) / 5)
  return cands.map((c) => ({ c, k: sim(c) })).sort((a, b) => b.k - a.k || String(b.c.sale_date).localeCompare(String(a.c.sale_date)) || a.c.distance_miles - b.c.distance_miles)
    .slice(0, 100).map((x) => ({ ...x.c, similarity_score: Math.max(0, Math.round(x.k * 100) / 100) }))
}
async function canonicalCandidates(subject, asOf) {
  const win = v3Window(subject)
  const mf = subject.asset_family === 'multifamily'
  const rows = await sql(mf ? CANON_MF_SQL : CANON_SQL, [num(subject.latitude), num(subject.longitude), win.radius, monthsBefore(asOf, win.months), asOf, 6000])
  const kept = rows.filter((r) => String(r.property_id) !== String(subject.property_id) && r.is_arms_length !== false && !(num(r.portfolio_size) >= 2))
    .map((r) => canonicalRowToCandidate(r, subject)).filter((c) => c.distance_miles <= win.radius)
  const top = rpcLikeRank(subject, kept)
  return { candidates: top, diagnostics: { candidate_count: top.length, read_rows: rows.length, truncated: rows.length >= 6000, retrieval_tier: `canonical_mv_map_market_sales_${win.radius}mi_${win.months}mo_top100`,
    buyer_basis: top.reduce((o, c) => { const k = c._canonical.buyer_basis ?? 'unresolved'; o[k] = (o[k] ?? 0) + 1; return o }, {}),
    newest_sale: top.map((c) => c.sale_date).sort().pop() ?? null } }
}

function v3Summary(d, loaded) {
  const v = d.evidence?.v3 ?? d.v3 ?? null
  if (!v) return { error: 'no_v3_block' }
  const u = v.universes ?? {}
  const pick = (k) => (u[k]?.available ? { mid: u[k].mid, p25: u[k].p25 ?? null, n: u[k].comp_count ?? u[k].sample_size ?? u[k].independent_count ?? null, cls: u[k].value_classification, conf: u[k].confidence } : null)
  const co = v.cash_offer ?? {}
  return {
    execution_state: v.execution_state, value_classification: v.value_classification, final_confidence: v.final_confidence, family: v.family, lane: v.canonical_asset_lane,
    market_mid: v.reconciliation?.reconciled_market_value_mid ?? null, market_cls: v.reconciliation?.market_value_classification ?? null,
    exit_conservative: v.reconciliation?.conservative_investor_exit ?? null, exit_base: v.reconciliation?.base_investor_exit ?? null, exit_cls: v.reconciliation?.investor_exit_classification ?? null,
    exit_derived_from: v.reconciliation?.investor_exit_derived_from ?? null, dominant_model: v.reconciliation?.dominant_model ?? null, disagreement: v.reconciliation?.model_disagreement_score ?? null,
    universes: { retail: pick('RETAIL_MLS_VALUE'), investor: pick('LOCAL_INVESTOR_VALUE'), institutional: pick('INSTITUTIONAL_VALUE'), public: pick('PUBLIC_RECORD_ARM_LENGTH_VALUE'), anchor: pick('SUBJECT_ANCHOR_SCENARIO') },
    repair: { mid: v.repair?.repair_mid ?? null, source: v.repair?.repair_source ?? null, confidence: v.repair?.repair_confidence ?? null },
    cash: co.available ? { exit: co.conservative_buyer_exit, recommended: co.recommended_cash_offer, maximum: co.maximum_cash_offer, opening: co.opening_cash_offer, margin_pct: co.margin_pct_used, costs: co.cost_breakdown } : { unavailable: co.unavailable_reason ?? 'n/a' },
    authorized_recommended: v.offer_authorization?.authorized_recommended_offer ?? null,
    scenario_recommended: v.offer_authorization?.scenario_recommended_offer ?? null,
    primary_strategy: v.strategy_ranking?.primary_strategy ?? null,
    accepted: v.sample?.accepted ?? v.raw_accepted_transaction_count ?? null, clean_ess: v.clean_effective_sample_size ?? null,
    material_anomaly_reasons: (v.material_anomaly_reasons ?? []).slice(0, 6),
    surfaced_valuation_mid: d.valuation?.mid ?? null, surfaced_offer: d.offer?.recommended_cash_offer ?? null,
    loader: loaded?.diagnostics ?? null,
  }
}

function runV3(subject, loaded, nowDate, buyerPurchases) {
  // Engine comps for the V2 half of the call are the same candidates (V3 replaces them with its accepted set).
  const d = engine.calculateAcquisitionDecision({ subject, comps: loaded.candidates, buyerPurchases, now: nowDate, v3Enabled: true, v3CompCandidates: loaded.candidates, v3LoaderDiagnostics: loaded.diagnostics })
  return v3Summary(d, loaded)
}

// v3.1 (current mode only): identical to scripts/valuation-v3-shadow-backtest.mjs v3For.
const ENGINE_GATE_IGNORED = new Set(['outside_radius', 'sale_too_old', 'outside_zip_without_coordinates'])
async function v31For({ raw, subject, asOf, nowDate }) {
  const lat = num(subject.latitude); const lng = num(subject.longitude)
  const neighbors = await sql(v31.SUBJECT_GEO_SQL, [lat, lng])
  const [own] = await sql(`select situs_census_tract census_tract, subdivision_name, coalesce(property_address_county_name, property_county_name) county_name,
    lot_square_feet::float8 lot_sqft, units_count::float8 units, property_type from public.properties where property_id = $1`, [String(raw.property_id)])
  const geo = v31.resolveSubjectGeography({ own: own ?? {}, neighbors })
  const mfType = ['Multi-Family', 'Apartment', 'Duplex', 'Triplex', 'Quadruplex'].includes(own?.property_type)
  const units = num(own?.units) > 0 ? num(own.units) : null
  const s3 = { property_id: String(raw.property_id), latitude: lat, longitude: lng, sqft: subject.sqft, beds: subject.beds, baths: subject.baths, year_built: subject.year_built,
    estimated_repairs: subject.estimated_repairs, census_tract: geo.census_tract, fips: geo.fips, subdivision_name: geo.subdivision_name, lot_sqft: num(own?.lot_sqft),
    units: mfType || (units ?? 0) >= 2 ? units : null, condition: raw.building_condition ?? null }
  const lane = v31.laneFor(s3)
  const rows = await sql(lane.lane === 'sfr' ? v31.CANDIDATE_ROWS_SQL : v31.CANDIDATE_ROWS_MF_SQL, [lat, lng, lane.radiusMiles, monthsBefore(asOf, lane.months), asOf, lane.readCap])
  const gate = (row) => { const comp = engine.normalizePropertyFeatures(v2.toEngineComp(row, subject), { source: 'mv_map_market_sales', distance_miles: row.distance_miles, now: nowDate }); return engine.evaluateCompEligibility(subject, comp, nowDate).reasons.filter((r) => !ENGINE_GATE_IGNORED.has(r)) }
  const pre = v31.valueSubjectV3({ subject: s3, rows, asOf, gate })
  const SET_LEVEL = new Set([v31.V3_REASONS.outsideTopK, v31.V3_REASONS.outlierLow, v31.V3_REASONS.outlierHigh, v31.V3_REASONS.dominantOutlier])
  const live = new Set(pre.comps.filter((c) => c.status !== 'excluded' || (c.reasons ?? []).every((x) => SET_LEVEL.has(x))).map((c) => c.comp_id))
  const pairs = rows.filter((r) => live.has(r.comp_id)).slice(0, 800)
  const bulkRows = pairs.length ? await sql(v2.BULK_CONSIDERATION_SQL, [pairs.map((p) => day(p.sold_on)), pairs.map((p) => num(p.price))]) : []
  const res = v31.valueSubjectV3({ subject: s3, rows, bulkRows, asOf, gate })
  return { lane: lane.lane, value: res.value, offer: res.offer }
}

async function runSubject(frame) {
  const pid = String(frame.property_id)
  const current = MODE === 'current'
  const asOf = current ? day(addDays(new Date(), 1)) : day(frame.sold_on)
  const nowDate = current ? new Date() : addDays(asOf, -1)
  const raw = await engine.loadSubjectProperty(pid, { supabase })
  if (!raw) return { property_id: pid, frame, error: 'subject_not_found' }
  const subject = engine.normalizePropertyFeatures(raw, { source: 'properties', now: nowDate })
  if (!num(subject.latitude) || !num(subject.longitude)) return { property_id: pid, frame, error: 'subject_no_coordinates' }
  const out = { property_id: pid, frame, as_of: asOf, subject: { market: raw.market, address: subject.address, asset_family: subject.asset_family, units: subject.units ?? null, sqft: subject.sqft, estimated_repairs: subject.estimated_repairs, estimated_repair_cost: num(raw.estimated_repair_cost), building_condition: raw.building_condition ?? null } }
  // The engine's own buyer-demand read (buyer_purchase_events_v2, 250 latest in the zip), strictly before the as-of date.
  const buyerPurchases = ((await engine.loadBuyerPurchases(subject, { supabase, now: nowDate })) ?? []).filter((e) => !e.purchase_date || day(e.purchase_date) < asOf)
  out.buyer_purchases = buyerPurchases.length
  const leak = (cands) => cands.filter((c) => (c.sale_date && day(c.sale_date) >= asOf) || String(c.property_id) === pid).length
  try {
    const nat = await nativeCandidates(subject, asOf)
    out.native = runV3(subject, nat, nowDate, buyerPurchases)
    out.native.leak = current ? null : leak(nat.candidates)
    out.native.newest_sale = nat.candidates.map((c) => day(c.sale_date)).filter(Boolean).sort().pop() ?? null
  } catch (e) { out.native = { error: String(e?.message || e).slice(0, 300) } }
  try {
    const can = await canonicalCandidates(subject, asOf)
    out.canonical = runV3(subject, can, nowDate, buyerPurchases)
    out.canonical.leak = current ? null : leak(can.candidates)
  } catch (e) { out.canonical = { error: String(e?.message || e).slice(0, 300) } }
  if (current) {
    try { out.v31 = await v31For({ raw, subject, asOf, nowDate }) } catch (e) { out.v31 = { error: String(e?.message || e).slice(0, 300) } }
  }
  return out
}

let frames
if (args['frame-file']) frames = JSON.parse(readFileSync(args['frame-file'], 'utf8')).subjects
else if (args.ids) frames = String(args.ids).split(',').map((property_id) => ({ property_id }))
else { console.error('--frame-file or --ids required'); process.exit(2) }

let done = 0
let pauses = 0
for (const frame of frames) {
  const file = resolve(OUT_DIR, 'subjects', `${frame.property_id}.json`)
  if (args.resume && existsSync(file)) { done += 1; continue }
  if (done % 5 === 0) {
    let [load] = await sql(`select count(*) filter (where state = 'active' and backend_type = 'client backend' and pid <> pg_backend_pid() and application_name <> 'realtime_replication_connection')::int active from pg_stat_activity where datname = current_database()`)
    while (load.active > MAX_ACTIVE && pauses <= 30) { pauses += 1; console.error(`[load] active=${load.active} pause ${pauses}`); await sleep(60000); [load] = await sql(`select count(*) filter (where state = 'active' and backend_type = 'client backend' and pid <> pg_backend_pid())::int active from pg_stat_activity where datname = current_database()`) }
    if (pauses > 30) { console.error('[load] stopping'); break }
  }
  if (args['stop-at-utc'] && new Date().toISOString().slice(11, 16) >= args['stop-at-utc'] && new Date().toISOString().slice(11, 16) < '12:00') { console.error(`\n[window] stop at ${args['stop-at-utc']} UTC; resume later`); break }
  const watchdog = setTimeout(() => { console.error(`\n[watchdog] ${frame.property_id} exceeded ${SUBJECT_TIMEOUT_MS}ms; exiting for resume`); process.exit(3) }, SUBJECT_TIMEOUT_MS)
  let r
  try { r = await runSubject(frame) } catch (e) { r = { property_id: String(frame.property_id), frame, error: String(e?.message || e).slice(0, 300) } }
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
