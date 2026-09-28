/**
 * BUYER MATCH — client for /api/cockpit/buyer-match/workspace.
 *
 * One bounded read per (subject, radius, months). The server ranks and
 * explains buyers from observed acquisitions (W8C identity, same buyer_id
 * space as Entity Graph); this client never scores, tiers or re-ranks.
 * Sorting/filtering here only re-orders the server's evidence.
 */
import { callBackend } from '../../lib/api/backendClient'

export type Tier = 'strong' | 'moderate' | 'exploratory' | 'excluded'
export type FitVerdict = 'inside' | 'near' | 'outside' | 'unknown'

export type BuyerEvidence = { k: string; text: string; sub?: string | null }

export type RecentPurchase = {
  txnId: number | null
  propertyId: string | null
  lat: number | null
  lng: number | null
  address: string | null
  city: string | null
  date: string | null
  price: number | null
  family: string | null
  sameFamily: boolean
  beds: number | null
  sqft: number | null
  yearBuilt: number | null
  cash: boolean | null
  miles: number | null
}

export type MatchedBuyer = {
  id: string
  kind: 'company' | 'person'
  name: string | null
  nameWithheld?: boolean
  tier: Tier
  exclusions: Array<{ code: string; label: string }>
  evidence: BuyerEvidence[]
  fit: {
    type: 'dominant' | 'present' | 'absent' | 'unknown'
    price: { verdict: FitVerdict; low?: number; high?: number; direction?: 'above' | 'below' }
    recency: 'active' | 'recent' | 'slowing' | 'stale' | 'unknown'
    size: { verdict: FitVerdict; low?: number; high?: number }
    market: 'strong' | 'present' | 'county' | 'none'
  }
  identity: { tier: 'registry' | 'corroborated' | 'engine' | 'observed'; label: string; method: string | null; registry: boolean; jurisdiction: string | null; aliases: number; confidence: number | null }
  activity: { acquisitions: number; dispositions: number; first: string | null; last: string | null; daysSince: number | null; t90: number; t180: number; t365: number; status: string | null }
  nearby: { purchases: number; sameFamily: number; within1mi: number; sameZip: number; nearestMiles: number | null; last: string | null; medianPrice: number | null; cashShare: number | null } | null
  countyPurchases: number
  buyBox: {
    families: string[]; dominant: string | null
    priceLow: number | null; priceMid: number | null; priceHigh: number | null
    sqftLow: number | null; sqftHigh: number | null; beds: number | null; units: number | null
    cashShare: number | null; markets: string[]; primaryMarket: string | null; topState: string | null; declared: boolean
  }
  behavior: { archetype: string | null; holdFlip: string | null; foreclosureDeeds: number; linkedTransactions: number }
  portfolio: { observed: number; owned: number; sold: number; crossover: boolean }
  recent: RecentPurchase[]
  contact: { state: 'available' | 'company_identity_only' | 'none' | 'suppressed'; label: string }
}

export type BuyerMatchWorkspace = {
  generatedAt: string
  query: { radiusMiles: number; months: number; radiusOptions: number[]; monthOptions: number[] }
  subject: {
    propertyId: string; address: string | null; city: string | null; state: string | null; zip: string | null; county: string | null; market: string | null
    lat: number | null; lng: number | null; family: string; familyLabel: string; propertyType: string | null; units: number | null
    beds: number | null; baths: number | null; sqft: number | null; yearBuilt: number | null
    value: number | null; valueBasis: 'deal_intelligence' | 'avm' | null; offer: number | null; ask: number | null
    stage: string | null; opportunityId: string | null
    window: { low: number; high: number; basis: 'offer_to_value' | 'value_band' } | null
  }
  counts: { matched: number; strong: number; moderate: number; exploratory: number; excluded: number; oneTimeIndividuals: number; exclusions: Record<string, number> }
  market: {
    transactionsInRadius: number; sameTypeTransactionsInRadius: number; buyersInRadius: number; countyBuyersActive24m: number | null
    nearbySimilarBuyers: number; activeLast90: number; matchedPriceBand: { low: number; high: number; buyers: number } | null
  }
  tierRules: Record<'strong' | 'moderate' | 'exploratory', string>
  disposition: { readable: boolean; contacted: number; replied: number; markedInterested: number; offers: number; selectedBuyer: boolean; committed: number; agreementExecuted: number; emdReceived: number }
  contactability: { verified: number; outreachAvailable: boolean; note: string }
  buyers: MatchedBuyer[]
  excluded: MatchedBuyer[]
  lineage: { identity: string; evidence: string; window: string }
}

export async function fetchBuyerMatchWorkspace(params: { propertyId: string; radius?: number; months?: number }, signal?: AbortSignal): Promise<BuyerMatchWorkspace> {
  const qs = new URLSearchParams({ property_id: params.propertyId })
  if (params.radius) qs.set('radius', String(params.radius))
  if (params.months) qs.set('months', String(params.months))
  const res = await callBackend<{ ok: boolean; data: BuyerMatchWorkspace }>(`/api/cockpit/buyer-match/workspace?${qs.toString()}`, { signal })
  if (!res.ok) {
    const upstream = (res as { upstream?: { error?: string } }).upstream
    throw new Error(upstream?.error || res.error || 'buyer_match_workspace_failed')
  }
  if (!res.data?.data) throw new Error('buyer_match_workspace_empty')
  return res.data.data
}

export const money = (n: number | null | undefined): string | null => {
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  const a = Math.abs(n)
  if (a >= 1e6) return `$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 2)}M`
  if (a >= 1e3) return `$${Math.round(a / 1e3)}K`
  return `$${Math.round(a)}`
}

export const ago = (days: number | null | undefined): string | null => {
  if (days === null || days === undefined) return null
  if (days < 1) return 'today'
  if (days < 45) return `${Math.round(days)}d ago`
  if (days < 730) return `${Math.round(days / 30.4)}mo ago`
  return `${(days / 365).toFixed(1)}y ago`
}

export const daysSince = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 86_400_000)) : null
}

/** Operator shortlist — attention only, on this device. Never a buyer-side state. */
const SHORTLIST_KEY = (pid: string) => `bmx:shortlist:v1:${pid}`
export function readShortlist(pid: string): string[] {
  try { const v = JSON.parse(localStorage.getItem(SHORTLIST_KEY(pid)) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] }
}
export function writeShortlist(pid: string, ids: string[]) {
  try { localStorage.setItem(SHORTLIST_KEY(pid), JSON.stringify(ids.slice(0, 50))) } catch { /* storage full or disabled */ }
}
