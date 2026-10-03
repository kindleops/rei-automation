/**
 * CAMPAIGN MAP PREVIEW — the pure model (Live Audience Geography).
 *
 * The Map never computes the audience. The server (part=geo) returns the
 * eligible cohort — the same pipeline as the Composer's "Eligible: N" — on
 * canonical coordinates, with eligible / mapped / without-coordinates counted
 * separately. This file turns that answer into one GeoJSON source, decides
 * when the camera may move (intent only: preview activated, a market added or
 * removed, Frame Campaign — never a filter edit), and words the status.
 */

export type FollowMode = 'auto' | 'markets' | 'manual'
export type PreviewMode = 'audience' | 'density'

export interface GeoMarket {
  market: string
  eligible: number
  mapped: number
  unmapped: number
  not_routable: number
  no_greeting: number
  /** [west, south, east, north] of the mapped points; null when none are mapped */
  bbox: [number, number, number, number] | null
}

export interface GeoPreview {
  ok: true
  at: string
  cohort_at?: string
  eligible: number
  mapped: number
  unmapped: number
  reconciliation: { composer_eligible: number | null; matches: boolean | null; delta: number | null }
  excluded: { held_by_build: number | null; not_routable: number; no_greeting: number }
  ready: number | null
  capped_by_build_limit: boolean
  build_limit: number | null
  markets: GeoMarket[]
  points: { ids: string[]; lng: number[]; lat: number[]; market: number[] }
  timings_ms?: { cohort: number; coordinates: number; total: number }
  cached?: boolean
}

/** Above this many points the Audience view clusters (exact counts stay in the status). */
export const CLUSTER_AT = 6000
export const shouldCluster = (n: number) => n > CLUSTER_AT

export interface PreviewFeature {
  type: 'Feature'
  id: number
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: { pid: string; m: number }
}
export interface PreviewCollection { type: 'FeatureCollection'; features: PreviewFeature[] }

/**
 * One feature per mapped eligible target, from the server's columnar points.
 * Defensive: a point whose arrays disagree or whose coordinates are not a
 * usable location is dropped (and stays counted by the server as unmapped).
 */
export function previewFeatures(g: Pick<GeoPreview, 'points'> | null): PreviewCollection {
  const features: PreviewFeature[] = []
  const p = g?.points
  if (!p) return { type: 'FeatureCollection', features }
  const n = Math.min(p.ids.length, p.lng.length, p.lat.length)
  for (let i = 0; i < n; i += 1) {
    const lng = p.lng[i]
    const lat = p.lat[i]
    if (!usable(lat, lng)) continue
    features.push({ type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { pid: p.ids[i], m: p.market[i] ?? -1 } })
  }
  return { type: 'FeatureCollection', features }
}

export const usable = (lat: unknown, lng: unknown) =>
  typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
  && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(Math.abs(lat) < 0.1 && Math.abs(lng) < 0.1)

/* ── markets ──────────────────────────────────────────────────────────── */

export { marketsOfSpec } from '../../../../domain/campaign-preview/campaign-preview-context'

export const shortMarket = (m: string) => m.split(',')[0].trim() || m

/** "Campaign Preview · Minneapolis + Dallas" (three or more: "Minneapolis + 3 markets"). */
export function previewTitle(markets: string[]): string {
  if (!markets.length) return 'Campaign Preview'
  const names = markets.map(shortMarket)
  if (names.length <= 2) return `Campaign Preview · ${names.join(' + ')}`
  return `Campaign Preview · ${names[0]} + ${names.length - 1} markets`
}

const nf = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—')
export const fmt = nf

/** "2,552 eligible · 2,487 mapped · 65 without coordinates" — every number the server's. */
export function statusLine(g: Pick<GeoPreview, 'eligible' | 'mapped' | 'unmapped'>): string {
  const parts = [`${nf(g.eligible)} eligible`, `${nf(g.mapped)} mapped`]
  if (g.unmapped > 0) parts.push(`${nf(g.unmapped)} without coordinates`)
  return parts.join(' · ')
}

/** Why a market shows no points (server-counted reasons only). */
export function marketNote(m: GeoMarket): string | null {
  if (m.eligible > 0) return m.unmapped > 0 ? `${nf(m.unmapped)} without coordinates` : null
  if (m.not_routable > 0) return 'No sender route'
  if (m.no_greeting > 0) return 'Greeting can’t render'
  return 'No eligible sellers'
}

/** Bounds of a set of market boxes (only markets with mapped points). */
export function unionBounds(markets: ReadonlyArray<Pick<GeoMarket, 'bbox'>>): [[number, number], [number, number]] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  for (const m of markets) {
    if (!m.bbox) continue
    w = Math.min(w, m.bbox[0]); s = Math.min(s, m.bbox[1]); e = Math.max(e, m.bbox[2]); n = Math.max(n, m.bbox[3])
  }
  return Number.isFinite(w) ? [[w, s], [e, n]] : null
}

/* ── camera: intent only ─────────────────────────────────────────────── */

export type CameraIntent =
  | { kind: 'frame_all' }
  | { kind: 'frame_market'; market: string }
  /** acknowledge a newly added market, then fit the combined audience */
  | { kind: 'arrive'; market: string }

export type CameraCause = 'activated' | 'audience_changed' | 'frame_request'

/**
 * Cinematic on intent, calm on iteration. The camera moves only when the
 * preview is activated, a market is added or removed, or the operator asks
 * (Frame Campaign). A filter edit — same markets — never moves it. Manual
 * follow never moves it automatically.
 */
export function planCameraIntent(input: { cause: CameraCause; mode: FollowMode; prevMarkets: string[] | null; nextMarkets: string[] }): CameraIntent | null {
  const { cause, mode, nextMarkets } = input
  const last = nextMarkets[nextMarkets.length - 1] ?? null
  if (cause === 'frame_request') return { kind: 'frame_all' }
  if (mode === 'manual') return null
  if (cause === 'activated' || input.prevMarkets === null) {
    if (mode === 'markets') return last ? { kind: 'frame_market', market: last } : { kind: 'frame_all' }
    return { kind: 'frame_all' }
  }
  const prev = input.prevMarkets
  const added = nextMarkets.filter((m) => !prev.includes(m))
  const removed = prev.filter((m) => !nextMarkets.includes(m))
  if (!added.length && !removed.length) return null // filters only: stay put
  if (added.length) {
    const market = added[added.length - 1]
    if (mode === 'markets') return { kind: 'frame_market', market }
    // one market from nothing is a plain framing; a market joining others is acknowledged first
    return nextMarkets.length > 1 ? { kind: 'arrive', market } : { kind: 'frame_all' }
  }
  if (mode === 'markets') return last ? { kind: 'frame_market', market: last } : null
  return nextMarkets.length ? { kind: 'frame_all' } : null
}

/* ── follow mode: per pane, per session ──────────────────────────────── */

const FOLLOW_KEY = 'lc.map.campaignPreview.follow.v1'
export const FOLLOW_OPTIONS: ReadonlyArray<{ key: FollowMode; label: string; hint: string }> = [
  { key: 'auto', label: 'Auto', hint: 'Frames the campaign as markets change' },
  { key: 'markets', label: 'Markets', hint: 'Follows the market you add' },
  { key: 'manual', label: 'Manual', hint: 'The camera stays where you put it' },
]

export function readFollowMode(scope: string | null, store: Pick<Storage, 'getItem'> | null = safeSession()): FollowMode {
  try {
    const all = JSON.parse(store?.getItem(FOLLOW_KEY) || '{}') as Record<string, unknown>
    const v = all[scope ?? 'main']
    return v === 'markets' || v === 'manual' || v === 'auto' ? v : 'auto'
  } catch { return 'auto' }
}

export function writeFollowMode(scope: string | null, mode: FollowMode, store: Pick<Storage, 'getItem' | 'setItem'> | null = safeSession()) {
  try {
    const all = JSON.parse(store?.getItem(FOLLOW_KEY) || '{}') as Record<string, unknown>
    all[scope ?? 'main'] = mode
    store?.setItem(FOLLOW_KEY, JSON.stringify(all))
  } catch { /* storage blocked: the mode lives in memory */ }
}

function safeSession(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage } catch { return null }
}

/* ── colour: the accent, never a semantic red / green / amber ─────────── */

export interface PreviewPaint { core: string; halo: string; stroke: string; ink: string }

const parseRgb = (s: string | null | undefined): [number, number, number] | null => {
  const m = String(s ?? '').match(/(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/)
  if (!m) return null
  const rgb = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number]
  return rgb.every((v) => v >= 0 && v <= 255) ? rgb : null
}

function hueSat([r, g, b]: [number, number, number]): { h: number; s: number; l: number } {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

/**
 * Semantic families the preview must never borrow: red (failure), green
 * (verified), amber (attention). An accent in one of them falls back to the
 * execution cyan — a campaign is the machine executing.
 */
export function isReservedHue(rgb: [number, number, number]): boolean {
  const { h, s } = hueSat(rgb)
  if (s < 0.28) return false
  return h < 22 || h >= 330 || (h >= 30 && h < 62) || (h >= 95 && h < 158)
}

const EXEC_FALLBACK: [number, number, number] = [76, 201, 240]

/** Light basemaps get a white rim; dark ones a near-black rim — the dot reads on both. */
const LIGHT_MAP_STYLES = new Set(['light_street', 'terrain'])
export const isLightMapStyle = (styleMode: string | null | undefined) => LIGHT_MAP_STYLES.has(String(styleMode ?? ''))

export function previewPaint(input: { accentRgb: string | null; execRgb?: string | null; styleMode: string | null }): PreviewPaint {
  const accent = parseRgb(input.accentRgb)
  const exec = parseRgb(input.execRgb) ?? EXEC_FALLBACK
  const rgb = accent && !isReservedHue(accent) ? accent : (isReservedHue(exec) ? EXEC_FALLBACK : exec)
  const light = isLightMapStyle(input.styleMode)
  const [r, g, b] = light ? darken(rgb, 0.18) : rgb
  return {
    core: `rgb(${r}, ${g}, ${b})`,
    halo: `rgba(${r}, ${g}, ${b}, ${light ? 0.22 : 0.3})`,
    stroke: light ? 'rgba(255, 255, 255, 0.95)' : 'rgba(4, 7, 12, 0.9)',
    ink: light ? '#ffffff' : '#04070c',
  }
}

const darken = (rgb: [number, number, number], k: number): [number, number, number] => rgb.map((v) => Math.round(v * (1 - k))) as [number, number, number]
