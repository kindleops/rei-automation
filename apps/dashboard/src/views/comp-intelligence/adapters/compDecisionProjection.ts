import type {
  CompIntelligenceDecisionProjection,
  CompLegacyValuation,
  CompModelHealth,
  CompTransactionEvidence,
  CompValuationUniverse,
} from '../../../domain/comp-intelligence/v3-types'
import type { CompIntelligencePayload } from '../../../domain/comp-intelligence/types'

export function isAuthoritativeV3(payload: CompIntelligencePayload | null): boolean {
  return payload?.decision_projection?.projection_mode === 'authoritative_v3'
}

export function isDegradedEvidenceOnly(payload: CompIntelligencePayload | null): boolean {
  return payload?.decision_projection?.execution_state === 'EVIDENCE_ONLY_DEGRADED'
    || payload?.data_source_mode === 'EVIDENCE_ONLY_DEGRADED'
}

export function getDecisionProjection(payload: CompIntelligencePayload | null): CompIntelligenceDecisionProjection | null {
  return payload?.decision_projection ?? null
}

export function getTransactionEvidence(payload: CompIntelligencePayload | null): CompTransactionEvidence[] {
  return payload?.transaction_evidence ?? []
}

export function getLegacyValuation(payload: CompIntelligencePayload | null): CompLegacyValuation | null {
  return payload?.legacy_valuation ?? null
}

export function getQualifiedMarketValue(projection: CompIntelligenceDecisionProjection | null): number | null {
  return projection?.value_contract?.qualified_market_value?.mid ?? null
}

export function getScenarioMarketValue(projection: CompIntelligenceDecisionProjection | null): number | null {
  return projection?.value_contract?.scenario_market_value?.mid ?? null
}

export function getDisplayMarketValue(projection: CompIntelligenceDecisionProjection | null): {
  value: number | null
  classification: string
} {
  const qualified = projection?.value_contract?.qualified_market_value?.mid ?? null
  if (qualified != null) return { value: qualified, classification: 'QUALIFIED' }
  const scenario = projection?.value_contract?.scenario_market_value?.mid ?? null
  if (scenario != null) {
    return {
      value: scenario,
      classification: projection?.value_contract?.scenario_market_value?.source ?? 'SCENARIO',
    }
  }
  return { value: null, classification: 'UNAVAILABLE' }
}

export function getConservativeBuyerExit(projection: CompIntelligenceDecisionProjection | null): number | null {
  const qualified = projection?.value_contract?.qualified_buyer_exit?.conservative
  if (qualified != null) return qualified
  return projection?.value_contract?.scenario_buyer_exit?.conservative ?? null
}

export function getShadowOffer(projection: CompIntelligenceDecisionProjection | null): number | null {
  if (projection?.execution_state !== 'SHADOW_MODE_READY') return null
  return projection?.offer_authorization?.scenario_recommended_offer
    ?? (projection?.cash_offer?.recommended_cash_offer as number | undefined)
    ?? null
}

export function getAuthorizedOffer(projection: CompIntelligenceDecisionProjection | null): number | null {
  return projection?.offer_authorization?.authorized_recommended_offer ?? null
}

export function listValuationUniverses(projection: CompIntelligenceDecisionProjection | null): CompValuationUniverse[] {
  const raw = projection?.universes
  if (!raw) return []
  return Object.entries(raw).map(([universe, data]) => ({
    universe,
    available: Boolean((data as unknown as CompValuationUniverse).available ?? (data as unknown as Record<string, unknown>).mid != null),
    classification: (data as unknown as CompValuationUniverse).classification ?? 'UNAVAILABLE',
    low: (data as unknown as CompValuationUniverse).low ?? null,
    mid: (data as unknown as CompValuationUniverse).mid ?? null,
    high: (data as unknown as CompValuationUniverse).high ?? null,
    independent_transaction_count: (data as unknown as CompValuationUniverse).independent_transaction_count ?? null,
    effective_sample_size: (data as unknown as CompValuationUniverse).effective_sample_size ?? null,
    confidence: (data as unknown as CompValuationUniverse).confidence ?? null,
    dispersion: (data as unknown as CompValuationUniverse).dispersion ?? null,
    source_composition: (data as unknown as CompValuationUniverse).source_composition ?? null,
    pricing_vs_context: (data as unknown as CompValuationUniverse).pricing_vs_context ?? null,
    rejection_count: (data as unknown as CompValuationUniverse).rejection_count ?? null,
    unavailable_reason: (data as unknown as CompValuationUniverse).unavailable_reason ?? null,
  }))
}

export function buildModelHealth(projection: CompIntelligenceDecisionProjection | null): CompModelHealth {
  return {
    confidence_components: projection?.evidence_depth ?? undefined,
    dominant_universe_cap: projection?.dominant_model_confidence_cap ?? null,
    total_clean_evidence: (projection?.evidence_depth?.total_clean_accepted_transaction_count as number) ?? null,
    wholesale_pricing_ess: (projection?.evidence_depth?.wholesale_pricing_ess as number) ?? null,
    model_disagreement: projection?.model_disagreement ?? null,
    anomaly_materiality: projection?.anomaly_materiality,
    invariant_results: projection?.invariants ?? undefined,
    loader_diagnostics: projection?.loader_diagnostics ?? null,
    feature_flags: projection?.feature_flags,
  }
}

export function hasBuyerIdentityData(evidence: CompTransactionEvidence[]): boolean {
  return evidence.some((row) => Boolean(row.buyer || row.buyer_archetype))
}

export function hasInstitutionalData(evidence: CompTransactionEvidence[]): boolean {
  return evidence.some((row) => /institutional/i.test(row.buyer_archetype || row.transaction_channel || ''))
}