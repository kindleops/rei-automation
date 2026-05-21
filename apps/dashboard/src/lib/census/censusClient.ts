import {
  CENSUS_BASE_URL,
  ACS_VARIABLE_CODES,
  ACS_VARIABLES,
  type CensusRawRow,
} from './censusVariables'

const VARIABLE_LIST = ACS_VARIABLE_CODES.join(',')

const parseCensusResponse = (
  data: unknown[][],
  geoLevel: 'zcta' | 'county',
  sourceYear: number,
): CensusRawRow[] => {
  if (!Array.isArray(data) || data.length < 2) return []
  const [headerRow, ...valueRows] = data
  const headers = headerRow as string[]

  return valueRows.map((row) => {
    const raw: Record<string, unknown> = {}
    headers.forEach((h, i) => { raw[h] = row[i] })

    const toNum = (key: string): number | null => {
      const v = Number(raw[key])
      return Number.isFinite(v) && v >= 0 ? v : null
    }

    const name = String(raw['NAME'] ?? '')
    let geoid = ''
    if (geoLevel === 'zcta') {
      geoid = String(raw['zip code tabulation area'] ?? raw['ZCTA5'] ?? raw['zcta5'] ?? '')
    } else {
      const state = String(raw['state'] ?? '')
      const county = String(raw['county'] ?? '')
      geoid = state.padStart(2, '0') + county.padStart(3, '0')
    }

    return {
      geoid,
      name,
      geo_level: geoLevel,
      source_year: sourceYear,
      median_household_income: toNum(Object.keys(ACS_VARIABLES).find((k) => ACS_VARIABLES[k as keyof typeof ACS_VARIABLES] === 'median_household_income') ?? ''),
      total_population: toNum(Object.keys(ACS_VARIABLES).find((k) => ACS_VARIABLES[k as keyof typeof ACS_VARIABLES] === 'total_population') ?? ''),
      total_households: toNum(Object.keys(ACS_VARIABLES).find((k) => ACS_VARIABLES[k as keyof typeof ACS_VARIABLES] === 'total_households') ?? ''),
      total_housing_units: toNum(Object.keys(ACS_VARIABLES).find((k) => ACS_VARIABLES[k as keyof typeof ACS_VARIABLES] === 'total_housing_units') ?? ''),
      occupied_housing_units: toNum(Object.keys(ACS_VARIABLES).find((k) => ACS_VARIABLES[k as keyof typeof ACS_VARIABLES] === 'occupied_housing_units') ?? ''),
      vacant_housing_units: toNum(Object.keys(ACS_VARIABLES).find((k) => ACS_VARIABLES[k as keyof typeof ACS_VARIABLES] === 'vacant_housing_units') ?? ''),
      owner_occupied_units: toNum(Object.keys(ACS_VARIABLES).find((k) => ACS_VARIABLES[k as keyof typeof ACS_VARIABLES] === 'owner_occupied_units') ?? ''),
      renter_occupied_units: toNum(Object.keys(ACS_VARIABLES).find((k) => ACS_VARIABLES[k as keyof typeof ACS_VARIABLES] === 'renter_occupied_units') ?? ''),
      median_year_built: toNum(Object.keys(ACS_VARIABLES).find((k) => ACS_VARIABLES[k as keyof typeof ACS_VARIABLES] === 'median_year_built') ?? ''),
      raw_census_data: raw,
    }
  })
}

export const fetchCensusZcta = async (
  zcta: string,
  sourceYear: number,
  apiKey: string,
): Promise<CensusRawRow | null> => {
  const url = `${CENSUS_BASE_URL}?get=NAME,${VARIABLE_LIST}&for=zip+code+tabulation+area:${encodeURIComponent(zcta)}&key=${apiKey}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Census API error ${response.status} for ZCTA ${zcta}: ${await response.text()}`)
  }
  const data = (await response.json()) as unknown[][]
  const rows = parseCensusResponse(data, 'zcta', sourceYear)
  return rows[0] ?? null
}

export const fetchCensusCounty = async (
  stateFips: string,
  countyFips: string,
  sourceYear: number,
  apiKey: string,
): Promise<CensusRawRow | null> => {
  const url = `${CENSUS_BASE_URL}?get=NAME,${VARIABLE_LIST}&for=county:${encodeURIComponent(countyFips)}&in=state:${encodeURIComponent(stateFips)}&key=${apiKey}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Census API error ${response.status} for county ${stateFips}/${countyFips}: ${await response.text()}`)
  }
  const data = (await response.json()) as unknown[][]
  const rows = parseCensusResponse(data, 'county', sourceYear)
  return rows[0] ?? null
}
