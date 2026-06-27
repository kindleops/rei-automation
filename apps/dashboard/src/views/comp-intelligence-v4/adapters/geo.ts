/**
 * Comp Intelligence V4 — geodesic helpers for the map pane.
 * Self-contained (does not import the rejected frontend's mapGeo util).
 */

import type { LatLng } from '../state/types'

const EARTH_RADIUS_MI = 3958.8

export function isValidCoord(coord: LatLng | null | undefined): coord is LatLng {
  if (!coord) return false
  const { lat, lng } = coord
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false
  if (lat === 0 && lng === 0) return false
  return true
}

/** GeoJSON polygon approximating a geodesic circle of `radiusMiles` around center. */
export function radiusCircleGeoJson(
  center: LatLng,
  radiusMiles: number,
  steps = 96,
): GeoJSON.Feature<GeoJSON.Polygon> {
  const coords: [number, number][] = []
  const latRad = (center.lat * Math.PI) / 180
  const dLat = radiusMiles / 69.0
  const dLng = radiusMiles / (69.0 * Math.cos(latRad) || 1e-6)
  for (let i = 0; i <= steps; i += 1) {
    const theta = (i / steps) * 2 * Math.PI
    coords.push([center.lng + dLng * Math.cos(theta), center.lat + dLat * Math.sin(theta)])
  }
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [coords] },
  }
}

export function haversineMiles(a: LatLng, b: LatLng): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Bounds [[w,s],[e,n]] covering all valid coords, or null. */
export function boundsOf(coords: LatLng[]): [[number, number], [number, number]] | null {
  const valid = coords.filter(isValidCoord)
  if (!valid.length) return null
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let nn = -Infinity
  for (const c of valid) {
    w = Math.min(w, c.lng)
    e = Math.max(e, c.lng)
    s = Math.min(s, c.lat)
    nn = Math.max(nn, c.lat)
  }
  return [
    [w, s],
    [e, nn],
  ]
}
