/**
 * MAP WORLD STATE — where is the map looking, what time is it there, and can
 * sellers there be contacted right now?
 *
 * Nothing here decides policy. The place comes from LeadCommand's own
 * geography (mv_map_search_areas: the ZIP / city / market outlines of real
 * properties), the timezone from the canonical contact-window resolver
 * (`deriveTimezoneFromGeography`: state + ZIP → IANA, fail-closed), the window
 * bounds from the operator setting (system_control.queue_contact_window_*),
 * and "inside the window" from the canonical `isWithinContactWindow`. When the
 * geography cannot be resolved confidently the answer is "unknown" — never a
 * guessed zone and never a guessed window.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import {
  CONTACT_WINDOW_POLICY_VERSION,
  deriveTimezoneFromGeography,
  isWithinContactWindow,
} from '@/lib/domain/campaigns/contact-window-timezone.js'
import { addDays, localDate, zoneAbbr, zonedInstant } from '@/lib/domain/calendar/calendar-timeline-service.js'

const clean = (v) => String(v ?? '').trim()
const MIN = 60e3
const AREA_TTL_MS = 30 * MIN
const NEAREST_ZIP_MAX_KM = 45

/** The US zones LeadCommand operates in, with a reference city for broad-zoom clocks. */
export const US_ZONES = Object.freeze([
  { iana: 'America/New_York', label: 'Eastern', city: 'New York', lng: -74.006, lat: 40.7128 },
  { iana: 'America/Chicago', label: 'Central', city: 'Chicago', lng: -87.6298, lat: 41.8781 },
  { iana: 'America/Denver', label: 'Mountain', city: 'Denver', lng: -104.9903, lat: 39.7392 },
  { iana: 'America/Phoenix', label: 'Arizona', city: 'Phoenix', lng: -112.074, lat: 33.4484 },
  { iana: 'America/Los_Angeles', label: 'Pacific', city: 'Los Angeles', lng: -118.2437, lat: 34.0522 },
  { iana: 'America/Anchorage', label: 'Alaska', city: 'Anchorage', lng: -149.9003, lat: 61.2181 },
  { iana: 'Pacific/Honolulu', label: 'Hawaii', city: 'Honolulu', lng: -157.8583, lat: 21.3069 },
])

/* ── operator window ─────────────────────────────────────────────────────── */

const hhmm = (v, d) => (/^\d{1,2}:\d{2}$/.test(clean(v)) ? clean(v).padStart(5, '0') : d)

export async function readOperatorWindow(db) {
  const { data, error } = await db.from('system_control').select('key, value').in('key', ['queue_contact_window_start', 'queue_contact_window_end'])
  if (error) return null
  const m = Object.fromEntries((data || []).map((r) => [r.key, r.value]))
  return { start: hhmm(m.queue_contact_window_start, '08:00'), end: hhmm(m.queue_contact_window_end, '21:00') }
}

/**
 * Contact-window state at `now` for one IANA zone, using the canonical check.
 * Returns the next boundary as an absolute instant so a client can count down
 * without re-implementing the rule; it refetches when the boundary passes.
 */
export function contactWindowState(now, iana, window) {
  if (!iana || !window) return null
  const startHour = Number(window.start.split(':')[0])
  const endHour = Number(window.end.split(':')[0])
  const check = isWithinContactWindow(new Date(now), iana, startHour, endHour)
  if (check.reason === 'no_timezone' || check.reason === 'unreadable_local_time') return null
  const today = localDate(now, iana)
  const openToday = zonedInstant(today, window.start, iana)
  const closeToday = zonedInstant(today, window.end, iana)
  const nextOpen = check.reason === 'before_window' ? openToday : zonedInstant(addDays(today, 1), window.start, iana)
  return {
    policy_version: CONTACT_WINDOW_POLICY_VERSION,
    window: `${window.start}–${window.end}`,
    open: check.ok,
    reason: check.reason,
    closes_at: check.ok ? new Date(closeToday).toISOString() : null,
    next_open_at: check.ok ? null : new Date(nextOpen).toISOString(),
  }
}

/* ── place resolution ────────────────────────────────────────────────────── */

let areaCache = null
async function loadAreas(db, now) {
  if (areaCache && now - areaCache.at < AREA_TTL_MS) return areaCache.rows
  // PostgREST silently caps a response at 1000 rows and there are ~2,850 areas:
  // page until a short page, or the tail of the country is simply missing.
  const rows = []
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await db.from('mv_map_search_areas').select('kind, key, label, state, n, center_lat, center_lng, min_lat, max_lat, min_lng, max_lng').in('kind', ['zip', 'city', 'market', 'state']).order('kind').order('key').range(from, from + 999)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  areaCache = { at: now, rows }
  return areaCache.rows
}
export function _resetAreaCache() { areaCache = null }
/** The same cached geography, for other map services (camera-local timezones). */
export const loadMapAreas = (db, now = Date.now()) => loadAreas(db, now)

const km = (aLat, aLng, bLat, bLng) => {
  const r = Math.PI / 180
  const dLat = (bLat - aLat) * r
  const dLng = (bLng - aLng) * r
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}
const inside = (r, lat, lng, pad = 0) => lat >= r.min_lat - pad && lat <= r.max_lat + pad && lng >= r.min_lng - pad && lng <= r.max_lng + pad

function nearest(rows, kind, lat, lng, { maxKm = Infinity, preferInside = true } = {}) {
  let best = null
  for (const r of rows) {
    if (r.kind !== kind || !Number.isFinite(r.center_lat)) continue
    const d = km(lat, lng, r.center_lat, r.center_lng)
    const score = preferInside && inside(r, lat, lng) ? d * 0.25 : d
    if (d <= maxKm && (!best || score < best.score)) best = { row: r, d, score }
  }
  return best
}

/** Resolve the place under a point from LeadCommand's own property geography. */
export function resolvePlace(rows, lat, lng) {
  const zip = nearest(rows, 'zip', lat, lng, { maxKm: NEAREST_ZIP_MAX_KM })
  const state = zip?.row.state || rows.find((r) => r.kind === 'state' && inside(r, lat, lng))?.key || null
  const city = nearest(rows, 'city', lat, lng, { maxKm: 30 })
  const market = nearest(rows, 'market', lat, lng, { maxKm: 120 })
  return {
    zip: zip ? clean(zip.row.key) : null,
    zip_km: zip ? Math.round(zip.d * 10) / 10 : null,
    state: state ? clean(state).toUpperCase() : null,
    city: city ? clean(city.row.label).replace(/,\s*[A-Z]{2}$/, '') : null,
    market: market ? clean(market.row.label) : null,
    basis: zip ? 'nearest_property_zip' : state ? 'state_outline' : 'outside_leadcommand_geography',
  }
}

export async function getMapWorld({ lat, lng, now = Date.now() } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const la = Number(lat)
  const ln = Number(lng)
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return { ok: false, status: 400, error: 'lat_lng_required' }
  const [rows, window] = await Promise.all([loadAreas(db, now), readOperatorWindow(db)])
  const place = resolvePlace(rows, la, ln)
  const tz = place.state ? deriveTimezoneFromGeography(place.state, place.zip) : { label: null, iana: null, basis: 'no_state', confident: false }
  const iana = tz.confident ? tz.iana : null
  return {
    ok: true,
    at: new Date(now).toISOString(),
    place,
    timezone: iana ? { iana, abbr: zoneAbbr(iana), label: tz.label, basis: tz.basis } : { iana: null, basis: tz.basis, reason: place.state ? 'timezone_ambiguous_for_geography' : 'no_leadcommand_geography_here' },
    contact_window: iana && window ? contactWindowState(now, iana, window) : null,
  }
}

/** Broad zoom: every US zone's clock + window state, and each market's zone. */
export async function getMapWorldZones({ now = Date.now() } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const [rows, window] = await Promise.all([loadAreas(db, now), readOperatorWindow(db)])
  const zones = US_ZONES.map((z) => ({ ...z, abbr: zoneAbbr(z.iana), contact_window: window ? contactWindowState(now, z.iana, window) : null }))
  const byIana = new Map(zones.map((z) => [z.iana, z]))
  const markets = []
  for (const m of rows.filter((r) => r.kind === 'market' && Number.isFinite(r.center_lat))) {
    // A market's zone comes from where its properties actually are: the ZIP
    // nearest its centre, through the canonical resolver.
    const zip = nearest(rows, 'zip', m.center_lat, m.center_lng, { maxKm: 80 })
    const state = zip?.row.state || m.state
    const tz = state ? deriveTimezoneFromGeography(state, zip?.row.key) : null
    const iana = tz?.confident ? tz.iana : null
    markets.push({
      market: clean(m.label), key: clean(m.key), state: clean(state).toUpperCase() || null, properties: m.n,
      lat: m.center_lat, lng: m.center_lng,
      iana, abbr: iana ? zoneAbbr(iana) : null,
      contact_window: iana ? byIana.get(iana)?.contact_window || (window ? contactWindowState(now, iana, window) : null) : null,
    })
  }
  return { ok: true, at: new Date(now).toISOString(), window, zones, markets }
}
