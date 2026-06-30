export type BuyerMarketSignal = 'Strong' | 'Active' | 'Balanced' | 'Thin' | 'No Coverage' | 'No Buyer Coverage'

export type EngineProgressStage =
  | 'resolving_property'
  | 'loading_comps'
  | 'qualifying_comps'
  | 'calculating_valuation'
  | 'measuring_buyer_demand'
  | 'evaluating_seller_pressure'
  | 'comparing_strategies'
  | 'building_offer_stack'
  | 'calculating_confidence'
  | 'persisting_decision'
  | 'decision_ready'

/** public.properties baseline columns — not engine AOS. */
export interface BaselineScores {
  /** final_acquisition_score */
  acquisition_score?: number | null
  /** properties.deal_strength_score */
  deal_strength_score?: number | null
  /** properties.structured_motivation_score */
  motivation_score?: number | null
  /** properties.tag_distress_score */
  distress_score?: number | null
  label?: string
}

export interface PropertySnapshot {
  value?: number | null
  equity_amount?: number | null
  equity_percentage?: number | null
  total_loan_balance?: number | null
  total_loan_amount?: number | null
  total_loan_payment?: number | null
  tax_amount?: number | null
  repair_estimate?: number | null
  building_condition?: string | null
  last_sale_date?: string | null
  last_sale_price?: number | null
  last_sale_document_type?: string | null
  recording_date?: string | null
  ownership_years?: number | null
  active_lien?: boolean | null
  tax_delinquent?: boolean | null
  default_date?: string | null
  appreciation?: {
    last_sale_price: number
    last_sale_date: string
    current_value: number
    dollar_change: number
    percent_change: number
    holding_period_years: number
  } | null
}

export interface CompQualification {
  candidates_found?: number
  asset_type_matches?: number
  location_qualified?: number
  similarity_qualified?: number
  weighted_usable?: number
  rejected?: number
}

export interface CompRecord {
  id?: string
  property_id?: string | null
  latitude?: number | null
  longitude?: number | null
  address?: string | null
  property_type?: string | null
  asset_class?: string | null
  sale_date?: string | null
  recording_date?: string | null
  sale_price?: number | null
  mls_sold_price?: number | null
  distance_miles?: number | null
  units?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  sqft?: number | null
  avg_sqft_per_unit?: number | null
  avg_beds_per_unit?: number | null
  lot_sqft?: number | null
  year_built?: number | null
  effective_year_built?: number | null
  condition?: string | null
  construction_type?: string | null
  subdivision?: string | null
  school_district?: string | null
  document_type?: string | null
  buyer_name?: string | null
  buyer_type?: 'individual' | 'corporate' | 'llc_corporate' | null
  is_corporate_buyer?: boolean | null
  is_mls_sale?: boolean | null
  is_off_market?: boolean | null
  ppsf?: number | null
  ppu?: number | null
  similarity_score?: number | null
  weight?: number | null
  included?: boolean
  exclusion_reason?: string | null
  source?: string | null
}

export interface DealIntelligenceProperty {
  status: string
  property_id?: string
  full_address?: string | null
  market?: string | null
  property_type?: string | null
  property_class?: string | null
  normalized_asset_class?: string | null
  units?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  square_feet?: number | null
  year_built?: number | null
  condition?: string | null
  repair_estimate?: number | null
  value?: number | null
  equity_amount?: number | null
  equity_percentage?: number | null
  loan_balance?: number | null
  ownership_years?: number | null
  property_flags?: string[]
  property_flags_overflow?: number
  street_view_url?: string | null
  satellite_url?: string | null
  latitude?: number | null
  longitude?: number | null
  acquisition_score?: number | null
  deal_strength_score?: number | null
  motivation_score?: number | null
  distress_score?: number | null
}

export interface DealIntelligenceDecisionSnapshot {
  baseline_acquisition_score?: number | null
  engine_aos_score?: number | null
  acquisition_score?: number | null
  deal_strength_score?: number | null
  motivation_score?: number | null
  distress_score?: number | null
  ai_score?: number | null
  heat_score?: number | null
  recommended_cash_offer?: number | null
  minimum_acceptable_offer?: number | null
  engine_status?: string
  engine_available?: boolean
  valuation_range?: {
    low?: number | null
    mid?: number | null
    high?: number | null
    confidence?: number | null
  }
  equity_amount?: number | null
  equity_percentage?: number | null
  repair_estimate?: number | null
  value?: number | null
  condition?: string | null
  best_strategy?: string | null
  decision_tier?: string | null
  confidence?: number | null
  expected_assignment_fee?: number | null
  buyer_demand_score?: number | null
  liquidity_score?: number | null
  buyer_market_signal?: string | null
  largest_risk?: { label: string; score?: number | null } | null
  recommended_next_action?: string | null
  engine_computed_at?: string | null
}

export interface ActivityEvent {
  type: string
  label: string
  timestamp?: string
  source?: string
  tone?: 'success' | 'danger' | 'warning' | 'info' | 'ai' | 'neutral'
  detail?: string | null
}

export interface DealIntelligenceDossier {
  identity: Record<string, unknown>
  location?: Record<string, unknown>
  property: DealIntelligenceProperty
  property_snapshot?: PropertySnapshot
  property_detail?: Record<string, Record<string, unknown>>
  multifamily?: Record<string, unknown>
  baseline_scores?: BaselineScores
  prospect: Record<string, unknown>
  master_owner: Record<string, unknown>
  phone: Record<string, unknown>
  acquisition_decision: Record<string, unknown>
  decision_snapshot: DealIntelligenceDecisionSnapshot
  comps: {
    status?: string
    label?: string | null
    qualification?: CompQualification
    candidate_count?: number
    usable_count?: number
    comp_count?: number
    weighted_comp_count?: number
    median_sale?: number | null
    median_ppsf?: number | null
    avg_ppsf?: number | null
    median_ppu?: number | null
    avg_ppu?: number | null
    mls_sale_count?: number | null
    off_market_count?: number | null
    corporate_buyer_count?: number | null
    valuation_low?: number | null
    valuation_high?: number | null
    valuation_mid?: number | null
    confidence?: number | null
    freshness?: string | null
    records?: CompRecord[]
  }
  buyer_market: Record<string, unknown>
  buyer_matches: Record<string, unknown>
  census: Record<string, unknown>
  conversation_intelligence?: Record<string, unknown>
  activity_timeline: ActivityEvent[]
  compliance?: Record<string, unknown>
  freshness?: Record<string, unknown>
}

export const ENGINE_STAGE_DISPLAY_ORDER: EngineProgressStage[] = [
  'resolving_property',
  'loading_comps',
  'qualifying_comps',
  'calculating_valuation',
  'measuring_buyer_demand',
  'evaluating_seller_pressure',
  'comparing_strategies',
  'building_offer_stack',
  'persisting_decision',
  'decision_ready',
]

export const ENGINE_STAGE_LABELS: Record<EngineProgressStage, string> = {
  resolving_property: 'Resolving property',
  loading_comps: 'Selecting comparable sales',
  qualifying_comps: 'Qualifying usable comps',
  calculating_valuation: 'Calculating valuation range',
  measuring_buyer_demand: 'Measuring investor demand',
  evaluating_seller_pressure: 'Evaluating seller pressure',
  comparing_strategies: 'Comparing strategies',
  building_offer_stack: 'Building offer stack',
  calculating_confidence: 'Calculating confidence',
  persisting_decision: 'Persisting decision',
  decision_ready: 'Decision ready',
}