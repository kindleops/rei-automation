// src/lib/data/censusData.ts

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

// TODO: Connect to real Supabase census_geo_metrics table
export async function loadCensusForProperty(property: any): Promise<CensusData | null> {
  // Return mock Census data shaped exactly like production data
  const mockData: CensusData = {
    census_tract: "48113000100",
    zip: property?.address?.zip || "75201",
    state: property?.address?.state || "TX",
    county: property?.address?.county || "Dallas",
    population: 4230,
    population_density: 3500,
    households: 1850,
    housing_units: 2100,
    vacant_units: 250,
    vacancy_rate: 11.9,
    owner_occupied_units: 820,
    owner_occupied_percent: 44.3,
    renter_occupied_units: 1030,
    renter_occupied_percent: 55.7,
    median_household_income: 72400,
    median_home_value: 312000,
    median_gross_rent: 1650,
    median_age: 36.2,
    poverty_rate: 12.4,
    education_bachelor_plus_percent: 32.1,
    language_non_english_percent: 18.4,
  };

  const { score, summary } = calculateInvestorOpportunityScore(mockData);
  mockData.investor_opportunity_score = score;
  mockData.investor_signal_summary = summary;

  return mockData;
}

export async function loadCensusForBounds(_bounds: any, _metric: CensusMetricExtended): Promise<CensusData[]> {
  return [];
}
