/**
 * Census sync handler — called by the Vite census API plugin.
 * Fetches ACS 5-year data for ZCTAs or counties and upserts into census_geo_metrics.
 * NOT included in tsc compilation — runs only in Vite dev server context.
 */

export interface CensusSyncPayload {
  geo_level: 'zcta' | 'county'
  zctas?: string[]
  state_fips?: string
  county_fips?: string
  source_year?: number
}

export interface CensusSyncResult {
  run_id: string
  requested_count: number
  inserted_or_updated_count: number
  error_count: number
  examples: Array<{ geoid: string; acquisition_pressure_score: number }>
  errors: string[]
  status: 'completed' | 'partial' | 'failed'
}

export const validateCensusSyncPayload = (body: unknown): CensusSyncPayload | null => {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (b['geo_level'] !== 'zcta' && b['geo_level'] !== 'county') return null
  if (b['geo_level'] === 'zcta') {
    if (!Array.isArray(b['zctas']) || b['zctas'].length === 0) return null
  }
  if (b['geo_level'] === 'county') {
    if (typeof b['state_fips'] !== 'string' || typeof b['county_fips'] !== 'string') return null
  }
  return b as CensusSyncPayload
}
