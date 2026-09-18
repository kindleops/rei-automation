// src/lib/data/censusData.ts
import { getSupabaseClient } from '../supabaseClient'

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
 * §42/§44 — REAL CENSUS OR NONE.
 *
 * This used to be a `// TODO: Connect to real Supabase census_geo_metrics table`
 * sitting above a hardcoded `mockData` object — census tract "48113000100",
 * population 4230, a fixed median income — described in its own comment as
 * "shaped exactly like production data". Intelligence Panel then ran
 * `calculateInvestorOpportunityScore` over it and rendered the result to the
 * operator as demographic intelligence for THEIR property. Every property got
 * the same invented tract and the same invented grade.
 *
 * `census_geo_metrics` is real and has 40 columns. It is also, as of this pass,
 * EMPTY — the census sync has never populated it. So this now asks the real
 * table and returns null when there is nothing, which is the honest answer and
 * one the caller already renders: "No demographic data found for this property
 * location."
 *
 * Wiring the sync is the actual fix for the feature; fabricating a tract is not.
 */
export async function loadCensusForProperty(property: any): Promise<CensusData | null> {
  const zip = clean(property?.address?.zip ?? property?.property_address_zip ?? property?.zip);
  const tract = clean(property?.census_tract);
  if (!zip && !tract) return null;

  try {
    const supabase = getSupabaseClient();
    if (!supabase) return null;

    let query = supabase.from('census_geo_metrics').select('*').limit(1);
    query = tract ? query.eq('tract', tract) : query.eq('zcta', zip);

    const { data, error } = await query;
    if (error) throw error;

    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    if (!row) return null;

    const mapped: CensusData = {
      census_tract: row.tract ?? row.geoid ?? undefined,
      zip: row.zcta ?? zip ?? undefined,
      state: row.state ?? undefined,
      county: row.county_name ?? undefined,
      population: row.total_population ?? undefined,
      households: row.total_households ?? undefined,
      housing_units: row.total_housing_units ?? undefined,
      vacant_units: row.vacant_housing_units ?? undefined,
      vacancy_rate: row.vacancy_rate ?? undefined,
      owner_occupied_units: row.owner_occupied_units ?? undefined,
      owner_occupied_percent: row.owner_occupancy_rate ?? undefined,
      renter_occupied_units: row.renter_occupied_units ?? undefined,
      renter_occupied_percent: row.renter_rate ?? undefined,
      median_household_income: row.median_household_income ?? undefined,
      housing_median_year_built: row.median_year_built ?? undefined,
    };

    const { score, summary } = calculateInvestorOpportunityScore(mapped);
    mapped.investor_opportunity_score = score;
    mapped.investor_signal_summary = summary;
    return mapped;
  } catch {
    // A failed read is not demographic data. Null renders the caller's
    // "no demographic data" state rather than an invented neighbourhood.
    return null;
  }
}

export async function loadCensusForBounds(_bounds: any, _metric: CensusMetricExtended): Promise<CensusData[]> {
  return [];
}
