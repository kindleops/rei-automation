/**
 * COMP SALE CHANNEL — HOW a comparable sale reached the market, read only from
 * recorded fields. It says nothing about WHO bought it: that is the buyer type
 * (comp-buyer-type.ts), shown as its own single chip. The two never repeat each
 * other (owner rule 2026-10-11: one channel chip + one buyer chip per comp).
 *
 * Channel (one per sale, first rule that holds wins):
 *  - `mls`         MLS sale. An MLS sold price is recorded on the sale
 *                  (mls_sold_price > 0 / sale_source "MLS Sold" / engine mls_sold).
 *  - `off_market`  Off market: a recorded sale with no MLS record — a recorded
 *                  deed, sale_source "Public Record Sold" / "Off-Market Sold", or
 *                  the engine's investor_purchase code.
 *  - `unknown`     None of those fields is present — "Channel unknown". Never guessed.
 *
 * Qualifier (optional, shown inside the channel chip): how the sale was
 * forced, when the recorded document says so —
 *  - `foreclosure` trustee's / sheriff's / referee's deed, certificate of sale,
 *                  foreclosure or auction document → "Foreclosure / auction";
 *  - `reo`         the SELLER of record is a bank / agency → "REO" (bank-owned resale).
 */

export type SaleType = 'mls' | 'off_market' | 'unknown'
export type SaleQualifier = 'foreclosure' | 'reo'
export type BuyerClass = 'institutional' | 'investor' | 'individual' | 'unknown'

export interface SaleTypeInput {
  /** engine_pool (sold-comp records) or transaction_corpus (recorded deeds) */
  corpus?: 'engine_pool' | 'transaction_corpus' | 'canonical_corpus' | null
  /** an MLS sold price is recorded on the sale */
  mls?: boolean | null
  /** the record's own sale_source text: "MLS Sold" | "Public Record Sold" | "Off-Market Sold" | "mls" | "public_record" */
  rawSource?: string | null
  /** the engine's sale_source code: mls_sold | public_record_sold | investor_purchase */
  engineSource?: string | null
  /** the recorded document type (Warranty Deed, Trustee's Deed …) */
  docType?: string | null
  /** the seller of record's kind, when recorded (bank / company / person …) */
  sellerKind?: string | null
}

export interface SaleTypeVerdict {
  type: SaleType
  label: string
  short: string
  qualifier: SaleQualifier | null
  qualifierLabel: string | null
  /** the recorded facts that decided it, in plain words */
  evidence: string[]
}

export const SALE_TYPE_LABEL: Record<SaleType, { label: string; short: string }> = {
  mls: { label: 'MLS sale', short: 'MLS' },
  off_market: { label: 'Off market · public record, no MLS record', short: 'Off market' },
  unknown: { label: 'Sale channel unknown', short: 'Channel unknown' },
}

export const QUALIFIER_LABEL: Record<SaleQualifier, string> = {
  foreclosure: 'Foreclosure / auction',
  reo: 'REO',
}

const lower = (v: string | null | undefined) => String(v ?? '').trim().toLowerCase()

/** Archetypes from eg_buyer_index that describe a repeat/professional acquirer. */
const INVESTOR_ARCHETYPES = new Set([
  'institutional_high_volume_buyer', 'active_flipper', 'long_term_rental_holder', 'general_acquirer',
  'geographically_concentrated_buyer', 'diversified_buyer', 'multifamily_operator', 'small_multifamily_operator',
  'commercial_operator', 'inactive_stale_buyer',
])
const INSTITUTIONAL_ARCHETYPES = new Set(['institutional_high_volume_buyer'])

/** Buyer class from the buyer index / deed kind (used by the buyer type; kept for the API-shaped callers). */
export function buyerClassOf(input: { buyerKind?: string | null; buyerArchetype?: string | null }): { buyer: BuyerClass; evidence: string | null } {
  const arch = lower(input.buyerArchetype)
  if (INSTITUTIONAL_ARCHETYPES.has(arch)) return { buyer: 'institutional', evidence: 'Buyer index: institutional high-volume buyer' }
  if (INVESTOR_ARCHETYPES.has(arch)) return { buyer: 'investor', evidence: `Buyer index: ${arch.replace(/_/g, ' ')}` }
  if (input.buyerKind === 'company') return { buyer: 'investor', evidence: 'Buyer recorded as a business entity' }
  if (input.buyerKind === 'person' || input.buyerKind === 'individual') return { buyer: 'individual', evidence: 'Buyer recorded as an individual' }
  return { buyer: 'unknown', evidence: null }
}

const FORECLOSURE_DOC = /\b(trustee|sheriff|referee|commissioner|foreclos|auction|certificate of (sale|title)|tax deed|deed in lieu)/i
const BANK_SELLER = /\b(bank|institution|agency|lender|mortgage|federal|fannie|freddie|hud)\b/i

/** Forced-sale qualifier from the recorded document / seller (null when the record does not say). */
export function saleQualifierOf(input: Pick<SaleTypeInput, 'docType' | 'sellerKind'>): { qualifier: SaleQualifier; evidence: string } | null {
  const doc = String(input.docType ?? '').replace(/’/g, "'")
  if (doc && FORECLOSURE_DOC.test(doc)) return { qualifier: 'foreclosure', evidence: `Recorded document: ${doc}` }
  if (input.sellerKind && BANK_SELLER.test(String(input.sellerKind))) return { qualifier: 'reo', evidence: 'Seller of record is a bank / agency' }
  return null
}

export function classifySaleType(input: SaleTypeInput): SaleTypeVerdict {
  const raw = lower(input.rawSource)
  const eng = lower(input.engineSource)
  const evidence: string[] = []
  const q = saleQualifierOf(input)
  const verdict = (type: SaleType): SaleTypeVerdict => {
    if (q) evidence.push(q.evidence)
    return { type, ...SALE_TYPE_LABEL[type], qualifier: q?.qualifier ?? null, qualifierLabel: q ? QUALIFIER_LABEL[q.qualifier] : null, evidence }
  }

  if (input.mls === true || raw.includes('mls') || eng === 'mls_sold') {
    evidence.push(input.mls === true ? 'MLS sold price recorded on the sale' : raw.includes('mls') ? 'Record source: MLS sold' : 'Engine recorded the sale as MLS sold')
    return verdict('mls')
  }
  const deed = input.corpus === 'transaction_corpus'
  if (deed) { evidence.push('Recorded deed — no MLS record'); return verdict('off_market') }
  if (raw.includes('off')) { evidence.push('Record source: off-market sold'); return verdict('off_market') }
  if (raw.includes('public')) { evidence.push('Record source: public record sold — no MLS record'); return verdict('off_market') }
  if (eng === 'investor_purchase') { evidence.push('Engine recorded the sale as a non-MLS investor purchase'); return verdict('off_market') }
  evidence.push(raw ? `Source not recognized: ${input.rawSource}` : 'No sale-source field on this record')
  return verdict('unknown')
}

/** The engine's source factor for a sale (mlsFactor / otherFactor of the weight formula). */
export function engineSourceFactor(engineSource: string | null | undefined, rules?: { mlsFactor: number; otherFactor: number } | null): { factor: number; mls: boolean } | null {
  if (!engineSource) return null
  const mls = engineSource === 'mls_sold'
  return { mls, factor: mls ? rules?.mlsFactor ?? 1 : rules?.otherFactor ?? 0.92 }
}

export function countSaleTypes<T>(rows: readonly T[], of: (r: T) => SaleType): Record<SaleType, number> {
  const out: Record<SaleType, number> = { mls: 0, off_market: 0, unknown: 0 }
  for (const r of rows) out[of(r)] += 1
  return out
}

const evidenceCache = new WeakMap<object, SaleTypeVerdict>()

/** Sale channel of a Comp Intelligence evidence row (cached per row object). */
export function saleTypeOfComp(c: {
  corpus: string; mls: boolean; saleSourceRaw?: string | null
  engine?: { saleSource?: string | null } | null; docType?: string | null; sellerKind?: string | null
}): SaleTypeVerdict {
  const hit = evidenceCache.get(c)
  if (hit) return hit
  const v = classifySaleType({
    corpus: c.corpus === 'transaction_corpus' ? 'transaction_corpus' : c.corpus === 'canonical_corpus' ? 'canonical_corpus' : 'engine_pool',
    mls: c.mls,
    rawSource: c.saleSourceRaw ?? null,
    engineSource: c.engine?.saleSource ?? null,
    docType: c.docType ?? null,
    sellerKind: c.sellerKind ?? null,
  })
  evidenceCache.set(c, v)
  return v
}

/** Display order everywhere a split is shown. */
export const SALE_TYPES: readonly SaleType[] = ['mls', 'off_market', 'unknown']

/** Sale channel of a Deal Intelligence comp (the engine's selected comp + its sold-comp record). */
export function saleTypeOfDealComp(c: { saleSource: string | null; mlsSoldPrice: number | null; source: string | null }): SaleTypeVerdict {
  return classifySaleType({
    corpus: 'engine_pool',
    mls: c.mlsSoldPrice !== null && c.mlsSoldPrice > 0 ? true : null,
    rawSource: c.saleSource,
    engineSource: c.source,
  })
}

/** Sale channel of a recent market sale (mv_map_market_sales: source mls | public_record). */
export function saleTypeOfRecentSale(s: { saleSource: string | null; docType?: string | null }): SaleTypeVerdict {
  return classifySaleType({ corpus: s.saleSource === 'mls' ? 'engine_pool' : 'transaction_corpus', mls: s.saleSource === 'mls' ? true : null, docType: s.docType ?? null })
}
