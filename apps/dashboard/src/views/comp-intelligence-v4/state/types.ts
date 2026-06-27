/**
 * Comp Intelligence V4 — view-model contracts.
 *
 * These are the typed shapes the V4 presentation layer consumes. They are
 * produced exclusively by `adapters/projectionAdapter.ts` from the canonical
 * read-only server projection (`CompIntelligencePayload`). The presentation
 * layer never reads the raw payload directly and never recomputes valuation.
 *
 * No `any`. Every field is explicitly typed.
 */

/**
 * The single canonical evidence state. One transaction → exactly one of these.
 *
 * Authority rule (Phase 2): `qualified` may ONLY originate from the canonical
 * Acquisition Engine V3 transaction pipeline. The frontend never promotes a
 * record to `qualified`; in the absence of canonical V3 qualification the best
 * a record can be is `candidate`, and the defensive gates only ever DEMOTE
 * (candidate → review / excluded / demand_only).
 */
export type EvidenceState = 'qualified' | 'review' | 'excluded' | 'demand_only' | 'candidate'

/** Source category, already translated to product language. */
export type EvidenceSourceKind =
  | 'mls'
  | 'public_record'
  | 'buyer_purchase_event'
  | 'unknown'

export interface LatLng {
  lat: number
  lng: number
}

/** Plain-language match quality tier derived from the similarity / score. */
export type MatchTier = 'exact' | 'strong' | 'close' | 'loose' | 'unknown'

export interface V4Subject {
  propertyId: string
  opportunityId: string | null
  threadKey: string | null
  masterOwnerId: string | null
  address: string | null
  coord: LatLng | null
  hasCoord: boolean
  coordSource: string | null
  coordConfidence: number | null
  isResolved: boolean
  isMarketFallback: boolean
  coordFailureReason: string | null
  assetLane: string | null
  assetLaneLabel: string | null
  propertySubtype: string | null
  units: number | null
  beds: number | null
  baths: number | null
  buildingSqft: number | null
  lotSqft: number | null
  lotAcreage: number | null
  yearBuilt: number | null
  condition: string | null
  constructionType: string | null
  zoning: string | null
  /** Property/Street-View media for the subject hero (approved infra). */
  imageUrl: string | null
  /** Labelled value estimates — never a single generic "ARV". */
  providerEstimate: number | null
  taxAssessedValue: number | null
  lastSalePrice: number | null
  lastSaleDate: string | null
  ownerName: string | null
  ownerType: string | null
  dataFreshness: string | null
}

export interface V4SubjectComparison {
  /** e.g. "Sq Ft", "Lot", "Year", "Beds" */
  attribute: string
  subject: string
  comp: string
  difference: string | null
  /** Exact | Close | Material | Unknown */
  assessment: 'exact' | 'close' | 'material' | 'unknown'
}

/** Authority that produced this record's canonical state. */
export type StateAuthority = 'canonical_v3' | 'frontend_defensive' | 'unknown'

/** Plain-language transaction badge derived from evidence (Section: transaction intel). */
export interface TransactionBadge {
  label: string
  tone: 'qualified' | 'review' | 'excluded' | 'demand' | 'neutral' | 'institutional'
}

/** Explicit per-record qualification reasoning (Phase 7 dossier basis). */
export interface QualificationBasis {
  /** Final state's single precise reason — replaces "Loose comp". */
  reason: string
  authority: StateAuthority
  pricingEligible: boolean | null
  singleAssetEligible: boolean | null
  assetLaneCompatible: boolean | null
  evidenceUniverse: string | null
  evidenceRole: string | null
  packageStatus: string | null
  outlierStatus: string | null
  /** 0..1 share of decision-relevant physical fields present. */
  physicalCompleteness: number | null
  essContribution: number | null
}

export interface V4Evidence {
  /** Stable id for selection / dedupe. */
  id: string
  propertyId: string | null
  state: EvidenceState
  /** Raw qualification status, kept for tooltips/advanced view only. */
  rawStatus: string | null
  /** Property/Street-View media URL (server-signed or approved infra). */
  imageUrl: string | null
  address: string | null
  city: string | null
  state_region: string | null
  zip: string | null
  coord: LatLng | null
  distanceMiles: number | null
  // transaction
  salePrice: number | null
  saleDate: string | null
  ppsf: number | null
  ppu: number | null
  sourceKind: EvidenceSourceKind
  sourceLabel: string | null
  transactionBadges: TransactionBadge[]
  // property facts
  assetLane: string | null
  propertySubtype: string | null
  propertyType: string | null
  units: number | null
  beds: number | null
  baths: number | null
  buildingSqft: number | null
  lotSqft: number | null
  yearBuilt: number | null
  condition: string | null
  constructionType: string | null
  providerEstimate: number | null
  /** True when the address carries a unit/apt designator (#, Apt, Unit). */
  isUnitAddress: boolean
  // buyer / grantee (present mainly on the V3 path)
  buyerName: string | null
  buyerEntityType: string | null
  buyerArchetype: string | null
  // match intelligence
  matchScore: number | null
  matchTier: MatchTier
  matchLabel: string | null
  // why this state
  reasons: string[]
  basis: QualificationBasis
  dataFreshness: string | null
}

export interface V4MarketSummary {
  discovered: number
  candidate: number
  qualified: number
  review: number
  excluded: number
  demandOnly: number
  /**
   * Whether canonical V3 qualification produced any qualified pricing comps.
   * When false, the workspace shows "No qualified pricing comps" and NEVER
   * manufactures a median/range (Phase 6).
   */
  hasQualified: boolean
  /** qualified-only stats (computed strictly from `qualified` records) */
  qualifiedMedianSale: number | null
  qualifiedSaleLow: number | null
  qualifiedSaleHigh: number | null
  qualifiedMedianPpsf: number | null
  qualifiedEss: number | null
  closestQualifiedMiles: number | null
  newestQualifiedDate: string | null
  /** raw discovered-sale range — secondary context only, never the headline */
  discoveredSaleLow: number | null
  discoveredSaleHigh: number | null
  /** largest excluded transaction + why (Phase 9 reporting) */
  largestExcludedSale: number | null
  largestExcludedReason: string | null
}

/** Compact, plain-language Acquisition Decision Engine V3 ribbon. */
export interface V4DecisionRibbon {
  available: boolean
  v3Enabled: boolean
  assetLaneLabel: string | null
  executionLabel: string | null
  valueClassificationLabel: string | null
  qualifiedMarketValue: number | null
  conservativeBuyerExit: number | null
  recommendedShadowOffer: number | null
  primaryStrategyLabel: string | null
  confidence: number | null
  qualifiedEvidenceCount: number
  largestBlocker: string | null
  /** One restrained line when V3 is unavailable. */
  unavailableNote: string | null
}

export interface V4Model {
  subject: V4Subject
  evidence: V4Evidence[]
  summary: V4MarketSummary
  decision: V4DecisionRibbon
  search: {
    radiusMiles: number
    monthsBack: number
    searchMode: string | null
    isMarketFallback: boolean
  }
  meta: {
    readOnly: boolean
    queryMs: number | null
    source: 'live' | 'fixture'
  }
}

export type V4FetchStatus = 'idle' | 'loading' | 'refreshing' | 'ready' | 'error'

export interface V4LoadState {
  status: V4FetchStatus
  model: V4Model | null
  error: string | null
}
