import type { Feature, FeatureCollection, GeoJsonProperties, Polygon } from 'geojson'
import { calculateInvestorOpportunityScore, type CensusData, type CensusMetricExtended } from '../data/censusData'
import { getSupabaseClient } from '../supabaseClient'

export type CensusOverlayMetric = CensusMetricExtended | 'population_density'
export type CensusOverlayGeographyType = 'state' | 'county' | 'zip' | 'tract'

export type CensusOverlayFeature = {
  id: string
  geography_type: CensusOverlayGeographyType
  geography_id: string
  name: string
  state?: string
  county?: string
  zip?: string
  tract?: string
  geometry?: Polygon
  centroid: [number, number]
  bounds: { west: number; south: number; east: number; north: number }
  metric_values: {
    population?: number
    population_density?: number
    households?: number
    housing_units?: number
    vacant_units?: number
    vacancy_rate?: number
    owner_occupied_percent?: number
    renter_occupied_percent?: number
    median_household_income?: number
    median_home_value?: number
    median_gross_rent?: number
    median_age?: number
    housing_median_year_built?: number
    poverty_rate?: number
    investor_opportunity_score?: number
    acquisition_pressure_score?: number
  }
  summary: string
  source: 'demo' | 'live'
}

export type CensusOverlayQueryBounds = {
  west: number
  south: number
  east: number
  north: number
}

export type CensusOverlayLegend = {
  metric: CensusOverlayMetric
  title: string
  stops: Array<{ value: number; color: string; label: string }>
  rangeLabel: string
  lowLabel: string
  highLabel: string
}

type CensusGeoMetricsRow = {
  geo_level?: string | null
  geoid?: string | null
  name?: string | null
  centroid_lat?: number | null
  centroid_lng?: number | null
  total_population?: number | null
  total_households?: number | null
  total_housing_units?: number | null
  vacant_housing_units?: number | null
  owner_occupied_units?: number | null
  renter_occupied_units?: number | null
  median_year_built?: number | null
  median_household_income?: number | null
  vacancy_rate?: number | null
  renter_rate?: number | null
  owner_occupancy_rate?: number | null
  housing_age?: number | null
  acquisition_pressure_score?: number | null
}

const USA_BOUNDS: CensusOverlayQueryBounds = { west: -125, south: 24, east: -66, north: 49.5 }
const overlayCache = new Map<string, CensusOverlayFeature[]>()
const DETAIL_SELECT = [
  'geo_level', 'geoid', 'name',
  'centroid_lat', 'centroid_lng',
  'total_population', 'total_households', 'total_housing_units',
  'vacant_housing_units', 'owner_occupied_units', 'renter_occupied_units',
  'median_year_built', 'median_household_income',
  'vacancy_rate', 'renter_rate', 'owner_occupancy_rate', 'housing_age',
  'acquisition_pressure_score',
].join(',')

const STATE_FIPS: Record<string, { abbr: string; name: string }> = {
  '01': { abbr: 'AL', name: 'Alabama' },
  '02': { abbr: 'AK', name: 'Alaska' },
  '04': { abbr: 'AZ', name: 'Arizona' },
  '05': { abbr: 'AR', name: 'Arkansas' },
  '06': { abbr: 'CA', name: 'California' },
  '08': { abbr: 'CO', name: 'Colorado' },
  '09': { abbr: 'CT', name: 'Connecticut' },
  '10': { abbr: 'DE', name: 'Delaware' },
  '11': { abbr: 'DC', name: 'District of Columbia' },
  '12': { abbr: 'FL', name: 'Florida' },
  '13': { abbr: 'GA', name: 'Georgia' },
  '15': { abbr: 'HI', name: 'Hawaii' },
  '16': { abbr: 'ID', name: 'Idaho' },
  '17': { abbr: 'IL', name: 'Illinois' },
  '18': { abbr: 'IN', name: 'Indiana' },
  '19': { abbr: 'IA', name: 'Iowa' },
  '20': { abbr: 'KS', name: 'Kansas' },
  '21': { abbr: 'KY', name: 'Kentucky' },
  '22': { abbr: 'LA', name: 'Louisiana' },
  '23': { abbr: 'ME', name: 'Maine' },
  '24': { abbr: 'MD', name: 'Maryland' },
  '25': { abbr: 'MA', name: 'Massachusetts' },
  '26': { abbr: 'MI', name: 'Michigan' },
  '27': { abbr: 'MN', name: 'Minnesota' },
  '28': { abbr: 'MS', name: 'Mississippi' },
  '29': { abbr: 'MO', name: 'Missouri' },
  '30': { abbr: 'MT', name: 'Montana' },
  '31': { abbr: 'NE', name: 'Nebraska' },
  '32': { abbr: 'NV', name: 'Nevada' },
  '33': { abbr: 'NH', name: 'New Hampshire' },
  '34': { abbr: 'NJ', name: 'New Jersey' },
  '35': { abbr: 'NM', name: 'New Mexico' },
  '36': { abbr: 'NY', name: 'New York' },
  '37': { abbr: 'NC', name: 'North Carolina' },
  '38': { abbr: 'ND', name: 'North Dakota' },
  '39': { abbr: 'OH', name: 'Ohio' },
  '40': { abbr: 'OK', name: 'Oklahoma' },
  '41': { abbr: 'OR', name: 'Oregon' },
  '42': { abbr: 'PA', name: 'Pennsylvania' },
  '44': { abbr: 'RI', name: 'Rhode Island' },
  '45': { abbr: 'SC', name: 'South Carolina' },
  '46': { abbr: 'SD', name: 'South Dakota' },
  '47': { abbr: 'TN', name: 'Tennessee' },
  '48': { abbr: 'TX', name: 'Texas' },
  '49': { abbr: 'UT', name: 'Utah' },
  '50': { abbr: 'VT', name: 'Vermont' },
  '51': { abbr: 'VA', name: 'Virginia' },
  '53': { abbr: 'WA', name: 'Washington' },
  '54': { abbr: 'WV', name: 'West Virginia' },
  '55': { abbr: 'WI', name: 'Wisconsin' },
  '56': { abbr: 'WY', name: 'Wyoming' },
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const round = (value: number, digits = 0) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const metricTitle = (metric: CensusOverlayMetric): string => {
  switch (metric) {
    case 'census_heatmap': return 'Census Heatmap'
    case 'vacancy_heat': return 'Vacancy Rate'
    case 'income_heat': return 'Median Household Income'
    case 'renter_density': return 'Renter Density'
    case 'owner_occupancy': return 'Owner Occupancy'
    case 'median_home_value': return 'Median Home Value'
    case 'median_rent': return 'Median Rent'
    case 'population_density': return 'Population Density'
    case 'housing_age': return 'Housing Age'
    case 'acquisition_pressure': return 'Acquisition Pressure'
    case 'investor_opportunity': return 'Investor Opportunity Score'
    default: return 'Census Metric'
  }
}

const geometryTypeForZoom = (zoom: number): CensusOverlayGeographyType => {
  if (zoom <= 4.6) return 'state'
  if (zoom <= 7.4) return 'county'
  if (zoom <= 10.6) return 'zip'
  return 'tract'
}

const polygonSizeForType = (type: CensusOverlayGeographyType) => {
  switch (type) {
    case 'state': return { lng: 2.6, lat: 1.8 }
    case 'county': return { lng: 0.68, lat: 0.46 }
    case 'zip': return { lng: 0.14, lat: 0.1 }
    case 'tract': return { lng: 0.06, lat: 0.04 }
  }
}

const normalizeBounds = (bounds: CensusOverlayQueryBounds): CensusOverlayQueryBounds => ({
  west: clamp(Math.min(bounds.west, bounds.east), USA_BOUNDS.west, USA_BOUNDS.east),
  east: clamp(Math.max(bounds.west, bounds.east), USA_BOUNDS.west, USA_BOUNDS.east),
  south: clamp(Math.min(bounds.south, bounds.north), USA_BOUNDS.south, USA_BOUNDS.north),
  north: clamp(Math.max(bounds.south, bounds.north), USA_BOUNDS.south, USA_BOUNDS.north),
})

const polygonForBounds = (west: number, south: number, east: number, north: number): Polygon => ({
  type: 'Polygon',
  coordinates: [[
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ]],
})

const polygonForCentroid = (lng: number, lat: number, type: CensusOverlayGeographyType): Polygon => {
  const size = polygonSizeForType(type)
  return polygonForBounds(lng - size.lng, lat - size.lat, lng + size.lng, lat + size.lat)
}

const getStateInfo = (geoid?: string | null) => {
  const key = String(geoid ?? '').slice(0, 2)
  return STATE_FIPS[key] ?? null
}

const metricValue = (metric: CensusOverlayMetric, values: CensusOverlayFeature['metric_values']) => {
  switch (metric) {
    case 'vacancy_heat': return values.vacancy_rate ?? 0
    case 'income_heat': return values.median_household_income ?? 0
    case 'renter_density': return values.renter_occupied_percent ?? 0
    case 'owner_occupancy': return values.owner_occupied_percent ?? 0
    case 'median_home_value': return values.median_home_value ?? 0
    case 'median_rent': return values.median_gross_rent ?? 0
    case 'population_density': return values.population_density ?? 0
    case 'housing_age': return values.housing_median_year_built ? 2026 - values.housing_median_year_built : 0
    case 'acquisition_pressure': return values.acquisition_pressure_score ?? 0
    case 'investor_opportunity': return values.investor_opportunity_score ?? 0
    case 'census_heatmap': return values.investor_opportunity_score ?? values.acquisition_pressure_score ?? 0
    default: return 0
  }
}

const toDisplayValue = (metric: CensusOverlayMetric, value: number): string => {
  if (!Number.isFinite(value)) return '—'
  switch (metric) {
    case 'income_heat':
    case 'median_home_value':
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(value)
    case 'median_rent':
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
    case 'vacancy_heat':
    case 'renter_density':
    case 'owner_occupancy':
      return `${round(value, 1)}%`
    case 'population_density':
      return `${Math.round(value).toLocaleString()}/mi²`
    case 'housing_age':
      return `${Math.round(value)} yrs`
    default:
      return `${round(value, 1)}`
  }
}

const interpolateColor = (stops: string[], t: number) => {
  const index = clamp(Math.floor(t * (stops.length - 1)), 0, stops.length - 2)
  const local = t * (stops.length - 1) - index
  const parse = (hex: string) => hex.replace('#', '').match(/.{1,2}/g)?.map((x) => parseInt(x, 16)) ?? [0, 0, 0]
  const [r1, g1, b1] = parse(stops[index])
  const [r2, g2, b2] = parse(stops[index + 1])
  const mix = (a: number, b: number) => Math.round(a + (b - a) * local)
  return `rgba(${mix(r1, r2)}, ${mix(g1, g2)}, ${mix(b1, b2)}, 0.24)`
}

const colorStopsForMetric = (metric: CensusOverlayMetric) => {
  switch (metric) {
    case 'vacancy_heat': return ['#1d4ed8', '#0ea5e9', '#f59e0b', '#ef4444']
    case 'income_heat': return ['#3b82f6', '#22d3ee', '#14b8a6', '#22c55e']
    case 'renter_density': return ['#1f2937', '#3b82f6', '#8b5cf6', '#ec4899']
    case 'owner_occupancy': return ['#3b82f6', '#14b8a6', '#22c55e', '#84cc16']
    case 'median_home_value': return ['#164e63', '#0ea5e9', '#8b5cf6', '#f59e0b']
    case 'median_rent': return ['#1d4ed8', '#2563eb', '#7c3aed', '#c026d3']
    case 'population_density': return ['#0f172a', '#155e75', '#0891b2', '#38bdf8']
    case 'housing_age': return ['#334155', '#64748b', '#f59e0b', '#ef4444']
    case 'acquisition_pressure': return ['#1d4ed8', '#7c3aed', '#ec4899', '#f97316']
    case 'investor_opportunity': return ['#0f766e', '#14b8a6', '#84cc16', '#eab308']
    case 'census_heatmap': return ['#1d4ed8', '#7c3aed', '#ec4899', '#f97316']
    default: return ['#334155', '#475569', '#64748b', '#94a3b8']
  }
}

const normalizeForMetric = (metric: CensusOverlayMetric, value: number) => {
  switch (metric) {
    case 'income_heat': return clamp((value - 25000) / 125000, 0, 1)
    case 'median_home_value': return clamp((value - 80000) / 720000, 0, 1)
    case 'median_rent': return clamp((value - 500) / 3000, 0, 1)
    case 'population_density': return clamp(value / 14000, 0, 1)
    case 'vacancy_heat':
    case 'renter_density':
    case 'owner_occupancy':
    case 'acquisition_pressure':
    case 'investor_opportunity':
    case 'census_heatmap':
      return clamp(value / 100, 0, 1)
    case 'housing_age':
      return clamp(value / 90, 0, 1)
    default:
      return clamp(value / 100, 0, 1)
  }
}

export const getCensusOverlayColor = (metric: CensusOverlayMetric, value: number): string => (
  interpolateColor(colorStopsForMetric(metric), normalizeForMetric(metric, value))
)

export const getCensusOverlayLegend = (metric: CensusOverlayMetric, range?: { min: number; max: number }): CensusOverlayLegend => {
  const stops = colorStopsForMetric(metric)
  const min = range?.min ?? 0
  const max = range?.max ?? 100
  const mid = min + ((max - min) / 2)
  return {
    metric,
    title: metricTitle(metric),
    stops: [
      { value: min, color: stops[0], label: toDisplayValue(metric, min) },
      { value: mid, color: stops[2] ?? stops[1], label: toDisplayValue(metric, mid) },
      { value: max, color: stops[stops.length - 1], label: toDisplayValue(metric, max) },
    ],
    rangeLabel: `${toDisplayValue(metric, min)} – ${toDisplayValue(metric, max)}`,
    lowLabel: 'Low',
    highLabel: 'High',
  }
}

const rowToCensusData = (row: CensusGeoMetricsRow): CensusData => ({
  population: Number(row.total_population ?? 0) || undefined,
  households: Number(row.total_households ?? 0) || undefined,
  housing_units: Number(row.total_housing_units ?? 0) || undefined,
  vacant_units: Number(row.vacant_housing_units ?? 0) || undefined,
  vacancy_rate: Number(row.vacancy_rate ?? 0) || undefined,
  owner_occupied_units: Number(row.owner_occupied_units ?? 0) || undefined,
  owner_occupied_percent: Number(row.owner_occupancy_rate ?? 0) || undefined,
  renter_occupied_units: Number(row.renter_occupied_units ?? 0) || undefined,
  renter_occupied_percent: Number(row.renter_rate ?? 0) || undefined,
  median_household_income: Number(row.median_household_income ?? 0) || undefined,
  housing_median_year_built: Number(row.median_year_built ?? 0) || undefined,
})

const summarizeFeature = (feature: CensusOverlayFeature, metric: CensusOverlayMetric) => {
  const value = metricValue(metric, feature.metric_values)
  return `${feature.name} shows ${metricTitle(metric).toLowerCase()} at ${toDisplayValue(metric, value)} with investor opportunity ${feature.metric_values.investor_opportunity_score ?? '—'}/100.`
}

const toFeatureFromRow = (row: CensusGeoMetricsRow, geographyType: CensusOverlayGeographyType): CensusOverlayFeature | null => {
  const lat = Number(row.centroid_lat ?? NaN)
  const lng = Number(row.centroid_lng ?? NaN)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const info = getStateInfo(row.geoid)
  const census = rowToCensusData(row)
  const opportunity = calculateInvestorOpportunityScore(census)
  const polygon = polygonForCentroid(lng, lat, geographyType)
  const size = polygonSizeForType(geographyType)
  const feature: CensusOverlayFeature = {
    id: `${geographyType}:${String(row.geoid ?? row.name ?? `${lng}:${lat}`)}`,
    geography_type: geographyType,
    geography_id: String(row.geoid ?? row.name ?? `${lng}:${lat}`),
    name: String(row.name ?? row.geoid ?? 'Unknown Geography'),
    state: info?.abbr,
    county: geographyType === 'county' ? String(row.name ?? '') : undefined,
    zip: geographyType === 'zip' || geographyType === 'tract' ? String(row.geoid ?? '') : undefined,
    tract: geographyType === 'tract' ? String(row.geoid ?? '') : undefined,
    geometry: polygon,
    centroid: [lng, lat],
    bounds: { west: lng - size.lng, south: lat - size.lat, east: lng + size.lng, north: lat + size.lat },
    metric_values: {
      population: census.population,
      households: census.households,
      housing_units: census.housing_units,
      vacant_units: census.vacant_units,
      vacancy_rate: census.vacancy_rate,
      owner_occupied_percent: census.owner_occupied_percent,
      renter_occupied_percent: census.renter_occupied_percent,
      median_household_income: census.median_household_income,
      median_age: census.median_age,
      housing_median_year_built: census.housing_median_year_built,
      acquisition_pressure_score: Number(row.acquisition_pressure_score ?? 0) || undefined,
      investor_opportunity_score: opportunity.score,
    },
    summary: opportunity.summary,
    source: 'live',
  }
  feature.summary = summarizeFeature(feature, 'investor_opportunity')
  return feature
}

const weighted = (pairs: Array<[number | undefined, number | undefined]>) => {
  let numerator = 0
  let denominator = 0
  for (const [value, weight] of pairs) {
    if (!Number.isFinite(value ?? NaN) || !Number.isFinite(weight ?? NaN) || (weight ?? 0) <= 0) continue
    numerator += (value as number) * (weight as number)
    denominator += weight as number
  }
  return denominator > 0 ? numerator / denominator : undefined
}

const aggregateStates = (rows: CensusGeoMetricsRow[]): CensusOverlayFeature[] => {
  const grouped = new Map<string, CensusGeoMetricsRow[]>()
  rows.forEach((row) => {
    const state = getStateInfo(row.geoid)
    const key = state?.abbr ?? 'NA'
    const current = grouped.get(key) ?? []
    current.push(row)
    grouped.set(key, current)
  })

  return Array.from(grouped.entries()).flatMap(([stateAbbr, items]) => {
    const coords = items
      .map((item) => [Number(item.centroid_lng ?? NaN), Number(item.centroid_lat ?? NaN)] as const)
      .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))
    if (!coords.length) return []
    const west = Math.min(...coords.map(([lng]) => lng)) - 0.7
    const east = Math.max(...coords.map(([lng]) => lng)) + 0.7
    const south = Math.min(...coords.map(([, lat]) => lat)) - 0.45
    const north = Math.max(...coords.map(([, lat]) => lat)) + 0.45
    const population = items.reduce((sum, item) => sum + Number(item.total_population ?? 0), 0)
    const households = items.reduce((sum, item) => sum + Number(item.total_households ?? 0), 0)
    const housingUnits = items.reduce((sum, item) => sum + Number(item.total_housing_units ?? 0), 0)
    const vacantUnits = items.reduce((sum, item) => sum + Number(item.vacant_housing_units ?? 0), 0)
    const ownerUnits = items.reduce((sum, item) => sum + Number(item.owner_occupied_units ?? 0), 0)
    const renterUnits = items.reduce((sum, item) => sum + Number(item.renter_occupied_units ?? 0), 0)
    const census: CensusData = {
      state: stateAbbr,
      population,
      households,
      housing_units: housingUnits,
      vacant_units: vacantUnits,
      vacancy_rate: housingUnits > 0 ? (vacantUnits / housingUnits) * 100 : undefined,
      owner_occupied_units: ownerUnits,
      renter_occupied_units: renterUnits,
      owner_occupied_percent: (ownerUnits + renterUnits) > 0 ? (ownerUnits / (ownerUnits + renterUnits)) * 100 : undefined,
      renter_occupied_percent: (ownerUnits + renterUnits) > 0 ? (renterUnits / (ownerUnits + renterUnits)) * 100 : undefined,
      median_household_income: weighted(items.map((item) => [Number(item.median_household_income ?? NaN), Number(item.total_households ?? 0)])),
      housing_median_year_built: weighted(items.map((item) => [Number(item.median_year_built ?? NaN), Number(item.total_housing_units ?? 0)])),
    }
    const opportunity = calculateInvestorOpportunityScore(census)
    const stateName = Object.values(STATE_FIPS).find((item) => item.abbr === stateAbbr)?.name ?? stateAbbr
    const feature: CensusOverlayFeature = {
      id: `state:${stateAbbr}`,
      geography_type: 'state',
      geography_id: stateAbbr,
      name: stateName,
      state: stateAbbr,
      geometry: polygonForBounds(west, south, east, north),
      centroid: [round((west + east) / 2, 4), round((south + north) / 2, 4)],
      bounds: { west, south, east, north },
      metric_values: {
        population: census.population,
        households: census.households,
        housing_units: census.housing_units,
        vacant_units: census.vacant_units,
        vacancy_rate: census.vacancy_rate,
        owner_occupied_percent: census.owner_occupied_percent,
        renter_occupied_percent: census.renter_occupied_percent,
        median_household_income: census.median_household_income,
        housing_median_year_built: census.housing_median_year_built,
        acquisition_pressure_score: weighted(items.map((item) => [Number(item.acquisition_pressure_score ?? NaN), Number(item.total_households ?? 0)])),
        investor_opportunity_score: opportunity.score,
      },
      summary: opportunity.summary,
      source: 'live',
    }
    feature.summary = summarizeFeature(feature, 'investor_opportunity')
    return feature
  })
}

const queryRows = async (bounds: CensusOverlayQueryBounds, geoLevels: string[]) => {
  const supabase = getSupabaseClient()
  const query = supabase
    .from('census_geo_metrics')
    .select(DETAIL_SELECT)
    .in('geo_level', geoLevels)
    .gte('centroid_lat', bounds.south)
    .lte('centroid_lat', bounds.north)
    .gte('centroid_lng', bounds.west)
    .lte('centroid_lng', bounds.east)
    .limit(2400)

  const { data, error } = await query
  if (error || !data) return []
  return data as CensusGeoMetricsRow[]
}

export const loadStateCensusSummary = async (state: string, metric: CensusOverlayMetric): Promise<CensusOverlayFeature | null> => {
  const rows = await queryRows(USA_BOUNDS, ['county'])
  const states = aggregateStates(rows)
  const needle = state.trim().toLowerCase()
  const match = states.find((item) => item.state?.toLowerCase() === needle || item.name.toLowerCase() === needle) ?? null
  if (!match) return null
  return { ...match, summary: summarizeFeature(match, metric) }
}

export const loadCountyCensusOverlay = async (bounds: CensusOverlayQueryBounds, _metric: CensusOverlayMetric) => {
  const rows = await queryRows(bounds, ['county'])
  return rows.map((row) => toFeatureFromRow(row, 'county')).filter(Boolean) as CensusOverlayFeature[]
}

export const loadZipCensusOverlay = async (bounds: CensusOverlayQueryBounds, _metric: CensusOverlayMetric) => {
  const rows = await queryRows(bounds, ['zcta'])
  return rows.map((row) => toFeatureFromRow(row, 'zip')).filter(Boolean) as CensusOverlayFeature[]
}

export const loadTractCensusOverlay = async (bounds: CensusOverlayQueryBounds, _metric: CensusOverlayMetric) => {
  const tractRows = await queryRows(bounds, ['tract'])
  if (tractRows.length) {
    return tractRows.map((row) => toFeatureFromRow(row, 'tract')).filter(Boolean) as CensusOverlayFeature[]
  }
  const zipRows = await queryRows(bounds, ['zcta'])
  return zipRows.map((row) => toFeatureFromRow(row, 'tract')).filter(Boolean) as CensusOverlayFeature[]
}

export const loadNationwideCensusOverlay = async (
  metric: CensusOverlayMetric,
  bounds: CensusOverlayQueryBounds,
  zoom: number,
): Promise<{ features: CensusOverlayFeature[]; geographyType: CensusOverlayGeographyType; live: boolean; message?: string }> => {
  const geographyType = geometryTypeForZoom(zoom)
  const normalized = normalizeBounds(bounds)
  const key = [metric, geographyType, round(normalized.west, 2), round(normalized.south, 2), round(normalized.east, 2), round(normalized.north, 2)].join(':')
  if (overlayCache.has(key)) {
    return { features: overlayCache.get(key) || [], geographyType, live: true }
  }

  let features: CensusOverlayFeature[] = []
  if (geographyType === 'state') {
    const rows = await queryRows(normalized, ['county'])
    features = aggregateStates(rows)
  } else if (geographyType === 'county') {
    features = await loadCountyCensusOverlay(normalized, metric)
  } else if (geographyType === 'zip') {
    features = await loadZipCensusOverlay(normalized, metric)
  } else {
    features = await loadTractCensusOverlay(normalized, metric)
  }

  overlayCache.set(key, features)
  if (!features.length) {
    return {
      features: [],
      geographyType,
      live: false,
      message: 'Nationwide Census overlay data not available in this viewport yet.',
    }
  }

  return {
    features,
    geographyType,
    live: true,
    message: geographyType === 'tract' && !features.some((feature) => feature.geography_type === 'tract')
      ? 'Tract geometry is not available yet, so ZIP-level Census coverage is shown in this zoom range.'
      : undefined,
  }
}

export const featureToGeoJson = (
  feature: CensusOverlayFeature,
  metric: CensusOverlayMetric,
): Feature<Polygon, GeoJsonProperties> => ({
  type: 'Feature',
  geometry: feature.geometry || polygonForBounds(feature.bounds.west, feature.bounds.south, feature.bounds.east, feature.bounds.north),
  properties: {
    id: feature.id,
    geography_type: feature.geography_type,
    geography_id: feature.geography_id,
    name: feature.name,
    state: feature.state || '',
    county: feature.county || '',
    zip: feature.zip || '',
    tract: feature.tract || '',
    source: feature.source,
    metric,
    metricValue: metricValue(metric, feature.metric_values),
    investorOpportunityScore: feature.metric_values.investor_opportunity_score ?? 0,
    acquisitionPressureScore: feature.metric_values.acquisition_pressure_score ?? 0,
    medianHouseholdIncome: feature.metric_values.median_household_income ?? null,
    medianHomeValue: feature.metric_values.median_home_value ?? null,
    medianGrossRent: feature.metric_values.median_gross_rent ?? null,
    vacancyRate: feature.metric_values.vacancy_rate ?? null,
    renterOccupiedPercent: feature.metric_values.renter_occupied_percent ?? null,
    ownerOccupiedPercent: feature.metric_values.owner_occupied_percent ?? null,
    populationDensity: feature.metric_values.population_density ?? null,
    housingMedianYearBuilt: feature.metric_values.housing_median_year_built ?? null,
    summary: feature.summary,
    fillColor: getCensusOverlayColor(metric, metricValue(metric, feature.metric_values)),
    displayValue: toDisplayValue(metric, metricValue(metric, feature.metric_values)),
  },
})

export const buildOverlayGeoJson = (features: CensusOverlayFeature[], metric: CensusOverlayMetric): FeatureCollection<Polygon, GeoJsonProperties> => ({
  type: 'FeatureCollection',
  features: features.map((feature) => featureToGeoJson(feature, metric)),
})
