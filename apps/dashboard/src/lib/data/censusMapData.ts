/**
 * Census point layer — one point per ACS ZIP (ZCTA) cell, carrying the real
 * published value for the chosen metric.
 *
 * Reads the census read model (GET /api/cockpit/map/census, backed by
 * exchange_market_fundamentals_cells — US Census ACS 5-year). It used to
 * read public.census_geo_metrics "heat scores" (income_heat_score,
 * acquisition_pressure_score …) that were never computed: that table has
 * never held a row. There are no scores here — `value` is the ACS value as
 * published (shares 0..1, dollars, years), and `acquisition_pressure` is gone
 * because nothing real ever fed it.
 */
import { fetchCensusCells, type CensusCell } from './censusData'

export type CensusMetric = 'income_heat' | 'vacancy_heat' | 'renter_density' | 'housing_age'

export interface CensusLayerPoint {
  id: string
  layer: 'census'
  label: string
  lat: number
  lng: number
  /** The ACS value for `metric`, as published. */
  value: number
  metric: CensusMetric
  geo_level: string
  geo_key: string
  source: string
  metadata: {
    median_household_income: number | null
    vacancy_rate: number | null
    renter_rate: number | null
    housing_age: number | null
  }
}

const VALUE: Record<CensusMetric, (c: CensusCell) => number | null> = {
  income_heat: (c) => c.median_household_income,
  vacancy_heat: (c) => c.vacancy_rate,
  renter_density: (c) => c.renter_share,
  housing_age: (c) => c.median_year_built,
}

const US = '-125,24,-66,49.5'

export const loadCensusLayerPoints = async (metric: CensusMetric, limit = 750, bbox: string = US): Promise<CensusLayerPoint[]> => {
  const cells = await fetchCensusCells({ bbox, level: 'zip' })
  const out: CensusLayerPoint[] = []
  for (const c of cells) {
    const v = VALUE[metric](c)
    if (v === null || !Number.isFinite(v) || c.lat === null || c.lng === null) continue
    out.push({
      id: `census-${c.census_geoid}-${metric}`,
      layer: 'census',
      label: c.name,
      lat: c.lat,
      lng: c.lng,
      value: v,
      metric,
      geo_level: c.level,
      geo_key: c.census_geoid,
      source: `${c.source.attribution} ${c.source.vintage ?? ''}`.trim(),
      metadata: {
        median_household_income: c.median_household_income,
        vacancy_rate: c.vacancy_rate,
        renter_rate: c.renter_share,
        housing_age: c.median_year_built,
      },
    })
    if (out.length >= limit) break
  }
  return out
}
