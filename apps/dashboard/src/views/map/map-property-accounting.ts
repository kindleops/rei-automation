import type maplibregl from 'maplibre-gl'
import { PROPERTY_TILES_LAYER_IDS, PROPERTY_TILES_SOURCE_ID, PROPERTY_TILES_SOURCE_LAYER } from './map-property-tile-source'
import { shouldUseAggregateSource, shouldUseVectorTileSource } from './map-property-source'

const MARKET_AGGREGATE_CORE_LAYER = 'map-agg-cluster-core'
const PROPERTY_UNIVERSE_CLUSTER_CORE = 'prop-univ-cluster-core'
const PROPERTY_UNIVERSE_MARKERS = 'prop-univ-markers'

export type MapBounds = {
  west: number
  south: number
  east: number
  north: number
}

export type TileCoord = { z: number; x: number; y: number }

/** WebMercator tile indices covering a lng/lat bounds at integer zoom. */
export const getCoveringTileCoords = (bounds: MapBounds, zoom: number): TileCoord[] => {
  const z = Math.max(0, Math.min(22, Math.floor(zoom)))
  const n = 2 ** z
  const lonToTile = (lng: number) => Math.floor(((lng + 180) / 360) * n)
  const latToTile = (lat: number) => {
    const rad = (lat * Math.PI) / 180
    return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)
  }
  const xMin = Math.max(0, lonToTile(bounds.west))
  const xMax = Math.min(n - 1, lonToTile(bounds.east))
  const yMin = Math.max(0, latToTile(bounds.north))
  const yMax = Math.min(n - 1, latToTile(bounds.south))
  const tiles: TileCoord[] = []
  for (let x = xMin; x <= xMax; x += 1) {
    for (let y = yMin; y <= yMax; y += 1) {
      tiles.push({ z, x, y })
    }
  }
  return tiles
}

export const isPointInBounds = (
  lng: number,
  lat: number,
  bounds: MapBounds,
  epsilon = 1e-9,
): boolean => (
  lng >= bounds.west - epsilon
  && lng <= bounds.east + epsilon
  && lat >= bounds.south - epsilon
  && lat <= bounds.north + epsilon
)

export type SourceFeatureProperty = {
  property_id: string
  marker_key?: string
  lng: number
  lat: number
}

/** Loaded MVT features via querySourceFeatures — not collision-filtered. */
export const queryUniqueTilePropertiesInBounds = (
  map: maplibregl.Map,
  bounds: MapBounds,
): {
  decodedFeatureCount: number
  uniquePropertyIds: Set<string>
  duplicatePropertyIdCount: number
  features: SourceFeatureProperty[]
} => {
  if (!map.getSource(PROPERTY_TILES_SOURCE_ID)) {
    return {
      decodedFeatureCount: 0,
      uniquePropertyIds: new Set(),
      duplicatePropertyIdCount: 0,
      features: [],
    }
  }

  const raw = map.querySourceFeatures(PROPERTY_TILES_SOURCE_ID, {
    sourceLayer: PROPERTY_TILES_SOURCE_LAYER,
  })

  const seen = new Map<string, number>()
  const uniquePropertyIds = new Set<string>()
  const features: SourceFeatureProperty[] = []

  for (const feature of raw) {
    const propertyId = String(feature.properties?.property_id ?? feature.id ?? '').trim()
    if (!propertyId) continue
    const geom = feature.geometry
    if (!geom || geom.type !== 'Point') continue
    const [lng, lat] = geom.coordinates as [number, number]
    if (!isPointInBounds(lng, lat, bounds)) continue

    seen.set(propertyId, (seen.get(propertyId) ?? 0) + 1)
    if (!uniquePropertyIds.has(propertyId)) {
      uniquePropertyIds.add(propertyId)
      features.push({
        property_id: propertyId,
        marker_key: String(feature.properties?.marker_key ?? ''),
        lng,
        lat,
      })
    }
  }

  const duplicatePropertyIdCount = [...seen.values()].reduce((sum, count) => (
    sum + (count > 1 ? count - 1 : 0)
  ), 0)

  return {
    decodedFeatureCount: raw.length,
    uniquePropertyIds,
    duplicatePropertyIdCount,
    features,
  }
}

export type VisualRepresentationAccounting = {
  renderedIndividualIcons: number
  renderedClusters: number
  clusteredPropertyTotal: number
  renderedHalos: number
  collisionHiddenEstimate: number
  selectedBreakouts: number
  liveBreakouts: number
}

export const countVisualRepresentation = (
  map: maplibregl.Map,
  zoom: number,
): VisualRepresentationAccounting => {
  const result: VisualRepresentationAccounting = {
    renderedIndividualIcons: 0,
    renderedClusters: 0,
    clusteredPropertyTotal: 0,
    renderedHalos: 0,
    collisionHiddenEstimate: 0,
    selectedBreakouts: 0,
    liveBreakouts: 0,
  }

  const sellerIconLayer = 'seller-pins-icon'
  const sellerIconsVisible = map.getLayer(sellerIconLayer)
    && map.getLayoutProperty(sellerIconLayer, 'visibility') !== 'none'

  if (sellerIconsVisible) {
    const sellerRendered = map.queryRenderedFeatures(undefined, { layers: [sellerIconLayer] })
    const sellerIds = new Set<string>()
    for (const f of sellerRendered) {
      const id = String(f.properties?.property_id ?? f.id ?? '')
      if (id) sellerIds.add(id)
    }
    result.renderedIndividualIcons = sellerIds.size
    result.renderedHalos = map.queryRenderedFeatures(undefined, { layers: ['seller-pins-ring'] }).length
    return result
  }

  if (shouldUseVectorTileSource(zoom)) {
    const iconRendered = map.queryRenderedFeatures(undefined, { layers: [PROPERTY_TILES_LAYER_IDS.icon] })
    const haloRendered = map.queryRenderedFeatures(undefined, { layers: [PROPERTY_TILES_LAYER_IDS.halo] })
    const iconIds = new Set<string>()
    for (const f of iconRendered) {
      const id = String(f.properties?.property_id ?? f.id ?? '')
      if (id) iconIds.add(id)
      if (Number(f.properties?.pin_selected ?? f.state?.pin_selected ?? 0) === 1) {
        result.selectedBreakouts += 1
      }
      if (String(f.state?.motion ?? '') !== 'static' && f.state?.motion) {
        result.liveBreakouts += 1
      }
    }
    result.renderedIndividualIcons = iconIds.size
    result.renderedHalos = haloRendered.length

    const sourceLoaded = map.querySourceFeatures(PROPERTY_TILES_SOURCE_ID, { sourceLayer: PROPERTY_TILES_SOURCE_LAYER }).length
    result.collisionHiddenEstimate = Math.max(0, sourceLoaded - result.renderedIndividualIcons)
    return result
  }

  if (shouldUseAggregateSource(zoom)) {
    const clusters = map.queryRenderedFeatures(undefined, {
      layers: [MARKET_AGGREGATE_CORE_LAYER],
    })
    result.renderedClusters = clusters.length
    result.clusteredPropertyTotal = clusters.reduce((sum, f) => (
      sum + Number(f.properties?.property_count ?? f.properties?.point_count ?? 0)
    ), 0)
    return result
  }

  const clusterRendered = map.queryRenderedFeatures(undefined, {
    layers: [PROPERTY_UNIVERSE_CLUSTER_CORE],
  })
  result.renderedClusters = clusterRendered.length
  result.clusteredPropertyTotal = clusterRendered.reduce((sum, f) => (
    sum + Number(f.properties?.point_count ?? 0)
  ), 0)

  const icons = map.queryRenderedFeatures(undefined, { layers: [PROPERTY_UNIVERSE_MARKERS] })
  result.renderedIndividualIcons = icons.length
  return result
}

/**
 * Edge tolerance for tile vs canonical reconciliation:
 * - Tile buffer (64px in MVT) may include features whose coordinates fall just outside exact bounds.
 * - Duplicate IDs across buffered tile edges are tracked separately and must not inflate unique counts.
 * - Acceptable difference = |unique_in_bounds - canonical| when all unique IDs are verified inside bounds.
 */
export const TILE_ACCOUNTING_EDGE_RULE = (
  'unique_tile_property_ids uses exact lng/lat within viewport bounds; '
  + 'duplicate_property_id_count reflects MVT buffer overlap across adjacent tiles; '
  + 'difference = canonical_total_in_bounds - unique_tile_property_ids should be 0 when all tiles covering the bounds are loaded'
)

export const computeTileAccountingDelta = (
  canonicalTotalInBounds: number,
  uniqueTilePropertyCount: number,
): number => canonicalTotalInBounds - uniqueTilePropertyCount