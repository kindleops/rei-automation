/**
 * MAP FOCUS SET — a set of places another app hands to the Map to emphasise.
 *
 * Entity Graph ("show these 40 properties", "show this buyer's portfolio")
 * writes the set here, then routes to /map. The Map lights the set, frames it,
 * and offers one tap to clear. sessionStorage, not a URL: the set can be
 * thousands of points and must not land in history or logs.
 */
export type MapFocusPoint = { lat: number; lng: number; id?: string; label?: string | null }
export type MapFocusSet = { label: string; tone: 'property' | 'buyer' | 'portfolio'; points: MapFocusPoint[]; at: number }

const KEY = 'nexus:map-focus-set:v1'
export const MAP_FOCUS_SET_EVENT = 'nexus:map-focus-set'
const TTL_MS = 20 * 60 * 1000

export function writeMapFocusSet(set: Omit<MapFocusSet, 'at'>): boolean {
  const points = set.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) > 0.1).slice(0, 5000)
  if (!points.length) return false
  const value: MapFocusSet = { ...set, points, at: Date.now() }
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value))
    window.dispatchEvent(new CustomEvent(MAP_FOCUS_SET_EVENT))
    return true
  } catch {
    return false
  }
}

export function readMapFocusSet(): MapFocusSet | null {
  try {
    const raw = window.sessionStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as MapFocusSet
    if (!parsed?.points?.length || Date.now() - (parsed.at ?? 0) > TTL_MS) return null
    return parsed
  } catch {
    return null
  }
}

export function clearMapFocusSet(): void {
  try {
    window.sessionStorage.removeItem(KEY)
    window.dispatchEvent(new CustomEvent(MAP_FOCUS_SET_EVENT))
  } catch { /* ignore */ }
}
