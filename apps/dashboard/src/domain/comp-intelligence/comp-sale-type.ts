/**
 * COMP SALE TYPE — how a comparable sale actually happened, read only from
 * recorded fields. MLS vs investor vs off-market changes what a sale says
 * about the subject's price, so it is shown on every comp — and never guessed.
 *
 * Primary type (one per sale, first rule that holds wins):
 *  - `mls`           MLS sale. The sale has an MLS sold price recorded
 *                    (v_recent_sold_comps.mls_sold_price > 0 / sale_source "MLS Sold").
 *  - `investor`      Investor purchase, not on the MLS. No MLS record, and the
 *                    buyer is an entity (recorded buyer name reads as a company:
 *                    LLC / Inc / Trust / Holdings …), or the buyer index
 *                    (eg_buyer_index.archetype) classifies the buyer as an
 *                    acquirer, or the engine itself recorded `investor_purchase`.
 *  - `off_market`    Off-market sale. The source says "Off-Market Sold" and the
 *                    buyer is not known to be an investor.
 *  - `public_record` Public-record sale with no MLS record: a recorded deed, or
 *                    sale_source "Public Record Sold", buyer an individual or not
 *                    recorded.
 *  - `unknown`       None of those fields is present — "Sale type unknown".
 *
 * The buyer is a second, independent fact: an MLS sale can still be bought by
 * an investor, and that is shown beside the type rather than replacing it.
 */

export type SaleType = 'mls' | 'investor' | 'off_market' | 'public_record' | 'unknown'
export type BuyerClass = 'institutional' | 'investor' | 'individual' | 'unknown'

export interface SaleTypeInput {
  /** engine_pool (sold-comp records) or transaction_corpus (recorded deeds) */
  corpus?: 'engine_pool' | 'transaction_corpus' | null
  /** an MLS sold price is recorded on the sale */
  mls?: boolean | null
  /** the record's own sale_source text: "MLS Sold" | "Public Record Sold" | "Off-Market Sold" */
  rawSource?: string | null
  /** the engine's sale_source code: mls_sold | public_record_sold | investor_purchase */
  engineSource?: string | null
  buyerKind?: 'company' | 'person' | 'individual' | 'unknown' | null
  /** eg_buyer_index.archetype when the buyer is resolved */
  buyerArchetype?: string | null
}

export interface SaleTypeVerdict {
  type: SaleType
  label: string
  short: string
  buyer: BuyerClass
  buyerLabel: string | null
  /** the recorded facts that decided it, in plain words */
  evidence: string[]
}

/** Archetypes from eg_buyer_index that describe a repeat/professional acquirer. */
const INVESTOR_ARCHETYPES = new Set([
  'institutional_high_volume_buyer', 'active_flipper', 'long_term_rental_holder', 'general_acquirer',
  'geographically_concentrated_buyer', 'diversified_buyer', 'multifamily_operator', 'small_multifamily_operator',
  'commercial_operator', 'inactive_stale_buyer',
])
const INSTITUTIONAL_ARCHETYPES = new Set(['institutional_high_volume_buyer'])

const ARCHETYPE_WORDS: Record<string, string> = {
  institutional_high_volume_buyer: 'institutional high-volume buyer',
  active_flipper: 'active flipper',
  long_term_rental_holder: 'long-term rental holder',
  general_acquirer: 'repeat acquirer',
  geographically_concentrated_buyer: 'locally concentrated buyer',
  diversified_buyer: 'diversified buyer',
  multifamily_operator: 'multifamily operator',
  small_multifamily_operator: 'small multifamily operator',
  commercial_operator: 'commercial operator',
  inactive_stale_buyer: 'past acquirer (inactive)',
}

export const SALE_TYPE_LABEL: Record<SaleType, { label: string; short: string }> = {
  mls: { label: 'MLS sale', short: 'MLS' },
  investor: { label: 'Investor purchase · not MLS', short: 'Investor' },
  off_market: { label: 'Off-market sale', short: 'Off-market' },
  public_record: { label: 'Public record · no MLS record', short: 'Public record' },
  unknown: { label: 'Sale type unknown', short: 'Unknown' },
}

const lower = (v: string | null | undefined) => String(v ?? '').trim().toLowerCase()

export function buyerClassOf(input: Pick<SaleTypeInput, 'buyerKind' | 'buyerArchetype'>): { buyer: BuyerClass; label: string | null; evidence: string | null } {
  const arch = lower(input.buyerArchetype)
  if (INSTITUTIONAL_ARCHETYPES.has(arch)) return { buyer: 'institutional', label: 'Institutional buyer', evidence: `Buyer index: ${ARCHETYPE_WORDS[arch]}` }
  if (INVESTOR_ARCHETYPES.has(arch)) return { buyer: 'investor', label: 'Investor buyer', evidence: `Buyer index: ${ARCHETYPE_WORDS[arch]}` }
  if (input.buyerKind === 'company') return { buyer: 'investor', label: 'Investor buyer', evidence: 'Buyer recorded as a company (LLC, Inc, Trust, Holdings …)' }
  if (input.buyerKind === 'person' || input.buyerKind === 'individual') return { buyer: 'individual', label: 'Individual buyer', evidence: 'Buyer recorded as an individual' }
  return { buyer: 'unknown', label: null, evidence: null }
}

export function classifySaleType(input: SaleTypeInput): SaleTypeVerdict {
  const raw = lower(input.rawSource)
  const eng = lower(input.engineSource)
  const b = buyerClassOf(input)
  const evidence: string[] = []
  const verdict = (type: SaleType): SaleTypeVerdict => ({ type, ...SALE_TYPE_LABEL[type], buyer: b.buyer, buyerLabel: b.label, evidence })
  const investorBuyer = b.buyer === 'investor' || b.buyer === 'institutional'

  if (input.mls === true || raw.includes('mls') || eng === 'mls_sold') {
    evidence.push(input.mls === true ? 'MLS sold price recorded on the sale' : raw.includes('mls') ? 'Record source: MLS sold' : 'Engine recorded the sale as MLS sold')
    if (b.evidence) evidence.push(b.evidence)
    return verdict('mls')
  }

  const deed = input.corpus === 'transaction_corpus'
  const hasChannel = deed || raw.length > 0 || eng === 'investor_purchase'
  if (!hasChannel) {
    if (b.evidence) evidence.push(b.evidence)
    evidence.push('No sale-source field on this record')
    return verdict('unknown')
  }

  const channel = deed ? 'Recorded deed — no MLS record' : raw.includes('off') ? 'Record source: off-market sold' : raw.includes('public') ? 'Record source: public record sold' : raw ? `Record source: ${input.rawSource}` : null
  if (investorBuyer || eng === 'investor_purchase') {
    if (channel) evidence.push(channel)
    evidence.push(b.evidence ?? 'Engine recorded the sale as an investor purchase')
    return verdict('investor')
  }
  if (channel) evidence.push(channel)
  if (b.evidence) evidence.push(b.evidence)
  if (raw.includes('off')) return verdict('off_market')
  if (deed || raw.includes('public')) return verdict('public_record')
  evidence.push('Source not recognized')
  return verdict('unknown')
}

/** The engine's source factor for a sale (mlsFactor / otherFactor of the weight formula). */
export function engineSourceFactor(engineSource: string | null | undefined, rules?: { mlsFactor: number; otherFactor: number } | null): { factor: number; mls: boolean } | null {
  if (!engineSource) return null
  const mls = engineSource === 'mls_sold'
  return { mls, factor: mls ? rules?.mlsFactor ?? 1 : rules?.otherFactor ?? 0.92 }
}

export function countSaleTypes<T>(rows: readonly T[], of: (r: T) => SaleType): Record<SaleType, number> {
  const out: Record<SaleType, number> = { mls: 0, investor: 0, off_market: 0, public_record: 0, unknown: 0 }
  for (const r of rows) out[of(r)] += 1
  return out
}

const evidenceCache = new WeakMap<object, SaleTypeVerdict>()

/** Sale type of a Comp Intelligence evidence row (cached per row object). */
export function saleTypeOfComp(c: {
  corpus: 'engine_pool' | 'transaction_corpus'; mls: boolean; saleSourceRaw?: string | null; buyerKind: 'company' | 'person' | null
  buyerArchetype?: string | null; engine?: { saleSource?: string | null } | null
}): SaleTypeVerdict {
  const hit = evidenceCache.get(c)
  if (hit) return hit
  const v = classifySaleType({
    corpus: c.corpus,
    mls: c.mls,
    rawSource: c.saleSourceRaw ?? null,
    engineSource: c.engine?.saleSource ?? null,
    buyerKind: c.buyerKind,
    buyerArchetype: c.buyerArchetype ?? null,
  })
  evidenceCache.set(c, v)
  return v
}

/** Display order everywhere a split is shown. */
export const SALE_TYPES: readonly SaleType[] = ['mls', 'investor', 'off_market', 'public_record', 'unknown']

/** Sale type of a Deal Intelligence comp (the engine's selected comp + its sold-comp record). */
export function saleTypeOfDealComp(c: {
  saleSource: string | null; mlsSoldPrice: number | null; source: string | null; buyerKind: 'company' | 'individual' | 'unknown'
}): SaleTypeVerdict {
  return classifySaleType({
    corpus: 'engine_pool',
    mls: c.mlsSoldPrice !== null && c.mlsSoldPrice > 0 ? true : null,
    rawSource: c.saleSource,
    engineSource: c.source,
    buyerKind: c.buyerKind,
  })
}
