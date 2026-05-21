import { getSupabaseClient } from '../supabaseClient'

export type CensusMetric =
  | 'income_heat'
  | 'vacancy_heat'
  | 'renter_density'
  | 'housing_age'
  | 'acquisition_pressure'

export interface CensusLayerPoint {
  id: string
  layer: 'census'
  label: string
  lat: number
  lng: number
  value: number
  score: number
  metric: CensusMetric
  geo_level: string
  geo_key: string
  metadata: {
    income_heat_score: number
    vacancy_heat_score: number
    renter_density_score: number
    housing_age_score: number
    acquisition_pressure_score: number
    median_household_income: number | null
    vacancy_rate: number | null
    renter_rate: number | null
    housing_age: number | null
  }
}

const METRIC_SCORE_FIELD: Record<CensusMetric, string> = {
  income_heat: 'income_heat_score',
  vacancy_heat: 'vacancy_heat_score',
  renter_density: 'renter_density_score',
  housing_age: 'housing_age_score',
  acquisition_pressure: 'acquisition_pressure_score',
}

const METRIC_VALUE_FIELD: Record<CensusMetric, string> = {
  income_heat: 'median_household_income',
  vacancy_heat: 'vacancy_rate',
  renter_density: 'renter_rate',
  housing_age: 'housing_age',
  acquisition_pressure: 'acquisition_pressure_score',
}

export const loadCensusLayerPoints = async (
  metric: CensusMetric,
  limit = 750,
): Promise<CensusLayerPoint[]> => {
  const supabase = getSupabaseClient()
  const scoreField = METRIC_SCORE_FIELD[metric]
  const valueField = METRIC_VALUE_FIELD[metric]

  const { data, error } = await supabase
    .from('census_geo_metrics')
    .select([
      'geo_level', 'geoid', 'name',
      'centroid_lat', 'centroid_lng',
      'income_heat_score', 'vacancy_heat_score', 'renter_density_score',
      'housing_age_score', 'acquisition_pressure_score',
      'median_household_income', 'vacancy_rate', 'renter_rate', 'housing_age',
    ].join(','))
    .gt(scoreField, 0)
    .order(scoreField, { ascending: false })
    .limit(limit)

  if (error || !data) return []

  return (data as unknown as Record<string, unknown>[])
    .filter((row) => {
      const lat = Number(row['centroid_lat'])
      const lng = Number(row['centroid_lng'])
      return Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0
    })
    .map((row): CensusLayerPoint => {
      const score = Number(row[scoreField] ?? 0)
      const value = Number(row[valueField] ?? 0)
      const geoid = String(row['geoid'] ?? '')
      return {
        id: `census-${geoid}-${metric}`,
        layer: 'census',
        label: String(row['name'] ?? geoid),
        lat: Number(row['centroid_lat']),
        lng: Number(row['centroid_lng']),
        value,
        score,
        metric,
        geo_level: String(row['geo_level'] ?? ''),
        geo_key: geoid,
        metadata: {
          income_heat_score: Number(row['income_heat_score'] ?? 0),
          vacancy_heat_score: Number(row['vacancy_heat_score'] ?? 0),
          renter_density_score: Number(row['renter_density_score'] ?? 0),
          housing_age_score: Number(row['housing_age_score'] ?? 0),
          acquisition_pressure_score: Number(row['acquisition_pressure_score'] ?? 0),
          median_household_income: row['median_household_income'] != null ? Number(row['median_household_income']) : null,
          vacancy_rate: row['vacancy_rate'] != null ? Number(row['vacancy_rate']) : null,
          renter_rate: row['renter_rate'] != null ? Number(row['renter_rate']) : null,
          housing_age: row['housing_age'] != null ? Number(row['housing_age']) : null,
        },
      }
    })
}
