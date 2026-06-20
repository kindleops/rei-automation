export type BuyerMarketSignal = 'Strong' | 'Active' | 'Balanced' | 'Thin' | 'No Coverage' | 'No Buyer Coverage'

export type EngineProgressStage =
  | 'resolving_property'
  | 'selecting_comps'
  | 'calculating_valuation'
  | 'measuring_buyer_demand'
  | 'evaluating_seller_pressure'
  | 'comparing_strategies'
  | 'building_offer_stack'
  | 'finalizing_decision'

export interface BaselineScores {
  acquisition_score?: number | null
  deal_strength_score?: number | null
  motivation_score?: number | null
  distress_score?: number | null
  ai_score?: number | null
  label?: string
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
  ai_score?: number | null
}

export interface DealIntelligenceDecisionSnapshot {
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
  owner_priority?: number | null
  largest_risk?: { label: string; score?: number | null } | null
  recommended_next_action?: string | null
  engine_computed_at?: string | null
}

export interface DealIntelligenceDossier {
  identity: Record<string, unknown>
  location?: Record<string, unknown>
  property: DealIntelligenceProperty
  baseline_scores?: BaselineScores
  prospect: Record<string, unknown>
  master_owner: Record<string, unknown>
  phone: Record<string, unknown>
  acquisition_decision: Record<string, unknown>
  decision_snapshot: DealIntelligenceDecisionSnapshot
  comps: Record<string, unknown>
  buyer_market: Record<string, unknown>
  buyer_matches: Record<string, unknown>
  census: Record<string, unknown>
  activity_timeline: Array<Record<string, unknown>>
  compliance?: Record<string, unknown>
  freshness?: Record<string, unknown>
}

export const ENGINE_STAGE_LABELS: Record<EngineProgressStage, string> = {
  resolving_property: 'Resolving property',
  selecting_comps: 'Selecting comparable sales',
  calculating_valuation: 'Calculating valuation range',
  measuring_buyer_demand: 'Measuring investor demand',
  evaluating_seller_pressure: 'Evaluating seller pressure',
  comparing_strategies: 'Comparing acquisition strategies',
  building_offer_stack: 'Building offer stack',
  finalizing_decision: 'Finalizing decision',
}