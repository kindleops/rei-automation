export type BuyerMatchV4Tab = 'MARKET' | 'BUYERS' | 'INSTITUTIONS' | 'PURCHASE_ACTIVITY' | 'SHORTLIST'

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

export type BuyerGradeFilter = 'all' | 'A+' | 'A' | 'B' | 'C'

export type BuyerDirectoryMode =
  | 'best_match'
  | 'local_regional'
  | 'institutional'
  | 'builders'
  | 'all_eligible'
  | 'research'

export type BuyerClass =
  | 'LOCAL_INVESTOR'
  | 'REGIONAL_OPERATOR'
  | 'INSTITUTIONAL_OPERATOR'
  | 'REIT'
  | 'PRIVATE_EQUITY_PLATFORM'
  | 'BUILDER'
  | 'OWNER_OCCUPANT'
  | 'GOVERNMENT_AGENCY'
  | 'LENDER_OR_SERVICER'
  | 'TRUST'
  | 'NONPROFIT'
  | 'INDIVIDUAL'
  | 'UNKNOWN'

export type BuyerDemandEligibility =
  | 'DISPOSITION_BUYER'
  | 'DEMAND_ONLY'
  | 'NON_MARKET_TRANSFER'
  | 'GOVERNMENT_OR_AGENCY'
  | 'LENDER_OR_FORECLOSURE'
  | 'RELATED_PARTY'
  | 'PACKAGE_UNRESOLVED'
  | 'IDENTITY_UNRESOLVED'
  | 'EXCLUDED'

export type TransactionScope = 'SINGLE_ASSET' | 'MULTI_ASSET_PACKAGE' | 'PORTFOLIO' | 'UNKNOWN'

export type BuyerSortKey =
  | 'best_match'
  | 'most_active'
  | 'highest_bid'
  | 'nearest'
  | 'most_recent'
  | 'most_purchases'
  | 'contact_ready'

export type ActivityPeriod = 30 | 60 | 90 | 180 | 365 | 0

export type MapStyle = 'satellite' | 'street' | 'hybrid'

export interface BuyerActivityMetrics {
  unique30d: number
  unique60d: number
  unique90d: number
  unique180d: number
  unique365d: number
  lifetime: number
  events30d: number
  events60d: number
  events90d: number
  events180d: number
  events365d: number
  lifetimeEvents: number
  packageAssets30d: number
  packageAssetsLifetime: number
  singleAssetPct: number | null
  packagePct: number | null
  localZipPurchases: number
  radiusPurchases: number
  nearestPurchaseMiles: number | null
  mostRecentPurchase: string | null
  medianQualifiedPrice: number | null
  qualifiedPriceLow: number | null
  qualifiedPriceHigh: number | null
}

export interface LegalEntityRef {
  entityId: string
  legalName: string
  normalizedName: string
  relationshipType: 'PARENT' | 'SUBSIDIARY' | 'ACQUISITION_ENTITY' | 'PROPERTY_SPV' | 'ALIAS' | 'UNKNOWN'
  confidence: number | null
  purchaseCount: number
}

export interface BuyerFilterState {
  grade: BuyerGradeFilter
  directoryMode: BuyerDirectoryMode
  institutionalOnly: boolean
  active90d: boolean
  active180d: boolean
  contactReady: boolean
  exactZip: boolean
  sort: BuyerSortKey
}

export interface ActivityFilterState {
  periodDays: ActivityPeriod
  buyerClass: BuyerClass | 'all'
  institutionalOnly: boolean
  localRegionalOnly: boolean
  singleAssetOnly: boolean
  packageOnly: boolean
  pricingEligibleOnly: boolean
  demandOnly: boolean
  nonMarketOnly: boolean
  unknownIdentityOnly: boolean
  radiusMiles: number
  mapStyle: MapStyle
}

export interface RankedBuyer {
  buyerId: string
  buyerFamilyId?: string
  buyerName: string
  entityType: string | null
  buyerArchetype: string | null
  buyerClass?: BuyerClass
  institutionalSubtype?: string | null
  institutionalStatus: string | null
  eligibleDispositionBuyer?: boolean
  matchScore: number | null
  matchGrade: string | null
  matchConfidence: number | null
  reasonSummary: string[]
  likelyBidLow: number | null
  likelyBidBase: number | null
  likelyBidHigh: number | null
  purchases30d?: number | null
  purchases60d?: number | null
  purchases90d: number | null
  purchases180d: number | null
  purchases365d: number | null
  lifetimePurchases?: number | null
  lastPurchaseAt: string | null
  nearestPurchaseMiles: number | null
  medianQualifiedPrice?: number | null
  localPurchases?: number | null
  contactReadiness: ContactReadiness
  legalEntities?: LegalEntityRef[]
  activity?: BuyerActivityMetrics
}

export interface PurchaseEvent {
  eventId: string
  buyerId: string
  buyerFamilyId?: string | null
  legalEntityId?: string | null
  buyerName?: string | null
  legalEntityName?: string | null
  address: string
  latitude: number | null
  longitude: number | null
  purchaseDate: string | null
  purchasePrice: number | null
  assetLane: string | null
  distanceMiles: number | null
  source: string | null
  sourceLabel?: string | null
  transactionScope?: TransactionScope
  packageId?: string | null
  packageAssetCount?: number | null
  totalConsideration?: number | null
  propertyAllocatedConsideration?: number | null
  pricingEligible?: boolean
  demandEligible?: boolean
  demandEligibility?: BuyerDemandEligibility
  exclusionReasons?: string[]
  buyerClass?: BuyerClass
  propertySubtype?: string | null
}

export interface InstitutionalPlatform {
  platformId: string
  platformName: string
  parentPlatform: {
    entityId: string | null
    name: string | null
    relationshipConfidence: number | null
    relationshipBasis: string | null
    verified: boolean
  }
  platformType: string
  institutionalSubtype: string | null
  legalEntities: LegalEntityRef[]
  activity: BuyerActivityMetrics
  matchGrade: string | null
  matchScore: number | null
  likelyBidLow: number | null
  likelyBidBase: number | null
  likelyBidHigh: number | null
  strategyProfile: {
    targetAssetTypes: string[]
    targetZips: string[]
    targetMarkets: string[]
    typicalPriceMin: number | null
    typicalPriceMax: number | null
    singleAssetVsPackage: { singleAssetPct: number | null; packagePct: number | null }
    inferred: boolean
  }
}

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
    activeBuyerCount30d?: number | null
    activeBuyerCount90d: number | null
    activeBuyerCount180d: number | null
    institutionalBuyerCount: number | null
    localRegionalBuyerCount?: number | null
    builderBuyerCount?: number | null
    governmentNonMarketCount?: number | null
    unresolvedIdentityCount?: number | null
    repeatBuyerCount: number | null
    verifiedPurchaseEventCount: number | null
    mappedPurchaseEventCount: number | null
    uniquePurchasedAssetCount?: number | null
    packageEventCount?: number | null
    packageAssetCount?: number | null
    qualifiedSingleAssetCount?: number | null
    likelyBidLow: number | null
    likelyBidBase: number | null
    likelyBidHigh: number | null
    liquidityScore: number | null
    demandScore: number | null
    refreshedAt: string | null
    cacheIncomplete?: boolean
    eligibleBuyerFamilies?: number | null
    highFitFamilies?: number | null
    localRegionalFamilies?: number | null
    institutionalPlatforms?: number | null
    builderFamilies?: number | null
    governmentNonMarketFamilies?: number | null
    unresolvedIdentities?: number | null
    uniquePurchaseEvents?: number | null
    uniquePurchasedAssets?: number | null
    geocodedEventCount?: number | null
  }
  buyerFamilies?: unknown[]
  rankedBuyers: RankedBuyer[]
  purchaseEvents: PurchaseEvent[]
  institutionalPlatforms?: InstitutionalPlatform[]
  institutionalActivity: unknown[]
  shortlist: unknown[]
  meta?: {
    cached?: boolean
    query_ms?: number
    model_version?: string | null
    error?: string | null
    geocodedEventCount?: number
    phase4_cache_note?: string
  }
}

export interface BuyerMatchV4ShellState {
  activeTab: BuyerMatchV4Tab
  selectedBuyerId: string | null
  selectedLegalEntityId: string | null
  selectedEventId: string | null
  expandedBuyerIds: string[]
  mapVisible: boolean
  filters: BuyerFilterState
  activityFilters: ActivityFilterState
  shortlistIds: string[]
}

export const INITIAL_FILTER_STATE: BuyerFilterState = {
  grade: 'all',
  directoryMode: 'best_match',
  institutionalOnly: false,
  active90d: false,
  active180d: false,
  contactReady: false,
  exactZip: false,
  sort: 'best_match',
}

export const INITIAL_ACTIVITY_FILTER_STATE: ActivityFilterState = {
  periodDays: 180,
  buyerClass: 'all',
  institutionalOnly: false,
  localRegionalOnly: false,
  singleAssetOnly: false,
  packageOnly: false,
  pricingEligibleOnly: false,
  demandOnly: false,
  nonMarketOnly: false,
  unknownIdentityOnly: false,
  radiusMiles: 3,
  mapStyle: 'satellite',
}

export const INITIAL_SHELL_STATE: BuyerMatchV4ShellState = {
  activeTab: 'MARKET',
  selectedBuyerId: null,
  selectedLegalEntityId: null,
  selectedEventId: null,
  expandedBuyerIds: [],
  mapVisible: false,
  filters: INITIAL_FILTER_STATE,
  activityFilters: INITIAL_ACTIVITY_FILTER_STATE,
  shortlistIds: [],
}

export const PROJECTION_LOAD_TIMEOUT_MS = 20_000

export const TAB_LAYOUT_COLUMNS: Record<BuyerMatchV4Tab, { left: string; main: string; right: string }> = {
  MARKET: { left: '22%', main: '48%', right: '30%' },
  BUYERS: { left: '18%', main: '50%', right: '32%' },
  INSTITUTIONS: { left: '18%', main: '50%', right: '32%' },
  PURCHASE_ACTIVITY: { left: '18%', main: '55%', right: '27%' },
  SHORTLIST: { left: '20%', main: '48%', right: '32%' },
}

export const DIRECTORY_MODE_OPTIONS: Array<{ key: BuyerDirectoryMode; label: string }> = [
  { key: 'best_match', label: 'Best Match' },
  { key: 'local_regional', label: 'Local & Regional' },
  { key: 'institutional', label: 'Institutional' },
  { key: 'builders', label: 'Builders' },
  { key: 'all_eligible', label: 'All Eligible' },
  { key: 'research', label: 'Research / Non-market' },
]

export const TAB_LABELS: Record<BuyerMatchV4Tab, string> = {
  MARKET: 'MARKET',
  BUYERS: 'BUYERS',
  INSTITUTIONS: 'INSTITUTIONS',
  PURCHASE_ACTIVITY: 'PURCHASE ACTIVITY',
  SHORTLIST: 'SHORTLIST',
}