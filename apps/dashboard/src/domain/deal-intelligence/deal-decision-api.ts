/**
 * DEAL DECISION — client for /api/cockpit/deal-intelligence/decision.
 *
 * Read-only. The server assembles the canonical engine projection, its
 * immutable lineage, recorded debt/liens/sales, seller facts (with
 * provenance) and binding offers. The UI renders it; it never re-derives a
 * valuation, never writes, and never turns a recommendation into an offer.
 */
import { callBackend } from '../../lib/api/backendClient'

export type Provenance = 'seller' | 'record' | 'system'
export type Severity = 'critical' | 'high' | 'medium' | 'low'

export type SpectrumMarker = { key: string; label: string; value: number; source: string; at: number | null; clamped: boolean }
export type ValuationSpectrum = {
  min: number
  max: number
  band: { low: number; mid: number | null; high: number; from: number | null; to: number | null; at: number | null } | null
  comps: { low: number; high: number; from: number | null; to: number | null } | null
  markers: SpectrumMarker[]
}

export type ScenarioInputs = {
  valuation_mid: number
  valuation_confidence: number
  repairs: number
  max_arv_factor: number
  behavior_ceiling: number | null
  buyer_ceiling_authoritative: boolean
  asset_family: string
  unit_count: number | null
  buyer_demand_score: number
  liquidity_score: number
  minimum_margin_floor: number
  motivation_score: number
}

export type ScenarioResult = {
  valuation_ceiling: number | null
  effective_ceiling: number | null
  ceiling_basis: string
  target_margin: number
  protected_margin: number
  margin_pct: number
  recommended_offer: number
  minimum_offer: number
  expected_fee: number
  protected_margin_enforced: boolean
  terms: { confidence_haircut_pct: number; motivation_discount_pct: number; demand_premium_pct: number }
}

export type DealComp = {
  id: string | null; propertyId: string | null; address: string | null; salePrice: number | null; adjustedValue: number | null
  saleDate: string | null; distanceMiles: number | null; score: number | null; weight: number | null; confidence: number | null
  source: string | null; completeness: number | null; mismatches: Array<{ feature: string; subject: unknown; comp: unknown }>
  propertyType: string | null; assetClass: string | null; family: string; assetMatch: boolean
  beds: number | null; baths: number | null; sqft: number | null; lotSqft: number | null; units: number | null
  yearBuilt: number | null; effectiveYear: number | null; condition: string | null; quality: string | null; construction: string | null
  renovation: string | null; stories: string | null; pool: string | null; ppsf: number | null; ppu: number | null
  saleSource: string | null; mlsSoldPrice: number | null; avmAtSale: number | null
  buyerKind: 'company' | 'individual' | 'unknown'; buyerLabel: string | null; photo: string | null
  /** the comp's property is a tracked (canonical) property; false = a recorded sale only; null/absent = unknown */
  canonicalProperty?: boolean | null
}

export type ConversationSignal = {
  version: string
  counts: { inbound: number; substantiveInbound: number; distinctInbound: number; repeatedInbound: number; reactions: number; autoReplies: number; outbound: number; inboundWords: number; avgWordsPerInbound: number | null; questionsAsked: number; daysActive: number }
  responsiveness: { medianReplyMinutes: number | null; fastestReplyMinutes: number | null; replyRate: number | null; touches: number; lastInboundAt: string | null; lastOutboundAt: string | null; silenceDays: number | null; awaitingUs: boolean; trend: 'accelerating' | 'steady' | 'cooling' | null }
  timing: { hourBuckets: number[]; share: { morning: number; workday: number; evening: number; lateNight: number }; weekendShare: number | null; timezone: string | null; timezoneSource: 'seller' | 'utc_fallback' }
  language: { profanity: number; hostility: number; urgency: number; distress: { financial: number; legal: number; life_event: number; property_burden: number }; priceMentions: number[]; positive: number; negative: number; optOut: number; wrongNumber: number; notOwner: number }
  intents: Record<string, number>
  score: number | null
  rawScore: number | null
  band: 'hot' | 'warm' | 'engaged' | 'lukewarm' | 'cold' | 'hostile' | 'opted_out' | 'no_reply'
  factors: Array<{ key: string; label: string; value: string; points: number; cap?: number; evidence?: { quote: string; at: string } }>
  confidence: 'low' | 'medium' | 'high'
}

type MarketGroup = { count: number; priced: number; medianPrice: number | null; medianPpsf: number | null; medianPpu?: number | null }
export type MarketDemand = {
  ok: boolean
  error?: string
  subject: { family: string; familyLabel: string; propertyType: string | null; units: number | null; sqft: number | null; estimatedValue: number | null; zip: string | null; city: string | null; state: string | null }
  radius: { requested: number; used: number; widened: boolean; minSalesTarget: number }
  unitsBand: { applied: boolean; min: number | null; max: number | null }
  window: { months: number; since: string; until: string; dataThrough: string | null; dataAgeDays: number | null }
  totals: { sales: number; pricedSales: number; unpricedSales: number; excludedOutliers: number; excludedByReason: Array<{ reason: string; label: string; count: number }> }
  overall: { medianPrice: number | null; avgPrice: number | null; p25Price: number | null; p75Price: number | null; medianPpsf: number | null; ppsfSample: number | null; medianPpu: number | null; ppuSample: number | null; medianBeds: number | null; medianSqft: number | null; medianUnits: number | null; medianYearBuilt: number | null; medianDistanceMiles: number | null; buyerKnownShare: number | null; portfolioDoors: number | null; portfolioTransactions: number | null; latestSaleOn: string | null; earliestSaleOn: string | null }
  bySource: Array<{ source: string; label: string; count: number; priced: number; share: number; medianPrice: number | null; medianPpsf: number | null }>
  byBuyer: Array<{ group: string; label: string; count: number; priced: number; share: number; medianPrice: number | null; medianPpsf: number | null; outOfStateShare: number | null }>
  investorVsRetail: { investor: MarketGroup; retail: MarketGroup; nonInvestor: MarketGroup; unclassifiedCount: number; nonMarketCount: number; minSample: number; discountPct: number | null; ppsfDiscountPct: number | null; discountVsNonInvestorPct: number | null; definitions?: Record<string, string> }
  trend: Array<{ quarter: string; quarterStart: string; count: number; priced: number; medianPrice: number | null; medianPpsf: number | null; investorCount: number }>
  zips: Array<{ zip: string; count: number; priced: number; medianPrice: number | null; medianPpsf: number | null; isSubjectZip: boolean }>
}

export type CompBuyerMix = { total: number; company: number; individual: number; unknown: number; companyMedian: number | null; individualMedian: number | null; mls: number; publicRecord: number; mlsMedian: number | null; publicRecordMedian: number | null; companyPpsf: number | null; individualPpsf: number | null }

export type RecordSection = { title: string; fields: Array<{ label: string; value: string }> }

export type DealRisk = { key: string; severity: Severity; title: string; detail: string | null; source: string }
export type SellerFact = { key: string; label: string; value: unknown; display: string | null; provenance: Provenance; source: string; at?: string | null; quote?: string | null; confidence?: number | null }

export type DealDecision = {
  generatedAt: string
  subject: {
    propertyId: string
    address: string | null
    city: string | null
    state: string | null
    zip: string | null
    market: string | null
    propertyType: string | null
    units: number | null
    beds: number | null
    baths: number | null
    sqft: number | null
    yearBuilt: number | null
    lat: number | null
    lng: number | null
    mls: { listPrice: number | null; status: string | null; soldPrice: number | null; soldAt: string | null } | null
    isCanary: boolean
  }
  pipeline: { opportunityId: string; stage: string | null; stageLabel: string | null; status: string | null; threadKey: string | null; lastActivityAt: string | null; stageEnteredAt: string | null } | null
  decision:
    | { status: 'not_run' }
    | {
        status: 'available'
        tier: string | null
        tierLabel: string | null
        tierTone: 'go' | 'hold' | 'alt' | 'wait' | 'stop'
        tierReasons: string[]
        gates: Array<{ key: string; label: string; pass: boolean }>
        aos: number | null
        confidence: number | null
        valuationConfidence: number | null
        confidenceBreakdown: { formula: string | null; valuation: number | null; subject: number | null; buyer: number | null; finance: number | null; missing: string[] } | null
        bestStrategy: string | null
        bestStrategyLabel: string | null
        leadWith: string | null
        conversationAngle: string | null
        why: string | null
        computedAt: string | null
        ageDays: number | null
        summary: string[]
        authorization: {
          presentable: boolean | null
          withheldReason: string | null
          withheldText: string | null
          economicFit: string | null
          zone: string | null
          band: string | null
          authorizedFloor: number | null
          authorizedCeiling: number | null
          directPurchaseMax: number | null
          remainingMovement: number | null
          strategy: string | null
          nextMove: string | null
        } | null
      }
  valuation: { low: number | null; mid: number | null; high: number | null; confidence: number | null; avm: number | null; compLow: number | null; compHigh: number | null; spectrum: ValuationSpectrum | null } | null
  offer: {
    recommended: number | null
    floor: number | null
    expectedFee: number | null
    valuationCeiling: number | null
    behaviorCeiling: number | null
    effectiveCeiling: number | null
    ceilingBasis: string | null
    buyerCeilingAuthoritative: boolean
    buyerCeilingReasons: string[]
    targetMargin: number | null
    protectedMargin: number | null
    marginPct: number | null
    marginPolicy: string | null
    repairs: { amount: number | null; source: string | null; confidence: number | null }
    maxArvFactor: number | null
    terms: { confidenceHaircutPct: number | null; motivationDiscountPct: number | null; demandPremiumPct: number | null }
    protectedMarginEnforced: boolean
    method: string | null
    negotiation: { ask: number | null; initialAsk: number | null; currentOffer: number | null; counter: number | null; lowestIndication: number | null; sellerNet: number | null; concessions: number | null }
    offers: Array<{ id: string; version: number | null; direction: string | null; price: number | null; status: string | null; strategy: string | null; snapshotId: string | null; sentAt: string | null; acceptedAt: string | null; supersededAt: string | null }>
    /** Every number quoted to the seller (negotiation_quotes). Anchors are NOT offers. Absent on older APIs. */
    quotes?: {
      status: 'captured' | 'not_captured'
      anchors: Array<{ amount: number | null; maxOffer: number | null; rule: string | null; language: string | null; templateId: string | null; quotedAt: string; compIds: string[]; snapshotId: string | null; label: string }>
      formalOffers: Array<{ amount: number | null; offerId: string | null; quotedAt: string; label: string }>
      confirmations?: Array<{ quotedAt: string; label: string }>
    }
    /** §82 Negotiation v3 desk — present only when NEGOTIATION_ENGINE_V3 is on server-side. Operator-only. */
    negotiationV3?: NegotiationV3Desk | null
    binding: boolean
    lineage: { snapshotId: string | null; negotiationSnapshotId: string | null; negotiationUsesLatest: boolean | null }
  } | null
  sellerFacts: SellerFact[]
  comps: {
    status: string
    message: string | null
    raw: number | null
    eligible: number | null
    selected: number
    rejected: number | null
    rejectionBreakdown: Array<{ reason: string; label: string; count: number }>
    dispersion: number | null
    avgDistanceMiles: number | null
    medianAgeMonths: number | null
    sources: Record<string, number>
    avgScore: number | null
    completeness: number | null
    adjustedLow: number | null
    adjustedHigh: number | null
    top: DealComp[]
    buyerMix: CompBuyerMix | null
    assetIntegrity: { subjectType: string | null; subjectUnits: number | null; total: number; matched: number; unknown: number; mismatched: Array<{ address: string | null; propertyType: string | null; units: number | null }>; types: Array<{ type: string; count: number }> } | null
    anchor: { address: string; salePrice: number | null; saleDate: string | null; statement: string | null; disclosed: boolean } | null
  } | null
  economics: {
    avm: number | null
    avmRange: { low: number; high: number; confidence: number | null } | null
    equityEstimate: number | null
    equityPercent: number | null
    debt: {
      estOpenBalance: number | null
      openMortgageCount: number | null
      monthlyPayment: number | null
      originalTotal: number | null
      mortgages: Array<{ position: number | null; lender: string | null; type: string | null; amount: number | null; estBalance: number | null; rate: number | null; payment: number | null; recordedAt: string | null; dueAt: string | null }>
      unknownBalances: number
    }
    liens: Array<{ type: string | null; holder: string | null; amount: number | null; at: string | null }>
    foreclosure: { status: string | null; docType?: string | null; defaultAt?: string | null; auctionAt: string | null; recordedAt?: string | null } | null
    tax: { annual: number | null; year: number | null; delinquent: boolean; delinquentYear: number | null }
    atOffer: { offer: number; ceilingSpread: number | null; debtCovered: boolean | null } | null
  }
  conversation: ConversationSignal | null
  market: MarketDemand | null
  record: {
    sections: RecordSection[]
    owner: { name: string | null; sections: RecordSection[] } | null
    prospects: Array<{ id: string; name: string; primary: boolean; fields: Array<{ label: string; value: string }> }>
  }
  history: Array<{ at: string; kind: 'sale' | 'mortgage' | 'lien' | 'foreclosure' | 'ask' | 'analysis' | 'offer'; title: string; amount: number | null; detail: string | null }>
  valuationHistory: Array<{ at: string; low: number | null; mid: number | null; high: number | null; offer: number | null; tier: string | null; comps: number | null }>
  strategies: Array<{ key: string; label: string; score: number | null; isBest: boolean; points: Array<{ reason: string; points: number | null }>; detail: string | null }>
  risks: DealRisk[]
  buyers: { candidates: number; grades: Record<string, number>; types: Array<{ type: string; count: number }>; medianDispo: number | null; topScore: number | null; packagesSent: number; interested: number; selected: boolean } | null
  actuals: { status: string; contractPrice: number | null; buyerPrice: number | null; assignmentFee: number | null; netRevenue: number | null; confirmedRevenue: number | null; closedAt: string; evidence: string[] } | null
  scenario: { replayable: boolean; reason: string | null; delta: number | null; inputs: ScenarioInputs | null; current: ScenarioResult | null; sensitivity: Array<{ key: string; label: string; offer: number; delta: number }> } | null
  lineage: { engine: string; engineVersion: string | null; policyVersion: string | null; computedAt: string | null; snapshotCount: number; latestSnapshotAt: string | null; snapshotMatchesProjection: boolean | null }
}

export type DealDecisionSubject = { propertyId?: string | null; threadKey?: string | null; opportunityId?: string | null }

export async function fetchDealDecision(subject: DealDecisionSubject, signal?: AbortSignal): Promise<DealDecision> {
  const qs = new URLSearchParams()
  if (subject.propertyId) qs.set('property_id', subject.propertyId)
  if (subject.threadKey) qs.set('thread_key', subject.threadKey)
  if (subject.opportunityId) qs.set('opportunity_id', subject.opportunityId)
  const res = await callBackend<{ ok: boolean; data: DealDecision }>(`/api/cockpit/deal-intelligence/decision?${qs.toString()}`, { signal })
  if (!res.ok) {
    const upstream = (res as { upstream?: { error?: string } }).upstream
    throw new Error(upstream?.error || res.error || 'deal_decision_failed')
  }
  if (!res.data?.data) throw new Error('deal_decision_empty')
  return res.data.data
}

export function money(n: number | null | undefined, opts: { exact?: boolean } = {}): string | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  const a = Math.abs(n)
  const sign = n < 0 ? '−' : ''
  if (opts.exact) return `${sign}$${Math.round(a).toLocaleString('en-US')}`
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 2)}M`
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}K`
  return `${sign}$${Math.round(a)}`
}

export function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function ago(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const d = Math.floor((now - t) / 86_400_000)
  if (d < 1) return 'today'
  if (d < 30) return `${d}d ago`
  if (d < 365) return `${Math.floor(d / 30)}mo ago`
  return `${(d / 365).toFixed(1)}y ago`
}

/** Negotiation Engine v3 operator view (apps/api negotiation-v3/view.js). Never seller-facing. */
export interface NegotiationV3Desk {
  status: 'authorized' | 'no_autonomous_money'
  asset: 'sfr' | 'multifamily' | 'unknown'
  ask: number | null
  anchor: number | null
  currentPosition: { amount: number | null; type: string; quoted_at: string } | null
  quotesCaptured: boolean
  target: number | null
  autonomousLimit: number | null
  ceiling: number | null
  fairFloor: number | null
  perUnit: { units: number; unit_source: string | null; ceiling: number | null; target: number | null; anchor: number | null; autonomous_limit: number | null; fair_floor: number | null } | null
  ladder: Array<{ step: number; kind: 'anchor' | 'concession' | 'final_autonomous'; amount: number }>
  authority: { source: string | null; engine_version: string | null; computed_at: string | null; decision_tier: string | null; fresh: boolean; ok: boolean; reasons: string[] }
  engineReference: { recommended: number | null; ceiling: number | null; valuation_mid: number | null } | null
  strategy: { situation: string | null; angle: string | null; creativeProbe: boolean }
  nextMove: { action: 'QUOTE' | 'HOLD' | 'HUMAN' | 'CLOSE_UNREALISTIC' | 'NO_NUMBER'; amount: number | null; proposal: number | null; quoteType: string | null; rule: string }
  why: string[]
  version: string
  configVersion: string
}
