/**
 * LEADCOMMAND CAMERA NETWORK — the canonical camera.
 *
 * Every provider (a state DOT, a 511 system, a regional ITS centre, a city) is
 * translated into this one shape by its adapter. Downstream — the store, the
 * API, the Map — nothing knows which provider a camera came from except
 * through `provider_id` and that provider's registry entry. A field a provider
 * does not publish stays null; nothing is inferred to fill it.
 *
 * Freshness is per provider cadence, never one universal rule: a camera that
 * refreshes every 20 s is stale long before one that refreshes every 5 min.
 */

export const FEED_TYPES = Object.freeze(['STILL_IMAGE', 'REFRESHING_STILL', 'MJPEG', 'HLS', 'VIDEO_STREAM', 'PROVIDER_PAGE_ONLY', 'UNAVAILABLE'])
export const CAMERA_STATUS = Object.freeze(['LIVE', 'STALE', 'OFFLINE', 'UNKNOWN', 'MAINTENANCE', 'BLOCKED_BY_PROVIDER'])
export const COVERAGE_STATUS = Object.freeze(['FULL', 'PARTIAL', 'METRO_ONLY', 'METADATA_ONLY', 'NO_PUBLIC_FEED', 'UNKNOWN'])
export const DIRECTIONS = Object.freeze(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'BOTH'])

const clean = (v) => (v === null || v === undefined ? '' : String(v).trim())
const finite = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * Stable LeadCommand id for a provider's camera. The same device from the same
 * provider always gets the same id across refreshes, so a selection, a URL or
 * a corridor position survives a metadata pull.
 */
export function cameraIdFor(providerId, externalId) {
  const p = clean(providerId)
  // URL-safe by construction ([A-Za-z0-9._~-] plus the ':' separator), so an id
  // survives a path segment without any percent-escapes of its own.
  const e = clean(externalId).replace(/\s+/g, '_').replace(/[^A-Za-z0-9._~-]/g, (c) => `_x${c.charCodeAt(0).toString(16)}`)
  if (!/^[a-z0-9_]{3,64}$/.test(p) || !e) return null
  return `${p}:${e}`.slice(0, 200)
}

/** "cam id" → provider id; null when the id is not ours. */
export function providerOfCameraId(cameraId) {
  const m = /^([a-z0-9_]{3,64}):(.+)$/.exec(clean(cameraId))
  return m ? m[1] : null
}

const DIR_WORDS = [
  [/^(n|nb|n\/b|north|northbound|north\s*bound)$/i, 'N'],
  [/^(s|sb|s\/b|south|southbound|south\s*bound)$/i, 'S'],
  [/^(e|eb|e\/b|east|eastbound|east\s*bound)$/i, 'E'],
  [/^(w|wb|w\/b|west|westbound|west\s*bound)$/i, 'W'],
  [/^(ne|northeast|north\s*east|northeastbound)$/i, 'NE'],
  [/^(nw|northwest|north\s*west|northwestbound)$/i, 'NW'],
  [/^(se|southeast|south\s*east|southeastbound)$/i, 'SE'],
  [/^(sw|southwest|south\s*west|southwestbound)$/i, 'SW'],
  [/^(both|both\s*directions|all|all\s*directions|nb\/sb|sb\/nb|eb\/wb|wb\/eb|n\/s|e\/w)$/i, 'BOTH'],
]

/**
 * Provider direction → 8-point compass (or BOTH). Accepts words ("Northbound"),
 * abbreviations ("NB", "N/B") and headings in degrees. Anything else is null:
 * "Inner Loop" or a blank is not a direction we can honestly draw.
 */
export function normalizeDirection(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number' || /^\s*\d+(\.\d+)?\s*$/.test(String(raw))) {
    const deg = finite(raw)
    if (deg === null || deg < 0 || deg > 360) return null
    return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((deg % 360) / 45) % 8]
  }
  const s = clean(raw)
  if (!s) return null
  for (const [re, dir] of DIR_WORDS) if (re.test(s)) return dir
  return null
}

const OFFLINE_WORDS = /(offline|out\s*of\s*service|disabled|inactive|down|not\s*available|unavailable|error|failed|no\s*signal|false|^0$)/i
const LIVE_WORDS = /^(online|active|enabled|in\s*service|ok|operational|available|up|true|1|live|normal)$/i
const MAINT_WORDS = /(maint|repair|construction)/i
const BLOCKED_WORDS = /(blocked|restricted|suppressed|private|withheld|turned\s*away|incident\s*block)/i

/**
 * Provider status → canonical. "Blocked by provider" is a real state (agencies
 * turn cameras away during incidents); it is not the same as offline. Anything
 * unrecognised is UNKNOWN — never LIVE by default.
 */
export function normalizeStatus(raw) {
  if (raw === true) return 'LIVE'
  if (raw === false) return 'OFFLINE'
  const s = clean(raw)
  if (!s) return 'UNKNOWN'
  if (BLOCKED_WORDS.test(s)) return 'BLOCKED_BY_PROVIDER'
  if (MAINT_WORDS.test(s)) return 'MAINTENANCE'
  if (LIVE_WORDS.test(s)) return 'LIVE'
  if (OFFLINE_WORDS.test(s)) return 'OFFLINE'
  return 'UNKNOWN'
}

/**
 * The road a camera watches, in one canonical spelling so a corridor can be
 * followed: "I 35W", "IH-35W", "Interstate 35W" → "I-35W"; "US Hwy 169" →
 * "US-169". Other roads keep the provider's own name.
 */
export function canonicalRoad(raw) {
  const s = clean(raw).replace(/\s+/g, ' ')
  if (!s) return null
  let m = /\b(?:I|IH|Interstate)[\s-]*(\d{1,3})\s*([NSEW])?\b/i.exec(s)
  if (m) return `I-${m[1]}${m[2] ? m[2].toUpperCase() : ''}`
  m = /\b(?:US|U\.S\.)(?:\s*(?:Hwy|Highway|Route|Rte))?[\s-]*(\d{1,3})\s*([A-Z])?\b/i.exec(s)
  if (m) return `US-${m[1]}${m[2] ? m[2].toUpperCase() : ''}`
  return s.length > 80 ? s.slice(0, 80) : s
}

/** Corridor = one road in one state; the unit PREVIOUS / NEXT steps along. */
export function corridorKeyFor({ state, road }) {
  const r = canonicalRoad(road)
  const st = clean(state).toUpperCase()
  if (!r || !/^[A-Z]{2}$/.test(st)) return null
  return `${st}|${r}`
}

const km = (aLat, aLng, bLat, bLng) => {
  const r = Math.PI / 180
  const dLat = (bLat - aLat) * r
  const dLng = (bLng - aLng) * r
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}
export const distanceKm = km

/**
 * Order the cameras of one corridor. Mile markers when the provider publishes
 * them for (nearly) every camera; otherwise the road's own geometry: a
 * nearest-neighbour chain from one end, which follows curves and interchanges
 * where a straight-line sort would zig-zag. Returns camera_id → rank and the
 * basis used, so the UI can say "Camera 14 of 38" only when the order is real.
 */
export function orderCorridor(cameras) {
  const list = cameras.filter((c) => Number.isFinite(c.latitude) && Number.isFinite(c.longitude))
  const ranks = new Map()
  if (!list.length) return { ranks, basis: null }
  const withMm = list.filter((c) => Number.isFinite(c.mile_marker))
  if (withMm.length >= Math.max(2, Math.ceil(list.length * 0.8))) {
    const sorted = [...list].sort((a, b) => (a.mile_marker ?? Infinity) - (b.mile_marker ?? Infinity) || String(a.camera_id).localeCompare(String(b.camera_id)))
    sorted.forEach((c, i) => ranks.set(c.camera_id, i + 1))
    return { ranks, basis: 'mile_marker' }
  }
  if (list.length === 1) { ranks.set(list[0].camera_id, 1); return { ranks, basis: 'geometry' } }
  // Start at an end: the camera farthest from the corridor's centroid, then
  // the camera farthest from that one (the other end), and chain from there.
  const cLat = list.reduce((a, c) => a + c.latitude, 0) / list.length
  const cLng = list.reduce((a, c) => a + c.longitude, 0) / list.length
  let far = list[0]
  for (const c of list) if (km(cLat, cLng, c.latitude, c.longitude) > km(cLat, cLng, far.latitude, far.longitude)) far = c
  let start = far
  for (const c of list) if (km(far.latitude, far.longitude, c.latitude, c.longitude) > km(far.latitude, far.longitude, start.latitude, start.longitude)) start = c
  // Deterministic end choice: the south-west-most of the two ends goes first.
  if (far.latitude + far.longitude < start.latitude + start.longitude) start = far
  const left = new Set(list)
  let cur = start
  let rank = 1
  while (cur) {
    left.delete(cur)
    ranks.set(cur.camera_id, rank++)
    let next = null
    let best = Infinity
    for (const c of left) {
      const d = km(cur.latitude, cur.longitude, c.latitude, c.longitude)
      if (d < best || (d === best && String(c.camera_id) < String(next?.camera_id))) { best = d; next = c }
    }
    cur = next
  }
  return { ranks, basis: 'geometry' }
}

/**
 * How current a camera's picture is, against ITS provider's cadence.
 *   fresh   — within the expected update cadence (with jitter allowance)
 *   stale   — older than that
 *   offline — the provider says the camera is not serving
 *   unknown — no capture time we can trust
 */
export function cameraFreshness({ capturedAt, cadenceSec, status, now = Date.now(), staleAfterSec = null }) {
  if (status === 'OFFLINE' || status === 'MAINTENANCE' || status === 'BLOCKED_BY_PROVIDER') return { state: 'offline', age_sec: null, stale_after_sec: null }
  const t = capturedAt ? Date.parse(capturedAt) : NaN
  if (!Number.isFinite(t)) return { state: 'unknown', age_sec: null, stale_after_sec: null }
  const age = Math.max(0, Math.round((now - t) / 1000))
  const cadence = Number.isFinite(cadenceSec) && cadenceSec > 0 ? cadenceSec : null
  const limit = Number.isFinite(staleAfterSec) && staleAfterSec > 0 ? staleAfterSec : cadence ? Math.round(cadence * 2.5 + 60) : 900
  return { state: age <= limit ? 'fresh' : 'stale', age_sec: age, stale_after_sec: limit }
}

/**
 * Validate and finish an adapter's output. Adapters may return partial rows;
 * this enforces the invariants every consumer relies on (id, coordinates,
 * enums) and drops what cannot be placed on a map. Unknown fields are ignored.
 */
export function finalizeCamera(provider, partial, { refreshedAt = new Date().toISOString() } = {}) {
  if (!partial || typeof partial !== 'object') return null
  const camera_id = cameraIdFor(provider.provider_id, partial.external_camera_id)
  const latitude = finite(partial.latitude)
  const longitude = finite(partial.longitude)
  if (!camera_id || latitude === null || longitude === null) return null
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || (latitude === 0 && longitude === 0)) return null
  const feed = FEED_TYPES.includes(partial.feed_type) ? partial.feed_type : 'UNAVAILABLE'
  const status = CAMERA_STATUS.includes(partial.status) ? partial.status : 'UNKNOWN'
  const direction = DIRECTIONS.includes(partial.direction) ? partial.direction : normalizeDirection(partial.direction)
  const state = clean(partial.state || provider.state).toUpperCase() || null
  const road = canonicalRoad(partial.road) || canonicalRoad(partial.route) || null
  const mm = finite(partial.mile_marker)
  const updated = clean(partial.provider_updated_at)
  const updatedIso = updated && Number.isFinite(Date.parse(updated)) ? new Date(Date.parse(updated)).toISOString() : null
  const url = (v) => {
    const s = clean(v)
    return /^https?:\/\//i.test(s) ? s : null
  }
  return {
    camera_id,
    provider_id: provider.provider_id,
    external_camera_id: clean(partial.external_camera_id),
    name: clean(partial.name) || null,
    state: /^[A-Z]{2}$/.test(state || '') ? state : null,
    county: clean(partial.county) || null,
    city: clean(partial.city) || null,
    road,
    route: clean(partial.route) || null,
    direction,
    mile_marker: mm,
    latitude,
    longitude,
    status,
    feed_type: feed,
    still_url: url(partial.still_url),
    stream_url: url(partial.stream_url),
    thumbnail_url: url(partial.thumbnail_url),
    provider_page_url: url(partial.provider_page_url),
    snapshot_cadence_sec: finite(partial.snapshot_cadence_sec) ?? provider.snapshot_cadence_sec ?? null,
    provider_updated_at: updatedIso,
    timezone: clean(partial.timezone) || null,
    corridor_key: corridorKeyFor({ state, road: road || partial.route }),
    metadata: partial.metadata && typeof partial.metadata === 'object' ? partial.metadata : {},
    leadcommand_refreshed_at: refreshedAt,
  }
}
