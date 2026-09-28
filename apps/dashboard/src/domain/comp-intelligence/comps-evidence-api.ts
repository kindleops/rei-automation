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
  weight?: number | null
  adjustedPrice?: number | null
  adjustments?: Array<{ basis: string; weight: number | null; value: number | null; amount: number | null }>
  dims?: Array<{ f: string; c: unknown; st: 'exact_or_near' | 'similar' | 'mismatch' }>
} | null

export type EvidenceComp = {
  key: string
  corpus: 'engine_pool' | 'transaction_corpus'
  compId: string | null
  txnId?: number | null
  propertyId: string | null
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
  mls: boolean
  buyerKind: 'company' | 'person' | null
  buyerCompany: string | null
  buyerId: string | null
  buyerAcquisitions: number | null
  buyerActivity: string | null
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
}

export type SetStats = { count: number; medianPrice: number | null; low: number | null; high: number | null; medianPpsf: number | null; medianPpu: number | null; medianAdjusted: number | null; medianDistance: number | null; medianAgeDays: number | null }

export type CompsWorkspace = {
  generatedAt: string
  query: { radiusMiles: number; months: number; radiusOptions: number[]; monthOptions: number[] }
  subject: {
    propertyId: string; address: string | null; city: string | null; state: string | null; zip: string | null; lat: number | null; lng: number | null
    propertyType: string | null; family: string | null; familyLabel: string | null; units: number | null; beds: number | null; baths: number | null
    sqft: number | null; lotSqft: number | null; yearBuilt: number | null; condition: string | null; estimatedValue: number | null
    mlsStatus: string | null; mlsListPrice: number | null; dimensions: string[]
  }
  counts: { system: number; candidates: number; excluded: number; enginePool: number; transactions: number; transactionsInRadius: number | null; transactionsSameFamily: number | null; transactionsReturned: number | null }
  systemStats: SetStats
  sufficiency: { level: 'strong' | 'moderate' | 'limited' | 'thin'; usable: number; withinMile: number; withinMileLastYear: number }
  conclusion: { valueLow: number | null; valueMid: number | null; valueHigh: number | null; valuationConfidence: number | null; recommendedOffer: number | null; floor: number | null; tier: string | null; computedAt: string | null; ask: number | null } | null
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
