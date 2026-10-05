/**
 * CRIME CONTEXT — reported incidents in a viewport, from the city open-data
 * portals in crime-sources.js. A context overlay, never a score.
 *
 *   GET /api/cockpit/map/crime?bbox=w,s,e,n&zoom=z&days=7|14|30|all&cats=violent,drugs
 *
 * Answers, honestly:
 *   mode 'incidents'  points (category, offense, glyph type, filter cat, day,
 *                     local time when the city publishes one) + counts per
 *                     cat and per type IN VIEW (before the cat filter, so the
 *                     panel can show what a switched-off category holds)
 *   mode 'zoom_in'    the box is too large for incident points (z < 11)
 *   covered:false     no connected city meets this viewport → "not covered"
 * Each source reports its own count, newest day it has published, whether we
 * hit its row cap, and its attribution / licence. A city that failed answers
 * `unavailable`, never zero.
 *
 * Bounded: zoom ≥ 11, box ≤ 0.6° per side, ≤ 2,000 rows per source (newest
 * first), window 7 / 14 / 30 days or 'all' (everything the city publishes
 * for the box — still newest 2,000 per city). The upstream read is cached in
 * memory ~10 min per snapped box + window; the category filter is applied to
 * the cached set, so a category toggle never re-reads a city. Nothing is
 * persisted. NEVER throws.
 */
import { createHash } from 'node:crypto'
import { makeProviderFetch, scrubProviderError } from '../world-providers/provider-fetch.js'
import { CRIME_NOT_COVERED, CRIME_SOURCES as BASE_SOURCES } from './crime-sources.js'
import { CITY_CRIME_SOURCES, CITY_NOT_COVERED } from './crime-sources-cities.js'
import { CRIME_CATS, CRIME_TYPES, classifyCrime, parseCats } from './crime-taxonomy.js'

export const CRIME_MIN_ZOOM = 11
export const CRIME_MAX_SPAN = 0.6
export const CRIME_ROW_CAP = 2000
/** Day windows; 'all' = no lower date bound (still box-, zoom- and row-capped). 90 stays accepted for old clients. */
export const CRIME_WINDOWS = Object.freeze([7, 14, 30, 90])
export const CRIME_WINDOW_KEYS = Object.freeze(['7', '14', '30', 'all'])
const TTL = 10 * 60_000
const ERROR_TTL = 60_000
const MAX_ENTRIES = 120
const DAY = 86_400_000

/** Every connected city: the original three + the 2026-10-05 expansion. */
export const CRIME_SOURCES = Object.freeze([...BASE_SOURCES, ...CITY_CRIME_SOURCES])
/** Cities checked and not drawn, with why (some carry their extent so a view over them can say so). */
export const NOT_COVERED = Object.freeze([...CRIME_NOT_COVERED, ...CITY_NOT_COVERED])

const cache = new Map()
export function _resetCrimeCache() { cache.clear() }

const overlaps = (a, b) => a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south

function notCoveredFor(box, connected) {
  const here = NOT_COVERED.filter((c) => c.bounds && overlaps(c.bounds, box))
  const list = here.length ? here : connected ? [] : NOT_COVERED
  return list.map(({ city, state, reason }) => ({ city, state, reason }))
}

export function parseCrimeRequest({ bbox, zoom, days, cats } = {}) {
  const parts = String(bbox ?? '').split(',').map((s) => Number(s.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return { ok: false, reason: 'bad_bbox' }
  const [west, south, east, north] = parts
  if (!(west < east && south < north) || Math.abs(south) > 90 || Math.abs(north) > 90 || Math.abs(west) > 180 || Math.abs(east) > 180) return { ok: false, reason: 'bad_bbox' }
  const z = Number(zoom)
  const d = Number(days)
  const all = String(days ?? '').trim().toLowerCase() === 'all'
  return { ok: true, box: { west, south, east, north }, zoom: Number.isFinite(z) ? z : 0, days: all ? 'all' : CRIME_WINDOWS.includes(d) ? d : 30, cats: parseCats(cats) }
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
  return { sources: CRIME_SOURCES.map(publicSource), not_covered: NOT_COVERED.map(({ city, state, reason }) => ({ city, state, reason })) }
}

const opaque = (key) => createHash('sha1').update(String(key)).digest('hex').slice(0, 14)

async function readSource(s, box, sinceMs, { fetchImpl, now = Date.now() }) {
  const fetch = makeProviderFetch({ ...s, image_hosts: [] }, { fetchImpl, timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024 })
  // sinceMs null = 'all': no lower bound; the row cap (newest first) still bounds it.
  const q = { box, sinceMs, limit: CRIME_ROW_CAP }
  // Most sources are one query; a city that splits its feed by layer (Houston) is a bounded few.
  const reqs = typeof s.urls === 'function' ? s.urls(q).slice(0, 4) : [{ url: s.url(q), tag: null }]
  const cap = Math.min(CRIME_ROW_CAP, s.max_rows || CRIME_ROW_CAP)
  const seen = new Map()
  let received = 0
  let truncated = false
  // A future day is a data-entry error in the city's feed (Atlanta 2124, Milwaukee 2027): never drawn.
  const tomorrow = new Date(now + DAY).toISOString().slice(0, 10)
  for (const { url, tag } of reqs) {
    const body = await fetch.json(url)
    const rows = s.rows(body)
    received += rows.length
    if (rows.length >= cap || body?.exceededTransferLimit) truncated = true
    for (const r of rows) {
      const n = s.normalize(tag ? Object.assign(r, { __tag: tag }) : r)
      if (!n || n.lat < box.south || n.lat > box.north || n.lng < box.west || n.lng > box.east) continue
      if (n.occurred_on && n.occurred_on > tomorrow) continue
      if (!seen.has(n.key)) seen.set(n.key, n)
    }
  }
  return { incidents: [...seen.values()], received, truncated }
}

/** Counts per cat and per type, every cat and type present (zeros kept so the panel never guesses). */
export function crimeCounts(incidents) {
  const cats = Object.fromEntries(CRIME_CATS.map((c) => [c, 0]))
  const types = Object.fromEntries(CRIME_TYPES.map((t) => [t, 0]))
  for (const i of incidents) { cats[i.cat] = (cats[i.cat] || 0) + 1; types[i.type] = (types[i.type] || 0) + 1 }
  return { cats, types }
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
    cats_filter: req.cats ? [...req.cats] : null,
    covered: inView.length > 0,
    sources: inView.map(publicSource),
    // Cities in view we checked and could not connect, with why — or, with nothing in view, the full list.
    not_covered: notCoveredFor(req.box, inView.length),
    scoring: 'none', // reported incidents only — never a safety score
  }
  if (!inView.length) return { ...base, mode: 'not_covered', incidents: [], categories: [] }
  const span = Math.max(req.box.east - req.box.west, req.box.north - req.box.south)
  if (req.zoom < CRIME_MIN_ZOOM || span > CRIME_MAX_SPAN) return { ...base, mode: 'zoom_in', min_zoom: CRIME_MIN_ZOOM, incidents: [], categories: [] }

  const box = snapBox(req.box)
  const key = `${box.west},${box.south},${box.east},${box.north}|${req.days}|${inView.map((s) => s.source_id).join('+')}`
  const hit = cache.get(key)
  const value = hit && hit.expires > now ? hit.value : await readAll(inView, box, req.days, now, fetchImpl)
  if (!(hit && hit.expires > now)) {
    cache.set(key, { value, expires: now + (value.unavailable?.length && !value.per_source.length ? ERROR_TTL : TTL) })
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value)
  }
  // The viewport, not the snapped box, bounds what is drawn and counted.
  const inBox = value.incidents.filter((i) => i.lat >= req.box.south && i.lat <= req.box.north && i.lng >= req.box.west && i.lng <= req.box.east)
  const counts = crimeCounts(inBox)
  const shown = req.cats ? inBox.filter((i) => req.cats.has(i.cat)) : inBox
  return { ...base, mode: 'incidents', incidents: shown, in_view: inBox.length, counts, categories: categoryCounts(shown), per_source: value.per_source, ...(value.unavailable ? { unavailable: value.unavailable } : {}), cached: Boolean(hit && hit.expires > now) }
}

function categoryCounts(incidents) {
  const counts = new Map()
  for (const i of incidents) {
    const k = `${i.family}|${i.cat}|${i.type}|${i.category}`
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  return [...counts.entries()].map(([k, count]) => { const [family, cat, type, category] = k.split('|'); return { family, cat, type, category, count } }).sort((a, b) => b.count - a.count)
}

/** One upstream read per source for a snapped box + window. Never throws. */
async function readAll(inView, box, days, now, fetchImpl) {
  const sinceMs = days === 'all' ? null : now - days * DAY
  const settled = await Promise.all(inView.map(async (s) => {
    try { return { s, ok: true, ...(await readSource(s, box, sinceMs, { fetchImpl, now })) } } catch (error) { return { s, ok: false, error: scrubProviderError(error?.message) } }
  }))
  const incidents = []
  const perSource = []
  const unavailable = []
  for (const r of settled) {
    if (!r.ok) { unavailable.push({ source_id: r.s.source_id, city: r.s.city, reason: r.error }); continue }
    let latest = null
    for (const i of r.incidents) {
      if (i.occurred_on && (!latest || i.occurred_on > latest)) latest = i.occurred_on
      const { type, cat } = classifyCrime(i)
      incidents.push({ id: opaque(i.key), source_id: r.s.source_id, category: i.category, offense: i.offense, family: i.family, type, cat, occurred_on: i.occurred_on, occurred_at: i.occurred_at ?? null, lat: i.lat, lng: i.lng })
    }
    perSource.push({ source_id: r.s.source_id, city: r.s.city, count: r.incidents.length, latest_on: latest, truncated: r.truncated })
  }
  return { incidents, per_source: perSource, ...(unavailable.length ? { unavailable } : {}) }
}
