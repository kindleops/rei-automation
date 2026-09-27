/**
 * Entity network client — the relationship network behind one property,
 * owner or person (GET /api/cockpit/entity-graph/network/{type}/{id}), and the
 * largest ownership networks for the landing. Read-only.
 */
import type { PartyRef, PropertyRecords } from '../../../domain/entity-graph/entity-graph-intel-api'
import { callBackend } from '../../../lib/api/backendClient'

export type NetworkNodeType = 'owner' | 'property' | 'entity' | 'person' | 'phone' | 'email' | 'mailing' | 'related_owner' | 'conversation' | 'mortgage' | 'lien' | 'sale' | 'buyer'
export type HolderKind = 'llc' | 'company' | 'trust' | 'estate' | 'institution' | 'individual'

export interface NetworkNode {
  id: string
  type: NetworkNodeType
  label: string
  sub?: string
  meta: Record<string, unknown>
}
export interface NetworkEdge { from: string; to: string; kind: string; label: string }

export interface NetworkProperty {
  id: string
  ownerId: string | null
  address: string
  city: string
  state: string
  zip: string
  county: string
  market: string
  lat: number | null
  lng: number | null
  type: string
  units: number | null
  beds: number | null
  baths: number | null
  sqft: number | null
  yearBuilt: number | null
  lotAcres: number | null
  value: number | null
  equityPct: number | null
  equity: number | null
  loanBalance: number | null
  loanAmount: number | null
  loanPayment: number | null
  ltv: number | null
  freeAndClear: boolean
  activeLien: boolean
  taxAmount: number | null
  taxDelinquent: boolean
  taxDelinquentYear: number | null
  lastSale: { date: string | null; price: number | null; docType: string | null } | null
  ownershipYears: number | null
  repairEstimate: number | null
  streetview: string | null
  tags: string[]
  outOfStateOwner: boolean
  corporateOwner: boolean
}

export interface NetworkSale {
  id: string
  propertyId: string
  address: string | null
  date: string
  price: number | null
  perDoor: number | null
  source: string | null
  buyer: string | null
  buyerClass: string | null
  docType?: string | null
  portfolioSale: boolean
}

export interface EntityNetwork {
  anchor: { type: 'property' | 'owner' | 'person'; id: string; nodeId: string }
  owner: {
    id: string | null
    name: string
    kind: HolderKind
    kindLabel: string
    linked: boolean
    propertyCount: number
    units: number | null
    markets: string[]
    language: string | null
    bestChannel: string | null
    maxOwnershipYears: number | null
    tags: string[]
    portfolio: { value: number | null; equity: number | null; loanBalance: number | null; monthlyPayment: number | null; annualTax: number | null; taxDelinquent: number | null; activeLiens: number | null } | null
  }
  mailing: { address: string; city: string; state: string; zip: string; outOfState: boolean } | null
  properties: NetworkProperty[]
  propertiesTruncated: number
  debt: { properties: number; totalValue: number | null; totalEquity: number | null; totalLoanBalance: number; monthlyPayment: number | null; withDebt: number; freeAndClear: number; activeLiens: number; taxDelinquent: number; blendedLtv: number | null }
  entities: Array<{ id: string; name: string; kind: HolderKind; kindLabel: string; mailing: string | null }>
  people: Array<{ id: string; name: string; role: string; primary: boolean; language: string | null; occupation: string | null; householdIncome: string | null; netAssets: string | null; smsEligible: boolean; bestPhone: string | null; bestEmail: string | null }>
  phones: Array<{ id: string; e164: string; display: string; type: string; personId: string | null; score: number | null; active: string | null; wrongNumber: boolean }>
  emails: Array<{ id: string; value: string; personId: string | null }>
  related: Array<{ id: string; name: string; kind: HolderKind; propertyCount: number; value: number | null; mailing: string | null; reasons: Array<'household' | 'cluster' | 'mailing'> }>
  history: NetworkSale[]
  outreach: {
    threads: Array<{ threadKey: string; propertyId: string | null; personId: string | null; at: string | null; preview: string | null; stage: string | null; hot: boolean; intent: string | null; nextAction: string | null }>
    lastSend: { status: string; at: string; propertyId: string } | null
  }
  graph: { anchorId: string; nodes: NetworkNode[]; edges: NetworkEdge[] }
  /** The anchor property's recorded documents (mortgages, liens, sales + buyer resolution). */
  records?: PropertyRecords | null
  /** The owner's buyer role, when the owner is also a known buyer entity. */
  ownerBuyer?: PartyRef | null
}

export interface TopNetwork {
  id: string
  name: string
  kind: HolderKind
  propertyCount: number
  units: number | null
  value: number | null
  equity: number | null
  loanBalance: number | null
  markets: string[]
}

const cache = new Map<string, { at: number; data: EntityNetwork }>()

export async function fetchEntityNetwork(type: 'property' | 'owner' | 'person', id: string, signal?: AbortSignal): Promise<EntityNetwork | null> {
  const key = `${type}:${id}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.data
  const res = await callBackend<{ ok: boolean; data: EntityNetwork }>(`/api/cockpit/entity-graph/network/${type}/${encodeURIComponent(id)}`, { signal })
  if (!res.ok || !res.data?.data) return null
  cache.set(key, { at: Date.now(), data: res.data.data })
  return res.data.data
}

export async function fetchTopNetworks(market = '', signal?: AbortSignal): Promise<TopNetwork[]> {
  const res = await callBackend<{ ok: boolean; data: TopNetwork[] }>(`/api/cockpit/entity-graph/networks?limit=16${market ? `&market=${encodeURIComponent(market)}` : ''}`, { signal })
  return res.ok && Array.isArray(res.data?.data) ? res.data.data : []
}

// ── formatting ─────────────────────────────────────────────────────────────
export const money = (v: number | null | undefined, digits = 1): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  const sign = v < 0 ? '−' : ''
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(digits)}B`
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(digits)}M`
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}K`
  return `${sign}$${Math.round(a).toLocaleString()}`
}
export const pct = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${Math.round(v)}%`)
export const shortDate = (s: string | null | undefined): string => {
  if (!s) return '—'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? String(s).slice(0, 10) : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}
export const REASON_LABEL: Record<string, string> = { household: 'Same household', cluster: 'Same owner cluster', mailing: 'Same mailing address' }
