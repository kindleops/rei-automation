import type maplibregl from 'maplibre-gl'
import type { CommandMapThemeId } from './commandMapThemes'
import type { CommandMapIntelligenceModeId } from './command-map-intelligence-modes'
import {
  PIN_HIT_RADIUS_EXPR,
  enrichAcquisitionRadarFeature,
} from './acquisition-radar-pin-renderer'
import { buildMarkerKeyIconColorExpr, buildMarkerKeyIconImageExpr } from './canonical-map-asset-marker'
import { getMapPinThemeTokens } from './map-pin-theme-tokens'
import { getMapThemeTokens } from './map-theme-tokens'
import {
  PROPERTY_TILES_LAYER_IDS,
  PROPERTY_TILES_SOURCE_ID,
  PROPERTY_TILES_SOURCE_LAYER,
  buildPropertyTilesUrlTemplate,
} from './map-property-tile-source'

const TILE_RING_STROKE_EXPR: unknown[] = [
  'coalesce',
  ['feature-state', 'ring_color'],
  ['case',
    ['in', ['get', 'contact_status'], ['literal', ['uncontacted', 'not_contacted', '']]],
    '#7A8FA8',
    '#6F9BFF',
  ],
]

const TILE_HALO_COLOR_EXPR: unknown[] = [
  'coalesce',
  ['feature-state', 'ring_color'],
  ['feature-state', 'icon_color'],
  ['get', 'icon_color'],
]

/**
 * MapLibre silently rejects some expressions on MVT circle layers (notably
 * multiplied zoom interpolates for circle-radius and feature-state filters).
 * Keep tile paint/layout expressions MVT-safe — use zoom-only interpolates for
 * radius/icon-size and drive halo visibility via opacity instead of filters.
 */
const TILE_GLASS_RADIUS_EXPR: unknown[] = [
  'interpolate', ['linear'], ['zoom'], 9, 9, 12, 10, 14, 11, 16, 12,
]

const TILE_HALO_RADIUS_EXPR: unknown[] = [
  'interpolate', ['linear'], ['zoom'], 9, 14, 12, 16, 16, 20,
]

const TILE_LIVE_ACTIVITY_EXPR: unknown[] = [
  'any',
  ['!=', ['coalesce', ['feature-state', 'motion'], 'static'], 'static'],
  ['>', ['coalesce', ['feature-state', 'breakout'], 0], 0],
  ['>', ['coalesce', ['feature-state', 'priority_tier'], 0], 0],
]

/** Halo only when live activity / priority enrichment is present — never a standalone orb */
const TILE_HALO_OPACITY_EXPR: unknown[] = [
  'case',
  TILE_LIVE_ACTIVITY_EXPR,
  ['coalesce', ['feature-state', 'halo_opacity'], 0.06],
  0,
]

const TILE_RING_WIDTH_EXPR: unknown[] = [
  'case',
  ['==', ['coalesce', ['feature-state', 'pin_selected'], 0], 1], 3.2,
  ['==', ['coalesce', ['feature-state', 'double_ring'], 0], 1], 2.8,
  2.2,
]

const TILE_RING_OPACITY_EXPR: unknown[] = [
  '*',
  ['coalesce', ['feature-state', 'ring_opacity'], 0.92],
  ['coalesce', ['feature-state', 'base_opacity'], 1],
]

const TILE_ICON_SCALE_EXPR: unknown[] = [
  'interpolate', ['linear'], ['zoom'], 8, 0.42, 11, 0.52, 13, 0.62, 16, 0.72,
]

const TILE_PULSE_OPACITY_EXPR: unknown[] = [
  'case',
  ['all',
    TILE_LIVE_ACTIVITY_EXPR,
    ['!=', ['coalesce', ['feature-state', 'motion'], 'static'], 'static'],
  ],
  0.12,
  0,
]

const TILE_LAYER_MIN_ZOOM = 9

export const ALL_PROPERTY_TILE_LAYER_IDS = Object.values(PROPERTY_TILES_LAYER_IDS)

export const getPropertyTileLayerInstallStatus = (map: maplibregl.Map): {
  sourceInstalled: boolean
  installedLayerIds: string[]
  missingLayerIds: string[]
} => {
  const installedLayerIds = ALL_PROPERTY_TILE_LAYER_IDS.filter((id) => Boolean(map.getLayer(id)))
  return {
    sourceInstalled: Boolean(map.getSource(PROPERTY_TILES_SOURCE_ID)),
    installedLayerIds,
    missingLayerIds: ALL_PROPERTY_TILE_LAYER_IDS.filter((id) => !installedLayerIds.includes(id)),
  }
}

export const ensurePropertyTileSourceAndLayers = (
  map: maplibregl.Map,
  themeId: CommandMapThemeId,
  beforeLayerId?: string,
): void => {
  const puTokens = getMapThemeTokens(themeId)
  const puPinTokens = getMapPinThemeTokens(themeId)

  const tilesTemplate = buildPropertyTilesUrlTemplate()
  const existingSource = map.getSource(PROPERTY_TILES_SOURCE_ID) as { tiles?: string[] } | undefined
  const existingTileUrl = existingSource?.tiles?.[0] ?? ''
  const needsSourceRefresh = Boolean(
    existingSource
    && (existingTileUrl.startsWith('/') || !existingTileUrl.startsWith('http')),
  )

  if (needsSourceRefresh) {
    for (const layerId of ALL_PROPERTY_TILE_LAYER_IDS) {
      if (map.getLayer(layerId)) map.removeLayer(layerId)
    }
    map.removeSource(PROPERTY_TILES_SOURCE_ID)
  }

  if (!map.getSource(PROPERTY_TILES_SOURCE_ID)) {
    map.addSource(PROPERTY_TILES_SOURCE_ID, {
      type: 'vector',
      tiles: [tilesTemplate],
      minzoom: 9,
      maxzoom: 16,
      promoteId: 'property_id',
    })
  }

  const addLayer = (layer: maplibregl.LayerSpecification) => {
    if (map.getLayer(layer.id)) return
    const attempts: Array<() => void> = beforeLayerId
      ? [
        () => map.addLayer(layer, beforeLayerId),
        () => map.addLayer(layer),
      ]
      : [() => map.addLayer(layer)]

    let lastError: unknown
    for (const attempt of attempts) {
      try {
        attempt()
        if (map.getLayer(layer.id)) return
        lastError = new Error('layer missing after addLayer')
      } catch (error) {
        lastError = error
      }
    }
    console.warn('[property-tiles] failed to add layer', layer.id, lastError)
  }

  addLayer({
    id: PROPERTY_TILES_LAYER_IDS.hit,
    type: 'circle',
    source: PROPERTY_TILES_SOURCE_ID,
    'source-layer': PROPERTY_TILES_SOURCE_LAYER,
    minzoom: TILE_LAYER_MIN_ZOOM,
    paint: {
      'circle-radius': PIN_HIT_RADIUS_EXPR as maplibregl.ExpressionSpecification,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-opacity': 0.01,
    },
    layout: { visibility: 'none' },
  })

  addLayer({
    id: PROPERTY_TILES_LAYER_IDS.halo,
    type: 'circle',
    source: PROPERTY_TILES_SOURCE_ID,
    'source-layer': PROPERTY_TILES_SOURCE_LAYER,
    minzoom: TILE_LAYER_MIN_ZOOM,
    paint: {
      'circle-radius': TILE_HALO_RADIUS_EXPR as maplibregl.ExpressionSpecification,
      'circle-blur': 0.62,
      'circle-opacity': TILE_HALO_OPACITY_EXPR as maplibregl.ExpressionSpecification,
      'circle-color': TILE_HALO_COLOR_EXPR as maplibregl.ExpressionSpecification,
    },
    layout: { visibility: 'none' },
  })

  addLayer({
    id: PROPERTY_TILES_LAYER_IDS.glass,
    type: 'circle',
    source: PROPERTY_TILES_SOURCE_ID,
    'source-layer': PROPERTY_TILES_SOURCE_LAYER,
    minzoom: TILE_LAYER_MIN_ZOOM,
    paint: {
      'circle-radius': TILE_GLASS_RADIUS_EXPR as maplibregl.ExpressionSpecification,
      'circle-color': ['coalesce', ['feature-state', 'glass_color'], puPinTokens.glassFill] as maplibregl.ExpressionSpecification,
      'circle-opacity': [
        '*',
        ['coalesce', ['feature-state', 'glass_opacity'], 0.84],
        ['coalesce', ['feature-state', 'base_opacity'], 1],
      ] as maplibregl.ExpressionSpecification,
      'circle-stroke-width': 0,
    },
    layout: { visibility: 'none' },
  })

  addLayer({
    id: PROPERTY_TILES_LAYER_IDS.ring,
    type: 'circle',
    source: PROPERTY_TILES_SOURCE_ID,
    'source-layer': PROPERTY_TILES_SOURCE_LAYER,
    minzoom: TILE_LAYER_MIN_ZOOM,
    paint: {
      'circle-radius': TILE_GLASS_RADIUS_EXPR as maplibregl.ExpressionSpecification,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': TILE_RING_STROKE_EXPR as maplibregl.ExpressionSpecification,
      'circle-stroke-width': TILE_RING_WIDTH_EXPR as maplibregl.ExpressionSpecification,
      'circle-stroke-opacity': TILE_RING_OPACITY_EXPR as maplibregl.ExpressionSpecification,
    },
    layout: { visibility: 'none' },
  })

  addLayer({
    id: PROPERTY_TILES_LAYER_IDS.pulse,
    type: 'circle',
    source: PROPERTY_TILES_SOURCE_ID,
    'source-layer': PROPERTY_TILES_SOURCE_LAYER,
    minzoom: TILE_LAYER_MIN_ZOOM,
    paint: {
      'circle-radius': 12,
      'circle-color': TILE_HALO_COLOR_EXPR as maplibregl.ExpressionSpecification,
      'circle-opacity': TILE_PULSE_OPACITY_EXPR as maplibregl.ExpressionSpecification,
      'circle-blur': 0.35,
    },
    layout: { visibility: 'none' },
  })

  addLayer({
    id: PROPERTY_TILES_LAYER_IDS.icon,
    type: 'symbol',
    source: PROPERTY_TILES_SOURCE_ID,
    'source-layer': PROPERTY_TILES_SOURCE_LAYER,
    minzoom: TILE_LAYER_MIN_ZOOM,
    layout: {
      'icon-image': buildMarkerKeyIconImageExpr() as maplibregl.ExpressionSpecification,
      'icon-size': TILE_ICON_SCALE_EXPR as maplibregl.ExpressionSpecification,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      visibility: 'none',
    },
    paint: {
      'icon-color': buildMarkerKeyIconColorExpr() as maplibregl.ExpressionSpecification,
      'icon-opacity': [
        'max',
        0.96,
        ['*', puTokens.markerIconOpacity, ['coalesce', ['feature-state', 'base_opacity'], 1]],
      ] as maplibregl.ExpressionSpecification,
    },
  })
}

export const applyPropertyTileThemePaint = (
  map: maplibregl.Map,
  themeId: CommandMapThemeId,
): void => {
  const puTokens = getMapThemeTokens(themeId)
  const puPinTokens = getMapPinThemeTokens(themeId)

  if (map.getLayer(PROPERTY_TILES_LAYER_IDS.glass)) {
    map.setPaintProperty(
      PROPERTY_TILES_LAYER_IDS.glass,
      'circle-color',
      ['coalesce', ['feature-state', 'glass_color'], puPinTokens.glassFill] as maplibregl.ExpressionSpecification,
    )
  }
  if (map.getLayer(PROPERTY_TILES_LAYER_IDS.icon)) {
    map.setPaintProperty(
      PROPERTY_TILES_LAYER_IDS.icon,
      'icon-opacity',
      ['max', 0.96, ['*', puTokens.markerIconOpacity, ['coalesce', ['feature-state', 'base_opacity'], 1]]] as maplibregl.ExpressionSpecification,
    )
  }
}

export const countRepresentedPropertyTileFeatures = (map: maplibregl.Map): number => {
  if (!map.getLayer(PROPERTY_TILES_LAYER_IDS.icon)) return 0
  const rendered = map.queryRenderedFeatures(undefined, {
    layers: [PROPERTY_TILES_LAYER_IDS.icon],
  })
  const ids = new Set<string>()
  for (const feature of rendered) {
    const id = String(feature.properties?.property_id ?? feature.id ?? '')
    if (id) ids.add(id)
  }
  return ids.size
}

export type PropertyTileEnrichmentPin = {
  property_id?: string | null
  property_type?: string | null
  contact_status?: string | null
  activity_status?: string | null
  final_acquisition_score?: number | null
  seller_state?: string | null
  [key: string]: unknown
}

export const applyPropertyTileEnrichmentStates = (
  map: maplibregl.Map,
  pins: PropertyTileEnrichmentPin[],
  themeId: CommandMapThemeId,
  modeId: CommandMapIntelligenceModeId,
  selectedPropertyId: string | null,
): void => {
  if (!map.getSource(PROPERTY_TILES_SOURCE_ID)) return

  for (const pin of pins) {
    const propertyId = String(pin.property_id ?? '').trim()
    if (!propertyId) continue

    const enriched = enrichAcquisitionRadarFeature(
      {
        properties: {
          ...pin,
          property_id: propertyId,
          assetType: pin.property_type ?? '',
          markerState: pin.seller_state ?? pin.contact_status ?? 'uncontacted',
          acquisitionScore: Number(pin.final_acquisition_score) || 0,
          contactStatus: pin.contact_status,
          activityStatus: pin.activity_status,
        },
      },
      themeId,
      { selectedPropertyId, modeId },
    )

    try {
      map.setFeatureState(
        { source: PROPERTY_TILES_SOURCE_ID, sourceLayer: PROPERTY_TILES_SOURCE_LAYER, id: propertyId },
        {
          ring_color: enriched.ring_color,
          glass_color: enriched.glass_color,
          icon_color: enriched.icon_color,
          ring_opacity: enriched.ring_opacity,
          glass_opacity: enriched.glass_opacity,
          base_opacity: enriched.base_opacity,
          motion: enriched.motion,
          breakout: enriched.breakout,
          priority_tier: enriched.priority_tier,
          double_ring: enriched.double_ring,
          pin_selected: enriched.pin_selected,
          halo_opacity: enriched.halo_opacity,
          marker_scale: enriched.marker_scale,
        },
      )
    } catch {
      // Tile may not be loaded yet — state applies when feature renders
    }
  }
}

export const clearPropertyTileEnrichmentStates = (
  map: maplibregl.Map,
  propertyIds: string[],
): void => {
  if (!map.getSource(PROPERTY_TILES_SOURCE_ID)) return
  for (const propertyId of propertyIds) {
    try {
      map.removeFeatureState(
        { source: PROPERTY_TILES_SOURCE_ID, sourceLayer: PROPERTY_TILES_SOURCE_LAYER, id: propertyId },
      )
    } catch {
      // ignore
    }
  }
}