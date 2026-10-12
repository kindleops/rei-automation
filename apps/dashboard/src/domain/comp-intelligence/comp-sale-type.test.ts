import { describe, expect, it } from 'vitest'
import { buyerClassOf, classifySaleType, countSaleTypes, engineSourceFactor, saleQualifierOf, saleTypeOfComp, saleTypeOfDealComp, saleTypeOfRecentSale, SALE_TYPE_LABEL } from './comp-sale-type'
import { compBuyerType } from './comp-buyer-type'

describe('the channel chip — MLS vs Off market, read from recorded fields only', () => {
  it('an MLS sold price makes it MLS — whoever bought it', () => {
    const v = classifySaleType({ corpus: 'engine_pool', mls: true, rawSource: 'MLS Sold' })
    expect(v).toMatchObject({ type: 'mls', short: 'MLS', qualifier: null })
    expect(v.evidence[0]).toMatch(/MLS sold price/)
    expect(classifySaleType({ rawSource: 'MLS Sold' }).type).toBe('mls')
    expect(classifySaleType({ engineSource: 'mls_sold' }).type).toBe('mls')
  })
  it('a recorded deed, "Public Record Sold", "Off-Market Sold" and investor_purchase are all Off market', () => {
    expect(classifySaleType({ corpus: 'transaction_corpus' }).short).toBe('Off market')
    expect(classifySaleType({ corpus: 'engine_pool', rawSource: 'Public Record Sold' }).type).toBe('off_market')
    expect(classifySaleType({ corpus: 'engine_pool', rawSource: 'Off-Market Sold' }).type).toBe('off_market')
    expect(classifySaleType({ engineSource: 'investor_purchase' }).type).toBe('off_market')
  })
  it('never guesses: no source field (the engine default public_record_sold is not evidence) is unknown', () => {
    const v = classifySaleType({ corpus: 'engine_pool', mls: false, rawSource: null, engineSource: 'public_record_sold' })
    expect(v.type).toBe('unknown')
    expect(classifySaleType({}).short).toBe('Channel unknown')
    expect(classifySaleType({ corpus: 'engine_pool', rawSource: 'Something Else' }).type).toBe('unknown')
  })
  it('the forced-sale qualifier rides inside the channel chip: Foreclosure / auction, REO', () => {
    expect(classifySaleType({ corpus: 'transaction_corpus', docType: 'Trustee’s Deed' })).toMatchObject({ type: 'off_market', qualifier: 'foreclosure', qualifierLabel: 'Foreclosure / auction' })
    expect(classifySaleType({ corpus: 'transaction_corpus', docType: "Sheriff's Deed" }).qualifier).toBe('foreclosure')
    expect(classifySaleType({ corpus: 'transaction_corpus', sellerKind: 'bank' }).qualifierLabel).toBe('REO')
    expect(classifySaleType({ corpus: 'transaction_corpus', docType: 'Warranty Deed' }).qualifier).toBeNull()
    expect(saleQualifierOf({ docType: null, sellerKind: 'person' })).toBeNull()
  })
  it('the channel never carries a buyer word — the buyer is its own chip (no duplicates)', () => {
    for (const t of Object.values(SALE_TYPE_LABEL)) expect(t.short).not.toMatch(/investor|llc|individual|company|buyer/i)
    // the owner's two cases: "Investor" + "Company/Investor", and "MLS" + "investor buyer" + "LLC investor"
    const mlsLlc = classifySaleType({ corpus: 'engine_pool', mls: true, rawSource: 'MLS Sold' })
    const mlsBuyer = compBuyerType({ buyerKind: 'company', buyerCompany: 'Pinewood LLC' })
    expect([mlsLlc.short, mlsBuyer.label]).toEqual(['MLS', 'LLC investor'])
    const offCo = classifySaleType({ corpus: 'engine_pool', rawSource: 'Public Record Sold' })
    const offBuyer = compBuyerType({ buyerKind: 'company', buyerCompany: null })
    expect([offCo.short, offBuyer.label]).toEqual(['Off market', 'LLC investor'])
  })
})

describe('buyer class (kept for API-shaped callers)', () => {
  it('reads archetype before the name heuristic', () => {
    expect(buyerClassOf({ buyerKind: 'person', buyerArchetype: 'institutional_high_volume_buyer' }).buyer).toBe('institutional')
    expect(buyerClassOf({ buyerKind: 'company' }).buyer).toBe('investor')
    expect(buyerClassOf({ buyerKind: 'individual' }).buyer).toBe('individual')
    expect(buyerClassOf({}).buyer).toBe('unknown')
  })
})

describe('adapters', () => {
  it('Comp Intelligence rows: pool rows, canonical rows and deeds', () => {
    const base = { corpus: 'engine_pool' as const, mls: false, engine: null }
    expect(saleTypeOfComp({ ...base, saleSourceRaw: null }).type).toBe('unknown')
    expect(saleTypeOfComp({ ...base, saleSourceRaw: 'Off-Market Sold' }).type).toBe('off_market')
    expect(saleTypeOfComp({ ...base, mls: true, saleSourceRaw: 'MLS Sold' }).type).toBe('mls')
    expect(saleTypeOfComp({ corpus: 'canonical_corpus', mls: false, saleSourceRaw: 'public_record' }).type).toBe('off_market')
    expect(saleTypeOfComp({ corpus: 'transaction_corpus', mls: false, docType: 'Trustee’s Deed' }).qualifier).toBe('foreclosure')
  })
  it('Deal Intelligence comps: mls_sold_price wins; a public-record sale is off market', () => {
    expect(saleTypeOfDealComp({ saleSource: 'MLS Sold', mlsSoldPrice: 210000, source: 'mls_sold' }).type).toBe('mls')
    expect(saleTypeOfDealComp({ saleSource: 'Public Record Sold', mlsSoldPrice: null, source: 'public_record_sold' }).type).toBe('off_market')
    expect(saleTypeOfDealComp({ saleSource: null, mlsSoldPrice: null, source: 'public_record_sold' }).type).toBe('unknown')
  })
  it('recent market sales: mls → MLS, public_record → Off market (+ qualifier from the doc type)', () => {
    expect(saleTypeOfRecentSale({ saleSource: 'mls' }).short).toBe('MLS')
    expect(saleTypeOfRecentSale({ saleSource: 'public_record', docType: 'Warranty Deed' })).toMatchObject({ short: 'Off market', qualifier: null })
    expect(saleTypeOfRecentSale({ saleSource: 'public_record', docType: 'Sheriff’s Deed' }).qualifierLabel).toBe('Foreclosure / auction')
  })
  it('engine source factor mirrors the weight formula (MLS ×1, other ×0.92)', () => {
    expect(engineSourceFactor('mls_sold')).toEqual({ mls: true, factor: 1 })
    expect(engineSourceFactor('public_record_sold')).toEqual({ mls: false, factor: 0.92 })
    expect(engineSourceFactor(null)).toBeNull()
  })
  it('counts a split', () => {
    expect(countSaleTypes(['mls', 'mls', 'unknown'] as const, (t) => t)).toEqual({ mls: 2, off_market: 0, unknown: 1 })
  })
})
