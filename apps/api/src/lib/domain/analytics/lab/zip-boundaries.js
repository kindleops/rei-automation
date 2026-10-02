/**
 * ANALYTICS LAB — ZIP outlines for the heat map (read-only, bounded).
 *
 * Reads public.analytics_zip_boundaries(p_zips text[]) → (zip, geojson)
 * (migration 20261001122000, owner-approved for RC 7.1; EXECUTE is
 * service_role only, so this runs on the API's service-role client).
 *
 *   · only the ZIPs on screen, well-formed 5-digit, de-duplicated, ≤ 400
 *   · cached per ZIP set in memory (outlines are static: 10 min; a missing
 *     function 60 s so the outlines appear soon after the migration lands;
 *     any other failure 15 s)
 *   · NEVER throws: a missing function (PostgREST PGRST202 / 404) or any
 *     error answers { available: false } and the map keeps placing ZIPs at
 *     the centre of their properties
 *
 * Geometry is passed through as the function returns it (simplified at
 * 0.0005°, 5 decimals); the dashboard projects it into the same Albers USA
 * frame as the county polygons.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

export const MAX_ZIPS = 400
export const ZIP_OUTLINE_SOURCE = 'US Census ZCTA'
const TTL = 10 * 60_000
const MISSING_TTL = 60_000
const ERROR_TTL = 15_000
const MAX_ENTRIES = 64

/** The ZIPs a request may ask for: 5-digit, unique, sorted, at most 400. */
export function normalizeZips(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(',')
  const out = new Set()
  for (const v of raw) {
    if (out.size >= MAX_ZIPS) break
    const z = String(v ?? '').trim()
    if (/^[0-9]{5}$/.test(z)) out.add(z)
  }
  return [...out].sort()
}

const isMissingFunction = (error, status) =>
  error?.code === 'PGRST202' || status === 404 || /could not find the function/i.test(String(error?.message || ''))

const isOutline = (g) => Boolean(g && typeof g === 'object' && (g.type === 'Polygon' || g.type === 'MultiPolygon') && Array.isArray(g.coordinates) && g.coordinates.length)

export function createZipBoundaryReader({ supabase = defaultSupabase, clock = () => Date.now(), ttl = TTL, missingTtl = MISSING_TTL, errorTtl = ERROR_TTL } = {}) {
  const cache = new Map() // key -> { expires, promise }
  const stats = { rpcCalls: 0, cacheHits: 0 }

  async function fetchSet(zips) {
    stats.rpcCalls += 1
    try {
      const res = await supabase.rpc('analytics_zip_boundaries', { p_zips: zips })
      if (res?.error) {
        const missing = isMissingFunction(res.error, res.status)
        return { result: { available: false, reason: missing ? 'not_installed' : 'unavailable' }, life: missing ? missingTtl : errorTtl }
      }
      const asked = new Set(zips)
      const outlines = {}
      for (const row of Array.isArray(res?.data) ? res.data : []) {
        const z = String(row?.zip ?? '')
        if (asked.has(z) && isOutline(row?.geojson)) outlines[z] = row.geojson
      }
      return {
        result: { available: true, source: ZIP_OUTLINE_SOURCE, zips: outlines, missing: zips.filter((z) => !outlines[z]) },
        life: ttl,
      }
    } catch {
      return { result: { available: false, reason: 'unavailable' }, life: errorTtl }
    }
  }

  /** Outlines for the ZIPs on screen. Resolves; never rejects. */
  async function read(input) {
    const zips = normalizeZips(input)
    if (!zips.length) return { available: false, reason: 'no_zips' }
    const key = zips.join(',')
    const now = clock()
    const hit = cache.get(key)
    if (hit && hit.expires > now) { stats.cacheHits += 1; return (await hit.promise).result }
    const entry = { expires: Infinity, promise: fetchSet(zips) }
    cache.set(key, entry)
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value)
    const settled = await entry.promise
    entry.expires = clock() + settled.life
    return settled.result
  }

  return { read, stats }
}

const shared = createZipBoundaryReader()
export const readZipBoundaries = (input) => shared.read(input)
