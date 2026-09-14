import type maplibregl from 'maplibre-gl'
import { PROPERTY_TILES_LAYER_IDS } from './map-property-tile-source'
import { shouldUseAggregateSource, shouldUseVectorTileSource } from './map-property-source'

/**
 * THE ONE OWNER OF GENERIC PROPERTY INVENTORY.
 *
 * "Generic inventory" means the background universe of properties the operator has not
 * touched — the dots that answer "what is here". It is distinct from the OPERATIONAL
 * OVERLAY (conversations, offers, live activity), which is drawn by the command-pin
 * family and is not governed by this module.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * Generic-inventory visibility was previously decided in three places that all wrote
 * `visibility` on the same layers, from two independent React effects:
 *
 *   applySellerPinFieldPresentation   hid the MVT tiles outright
 *   applyMasterFilterMapLayerOverride the only path that ever showed them
 *   applyZoomBandVisibility           computed its own answer and wrote them again
 *
 * The two `sellerPinFieldActive` computations were not even the same expression: the
 * first ANDed in `isSellerPinIconLayerReady(map)`, the second did not. The seller-pins
 * icon layer is never created in this configuration, so the two resolvers permanently
 * disagreed, and which one wrote last depended on effect ordering and on whether the
 * seller GeoJSON had arrived yet. Measured symptom: MVT reported 6/6 layers visible at
 * z11 on one fresh arrival and 0/6 on the next, with 26,415 symbols painted in one pass
 * and none in another. That is not a tuning problem, it is an ownership problem.
 *
 * ── The contract ──────────────────────────────────────────────────────────────
 * One function, three inputs, a TOTAL answer. `visibility` names EVERY managed layer
 * explicitly on every call — there is no "leave this family alone" branch, because that
 * branch is precisely how a stale value from another resolver survived.
 *
 * Note what is deliberately NOT an input: whether a seller sprite layer happens to
 * exist, and how many features the bounded GeoJSON fetch has returned so far. Both are
 * arrival-timing artefacts. Letting them decide ownership is what made the render
 * non-deterministic across identical runs.
 */

/** Cluster/aggregate rollups — the only generic renderer below tile minzoom. */
export const MARKET_AGGREGATE_LAYER_IDS = {
  halo: 'map-agg-cluster-halo',
  core: 'map-agg-cluster-core',
  ring: 'map-agg-cluster-ring',
  icon: 'map-agg-cluster-icon',
  count: 'map-agg-cluster-count',
} as const

/**
 * Legacy bounded-GeoJSON property stack. Superseded by the MVT tiles, which carry the
 * same universe with no row cap; retained because its layers still exist in installed
 * styles and must be explicitly switched off rather than left to a stale value.
 */
export const PROPERTY_UNIVERSE_LAYER_IDS = {
  clusterRing:  'prop-univ-cluster-ring',
  clusterCore:  'prop-univ-cluster-core',
  clusterIcon:  'prop-univ-cluster-icon',
  clusterCount: 'prop-univ-cluster-count',
  markerHit:    'prop-univ-marker-hit',
  markerGlow:   'prop-univ-marker-glow',
  markerGlass:  'prop-univ-marker-glass',
  markerRing:   'prop-univ-marker-ring',
  markerPulse:  'prop-univ-marker-pulse',
  markers:      'prop-univ-markers',
} as const

/** The other legacy bounded path: a seller-lead GeoJSON field. Also superseded. */
export const SELLER_PINS_LAYER_IDS = {
  hit: 'seller-pins-hit',
  glow: 'seller-pins-glow',
  pulse: 'seller-pins-pulse',
  ring: 'seller-pins-ring',
  core: 'seller-pins-core',
  icon: 'seller-pins-icon',
  clusterGlow: 'seller-pins-cluster-glow',
  clusterCore: 'seller-pins-cluster-core',
  clusterCount: 'seller-pins-cluster-count',
} as const

/**
 * Which family draws generic inventory right now.
 *
 *   aggregates  below tile minzoom: market rollups, because there are no tiles to draw
 *   mvt         z>=9: the PostGIS vector tiles, the complete universe
 *   none        the operator has switched the property field off
 */
export type GenericInventoryOwner = 'aggregates' | 'mvt' | 'none'

export interface GenericInventoryInputs {
  zoom: number
  /** The operator's property-field toggle. Off means no generic inventory at all. */
  propertyFieldEnabled: boolean
  /**
   * A Master Filter is a FILTER OVER the canonical universe, not a different renderer.
   * It changes the tile URL token, never the owner — which is why it does not appear in
   * the owner computation below and only survives as a recorded reason.
   */
  masterFilterActive: boolean
}

export interface GenericInventoryDecision {
  owner: GenericInventoryOwner
  /** Human-readable, surfaced to the QA harness so a wrong owner is attributable. */
  reason: string
  /** Total over every managed layer. Never partial. */
  visibility: Record<string, 'visible' | 'none'>
}

const MVT_LAYER_IDS = Object.values(PROPERTY_TILES_LAYER_IDS)
const AGGREGATE_LAYER_IDS = Object.values(MARKET_AGGREGATE_LAYER_IDS)
const LEGACY_UNIVERSE_LAYER_IDS = Object.values(PROPERTY_UNIVERSE_LAYER_IDS)
const LEGACY_SELLER_FIELD_LAYER_IDS = Object.values(SELLER_PINS_LAYER_IDS)

/** Every layer this module owns. A layer absent from here is owned by nobody. */
export const GENERIC_INVENTORY_LAYER_IDS: readonly string[] = [
  ...MVT_LAYER_IDS,
  ...AGGREGATE_LAYER_IDS,
  ...LEGACY_UNIVERSE_LAYER_IDS,
  ...LEGACY_SELLER_FIELD_LAYER_IDS,
]

const assign = (
  target: Record<string, 'visible' | 'none'>,
  layerIds: readonly string[],
  value: 'visible' | 'none',
) => {
  for (const layerId of layerIds) target[layerId] = value
  return target
}

/**
 * Resolve the owner. Pure — no map, no refs, no timing. This is the function the
 * determinism guarantee rests on: identical inputs give an identical total answer, so
 * two fresh arrivals at the same zoom cannot render differently.
 */
export const resolveGenericInventoryOwner = (
  inputs: GenericInventoryInputs,
): GenericInventoryDecision => {
  const { zoom, propertyFieldEnabled, masterFilterActive } = inputs
  const visibility: Record<string, 'visible' | 'none'> = {}

  // Legacy bounded paths are off in every state. They are kept installable for styles
  // that still declare them, never drawn, and written explicitly so no other resolver's
  // leftover `visible` can survive a state change.
  assign(visibility, LEGACY_UNIVERSE_LAYER_IDS, 'none')
  assign(visibility, LEGACY_SELLER_FIELD_LAYER_IDS, 'none')

  if (!propertyFieldEnabled) {
    assign(visibility, MVT_LAYER_IDS, 'none')
    assign(visibility, AGGREGATE_LAYER_IDS, 'none')
    return { owner: 'none', reason: 'property field toggled off', visibility }
  }

  if (shouldUseAggregateSource(zoom)) {
    assign(visibility, MVT_LAYER_IDS, 'none')
    assign(visibility, AGGREGATE_LAYER_IDS, 'visible')
    return { owner: 'aggregates', reason: `z${zoom.toFixed(2)} below tile minzoom`, visibility }
  }

  if (shouldUseVectorTileSource(zoom)) {
    assign(visibility, MVT_LAYER_IDS, 'visible')
    assign(visibility, AGGREGATE_LAYER_IDS, 'none')
    return {
      owner: 'mvt',
      reason: masterFilterActive
        ? `z${zoom.toFixed(2)} canonical MVT universe, master-filter scoped`
        : `z${zoom.toFixed(2)} canonical MVT universe`,
      visibility,
    }
  }

  /**
   * Unreachable while the two predicates partition the zoom line, and asserted rather
   * than assumed: a future band edit that opens a gap here would otherwise show up as a
   * blank map, which is the hardest possible symptom to attribute back to this file.
   */
  assign(visibility, MVT_LAYER_IDS, 'none')
  assign(visibility, AGGREGATE_LAYER_IDS, 'none')
  return { owner: 'none', reason: `z${zoom.toFixed(2)} in no zoom band — band gap`, visibility }
}

/** The last decision applied, for the proof harness. Dev diagnostics only. */
let lastDecision: (GenericInventoryDecision & { appliedLayers: number }) | null = null
export const getLastGenericInventoryDecision = () => lastDecision

/**
 * Resolve and write. The ONLY place `visibility` is set on a generic-inventory layer.
 */
export const applyGenericInventoryOwner = (
  map: maplibregl.Map,
  inputs: GenericInventoryInputs,
): GenericInventoryDecision => {
  const decision = resolveGenericInventoryOwner(inputs)
  let appliedLayers = 0
  for (const [layerId, value] of Object.entries(decision.visibility)) {
    if (!map.getLayer(layerId)) continue
    try {
      map.setLayoutProperty(layerId, 'visibility', value)
      appliedLayers += 1
    } catch {
      /* A layer removed by a concurrent style swap is not an error. */
    }
  }
  lastDecision = { ...decision, appliedLayers }
  if (typeof window !== 'undefined' && import.meta.env.DEV) {
    ;(window as unknown as Record<string, unknown>).__nexusInventoryOwner = lastDecision
  }
  return decision
}
