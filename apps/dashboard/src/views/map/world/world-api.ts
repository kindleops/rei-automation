import { callBackend } from '../../../lib/api/backendClient'

/**
 * World state for the map — the place under the centre, its canonical
 * timezone and the seller contact window there, plus every US zone's clock.
 * The server resolves all of it through the canonical contact-window module;
 * this client only displays and counts down to the instants it returns.
 */

export interface ContactWindow {
  policy_version: string
  window: string
  open: boolean
  reason: string
  closes_at: string | null
  next_open_at: string | null
}
export interface WorldResponse {
  at: string
  place: { zip: string | null; state: string | null; city: string | null; market: string | null; basis: string }
  timezone: { iana: string | null; abbr?: string; label?: string; basis: string; reason?: string }
  contact_window: ContactWindow | null
}
export interface ZoneClock { iana: string; label: string; city: string; lat: number; lng: number; abbr: string; contact_window: ContactWindow | null }
export interface MarketZone { market: string; key: string; state: string | null; properties: number; lat: number; lng: number; iana: string | null; abbr: string | null; contact_window: ContactWindow | null }
export interface ZonesResponse { at: string; window: { start: string; end: string } | null; zones: ZoneClock[]; markets: MarketZone[] }

async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await callBackend<T & { ok: boolean; error?: string }>(path, { signal, timeoutMs: 15_000 })
  if (!res.ok) throw new Error((res as { error?: string }).error || 'world_unavailable')
  const body = res.data as (T & { ok: boolean; error?: string }) | undefined
  if (!body || body.ok === false) throw new Error(body?.error || 'world_unavailable')
  return body
}

// The place under a point rarely changes within ~5 km; cache per cell.
const worldCache = new Map<string, { at: number; value: WorldResponse }>()
const WORLD_TTL = 60_000
const cellKey = (lat: number, lng: number) => `${lat.toFixed(2)},${lng.toFixed(2)}`

export async function fetchWorld(lat: number, lng: number, signal?: AbortSignal): Promise<WorldResponse> {
  const key = cellKey(Math.round(lat * 20) / 20, Math.round(lng * 20) / 20)
  const hit = worldCache.get(key)
  if (hit && Date.now() - hit.at < WORLD_TTL) return hit.value
  const value = await read<WorldResponse>(`/api/cockpit/map/world?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}`, signal)
  worldCache.set(key, { at: Date.now(), value })
  if (worldCache.size > 80) worldCache.delete(worldCache.keys().next().value as string)
  return value
}

let zonesCache: { at: number; value: ZonesResponse } | null = null
export async function fetchZones(signal?: AbortSignal): Promise<ZonesResponse> {
  if (zonesCache && Date.now() - zonesCache.at < 5 * 60_000) return zonesCache.value
  const value = await read<ZonesResponse>('/api/cockpit/map/world/zones', signal)
  zonesCache = { at: Date.now(), value }
  return value
}
export function invalidateWorldCaches() { worldCache.clear(); zonesCache = null }

/** Wall-clock time in an IANA zone ("7:42 PM"). */
export function localClock(iana: string, at = new Date()): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: iana, hour: 'numeric', minute: '2-digit' }).format(at)
}

/** "1h 18m" / "42m" / "under a minute" until an instant. */
export function untilLabel(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms)) return null
  if (ms <= 60_000) return 'under a minute'
  const m = Math.round(ms / 60_000)
  const h = Math.floor(m / 60)
  return h ? `${h}h ${m % 60}m` : `${m}m`
}

export type WindowTone = 'open' | 'closing' | 'quiet' | 'unknown'
export function windowTone(w: ContactWindow | null, now = Date.now()): WindowTone {
  if (!w) return 'unknown'
  if (!w.open) return 'quiet'
  const left = w.closes_at ? Date.parse(w.closes_at) - now : Infinity
  return left <= 60 * 60_000 ? 'closing' : 'open'
}

/** A boundary passed since the server answered — the state must be re-read. */
export function windowIsStale(w: ContactWindow | null, now = Date.now()): boolean {
  if (!w) return false
  const edge = w.open ? w.closes_at : w.next_open_at
  return Boolean(edge && Date.parse(edge) <= now)
}
