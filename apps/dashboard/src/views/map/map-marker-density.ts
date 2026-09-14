import type maplibregl from 'maplibre-gl'

/**
 * ZOOM-AWARE PROPERTY DENSITY.
 *
 * The property universe renders from vector tiles with collision switched OFF
 * (`icon-allow-overlap: true`, `icon-ignore-placement: true`) and no filter on any
 * layer, so every property in a tile painted at every zoom from 9 up. At neighbourhood
 * zoom in a dense market that is hundreds of house glyphs stacked on each other, and
 * the map stops being readable as anything.
 *
 * ── Why the existing helpers could not be used ────────────────────────────────
 * `buildIndividualPinVisibilityFilter` and `shouldShowIndividualPin` already existed
 * with zero consumers, and they filter on `breakout`, `semanticKey` and
 * `acquisitionScore`. The MVT tiles carry NONE of those. The server emits exactly six
 * properties per feature:
 *
 *     property_id · marker_key · market · contact_status · activity_status ·
 *     acquisition_score
 *
 * So those helpers could never have worked: `['get','breakout']` is null on every
 * feature, every clause is false, and wiring them up would have hidden the entire
 * universe. This is built on the fields that are actually in the tile.
 *
 * ── The model ─────────────────────────────────────────────────────────────────
 * Two mechanisms, deliberately layered, because either alone is insufficient:
 *
 *   1. A COUPLED FILTER on all five marker layers. Deterministic, identical on every
 *      layer, so a ring can never render without its icon. This does the bulk of the
 *      thinning and is what makes the behaviour predictable across pans.
 *   2. COLLISION on the icon layer, ordered by priority. This is the safety net for
 *      places the filter cannot anticipate — a cul-de-sac where thirty qualifying
 *      properties sit within forty metres. MapLibre drops the lowest-priority icons.
 *
 * Progressive disclosure is by PRIORITY, not by random sampling: zooming out removes
 * the least interesting properties, never the operator's live work.
 *
 * ── A note on acquisition_score ───────────────────────────────────────────────
 * `properties.final_acquisition_score` is a Podio-era import, not current Decision
 * Engine output, and must never be presented as AI confidence or current economics.
 * It is used here ONLY as a visual density ranking — which of two dots survives a
 * zoom-out — and never rendered as a number. That is a legitimate use of a legacy
 * signal; presenting it as authority would not be.
 */

/** Tiles are not served below this, so there is nothing to thin at national zoom. */
export const PROPERTY_TILE_MIN_ZOOM = 9

/**
 * A property the operator is actively working. These outrank score at every zoom, so
 * a live conversation never disappears because its legacy score is low.
 *
 * Derived from the two state columns the tile actually carries. `uncontacted` is the
 * server's default for "no outreach yet", so anything else means something happened.
 */
const ACTIVE_STATE_EXPR: unknown[] = [
  'any',
  ['all',
    ['has', 'contact_status'],
    ['!=', ['coalesce', ['get', 'contact_status'], 'uncontacted'], 'uncontacted'],
    ['!=', ['coalesce', ['get', 'contact_status'], ''], ''],
  ],
  ['all',
    ['has', 'activity_status'],
    ['!=', ['coalesce', ['get', 'activity_status'], ''], ''],
  ],
]

/**
 * Score floor by zoom band. Tuned against the live Miami dataset — see
 * scripts/proof/mobile/map-density-qa.mjs, which counts rendered icons and overlapping
 * pairs per band and is the reason these are the numbers they are.
 *
 * The bands are named for what the operator is looking at, not for zoom arithmetic:
 *   metro         the shape of a market
 *   district      which neighbourhoods are worth a look
 *   neighborhood  individual streets
 *   street        every property, because that is the point of being this close
 */
const SCORE_FLOOR_BY_ZOOM: unknown[] = [
  'step',
  ['zoom'],
  92,      // z < 11   metro          — only the strongest signals
  11, 78,  // z 11-13  district
  13, 45,  // z 13-14.5 neighborhood
  14.5, 0, // z >= 14.5 street        — everything
]

/**
 * The one filter, applied identically to every marker layer.
 *
 * `selectedPropertyId` is always admitted regardless of score or zoom: the operator's
 * subject may not survive a score floor, and it disappearing when they zoom out is the
 * single worst thing this system could do.
 */
export const buildPropertyDensityFilter = (
  selectedPropertyId: string | null,
): maplibregl.FilterSpecification => {
  const admit: unknown[] = [
    'any',
    ACTIVE_STATE_EXPR,
    ['>=', ['coalesce', ['get', 'acquisition_score'], 0], SCORE_FLOOR_BY_ZOOM],
  ]
  if (selectedPropertyId) {
    admit.push(['==', ['coalesce', ['get', 'property_id'], ''], selectedPropertyId])
  }
  return admit as unknown as maplibregl.FilterSpecification
}

/**
 * Collision ORDER. MapLibre places lower sort keys first and drops what no longer fits,
 * so this is the hierarchy expressed as a number:
 *
 *   0    the selected property — always placed
 *   1    actively worked properties
 *   2+   everything else, best score first
 *
 * Without a sort key MapLibre places in tile order, which is arbitrary, and the pin
 * that survived a zoom change would change from frame to frame — the flicker this
 * phase explicitly has to avoid.
 */
export const buildPropertySortKeyExpr = (
  selectedPropertyId: string | null,
): maplibregl.ExpressionSpecification => {
  const expr: unknown[] = ['case']
  if (selectedPropertyId) {
    expr.push(['==', ['coalesce', ['get', 'property_id'], ''], selectedPropertyId], 0)
  }
  expr.push(ACTIVE_STATE_EXPR, 1)
  // 2..102, best score first.
  expr.push(['-', 102, ['coalesce', ['get', 'acquisition_score'], 0]])
  return expr as unknown as maplibregl.ExpressionSpecification
}

/** Every layer that renders a property marker. They share one filter, always. */
export const PROPERTY_MARKER_LAYER_IDS = [
  'prop-tiles-hit',
  'prop-tiles-halo',
  'prop-tiles-glass',
  'prop-tiles-ring',
  'prop-tiles-pulse',
  'prop-tiles-icon',
] as const

/**
 * Apply the density system to a live map.
 *
 * Coupled on purpose: if a future change filters one layer differently, rings appear
 * without icons and the map looks broken in a way that is hard to attribute. One call
 * site, one filter, all layers.
 */
export const applyPropertyDensity = (
  map: maplibregl.Map,
  selectedPropertyId: string | null,
): void => {
  const filter = buildPropertyDensityFilter(selectedPropertyId)
  for (const layerId of PROPERTY_MARKER_LAYER_IDS) {
    if (!map.getLayer(layerId)) continue
    try {
      map.setFilter(layerId, filter)
    } catch {
      /* A layer removed by a style swap mid-apply is not an error. */
    }
  }

  if (map.getLayer('prop-tiles-icon')) {
    try {
      map.setLayoutProperty('prop-tiles-icon', 'symbol-sort-key', buildPropertySortKeyExpr(selectedPropertyId))
    } catch {
      /* ignore */
    }
  }
}
