/**
 * COMP BUYER TYPE — who bought each comparable sale, as a DISPLAY read. ONE chip
 * per comp (owner rule 2026-10-11); the sale CHANNEL (MLS / off market) is a
 * separate chip (comp-sale-type.ts) and never repeats it.
 *
 * Holder (from the name / record):
 *   entity       any business entity — LLC · Corp · Inc · LP · LLP · Ltd ·
 *                Holdings … are ONE class. There is no "company" vs "LLC" split:
 *                the records carry no field that tells an operating company from
 *                an investment vehicle, so every business entity that buys a
 *                house is read as an investor purchase → "LLC investor".
 *   institution  bank / agency / GSE → "Bank / REO"
 *   trust · estate · individual · unknown
 *
 * Use (what the purchase was for, where known): investor · owner-occupant · unknown.
 *
 * The one chip label, by rule:
 *   entity                      → "LLC investor"  ("Institutional investor" when the buyer
 *                                  index / class says institutional high-volume)
 *   institution                 → "Bank / REO"
 *   trust / estate              → "Trust" / "Estate"
 *   individual + owner-occupant → "Owner-occupant"
 *   individual + investor       → "Individual investor"
 *   individual                  → "Individual"
 *   unknown                     → "Buyer unknown"
 * Recorded vs inferred is the chip's STYLE (solid vs dashed), never extra words.
 *
 * Read only from sources that already exist, in this order (first that speaks wins):
 *   1. the recorded buyer on the comp itself (deed name classified server-side into
 *      buyerKind / buyerCompany; mv_map_market_sales buyer_class / is_investor;
 *      eg_buyer_index archetype via the W8C transaction→buyer links);
 *   2. the shared buyer-of-record resolver (op=sale_owner: a property's most recent
 *      sale with no later transfer inherits today's owner of record, with the
 *      owner-tier investor inference mi_owner_tier@2);
 *   3. nothing — "Buyer unknown". Never guessed.
 *
 * Individuals are never named. This module never feeds pricing.
 */
import type { SaleOwnerRow } from '../../modules/market-intelligence/sale-owner/sale-owner-client'

export type BuyerEntity = 'entity' | 'trust' | 'estate' | 'institution' | 'individual' | 'unknown'
export type BuyerUse = 'investor' | 'owner_occupant' | 'unknown'
/** where the buyer fact came from */
export type BuyerBasis = 'deed' | 'buyer_index' | 'owner_of_record' | 'none'
/** the one chip a comp shows */
export type BuyerChipKind = 'llc_investor' | 'institutional' | 'bank' | 'trust' | 'estate' | 'owner_occupant' | 'individual_investor' | 'individual' | 'unknown'

export const BUYER_CHIP_LABEL: Record<BuyerChipKind, string> = {
  llc_investor: 'LLC investor',
  institutional: 'Institutional investor',
  bank: 'Bank / REO',
  trust: 'Trust',
  estate: 'Estate',
  owner_occupant: 'Owner-occupant',
  individual_investor: 'Individual investor',
  individual: 'Individual',
  unknown: 'Buyer unknown',
}

export interface CompBuyerType {
  entity: BuyerEntity
  /** true = an entity (business/trust/estate/institution), false = an individual, null = unknown */
  isEntity: boolean | null
  use: BuyerUse
  /** the ONE chip: kind + label (see the rule table above) */
  chip: BuyerChipKind
  label: string
  basis: BuyerBasis
  basisLabel: string
  /** recorded = read off the deed/index; inferred = from the owner of record or an entity rule */
  provenance: 'recorded' | 'inferred' | 'none'
  /** company name when the record carries a displayable one; never an individual's */
  name: string | null
  evidence: string[]
}

export interface CompBuyerInput {
  buyerKind?: 'company' | 'person' | 'individual' | 'unknown' | null
  buyerCompany?: string | null
  buyerArchetype?: string | null
  buyerAcquisitions?: number | null
  /** mv_map_market_sales.buyer_class: llc_investor · institutional · portfolio · bank · individual · unknown */
  buyerClass?: string | null
  /** mv_map_market_sales.is_investor / the engine's investor_purchase code */
  investorFlag?: boolean | null
  owner?: SaleOwnerRow | null
}

const ARTICLE: Record<BuyerEntity, string> = { entity: 'a business entity (LLC / Corp / Inc / LP)', trust: 'a trust', estate: 'an estate', institution: 'a bank / agency', individual: 'an individual', unknown: 'not recorded' }
const BASIS_LABEL: Record<BuyerBasis, string> = {
  deed: 'Recorded deed buyer',
  buyer_index: 'Buyer index (recorded purchases)',
  owner_of_record: 'Current owner of record (most recent sale, no later transfer)',
  none: 'No buyer on record',
}

/** Archetypes from eg_buyer_index that describe a repeat / professional acquirer (same set as comp-sale-type). */
const INVESTOR_ARCHETYPES = new Set([
  'institutional_high_volume_buyer', 'active_flipper', 'long_term_rental_holder', 'general_acquirer',
  'geographically_concentrated_buyer', 'diversified_buyer', 'multifamily_operator', 'small_multifamily_operator',
  'commercial_operator', 'inactive_stale_buyer',
])

/**
 * What kind of holder a name is, from the name itself — the Entity Graph's
 * classifyHolder rules (bank → trust → estate → business entity → individual).
 * LLC / Corp / Inc / LP / Holdings … are all one class: `entity`.
 */
export function classifyHolderName(name: string | null | undefined, typeGuess = ''): Exclude<BuyerEntity, 'unknown'> {
  const n = ` ${String(name ?? '').trim().toUpperCase().replace(/[.,]/g, ' ')} `
  const g = String(typeGuess ?? '').trim().toUpperCase()
  if (/\b(BANK|MORTGAGE|FEDERAL|NATIONAL ASSOC|SAVINGS|CREDIT UNION|HOUSING AUTHORITY|FANNIE|FREDDIE|HUD|SECRETARY OF)\b/.test(n) || g.includes('BANK')) return 'institution'
  if (/\b(TRUST|TRUSTEE|TRS|TR|REVOCABLE|LIVING TRUST)\b/.test(n)) return 'trust'
  if (/\b(ESTATE|EST|HEIRS|DECEASED)\b/.test(n) || g.includes('ESTATE')) return 'estate'
  if (/\b(LLC|L L C|INC|CORP|CORPORATION|CO|COMPANY|LP|LLP|LTD|HOLDINGS|PROPERTIES|INVESTMENTS|GROUP|PARTNERS|VENTURES|CAPITAL|REALTY|ENTERPRISES|ASSOCIATES|MANAGEMENT|FUND|HOMES|RENTALS)\b/.test(n)) return 'entity'
  if (g.includes('LLC') || g.includes('CORP')) return 'entity'
  if (g.includes('TRUST')) return 'trust'
  return 'individual'
}

const isEntityKind = (e: BuyerEntity) => (e === 'unknown' ? null : e !== 'individual')
const lower = (v: string | null | undefined) => String(v ?? '').trim().toLowerCase()

/** A company-flagged buyer: the name decides trust / bank / estate; otherwise (or with no name) a business entity. */
function entityOfCompany(name: string | null | undefined): BuyerEntity {
  if (!name || !String(name).trim()) return 'entity'
  const e = classifyHolderName(name)
  return e === 'individual' ? 'entity' : e
}

/** The one chip for a holder + use (+ institutional evidence). */
export function buyerChipOf(entity: BuyerEntity, use: BuyerUse, institutional = false): BuyerChipKind {
  if (entity === 'entity') return institutional ? 'institutional' : 'llc_investor'
  if (entity === 'institution') return 'bank'
  if (entity === 'trust') return 'trust'
  if (entity === 'estate') return 'estate'
  if (entity === 'individual') return use === 'owner_occupant' ? 'owner_occupant' : use === 'investor' ? 'individual_investor' : 'individual'
  return 'unknown'
}

function build(entity: BuyerEntity, use: BuyerUse, basis: BuyerBasis, provenance: CompBuyerType['provenance'], name: string | null, evidence: string[], institutional = false): CompBuyerType {
  const chip = buyerChipOf(entity, use, institutional)
  return {
    entity,
    isEntity: isEntityKind(entity),
    use,
    chip,
    label: BUYER_CHIP_LABEL[chip],
    basis,
    basisLabel: BASIS_LABEL[basis],
    provenance,
    name: entity === 'individual' ? null : name,
    evidence,
  }
}

const isInstitutional = (input: CompBuyerInput) => lower(input.buyerArchetype) === 'institutional_high_volume_buyer' || lower(input.buyerClass) === 'institutional'

/** Investor / owner-occupant for a known holder, with the evidence that decided it. */
function useOf(entity: BuyerEntity, input: CompBuyerInput, evidence: string[]): BuyerUse {
  const arch = lower(input.buyerArchetype)
  const cls = lower(input.buyerClass)
  if (INVESTOR_ARCHETYPES.has(arch)) { evidence.push(`Buyer index archetype: ${arch.replace(/_/g, ' ')}`); return 'investor' }
  if ((input.buyerAcquisitions ?? 0) > 1) { evidence.push(`${input.buyerAcquisitions} recorded acquisitions by this buyer`); return 'investor' }
  if (cls === 'portfolio') { evidence.push('Bought as part of a multi-property (portfolio) deed'); return 'investor' }
  if (input.investorFlag === true) { evidence.push('Recorded sale flagged as an investor purchase'); return 'investor' }
  if (entity === 'entity') { evidence.push('Business entity buyer (LLC / Corp / Inc / LP) — read as an investor purchase'); return 'investor' }
  return 'unknown'
}

/** The recorded buyer kind, from the comp's own fields (deed kind, else the MV buyer class). */
function recordedKind(input: CompBuyerInput): 'company' | 'person' | 'bank' | null {
  const k = input.buyerKind
  const cls = lower(input.buyerClass)
  if (cls === 'bank') return 'bank'
  if (k === 'company') return 'company'
  if (k === 'person' || k === 'individual') return 'person'
  if (input.buyerCompany && String(input.buyerCompany).trim()) return 'company'
  if (cls === 'llc_investor' || cls === 'institutional') return 'company'
  if (cls === 'individual') return 'person'
  return null
}

/**
 * The buyer type of one comp. `owner` is the shared sale_owner resolver row
 * for the comp's sale (null when not fetched or not on record).
 */
export function compBuyerType(input: CompBuyerInput): CompBuyerType {
  const kind = recordedKind(input)
  const owner = input.owner ?? null
  const b = owner?.buyer_of_record ?? null

  // 1 · the comp's own recorded buyer (deed name, buyer class, or the buyer index behind it)
  if (kind) {
    const evidence: string[] = []
    const entity: BuyerEntity = kind === 'bank' ? 'institution' : kind === 'company' ? entityOfCompany(input.buyerCompany) : 'individual'
    evidence.push(kind === 'person' ? 'Deed buyer is an individual'
      : input.buyerCompany ? `Deed buyer is ${ARTICLE[entity]}` : `Deed buyer is ${ARTICLE[entity]} (name withheld)`)
    let use = useOf(entity, input, evidence)
    // an individual deed buyer whose resolver row says the owner lives there
    if (use === 'unknown' && entity === 'individual' && b?.basis === 'current_owner_of_record' && /owner-occupant/i.test(b.short ?? b.label ?? '')) {
      use = 'owner_occupant'
      evidence.push('Today’s owner of record lives at the property')
    }
    const basis: BuyerBasis = lower(input.buyerArchetype) ? 'buyer_index' : 'deed'
    return build(entity, use, basis, 'recorded', kind === 'company' ? input.buyerCompany ?? null : null, evidence, isInstitutional(input))
  }

  // 2 · the shared resolver: a recorded buyer it knows, or today's owner of a linked sale
  if (b && b.basis !== 'not_on_record') {
    const evidence: string[] = []
    const k = lower(b.kind)
    const entity: BuyerEntity = k === 'company' ? entityOfCompany(b.name)
      : k === 'trust_estate' || k === 'trust' ? (b.name ? (classifyHolderName(b.name) === 'estate' ? 'estate' : 'trust') : 'trust')
      : k === 'individual' ? 'individual'
      : 'unknown'
    const recorded = b.basis === 'recorded_buyer'
    evidence.push(recorded ? `Deed buyer: ${b.short ?? b.label}` : `${b.short ?? b.label} — current owner of record`)
    let use: BuyerUse = 'unknown'
    if (owner?.inferred?.investor) { use = 'investor'; evidence.push(`${owner.inferred.label} (owner-of-record signals, not the deed)`) }
    else if (entity === 'individual' && /owner-occupant/i.test(b.short ?? b.label ?? '')) { use = 'owner_occupant'; evidence.push('Today’s owner of record lives at the property') }
    else if (recorded || entity === 'entity') use = useOf(entity, input, evidence)
    return build(entity, use, recorded ? 'deed' : 'owner_of_record', recorded ? 'recorded' : 'inferred', entity === 'individual' ? null : b.name ?? null, evidence)
  }

  // 3 · nothing on record
  return build('unknown', 'unknown', 'none', 'none', null, [owner?.owner_link?.explanation ?? 'No buyer name on the deed and the sale is not linked to today’s owner of record'])
}

export interface BuyerTypeCoverage {
  total: number
  classified: number
  entities: number
  individuals: number
  investor: number
  ownerOccupant: number
  byEntity: Record<BuyerEntity, number>
  /** classified / total, 0–1 (null when there are no comps) */
  share: number | null
}

/** How many comps carry a buyer type — the honest coverage figure shown beside the list. */
export function buyerTypeCoverage(types: readonly CompBuyerType[]): BuyerTypeCoverage {
  const byEntity: Record<BuyerEntity, number> = { entity: 0, trust: 0, estate: 0, institution: 0, individual: 0, unknown: 0 }
  let investor = 0
  let ownerOccupant = 0
  for (const t of types) {
    byEntity[t.entity] += 1
    if (t.use === 'investor') investor += 1
    if (t.use === 'owner_occupant') ownerOccupant += 1
  }
  const total = types.length
  const classified = total - byEntity.unknown
  return {
    total,
    classified,
    entities: byEntity.entity + byEntity.trust + byEntity.estate + byEntity.institution,
    individuals: byEntity.individual,
    investor,
    ownerOccupant,
    byEntity,
    share: total ? classified / total : null,
  }
}

/** The buyer type of a Comp Intelligence evidence row (the one shared adapter — rows, inspector, coverage, DI). */
export function buyerTypeOfEvidenceComp(c: {
  buyerKind: 'company' | 'person' | null; buyerCompany: string | null; buyerArchetype?: string | null; buyerAcquisitions: number | null
  engine?: { saleSource?: string | null } | null
}, owner: SaleOwnerRow | null = null): CompBuyerType {
  return compBuyerType({
    buyerKind: c.buyerKind,
    buyerCompany: c.buyerCompany,
    buyerArchetype: c.buyerArchetype ?? null,
    buyerAcquisitions: c.buyerAcquisitions,
    investorFlag: c.engine?.saleSource === 'investor_purchase' ? true : null,
    owner,
  })
}
