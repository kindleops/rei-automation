// src/lib/data/censusData.ts
import { callBackend } from '../api/backendClient'

const clean = (value: unknown): string | null => {
  const text = String(value ?? '').trim()
  return text.length > 0 ? text : null
}

export interface CensusData {
  census_tract?: string;
  zip?: string;
  state?: string;
  county?: string;
  population?: number;
  population_density?: number;
  households?: number;
  housing_units?: number;
  vacant_units?: number;
  vacancy_rate?: number;
  owner_occupied_units?: number;
  owner_occupied_percent?: number;
  renter_occupied_units?: number;
  renter_occupied_percent?: number;
  median_household_income?: number;
  median_home_value?: number;
  median_gross_rent?: number;
  median_age?: number;
  poverty_rate?: number;
  education_bachelor_plus_percent?: number;
  language_non_english_percent?: number;
  investor_opportunity_score?: number;
  investor_signal_summary?: string;
  housing_median_year_built?: number;
}

export type CensusMetric = 
  | 'vacancy_rate' 
  | 'median_income' 
  | 'renter_density' 
  | 'owner_occupancy' 
  | 'median_home_value' 
  | 'median_rent' 
  | 'population_density' 
  | 'investor_opportunity_score'
  | 'none';

// Used by map overlays
export type CensusMetricExtended = 
  | 'census_heatmap'
  | 'vacancy_heat'
  | 'income_heat'
  | 'renter_density'
  | 'owner_occupancy'
  | 'median_home_value'
  | 'median_rent'
  | 'housing_age'
  | 'acquisition_pressure'
  | 'investor_opportunity';

export interface InvestorOpportunityResult {
  score: number;
  grade: 'A' | 'B' | 'C' | 'Watchlist';
  summary: string;
}

export function calculateInvestorOpportunityScore(data: Partial<CensusData>): InvestorOpportunityResult {
  let score = 50; // Base score
  const reasons: string[] = [];

  const vacancy = data.vacancy_rate ?? 0;
  const renterPercent = data.renter_occupied_percent ?? 0;
  const medianHomeValue = data.median_home_value ?? 0;
  const medianIncome = data.median_household_income ?? 0;
  const popDensity = data.population_density ?? 0;
  const poverty = data.poverty_rate ?? 0;

  // vacancy_rate high but not extreme = positive (indicates transition or high inventory)
  if (vacancy >= 8 && vacancy <= 15) {
    score += 15;
    reasons.push("Healthy inventory levels");
  } else if (vacancy > 15) {
    score -= 10;
    reasons.push("High vacancy risk");
  }

  // renter_occupied_percent high = rental demand signal
  if (renterPercent > 45) {
    score += 15;
    reasons.push("Strong rental demand");
  }

  // median_home_value below market average = opportunity signal
  if (medianHomeValue > 0 && medianHomeValue < 300000) {
    score += 10;
    reasons.push("Accessible entry price");
  } else if (medianHomeValue > 500000) {
    score -= 5;
    reasons.push("High capital requirement");
  }

  // median_income stable/moderate = buyer/renter strength
  if (medianIncome >= 45000 && medianIncome <= 90000) {
    score += 10;
    reasons.push("Stable middle-income base");
  }

  // population_density moderate/high = liquidity
  if (popDensity > 2000) {
    score += 10;
    reasons.push("High liquidity");
  }

  // poverty_rate extreme = risk penalty
  if (poverty > 25) {
    score -= 20;
    reasons.push("Elevated economic risk");
  }

  score = Math.max(0, Math.min(100, score));

  let grade: 'A' | 'B' | 'C' | 'Watchlist' = 'Watchlist';
  if (score >= 80) grade = 'A';
  else if (score >= 60) grade = 'B';
  else if (score >= 40) grade = 'C';

  const summary = reasons.length > 0 
    ? `Targeted as ${grade}-Grade (${score}/100) signal. ${reasons.slice(0, 2).join('; ')}.`
    : `Neutral signal detected (${score}/100).`;

  return { score, grade, summary };
}

/**
 * The one census read model: GET /api/cockpit/map/census (operator-gated),
 * backed by exchange_market_fundamentals_cells — US Census ACS 5-year, 2024
 * vintage: 1,325 ZCTAs, 403 places, 76 counties, 33 states, each with its
 * margin of error. Values arrive as published (shares 0..1); `toCensusData`
 * turns shares into the percents CensusData has always carried.
 *
 * History: this used to read public.census_geo_metrics, which has never held
 * a row (its only loader was a dev-only Vite middleware that never ran in
 * production), and before that a hardcoded mock tract. Fields the ACS cells
 * do not carry (home value, poverty, density, age, education, language) stay
 * undefined — never zero.
 */
export interface CensusCell {
  geo_id: string
  level: 'zip' | 'county' | 'city' | 'state'
  name: string
  census_geoid: string
  state: string | null
  county: string | null
  city: string | null
  lat: number | null
  lng: number | null
  source: { dataset: string; vintage: number | null; attribution: string }
  population: number | null
  households: number | null
  housing_units: number | null
  vacancy_rate: number | null
  renter_share: number | null
  owner_share: number | null
  median_household_income: number | null
  median_household_income_moe: number | null
  median_gross_rent: number | null
  median_year_built: number | null
  rent_burden: number | null
  units_2_4_share: number | null
  units_5plus_share: number | null
}
interface CensusReply { ok: boolean; covered?: boolean; cell?: CensusCell | null; cells?: CensusCell[] }

export async function fetchCensusCells(query: Record<string, string | number>): Promise<CensusCell[]> {
  const qs = Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
  const res = await callBackend<CensusReply>(`/api/cockpit/map/census?${qs}`, { timeoutMs: 20_000 })
  const body = res.ok ? (res.data as CensusReply | undefined) : undefined
  if (!body?.ok) return []
  return body.cells ?? (body.cell ? [body.cell] : [])
}

const pct = (share: number | null | undefined) => (share === null || share === undefined || !Number.isFinite(share) ? undefined : Math.round(share * 1000) / 10)
const val = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? undefined : v)

/** One ACS cell → the CensusData shape the panels read (shares → percents). */
export function toCensusData(c: CensusCell): CensusData {
  const units = val(c.housing_units)
  const vac = pct(c.vacancy_rate)
  return {
    zip: c.level === 'zip' ? c.census_geoid : undefined,
    state: c.state ?? undefined,
    county: c.county ?? undefined,
    population: val(c.population),
    households: val(c.households),
    housing_units: units,
    vacant_units: units !== undefined && c.vacancy_rate !== null ? Math.round(units * c.vacancy_rate) : undefined,
    vacancy_rate: vac,
    owner_occupied_percent: pct(c.owner_share),
    renter_occupied_percent: pct(c.renter_share),
    median_household_income: val(c.median_household_income),
    median_gross_rent: val(c.median_gross_rent),
    housing_median_year_built: val(c.median_year_built),
  }
}

export async function loadCensusForProperty(property: any): Promise<CensusData | null> {
  const zip = clean(property?.address?.zip ?? property?.property_address_zip ?? property?.zip)?.slice(0, 5) ?? null
  const lat = Number(property?.latitude ?? property?.lat ?? property?.address?.lat)
  const lng = Number(property?.longitude ?? property?.lng ?? property?.address?.lng)
  const query: Record<string, string | number> | null = zip && /^\d{5}$/.test(zip) ? { zip } : Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0) ? { lat, lng } : null
  if (!query) return null
  try {
    const cell = (await fetchCensusCells(query))[0]
    if (!cell) return null
    const mapped = toCensusData(cell)
    const { score } = calculateInvestorOpportunityScore(mapped)
    mapped.investor_opportunity_score = score
    mapped.investor_signal_summary = `US Census ACS 5-year ${cell.source.vintage ?? ''} · ZIP ${cell.census_geoid}${cell.median_household_income_moe ? ` · income ±$${Math.round(cell.median_household_income_moe).toLocaleString('en-US')}` : ''}`.replace(/\s+·/g, ' ·')
    return mapped
  } catch {
    // A failed read is not demographic data: null renders the caller's
    // "no demographic data" state rather than an invented neighbourhood.
    return null
  }
}

/** ZIP-level ACS cells whose centroid is inside the bounds (same read model). */
export async function loadCensusForBounds(bounds: { west?: number; south?: number; east?: number; north?: number } | null | undefined): Promise<CensusData[]> {
  const b = bounds ?? {}
  if (![b.west, b.south, b.east, b.north].every((v) => Number.isFinite(v))) return []
  try {
    const cells = await fetchCensusCells({ bbox: [b.west, b.south, b.east, b.north].map((v) => (v as number).toFixed(4)).join(','), level: 'zip' })
    return cells.map(toCensusData)
  } catch {
    return []
  }
}
