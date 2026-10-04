import type { GeoCoverage } from '../domain/geography'
import type { GeoKind } from '../domain/types'

export const BLACK_MARBLE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png'
export const CARTO_DARK = ['a', 'b', 'c'].map((s) => `https://${s}.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}.png`)
export const STATES_URL = '/geo/us-states.json'

export const GLOBE_HOME = { center: [-46, 26] as [number, number], zoom: 1.25 }
export const US_FRAME = { center: [-97, 37.6] as [number, number], zoom: 2.45 }
export const ZOOM_FOR: Record<GeoKind, number> = { COUNTRY: 2.4, STATE: 4.6, METRO: 7, COUNTY: 7, CITY: 8 }

export function cssVar(el: Element, name: string, fallback: string) {
  const v = getComputedStyle(el).getPropertyValue(name).trim()
  return v || fallback
}

/** GeoJSON for planned territory points (non-state places with a reference coordinate). */
export function territoryFeatures(cov: Map<string, GeoCoverage>, selected: string | null) {
  const features = []
  for (const c of cov.values()) {
    const g = c.geo
    if (g.kind === 'COUNTRY' || g.kind === 'STATE' || g.lat == null || g.lng == null) continue
    features.push({
      type: 'Feature' as const,
      id: g.id,
      geometry: { type: 'Point' as const, coordinates: [g.lng, g.lat] },
      properties: { id: g.id, name: g.name, kind: g.kind, planned: c.planned, ready: c.ready, completion: c.planned ? c.ready / c.planned : 0, selected: g.id === selected ? 1 : 0 },
    })
  }
  return { type: 'FeatureCollection' as const, features }
}

