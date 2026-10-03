/**
 * COMPS INTELLIGENCE — client for /api/cockpit/comps/workspace.
 *
 * One bounded read per (subject, radius, months). The server judges every
 * candidate with the acquisition engine's own scoring; the System set is the
 * engine's stored pricing set. Everything the operator does here (select,
 * deselect) is an EVIDENCE PREVIEW held in the browser — never written back
 * and never presented as the canonical valuation.
 */
import { callBackend } from '../../lib/api/backendClient'

export type CompState = 'system' | 'candidate' | 'excluded'

export type EngineVerdict = {
  origin: 'stored' | 'live'
  eligible: boolean
  reasons: string[]
  score?: number | null
  confidence?: number | null
  completeness?: number | null
  /** recencyScore() factor; on a stored verdict only when re-scoring reproduced it */
  recency?: number | null
  weight?: number | null
  adjustedPrice?: number | null
  /** engine sale source code: mls_sold | public_record_sold | investor_purchase */
  saleSource?: string | null
  adjustments?: Array<{ basis: string; weight: number | null; value: number | null; amount: number | null }>
  dims?: Array<{ f: string; s?: unknown; c: unknown; st: 'exact_or_near' | 'similar' | 'mismatch' }>
  /** feature-match categories: name, category weight, score, compared / missing feature counts */
  cats?: Array<{ c: string; w: number | null; s: number | null; n: number | null; m: number | null }>
} | null

/** The engine's verdict on a stored system comp TODAY (calendar aging can move its weight). */
export type TodayVerdict = { eligible: boolean; reasons: string[]; weight: number | null; adjustedPrice: number | null; recency: number | null; score?: number | null; completeness?: number | null }

export type EngineRun = {
  engine: string
  version: string | null
  computedAt: string | null
  method: string | null
  formula: string | null
  selectedCount: number | null
  totalWeight: number | null
  dispersion: number | null
  sourceTypes: string[]
  sourceValue: number | null
  components: { depth: number | null; compScore: number | null; completeness: number | null; consistency: number | null; sourceDiversity: number | null }
  pool: { status: string | null; rawCandidates: number | null; eligibleCandidates: number | null; rejectionBreakdown: Record<string, number | null> }
  outlier: { method: string; median: number | null; mad: number | null; allowedDeviation: number | null } | null
}

export type EngineRules = {
  family: string | null
  radiusMiles: number
  months: number
  size: { field: 'sqft' | 'units'; label: string; min: number; max: number; reason: string } | null
  minSalePrice: number
  nominalPriceToValue: number
  minCompScore: number
  maxSelected: number
  pool: { source: string; limit: number }
  outlier: { method: string; minObservations: number; madMultiple: number; floorShareOfMedian: number }
  weight: { formula: string; mlsFactor: number; otherFactor: number }
  /** recencyScore() knots: linear in elapsed months between knots, flat before the first and after the last (RC 7.1). */
  recency: Array<{ months: number; score: number }>
  /** How the engine measures a sale's age for recency. */
  recencyBasis?: { age: string; daysPerMonth: number; interpolation: string; unknownDateScore: number }
  confidence: { formula: string; depthFullAt: number; weights: { depth: number; compScore: number; completeness: number; consistency: number; sourceDiversity: number } }
}

export type EvidenceComp = {
  key: string
  corpus: 'engine_pool' | 'transaction_corpus'
  compId: string | null
  txnId?: number | null
  propertyId: string | null
  /** the comp's property is a tracked (canonical) property; false = a recorded sale only; null/absent = unknown */
  canonicalProperty?: boolean | null
  address: string | null
  city: string | null
  zip: string | null
  lat: number | null
  lng: number | null
  salePrice: number | null
  saleDate: string | null
  distanceMiles: number | null
  propertyType: string | null
  units: number | null
  beds: number | null
  baths: number | null
  sqft: number | null
  lotSqft: number | null
  yearBuilt: number | null
  condition: string | null
  renovation: string | null
  ppsf: number | null
  ppu: number | null
  source: string | null
  /** the sold-comp record's own sale_source ("MLS Sold" | "Public Record Sold" | "Off-Market Sold"); null when not recorded */
  saleSourceRaw?: string | null
  mls: boolean
  buyerKind: 'company' | 'person' | null
  buyerCompany: string | null
  buyerId: string | null
  buyerAcquisitions: number | null
  buyerActivity: string | null
  /** eg_buyer_index.archetype of the resolved buyer (recorded deeds) */
  buyerArchetype?: string | null
  sellerKind: string | null
  armsLength: boolean | null
  cash: boolean | null
  docType: string | null
  photo: string | null
  assetMatch: boolean
  state: CompState
  reasons: Array<{ code: string; label: string }>
  engine: EngineVerdict
  compare: { sqftPct: number | null; beds: number | null; baths: number | null; years: number | null; lotPct: number | null; units: number | null; days: number | null }
  /** stored system comps: the engine's verdict on the same sale today */
  today?: TodayVerdict | null
  /** a stored system comp that lies outside the current search radius / window */
  outsideSearch?: boolean
  /** engine-pool record features (null for recorded deeds) */
  features?: { subdivision: string | null; zoning: string | null; quality: string | null; garage: string | null; pool: string | null; stories: number | null; county: string | null } | null
}

export type SetStats = { count: number; medianPrice: number | null; low: number | null; high: number | null; medianPpsf: number | null; medianPpu: number | null; medianAdjusted: number | null; medianDistance: number | null; medianAgeDays: number | null }

export type CompsWorkspace = {
  generatedAt: string
  query: { radiusMiles: number; months: number; radiusOptions: number[]; monthOptions: number[]; engineWindow?: { radiusMiles: number; months: number; clamped: boolean } }
  subject: {
    propertyId: string; address: string | null; city: string | null; state: string | null; zip: string | null; lat: number | null; lng: number | null
    propertyType: string | null; family: string | null; familyLabel: string | null; units: number | null; beds: number | null; baths: number | null
    sqft: number | null; lotSqft: number | null; yearBuilt: number | null; condition: string | null; estimatedValue: number | null
    mlsStatus: string | null; mlsListPrice: number | null; dimensions: string[]
    county?: string | null; market?: string | null; subdivision?: string | null; zoning?: string | null; quality?: string | null
    garage?: string | null; pool?: string | null; stories?: number | null; assessedValue?: number | null
    /** the property record's market-status label — undated, not a listing feed */
    recordStatus?: string | null
    lastSale?: { date: string; price: number } | null
  }
  counts: { system: number; candidates: number; excluded: number; enginePool: number; transactions: number; transactionsInRadius: number | null; transactionsSameFamily: number | null; transactionsReturned: number | null }
  systemStats: SetStats
  sufficiency: { level: 'strong' | 'moderate' | 'limited' | 'thin'; usable: number; withinMile: number; withinMileLastYear: number }
  conclusion: {
    valueLow: number | null; valueMid: number | null; valueHigh: number | null; valuationConfidence: number | null; recommendedOffer: number | null; floor: number | null; tier: string | null; computedAt: string | null; ask: number | null
    /** weighted_adjusted_comp_value = comp evidence; subject_value_fallback = record estimate ± (no comp qualified) */
    method?: string | null
  } | null
  engineRun?: EngineRun | null
  engineRules?: EngineRules | null
  market: { zip: string; family: string; windowDays: number | null; asOf: string; sales: number | null; medianPrice: number | null; p25: number | null; p75: number | null; medianPpsf: number | null; medianPpu: number | null; cashShare: number | null; armsLengthShare: number | null; corporateBuyerShare: number | null; repeatBuyerShare: number | null; recencyDaysMedian: number | null; admissible: boolean } | null
  comps: EvidenceComp[]
}

export async function fetchCompsWorkspace(params: { propertyId: string; radius?: number; months?: number }, signal?: AbortSignal): Promise<CompsWorkspace> {
  const qs = new URLSearchParams({ property_id: params.propertyId })
  if (params.radius) qs.set('radius', String(params.radius))
  if (params.months) qs.set('months', String(params.months))
  const res = await callBackend<{ ok: boolean; data: CompsWorkspace }>(`/api/cockpit/comps/workspace?${qs.toString()}`, { signal })
  if (!res.ok) {
    const upstream = (res as { upstream?: { error?: string } }).upstream
    throw new Error(upstream?.error || res.error || 'comps_workspace_failed')
  }
  if (!res.data?.data) throw new Error('comps_workspace_empty')
  return res.data.data
}

const median = (xs: number[]) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/** Same arithmetic as the server's setStats — evidence summary, not valuation. */
export function statsFor(comps: EvidenceComp[], now = Date.now()): SetStats {
  const prices = comps.map((c) => c.salePrice ?? 0).filter((v) => v > 0)
  const ppsf = comps.map((c) => c.ppsf ?? 0).filter((v) => v > 0)
  const ppu = comps.map((c) => c.ppu ?? 0).filter((v) => v > 0)
  const adj = comps.map((c) => c.engine?.adjustedPrice ?? 0).filter((v) => v > 0)
  const dist = comps.map((c) => c.distanceMiles).filter((v): v is number => v !== null)
  const age = comps.map((c) => (c.saleDate ? (now - Date.parse(c.saleDate)) / 86_400_000 : NaN)).filter((v) => Number.isFinite(v))
  const r = (v: number | null, d = 0) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d)
  return {
    count: comps.length,
    medianPrice: median(prices),
    low: prices.length ? Math.min(...prices) : null,
    high: prices.length ? Math.max(...prices) : null,
    medianPpsf: r(median(ppsf)),
    medianPpu: r(median(ppu)),
    medianAdjusted: median(adj) === null ? null : Math.round((median(adj) as number) / 100) * 100,
    medianDistance: r(median(dist), 2),
    medianAgeDays: r(median(age)),
  }
}

export const money = (n: number | null | undefined, exact = false): string | null => {
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  const a = Math.abs(n)
  const sign = n < 0 ? '−' : ''
  if (exact) return `${sign}$${Math.round(a).toLocaleString('en-US')}`
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 2)}M`
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}K`
  return `${sign}$${Math.round(a)}`
}

export const ageLabel = (days: number | null | undefined): string | null => {
  if (days === null || days === undefined) return null
  if (days < 45) return `${Math.round(days)}d`
  if (days < 730) return `${Math.round(days / 30.4)}mo`
  return `${(days / 365).toFixed(1)}y`
}
