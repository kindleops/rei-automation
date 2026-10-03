/**
 * CENSUS CELLS — the dashboard's one read model for ACS demographics.
 *
 * Source: public.exchange_market_fundamentals_cells (US Census ACS 5-year,
 * 2024 vintage: 1,325 ZCTAs, 403 places, 76 counties, 33 states — every cell
 * carries its margin of error and precision). Server-only (anon/authenticated
 * revoked), read here with the service client behind the operator gate.
 *
 * It replaces public.census_geo_metrics, which has never held a row (its
 * loader was a dev-only Vite middleware that never ran in production).
 *
 *   GET /api/cockpit/map/census?zip=55411            one ZCTA
 *   GET /api/cockpit/map/census?lat=..&lng=..         the ZCTA nearest a point
 *   GET /api/cockpit/map/census?bbox=w,s,e,n&level=   cells in a viewport
 *
 * Values are returned as published (shares 0..1, dollars, years) with their
 * MOE. No opportunity score, no grade. NEVER throws.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

export const CENSUS_LEVELS = Object.freeze({ zip: 'zip5', county: 'county', city: 'city', state: 'state' })
const CELL_COLS = [
  'geo_id', 'geo_level', 'geo_name', 'census_geoid', 'state_code', 'county_name', 'city_name', 'centroid_lat', 'centroid_lng', 'dataset', 'vintage',
  'population', 'population_moe', 'households', 'housing_units', 'vacancy_rate', 'vacancy_rate_moe', 'renter_share', 'renter_share_moe',
  'owner_share', 'owner_share_moe', 'median_household_income', 'median_household_income_moe', 'median_gross_rent', 'median_gross_rent_moe',
  'median_year_built', 'rent_burden', 'units_2_4_share', 'units_5plus_share',
].join(',')
const MAX_CELLS = 2000
const TTL = 60 * 60_000
const MAX_ENTRIES = 200
const cache = new Map()
export function _resetCensusCache() { cache.clear() }

const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)

/** One canonical cell as the dashboard reads it. */
export function shapeCensusCell(r) {
  if (!r) return null
  return {
    geo_id: r.geo_id,
    level: r.geo_level === 'zip5' ? 'zip' : r.geo_level,
    name: r.geo_name,
    census_geoid: r.census_geoid,
    state: r.state_code,
    county: r.county_name || null,
    city: r.city_name || null,
    lat: num(r.centroid_lat),
    lng: num(r.centroid_lng),
    source: { dataset: r.dataset || 'acs/acs5', vintage: num(r.vintage), attribution: 'US Census Bureau ACS 5-year' },
    population: num(r.population),
    population_moe: num(r.population_moe),
    households: num(r.households),
    housing_units: num(r.housing_units),
    vacancy_rate: num(r.vacancy_rate),
    vacancy_rate_moe: num(r.vacancy_rate_moe),
    renter_share: num(r.renter_share),
    renter_share_moe: num(r.renter_share_moe),
    owner_share: num(r.owner_share),
    owner_share_moe: num(r.owner_share_moe),
    median_household_income: num(r.median_household_income),
    median_household_income_moe: num(r.median_household_income_moe),
    median_gross_rent: num(r.median_gross_rent),
    median_gross_rent_moe: num(r.median_gross_rent_moe),
    median_year_built: num(r.median_year_built),
    rent_burden: num(r.rent_burden),
    units_2_4_share: num(r.units_2_4_share),
    units_5plus_share: num(r.units_5plus_share),
  }
}

function cached(key, now) {
  const hit = cache.get(key)
  return hit && hit.expires > now ? hit.value : null
}
function remember(key, value, now) {
  cache.set(key, { value, expires: now + TTL })
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value)
  return value
}

export async function getCensusCells(params = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const now = deps.now ?? Date.now()
  try {
    const zip = String(params.zip ?? '').trim()
    if (zip) {
      if (!/^\d{5}$/.test(zip)) return { ok: false, status: 400, error: 'bad_zip' }
      const key = `zip:${zip}`
      const hit = cached(key, now)
      if (hit) return hit
      const { data, error } = await db.from('exchange_market_fundamentals_cells').select(CELL_COLS).eq('geo_level', 'zip5').eq('census_geoid', zip).limit(1)
      if (error) return { ok: false, status: 502, error: 'census_unavailable' }
      const cell = shapeCensusCell(data?.[0])
      return remember(key, { ok: true, covered: Boolean(cell), cell, cells: cell ? [cell] : [] }, now)
    }
    const lat = num(params.lat)
    const lng = num(params.lng)
    if (lat !== null && lng !== null) {
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ok: false, status: 400, error: 'bad_point' }
      const r = 0.12
      const { data, error } = await db.from('exchange_market_fundamentals_cells').select(CELL_COLS).eq('geo_level', 'zip5')
        .gte('centroid_lat', lat - r).lte('centroid_lat', lat + r).gte('centroid_lng', lng - r).lte('centroid_lng', lng + r).limit(200)
      if (error) return { ok: false, status: 502, error: 'census_unavailable' }
      const best = (data || []).map(shapeCensusCell).filter((c) => c.lat !== null && c.lng !== null)
        .map((c) => ({ c, d: (c.lat - lat) ** 2 + ((c.lng - lng) * Math.cos((lat * Math.PI) / 180)) ** 2 }))
        .sort((a, b) => a.d - b.d)[0]?.c || null
      return { ok: true, covered: Boolean(best), cell: best, cells: best ? [best] : [], basis: best ? 'nearest_zcta_centroid' : null }
    }
    const parts = String(params.bbox ?? '').split(',').map(Number)
    if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return { ok: false, status: 400, error: 'zip_point_or_bbox_required' }
    const [w, s, e, n] = parts
    if (!(w < e && s < n)) return { ok: false, status: 400, error: 'bad_bbox' }
    const level = CENSUS_LEVELS[String(params.level || 'zip')] || 'zip5'
    const key = `bbox:${level}:${[w, s, e, n].map((v) => v.toFixed(2)).join(',')}`
    const hit = cached(key, now)
    if (hit) return hit
    const { data, error } = await db.from('exchange_market_fundamentals_cells').select(CELL_COLS).eq('geo_level', level)
      .gte('centroid_lat', s).lte('centroid_lat', n).gte('centroid_lng', w).lte('centroid_lng', e).limit(MAX_CELLS)
    if (error) return { ok: false, status: 502, error: 'census_unavailable' }
    const cells = (data || []).map(shapeCensusCell)
    return remember(key, { ok: true, covered: cells.length > 0, level: level === 'zip5' ? 'zip' : level, cells, truncated: cells.length >= MAX_CELLS }, now)
  } catch {
    return { ok: false, status: 502, error: 'census_unavailable' }
  }
}
