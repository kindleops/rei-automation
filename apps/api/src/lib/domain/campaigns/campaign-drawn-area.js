/**
 * A polygon drawn on the Map, as a campaign filter.
 *
 * Owner (2026-09-30): "A drawn polygon should resolve the entire exact eligible
 * cohort server-side ... No arbitrary ordering, no silent truncation." The Map
 * used to hand Campaign Command the first 5,000 property ids of an area (in no
 * defined order); an 18,400-property area became an arbitrary 5,000-property
 * campaign, and the id list travelled in the request URL besides.
 *
 * Now the campaign stores the polygon itself (`properties.drawn_area`, a GeoJSON
 * Polygon) and the audience is resolved inside the database by
 * campaign_target_graph_in_area. Reach and Build both read through it, with
 * every other filter, the deterministic order and paging on top, so they count
 * and build the same exact cohort.
 */

export const DRAWN_AREA_FIELD_KEY = 'properties.drawn_area'
export const DRAWN_AREA_GRAPH_RPC = 'campaign_target_graph_in_area'
export const DRAWN_AREA_PROPERTY_COUNT_RPC = 'map_area_property_count'
export const DRAWN_AREA_MAX_VERTICES = 1000
// Below about one square metre a drawing is a line, not an area. Points drawn
// along a line are never exactly collinear in floating point, so a strict zero
// would let a sliver through. map_area_checked uses the same floor.
export const DRAWN_AREA_MIN_SQ_DEGREES = 1e-10

const REASONS = Object.freeze({
  invalid_drawn_area: 'the drawn area is not a valid polygon on the map',
  multiple_drawn_areas: 'a campaign can target one drawn area',
})

export function drawnAreaReasonMessage(reason) {
  return REASONS[reason] || REASONS.invalid_drawn_area
}

function isCoordinate(point) {
  return Array.isArray(point)
    && point.length >= 2
    && Number.isFinite(Number(point[0]))
    && Number.isFinite(Number(point[1]))
    && Math.abs(Number(point[0])) <= 180
    && Math.abs(Number(point[1])) <= 90
}

/**
 * A GeoJSON Polygon (one closed exterior ring) from either a GeoJSON Polygon or
 * a bare ring of [lng, lat] points. { ok: true, area } or { ok: false, reason }.
 */
export function normalizeDrawnArea(value) {
  let ring = null
  if (value && typeof value === 'object' && !Array.isArray(value) && value.type === 'Polygon') {
    ring = Array.isArray(value.coordinates) ? value.coordinates[0] : null
  } else if (Array.isArray(value)) {
    ring = value
  }
  if (!Array.isArray(ring) || !ring.every(isCoordinate)) return { ok: false, reason: 'invalid_drawn_area' }
  const points = ring.map((point) => [Number(point[0]), Number(point[1])])
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return { ok: false, reason: 'invalid_drawn_area' }
  if (first[0] !== last[0] || first[1] !== last[1]) points.push([first[0], first[1]])
  const distinct = new Set(points.slice(0, -1).map(([x, y]) => `${x},${y}`))
  if (distinct.size < 3 || points.length - 1 > DRAWN_AREA_MAX_VERTICES) return { ok: false, reason: 'invalid_drawn_area' }
  if (spanArea(points) < DRAWN_AREA_MIN_SQ_DEGREES) return { ok: false, reason: 'invalid_drawn_area' }
  return { ok: true, area: { type: 'Polygon', coordinates: [points] } }
}

/**
 * "Is this an area": the widest triangle standing on the longest
 * chord from the first point. Zero only when every point lies on one line, and
 * unlike the shoelace sum it does not cancel to zero for a self-crossing lasso
 * (a bow-tie's two lobes wind opposite ways), which the database repairs into
 * its polygonal parts and counts. Coordinates are taken relative to the first
 * point so a small area is not lost to cancellation between large products.
 */
function spanArea(points) {
  const [ox, oy] = points[0]
  const rel = points.map(([x, y]) => [x - ox, y - oy])
  let far = rel[0]
  for (const point of rel) if (Math.hypot(point[0], point[1]) > Math.hypot(far[0], far[1])) far = point
  let widest = 0
  for (const [x, y] of rel) widest = Math.max(widest, Math.abs(far[0] * y - far[1] * x) / 2)
  return widest
}

/** The drawn area among resolved filters (normalizeCatalogPreviewFilters output), or null. */
export function drawnAreaFromFilters(filters = []) {
  const filter = (filters || []).find((entry) => String(entry?.field_key || entry?.fieldKey || '') === DRAWN_AREA_FIELD_KEY)
  if (!filter) return null
  const normalized = normalizeDrawnArea(filter.value)
  return normalized.ok ? normalized.area : null
}

/**
 * The audience read for a campaign: the whole graph, or, with a drawn area, the
 * exact rows inside it (resolved in the database, filters and paging on top).
 * `selectOptions.count` asks for an exact count; a head-only count becomes a
 * one-row read because the area travels in the request body, never the URL.
 */
export function campaignGraphQuery(supabase, { area = null, table, columns, selectOptions } = {}) {
  if (!area) return supabase.from(table).select(columns, selectOptions)
  const count = selectOptions?.count
  const query = supabase.rpc(DRAWN_AREA_GRAPH_RPC, { p_area: area }, count ? { count } : undefined).select(columns)
  return selectOptions?.head ? query.limit(1) : query
}
