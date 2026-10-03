/**
 * INVESTOR PRESENCE — two separate signals, side by side, never blended.
 *
 *   purchases  investor PURCHASES: recorded sales in the window whose buyer is
 *              an investor (public.mv_map_market_sales.is_investor — a company
 *              buyer or an investor buyer archetype)
 *   entity     ENTITY OWNERSHIP now: properties whose latest recorded sale has
 *              no buyer name but whose current owner is a company
 *              (mv_map_market_sales.investor_inferred_current_owner)
 *
 * A purchase is an event in a window; entity ownership is a current state.
 * They are counted separately, returned separately and drawn separately; the
 * composite view shows both at once with a per-cell breakdown. There is no
 * combined score and no share of a mixed denominator.
 *
 * mv_map_market_sales is server-only (anon/authenticated revoked), so this
 * reads it with the API's direct Postgres connection behind the operator gate
 * of the route. Bounded: zoom ≥ 9.5, box ≤ 2° per side, grid aggregation, a
 * 20 s statement timeout, cached in memory per snapped box for 30 min.
 * NEVER throws.
 */
import { queryWithTimeout } from '@/lib/postgres/client.js'

export const PRESENCE_MIN_ZOOM = 9.5
export const PRESENCE_MAX_SPAN = 2
export const PRESENCE_WINDOWS = Object.freeze([12, 24])
const TTL = 30 * 60_000
const ERROR_TTL = 30_000
const MAX_ENTRIES = 80
const cache = new Map()
export function _resetPresenceCache() { cache.clear() }

/** Aggregation grid (degrees) for a zoom — cells stay a few dozen pixels wide. */
export function presenceGrid(zoom) {
  if (zoom >= 13) return 0.0025
  if (zoom >= 12) return 0.005
  if (zoom >= 11) return 0.01
  if (zoom >= 10) return 0.02
  return 0.04
}

export function parsePresenceRequest({ bbox, zoom, months } = {}) {
  const parts = String(bbox ?? '').split(',').map((s) => Number(s.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return { ok: false, reason: 'bad_bbox' }
  const [west, south, east, north] = parts
  if (!(west < east && south < north) || Math.abs(south) > 90 || Math.abs(north) > 90 || Math.abs(west) > 180 || Math.abs(east) > 180) return { ok: false, reason: 'bad_bbox' }
  const z = Number(zoom)
  const m = Number(months)
  return { ok: true, box: { west, south, east, north }, zoom: Number.isFinite(z) ? z : 0, months: PRESENCE_WINDOWS.includes(m) ? m : 24 }
}

const snap = (b, step) => ({
  west: +(Math.floor(b.west / step) * step).toFixed(5), south: +(Math.floor(b.south / step) * step).toFixed(5),
  east: +(Math.ceil(b.east / step) * step).toFixed(5), north: +(Math.ceil(b.north / step) * step).toFixed(5),
})

export const PRESENCE_SQL = `
  select floor(m.lng / $5)::int as gx, floor(m.lat / $5)::int as gy,
         avg(m.lat)::float8 as lat, avg(m.lng)::float8 as lng,
         count(*) filter (where m.sold_on >= $6::date)::int as sales,
         count(*) filter (where m.sold_on >= $6::date and m.is_investor)::int as investor_purchases,
         count(distinct m.property_id) filter (where m.investor_inferred_current_owner)::int as entity_owned,
         max(m.sold_on)::text as latest_sale_on
    from public.mv_map_market_sales m
   where m.lat between $1 and $2 and m.lng between $3 and $4
   group by 1, 2`

export function shapeCells(rows) {
  const cells = []
  let purchases = 0
  let entity = 0
  let sales = 0
  let latest = null
  for (const r of rows || []) {
    const c = {
      lat: Number(r.lat), lng: Number(r.lng),
      sales: Number(r.sales) || 0,
      investor_purchases: Number(r.investor_purchases) || 0,
      entity_owned: Number(r.entity_owned) || 0,
    }
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue
    if (r.latest_sale_on && (!latest || r.latest_sale_on > latest)) latest = r.latest_sale_on
    if (!c.investor_purchases && !c.entity_owned) continue
    purchases += c.investor_purchases
    entity += c.entity_owned
    sales += c.sales
    cells.push(c)
  }
  return { cells, totals: { sales_in_window: sales, investor_purchases: purchases, entity_owned: entity }, latest_sale_on: latest }
}

export async function getInvestorPresence(params = {}, deps = {}) {
  const now = deps.now ?? Date.now()
  const query = deps.query || queryWithTimeout
  const req = parsePresenceRequest(params)
  if (!req.ok) return { ok: false, status: 400, error: req.reason }
  const base = {
    ok: true,
    window_months: req.months,
    components: {
      purchases: { label: 'Investor purchases', basis: 'Recorded sales in the window with an investor buyer', source: 'Public record + MLS sales (mv_map_market_sales.is_investor)' },
      entity: { label: 'Entity-owned now', basis: 'Properties whose current owner is a company, where the latest sale names no buyer', source: 'Public record ownership (mv_map_market_sales.investor_inferred_current_owner)' },
    },
    scoring: 'none',
  }
  const span = Math.max(req.box.east - req.box.west, req.box.north - req.box.south)
  if (req.zoom < PRESENCE_MIN_ZOOM || span > PRESENCE_MAX_SPAN) return { ...base, mode: 'zoom_in', min_zoom: PRESENCE_MIN_ZOOM, cells: [] }
  const grid = presenceGrid(req.zoom)
  const box = snap(req.box, Math.max(grid * 4, 0.02))
  const key = `${box.west},${box.south},${box.east},${box.north}|${grid}|${req.months}`
  const hit = cache.get(key)
  if (hit && hit.expires > now) return { ...base, ...hit.value, grid_deg: grid, cached: true }
  const since = new Date(now)
  since.setUTCMonth(since.getUTCMonth() - req.months)
  let value
  try {
    const res = await query(PRESENCE_SQL, [box.south, box.north, box.west, box.east, grid, since.toISOString().slice(0, 10)], 20_000)
    value = { mode: 'cells', ...shapeCells(res?.rows) }
  } catch {
    value = { mode: 'unavailable', cells: [], reason: 'read_failed' }
  }
  cache.set(key, { value, expires: now + (value.mode === 'unavailable' ? ERROR_TTL : TTL) })
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value)
  return { ...base, ...value, grid_deg: grid, cached: false }
}
