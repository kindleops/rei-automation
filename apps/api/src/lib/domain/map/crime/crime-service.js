/**
 * CRIME CONTEXT — reported incidents in a viewport, from the city open-data
 * portals in crime-sources.js. A context overlay, never a score.
 *
 *   GET /api/cockpit/map/crime?bbox=w,s,e,n&zoom=z&days=30
 *
 * Answers, honestly:
 *   mode 'incidents'  points (category, offense, family, day) + category counts
 *   mode 'zoom_in'    the box is too large for incident points (z < 11)
 *   covered:false     no connected city meets this viewport → "not covered"
 * Each source reports its own count, newest day it has published, whether we
 * hit its row cap, and its attribution / licence. A city that failed answers
 * `unavailable`, never zero.
 *
 * Bounded: zoom ≥ 11, box ≤ 0.6° per side, ≤ 2,000 rows per source, window
 * 7 / 30 / 90 days. Results are cached in memory ~10 min per snapped box.
 * Nothing is persisted. NEVER throws.
 */
import { createHash } from 'node:crypto'
import { makeProviderFetch, scrubProviderError } from '../world-providers/provider-fetch.js'
import { CRIME_NOT_COVERED, CRIME_SOURCES } from './crime-sources.js'

export const CRIME_MIN_ZOOM = 11
export const CRIME_MAX_SPAN = 0.6
export const CRIME_ROW_CAP = 2000
export const CRIME_WINDOWS = Object.freeze([7, 30, 90])
const TTL = 10 * 60_000
const ERROR_TTL = 60_000
const MAX_ENTRIES = 120
const DAY = 86_400_000

const cache = new Map()
export function _resetCrimeCache() { cache.clear() }

const overlaps = (a, b) => a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south

export function parseCrimeRequest({ bbox, zoom, days } = {}) {
  const parts = String(bbox ?? '').split(',').map((s) => Number(s.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return { ok: false, reason: 'bad_bbox' }
  const [west, south, east, north] = parts
  if (!(west < east && south < north) || Math.abs(south) > 90 || Math.abs(north) > 90 || Math.abs(west) > 180 || Math.abs(east) > 180) return { ok: false, reason: 'bad_bbox' }
  const z = Number(zoom)
  const d = Number(days)
  return { ok: true, box: { west, south, east, north }, zoom: Number.isFinite(z) ? z : 0, days: CRIME_WINDOWS.includes(d) ? d : 30 }
}

/** Snap outward to a 0.05° grid so nearby pans share one cache entry and one upstream query. */
export function snapBox(b, step = 0.05) {
  const f = (v) => Math.floor(v / step) * step
  const c = (v) => Math.ceil(v / step) * step
  return { west: +f(b.west).toFixed(4), south: +f(b.south).toFixed(4), east: +c(b.east).toFixed(4), north: +c(b.north).toFixed(4) }
}

const publicSource = (s) => ({
  source_id: s.source_id, city: s.city, state: s.state, publisher: s.publisher,
  attribution: s.attribution, licence: s.licence, terms_url: s.terms_url, dataset_url: s.dataset_url,
  lag_note: s.lag_note, location_note: s.location_note,
})

/** Every city we read, for the Layers row and the legend (no hosts). */
export function crimeCoverage() {
  return { sources: CRIME_SOURCES.map(publicSource), not_covered: CRIME_NOT_COVERED }
}

const opaque = (key) => createHash('sha1').update(String(key)).digest('hex').slice(0, 14)

async function readSource(s, box, sinceMs, { fetchImpl }) {
  const fetch = makeProviderFetch({ ...s, image_hosts: [] }, { fetchImpl, timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024 })
  const body = await fetch.json(s.url({ box, sinceMs, limit: CRIME_ROW_CAP }))
  const rows = s.rows(body)
  const seen = new Map()
  for (const r of rows) {
    const n = s.normalize(r)
    if (!n || n.lat < box.south || n.lat > box.north || n.lng < box.west || n.lng > box.east) continue
    if (!seen.has(n.key)) seen.set(n.key, n)
  }
  return { incidents: [...seen.values()], received: rows.length, truncated: rows.length >= CRIME_ROW_CAP }
}

export async function getCrimeInView(params = {}, deps = {}) {
  const now = deps.now ?? Date.now()
  const fetchImpl = deps.fetchImpl || globalThis.fetch
  const sources = deps.sources || CRIME_SOURCES
  const req = parseCrimeRequest(params)
  if (!req.ok) return { ok: false, status: 400, error: req.reason }
  const inView = sources.filter((s) => overlaps(s.bounds, req.box))
  const base = {
    ok: true,
    generated_at: new Date(now).toISOString(),
    window_days: req.days,
    covered: inView.length > 0,
    sources: inView.map(publicSource),
    not_covered: CRIME_NOT_COVERED.filter(() => !inView.length),
    scoring: 'none', // reported incidents only — never a safety score
  }
  if (!inView.length) return { ...base, mode: 'not_covered', incidents: [], categories: [] }
  const span = Math.max(req.box.east - req.box.west, req.box.north - req.box.south)
  if (req.zoom < CRIME_MIN_ZOOM || span > CRIME_MAX_SPAN) return { ...base, mode: 'zoom_in', min_zoom: CRIME_MIN_ZOOM, incidents: [], categories: [] }

  const box = snapBox(req.box)
  const key = `${box.west},${box.south},${box.east},${box.north}|${req.days}|${inView.map((s) => s.source_id).join('+')}`
  const hit = cache.get(key)
  if (hit && hit.expires > now) return { ...base, ...hit.value, cached: true }

  const sinceMs = now - req.days * DAY
  const settled = await Promise.all(inView.map(async (s) => {
    try { return { s, ok: true, ...(await readSource(s, box, sinceMs, { fetchImpl })) } } catch (error) { return { s, ok: false, error: scrubProviderError(error?.message) } }
  }))
  const incidents = []
  const perSource = []
  const unavailable = []
  for (const r of settled) {
    if (!r.ok) { unavailable.push({ source_id: r.s.source_id, city: r.s.city, reason: r.error }); continue }
    let latest = null
    for (const i of r.incidents) {
      if (i.occurred_on && (!latest || i.occurred_on > latest)) latest = i.occurred_on
      incidents.push({ id: opaque(i.key), source_id: r.s.source_id, category: i.category, offense: i.offense, family: i.family, occurred_on: i.occurred_on, lat: i.lat, lng: i.lng })
    }
    perSource.push({ source_id: r.s.source_id, city: r.s.city, count: r.incidents.length, latest_on: latest, truncated: r.truncated })
  }
  const counts = new Map()
  for (const i of incidents) {
    const k = `${i.family}|${i.category}`
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  const categories = [...counts.entries()].map(([k, count]) => { const [family, category] = k.split('|'); return { family, category, count } }).sort((a, b) => b.count - a.count)
  const value = { mode: 'incidents', incidents, categories, per_source: perSource, ...(unavailable.length ? { unavailable } : {}) }
  cache.set(key, { value, expires: now + (unavailable.length && !perSource.length ? ERROR_TTL : TTL) })
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value)
  return { ...base, ...value, cached: false }
}
