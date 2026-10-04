#!/usr/bin/env node
/**
 * COMPS VALUATION POOL — SHADOW COMPARISON (read-only; owner decides).
 *
 * QUESTION. The acquisition engine prices every subject from the engine pool
 * (get_comp_candidates_for_subject -> v_recent_sold_comps -> buyer_comp_raw_v2,
 * newest sale 2026-05-08, frozen). The canonical recorded sales
 * (public.mv_map_market_sales over comp_private.comp_canonical_transactions,
 * through 2026-09-10, refreshed daily) are fresher. Is the frozen pool
 * overvaluing, or does the canonical adapter introduce a selection/ranking
 * defect? This script measures that. It does NOT switch anything.
 *
 * WRITE SAFETY. The Supabase client handed to the engine is wrapped in a guard
 * that throws on insert/upsert/update/delete and on any RPC outside an
 * allowlist; every call is logged and the audit is written with the output.
 * persistAcquisitionScore / scoreProperty / snapshot writers are never called.
 * Direct SQL runs in BEGIN READ ONLY with default_transaction_read_only = on
 * and statement_timeout = 30s.
 *
 * VARIANTS, per subject — the same engine (calculateAcquisitionDecision, V3
 * OFF as in production, comp integrity ON), the same subject, the same buyer
 * purchases and one fixed `now`; only the comp list changes:
 *   A_old            the engine's own loader (RPC pool + advanced comps).
 *   C_adapter        the 2026-10-04 smoke adapter: buyer-match-sales nearest
 *                    100 priced sales, thin `properties` overlay (no repair
 *                    estimate, no normalized class).
 *   C2_detail        C's sales with the engine's full detail columns from
 *                    `properties` where the sold parcel is a known property.
 *   C3_repair_neutral C2, but a comp with no repair estimate carries the
 *                    subject's (repair_difference = 0 instead of -subject).
 *   D_fair           canonical priced sales over the engine radius/window,
 *                    pre-ranked exactly like get_comp_candidates_for_subject
 *                    (asset rank, similarity, recency, distance; top 100),
 *                    full detail overlay, repair-neutral for unknowns.
 *   E_fair_frozen    D restricted to sales on/before the pool freeze date.
 *   F_fair_qualified D excluding is_arms_length = false and portfolio_size >= 2.
 * Attribution chain (log-ratio steps, they sum to A -> C):
 *   A -> E source/qualification at the same period, E -> D fresh sales,
 *   D -> C3 candidate selection (similarity pre-rank vs nearest-100),
 *   C3 -> C2 unknown repairs treated as 0, C2 -> C detail sparsity.
 *
 * SMOKE (2026-10-04, 1 subject, 273312064 Minneapolis SFR): newest selected
 *   comp 2026-04-21 -> 2026-08-17; mid $349.7K -> $228.9K (-34.5%); offer
 *   -50.5% (A_old vs C_adapter).
 *
 * DECISION GATES (proposed, for the owner):
 *   - median |delta mid| <= 5% and p90 <= 15% across the sample;
 *   - no tier flip toward a MORE aggressive offer without a fresher comp
 *     explaining it;
 *   - comp-backed coverage does not drop.
 *
 * USAGE (from apps/api):
 *   node scripts/comps-valuation-pool-shadow.mjs --subjects=273312064 --out-dir=/tmp/vs
 *   node scripts/comps-valuation-pool-shadow.mjs --subjects-file=frame.json --out-dir=/tmp/vs --pause-ms=700
 *   (legacy) --limit=40 --out=/tmp/comps-shadow.json picks recent scored subjects.
 * Credentials come from apps/api/.env.local and are never printed.
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
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL']) {
  if (!process.env[k] && fileEnv[k]) process.env[k] = fileEnv[k]
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_DB_URL) {
  console.error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL (apps/api/.env.local)')
  process.exit(2)
}
register('./tests/alias-loader.mjs', pathToFileURL(`${apiRoot}/`))

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true']
}))
const LIMIT = Math.max(1, Math.min(400, Number(args.limit ?? 40)))
const PAUSE = Math.max(0, Number(args['pause-ms'] ?? 500))
const NOW = new Date(args.now ?? Date.now())
const FREEZE = args.freeze ?? '2026-05-08'
const OUT_DIR = args['out-dir'] ?? null
const MAX_ACTIVE = Number(args['max-active'] ?? 12)

const { supabase: rawSupabase } = await import('../src/lib/supabase/client.js')
const engine = await import('../src/lib/acquisition/acquisitionDecisionEngine.js')
const { loadBuyerMatchSales } = await import('../src/lib/domain/buyer-match/buyer-match-sales.js')
const { engineSearchWindow, engineRulesFor } = await import('../src/lib/domain/comp-intelligence/comps-engine-rules.js')

// ── write guard ──────────────────────────────────────────────────────────────
const AUDIT = { calls: [], blocked: [] }
const WRITE_METHODS = new Set(['insert', 'upsert', 'update', 'delete'])
const RPC_ALLOW = new Set(['get_comp_candidates_for_subject'])
function guardBuilder(builder, table) {
  return new Proxy(builder, {
    get(target, prop, recv) {
      if (WRITE_METHODS.has(prop)) {
        return () => { AUDIT.blocked.push(`${table}.${String(prop)}`); throw new Error(`read_only_guard:${table}.${String(prop)}`) }
      }
      const v = Reflect.get(target, prop, recv)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}
const supabase = new Proxy(rawSupabase, {
  get(target, prop, recv) {
    if (prop === 'from') return (table) => { AUDIT.calls.push(`from:${table}`); return guardBuilder(target.from(table), table) }
    if (prop === 'rpc') {
      return (name, params, opts) => {
        AUDIT.calls.push(`rpc:${name}`)
        if (!RPC_ALLOW.has(name)) { AUDIT.blocked.push(`rpc:${name}`); throw new Error(`read_only_guard:rpc:${name}`) }
        return target.rpc(name, params, opts)
      }
    }
    if (prop === 'schema' || prop === 'storage' || prop === 'functions' || prop === 'channel') {
      return () => { AUDIT.blocked.push(String(prop)); throw new Error(`read_only_guard:${String(prop)}`) }
    }
    const v = Reflect.get(target, prop, recv)
    return typeof v === 'function' ? v.bind(target) : v
  },
})

// ── read-only SQL ───────────────────────────────────────────────────────────
const pgc = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
await pgc.connect()
await pgc.query("SET statement_timeout = '30s'")
await pgc.query('SET default_transaction_read_only = on')
async function sql(text, params = []) {
  AUDIT.calls.push('sql')
  await pgc.query('BEGIN READ ONLY')
  try {
    await pgc.query("SET LOCAL statement_timeout = '30s'")
    const r = await pgc.query(text, params)
    return r.rows
  } finally {
    await pgc.query('ROLLBACK')
  }
}
async function dbLoad() {
  const [r] = await sql(`select count(*) filter (where state = 'active' and backend_type = 'client backend' and pid <> pg_backend_pid() and application_name <> 'realtime_replication_connection')::int active,
    count(*) filter (where state = 'active' and backend_type = 'client backend' and application_name <> 'realtime_replication_connection' and now() - query_start > interval '10 seconds')::int long_q
    from pg_stat_activity where datname = current_database()`)
  return r
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const pct = (a, b) => (num(a) && num(b) ? Math.round(((b - a) / a) * 1000) / 10 : null)
const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
const quantile = (xs, q) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  return v[Math.min(v.length - 1, Math.floor(q * (v.length - 1)))]
}
const isoDate = (d) => (d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null)

// The engine's comp detail columns (comps-engine-rules ENGINE_COMP_DETAIL_COLUMNS),
// minus every sale field: `properties` sale_* / mls_* describe the parcel's own
// last sale, not the canonical transaction being comped.
const DETAIL_COLS = [
  'property_address_county_name', 'normalized_asset_class', 'property_class', 'lot_square_feet', 'effective_year_built',
  'building_condition', 'construction_type', 'estimated_repair_cost', 'renovation_level_classification', 'estimated_value',
  'comp_confidence_score', 'subdivision_name', 'school_district_name', 'zoning', 'flood_zone', 'building_quality',
  'exterior_walls', 'interior_walls', 'floor_cover', 'roof_cover', 'roof_type', 'basement', 'garage', 'pool', 'porch',
  'patio', 'deck', 'driveway', 'stories', 'style', 'air_conditioning', 'heating_type', 'heating_fuel_type', 'sewer', 'water',
]
const THIN_DETAIL_COLS = ['property_address_county_name', 'lot_square_feet', 'building_condition', 'construction_type',
  'subdivision_name', 'zoning', 'garage', 'pool', 'stories', 'effective_year_built', 'estimated_value']

/** get_comp_candidates_for_subject similarity, verbatim, for reporting on any comp. */
function rpcSimilarity(s, c) {
  const z = (v) => num(v) ?? 0
  const cls = (r) => r.cls
  return Math.max(0, Math.round((100
    - Math.min(35, Math.abs(z(c.sqft) - z(s.sqft)) / Math.max(num(s.sqft) ?? 1, 1) * 35)
    - Math.min(15, Math.abs(z(c.beds) - z(s.beds)) * 5)
    - Math.min(15, Math.abs(z(c.baths) - z(s.baths)) * 5)
    - Math.min(20, Math.abs(z(c.year_built) - z(s.year_built)) / 5)
    - (cls(c) === cls(s) ? 0 : 20)) * 100) / 100)
}
function rpcClass(propertyType, units) {
  const t = String(propertyType ?? '')
  if (t === 'Vacant Land') return 'land'
  if (t === 'Other') return 'other'
  if (t === 'Apartment' && (num(units) ?? 0) >= 5) return 'apartment'
  if (['Multi-Family', 'Apartment', 'Duplex', 'Triplex', 'Quadruplex'].includes(t)) return 'multifamily'
  if ((num(units) ?? 0) >= 2) return 'multifamily'
  return 'single_family'
}

async function loadDetail(pids, cols) {
  const ids = [...new Set(pids.filter(Boolean).map(String))]
  if (!ids.length) return new Map()
  const rows = await sql(`select property_id, ${cols.join(', ')} from properties where property_id = any($1::text[])`, [ids])
  return new Map(rows.map((r) => [String(r.property_id), r]))
}

/** C_adapter: the smoke adapter, unchanged (thin overlay). */
async function adapterSales(subject) {
  const win = engineSearchWindow(subject.asset_family)
  const { sales, meta } = await loadBuyerMatchSales({
    lat: subject.latitude, lng: subject.longitude, radius_miles: win.radiusMiles, months: win.months, priced: 'only', limit: 100,
  }, { db: supabase, now: NOW })
  return { sales: sales.filter((s) => s.is_priced), meta, win }
}
function saleToComp(s, detail, hasDetail = Boolean(detail)) {
  return {
    ...(detail ?? {}),
    id: s.comp_id,
    property_id: s.property_id,
    property_address_full: s.address,
    property_address_city: s.city,
    property_address_state: s.state,
    property_address_zip: s.zip,
    latitude: s.lat,
    longitude: s.lng,
    sale_price: s.price,
    sale_date: s.sold_on,
    mls_sold_price: s.sale_source === 'mls' ? s.price : null,
    mls_sold_date: s.sale_source === 'mls' ? s.sold_on : null,
    property_type: s.property_type,
    units_count: s.units,
    total_bedrooms: s.beds,
    total_baths: s.baths,
    building_square_feet: s.sqft,
    year_built: s.year_built,
    distance_miles: s.distance_miles,
    source: 'mv_map_market_sales',
    _canon: { txn_id: s.txn_id ?? null, doc_type: s.doc_type ?? null, is_arms_length: s.is_arms_length ?? null, portfolio_size: s.portfolio_size ?? null, price_source: s.price_source ?? null, observations: s.observations ?? null, sources: s.sources ?? null, buyer_class: s.buyer_class ?? null, sale_source: s.sale_source, has_detail: hasDetail, rpc_similarity: s.rpc_similarity ?? null, rank: s.rank ?? null },
  }
}
function repairNeutral(comp, subject) {
  if (num(comp.estimated_repair_cost) !== null) return comp
  return { ...comp, estimated_repair_cost: subject.estimated_repairs, _repair_neutralized: true }
}

/** D/E/F: canonical priced sales pre-ranked exactly like get_comp_candidates_for_subject. */
const FAIR_SQL = `
with sf as (
  select s.*, case when s.cls in ('multifamily','apartment') then 'multi' else 'single' end fam,
    greatest(coalesce(nullif(s.units, 0), 1), 1)::numeric fam_units
  from (
    select property_id, latitude::float8 lat, longitude::float8 lng, normalized_asset_class cls, building_square_feet sqft,
      total_bedrooms beds, total_baths baths, year_built::numeric yb, units_count::numeric units
      from v_recent_sold_comps where property_id = $1
    union all
    select property_id, latitude::float8, longitude::float8,
      case when property_type = 'Apartment' and coalesce(units_count, 0) >= 5 then 'apartment'
           when property_type in ('Multi-Family','Apartment','Duplex','Triplex','Quadruplex') then 'multifamily'
           when coalesce(units_count, 0) >= 2 then 'multifamily' else 'single_family' end,
      building_square_feet, total_bedrooms, total_baths, year_built::numeric, units_count::numeric
      from properties where property_id = $1 and not exists (select 1 from v_recent_sold_comps where property_id = $1)
    limit 1) s
),
c as (
  select m.comp_id, m.txn_id, m.source msrc, m.sold_on, m.price, m.lat, m.lng, m.property_id, m.address, m.city, m.state, m.zip,
    m.property_type mtype, m.beds mbeds, m.baths mbaths, m.sqft msqft, m.year_built myb, m.units munits, m.estimated_value mev,
    m.portfolio_size, m.doc_type, m.is_arms_length, m.buyer_class, m.observations, m.sources, m.price_source,
    case when m.property_type = 'Vacant Land' then 'land' when m.property_type = 'Other' then 'other'
         when m.property_type = 'Apartment' and coalesce(m.units, 0) >= 5 then 'apartment'
         when m.property_type in ('Multi-Family','Apartment') then 'multifamily'
         when coalesce(m.units, 0) >= 2 then 'multifamily' else 'single_family' end ccls,
    3958.8 * acos(least(1, greatest(-1, cos(radians(sf.lat)) * cos(radians(m.lat)) * cos(radians(m.lng) - radians(sf.lng))
      + sin(radians(sf.lat)) * sin(radians(m.lat))))) dist,
    sf.cls, sf.sqft, sf.beds, sf.baths, sf.yb, sf.fam, sf.fam_units
  from mv_map_market_sales m cross join sf
  where m.price > 0 and m.sold_on >= $2::date
    and m.lat between sf.lat - $3::float8 / 68.5 and sf.lat + $3::float8 / 68.5
    and m.lng between sf.lng - $3::float8 / (68.5 * greatest(cos(radians(sf.lat)), 0.05))
                  and sf.lng + $3::float8 / (68.5 * greatest(cos(radians(sf.lat)), 0.05))
    and m.property_id is distinct from sf.property_id
),
r as (
  select c.*,
    greatest(0, round((100
      - least(35, abs(coalesce(msqft, 0) - coalesce(sqft, 0)) / greatest(coalesce(sqft, 1), 1) * 35)
      - least(15, abs(coalesce(mbeds, 0) - coalesce(beds, 0)) * 5)
      - least(15, abs(coalesce(mbaths, 0) - coalesce(baths, 0)) * 5)
      - least(20, abs(coalesce(myb, 0) - coalesce(yb, 0)) / 5)
      - case when ccls = cls then 0 else 20 end)::numeric, 2)) sim,
    case when ccls in ('land','other') and cls not in ('land','other') then 3
         when (case when ccls in ('multifamily','apartment') then 'multi' else 'single' end) <> fam then 2
         when fam = 'single' and coalesce(nullif(munits, 0), 1) <= 1 then 0
         when fam = 'multi' and greatest(coalesce(nullif(munits, 0), 1), 1) / fam_units between 0.35 and 2.75 then 0
         else 1 end arank,
    (coalesce(is_arms_length, true) and coalesce(portfolio_size, 1) < 2) qual
  from c where dist <= $3::float8
),
k as (
  select r.*,
    row_number() over (order by arank, sim desc, sold_on desc, dist) rk_all,
    row_number() over (partition by sold_on <= $4::date order by arank, sim desc, sold_on desc, dist) rk_period,
    row_number() over (partition by qual order by arank, sim desc, sold_on desc, dist) rk_qual,
    count(*) over () n_priced,
    count(*) filter (where sold_on > $4::date) over () n_after_freeze,
    count(*) filter (where arank = 0) over () n_same_family,
    count(*) filter (where arank = 0 and sold_on > $4::date) over () n_same_family_after,
    count(*) filter (where is_arms_length is false) over () n_non_arms,
    count(*) filter (where portfolio_size >= 2) over () n_portfolio,
    count(*) filter (where dist <= 1) over () n_within_1mi
  from r
)
select k.*, ${DETAIL_COLS.map((c) => `p.${c} as d_${c}`).join(', ')}, (p.property_id is not null) has_detail
from k left join properties p on p.property_id = k.property_id
where rk_all <= 100 or (sold_on <= $4::date and rk_period <= 100) or (qual and rk_qual <= 100)`

function fairRowToComp(r) {
  const detail = {}
  if (r.has_detail) for (const c of DETAIL_COLS) detail[c] = r[`d_${c}`]
  if (detail.estimated_value == null) detail.estimated_value = r.mev
  const sale = {
    comp_id: r.comp_id, txn_id: r.txn_id, property_id: r.property_id, address: r.address, city: r.city, state: r.state, zip: r.zip,
    lat: num(r.lat), lng: num(r.lng), price: num(r.price), sold_on: isoDate(r.sold_on), sale_source: r.msrc === 'mls' ? 'mls' : 'public_record',
    property_type: r.mtype, units: num(r.munits), beds: num(r.mbeds), baths: num(r.mbaths), sqft: num(r.msqft), year_built: num(r.myb),
    distance_miles: Math.round(num(r.dist) * 100) / 100, doc_type: r.doc_type, is_arms_length: r.is_arms_length, portfolio_size: r.portfolio_size,
    price_source: r.price_source, observations: r.observations, sources: r.sources, buyer_class: r.buyer_class,
    rpc_similarity: num(r.sim), rank: { all: num(r.rk_all), period: num(r.rk_period), qual: num(r.rk_qual), asset_rank: num(r.arank) },
  }
  // Off-universe parcels (no `properties` row) still carry the MV's own estimated_value,
  // so the engine's nominal-transfer ratio can run on them.
  return saleToComp(sale, r.has_detail ? detail : (detail.estimated_value != null ? { estimated_value: detail.estimated_value } : null), Boolean(r.has_detail))
}

const CENSUS_SQL = `
with b as (select $1::float8 lat, $2::float8 lng, $3::float8 r)
select
  (select count(*) from mv_map_market_sales m, b where m.sold_on >= $4::date and (m.price is null or m.price <= 0)
     and m.lat between b.lat - b.r/68.5 and b.lat + b.r/68.5 and m.lng between b.lng - b.r/(68.5*greatest(cos(radians(b.lat)),0.05)) and b.lng + b.r/(68.5*greatest(cos(radians(b.lat)),0.05)))::int mv_unpriced_bbox,
  (select count(*) from v_recent_sold_comps c, b where c.is_usable_comp and c.sale_date >= $4::date
     and c.latitude between b.lat - b.r/68.5 and b.lat + b.r/68.5 and c.longitude between b.lng - b.r/(68.5*greatest(cos(radians(b.lat)),0.05)) and b.lng + b.r/(68.5*greatest(cos(radians(b.lat)),0.05)))::int pool_usable_bbox`

function sinceDate(months) {
  const d = new Date(NOW.getTime())
  d.setUTCMonth(d.getUTCMonth() - months)
  return d.toISOString().slice(0, 10)
}

// ── per-comp record (selected, rejected and why) ────────────────────────────
function compRecord(entry, status, subjectSim) {
  const c = entry.comp ?? {}
  const raw = c.raw ?? {}
  const canon = raw._canon ?? null
  const repair = (entry.price_adjustments ?? []).find((a) => a.basis === 'repair_difference')
  return {
    id: c.source_id ?? null,
    property_id: c.property_id ?? null,
    city: c.city ?? null, state: c.state ?? null, zip: c.zip ?? null,
    source: raw.source ?? c.source ?? null,
    sale_source: c.sale_source ?? null,
    sale_date: isoDate(c.sale_date),
    price: c.sale_price ?? null,
    priced: num(c.sale_price) > 0,
    distance_miles: c.distance_miles ?? null,
    rpc_similarity: num(raw.similarity_score) ?? canon?.rpc_similarity ?? (subjectSim ? subjectSim(c) : null),
    comp_score: entry.comp_score ?? null,
    comp_confidence: entry.comp_confidence ?? null,
    data_completeness: entry.data_completeness ?? null,
    recency_score: entry.recency_score ?? null,
    weight: entry.weight ?? null,
    ppsf: num(c.sale_price) && num(c.sqft) ? Math.round(c.sale_price / c.sqft) : null,
    property_type: raw.property_type ?? null,
    asset_type: c.asset_type ?? null,
    asset_class: c.asset_class ?? null,
    beds: c.beds ?? null, baths: c.baths ?? null, sqft: c.sqft ?? null, year_built: c.year_built ?? null, units: c.units ?? null,
    estimated_value: c.estimated_value ?? null,
    comp_estimated_repairs: c.estimated_repairs ?? null,
    repair_neutralized: Boolean(raw._repair_neutralized),
    condition: c.condition ?? null,
    condition_adjustment: repair ? repair.amount : null,
    adjusted_price: entry.adjusted_price ?? null,
    dedupe_group: canon ? { comp_id: c.source_id, txn_id: canon.txn_id, observations: canon.observations, sources: canon.sources } : { pool_id: c.source_id, key: `${c.property_id}|${isoDate(c.sale_date)}|${c.sale_price}` },
    canonical: canon ? { doc_type: canon.doc_type, is_arms_length: canon.is_arms_length, portfolio_size: canon.portfolio_size, price_source: canon.price_source, has_detail: canon.has_detail, rank: canon.rank } : null,
    status,
    reasons: status === 'selected' ? ['selected_top_weight'] : (entry.reasons ?? []),
  }
}

function summarizeRun(d, subjectSim) {
  const sel = d.selected_comps ?? []
  const recs = [
    ...sel.map((e) => compRecord(e, 'selected', subjectSim)),
    ...(d.rejected_comps ?? []).map((e) => compRecord(e, 'rejected', subjectSim)),
  ]
  const s = recs.filter((r) => r.status === 'selected')
  const rejectionCounts = {}
  for (const r of recs) if (r.status === 'rejected') for (const why of r.reasons) rejectionCounts[why] = (rejectionCounts[why] ?? 0) + 1
  const w = s.reduce((a, r) => a + (r.weight ?? 0), 0)
  const repAdj = s.length && w ? s.reduce((a, r) => a + (r.condition_adjustment ?? 0) * (r.weight ?? 0), 0) / w : null
  const rawWeighted = s.length && w ? s.reduce((a, r) => a + (r.price ?? 0) * (r.weight ?? 0), 0) / w : null
  return {
    summary: {
      low: num(d.valuation?.low), mid: num(d.valuation?.mid), high: num(d.valuation?.high),
      offer: num(d.offer?.recommended_cash_offer), floor: num(d.offer?.minimum_acceptable_offer),
      valuation_confidence: num(d.valuation?.confidence), confidence: num(d.confidence),
      tier: d.decision?.tier ?? null, method: d.valuation?.calculation?.method ?? null,
      candidates: recs.length, selected: s.length,
      newest: s.map((r) => r.sale_date).filter(Boolean).sort().pop() ?? null,
      oldest: s.map((r) => r.sale_date).filter(Boolean).sort()[0] ?? null,
      selected_after_freeze: s.filter((r) => r.sale_date && r.sale_date > FREEZE).length,
      median_distance: median(s.map((r) => r.distance_miles)),
      median_similarity: median(s.map((r) => r.rpc_similarity)),
      median_comp_score: median(s.map((r) => r.comp_score)),
      median_completeness: median(s.map((r) => r.data_completeness)),
      median_ppsf: median(s.map((r) => r.ppsf)),
      median_price: median(s.map((r) => r.price)),
      weighted_raw_price: rawWeighted === null ? null : Math.round(rawWeighted),
      weighted_condition_adjustment: repAdj === null ? null : Math.round(repAdj),
      selected_mls: s.filter((r) => r.sale_source === 'mls_sold').length,
      selected_non_arms: s.filter((r) => r.canonical?.is_arms_length === false).length,
      selected_portfolio: s.filter((r) => (r.canonical?.portfolio_size ?? 1) >= 2).length,
      selected_with_detail: s.filter((r) => r.canonical ? r.canonical.has_detail : true).length,
      selected_repair_neutralized: s.filter((r) => r.repair_neutralized).length,
      rejection_counts: rejectionCounts,
    },
    comps: recs,
  }
}

// ── subject selection ───────────────────────────────────────────────────────
async function pickSubjects() {
  if (args['subjects-file']) {
    const f = JSON.parse(readFileSync(args['subjects-file'], 'utf8'))
    return (Array.isArray(f) ? f : f.subjects).map((x) => (typeof x === 'object' ? x : { property_id: String(x) }))
  }
  if (args.subjects) return String(args.subjects).split(',').map((s) => ({ property_id: s.trim() })).filter((s) => s.property_id)
  const { data, error } = await supabase.from('property_acquisition_scores')
    .select('property_id, computed_at').order('computed_at', { ascending: false }).limit(LIMIT * 3)
  if (error) throw error
  return [...new Set((data ?? []).map((r) => String(r.property_id)))].map((property_id) => ({ property_id, stratum: 'recent_scored' }))
}

async function runSubject(frame) {
  const pid = frame.property_id
  const raw = await engine.loadSubjectProperty(pid, { supabase })
  if (!raw) return { property_id: pid, frame, error: 'subject_not_found' }
  const subject = engine.normalizePropertyFeatures(raw, { source: 'properties', now: NOW })
  if (!num(subject.latitude) || !num(subject.longitude)) return { property_id: pid, frame, error: 'subject_no_coordinates' }
  const deps = { supabase, now: NOW }
  const rules = engineRulesFor(subject.asset_family)
  const since = sinceDate(rules.months)
  const subjSimBase = { sqft: subject.sqft, beds: subject.beds, baths: subject.baths, year_built: subject.year_built, cls: rpcClass(raw.property_type, raw.units_count) }
  const subjectSim = (c) => rpcSimilarity(subjSimBase, { sqft: c.sqft, beds: c.beds, baths: c.baths, year_built: c.year_built, cls: rpcClass(c.raw?.property_type, c.units) })

  // Sequential, bounded reads (no fan-out).
  const oldComps = await engine.loadComparableProperties(subject, deps)
  const buyerPurchases = await engine.loadBuyerPurchases(subject, deps)
  const adapter = await adapterSales(subject)
  const thin = await loadDetail(adapter.sales.map((s) => s.property_id), THIN_DETAIL_COLS)
  const full = await loadDetail(adapter.sales.map((s) => s.property_id), DETAIL_COLS)
  const fairRows = await sql(FAIR_SQL, [pid, since, rules.radiusMiles, FREEZE])
  const [census] = await sql(CENSUS_SQL, [subject.latitude, subject.longitude, rules.radiusMiles, since])
  const oldPids = [...new Set(oldComps.map((c) => c.property_id).filter(Boolean).map(String))]
  const sameSales = oldPids.length
    ? await sql('select comp_id, property_id, sold_on, price, source, is_arms_length, portfolio_size from mv_map_market_sales where property_id = any($1::text[])', [oldPids])
    : []

  // Ground truth where it exists: the subject's own recorded sales (any date).
  const subjectSales = await sql('select comp_id, sold_on, price, source, doc_type, is_arms_length, portfolio_size from mv_map_market_sales where property_id = $1 order by sold_on desc', [pid])
  const fair = fairRows.map((r) => ({ r, comp: fairRowToComp(r) }))
  const neutral = (c) => repairNeutral(c, subject)
  const lists = {
    A_old: oldComps,
    C_adapter: adapter.sales.map((s) => saleToComp(s, thin.get(String(s.property_id)))),
    C2_detail: adapter.sales.map((s) => saleToComp(s, full.get(String(s.property_id)))),
    C3_repair_neutral: adapter.sales.map((s) => neutral(saleToComp(s, full.get(String(s.property_id))))),
    D_fair: fair.filter((x) => num(x.r.rk_all) <= 100).map((x) => neutral(x.comp)),
    E_fair_frozen: fair.filter((x) => isoDate(x.r.sold_on) <= FREEZE && num(x.r.rk_period) <= 100).map((x) => neutral(x.comp)),
    F_fair_qualified: fair.filter((x) => x.r.qual && num(x.r.rk_qual) <= 100).map((x) => neutral(x.comp)),
  }
  const variants = {}
  for (const [name, comps] of Object.entries(lists)) {
    const d = engine.calculateAcquisitionDecision({ subject, comps, buyerPurchases, now: NOW, v3Enabled: false })
    variants[name] = summarizeRun(d, subjectSim)
  }

  // Same-sale test: each old-pool candidate vs the canonical record of the same parcel.
  const byPid = new Map()
  for (const s of sameSales) { const k = String(s.property_id); if (!byPid.has(k)) byPid.set(k, []); byPid.get(k).push(s) }
  const selectedOldIds = new Set(variants.A_old.comps.filter((c) => c.status === 'selected').map((c) => c.id))
  const sameSale = oldComps.map((c) => {
    const date = isoDate(c.mls_sold_date || c.sale_date)
    const price = num(c.mls_sold_price) || num(c.sale_price)
    const cands = (byPid.get(String(c.property_id)) ?? []).map((s) => ({ ...s, sold_on: isoDate(s.sold_on), days: date ? Math.abs((new Date(isoDate(s.sold_on)) - new Date(date)) / 86400000) : null }))
    const best = cands.filter((s) => s.days !== null && s.days <= 31).sort((a, b) => a.days - b.days)[0] ?? null
    return {
      pool_id: String(c.id), property_id: c.property_id, selected: selectedOldIds.has(String(c.id)), pool_date: date, pool_price: price,
      canonical: best ? { comp_id: best.comp_id, sold_on: best.sold_on, price: num(best.price), days: best.days, source: best.source, is_arms_length: best.is_arms_length } : null,
      price_ratio_pool_over_canonical: best && num(best.price) > 0 && price ? Math.round((price / num(best.price)) * 1000) / 1000 : null,
      parcel_sales_in_canonical: cands.length,
    }
  })

  // Dedupe test inside the fair candidate set: one parcel+date more than once = double count.
  const dupKey = new Map()
  for (const x of fair) { const k = `${x.r.property_id}|${isoDate(x.r.sold_on)}`; dupKey.set(k, (dupKey.get(k) ?? 0) + 1) }
  const parcelDateDuplicates = [...dupKey.values()].filter((n) => n > 1).length
  const priceDate = new Map()
  for (const x of fair) { const k = `${isoDate(x.r.sold_on)}|${num(x.r.price)}`; priceDate.set(k, (priceDate.get(k) ?? 0) + 1) }

  // Staleness test: same-family priced canonical sales near the subject, PPSF before vs after the freeze.
  const sameFam = fair.filter((x) => num(x.r.arank) === 0 && num(x.r.msqft) > 0 && x.r.qual)
  const ppsfOf = (xs) => median(xs.map((x) => num(x.r.price) / num(x.r.msqft)))
  const f0 = fairRows[0] ?? {}
  return {
    property_id: pid,
    frame,
    subject: {
      market: raw.market ?? null, address: subject.address, zip: subject.zip, asset_type: subject.asset_type, family: subject.asset_family,
      property_type: raw.property_type ?? null, units: num(raw.units_count), beds: subject.beds, baths: subject.baths, sqft: subject.sqft,
      year_built: subject.year_built, estimated_value: subject.estimated_value, estimated_repairs: subject.estimated_repairs,
      condition: subject.condition, lat: subject.latitude, lng: subject.longitude,
    },
    window: { radius_miles: rules.radiusMiles, months: rules.months, since, freeze: FREEZE, adapter_radius: adapter.win.radiusMiles, adapter_months: adapter.win.months, adapter_meta: adapter.meta },
    density: {
      old_pool_raw: oldComps.length,
      pool_usable_bbox: census?.pool_usable_bbox ?? null,
      canonical_priced_in_radius: num(f0.n_priced) ?? 0,
      canonical_priced_after_freeze: num(f0.n_after_freeze) ?? 0,
      canonical_same_family: num(f0.n_same_family) ?? 0,
      canonical_same_family_after_freeze: num(f0.n_same_family_after) ?? 0,
      canonical_non_arms: num(f0.n_non_arms) ?? 0,
      canonical_portfolio: num(f0.n_portfolio) ?? 0,
      canonical_within_1mi: num(f0.n_within_1mi) ?? 0,
      canonical_unpriced_bbox: census?.mv_unpriced_bbox ?? null,
      adapter_rows_read: adapter.meta?.rows_read ?? null,
      adapter_radius_used: adapter.meta?.radius_miles ?? null,
      adapter_truncated: adapter.meta?.truncated ?? null,
    },
    tests: {
      subject_sales: subjectSales.map((x) => ({ ...x, sold_on: isoDate(x.sold_on), price: num(x.price) })),
      same_sale: sameSale,
      fair_parcel_date_duplicates: parcelDateDuplicates,
      fair_price_date_clusters: [...priceDate.values()].filter((n) => n > 1).length,
      staleness: {
        same_family_qualified_n_before: sameFam.filter((x) => isoDate(x.r.sold_on) <= FREEZE).length,
        same_family_qualified_n_after: sameFam.filter((x) => isoDate(x.r.sold_on) > FREEZE).length,
        ppsf_before_freeze: ppsfOf(sameFam.filter((x) => isoDate(x.r.sold_on) <= FREEZE)),
        ppsf_after_freeze: ppsfOf(sameFam.filter((x) => isoDate(x.r.sold_on) > FREEZE)),
      },
    },
    variants,
  }
}

// ── main ────────────────────────────────────────────────────────────────────
const frames = await pickSubjects()
if (OUT_DIR) mkdirSync(resolve(OUT_DIR, 'subjects'), { recursive: true })
const results = []
let loadStops = 0
for (const frame of frames) {
  if (!args['subjects-file'] && !args.subjects && results.length >= LIMIT) break
  if (OUT_DIR && args.resume && existsSync(resolve(OUT_DIR, 'subjects', `${frame.property_id}.json`))) {
    results.push(JSON.parse(readFileSync(resolve(OUT_DIR, 'subjects', `${frame.property_id}.json`), 'utf8')))
    continue
  }
  if (results.length % 5 === 0) {
    let load = await dbLoad()
    while (load.active > MAX_ACTIVE || load.long_q > 0) {
      loadStops += 1
      console.error(`\n[load] active=${load.active} long=${load.long_q} — pausing 30s (${loadStops})`)
      if (loadStops > 20) { console.error('[load] still high after 10 min — stopping'); break }
      await sleep(30000)
      load = await dbLoad()
    }
    if (loadStops > 20) break
  }
  let r
  try {
    r = await runSubject(frame)
  } catch (e) {
    r = { property_id: frame.property_id, frame, error: String(e?.message || e).slice(0, 300) }
  }
  results.push(r)
  if (OUT_DIR) writeFileSync(resolve(OUT_DIR, 'subjects', `${frame.property_id}.json`), JSON.stringify(r))
  process.stdout.write(r.error ? 'x' : '.')
  if (results.length % 50 === 0) process.stdout.write(`${results.length}\n`)
  if (PAUSE) await sleep(PAUSE)
}
await pgc.end()

const ok = results.filter((r) => !r.error && r.variants?.A_old?.summary?.mid && r.variants?.C_adapter?.summary?.mid)
const delta = (r, v) => ({ mid: pct(r.variants.A_old.summary.mid, r.variants[v].summary.mid), offer: pct(r.variants.A_old.summary.offer, r.variants[v].summary.offer) })
const summary = {
  generatedAt: new Date().toISOString(), now: NOW.toISOString(), freeze: FREEZE, subjects: results.length, compared: ok.length,
  errors: results.filter((r) => r.error).length,
  writeAudit: { blocked: AUDIT.blocked, calls: Object.fromEntries([...new Set(AUDIT.calls)].map((k) => [k, AUDIT.calls.filter((x) => x === k).length])) },
  medianMidDeltaPct: Object.fromEntries(['C_adapter', 'C2_detail', 'C3_repair_neutral', 'D_fair', 'E_fair_frozen', 'F_fair_qualified'].map((v) => [v, quantile(ok.map((r) => delta(r, v).mid), 0.5)])),
}
if (args.out) writeFileSync(args.out, JSON.stringify({ summary, results }, null, 2))
if (OUT_DIR) writeFileSync(resolve(OUT_DIR, 'run-summary.json'), JSON.stringify(summary, null, 2))
console.log(`\n${JSON.stringify(summary, null, 2)}`)
