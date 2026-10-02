/**
 * MAP BOUNDARIES — administrative outlines (state, ZIP) for the Map's boundary
 * overlay, from geometry LeadCommand owns (risk_private.geography_authoritative:
 * US Census state polygons and ZCTA outlines). Read-only, server-only.
 *
 * Sources, in order:
 *   1. public.map_boundaries_in_bbox(level, bbox, tolerance)   (proposed 8.2
 *      migration 20261002123000; service_role only) — state and ZIP, GiST bbox
 *   2. ZIP only, until (1) exists: the ZIP keys whose property footprint meets
 *      the viewport (public.mv_map_search_areas, kind 'zip') → the RC 7.1
 *      public.analytics_zip_boundaries(p_zips) outlines (already applied)
 *   Anything else answers { available: false, reason } — never a guessed shape.
 *   County, city and market have NO polygon source in the database: refused
 *   with reason 'no_source'.
 *
 * Limits: the bbox is validated and snapped outward to a grid (so nearby pans
 * share one cache entry); ZIP needs zoom ≥ 9 and a box ≤ 4° × 4°; ≤ 400
 * features. Simplification tolerance follows the zoom. Results are cached in
 * memory (outlines are static: 30 min; a missing function 60 s; errors 15 s).
 * NEVER throws.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

export const BOUNDARY_LEVELS = Object.freeze(['state', 'zip'])
export const UNSUPPORTED_LEVELS = Object.freeze(['county', 'city', 'market'])
export const ZIP_MIN_ZOOM = 9
export const MAX_FEATURES = 400
export const BOUNDARY_SOURCE = Object.freeze({ state: 'US Census states', zip: 'US Census ZCTA' })
const TTL = 30 * 60_000
const MISSING_TTL = 60_000
const ERROR_TTL = 15_000
const MAX_ENTRIES = 96

const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Tolerance (degrees) for a level at a zoom: coarser when zoomed out. */
export function toleranceFor(level, zoom) {
  if (level === 'state') return zoom < 5 ? 0.02 : zoom < 7 ? 0.008 : zoom < 9 ? 0.003 : 0.001
  return zoom < 11 ? 0.001 : zoom < 13 ? 0.0004 : 0.0002
}

/** Grid the bbox is snapped to: one cache entry per neighbourhood of pans. */
const snapStep = (level, zoom) => (level === 'state' ? (zoom < 6 ? 10 : 2) : zoom < 11 ? 0.5 : 0.25)

/**
 * Validate and normalise a request. Returns { ok: true, level, zoom, bbox, tolerance }
 * or { ok: false, reason } (a refusal, not an error).
 */
export function normalizeBoundaryRequest({ level, bbox, zoom } = {}) {
  const lv = String(level ?? '').trim().toLowerCase()
  if (UNSUPPORTED_LEVELS.includes(lv)) return { ok: false, reason: 'no_source' }
  if (!BOUNDARY_LEVELS.includes(lv)) return { ok: false, reason: 'bad_level' }
  const parts = (Array.isArray(bbox) ? bbox : String(bbox ?? '').split(',')).map(num)
  if (parts.length !== 4 || parts.some((v) => v === null)) return { ok: false, reason: 'bad_bbox' }
  let [w, s, e, n] = parts
  if (!(w < e && s < n) || w < -180 || e > 180 || s < -90 || n > 90) return { ok: false, reason: 'bad_bbox' }
  const z = num(zoom)
  if (z === null || z < 0 || z > 24) return { ok: false, reason: 'bad_zoom' }
  if (lv === 'zip' && z < ZIP_MIN_ZOOM) return { ok: false, reason: 'zoom_out' }
  const step = snapStep(lv, z)
  w = Math.max(-180, Math.floor(w / step) * step)
  s = Math.max(-90, Math.floor(s / step) * step)
  e = Math.min(180, Math.ceil(e / step) * step)
  n = Math.min(90, Math.ceil(n / step) * step)
  // ZIP outlines are dense: a box wider than ~4° is refused (zoom in). States are 33 rows
  // nationwide, so any box is fine.
  if (lv === 'zip' && (e - w > 4 || n - s > 4)) return { ok: false, reason: 'too_large' }
  const r = (v) => Math.round(v * 1e4) / 1e4
  return { ok: true, level: lv, zoom: z, bbox: [r(w), r(s), r(e), r(n)], tolerance: toleranceFor(lv, z) }
}

const isMissingFunction = (error, status) =>
  error?.code === 'PGRST202' || error?.code === '42883' || status === 404 || /could not find the function|does not exist/i.test(String(error?.message || ''))

const isOutline = (g) => Boolean(g && typeof g === 'object' && (g.type === 'Polygon' || g.type === 'MultiPolygon') && Array.isArray(g.coordinates) && g.coordinates.length)

function collection(level, rows) {
  const features = []
  for (const row of rows) {
    if (features.length >= MAX_FEATURES) break
    if (!isOutline(row?.geojson)) continue
    const key = String(row.key ?? '')
    features.push({ type: 'Feature', id: `${level}:${key}`, geometry: row.geojson, properties: { level, key, label: row.label ?? key } })
  }
  return { type: 'FeatureCollection', features }
}

export function createMapBoundaryReader({ supabase = defaultSupabase, clock = () => Date.now(), ttl = TTL, missingTtl = MISSING_TTL, errorTtl = ERROR_TTL } = {}) {
  const cache = new Map()
  const stats = { rpcCalls: 0, cacheHits: 0, fallbackCalls: 0 }

  async function viaFunction(req) {
    stats.rpcCalls += 1
    const [w, s, e, n] = req.bbox
    const res = await supabase.rpc('map_boundaries_in_bbox', { p_level: req.level, p_min_lng: w, p_min_lat: s, p_max_lng: e, p_max_lat: n, p_tolerance: req.tolerance })
    if (res?.error) return { missing: isMissingFunction(res.error, res.status), error: res.error }
    const rows = (Array.isArray(res?.data) ? res.data : []).map((r) => ({ key: r.label ?? String(r.geo_id ?? '').split(':')[1], label: r.label, geojson: r.geojson }))
    return { rows }
  }

  async function zipFallback(req) {
    stats.fallbackCalls += 1
    const [w, s, e, n] = req.bbox
    const areas = await supabase
      .from('mv_map_search_areas')
      .select('key')
      .eq('kind', 'zip')
      .lte('min_lat', n).gte('max_lat', s)
      .lte('min_lng', e).gte('max_lng', w)
      .limit(MAX_FEATURES)
    if (areas?.error) return { error: areas.error }
    const zips = [...new Set((areas?.data || []).map((r) => String(r.key ?? '')).filter((z) => /^[0-9]{5}$/.test(z)))].sort()
    if (!zips.length) return { rows: [] }
    const res = await supabase.rpc('analytics_zip_boundaries', { p_zips: zips })
    if (res?.error) return { missing: isMissingFunction(res.error, res.status), error: res.error }
    return { rows: (Array.isArray(res?.data) ? res.data : []).map((r) => ({ key: String(r.zip ?? ''), label: String(r.zip ?? ''), geojson: r.geojson })), asked: zips.length }
  }

  async function fetchFor(req) {
    try {
      const primary = await viaFunction(req)
      if (primary.rows) {
        return { result: { available: true, level: req.level, source: BOUNDARY_SOURCE[req.level], via: 'map_boundaries_in_bbox', bbox: req.bbox, tolerance: req.tolerance, data: collection(req.level, primary.rows) }, life: ttl }
      }
      if (!primary.missing) return { result: { available: false, level: req.level, reason: 'unavailable' }, life: errorTtl }
      if (req.level !== 'zip') return { result: { available: false, level: req.level, reason: 'not_installed' }, life: missingTtl }
      const fb = await zipFallback(req)
      if (fb.rows) {
        const data = collection('zip', fb.rows)
        return {
          // the primary function is not installed yet: re-check it soon, keep the outlines meanwhile
          result: { available: true, level: 'zip', source: BOUNDARY_SOURCE.zip, via: 'analytics_zip_boundaries', bbox: req.bbox, tolerance: 0.0005, data, coverage: { zips_in_view: fb.asked ?? 0, outlined: data.features.length } },
          life: missingTtl,
        }
      }
      return { result: { available: false, level: 'zip', reason: fb.missing ? 'not_installed' : 'unavailable' }, life: fb.missing ? missingTtl : errorTtl }
    } catch {
      return { result: { available: false, level: req.level, reason: 'unavailable' }, life: errorTtl }
    }
  }

  /** Outlines for a viewport. Resolves; never rejects. */
  async function read(input) {
    const req = normalizeBoundaryRequest(input)
    if (!req.ok) return { available: false, level: String(input?.level ?? ''), reason: req.reason }
    const key = `${req.level}|${req.bbox.join(',')}|${req.tolerance}`
    const now = clock()
    const hit = cache.get(key)
    if (hit && hit.expires > now) { stats.cacheHits += 1; return (await hit.promise).result }
    const entry = { expires: Infinity, promise: fetchFor(req) }
    cache.set(key, entry)
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value)
    const settled = await entry.promise
    entry.expires = clock() + settled.life
    return settled.result
  }

  return { read, stats }
}

const shared = createMapBoundaryReader()
export const readMapBoundaries = (input) => shared.read(input)
