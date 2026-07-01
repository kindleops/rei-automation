/**
 * Two-scale map property source controller.
 * SOURCE A: national/market aggregates (zoom < 9)
 * SOURCE B: canonical property points (zoom >= 9)
 */

export type MapPropertyFetchMode = 'national' | 'metro' | 'city' | 'street'

export type MapZoomBand = 'national' | 'regional' | 'metro' | 'city' | 'neighborhood' | 'street'

export const MAP_ZOOM_BANDS = {
  nationalMax: 5.99,
  regionalMin: 6,
  regionalMax: 8.99,
  cityMin: 9,
  cityMax: 11.49,
  neighborhoodMin: 11.5,
  neighborhoodMax: 13.49,
  streetMin: 13.5,
} as const

export const getMapZoomBand = (zoom: number): MapZoomBand => {
  if (zoom <= MAP_ZOOM_BANDS.nationalMax) return 'national'
  if (zoom < MAP_ZOOM_BANDS.cityMin) return 'metro'
  if (zoom < MAP_ZOOM_BANDS.neighborhoodMin) return 'city'
  if (zoom < MAP_ZOOM_BANDS.streetMin) return 'neighborhood'
  return 'street'
}

export const getMapPropertyFetchMode = (zoom: number): MapPropertyFetchMode => {
  if (zoom < 6) return 'national'
  if (zoom < 9) return 'metro'
  if (zoom < 13.5) return 'city'
  return 'street'
}

export const shouldUseAggregateSource = (zoom: number): boolean => zoom < MAP_ZOOM_BANDS.cityMin

/** Zoom 9+ uses PostGIS MVT tiles — complete property universe, no row caps */
export const shouldUseVectorTileSource = (zoom: number): boolean => zoom >= MAP_ZOOM_BANDS.cityMin

/** Legacy bounded GeoJSON path — diagnostics only when tiles are active */
export const shouldUsePropertySource = (zoom: number): boolean => zoom >= MAP_ZOOM_BANDS.cityMin

export const formatClusterCountLabel = (count: number): string => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 10_000) return `${(count / 1_000).toFixed(1)}K`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
  return String(count)
}

export const CLUSTER_COUNT_TEXT_EXPR: unknown[] = [
  'case',
  ['>=', ['coalesce', ['get', 'property_count'], ['get', 'point_count'], 0], 10000],
  ['concat', ['to-string', ['/', ['round', ['*', ['/', ['coalesce', ['get', 'property_count'], ['get', 'point_count'], 0], 1000], 10]], 10]], 'K'],
  ['>=', ['coalesce', ['get', 'property_count'], ['get', 'point_count'], 0], 1000],
  ['concat', ['to-string', ['/', ['round', ['*', ['/', ['coalesce', ['get', 'property_count'], ['get', 'point_count'], 0], 1000], 10]], 10]], 'K'],
  ['to-string', ['coalesce', ['get', 'property_count'], ['get', 'point_count'], 0]],
]