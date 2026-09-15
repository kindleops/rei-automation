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
 * ── What the tile can and cannot tell us ──────────────────────────────────────
 * An earlier revision admitted anything with `contact_status != 'uncontacted'` or a
 * non-empty `activity_status`, described as "a property the operator is actively
 * working". Measured against the live table, neither clause means that:
 *
 *   properties.contact_status holds exactly two values across all 169,802 rows —
 *   'No Contact' (121,182) and NULL (48,620). It never indicates contact. So
 *   `!= 'uncontacted'` was true for every non-null row, and the filter admitted 71% of
 *   the universe under a claim that was false of all of it. In the Miami test viewport
 *   that was 3,443 of 5,160 properties, every one of them labelled 'No Contact'.
 *
 *   properties.activity_status describes the PROPERTY ("Active for 12 months or
 *   longer", "Inactive monthly for 2 months"), not outreach.
 *
 * The tile carries six fields and none of them identify operator work. That is fine,
 * because operator work is not this family's job: live conversations are drawn by the
 * command-pin overlay on top of this layer, and the selected property is admitted
 * explicitly below. Generic inventory only has to answer "what is here", legibly.
 *
 * ── Two honest mechanisms instead of one false one ────────────────────────────
 * SCORE, tuned to the distribution that actually exists. In the test viewport the
 * legacy score is 0 for 88% of rows, p90 = 44, p99 = 77 and the maximum is 88 — so the
 * previous metro floor of 92 could not admit a single property anywhere, and the whole
 * ladder was calibrated against a range the data never reaches.
 *
 * DETERMINISTIC SAMPLING, for the 88% that have no score at all. Without it a score
 * floor would blank those properties entirely below street zoom and then reveal all of
 * them at once — a cliff, not progressive disclosure. The sample is taken from the last
 * two digits of `property_id`, which is numeric for 169,795 of 169,802 rows: uniform
 * enough, costs nothing, and — the point — is a pure function of the id, so the same
 * properties survive every pan, every zoom and every reload. A random sample would make
 * the map flicker on every frame.
 */
const SCORE_EXPR: unknown[] = ['coalesce', ['get', 'acquisition_score'], 0]

/**
 * A stable 0-99 bucket per property. `slice` takes the last two characters rather than
 * the number modulo 100 because ids run up to 35 digits, which loses integer precision
 * as a float — the bucket would stop being stable exactly where ids are longest.
 */
const BUCKET_EXPR: unknown[] = [
  'coalesce',
  ['to-number', ['slice', ['to-string', ['get', 'property_id']], -2], 0],
  0,
]

/**
 * A much finer stable key, 0-999999, used ONLY to break ties in collision order.
 *
 * The 0-99 bucket above is the right granularity for sampling but the wrong one for
 * ordering: with hundreds of properties in view and 88% of them scoring 0, the sort key
 * had about a hundred distinct values and everything else tied. MapLibre breaks ties by
 * tile order, which depends on the order tiles arrived, so which pins survived collision
 * changed between runs — measured at z12 as 73 markers in one run and 63 in the next
 * from an identical admitted set of 540.
 *
 * Six digits gives roughly a 10^6 space, so ties are rare enough not to matter at any
 * realistic pin count, and the order is still a pure function of the id: the same pins
 * survive the same way on every pan, zoom and reload.
 */
const TIEBREAK_EXPR: unknown[] = [
  'coalesce',
  ['to-number', ['slice', ['to-string', ['get', 'property_id']], -6], 0],
  0,
]

/**
 * The ladder, by what the operator is looking at:
 *   metro         the shape of a market
 *   district      which neighbourhoods are worth a look
 *   neighborhood  individual streets
 *   street        every property, because that is the point of being this close
 *
 * ── Why these are JS functions and not `['step', ['zoom'], ...]` ──────────────
 * They were step expressions, evaluated inside the layer FILTER. MapLibre does not
 * evaluate a zoom expression in a filter against the live camera — it resolves it per
 * tile, at the tile's own zoom, when the tile is loaded. So which properties a filter
 * admitted depended on which tiles happened to be in the cache and when they arrived.
 *
 * Measured across two fresh runs at identical cameras, with identical source counts:
 * z13 admitted 42 in one run and 153 in the other, z14 13 against 49, z11 403 against
 * 874. The render was genuinely different between runs, not just the measurement — the
 * exact flicker this phase exists to eliminate, introduced by the fix for it.
 *
 * Resolving the zoom in JS and emitting LITERAL numbers removes the ambiguity: the
 * filter has no zoom term, so it means one thing. The cost is that it has to be
 * re-applied when the zoom band changes, which applyPropertyDensity now does.
 */
export const scoreFloorForZoom = (zoom: number): number => {
  if (zoom < 11) return 70    // metro       — roughly the top 1% of scored properties
  if (zoom < 13) return 45    // district    — roughly the top 10%
  if (zoom < 14.5) return 20  // neighborhood
  return 0                    // street      — everything
}

/** Share of the 0-99 bucket space admitted regardless of score, by the same bands. */
export const sampleQuotaForZoom = (zoom: number): number => {
  if (zoom < 11) return 2     // ~2% of unscored inventory, enough to read a market
  if (zoom < 13) return 8
  if (zoom < 14.5) return 30
  return 100                  // all of it
}

/**
 * The one filter, applied identically to every marker layer.
 *
 * `selectedPropertyId` is always admitted regardless of score or zoom: the operator's
 * subject may not survive a score floor, and it disappearing when they zoom out is the
 * single worst thing this system could do.
 */
export const buildPropertyDensityFilter = (
  selectedPropertyId: string | null,
  zoom: number,
): maplibregl.FilterSpecification => {
  const admit: unknown[] = [
    'any',
    ['>=', SCORE_EXPR, scoreFloorForZoom(zoom)],
    ['<', BUCKET_EXPR, sampleQuotaForZoom(zoom)],
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
  /**
   * 1..102, best score first, with a fine stable sub-unit tie-break. Ties are the common
   * case here — 88% of properties score 0 — and MapLibre breaks them by tile order,
   * which depends on the order tiles arrived. That is visible as pins swapping between
   * identical views.
   */
  expr.push(['+', ['-', 102, SCORE_EXPR], ['/', TIEBREAK_EXPR, 1_000_000]])
  return expr as unknown as maplibregl.ExpressionSpecification
}

/**
 * The layers that PAINT a property marker. They share one filter, always: if a future
 * change filters one of them differently, rings appear without icons and the map looks
 * broken in a way that is hard to attribute.
 */
export const PROPERTY_MARKER_VISUAL_LAYER_IDS = [
  'prop-tiles-halo',
  'prop-tiles-glass',
  'prop-tiles-ring',
  'prop-tiles-pulse',
  'prop-tiles-icon',
] as const

/**
 * The invisible tap target. It gets the density filter WITHOUT the subject exclusion,
 * so the selected property stays touchable underneath its gold star.
 */
export const PROPERTY_MARKER_HIT_LAYER_ID = 'prop-tiles-hit'

export const PROPERTY_MARKER_LAYER_IDS = [
  PROPERTY_MARKER_HIT_LAYER_ID,
  ...PROPERTY_MARKER_VISUAL_LAYER_IDS,
] as const
/**
 * The selection the density system was last applied with.
 *
 * Held at module scope so LAYER CREATION can re-apply the filter without threading the
 * selection through six call sites. `ensurePropertyTileSourceAndLayers` is invoked from
 * six places and any of them can re-add the layers; a layer added after the density
 * effect last ran carried NO filter, which is how a zoom band with a score floor of 78
 * still rendered 26,415 symbols.
 */
let currentDensitySelection: string | null = null

export const getDensitySelection = (): string | null => currentDensitySelection

/**
 * The zoom band the filter currently expresses, so a caller can tell whether a camera
 * move actually needs new filters — this runs on every move.
 */
let currentDensityBand: string | null = null

export const densityBandForZoom = (zoom: number): string =>
  `${scoreFloorForZoom(zoom)}:${sampleQuotaForZoom(zoom)}`

export const getDensityBand = (): string | null => currentDensityBand

export const applyPropertyDensity = (
  map: maplibregl.Map,
  selectedPropertyId: string | null,
): void => {
  currentDensitySelection = selectedPropertyId
  const zoom = map.getZoom()
  currentDensityBand = densityBandForZoom(zoom)
  const filter = buildPropertyDensityFilter(selectedPropertyId, zoom)

  /**
   * The SUBJECT KNOCKOUT: the selected property is drawn as a gold star that replaces
   * its house glyph, so the tile family must not also draw it.
   *
   * This is a filter rather than an opacity override because opacity cannot do it. The
   * tile icon's painted opacity is `['max', 0.96, ...]` — a floor applied by the theme
   * pass — so any knockout multiplied into it still resolves to 0.96. The previous
   * opacity-based knockout was silently defeated by that floor and the star had been
   * stacking on top of the pin it was meant to replace.
   *
   * The hit layer is deliberately excluded from the exclusion: filtering a marker out of
   * the tap target as well would make the operator's own subject the one thing on the map
   * they cannot tap.
   */
  const visualFilter = selectedPropertyId
    ? ([
      'all',
      filter,
      ['!=', ['to-string', ['coalesce', ['get', 'property_id'], '']], selectedPropertyId],
    ] as unknown as maplibregl.FilterSpecification)
    : filter

  for (const layerId of PROPERTY_MARKER_LAYER_IDS) {
    if (!map.getLayer(layerId)) continue
    try {
      map.setFilter(layerId, layerId === PROPERTY_MARKER_HIT_LAYER_ID ? filter : visualFilter)
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

/**
 * The conversation-overlay half of the subject knockout.
 *
 * `command-pin-core-raw` is deliberately absent: it already paints at circle-opacity 0,
 * so it is invisible but still hit-testable, and leaving it unfiltered keeps the subject
 * tappable once its visible pin is gone. Clustered layers are absent too — a cluster is
 * an aggregate, and hiding one because a member is selected would hide the rest.
 */
export const COMMAND_PIN_SUBJECT_LAYER_IDS = [
  'command-pin-icon-raw',
  'command-pin-glow-raw',
  'command-pin-pulse-raw',
  'command-pin-unread-ring-raw',
  'command-pin-offer-ring-raw',
  'command-pin-contract-ring-raw',
  'command-pin-warning-badge-raw',
] as const

/**
 * Exclude the subject from the conversation overlay, so the gold star is the only thing
 * drawn at that point.
 *
 * Lives here, next to the tile half, and re-applied from LAYER CREATION as well as from
 * the selection effect. Setting it only from the effect was not enough: these layers are
 * rebuilt by addMapLayers on every style load, which silently dropped the filter and put
 * the pin back underneath the star.
 */
export const applyCommandPinSubjectKnockout = (
  map: maplibregl.Map,
  selectedPropertyId: string | null,
): void => {
  const exclusion = selectedPropertyId
    ? ([
      '!=',
      ['to-string', ['coalesce', ['get', 'property_id'], ['get', 'propertyId'], '']],
      selectedPropertyId,
    ] as unknown as maplibregl.FilterSpecification)
    : null
  for (const layerId of COMMAND_PIN_SUBJECT_LAYER_IDS) {
    if (!map.getLayer(layerId)) continue
    try {
      map.setFilter(layerId, exclusion)
    } catch {
      /* A layer removed by a style swap mid-apply is not an error. */
    }
  }
}
