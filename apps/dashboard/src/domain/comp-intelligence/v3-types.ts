export type CompExecutionState =
  | 'SHADOW_MODE_READY'
  | 'REVIEW_REQUIRED'
  | 'DATA_REQUIRED'
  | 'ANOMALY_QUARANTINE'
  | 'EVIDENCE_ONLY_DEGRADED'
  | 'V3_DISABLED'
  | 'legacy_v2_projection'
  | string

export type CompValueClassification =
  | 'QUALIFIED'
  | 'PROVISIONAL_SCENARIO'
  | 'SCENARIO'
  | 'UNAVAILABLE'
  | string

export interface CompValueRange {
  low: number | null
  mid: number | null
  high: number | null
  source?: string | null
  assumptions?: string[]
}

export interface CompOfferAuthorization {
  authorized_opening_offer: number | null
  authorized_recommended_offer: number | null
  authorized_maximum_offer: number | null
  authorized_walkaway_price: number | null
  scenario_opening_offer: number | null
  scenario_recommended_offer: number | null
  scenario_maximum_offer: number | null
  scenario_walkaway_price: number | null
  scenario_source?: string | null
  scenario_assumptions?: string[]
}

export interface CompValueContract {
  qualified_market_value: CompValueRange | null
  scenario_market_value: CompValueRange | null
  qualified_buyer_exit: { conservative: number | null; base: number | null; optimistic: number | null } | null
  scenario_buyer_exit: { conservative: number | null; base: number | null; optimistic: number | null; source?: string; derived_from?: string } | null
}

export interface CompValuationUniverse {
  universe: string
  available: boolean
  classification: CompValueClassification
  low: number | null
  mid: number | null
  high: number | null
  independent_transaction_count: number | null
  effective_sample_size: number | null
  confidence: number | null
  dispersion: number | null
  source_composition?: Record<string, unknown> | null
  pricing_vs_context?: string | null
  rejection_count?: number | null
  unavailable_reason?: string | null
}

export interface CompStrategyEvidence {
  strategy: string
  qualification_status: string
  underwritten: boolean
  scenario_only: boolean
  evidence_completeness?: number | null
  missing_inputs?: string[]
  confidence?: number | null
  base_economics?: Record<string, unknown> | null
  stress_result?: Record<string, unknown> | null
  shadow_approved?: boolean
  live_authorized?: boolean
  blockers?: string[]
}

export interface CompExecutionBasis {
  basis_strategy?: string | null
  basis_label?: string | null
  shadow_mode?: boolean
  live_authorization_enabled?: boolean
}

export interface CompAnomalyMateriality {
  transaction_anomaly_present?: boolean
  transaction_anomaly_count?: number
  transaction_anomaly_material?: boolean
  material_anomaly_reasons?: string[]
  nonmaterial_warning_reasons?: string[]
  anomaly_flags?: string[]
}

export interface CompModelHealth {
  confidence_components?: Record<string, unknown>
  dominant_universe_cap?: number | null
  total_clean_evidence?: number | null
  wholesale_pricing_ess?: number | null
  universe_specific_ess?: Record<string, number> | null
  model_disagreement?: number | null
  anomaly_materiality?: CompAnomalyMateriality
  invariant_results?: Record<string, unknown>
  loader_diagnostics?: Record<string, unknown> | null
  feature_flags?: Record<string, boolean>
}

export interface CompTransactionEvidence {
  candidate_id: string | null
  source_record_id: string | null
  transaction_cluster_id: string | null
  property_id: string | null
  address: string | null
  canonical_asset_lane: string | null
  sale_price: number | null
  sale_date: string | null
  buyer: string | null
  buyer_archetype: string | null
  transaction_channel: string | null
  evidence_role: string | null
  routed_universe: string | null
  pricing_eligibility: boolean | null
  demand_eligibility: boolean | null
  package_probability: number | null
  parcel_count: number | null
  raw_row_count: number | null
  peer_classification: string | null
  qualification_score: number | null
  similarity: number | null
  recency: string | null
  geography: {
    distance_miles: number | null
    zip: string | null
    city: string | null
    state: string | null
    latitude: number | null
    longitude: number | null
  }
  independence_weight: number | null
  ess_contribution: number | null
  rejection_review_reasons: string[]
  source_lineage: {
    source_table: string | null
    source_record_id: string | null
    identity_unresolved: boolean | null
    source_completeness: number | null
    channel_reasons: string[]
  }
  evidence_list_role: 'accepted' | 'rejected' | string
  qualification_status: string
}

export interface CompIntelligenceDecisionProjection {
  engine_version: string
  formula_version: string
  v3_enabled?: boolean
  canonical_asset_lane: string | null
  asset_lane_confidence: number | null
  asset_lane_reasoning?: string[] | Record<string, unknown> | null
  conflicting_asset_signals?: string[]
  execution_state: CompExecutionState
  value_classification: CompValueClassification | null
  final_confidence: number | null
  dominant_model_universe: string | null
  dominant_model_ess: number | null
  dominant_model_depth_score: number | null
  dominant_model_confidence_cap: number | null
  execution_state_basis: CompExecutionBasis | null
  value_contract: CompValueContract | null
  offer_authorization: CompOfferAuthorization | null
  strategy_ranking: {
    primary_strategy?: string | null
    backup_strategy?: string | null
    ranked?: CompStrategyEvidence[]
  } | null
  strategy_depth_gate?: Record<string, unknown> | null
  universes?: Record<string, CompValuationUniverse>
  reconciliation?: Record<string, unknown> | null
  repair?: Record<string, unknown> | null
  buyer_exit?: Record<string, unknown> | null
  cash_offer?: Record<string, unknown> | null
  novation?: Record<string, unknown> | null
  subject_to?: Record<string, unknown> | null
  seller_finance?: Record<string, unknown> | null
  residential_income?: Record<string, unknown> | null
  self_storage?: Record<string, unknown> | null
  retail?: Record<string, unknown> | null
  office?: Record<string, unknown> | null
  evidence_depth?: Record<string, unknown> | null
  anomaly_materiality?: CompAnomalyMateriality
  invariants?: Record<string, unknown> | null
  loader_diagnostics?: Record<string, unknown> | null
  feature_flags?: Record<string, boolean>
  shadow_mode?: boolean
  primary_strategy?: string | null
  backup_strategy?: string | null
  model_disagreement?: number | null
  projection_mode: string
}

export interface CompAnalystScenario {
  label: 'ANALYST SCENARIO'
  included_candidate_ids: string[]
  excluded_candidate_ids: string[]
  scenario_market_value: CompValueRange | null
  scenario_offer: number | null
  delta_from_canonical: Record<string, number | null>
  invariant_changes: string[]
  confidence_gate_changes: string[]
}

export interface CompLegacyValuation {
  model_version: string
  arv: number | null
  as_is_value: number | null
  repair_estimate: number | null
  confidence: number
  data_gaps: string[]
  warnings: string[]
  outputs: Record<string, { value: unknown; formula?: string; confidence?: number }>
  supporting_comp_ids?: string[]
  authoritative: false
  label: string
}