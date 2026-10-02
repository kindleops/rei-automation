import { describe, expect, it } from 'vitest'
import { buyerClassOf, classifySaleType, countSaleTypes, engineSourceFactor, saleTypeOfComp, saleTypeOfDealComp } from './comp-sale-type'

describe('classifySaleType — read from recorded fields only', () => {
  it('an MLS sold price makes it an MLS sale, and an investor buyer stays a separate fact', () => {
    const v = classifySaleType({ corpus: 'engine_pool', mls: true, rawSource: 'MLS Sold', buyerKind: 'company' })
    expect(v.type).toBe('mls')
    expect(v.label).toBe('MLS sale')
    expect(v.buyer).toBe('investor')
    expect(v.evidence[0]).toMatch(/MLS sold price/)
  })

  it('the record source "MLS Sold" alone is MLS evidence; so is the engine code mls_sold', () => {
    expect(classifySaleType({ rawSource: 'MLS Sold' }).type).toBe('mls')
    expect(classifySaleType({ engineSource: 'mls_sold' }).type).toBe('mls')
  })

  it('a non-MLS sale to a company is an investor purchase', () => {
    const v = classifySaleType({ corpus: 'engine_pool', mls: false, rawSource: 'Public Record Sold', buyerKind: 'company' })
    expect(v.type).toBe('investor')
    expect(v.evidence.join(' ')).toMatch(/company/)
  })

  it('a recorded deed whose buyer the index calls institutional is an institutional investor purchase', () => {
    const v = classifySaleType({ corpus: 'transaction_corpus', mls: false, buyerKind: 'company', buyerArchetype: 'institutional_high_volume_buyer' })
    expect(v.type).toBe('investor')
    expect(v.buyer).toBe('institutional')
    expect(v.evidence).toContain('Recorded deed — no MLS record')
  })

  it('a person with an acquirer archetype counts as an investor buyer', () => {
    expect(classifySaleType({ corpus: 'transaction_corpus', buyerKind: 'person', buyerArchetype: 'active_flipper' }).type).toBe('investor')
    // insufficient evidence is not an archetype
    expect(classifySaleType({ corpus: 'transaction_corpus', buyerKind: 'person', buyerArchetype: 'insufficient_evidence' }).type).toBe('public_record')
  })

  it('the engine code investor_purchase is investor evidence on its own', () => {
    expect(classifySaleType({ engineSource: 'investor_purchase' }).type).toBe('investor')
  })

  it('off-market sold to an individual is an off-market sale', () => {
    expect(classifySaleType({ corpus: 'engine_pool', rawSource: 'Off-Market Sold', buyerKind: 'individual' }).type).toBe('off_market')
  })

  it('a deed or "Public Record Sold" to an individual or unknown buyer is public record', () => {
    expect(classifySaleType({ corpus: 'transaction_corpus', buyerKind: 'person' }).type).toBe('public_record')
    expect(classifySaleType({ corpus: 'engine_pool', rawSource: 'Public Record Sold', buyerKind: null }).type).toBe('public_record')
  })

  it('never guesses: no source field means unknown — the engine default public_record_sold is not evidence', () => {
    const v = classifySaleType({ corpus: 'engine_pool', mls: false, rawSource: null, engineSource: 'public_record_sold', buyerKind: 'person' })
    expect(v.type).toBe('unknown')
    expect(v.label).toBe('Sale type unknown')
    expect(classifySaleType({}).type).toBe('unknown')
  })

  it('an unrecognized source text is unknown, not public record', () => {
    expect(classifySaleType({ corpus: 'engine_pool', rawSource: 'Something Else' }).type).toBe('unknown')
  })
})

describe('buyer class', () => {
  it('reads archetype before the name heuristic', () => {
    expect(buyerClassOf({ buyerKind: 'person', buyerArchetype: 'institutional_high_volume_buyer' }).buyer).toBe('institutional')
    expect(buyerClassOf({ buyerKind: 'company' }).buyer).toBe('investor')
    expect(buyerClassOf({ buyerKind: 'individual' }).buyer).toBe('individual')
    expect(buyerClassOf({}).buyer).toBe('unknown')
  })
})

describe('adapters', () => {
  it('Comp Intelligence rows: a pool row with no detail sale_source and no MLS price is unknown', () => {
    const base = { corpus: 'engine_pool' as const, mls: false, buyerKind: null, engine: null }
    expect(saleTypeOfComp({ ...base, saleSourceRaw: null }).type).toBe('unknown')
    expect(saleTypeOfComp({ ...base, saleSourceRaw: 'Off-Market Sold' }).type).toBe('off_market')
    expect(saleTypeOfComp({ ...base, mls: true, saleSourceRaw: 'MLS Sold' }).type).toBe('mls')
  })

  it('Deal Intelligence comps: mls_sold_price wins; LLC buyer on a public-record sale is investor', () => {
    expect(saleTypeOfDealComp({ saleSource: 'MLS Sold', mlsSoldPrice: 210000, source: 'mls_sold', buyerKind: 'company' }).type).toBe('mls')
    expect(saleTypeOfDealComp({ saleSource: 'Public Record Sold', mlsSoldPrice: null, source: 'public_record_sold', buyerKind: 'company' }).type).toBe('investor')
    expect(saleTypeOfDealComp({ saleSource: null, mlsSoldPrice: null, source: 'public_record_sold', buyerKind: 'unknown' }).type).toBe('unknown')
  })

  it('engine source factor mirrors the weight formula (MLS ×1, other ×0.92)', () => {
    expect(engineSourceFactor('mls_sold')).toEqual({ mls: true, factor: 1 })
    expect(engineSourceFactor('public_record_sold')).toEqual({ mls: false, factor: 0.92 })
    expect(engineSourceFactor(null)).toBeNull()
  })

  it('counts a split', () => {
    const c = countSaleTypes(['mls', 'mls', 'unknown'] as const, (t) => t)
    expect(c).toEqual({ mls: 2, investor: 0, off_market: 0, public_record: 0, unknown: 1 })
  })
})
