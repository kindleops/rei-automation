import { describe, expect, it } from 'vitest'
import { BUYER_CHIP_LABEL, buyerChipOf, buyerTypeCoverage, buyerTypeOfEvidenceComp, classifyHolderName, compBuyerType } from './comp-buyer-type'
import type { SaleOwnerRow } from '../../modules/market-intelligence/sale-owner/sale-owner-client'

const ownerRow = (b: Partial<NonNullable<SaleOwnerRow['buyer_of_record']>>, inferred: SaleOwnerRow['inferred'] = null): SaleOwnerRow => ({
  buyer_of_record: { label: 'x', basis: 'current_owner_of_record', kind: null, name: null, linked: true, reason: 'linked', ...b },
  owner_link: { linked: true, reason: 'linked', explanation: 'Most recent sale; no later transfer.', owner_observed_on: '2026-09-20', later_transfer_on: null },
  inferred,
})

describe('holder names classify like the Entity Graph (classifyHolder)', () => {
  it('bank → trust → estate → business entity → individual; LLC / Corp / Inc / LP are ONE class', () => {
    expect(classifyHolderName('Wells Fargo Bank NA')).toBe('institution')
    expect(classifyHolderName('Smith Family Living Trust')).toBe('trust')
    expect(classifyHolderName('Estate of J Doe')).toBe('estate')
    expect(classifyHolderName('Pinewood L.L.C.')).toBe('entity')
    expect(classifyHolderName('Northside Holdings Inc')).toBe('entity')
    expect(classifyHolderName('Acme Corp')).toBe('entity')
    expect(classifyHolderName('Lakes Partners LP')).toBe('entity')
    expect(classifyHolderName('Jane Q Public')).toBe('individual')
  })
})

describe('buyer type per comp', () => {
  it('a recorded LLC deed buyer is an entity, read as an investor purchase', () => {
    const t = compBuyerType({ buyerKind: 'company', buyerCompany: 'Pinewood LLC' })
    expect(t).toMatchObject({ entity: 'entity', isEntity: true, use: 'investor', chip: 'llc_investor', label: 'LLC investor', basis: 'deed', provenance: 'recorded', name: 'Pinewood LLC' })
  })
  it('a withheld business name is still a business entity → "LLC investor"; the name is never guessed', () => {
    const t = compBuyerType({ buyerKind: 'company', buyerCompany: null })
    expect(t.entity).toBe('entity')
    expect(t.label).toBe('LLC investor')
    expect(t.name).toBeNull()
  })
  it('a recorded individual is never named; a buyer-index archetype makes it an investor', () => {
    const plain = compBuyerType({ buyerKind: 'person' })
    expect(plain).toMatchObject({ entity: 'individual', isEntity: false, use: 'unknown', label: 'Individual', name: null })
    const flipper = compBuyerType({ buyerKind: 'person', buyerArchetype: 'active_flipper' })
    expect(flipper).toMatchObject({ entity: 'individual', use: 'investor', label: 'Individual investor', basis: 'buyer_index' })
  })
  it('a trust or bank buyer is an entity but NOT assumed to be an investor', () => {
    expect(compBuyerType({ buyerKind: 'company', buyerCompany: 'Doe Revocable Trust' })).toMatchObject({ entity: 'trust', use: 'unknown', label: 'Trust' })
    expect(compBuyerType({ buyerKind: 'company', buyerCompany: 'US Bank National Assoc' })).toMatchObject({ entity: 'institution', use: 'unknown', label: 'Bank / REO' })
  })
  it('no deed buyer: today’s owner of record speaks, marked INFERRED', () => {
    const co = compBuyerType({ buyerKind: null, owner: ownerRow({ kind: 'company', short: 'Company (name not on record)' }, { tier: 'likely', label: 'Likely inferred investor', investor: true, evidence: ['entity_owner'], mailing_stack: 1 }) })
    expect(co).toMatchObject({ entity: 'entity', use: 'investor', label: 'LLC investor', basis: 'owner_of_record', provenance: 'inferred' })
    const occ = compBuyerType({ buyerKind: null, owner: ownerRow({ kind: 'individual', short: 'Individual (owner-occupant)' }) })
    expect(occ).toMatchObject({ entity: 'individual', use: 'owner_occupant', label: 'Owner-occupant', provenance: 'inferred', name: null })
    const trust = compBuyerType({ buyerKind: null, owner: ownerRow({ kind: 'trust_estate', short: 'Trust / estate' }) })
    expect(trust.entity).toBe('trust')
  })
  it('a recorded individual whose owner of record lives there reads owner-occupant', () => {
    const t = compBuyerType({ buyerKind: 'person', owner: ownerRow({ kind: 'individual', short: 'Individual (owner-occupant)' }) })
    expect(t).toMatchObject({ entity: 'individual', use: 'owner_occupant', basis: 'deed' })
  })
  it('nothing on record → unknown with the reason, never a guess', () => {
    const t = compBuyerType({ buyerKind: null, owner: { buyer_of_record: { label: 'Buyer not on record', basis: 'not_on_record', kind: null, name: null, linked: false, reason: 'later_transfer' }, owner_link: { linked: false, reason: 'later_transfer', explanation: 'The property sold again later.', owner_observed_on: null, later_transfer_on: '2026-03-02' }, inferred: null } })
    expect(t).toMatchObject({ entity: 'unknown', isEntity: null, use: 'unknown', label: 'Buyer unknown', basis: 'none', provenance: 'none' })
    expect(t.evidence[0]).toContain('sold again later')
  })
  it('coverage counts classified comps and splits entity vs individual', () => {
    const c = buyerTypeCoverage([
      compBuyerType({ buyerKind: 'company', buyerCompany: 'A LLC' }),
      compBuyerType({ buyerKind: 'person' }),
      compBuyerType({ buyerKind: null }),
      compBuyerType({ buyerKind: 'company', buyerCompany: 'B Trust' }),
    ])
    expect(c).toMatchObject({ total: 4, classified: 3, entities: 2, individuals: 1, investor: 1 })
    expect(c.share).toBeCloseTo(0.75)
    expect(buyerTypeCoverage([]).share).toBeNull()
  })
})

describe('ONE buyer chip — the label model (owner rule 2026-10-11)', () => {
  it('every holder × use maps to exactly one label, and no two kinds share a label', () => {
    const labels = Object.values(BUYER_CHIP_LABEL)
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels).not.toContain('Company')
    expect(buyerChipOf('entity', 'investor')).toBe('llc_investor')
    expect(buyerChipOf('entity', 'unknown')).toBe('llc_investor')
    expect(buyerChipOf('entity', 'investor', true)).toBe('institutional')
    expect(buyerChipOf('institution', 'unknown')).toBe('bank')
    expect(buyerChipOf('individual', 'owner_occupant')).toBe('owner_occupant')
    expect(buyerChipOf('individual', 'investor')).toBe('individual_investor')
    expect(buyerChipOf('individual', 'unknown')).toBe('individual')
    expect(buyerChipOf('unknown', 'unknown')).toBe('unknown')
  })
  it('the label never repeats the channel or adds a second "investor" word', () => {
    for (const label of Object.values(BUYER_CHIP_LABEL)) {
      expect(label).not.toMatch(/\bMLS\b|off market|public record/i)
      expect((label.match(/investor/gi) ?? []).length).toBeLessThanOrEqual(1)
    }
  })
  it('the canonical-sales buyer class speaks when the deed kind is absent (bank, institutional, portfolio)', () => {
    expect(compBuyerType({ buyerClass: 'bank' }).label).toBe('Bank / REO')
    expect(compBuyerType({ buyerClass: 'institutional', buyerCompany: 'Big Homes LP' }).label).toBe('Institutional investor')
    expect(compBuyerType({ buyerKind: 'person', buyerClass: 'portfolio' }).label).toBe('Individual investor')
    expect(compBuyerType({ buyerClass: 'individual' }).label).toBe('Individual')
    expect(compBuyerType({ buyerClass: 'unknown' }).label).toBe('Buyer unknown')
  })
  it('the engine investor_purchase code is investor evidence on the buyer, not a channel', () => {
    const t = buyerTypeOfEvidenceComp({ buyerKind: 'person', buyerCompany: null, buyerAcquisitions: null, engine: { saleSource: 'investor_purchase' } })
    expect(t.label).toBe('Individual investor')
  })
})
