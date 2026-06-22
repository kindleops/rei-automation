export type ValuationPipelineState =
  | 'loading_evidence'
  | 'resolving_subject'
  | 'searching_comps'
  | 'expanding_search'
  | 'scoring_comps'
  | 'valuing'
  | 'ready'
  | 'ready_with_limitations'
  | 'blocked_missing_subject'
  | 'blocked_insufficient_evidence'
  | 'error'

export interface EvidenceField<T = unknown> {
  value: T | null
  source: string | null
  source_timestamp?: string | null
  confidence?: number | null
  applicability?: string
  missing_reason?: string | null
  present: boolean
}

export interface CanonicalSubjectProperty {
  property_id: string
  source_property_id?: string | null
  parcel_apn?: EvidenceField<string>
  canonical_address?: EvidenceField<string>
  normalized_address?: EvidenceField<string>
  owner_id?: EvidenceField<string>
  master_owner_id?: EvidenceField<string>
  opportunity_id?: EvidenceField<string>
  thread_key?: EvidenceField<string>
  asset_type?: EvidenceField<string>
  units?: EvidenceField<number>
  latitude?: EvidenceField<number>
  longitude?: EvidenceField<number>
  coordinate_source: string
  coordinate_confidence: number
  coordinate_reversed?: boolean
  is_market_fallback: boolean
  is_subject_resolved: boolean
  coordinate_failure_reason?: string | null
  market?: EvidenceField<string>
  county?: EvidenceField<string>
  state?: EvidenceField<string>
  zip?: EvidenceField<string>
  city?: EvidenceField<string>
  property_type?: EvidenceField<string>
  bedrooms?: EvidenceField<number>
  bathrooms?: EvidenceField<number>
  square_feet?: EvidenceField<number>
  lot_square_feet?: EvidenceField<number>
  year_built?: EvidenceField<number>
  condition?: EvidenceField<string>
  estimated_value?: EvidenceField<number>
  estimated_arv?: EvidenceField<number>
  equity_amount?: EvidenceField<number>
  repair_estimate?: EvidenceField<number>
  contract_version?: string
}

export interface CompCandidateEvidence {
  comp_property_id: string
  property_id?: string | null
  source?: string
  sale_list_price?: number | null
  sale_list_date?: string | null
  sold_price?: number | null
  sold_date?: string | null
  sold_source?: string
  distance_miles?: number | null
  latitude?: number | null
  longitude?: number | null
  asset_type?: string | null
  units?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  square_feet?: number | null
  ppsf?: number | null
  ppu?: number | null
  address?: string | null
  similarity_score?: number
  comp_match_label?: string
  selected?: boolean
  excluded?: boolean
  exclusion_reasons?: string[]
  scoring?: {
    score: number
    label: string
    reasoning: Record<string, unknown>
    exclusion_reasons?: string[]
    auto_included?: boolean
    auto_excluded?: boolean
  }
}

export interface CompIntelligencePayload {
  subject: CanonicalSubjectProperty
  discovery: {
    search_mode: string
    is_market_fallback: boolean
    relaxations: Array<Record<string, unknown>>
    candidates: CompCandidateEvidence[]
    included: CompCandidateEvidence[]
    excluded: CompCandidateEvidence[]
    counts: { total: number; included: number; excluded: number }
  }
  valuation: {
    model_version: string
    arv: number | null
    as_is_value: number | null
    repair_estimate: number | null
    confidence: number
    data_gaps: string[]
    warnings: string[]
    outputs: Record<string, { value: unknown; formula?: string; confidence?: number }>
    supporting_comp_ids?: string[]
  }
  valuation_state: {
    state: string
    label: string
    detail?: string
  }
  snapshot?: { persisted: boolean; reason?: string; snapshot_id?: string; input_hash?: string }
  input_hash?: string | null
}