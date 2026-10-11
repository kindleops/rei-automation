/**
 * COMP BUYER TYPE — who bought each comparable sale, as a DISPLAY read.
 *
 * Two independent facts per comp, each with its basis:
 *
 *   entity  what kind of holder bought it — LLC · trust · estate · company ·
 *           bank / agency · individual · unknown
 *   use     what the purchase was for, where known — investor · owner-occupant ·
 *           unknown
 *
 * Read only from sources that already exist, in this order (first that speaks wins):
 *   1. the recorded deed buyer on the comp itself (buyer_1_name classified
 *      server-side into buyerKind / buyerCompany; eg_buyer_index entity_type
 *      and archetype via the W8C transaction→buyer links);
 *   2. the shared buyer-of-record resolver (op=sale_owner: a property's most
 *      recent sale with no later transfer inherits today's owner of record, with
 *      the owner-tier investor inference mi_owner_tier@2);
 *   3. nothing — "Buyer not on record". Never guessed.
 *
 * The entity split uses the same name rules as the Entity Graph's
 * classifyHolder (apps/api entity-network-service.js), ported verbatim so a
 * holder reads the same everywhere. Individuals are never named. This module
 * never feeds pricing: it is evidence shown beside a comp.
 */
import type { SaleOwnerRow } from '../../modules/market-intelligence/sale-owner/sale-owner-client'

export type BuyerEntity = 'llc' | 'trust' | 'estate' | 'company' | 'institution' | 'individual' | 'unknown'
export type BuyerUse = 'investor' | 'owner_occupant' | 'unknown'
/** where the buyer fact came from */
export type BuyerBasis = 'deed' | 'buyer_index' | 'owner_of_record' | 'none'

export interface CompBuyerType {
  entity: BuyerEntity
  entityLabel: string
  /** true = an entity (LLC/trust/estate/company/institution), false = an individual, null = unknown */
  isEntity: boolean | null
  use: BuyerUse
  useLabel: string | null
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
  owner?: SaleOwnerRow | null
}

const ENTITY_LABEL: Record<BuyerEntity, string> = {
  llc: 'LLC',
  trust: 'Trust',
  estate: 'Estate',
  company: 'Company',
  institution: 'Bank / agency',
  individual: 'Individual',
  unknown: 'Buyer not on record',
}
const ARTICLE: Record<BuyerEntity, string> = { llc: 'an LLC', trust: 'a trust', estate: 'an estate', company: 'a company', institution: 'a bank / agency', individual: 'an individual', unknown: 'not recorded' }
const USE_LABEL: Record<BuyerUse, string | null> = { investor: 'Investor', owner_occupant: 'Owner-occupant', unknown: null }
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
 * classifyHolder rules (bank → trust → estate → LLC → company → individual).
 */
export function classifyHolderName(name: string | null | undefined, typeGuess = ''): Exclude<BuyerEntity, 'unknown'> {
  const n = ` ${String(name ?? '').trim().toUpperCase().replace(/[.,]/g, ' ')} `
  const g = String(typeGuess ?? '').trim().toUpperCase()
  if (/\b(BANK|MORTGAGE|FEDERAL|NATIONAL ASSOC|SAVINGS|CREDIT UNION|HOUSING AUTHORITY|FANNIE|FREDDIE|HUD|SECRETARY OF)\b/.test(n) || g.includes('BANK')) return 'institution'
  if (/\b(TRUST|TRUSTEE|TRS|TR|REVOCABLE|LIVING TRUST)\b/.test(n)) return 'trust'
  if (/\b(ESTATE|EST|HEIRS|DECEASED)\b/.test(n) || g.includes('ESTATE')) return 'estate'
  if (/\b(LLC|L L C)\b/.test(n)) return 'llc'
  if (/\b(INC|CORP|CORPORATION|CO|COMPANY|LP|LLP|LTD|HOLDINGS|PROPERTIES|INVESTMENTS|GROUP|PARTNERS|VENTURES|CAPITAL|REALTY|ENTERPRISES|ASSOCIATES|MANAGEMENT|FUND|HOMES|RENTALS)\b/.test(n)) return 'company'
  if (g.includes('LLC') || g.includes('CORP')) return 'company'
  if (g.includes('TRUST')) return 'trust'
  return 'individual'
}

const isEntityKind = (e: BuyerEntity) => (e === 'unknown' ? null : e !== 'individual')
const lower = (v: string | null | undefined) => String(v ?? '').trim().toLowerCase()

/** A company-flagged buyer: the name decides LLC / trust / bank …; a withheld or bare name stays "Company". */
function entityOfCompany(name: string | null | undefined): BuyerEntity {
  if (!name || !String(name).trim()) return 'company'
  const e = classifyHolderName(name)
  return e === 'individual' ? 'company' : e
}

function build(entity: BuyerEntity, use: BuyerUse, basis: BuyerBasis, provenance: CompBuyerType['provenance'], name: string | null, evidence: string[]): CompBuyerType {
  return {
    entity,
    entityLabel: ENTITY_LABEL[entity],
    isEntity: isEntityKind(entity),
    use,
    useLabel: USE_LABEL[use],
    basis,
    basisLabel: BASIS_LABEL[basis],
    provenance,
    name: entity === 'individual' ? null : name,
    evidence,
  }
}

/** Investor / owner-occupant for a known holder, with the evidence that decided it. */
function useOf(entity: BuyerEntity, input: CompBuyerInput, evidence: string[]): BuyerUse {
  const arch = lower(input.buyerArchetype)
  if (INVESTOR_ARCHETYPES.has(arch)) { evidence.push(`Buyer index archetype: ${arch.replace(/_/g, ' ')}`); return 'investor' }
  if ((input.buyerAcquisitions ?? 0) > 1) { evidence.push(`${input.buyerAcquisitions} recorded acquisitions by this buyer`); return 'investor' }
  if (entity === 'llc' || entity === 'company') { evidence.push('Entity buyer (LLC / company) — read as an investor purchase'); return 'investor' }
  return 'unknown'
}

/**
 * The buyer type of one comp. `owner` is the shared sale_owner resolver row
 * for the comp's sale (null when not fetched or not on record).
 */
export function compBuyerType(input: CompBuyerInput): CompBuyerType {
  const kind = input.buyerKind
  const owner = input.owner ?? null
  const b = owner?.buyer_of_record ?? null

  // 1 · the comp's own recorded buyer (deed name, or the buyer index behind it)
  if (kind === 'company' || kind === 'person' || kind === 'individual') {
    const evidence: string[] = []
    const entity: BuyerEntity = kind === 'company' ? entityOfCompany(input.buyerCompany) : 'individual'
    evidence.push(kind === 'company'
      ? (input.buyerCompany ? `Deed buyer is ${ARTICLE[entity]}` : 'Deed buyer is a company (name withheld)')
      : 'Deed buyer is an individual')
    let use = useOf(entity, input, evidence)
    // an individual deed buyer whose resolver row says the owner lives there
    if (use === 'unknown' && entity === 'individual' && b?.basis === 'current_owner_of_record' && /owner-occupant/i.test(b.short ?? b.label ?? '')) {
      use = 'owner_occupant'
      evidence.push('Today’s owner of record lives at the property')
    }
    const basis: BuyerBasis = lower(input.buyerArchetype) ? 'buyer_index' : 'deed'
    return build(entity, use, basis, 'recorded', kind === 'company' ? input.buyerCompany ?? null : null, evidence)
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
    else if (recorded) use = useOf(entity, input, evidence)
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
  const byEntity: Record<BuyerEntity, number> = { llc: 0, trust: 0, estate: 0, company: 0, institution: 0, individual: 0, unknown: 0 }
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
    entities: byEntity.llc + byEntity.trust + byEntity.estate + byEntity.company + byEntity.institution,
    individuals: byEntity.individual,
    investor,
    ownerOccupant,
    byEntity,
    share: total ? classified / total : null,
  }
}
