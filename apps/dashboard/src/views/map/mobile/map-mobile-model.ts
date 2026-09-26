/**
 * Mobile Map + Live Activity — pure presentation model.
 *
 * Nothing here invents data. Activity events are the map's own Live Activity
 * feed (commandMapLiveActivity / live-activity-engine), which already carries a
 * deterministic `severity` per event type; this file only groups, filters,
 * orders and labels them for a phone.
 */
import type { LiveActivityEvent } from '../live-activity-engine'
import type { CommandMapActivityType } from '../commandMapLiveActivity'

// ── Activity scopes (the feed's own event taxonomy, grouped) ─────────────────

export type ActivityScope = 'all' | 'sellers' | 'outreach' | 'deals' | 'buyers' | 'system'

export const ACTIVITY_SCOPES: ReadonlyArray<{ key: ActivityScope; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'sellers', label: 'Sellers' },
  { key: 'outreach', label: 'Outreach' },
  { key: 'deals', label: 'Deals' },
  { key: 'buyers', label: 'Buyers' },
  { key: 'system', label: 'System' },
]

const SCOPE_OF: Record<CommandMapActivityType, Exclude<ActivityScope, 'all'>> = {
  new_reply: 'sellers',
  stage_change: 'sellers',
  positive_reply: 'sellers',
  hot_lead: 'sellers',
  follow_up_due: 'sellers',
  opt_out: 'sellers',
  message_sent: 'outreach',
  message_delivered: 'outreach',
  message_failed: 'outreach',
  queue_scheduled: 'outreach',
  queue_ready: 'outreach',
  queue_blocked: 'outreach',
  queue_paused: 'outreach',
  offer: 'deals',
  contract: 'deals',
  closing: 'deals',
  buyer_activity: 'buyers',
  sold_comp: 'buyers',
  system_alert: 'system',
  routing_block: 'system',
  automation_block: 'system',
  missing_message_event: 'system',
  provider_id_missing: 'system',
}

export const scopeOf = (event: Pick<LiveActivityEvent, 'type'>): Exclude<ActivityScope, 'all'> =>
  SCOPE_OF[event.type] ?? 'system'

// ── Severity → presentation tier (from the engine's own deterministic severity) ──

export type ActivityTier = 'critical' | 'important' | 'normal' | 'background'

export function tierOf(event: Pick<LiveActivityEvent, 'severity' | 'priority'>): ActivityTier {
  if (event.severity === 'urgent' || event.severity === 'blocked' || event.priority === 'critical') return 'critical'
  if (event.severity === 'attention' || event.priority === 'hot') return 'important'
  if (event.priority === 'muted') return 'background'
  return 'normal'
}

export const TIER_RANK: Record<ActivityTier, number> = { critical: 0, important: 1, normal: 2, background: 3 }

// ── Time windows ──────────────────────────────────────────────────────────────

export type ActivityWindow = '15m' | '1h' | 'today' | 'all'

export const ACTIVITY_WINDOWS: ReadonlyArray<{ key: ActivityWindow; label: string }> = [
  { key: '15m', label: '15m' },
  { key: '1h', label: '1h' },
  { key: 'today', label: 'Today' },
  { key: 'all', label: 'All' },
]

export const eventTime = (event: Pick<LiveActivityEvent, 'occurredAt' | 'createdAt' | 'receivedAt'>): number => {
  const t = Date.parse(event.occurredAt || event.createdAt || event.receivedAt || '')
  return Number.isFinite(t) ? t : 0
}

export function windowStart(window: ActivityWindow, now: Date = new Date()): number {
  if (window === '15m') return now.getTime() - 15 * 60_000
  if (window === '1h') return now.getTime() - 60 * 60_000
  if (window === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return 0
}

/** One row per event id, newest first; the first occurrence of an id wins. */
export function dedupeEvents<T extends Pick<LiveActivityEvent, 'id'>>(events: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const e of events) {
    if (!e?.id || seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  return out
}

export function filterActivity(
  events: LiveActivityEvent[],
  { scope, window, now = new Date() }: { scope: ActivityScope; window: ActivityWindow; now?: Date },
): LiveActivityEvent[] {
  const since = windowStart(window, now)
  return dedupeEvents(events)
    .filter((e) => scope === 'all' || scopeOf(e) === scope)
    .filter((e) => since === 0 || eventTime(e) >= since)
    .sort((a, b) => eventTime(b) - eventTime(a))
}

export function scopeCounts(events: LiveActivityEvent[], window: ActivityWindow, now = new Date()): Record<ActivityScope, number> {
  const counts: Record<ActivityScope, number> = { all: 0, sellers: 0, outreach: 0, deals: 0, buyers: 0, system: 0 }
  for (const e of filterActivity(events, { scope: 'all', window, now })) {
    counts.all += 1
    counts[scopeOf(e)] += 1
  }
  return counts
}

// ── Spatial grouping (activity clustering) ────────────────────────────────────

export interface ActivityPlace {
  key: string
  lng: number
  lat: number
  events: LiveActivityEvent[]
  tier: ActivityTier
  label: string
}

/**
 * Events at (about) the same place collapse into one marker. Precision is in
 * decimal degrees: 0.01° ≈ 1 km for city zooms, coarser when zoomed out.
 */
export function groupByPlace(events: LiveActivityEvent[], precision = 0.01): ActivityPlace[] {
  const map = new Map<string, ActivityPlace>()
  for (const e of events) {
    if (typeof e.lat !== 'number' || typeof e.lng !== 'number' || !Number.isFinite(e.lat) || !Number.isFinite(e.lng)) continue
    const key = `${Math.round(e.lng / precision)}:${Math.round(e.lat / precision)}`
    const place = map.get(key)
    if (place) {
      place.events.push(e)
      if (TIER_RANK[tierOf(e)] < TIER_RANK[place.tier]) place.tier = tierOf(e)
    } else {
      map.set(key, { key, lng: e.lng, lat: e.lat, events: [e], tier: tierOf(e), label: e.market || e.address || '' })
    }
  }
  return [...map.values()]
}

export const precisionForZoom = (zoom: number): number =>
  zoom >= 13 ? 0.0015 : zoom >= 11 ? 0.006 : zoom >= 9 ? 0.03 : zoom >= 6 ? 0.2 : 1

/** New ids relative to what the operator has already been shown. */
export function newEventIds(previous: ReadonlySet<string>, events: Pick<LiveActivityEvent, 'id'>[]): string[] {
  return events.map((e) => e.id).filter((id) => id && !previous.has(id))
}

// ── Labels ────────────────────────────────────────────────────────────────────

export function timeAgo(ms: number, now: number = Date.now()): string {
  if (!ms) return ''
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

/** What the operator can do with the event, only when the event carries the context. */
export function eventAction(event: Pick<LiveActivityEvent, 'targetType' | 'targetId' | 'threadKey' | 'propertyId' | 'lat' | 'lng'>):
  | { kind: 'select_property'; label: string }
  | { kind: 'open_conversation'; label: string }
  | null {
  const locatable = typeof event.lat === 'number' && typeof event.lng === 'number'
  if (event.targetType === 'seller' && event.targetId && locatable) return { kind: 'select_property', label: 'Show on map' }
  if (event.threadKey) return { kind: 'open_conversation', label: 'Open conversation' }
  return null
}

// ── Map appearance groups (the real preset ids) ──────────────────────────────

export const APPEARANCE_GROUPS: ReadonlyArray<{ label: string; ids: string[] }> = [
  { label: 'Standard', ids: ['dark_ops', 'light_street', 'executive', 'monochrome'] },
  { label: 'Imagery', ids: ['satellite', 'terrain'] },
  { label: 'Tactical', ids: ['red_ops', 'radar_night', 'blueprint', 'matrix'] },
]

// ── Marker hierarchy ─────────────────────────────────────────────────────────
// Reads ONLY feature-state the map already writes. Selected and live
// properties keep full strength; a property with a stage ring (a real
// conversation) stays clear; the untouched universe goes quiet.

export interface MarkerState {
  pin_selected?: number
  motion?: string
  priority_tier?: number
  breakout?: number
  ring_color?: string
}

export const MARKER_EMPHASIS = { selected: 1, live: 1, staged: 0.9, quiet: 0.4 } as const

/**
 * The map writes a default grey ring ('#7A8FA8') and a priority_tier onto
 * almost every property, so neither alone means "worked". A stage ring is a
 * ring colour OTHER than the default; live is real motion or a breakout.
 */
export const DEFAULT_RING = '#7A8FA8'

/** MapLibre expression — must stay in lockstep with markerEmphasis() below. */
export function buildMarkerEmphasisExpr(): unknown[] {
  return [
    'case',
    ['==', ['coalesce', ['feature-state', 'pin_selected'], 0], 1], MARKER_EMPHASIS.selected,
    ['any',
      ['!=', ['coalesce', ['feature-state', 'motion'], 'static'], 'static'],
      ['>', ['coalesce', ['feature-state', 'breakout'], 0], 0],
    ], MARKER_EMPHASIS.live,
    ['!=', ['coalesce', ['feature-state', 'ring_color'], DEFAULT_RING], DEFAULT_RING], MARKER_EMPHASIS.staged,
    MARKER_EMPHASIS.quiet,
  ]
}

/** The same rule, evaluated in JS (tests, diagnostics). */
export function markerEmphasis(state: MarkerState = {}): number {
  if ((state.pin_selected ?? 0) === 1) return MARKER_EMPHASIS.selected
  if ((state.motion ?? 'static') !== 'static' || (state.breakout ?? 0) > 0) return MARKER_EMPHASIS.live
  if (state.ring_color && state.ring_color.toUpperCase() !== DEFAULT_RING.toUpperCase()) return MARKER_EMPHASIS.staged
  return MARKER_EMPHASIS.quiet
}

// ── Selection camera (phone) ─────────────────────────────────────────────────

/**
 * Should the map move when a property is selected? Only when the pin would
 * be hidden — under the property card (lower ~48%), under the top chrome, or
 * off the side. Never a zoom change.
 */
export function selectionNeedsNudge(point: { x: number; y: number }, size: { width: number; height: number }): boolean {
  return point.y > size.height * 0.52 || point.y < 70 || point.x < 16 || point.x > size.width - 16
}

/**
 * Realtime rows first, then the map's derived feed. Once the live stream has
 * backfilled from message_events, it is the record for sellers + outreach in
 * its window: derived events of those scopes inside the window are dropped
 * (the pin-derived feed guesses times — a 7h-old reply read "now"). Outside
 * the window, a derived event describing the same moment (same property or
 * thread, same scope, within two minutes) is still dropped.
 */
export function mergeActivity(
  realtime: LiveActivityEvent[],
  derived: LiveActivityEvent[],
  coveredSince: number | null = null,
): LiveActivityEvent[] {
  const key = (e: LiveActivityEvent) => e.propertyId || e.threadKey || ''
  const seen = realtime.map((e) => ({ k: key(e), scope: scopeOf(e), t: eventTime(e) })).filter((x) => x.k)
  const rest = derived.filter((d) => {
    const scope = scopeOf(d)
    const t = eventTime(d)
    if (coveredSince !== null && (scope === 'sellers' || scope === 'outreach') && t >= coveredSince) return false
    const k = key(d)
    if (!k) return true
    return !seen.some((r) => r.k === k && r.scope === scope && Math.abs(r.t - t) < 120_000)
  })
  return dedupeEvents([...realtime, ...rest])
}
