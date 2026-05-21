export const CENSUS_SOURCE_YEAR = 2024
export const CENSUS_DATASET = 'acs/acs5'
export const CENSUS_BASE_URL = `https://api.census.gov/data/${CENSUS_SOURCE_YEAR}/${CENSUS_DATASET}`
export const SCORE_VERSION = '2026_v1'

export const ACS_VARIABLES = {
  B19013_001E: 'median_household_income',
  B01003_001E: 'total_population',
  B11001_001E: 'total_households',
  B25002_001E: 'total_housing_units',
  B25002_002E: 'occupied_housing_units',
  B25002_003E: 'vacant_housing_units',
  B25003_002E: 'owner_occupied_units',
  B25003_003E: 'renter_occupied_units',
  B25035_001E: 'median_year_built',
} as const

export type AcsVariableCode = keyof typeof ACS_VARIABLES
export type AcsFieldName = (typeof ACS_VARIABLES)[AcsVariableCode]

export const ACS_VARIABLE_CODES = Object.keys(ACS_VARIABLES) as AcsVariableCode[]

export interface CensusRawRow {
  geoid: string
  name: string
  geo_level: 'zcta' | 'county'
  source_year: number
  median_household_income: number | null
  total_population: number | null
  total_households: number | null
  total_housing_units: number | null
  occupied_housing_units: number | null
  vacant_housing_units: number | null
  owner_occupied_units: number | null
  renter_occupied_units: number | null
  median_year_built: number | null
  raw_census_data: Record<string, unknown>
}
