/**
 * Loader for the property Buyer Intelligence (shadow) panel.
 *
 * Read-only and observational. The backend reads the W8C serving views
 * server-side; the browser never touches them directly, because
 * `reivesti.property_historical_buyers` is service-role only.
 *
 * Person identifiers arrive pre-redacted as `person:anon_<hash>` — the raw
 * upstream form embeds an individual key and must never reach the browser.
 */

import { callBackend } from '../api/backendClient'

export type BuyerIntelligenceStatus = 'available' | 'no_canonical_buyer_history' | 'unavailable'
export type BuyboxStatus = 'derived' | 'insufficient_evidence' | 'unavailable' | string

export interface BuyerAcquisition {
  buyerRole: string | null
  acquiredOn: string | null
  acquisitionPrice: number | null
  resolutionMethod: string | null
  confidence: number | null
}

export interface BuyerHoldFlip {
  classification: string | null
  medianHoldDays: number | null
  dispositions: number | null
  dispositionRatePct: number | null
  confidence: number | null
}

export interface BuyerGeography {
  primaryMarkets: string[]
  topCounties: Array<{ label: string; count: number | null; sharePct: number | null }>
  distinctCounties: number | null
  distinctStates: number | null
  concentrationIndex: number | null
}

export interface BuyerBehavior {
  acquisitionCount: number | null
  dispositionCount: number | null
  firstAcquisition: string | null
  lastAcquisition: string | null
  daysSinceLast: number | null
  trailing365d: number | null
  acquisitionsPerYear: number | null
  activityStatus: string | null
  activityScore: number | null
  archetype: string | null
  archetypeReasons: string[]
  holdFlip: BuyerHoldFlip
  geography: BuyerGeography
  priceMedian: number | null
  cashSharePct: number | null
  portfolioState: string
  portfolioPropertyCount: number | null
  inCorpusHoldings: number | null
  outOfCorpusHoldings: number | null
  evidenceCount: number | null
  evidenceCoveragePct: number | null
  confidence: number | null
}

export interface BuyerBuybox {
  evidenceDepth: number | null
  preferredCounties: string[]
  acceptableStates: string[]
  preferredAssetFamilies: string[]
  priceRobustLow: number | null
  priceRobustHigh: number | null
  priceCoreLow: number | null
  priceCoreHigh: number | null
  priceBasis: string | null
  buildingSqftP25: number | null
  buildingSqftP75: number | null
  unitsP25: number | null
  unitsP75: number | null
  recencyWeightingApplied: boolean
  confidence: number | null
}

export interface BuyerIntelligenceBuyer {
  buyerRef: string
  entityType: string
  displayName: string | null
  identityConfidence: number | null
  identityMethod: string | null
  resolutionMethod: string | null
  resolutionConfidence: number | null
  occurrenceCount: number
  acquisitions: BuyerAcquisition[]
  behavior: BuyerBehavior | null
  buybox: BuyerBuybox | null
  buyboxStatus: BuyboxStatus
}

export interface BuyerIntelligenceComparisonRow {
  reiBuyerEntityId: string
  displayName: string | null
  matchGrade: string | null
  matchScore: number | null
  w8cPropertyEvidence: boolean
  nameAgreementObserved: boolean
  nameAgreementAmbiguous: boolean
  identityConfirmed: false
  linkedByNameOnly: {
    basis: string
    isIdentity: false
    w8cBuyboxAvailable: boolean
    w8cBehaviorConfidence: number | null
  } | null
}

export interface ObservedBuyboxFit {
  buyerRef: string
  displayName: string | null
  entityType: string
  geographyFit: number | null
  geographyTier: string
  assetFit: number | null
  assetTier: string
  robustPriceFit: number | null
  robustPriceTier: string
  characteristicsFit: number | null
  characteristicsTier: string
  evidenceConfidence: number
  evidenceDepth: number | null
  observedBuyboxFitScore: number
  label: string
  evaluable: boolean
  reasons: string[]
}

export interface ObservedFitsSection {
  available: boolean
  reason?: string
  eligibleCandidates?: number
  subject?: {
    state: string | null
    county: string | null
    zip: string | null
    assetFamily: string | null
    referencePrice: number | null
  }
  fits: ObservedBuyboxFit[]
}

export interface BuyerIntelligencePanel {
  source: string
  label: string
  observationalOnly: boolean
  propertyId: string
  status: BuyerIntelligenceStatus
  reason?: string | null
  version?: {
    runId: string | null
    modelVersion: string | null
    w8aVersion: string | null
    w8bVersion: string | null
    completedAt: string | null
  }
  occurrenceCount?: number
  buyerCount?: number
  buyersWithBuybox?: number
  buyers: BuyerIntelligenceBuyer[]
  observedFits?: ObservedFitsSection
  reiComparison?: {
    available: boolean
    candidateCount: number
    rows: BuyerIntelligenceComparisonRow[]
    namespacesSeparate: boolean
    note: string
  }
}

const UNAVAILABLE = (propertyId: string, reason: string): BuyerIntelligencePanel => ({
  source: 'shadow_buyer_intelligence',
  label: 'Buyer Intelligence — Shadow',
  observationalOnly: true,
  propertyId,
  status: 'unavailable',
  reason,
  buyers: [],
})

/**
 * Never rejects. A failure returns an `unavailable` panel so the property page
 * keeps rendering — shadow intelligence must not be able to break it.
 */
export async function loadBuyerIntelligence(propertyId: string | null): Promise<BuyerIntelligencePanel> {
  const id = String(propertyId ?? '').trim()
  if (!id) return UNAVAILABLE('', 'missing_property_id')

  try {
    const result = await callBackend<{ ok: boolean; panel?: BuyerIntelligencePanel }>(
      `/api/intel/buyer-intelligence?property_id=${encodeURIComponent(id)}`,
    )
    if (!result.ok) return UNAVAILABLE(id, 'w8c_unavailable')
    return result.data?.panel ?? UNAVAILABLE(id, 'w8c_unavailable')
  } catch {
    return UNAVAILABLE(id, 'w8c_unavailable')
  }
}
