export type BuyerMarketSignal = 'Strong' | 'Active' | 'Balanced' | 'Thin' | 'No Coverage' | 'No Buyer Coverage'

export type EngineProgressStage =
  | 'resolving_property'
  | 'loading_comps'
  | 'measuring_buyer_demand'
  | 'evaluating_seller_pressure'
  | 'comparing_strategies'
  | 'building_offer_stack'
  | 'decision_ready'

export interface DealIntelligenceIdentity {
  thread_key: string
  property_id?: string
  prospect_id?: string
  master_owner_id?: string
  canonical_e164?: string
  market?: string | null
  zip?: string | null
  latitude?: number | null
  longitude?: number | null
}

export interface DealIntelligenceProperty {
  status: string
  property_id?: string
  full_address?: string | null
  market?: string | null
  property_type?: string | null
  normalized_asset_class?: string | null
  units?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  square_feet?: number | null
  year_built?: number | null
  condition?: string | null
  repair_estimate?: number | null
  arv?: number | null
  value?: number | null
  equity_amount?: number | null
  equity_percentage?: number | null
  loan_balance?: number | null
  property_flags?: string[]
  street_view_url?: string | null
  satellite_url?: string | null
  latitude?: number | null
  longitude?: number | null
  acquisition_score?: number | null
}

export interface DealIntelligenceDecisionSnapshot {
  acquisition_score?: number | null
  heat_score?: number | null
  recommended_cash_offer?: number | null
  engine_status?: string
  valuation_range?: {
    low?: number | null
    mid?: number | null
    high?: number | null
    confidence?: number | null
  }
  equity_amount?: number | null
  equity_percentage?: number | null
  best_strategy?: string | null
  expected_assignment_fee?: number | null
  buyer_demand_score?: number | null
  liquidity_score?: number | null
  largest_risk?: { label: string; score?: number | null } | null
  recommended_next_action?: string | null
}

export interface DealIntelligenceBuyerMarket {
  status: string
  signal?: BuyerMarketSignal
  geographic_level_used?: string | null
  fallback_attempted?: string[]
  purchase_count?: number | null
  buyer_count?: number | null
  corporate_buyer_count?: number | null
  repeat_buyer_count?: number | null
  avg_purchase_price?: number | null
  median_purchase_price?: number | null
  ppsf?: number | null
  ppu?: number | null
  liquidity_score?: number | null
  velocity_score?: number | null
  investor_demand_score?: number | null
  buyer_heat_score?: number | null
  dominant_buyer_type?: string | null
  dominant_strategy?: string | null
  data_freshness?: string | null
}

export interface DealIntelligenceDossier {
  identity: DealIntelligenceIdentity
  property: DealIntelligenceProperty
  prospect: Record<string, unknown>
  master_owner: Record<string, unknown>
  phone: Record<string, unknown>
  acquisition_decision: Record<string, unknown>
  decision_snapshot: DealIntelligenceDecisionSnapshot
  comps: Record<string, unknown>
  buyer_market: DealIntelligenceBuyerMarket
  buyer_matches: Record<string, unknown>
  census: Record<string, unknown>
  activity_timeline: Array<Record<string, unknown>>
  compliance?: Record<string, unknown>
  freshness?: Record<string, unknown>
}

export const ENGINE_STAGE_LABELS: Record<EngineProgressStage, string> = {
  resolving_property: 'Resolving property',
  loading_comps: 'Loading comps',
  measuring_buyer_demand: 'Measuring buyer demand',
  evaluating_seller_pressure: 'Evaluating seller pressure',
  comparing_strategies: 'Comparing strategies',
  building_offer_stack: 'Building offer stack',
  decision_ready: 'Decision ready',
}