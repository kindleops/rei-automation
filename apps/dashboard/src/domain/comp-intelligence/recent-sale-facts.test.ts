import { describe, expect, it } from 'vitest'
import type { RecentSale } from './comps-evidence-api'
import { recentSaleBuyer, recentSaleFlags, recentSaleOwnerKey, recentSaleView } from './recent-sale-facts'
import type { SaleOwnerRow } from '../../modules/market-intelligence/sale-owner/sale-owner-client'

export const SALE = (over: Partial<RecentSale> = {}): RecentSale => ({
  key: 'm:t:1', propertyId: 'P1', address: '1 Test St, Minneapolis, MN', city: null, state: null, zip: null, lat: 45, lng: -93,
  soldOn: '2026-09-01', price: 250000, priced: true, ppsf: 180, saleSource: 'public_record', docType: 'Warranty Deed',
  armsLength: null, cash: null, buyerCompany: null, buyerKind: null, buyerClass: 'unknown', investor: false, portfolioSize: 1,
  propertyType: 'Single Family', beds: 3, baths: 2, sqft: 1400, yearBuilt: 1950, units: 1, distanceMiles: 0.4, ...over,
})

describe('recent sale facts', () => {
  it('the resolver key strips the m: prefix to the canonical comp id', () => {
    expect(recentSaleOwnerKey({ key: 'm:t:123' })).toBe('t:123')
    expect(recentSaleOwnerKey({ key: 'm:p:abc' })).toBe('p:abc')
    expect(recentSaleOwnerKey({ key: 'bad key' })).toBeNull()
  })
  it('channel is Off market for public record, MLS for mls, with the foreclosure qualifier from the deed', () => {
    expect(recentSaleView(SALE(), []).channel.short).toBe('Off market')
    expect(recentSaleView(SALE({ saleSource: 'mls' }), []).channel.short).toBe('MLS')
    expect(recentSaleView(SALE({ docType: 'Trustee’s Deed' }), []).channel.qualifierLabel).toBe('Foreclosure / auction')
  })
  it('buyer: MV buyer kind / class first, then the owner of record, else "Buyer unknown"', () => {
    expect(recentSaleBuyer(SALE({ buyerKind: 'company', buyerCompany: 'Acme Homes LLC', buyerClass: 'llc_investor', investor: true })).label).toBe('LLC investor')
    expect(recentSaleBuyer(SALE({ buyerKind: 'person', buyerClass: 'individual' })).label).toBe('Individual')
    expect(recentSaleBuyer(SALE({ buyerClass: 'bank' })).label).toBe('Bank / REO')
    const owner: SaleOwnerRow = {
      buyer_of_record: { label: 'Individual (owner-occupant) · current owner of record', short: 'Individual (owner-occupant)', basis: 'current_owner_of_record', kind: 'individual', name: null, linked: true, reason: 'linked' },
      owner_link: null, inferred: null,
    }
    const occ = recentSaleBuyer(SALE(), owner)
    expect(occ).toMatchObject({ label: 'Owner-occupant', provenance: 'inferred' })
    expect(recentSaleBuyer(SALE()).label).toBe('Buyer unknown')
  })
  it('flags only what the record supports: cash, flip / resale, portfolio, non-arm’s-length', () => {
    expect(recentSaleFlags(SALE(), [])).toEqual([])
    const later = SALE({ key: 'm:t:2', soldOn: '2026-08-01', price: 300000, cash: true })
    const earlier = SALE({ key: 'm:t:3', soldOn: '2026-02-01', price: 200000 })
    const flags = recentSaleFlags(later, [later, earlier])
    expect(flags.map((f) => f.key)).toEqual(['cash', 'flip'])
    expect(flags[1].label).toBe('Flip · +50% in 6 mo')
    // same property, modest change, 18 months → resale, not a flip
    const resold = SALE({ key: 'm:t:4', soldOn: '2026-08-01', price: 210000 })
    const before = SALE({ key: 'm:t:5', soldOn: '2025-02-01', price: 200000 })
    expect(recentSaleFlags(resold, [resold, before]).map((f) => f.label)).toEqual(['Resale · 18 mo'])
    // a different property never makes a resale
    expect(recentSaleFlags(resold, [resold, { ...before, propertyId: 'P2' }])).toEqual([])
    expect(recentSaleFlags(SALE({ portfolioSize: 4, armsLength: false }), []).map((f) => f.label)).toEqual(['Portfolio of 4', 'Non-arm’s-length'])
  })
})
