export type BuyerMatchV4Tab = 'MARKET' | 'BUYERS' | 'ACTIVITY' | 'SHORTLIST'

export type BuyerMatchPaneWidth = '25' | '50' | '75' | '100'

export type BuyerMatchDataState =
  | 'READY'
  | 'PARTIAL'
  | 'NO_LOCAL_DATA'
  | 'SUBJECT_COORDINATES_REQUIRED'
  | 'REFRESHING'
  | 'ERROR'

export type BuyerMatchFallbackLevel =
  | 'EXACT_ZIP'
  | 'RADIUS'
  | 'MARKET'
  | 'COUNTY'
  | 'STATE'
  | 'NONE'

export type ContactReadiness =
  | 'READY'
  | 'PARTIAL'
  | 'ENRICHMENT_REQUIRED'
  | 'RESTRICTED'
  | 'UNKNOWN'

export type AcquisitionContextSource = 'ACQUISITION_ENGINE_V3' | 'UNAVAILABLE'

export interface BuyerMatchSubjectContext {
  propertyId: string | null
  opportunityId: string | null
  threadKey: string | null
  canonicalAddress: string
  latitude: number | null
  longitude: number | null
  assetLane: string | null
  propertySubtype: string | null
  units: number | null
  buildingSquareFeet: number | null
  lotSquareFeet: number | null
  yearBuilt: number | null
  acquisitionDecisionVersion: string | null
  marketValue: number | null
  buyerExitLow: number | null
  buyerExitBase: number | null
  buyerExitHigh: number | null
  strategy: string | null
  repairEstimate: number | null
  executionState: string | null
  majorBuyerFacingRisks?: string[]
  valuationSnapshotId?: string | null
}

export interface BuyerMatchV4Projection {
  version: string
  subject: {
    propertyId: string
    canonicalAddress: string
    latitude: number | null
    longitude: number | null
    assetLane: string | null
    propertySubtype: string | null
    acquisitionContext: {
      marketValue: number | null
      buyerExitLow: number | null
      buyerExitBase: number | null
      buyerExitHigh: number | null
      strategy: string | null
      executionState: string | null
      source: AcquisitionContextSource
    }
  }
  market: {
    dataState: BuyerMatchDataState
    fallbackLevel: BuyerMatchFallbackLevel
    verifiedBuyerCount: number | null
    highFitBuyerCount: number | null
    activeBuyerCount90d: number | null
    activeBuyerCount180d: number | null
    institutionalBuyerCount: number | null
    repeatBuyerCount: number | null
    verifiedPurchaseEventCount: number | null
    mappedPurchaseEventCount: number | null
    likelyBidLow: number | null
    likelyBidBase: number | null
    likelyBidHigh: number | null
    liquidityScore: number | null
    demandScore: number | null
    refreshedAt: string | null
    cacheIncomplete?: boolean
  }
  rankedBuyers: Array<{
    buyerId: string
    buyerName: string
    entityType: string | null
    buyerArchetype: string | null
    institutionalStatus: string | null
    matchScore: number | null
    matchGrade: string | null
    matchConfidence: number | null
    reasonSummary: string[]
    likelyBidLow: number | null
    likelyBidBase: number | null
    likelyBidHigh: number | null
    purchases90d: number | null
    purchases180d: number | null
    purchases365d: number | null
    lastPurchaseAt: string | null
    nearestPurchaseMiles: number | null
    contactReadiness: ContactReadiness
  }>
  purchaseEvents: Array<{
    eventId: string
    buyerId: string
    address: string
    latitude: number | null
    longitude: number | null
    purchaseDate: string | null
    purchasePrice: number | null
    assetLane: string | null
    distanceMiles: number | null
    source: string | null
  }>
  institutionalActivity: unknown[]
  shortlist: unknown[]
  meta?: {
    cached?: boolean
    query_ms?: number
    model_version?: string | null
    error?: string | null
    phase4_cache_note?: string
  }
}

export interface BuyerMatchV4ShellState {
  activeTab: BuyerMatchV4Tab
  selectedBuyerId: string | null
  selectedEventId: string | null
  mapVisible: boolean
  gradeFilter: 'all' | 'A+' | 'A' | 'B'
  shortlist: unknown[]
}

export const INITIAL_SHELL_STATE: BuyerMatchV4ShellState = {
  activeTab: 'MARKET',
  selectedBuyerId: null,
  selectedEventId: null,
  mapVisible: false,
  gradeFilter: 'all',
  shortlist: [],
}