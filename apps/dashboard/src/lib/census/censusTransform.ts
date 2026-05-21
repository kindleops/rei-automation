import { SCORE_VERSION, type CensusRawRow } from './censusVariables'

// ── Math helpers ──────────────────────────────────────────────────────────────

export const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export const safeDivide = (numerator: number | null, denominator: number | null): number | null => {
  if (numerator === null || denominator === null || denominator === 0) return null
  return numerator / denominator
}

export const clamp = (value: number, min = 0, max = 100): number =>
  Math.max(min, Math.min(max, value))

export const normalizeScore = (
  value: number | null,
  minVal: number,
  maxVal: number,
  invert = false,
): number => {
  if (value === null || maxVal === minVal) return 0
  const norm = ((value - minVal) / (maxVal - minVal)) * 100
  return clamp(invert ? 100 - norm : norm)
}

// ── Score computations ────────────────────────────────────────────────────────

const currentYear = new Date().getFullYear()

const computeVacancyRate = (row: CensusRawRow): number | null =>
  safeDivide(row.vacant_housing_units, row.total_housing_units)
    ? (row.vacant_housing_units! / row.total_housing_units!) * 100
    : null

const computeRenterRate = (row: CensusRawRow): number | null =>
  row.renter_occupied_units !== null && row.occupied_housing_units !== null && row.occupied_housing_units > 0
    ? (row.renter_occupied_units / row.occupied_housing_units) * 100
    : null

const computeOwnerOccupancyRate = (row: CensusRawRow): number | null =>
  row.owner_occupied_units !== null && row.occupied_housing_units !== null && row.occupied_housing_units > 0
    ? (row.owner_occupied_units / row.occupied_housing_units) * 100
    : null

const computeHousingAge = (row: CensusRawRow): number | null =>
  row.median_year_built !== null && row.median_year_built > 1800
    ? currentYear - row.median_year_built
    : null

// Income normalization: $0 = score 100 (high pressure), $200k+ = score 0
const INCOME_LOW = 20_000
const INCOME_HIGH = 200_000

const computeIncomeHeatScore = (income: number | null): number => {
  if (income === null) return 0
  return clamp(normalizeScore(income, INCOME_LOW, INCOME_HIGH, true))
}

const computeVacancyHeatScore = (vacancyRate: number | null): number => {
  if (vacancyRate === null) return 0
  return clamp(vacancyRate * 5)
}

const computeRenterDensityScore = (renterRate: number | null): number => {
  if (renterRate === null) return 0
  return clamp(renterRate)
}

const computeHousingAgeScore = (housingAge: number | null): number => {
  if (housingAge === null) return 0
  return clamp(housingAge * 1.5)
}

const computeAcquisitionPressureScore = (
  vacancyHeat: number,
  renterDensity: number,
  housingAge: number,
  incomeHeat: number,
): number =>
  clamp((vacancyHeat + renterDensity + housingAge + incomeHeat) / 4)

// ── Main transform ────────────────────────────────────────────────────────────

export interface CensusGeoMetricsRow {
  geo_level: 'zcta' | 'county'
  geoid: string
  source_year: number
  name: string
  total_population: number | null
  total_households: number | null
  total_housing_units: number | null
  occupied_housing_units: number | null
  vacant_housing_units: number | null
  owner_occupied_units: number | null
  renter_occupied_units: number | null
  median_year_built: number | null
  median_household_income: number | null
  vacancy_rate: number | null
  renter_rate: number | null
  owner_occupancy_rate: number | null
  housing_age: number | null
  income_heat_score: number
  vacancy_heat_score: number
  renter_density_score: number
  housing_age_score: number
  acquisition_pressure_score: number
  score_version: string
  raw_census_data: Record<string, unknown>
}

export const transformCensusRow = (row: CensusRawRow): CensusGeoMetricsRow => {
  const vacancyRate = computeVacancyRate(row)
  const renterRate = computeRenterRate(row)
  const ownerOccupancyRate = computeOwnerOccupancyRate(row)
  const housingAge = computeHousingAge(row)

  const incomeHeatScore = computeIncomeHeatScore(row.median_household_income)
  const vacancyHeatScore = computeVacancyHeatScore(vacancyRate)
  const renterDensityScore = computeRenterDensityScore(renterRate)
  const housingAgeScore = computeHousingAgeScore(housingAge)
  const acquisitionPressureScore = computeAcquisitionPressureScore(
    vacancyHeatScore,
    renterDensityScore,
    housingAgeScore,
    incomeHeatScore,
  )

  return {
    geo_level: row.geo_level,
    geoid: row.geoid,
    source_year: row.source_year,
    name: row.name,
    total_population: row.total_population,
    total_households: row.total_households,
    total_housing_units: row.total_housing_units,
    occupied_housing_units: row.occupied_housing_units,
    vacant_housing_units: row.vacant_housing_units,
    owner_occupied_units: row.owner_occupied_units,
    renter_occupied_units: row.renter_occupied_units,
    median_year_built: row.median_year_built,
    median_household_income: row.median_household_income,
    vacancy_rate: vacancyRate,
    renter_rate: renterRate,
    owner_occupancy_rate: ownerOccupancyRate,
    housing_age: housingAge,
    income_heat_score: incomeHeatScore,
    vacancy_heat_score: vacancyHeatScore,
    renter_density_score: renterDensityScore,
    housing_age_score: housingAgeScore,
    acquisition_pressure_score: acquisitionPressureScore,
    score_version: SCORE_VERSION,
    raw_census_data: row.raw_census_data,
  }
}
