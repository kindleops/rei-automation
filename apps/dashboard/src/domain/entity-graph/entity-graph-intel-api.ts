/**
 * ENTITY GRAPH INTELLIGENCE — records, buyers, composition, cohort ids.
 *
 * Every call goes through the authenticated cockpit API. The buyer layer is a
 * service-role read model over comp_private; nothing here touches it directly.
 *
 * Evidence tiers (rendered, never hidden):
 *   resolved  registry number / engine link ≥ 0.95 / individual key
 *   observed  exact normalized-name match on an unambiguous alias
 *   inferred  engine link below 0.95
 */
import * as backendClient from '../../lib/api/backendClient'
import type { EntityGraphFieldFilter } from './entity-graph-field-filters'

export type EvidenceTier = 'resolved' | 'observed' | 'inferred'

export type PartyRef = {
  id: string
  name: string | null
  kind: 'company' | 'person' | null
  basis: 'registry' | 'link' | 'name' | 'individual_key' | null
  method?: string | null
  confidence?: number | null
  purchases?: number | null
  sold?: number | null
  owned?: number | null
  status?: string | null
  archetype?: string | null
  lastPurchase?: string | null
  market?: string | null
  crossover?: boolean
}

export type MortgageRecord = {
  slot: string
  open: boolean
  position: number | null
  lender: string | null
  amount: number | null
  balance: number | null
  payment: number | null
  rate: number | null
  loanType: string | null
  financing: string | null
  recorded: string | null
  due: string | null
  termMonths: number | null
  privateLender: boolean
}

export type LienRecord = {
  id: string
  label: string
  category: string | null
  type: string | null
  title: string | null
  description: string | null
  amountDue: number | null
  recorded: string | null
  party1: string | null
  party2: string | null
  hoaName: string | null
  defaultAmount: number | null
  dateOfDeath: string | null
  taxPeriod: [string, string | null] | null
  county: string | null
  distress: boolean
  /** Recorded-document class (lien, judgment, lis_pendens, ucc, probate, death, …); absent on older APIs. */
  docClass?: string
  /** Only the lien / judgment classes are liens. Absent on older APIs (treat by category). */
  isLien?: boolean
}

export type SaleRecord = {
  id: string
  date: string | null
  price: number | null
  docType: string | null
  buyerName: string | null
  buyer2Name: string | null
  sellerName: string | null
  seller2Name: string | null
  cash: boolean | null
  armsLength: boolean | null
  priceNote: string | null
  lender: string | null
  loanAmount: number | null
  current: boolean
  buyer: PartyRef | null
  seller: PartyRef | null
}

export type ForeclosureRecord = {
  stage: string | null
  recorded: string | null
  defaultDate: string | null
  auctionDate: string | null
  auctionTime: string | null
  auctionLocation: string | null
  caseNumber: string | null
  unpaidBalance: number | null
  minBid: number | null
  lender: string | null
  originalLoan: number | null
  trustee: string | null
  trusteePhone: string | null
  borrower: string | null
}

export type PropertyRecords = {
  mortgages: MortgageRecord[]
  liens: LienRecord[]
  sales: SaleRecord[]
  foreclosures: ForeclosureRecord[]
  ownerBuyer: PartyRef | null
  parcel: Record<string, unknown> | null
  totals: {
    openMortgages: number
    balance: number | null
    payment: number | null
    /** True liens (lien + judgment classes). */
    liens: number
    /** Every other recorded non-mortgage document (absent on older APIs). */
    filings?: number
    distressLiens: number
    sales: number
  }
}

export type Share = { key: string; label: string; count: number; share: number | null }

export type BuyerTransaction = {
  id: number | string
  date: string | null
  price: number | null
  docType: string | null
  seller?: string | null
  buyer?: string | null
  cash?: boolean | null
  armsLength?: boolean | null
  lender?: string | null
  loanAmount?: number | null
  propertyId: string | null
  inUniverse?: boolean
  address: string | null
  city?: string | null
  state?: string | null
  lat?: number | null
  lng?: number | null
  propertyType?: string | null
  evidence: { basis: string; method?: string | null; confidence?: number | null; tier: EvidenceTier }
}

export type BuyerProfile = {
  id: string
  kind: 'company' | 'person'
  name: string
  nameWithheld: boolean
  identity: {
    grade: string | null
    confidence: number | null
    method: string | null
    jurisdiction: string | null
    companyNumber: string | null
    aliasCount: number | null
    modelAsOf: string | null
  }
  registry: {
    company_name?: string
    company_number?: string
    jurisdiction?: string
    status?: string
    inactive?: boolean
    incorporated?: string
    dissolved?: string
    address?: string
    city?: string
    state?: string
    zip?: string
    registry_url?: string
  } | null
  aliases: Array<{ name: string; forms: string[]; canonical: boolean; provisional: boolean; grade: number | null }>
  roles: {
    purchases: number
    dispositions: number
    sold: number
    owned: number
    ownedRegistry: number
    portfolio: number
    portfolioValue: number | null
    linkedSales: number
    crossover: boolean
  }
  activity: {
    status: string | null
    score: number | null
    first: string | null
    last: string | null
    daysSinceLast: number | null
    trailing90: number | null
    trailing180: number | null
    trailing365: number | null
    perYear: number | null
    components: Record<string, number> | null
    byYear: Array<{ year: number; count: number; volume: number | null }>
  }
  behavior: {
    archetype: string | null
    archetypeReasons: string[]
    holdFlip: string | null
    medianHoldDays: number | null
    evidenceCount: number | null
    confidence: number | null
  }
  geography: {
    usable: boolean
    states: Share[]
    counties: Share[]
    cities: Share[]
    zips: Share[]
    primaryMarkets: string[]
    concentration: number | null
  }
  assets: { families: Share[]; dominant: string | null }
  price: {
    p10: number | null
    p25: number | null
    p50: number | null
    p75: number | null
    p90: number | null
    recentMedian: number | null
    recentCount: number | null
    cashShare: number | null
    armsLengthShare: number | null
  }
  buybox: {
    counties: string[]
    states: string[]
    families: string[]
    priceLow: number | null
    priceHigh: number | null
    sqftLow: number | null
    sqftHigh: number | null
    unitsLow: number | null
    unitsHigh: number | null
    evidenceDepth: number | null
    confidence: number | null
  } | null
  network: Array<{
    other: { id: string; name: string; kind: string | null; purchases: number | null } | null
    direction: 'officer_of' | 'officer'
    role: string | null
    confidence: number | null
    basis: string | null
  }>
  purchases: BuyerTransaction[]
  dispositions: BuyerTransaction[]
  owned: Array<{
    propertyId: string
    address: string | null
    value: number | null
    equityPercent: number | null
    propertyType: string | null
    market: string | null
    lat: number | null
    lng: number | null
    evidence: { basis: string; tier: EvidenceTier }
  }>
  portfolio: Array<{
    propertyId: string
    address: string | null
    value: number | null
    equity: number | null
    propertyType: string | null
    lat: number | null
    lng: number | null
    attribution: string | null
  }>
}

export type CompositionBucket = {
  key: string
  label: string
  value: number | null
  share: number | null
  filter: EntityGraphFieldFilter | null
}

export type Composition = {
  tab: string
  supported: boolean
  dimension: { key: string; label: string; group: string; kind: 'top' | 'banded' | 'signals'; format: string | null } | null
  total: number | null
  additive: boolean
  note: string | null
  buckets: CompositionBucket[]
}

export type CompositionDimension = { key: string; label: string; group: string; kind: 'top' | 'banded' | 'signals'; format: string | null }

const buyerCache = new Map<string, { at: number; data: BuyerProfile }>()
const BUYER_TTL = 120_000

function qs(params: Record<string, string | number | undefined | null>): string {
  const out = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    out.set(key, String(value))
  }
  return out.toString()
}

export async function fetchBuyerProfile(buyerId: string, signal?: AbortSignal): Promise<BuyerProfile | null> {
  const hit = buyerCache.get(buyerId)
  if (hit && Date.now() - hit.at < BUYER_TTL) return hit.data
  const res = await backendClient.callBackend<{ ok: boolean; profile: BuyerProfile }>(
    `/api/cockpit/entity-graph/buyer/${encodeURIComponent(buyerId)}`,
    { signal },
  )
  if (!res.ok || !res.data?.profile) return null
  buyerCache.set(buyerId, { at: Date.now(), data: res.data.profile })
  return res.data.profile
}

const catalogCache = new Map<string, CompositionDimension[]>()

export async function fetchCompositionCatalog(tab: string, signal?: AbortSignal): Promise<CompositionDimension[]> {
  const cached = catalogCache.get(tab)
  if (cached) return cached
  const res = await backendClient.callBackend<{ ok: boolean; dimensions: CompositionDimension[] }>(
    `/api/cockpit/entity-graph/composition?${qs({ tab, catalog: 1 })}`,
    { signal },
  )
  const dims = res.ok ? res.data?.dimensions ?? [] : []
  if (dims.length) catalogCache.set(tab, dims)
  return dims
}

export async function fetchComposition(
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<Composition | null> {
  const res = await backendClient.callBackend<{ ok: boolean; composition: Composition }>(
    `/api/cockpit/entity-graph/composition?${qs(params)}`,
    { signal },
  )
  if (!res.ok) return null
  return res.data?.composition ?? null
}

/** Every property id in the current cohort (bounded server-side at `limit`, max 5,000). */
export async function fetchCohortPropertyIds(
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<{ ids: string[]; points: Array<{ id: string; lat: number; lng: number }>; truncated: boolean; cap: number } | null> {
  const res = await backendClient.callBackend<{ ok: boolean; ids: string[]; points?: Array<{ id: string; lat: number; lng: number }>; truncated: boolean; cap: number }>(
    `/api/cockpit/entity-graph/property-ids?${qs({ ...params, limit: params.limit ?? 5000 })}`,
    { signal },
  )
  if (!res.ok || !res.data) return null
  return { ids: res.data.ids ?? [], points: res.data.points ?? [], truncated: Boolean(res.data.truncated), cap: res.data.cap ?? 5000 }
}

export function evidenceTierFor(ref: Pick<PartyRef, 'basis' | 'confidence'> | null | undefined): EvidenceTier {
  if (!ref) return 'inferred'
  if (ref.basis === 'registry' || ref.basis === 'individual_key') return 'resolved'
  if (ref.basis === 'link') return (ref.confidence ?? 0) >= 0.95 ? 'resolved' : 'inferred'
  if (ref.basis === 'name') return 'observed'
  return 'inferred'
}

export const EVIDENCE_LABEL: Record<EvidenceTier, string> = {
  resolved: 'Resolved',
  observed: 'Observed by name',
  inferred: 'Inferred',
}

export const ARCHETYPE_LABEL: Record<string, string> = {
  institutional_high_volume_buyer: 'Institutional',
  active_flipper: 'Active flipper',
  long_term_rental_holder: 'Rental holder',
  multifamily_operator: 'Multifamily operator',
  small_multifamily_operator: 'Small multifamily operator',
  commercial_operator: 'Commercial operator',
  diversified_buyer: 'Diversified',
  geographically_concentrated_buyer: 'Concentrated',
  general_acquirer: 'Repeat buyer',
  inactive_stale_buyer: 'Gone quiet',
  insufficient_evidence: 'Limited history',
}

export const HOLD_FLIP_LABEL: Record<string, string> = {
  flip_like: 'Flips',
  hold_like: 'Holds',
  mixed: 'Holds + flips',
  no_disposition_evidence: 'No resales seen',
}

export const ASSET_FAMILY_LABEL: Record<string, string> = {
  sfr: 'Single family',
  small_multifamily_2_4: '2–4 units',
  multifamily_unspecified: 'Multifamily',
  apartments_5plus: 'Apartments 5+',
  commercial_other: 'Commercial',
  self_storage: 'Self storage',
  retail_strip: 'Retail strip',
  industrial: 'Industrial',
  land: 'Land',
  excluded_non_market: 'Non-market',
}
