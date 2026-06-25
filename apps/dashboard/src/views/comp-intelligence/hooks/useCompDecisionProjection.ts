import { useMemo } from 'react'
import type { CompIntelligencePayload } from '../../../domain/comp-intelligence/types'
import {
  buildModelHealth,
  getAuthorizedOffer,
  getConservativeBuyerExit,
  getDecisionProjection,
  getDisplayMarketValue,
  getLegacyValuation,
  getShadowOffer,
  getTransactionEvidence,
  isAuthoritativeV3,
  isDegradedEvidenceOnly,
  listValuationUniverses,
} from '../adapters/compDecisionProjection'

export function useCompDecisionProjection(payload: CompIntelligencePayload | null) {
  const projection = useMemo(() => getDecisionProjection(payload), [payload])
  const evidence = useMemo(() => getTransactionEvidence(payload), [payload])
  const legacy = useMemo(() => getLegacyValuation(payload), [payload])
  const market = useMemo(() => getDisplayMarketValue(projection), [projection])
  const universes = useMemo(() => listValuationUniverses(projection), [projection])
  const modelHealth = useMemo(() => buildModelHealth(projection), [projection])

  return {
    projection,
    evidence,
    legacy,
    universes,
    modelHealth,
    isAuthoritative: isAuthoritativeV3(payload),
    isDegraded: isDegradedEvidenceOnly(payload),
    marketValue: market.value,
    marketClassification: market.classification,
    conservativeBuyerExit: getConservativeBuyerExit(projection),
    shadowOffer: getShadowOffer(projection),
    authorizedOffer: getAuthorizedOffer(projection),
    executionState: projection?.execution_state ?? null,
    canonicalLane: projection?.canonical_asset_lane ?? null,
    laneConfidence: projection?.asset_lane_confidence ?? null,
    finalConfidence: projection?.final_confidence ?? null,
    primaryStrategy: projection?.primary_strategy ?? projection?.strategy_ranking?.primary_strategy ?? null,
    backupStrategy: projection?.backup_strategy ?? projection?.strategy_ranking?.backup_strategy ?? null,
    offerAuthorization: projection?.offer_authorization ?? null,
    cashOffer: projection?.cash_offer ?? null,
    reconciliation: projection?.reconciliation ?? null,
    featureFlags: projection?.feature_flags ?? null,
    shadowMode: projection?.shadow_mode ?? false,
  }
}