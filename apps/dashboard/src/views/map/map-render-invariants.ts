import type maplibregl from 'maplibre-gl'
import { PROPERTY_TILES_LAYER_IDS, PROPERTY_TILES_SOURCE_ID } from './map-property-tile-source'

const MARKET_AGGREGATE_LAYERS = {
  core: 'map-agg-cluster-core',
  count: 'map-agg-cluster-count',
}

const PROPERTY_UNIVERSE_CLUSTER = {
  core: 'prop-univ-cluster-core',
  count: 'prop-univ-cluster-count',
}

export type RenderInvariantViolation = {
  code: string
  message: string
  layerId?: string
}

const layerVisible = (map: maplibregl.Map, layerId: string): boolean => {
  if (!map.getLayer(layerId)) return false
  return map.getLayoutProperty(layerId, 'visibility') !== 'none'
}

const layerOpacityAboveZero = (map: maplibregl.Map, layerId: string, paintKey: string): boolean => {
  if (!map.getLayer(layerId)) return true
  const value = map.getPaintProperty(layerId, paintKey)
  return value === undefined || Number(value) > 0
}

/** Assert individual-marker and cluster rendering invariants for visible features. */
export const assertMapRenderInvariants = (
  map: maplibregl.Map,
): RenderInvariantViolation[] => {
  const violations: RenderInvariantViolation[] = []

  if (map.getSource(PROPERTY_TILES_SOURCE_ID)) {
    const halos = map.queryRenderedFeatures(undefined, { layers: [PROPERTY_TILES_LAYER_IDS.halo] })
    const sourceFeatures = map.querySourceFeatures(PROPERTY_TILES_SOURCE_ID, {
      sourceLayer: 'properties',
    })
    const sourceIds = new Set(sourceFeatures.map((f) => String(f.properties?.property_id ?? f.id ?? '')))

    for (const halo of halos) {
      const id = String(halo.properties?.property_id ?? halo.id ?? '')
      if (id && !sourceIds.has(id)) {
        violations.push({
          code: 'halo_without_icon',
          message: `Halo rendered without tile-backed property identity for ${id}`,
          layerId: PROPERTY_TILES_LAYER_IDS.halo,
        })
      }
    }

    if (layerVisible(map, PROPERTY_TILES_LAYER_IDS.icon) && !layerVisible(map, PROPERTY_TILES_LAYER_IDS.glass)) {
      violations.push({
        code: 'icon_without_glass_stack',
        message: 'Icon layer visible but glass body layer is hidden',
        layerId: PROPERTY_TILES_LAYER_IDS.icon,
      })
    }
  }

  for (const pair of [
    { core: MARKET_AGGREGATE_LAYERS.core, count: MARKET_AGGREGATE_LAYERS.count, scope: 'market_aggregate' },
    { core: PROPERTY_UNIVERSE_CLUSTER.core, count: PROPERTY_UNIVERSE_CLUSTER.count, scope: 'property_universe' },
  ]) {
    const counts = map.queryRenderedFeatures(undefined, { layers: [pair.count] })
    const bodies = map.queryRenderedFeatures(undefined, { layers: [pair.core] })
    if (counts.length > bodies.length) {
      violations.push({
        code: 'cluster_text_without_body',
        message: `${pair.scope}: ${counts.length} count labels vs ${bodies.length} cluster bodies`,
        layerId: pair.count,
      })
    }
    for (const body of bodies) {
      const count = Number(body.properties?.property_count ?? body.properties?.point_count ?? 0)
      if (count <= 0) {
        violations.push({
          code: 'cluster_body_zero_count',
          message: `${pair.scope}: cluster body with zero property count`,
          layerId: pair.core,
        })
      }
    }
    if (layerVisible(map, pair.count) && !layerOpacityAboveZero(map, pair.core, 'circle-opacity')) {
      violations.push({
        code: 'cluster_count_while_body_hidden',
        message: `${pair.scope}: count layer visible while core opacity is zero`,
        layerId: pair.count,
      })
    }
  }

  return violations
}

/** Detect duplicate rendered property markers keyed by property_id. */
export const findDuplicateRenderedPropertyIds = (map: maplibregl.Map): string[] => {
  const layers = [
    PROPERTY_TILES_LAYER_IDS.icon,
    'seller-pins-icon',
    'prop-univ-markers',
  ].filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none')

  const idToLayers = new Map<string, string[]>()
  for (const layerId of layers) {
    const rendered = map.queryRenderedFeatures(undefined, { layers: [layerId] })
    for (const feature of rendered) {
      const propertyId = String(feature.properties?.property_id ?? '').trim()
      if (!propertyId) continue
      const existing = idToLayers.get(propertyId) ?? []
      if (!existing.includes(layerId)) existing.push(layerId)
      idToLayers.set(propertyId, existing)
    }
  }

  return [...idToLayers.entries()]
    .filter(([, layerList]) => layerList.length > 1)
    .map(([propertyId, layerList]) => `${propertyId}:${layerList.join('+')}`)
}