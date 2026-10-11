import { describe, expect, it } from 'vitest'
import { buyerTypeCoverage, classifyHolderName, compBuyerType } from './comp-buyer-type'
import type { SaleOwnerRow } from '../../modules/market-intelligence/sale-owner/sale-owner-client'

const ownerRow = (b: Partial<NonNullable<SaleOwnerRow['buyer_of_record']>>, inferred: SaleOwnerRow['inferred'] = null): SaleOwnerRow => ({
  buyer_of_record: { label: 'x', basis: 'current_owner_of_record', kind: null, name: null, linked: true, reason: 'linked', ...b },
  owner_link: { linked: true, reason: 'linked', explanation: 'Most recent sale; no later transfer.', owner_observed_on: '2026-09-20', later_transfer_on: null },
  inferred,
})

describe('holder names classify like the Entity Graph (classifyHolder)', () => {
  it('bank → trust → estate → LLC → company → individual', () => {
    expect(classifyHolderName('Wells Fargo Bank NA')).toBe('institution')
    expect(classifyHolderName('Smith Family Living Trust')).toBe('trust')
    expect(classifyHolderName('Estate of J Doe')).toBe('estate')
    expect(classifyHolderName('Pinewood L.L.C.')).toBe('llc')
    expect(classifyHolderName('Northside Holdings Inc')).toBe('company')
    expect(classifyHolderName('Jane Q Public')).toBe('individual')
  })
})

describe('buyer type per comp', () => {
  it('a recorded LLC deed buyer is an entity, read as an investor purchase', () => {
    const t = compBuyerType({ buyerKind: 'company', buyerCompany: 'Pinewood LLC' })
    expect(t).toMatchObject({ entity: 'llc', isEntity: true, use: 'investor', basis: 'deed', provenance: 'recorded', name: 'Pinewood LLC' })
  })
  it('a withheld company name stays "Company", never guessed', () => {
    const t = compBuyerType({ buyerKind: 'company', buyerCompany: null })
    expect(t.entity).toBe('company')
    expect(t.name).toBeNull()
  })
  it('a recorded individual is never named; a buyer-index archetype makes it an investor', () => {
    const plain = compBuyerType({ buyerKind: 'person' })
    expect(plain).toMatchObject({ entity: 'individual', isEntity: false, use: 'unknown', name: null })
    const flipper = compBuyerType({ buyerKind: 'person', buyerArchetype: 'active_flipper' })
    expect(flipper).toMatchObject({ entity: 'individual', use: 'investor', basis: 'buyer_index' })
  })
  it('a trust or bank buyer is an entity but NOT assumed to be an investor', () => {
    expect(compBuyerType({ buyerKind: 'company', buyerCompany: 'Doe Revocable Trust' })).toMatchObject({ entity: 'trust', use: 'unknown' })
    expect(compBuyerType({ buyerKind: 'company', buyerCompany: 'US Bank National Assoc' })).toMatchObject({ entity: 'institution', use: 'unknown' })
  })
  it('no deed buyer: today’s owner of record speaks, marked INFERRED', () => {
    const co = compBuyerType({ buyerKind: null, owner: ownerRow({ kind: 'company', short: 'Company (name not on record)' }, { tier: 'likely', label: 'Likely inferred investor', investor: true, evidence: ['entity_owner'], mailing_stack: 1 }) })
    expect(co).toMatchObject({ entity: 'company', use: 'investor', basis: 'owner_of_record', provenance: 'inferred' })
    const occ = compBuyerType({ buyerKind: null, owner: ownerRow({ kind: 'individual', short: 'Individual (owner-occupant)' }) })
    expect(occ).toMatchObject({ entity: 'individual', use: 'owner_occupant', provenance: 'inferred', name: null })
    const trust = compBuyerType({ buyerKind: null, owner: ownerRow({ kind: 'trust_estate', short: 'Trust / estate' }) })
    expect(trust.entity).toBe('trust')
  })
  it('a recorded individual whose owner of record lives there reads owner-occupant', () => {
    const t = compBuyerType({ buyerKind: 'person', owner: ownerRow({ kind: 'individual', short: 'Individual (owner-occupant)' }) })
    expect(t).toMatchObject({ entity: 'individual', use: 'owner_occupant', basis: 'deed' })
  })
  it('nothing on record → unknown with the reason, never a guess', () => {
    const t = compBuyerType({ buyerKind: null, owner: { buyer_of_record: { label: 'Buyer not on record', basis: 'not_on_record', kind: null, name: null, linked: false, reason: 'later_transfer' }, owner_link: { linked: false, reason: 'later_transfer', explanation: 'The property sold again later.', owner_observed_on: null, later_transfer_on: '2026-03-02' }, inferred: null } })
    expect(t).toMatchObject({ entity: 'unknown', isEntity: null, use: 'unknown', basis: 'none', provenance: 'none' })
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
