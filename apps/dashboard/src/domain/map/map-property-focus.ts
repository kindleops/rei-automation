/**
 * MAP PROPERTY FOCUS — "Show on Map" for one canonical property.
 *
 * The sibling of map-focus-set (which carries MANY points for framing). This
 * carries ONE property by its canonical property_id, so the Map can make the
 * same canonical selection a pin tap makes — the star, the preview, the
 * Inspector — rather than just lighting a dot.
 *
 * Deliberately NOT the property locator: showing a comp on the map must not
 * re-aim Deal Intelligence or Comps at that comp. The locator is the linked
 * workspace subject; this is a request to the Map alone.
 *
 * The request is held in sessionStorage (short TTL) so a Map pane that is
 * being opened by the same action consumes it on mount; a mounted Map hears
 * the event. The Map acknowledges with an outcome, which the shell announces.
 */

export interface MapPropertyFocus {
  /** monotonic per tab — a Map applies each request once */
  seq: number
  propertyId: string
  label: string | null
  threadKey: string | null
  /** coordinates the CALLER already read from a canonical source (never invented) */
  lat: number | null
  lng: number | null
  /** the app the request came from (display / audit only) */
  source: string | null
  at: number
}

export type MapFocusOutcome =
  | { seq: number; status: 'focused'; propertyId: string; via: 'pin' | 'caller' | 'canonical' }
  | { seq: number; status: 'unavailable'; propertyId: string; reason: string }

const KEY = 'nexus:map-property-focus:v1'
export const MAP_PROPERTY_FOCUS_EVENT = 'nexus:map-property-focus'
export const MAP_FOCUS_OUTCOME_EVENT = 'nexus:map-focus-outcome'
/** A request older than this is history, not a request (a Map opened much later must not fly). */
export const MAP_PROPERTY_FOCUS_TTL_MS = 30_000

let lastSeq = 0
const finite = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

/** A usable WGS84 coordinate pair (0,0 and out-of-range values are not locations). */
export function isUsableLngLat(lat: unknown, lng: unknown): boolean {
  const a = finite(lat)
  const o = finite(lng)
  return a !== null && o !== null && Math.abs(a) <= 90 && Math.abs(o) <= 180 && !(Math.abs(a) < 0.1 && Math.abs(o) < 0.1)
}

export function writeMapPropertyFocus(input: { propertyId: string; label?: string | null; threadKey?: string | null; lat?: number | string | null; lng?: number | string | null; source?: string | null }): MapPropertyFocus | null {
  const propertyId = String(input.propertyId ?? '').trim()
  if (!propertyId) return null
  const now = Date.now()
  lastSeq = Math.max(lastSeq + 1, now)
  const usable = isUsableLngLat(input.lat, input.lng)
  const value: MapPropertyFocus = {
    seq: lastSeq,
    propertyId,
    label: input.label?.trim() || null,
    threadKey: input.threadKey?.trim() || null,
    lat: usable ? finite(input.lat) : null,
    lng: usable ? finite(input.lng) : null,
    source: input.source ?? null,
    at: now,
  }
  try { window.sessionStorage.setItem(KEY, JSON.stringify(value)) } catch { /* private mode: the event still carries it */ }
  try { window.dispatchEvent(new CustomEvent<MapPropertyFocus>(MAP_PROPERTY_FOCUS_EVENT, { detail: value })) } catch { /* non-DOM */ }
  return value
}

/** The request a Map mounting now should apply, if it is still fresh. */
export function readPendingMapPropertyFocus(now = Date.now()): MapPropertyFocus | null {
  try {
    const raw = window.sessionStorage.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as MapPropertyFocus
    if (!v?.propertyId || !Number.isFinite(v.seq) || now - (v.at ?? 0) > MAP_PROPERTY_FOCUS_TTL_MS) return null
    return v
  } catch {
    return null
  }
}

/** The Map applied (or could not apply) a request: it is consumed and the outcome is broadcast. */
export function ackMapPropertyFocus(outcome: MapFocusOutcome): void {
  try {
    const raw = window.sessionStorage.getItem(KEY)
    const v = raw ? (JSON.parse(raw) as MapPropertyFocus) : null
    if (v && v.seq <= outcome.seq) window.sessionStorage.removeItem(KEY)
  } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent<MapFocusOutcome>(MAP_FOCUS_OUTCOME_EVENT, { detail: outcome })) } catch { /* non-DOM */ }
}

export function clearMapPropertyFocus(): void {
  try { window.sessionStorage.removeItem(KEY) } catch { /* ignore */ }
}
