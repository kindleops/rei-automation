/**
 * MAP CONTEXT OVERLAYS — the pure half: request builders, API shapes, the
 * Layers rows and the legend copy for the three context overlays that sit on
 * top of whatever primary lens is drawing.
 *
 *   Traffic cameras   official DOT / city feeds (camera-provider-registry)
 *   Crime             city open-data portals (crime-sources) · no scores
 *   Investor presence investor purchases + entity ownership, two components
 *
 * Every row reports what is really drawn: a count in view, "zoom in", "not
 * covered here", or the reason a source is unavailable. Nothing is invented
 * to fill a gap. All three are read through the operator-gated API.
 */
import type { SensorGroup, SensorRow, SensorStatus } from '../map-desk-model'
import { CRIME_CATS, type CrimeCat, type CrimeType } from './context-icons'

/** Crime windows: 7 / 14 / 30 days or everything the city publishes for the view ('all'). */
export type CrimeDays = '7' | '14' | '30' | 'all'
export const CRIME_WINDOWS: Array<{ key: CrimeDays; label: string }> = [{ key: '7', label: '7 d' }, { key: '14', label: '14 d' }, { key: '30', label: '30 d' }, { key: 'all', label: 'All' }]
export const crimeWindowWords = (d: CrimeDays) => (d === 'all' ? 'all published' : `last ${d} days`)
/** A stored preference from an older build (7 | 30 | 90 numbers) → today's windows. */
export function normalizeCrimeDays(v: unknown): CrimeDays {
  const s = String(v ?? '')
  return s === '7' || s === '14' || s === '30' || s === 'all' ? s : s === '90' ? 'all' : '30'
}
export function normalizeCrimeCats(v: unknown): CrimeCat[] {
  const list = Array.isArray(v) ? v.filter((x): x is CrimeCat => CRIME_CATS.includes(x as CrimeCat)) : CRIME_CATS
  return list.length ? [...new Set(list)] : [...CRIME_CATS]
}
export type PresenceView = 'composite' | 'purchases' | 'entity'
export type PresenceMonths = 12 | 24

export interface ContextPrefs {
  cameras: boolean
  crime: boolean
  crimeDays: CrimeDays
  /** Categories drawn (the server filters; counts stay for every category). */
  crimeCats: CrimeCat[]
  presence: boolean
  presenceView: PresenceView
  presenceMonths: PresenceMonths
}
export const CONTEXT_DEFAULTS: ContextPrefs = { cameras: false, crime: false, crimeDays: '30', crimeCats: [...CRIME_CATS], presence: false, presenceView: 'composite', presenceMonths: 24 }

export type ViewBox = { west: number; south: number; east: number; north: number }

/** What one overlay knows about the current view. */
export interface OverlayStatus {
  on: boolean
  state: 'off' | 'loading' | 'on' | 'waiting' | 'unavailable' | 'not_covered'
  count: number
  /** Plain words when nothing (or not everything) is drawn. */
  reason: string | null
  /** Who covers this view, in plain words (e.g. "MnDOT · statewide"). */
  coverage: string | null
  /** Exact credits the sources require. */
  attributions: string[]
}
export const OVERLAY_OFF: OverlayStatus = { on: false, state: 'off', count: 0, reason: null, coverage: null, attributions: [] }

/* ── API shapes ───────────────────────────────────────────────────────────── */

export interface CameraPoint {
  id: string
  name: string | null
  road: string | null
  direction: string | null
  lat: number
  lng: number
  status: string
  feed: string
  media: 'still' | 'link'
  /** The agency publishes live video for this camera (official HLS). */
  video?: boolean
  freshness: string
  provider: string
}
export interface CameraCoverage { provider: string; state: string | null; region: string | null; coverage_status: string; image_policy: 'proxy' | 'direct' | 'link_only'; attribution: string; terms_url: string | null }
export interface CamerasReply {
  ok: boolean
  mode: 'none' | 'coverage' | 'points'
  cameras: CameraPoint[]
  cells: Array<{ lng: number; lat: number; cameras: number; live: number }>
  attributions: Array<{ provider: string; text: string }>
  coverage?: CameraCoverage[]
  unavailable?: string[]
  /** Registered providers in view that are NOT connected, and why (needs a key / needs permission). */
  pending?: CameraPending[]
  note?: string
}
export interface CameraPending { provider: string; state: string | null; access: 'needs_key' | 'needs_permission' | 'not_permitted' | 'off' }
export interface CameraDetailReply {
  ok: boolean
  error?: string
  camera?: {
    id: string; name: string | null; road: string | null; route: string | null; direction: string | null; mile_marker: number | null
    city: string | null; county: string | null; state: string | null; lat: number; lng: number; status: string; feed: string
    timezone: string | null; provider_updated_at: string | null; refreshed_at: string | null; cadence_sec: number | null
    freshness: { state: string; age_sec: number | null }
  }
  media?: { still: { kind: 'proxy' | 'direct'; path?: string; url?: string; refresh_sec: number | null; passthrough?: boolean } | null; stream: { type: 'HLS' | 'VIDEO'; url: string } | null; provider_page_url: string | null }
  provider?: { id: string; name: string; attribution: string; terms_url: string | null; image_policy?: string; internal_use?: boolean }
  corridor?: { road: string; state: string; index: number; total: number } | null
}

export type CrimeFamily = 'person' | 'property' | 'society' | 'other'
export interface CrimeIncident {
  id: string; source_id: string; category: string; offense: string | null; family: CrimeFamily
  /** Map glyph and filter family, from the city's own words (server crime-taxonomy). */
  type: CrimeType; cat: CrimeCat
  occurred_on: string | null
  /** City-local 'YYYY-MM-DDTHH:MM' when the city publishes a time; null otherwise. */
  occurred_at: string | null
  lat: number; lng: number
}
export interface CrimeSourceInfo { source_id: string; city: string; state: string; publisher: string; attribution: string; licence: string; terms_url: string; dataset_url: string; lag_note: string; location_note: string }
export interface CrimeReply {
  ok: boolean
  mode: 'incidents' | 'zoom_in' | 'not_covered'
  covered: boolean
  window_days: number | 'all'
  incidents: CrimeIncident[]
  /** In view before the category filter; `counts` are per cat / per type over that set. */
  in_view?: number
  counts?: { cats: Record<CrimeCat, number>; types: Record<CrimeType, number> }
  categories: Array<{ family: CrimeFamily; cat?: CrimeCat; type?: CrimeType; category: string; count: number }>
  sources: CrimeSourceInfo[]
  per_source?: Array<{ source_id: string; city: string; count: number; latest_on: string | null; truncated: boolean }>
  unavailable?: Array<{ source_id: string; city: string; reason: string }>
  not_covered?: Array<{ city: string; state: string; reason: string }>
  min_zoom?: number
}

export interface PresenceCell { lat: number; lng: number; sales: number; investor_purchases: number; entity_owned: number }
export interface PresenceReply {
  ok: boolean
  mode: 'cells' | 'zoom_in' | 'unavailable'
  window_months: number
  cells: PresenceCell[]
  totals?: { sales_in_window: number; investor_purchases: number; entity_owned: number }
  latest_sale_on?: string | null
  grid_deg?: number
  min_zoom?: number
  components?: Record<'purchases' | 'entity', { label: string; basis: string; source: string }>
}

/* ── request builders (mirror the server's own refusals) ─────────────────── */

const clampBox = (b: ViewBox): ViewBox | null => {
  const w = Math.max(-180, b.west)
  const e = Math.min(180, b.east)
  const s = Math.max(-85, b.south)
  const n = Math.min(85, b.north)
  return w < e && s < n ? { west: w, south: s, east: e, north: n } : null
}
const fmtBox = (b: ViewBox) => [b.west, b.south, b.east, b.north].map((v) => v.toFixed(4)).join(',')

export const CAMERA_MIN_ZOOM = 5
export const CRIME_MIN_ZOOM = 11
export const CRIME_MAX_SPAN = 0.6
export const PRESENCE_MIN_ZOOM = 9.5
export const PRESENCE_MAX_SPAN = 2

export function camerasRequestFor(b: ViewBox, zoom: number): string | null {
  const box = clampBox(b)
  if (!box || zoom < CAMERA_MIN_ZOOM) return null
  return `/api/cockpit/map/cameras?bbox=${fmtBox(box)}&zoom=${zoom.toFixed(1)}`
}
export function crimeRequestFor(b: ViewBox, zoom: number, days: CrimeDays, cats: CrimeCat[] = CRIME_CATS): string | null {
  const box = clampBox(b)
  if (!box) return null
  // Out of range still asks: the server answers coverage ("not covered" / zoom in) for free.
  const some = cats.length && cats.length < CRIME_CATS.length ? `&cats=${[...cats].sort().join(',')}` : ''
  return `/api/cockpit/map/crime?bbox=${fmtBox(box)}&zoom=${zoom.toFixed(1)}&days=${days}${some}`
}
export function presenceRequestFor(b: ViewBox, zoom: number, months: PresenceMonths): string | null {
  const box = clampBox(b)
  if (!box || zoom < PRESENCE_MIN_ZOOM || Math.max(box.east - box.west, box.north - box.south) > PRESENCE_MAX_SPAN) return null
  return `/api/cockpit/map/investor-presence?bbox=${fmtBox(box)}&zoom=${zoom.toFixed(1)}&months=${months}`
}
export const cameraDetailPath = (id: string) => `/api/cockpit/map/cameras/${encodeURIComponent(id)}`

/* ── replies → status ─────────────────────────────────────────────────────── */

const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => Boolean(x)))]

export function cameraStatus(r: CamerasReply | null, zoom: number): OverlayStatus {
  if (!r) return { ...OVERLAY_OFF, on: true, state: 'unavailable', reason: 'Camera sources unavailable right now' }
  const cov = r.coverage ?? []
  const coverage = cov.length ? cov.map((c) => (c.image_policy === 'link_only' ? `${c.provider} (locations · pictures on TxDOT)` : c.provider)).join(' · ') : null
  const attributions = uniq([...r.attributions.map((a) => a.text), ...cov.map((c) => c.attribution)])
  if (zoom < CAMERA_MIN_ZOOM || r.mode === 'none') {
    if (r.note === 'no_provider_connected') return { on: true, state: 'unavailable', count: 0, reason: 'No camera source connected', coverage: null, attributions: [] }
    return { on: true, state: 'waiting', count: 0, reason: 'Zoom in to a state to see cameras', coverage, attributions }
  }
  if (!cov.length) return { on: true, state: 'not_covered', count: 0, reason: pendingWords(r.pending) ?? 'No public camera feed connected here', coverage: null, attributions: [] }
  const failed = r.unavailable?.length ? `${r.unavailable.join(', ')} not answering right now` : null
  if (r.mode === 'coverage') {
    const n = r.cells.reduce((a, c) => a + c.cameras, 0)
    return { on: true, state: n ? 'on' : failed ? 'unavailable' : 'on', count: n, reason: failed ?? 'Counts by area · zoom in for each camera', coverage, attributions }
  }
  return { on: true, state: r.cameras.length || !failed ? 'on' : 'unavailable', count: r.cameras.length, reason: failed, coverage, attributions }
}

/** "FL511 needs an API key · GDOT needs permission" — what would connect this view. */
export function pendingWords(p: CameraPending[] | undefined): string | null {
  if (!p?.length) return null
  const words = p.filter((x) => x.access !== 'off').map((x) => `${x.provider} ${x.access === 'needs_key' ? 'needs an API key' : x.access === 'not_permitted' ? 'terms do not allow this use' : 'needs agency permission'}`)
  return words.length ? `No camera feed connected here · ${[...new Set(words)].join(' · ')}` : null
}

export function crimeStatus(r: CrimeReply | null): OverlayStatus {
  if (!r) return { ...OVERLAY_OFF, on: true, state: 'unavailable', reason: 'Crime sources unavailable right now' }
  const attributions = uniq(r.sources.map((s) => s.attribution))
  const coverage = r.sources.length ? r.sources.map((s) => `${s.city} open data`).join(' · ') : null
  if (!r.covered) return { on: true, state: 'not_covered', count: 0, reason: 'Crime coverage unavailable here · no city open-data feed connected for this area', coverage: null, attributions: [] }
  if (r.mode === 'zoom_in') return { on: true, state: 'waiting', count: 0, reason: `Zoom in to see reported incidents (from z${r.min_zoom ?? CRIME_MIN_ZOOM})`, coverage, attributions }
  const failed = r.unavailable?.length ? `${r.unavailable.map((u) => u.city).join(', ')} not answering right now` : null
  const capped = r.per_source?.filter((p) => p.truncated).map((p) => p.city) ?? []
  const reason = failed ?? (capped.length ? `Row cap reached for ${capped.join(', ')} (newest first where the city orders them) · zoom in or shorten the window for all` : null)
  return { on: true, state: r.incidents.length || (r.in_view ?? 0) || !failed ? 'on' : 'unavailable', count: r.incidents.length, reason, coverage, attributions }
}

export function presenceStatus(r: PresenceReply | null, zoom: number, refused: boolean): OverlayStatus {
  const attributions = ['Public record + MLS sales · public record ownership']
  if (refused || zoom < PRESENCE_MIN_ZOOM) return { on: true, state: 'waiting', count: 0, reason: `Zoom in to a metro to see investor presence (from z${PRESENCE_MIN_ZOOM})`, coverage: null, attributions }
  if (!r || r.mode === 'unavailable') return { on: true, state: 'unavailable', count: 0, reason: 'Investor presence unavailable right now', coverage: null, attributions }
  if (r.mode === 'zoom_in') return { on: true, state: 'waiting', count: 0, reason: `Zoom in to a metro to see investor presence (from z${r.min_zoom ?? PRESENCE_MIN_ZOOM})`, coverage: null, attributions }
  const latest = r.latest_sale_on ? `latest recorded sale here ${fmtDay(r.latest_sale_on)}` : null
  return { on: true, state: 'on', count: r.cells.length, reason: latest, coverage: null, attributions }
}

/* ── Layers rows ──────────────────────────────────────────────────────────── */

const rowStatus = (s: OverlayStatus): SensorStatus => (!s.on ? 'off' : s.state === 'on' ? 'on' : s.state === 'unavailable' || s.state === 'not_covered' ? 'unavailable' : 'waiting')
const S = { visibility: true, opacity: false, style: false, time: true }

export function contextGroup(cams: OverlayStatus, crime: OverlayStatus, presence: OverlayStatus, prefs: ContextPrefs): SensorGroup {
  const camSub = cams.on && cams.state === 'on' ? `${cams.count.toLocaleString('en-US')} in view · ${cams.coverage ?? 'official DOT feeds'}` : 'Official DOT and city feeds · stills on press · live video MN and CA only'
  const crimeSub = crime.on && crime.state === 'on' ? `${crime.count.toLocaleString('en-US')} reported · ${crimeWindowWords(prefs.crimeDays)} · ${crime.coverage ?? ''}` : 'Reported incidents from city open data · by type and date, no scores'
  const presSub = presence.on && presence.state === 'on' ? `${presence.count.toLocaleString('en-US')} areas · last ${prefs.presenceMonths} mo purchases + entity owners now` : 'Investor purchases and entity ownership — two separate signals'
  const rows: SensorRow[] = [
    { id: 'ctxCameras', label: 'Traffic cameras', sub: camSub, status: rowStatus(cams), on: prefs.cameras, available: true, reason: cams.on ? cams.reason ?? undefined : undefined, supports: { ...S, time: false } },
    { id: 'ctxCrime', label: 'Crime (reported)', sub: crimeSub, status: rowStatus(crime), on: prefs.crime, available: true, reason: crime.on ? crime.reason ?? undefined : undefined, supports: S },
    { id: 'ctxPresence', label: 'Investor presence', sub: presSub, status: rowStatus(presence), on: prefs.presence, available: true, reason: presence.on ? presence.reason ?? undefined : undefined, supports: S },
  ]
  return { id: 'context', label: 'Context overlays', rows }
}

/* ── labels ───────────────────────────────────────────────────────────────── */

export const CRIME_FAMILY: Record<CrimeFamily, { label: string; color: string }> = {
  person: { label: 'Against people', color: '#f0b35a' },
  property: { label: 'Property', color: '#8ea2ff' },
  society: { label: 'Society (drugs, weapons, order)', color: '#5fd4c4' },
  other: { label: 'Other / calls', color: '#a3abb9' },
}
export const PRESENCE_COLORS = { purchases: '#f0b35a', entity: '#5cc8ff' } as const

const DIR_WORD: Record<string, string> = { N: 'Northbound', S: 'Southbound', E: 'Eastbound', W: 'Westbound', NE: 'Northeast', NW: 'Northwest', SE: 'Southeast', SW: 'Southwest', BOTH: 'Both directions' }
export const directionLabel = (d: string | null | undefined) => (d ? DIR_WORD[d] ?? d : 'Direction not published')

export function fmtDay(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}/.test(day)) return '—'
  const [y, m, d] = day.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/** A city-local 'YYYY-MM-DDTHH:MM' → "2:20 AM" (the city's own clock), or null. */
export function fmtLocalTime(at: string | null | undefined): string | null {
  const m = at ? /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/.exec(at) : null
  if (!m) return null
  const h = Number(m[1])
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`
}

/** Days between a city day and "now" (for freshness copy). */
export function daysAgo(day: string | null | undefined, now: number): number | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}/.test(day)) return null
  const [y, m, d] = day.slice(0, 10).split('-').map(Number)
  return Math.max(0, Math.floor((now - Date.UTC(y, m - 1, d)) / 86_400_000))
}

/** "2 min ago" from an ISO time and a clock. */
export function agoFrom(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} d ago`
}

/** What the camera preview can honestly call its picture. */
export function cameraMediaLabel(d: CameraDetailReply): { kind: 'still' | 'link' | 'none'; label: string } {
  if (d.media?.still) {
    const sec = d.media.still.refresh_sec
    return { kind: 'still', label: sec ? `Still image · the agency updates about every ${sec >= 120 ? `${Math.round(sec / 60)} min` : `${sec} s`}` : 'Still image' }
  }
  if (d.media?.provider_page_url) return { kind: 'link', label: `Picture on ${d.provider?.name ?? 'the agency'}’s own page (not cleared for reuse)` }
  return { kind: 'none', label: 'No picture published for this camera' }
}

/** Presence features for the map: one point per cell, both components carried, radius by count. */
export function presenceFeatures(cells: PresenceCell[]): GeoJSON.FeatureCollection {
  const maxP = cells.reduce((m, c) => Math.max(m, c.investor_purchases), 1)
  const maxE = cells.reduce((m, c) => Math.max(m, c.entity_owned), 1)
  return {
    type: 'FeatureCollection',
    features: cells.map((c, i) => ({
      type: 'Feature',
      id: i,
      geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      properties: {
        i, p: c.investor_purchases, e: c.entity_owned, s: c.sales,
        // sqrt so area tracks count; each component scaled on its own range
        pr: c.investor_purchases ? Math.sqrt(c.investor_purchases / maxP) : 0,
        er: c.entity_owned ? Math.sqrt(c.entity_owned / maxE) : 0,
      },
    })),
  }
}
