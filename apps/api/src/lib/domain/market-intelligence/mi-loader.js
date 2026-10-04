/**
 * MARKET INTELLIGENCE: every database read, in one place (brief §41, §42).
 *
 * Read-only, bounded, sequential (concurrency 1):
 *   - a LOAD GUARD first: if prod is busy (> 12 active sessions, or any client
 *     query running > 10 s), the load is deferred and retried later.
 *   - the sales index: ONE consistent snapshot (REPEATABLE READ READ ONLY) of
 *     mv_map_market_sales through a server-side cursor over a sequential scan,
 *     fetched in chunks. No sorts, no group-bys, no person names or property
 *     ids. Measured: ~4.4 s for 665,288 rows.
 *   - small reference tables (thousands of rows each).
 *   - the seller universe for ONE state at a time (index on state).
 * Every statement runs with a 30 s statement_timeout (20 s for the universe).
 */
import { getPgPool, queryWithTimeout } from '@/lib/postgres/client.js'

export const MAX_ACTIVE_SESSIONS = 12
export const MAX_RUNNING_SECONDS = 10
const FETCH_ROWS = 25_000

const QUALIFIED_SQL = `coalesce(m.price > 0 and coalesce(m.portfolio_size, 1) < 2 and m.is_arms_length is distinct from false
  and coalesce(m.doc_type, '') !~* 'quit ?claim|gift|transfer on death|correction|re-recorded|public action', false)`

/** Column order = EXTRACT_COLUMNS in mi-sales-index.js. */
export const SALES_EXTRACT_SQL = `
select (m.sold_on - date '2000-01-01')::int as d,
       m.price::float8, m.ppsf::float8, m.units::float8, m.sqft::float8,
       m.property_type, m.state, m.zip, lower(btrim(m.city)) as city,
       m.lat, m.lng,
       (coalesce(m.is_investor, false)::int
        + (m.buyer_kind is not null)::int * 2
        + (m.is_cash_purchase is not null)::int * 4
        + coalesce(m.is_cash_purchase, false)::int * 8
        + coalesce(m.investor_inferred_current_owner, false)::int * 16
        + (${QUALIFIED_SQL})::int * 32
        + (m.source = 'mls')::int * 64
        + (coalesce(m.portfolio_size, 1) >= 2)::int * 128
        + coalesce(m.price > 0, false)::int * 256) as flags,
       m.buyer, m.buyer_class
  from public.mv_map_market_sales m`

export const FRESHNESS_SQL = `select max(m.sold_on)::text as max_sold_on,
  (select c.reltuples::bigint from pg_class c where c.oid = 'public.mv_map_market_sales'::regclass) as est_rows
  from public.mv_map_market_sales m`

export const LOAD_GUARD_SQL = `select count(*) filter (where state = 'active' and backend_type = 'client backend')::int as active,
  coalesce(max(extract(epoch from now() - query_start)) filter (where state = 'active' and backend_type = 'client backend' and pid <> pg_backend_pid()), 0)::int as longest
  from pg_stat_activity`

export const AUX_SQL = Object.freeze({
  searchAreas: `select kind, key, label, state, n, min_lat, max_lat, min_lng, max_lng, center_lat, center_lng from public.mv_map_search_areas`,
  markets: `select id, display_name, state from public.canonical_markets where is_active`,
  zipMarket: `select zip5, state, canonical_market_id from public.market_zip_membership where status = 'resolved'`,
  aliases: `select alias, state, canonical_market_id from public.market_aliases`,
  census: `select geo_id, geo_level, geo_name, state_code, county_name, city_name, county_geo_id, centroid_lat::float8, centroid_lng::float8, dataset, vintage,
             population::float8, households::float8, housing_units::float8, vacancy_rate::float8, renter_share::float8, owner_share::float8,
             median_household_income::float8, median_household_income_moe::float8, median_gross_rent::float8, median_year_built::float8,
             rent_burden::float8, units_2_4_share::float8, units_5plus_share::float8
             from public.exchange_market_fundamentals_cells`,
  parcelZipCounty: `select zip5 as zip, state, county_name as county, count(*)::int as n from comp_private.comp_properties
             where zip5 is not null and county_name is not null group by 1, 2, 3`,
  outlined: `select geo_level, substr(geo_id, strpos(geo_id, ':') + 1) as k from risk_private.geography_authoritative`,
  areaStats: `select kind, key, n, equity::float8, value::float8, year_built::float8, motivation::float8, distress::float8, tax_delinquent::float8, free_clear::float8 from public.mv_map_property_area_stats`,
  graphCoverage: `select measured_at::text, coverage from public.campaign_target_graph_coverage order by measured_at desc limit 1`,
})

export const UNIVERSE_SQL_COLUMNS = Object.freeze(['property_id', 'property_zip', 'city', 'county', 'market', 'property_type', 'units_count', 'sms_eligible', 'queue_eligible',
  'email_eligible', 'has_phone', 'true_post_contact_suppression', 'wrong_number', 'pending_prior_touch', 'active_queue_item', 'never_contacted', 'is_corporate_owner',
  'beds', 'baths', 'building_sqft', 'year_built', 'lot_sqft', 'total_loan_balance', 'ownership_years', 'equity_percent', 'estimated_value', 'phone_type'])

/** Column order = UNIVERSE_COLUMNS in mi-universe.js (via UNIVERSE_SQL_COLUMNS). */
export const UNIVERSE_SQL = `select property_id, property_zip, lower(btrim(property_city)) as city, lower(btrim(property_county_name)) as county, market,
  property_type, units_count::float8, sms_eligible, queue_eligible, email_eligible, canonical_e164 is not null as has_phone,
  true_post_contact_suppression, wrong_number, pending_prior_touch, active_queue_item, never_contacted, is_corporate_owner,
  beds::float8, baths::float8, building_sqft::float8, year_built, lot_sqft::float8, total_loan_balance::float8, ownership_years::float8,
  equity_percent::float8, estimated_value::float8, phone_type
  from public.campaign_target_graph where state = $1`

/** Decide whether a load may run now. Pure. */
export function loadAllowed(row) {
  const active = Number(row?.active) || 0
  const longest = Number(row?.longest) || 0
  if (active > MAX_ACTIVE_SESSIONS) return { ok: false, reason: `database busy (${active} active sessions)` }
  if (longest > MAX_RUNNING_SECONDS) return { ok: false, reason: `database busy (a query has run ${longest}s)` }
  return { ok: true }
}

export function createMarketIntelLoader(deps = {}) {
  const query = deps.query || queryWithTimeout
  const connect = deps.connect || (() => getPgPool().connect())

  async function guard() {
    const res = await query(LOAD_GUARD_SQL, [], 5_000)
    return loadAllowed(res?.rows?.[0])
  }

  async function freshness() {
    const res = await query(FRESHNESS_SQL, [], 10_000)
    const r = res?.rows?.[0] || {}
    return { max_sold_on: r.max_sold_on || null, est_rows: r.est_rows === null || r.est_rows === undefined ? null : Number(r.est_rows) }
  }

  /** Stream the sales MV into `onRows(arrayRows)`; reports progress. One consistent snapshot. */
  async function streamSales(onRows, onProgress) {
    const client = await connect()
    let total = 0
    try {
      // SET LOCAL inside the transaction: under a transaction pooler a bare SET can land on another backend.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query('SET LOCAL statement_timeout = 30000')
      await client.query(`DECLARE mi_sales NO SCROLL CURSOR FOR ${SALES_EXTRACT_SQL}`)
      for (;;) {
        const res = await client.query({ text: `FETCH ${FETCH_ROWS} FROM mi_sales`, rowMode: 'array' })
        const rows = res?.rows || []
        if (!rows.length) break
        onRows(rows)
        total += rows.length
        onProgress?.(total)
      }
      await client.query('COMMIT')
      return total
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* connection may be gone */ }
      throw error
    } finally {
      client.release?.()
    }
  }

  async function aux(name, timeoutMs = 30_000) {
    const res = await query(AUX_SQL[name], [], timeoutMs)
    return res?.rows || []
  }

  /** Array rows in UNIVERSE_COLUMNS order. (A config object + params would lose its values in pg, so map by name.) */
  async function universeForState(state) {
    const res = await query(UNIVERSE_SQL, [state], 20_000)
    return (res?.rows || []).map((r) => UNIVERSE_SQL_COLUMNS.map((k) => r[k]))
  }

  return { guard, freshness, streamSales, aux, universeForState }
}
