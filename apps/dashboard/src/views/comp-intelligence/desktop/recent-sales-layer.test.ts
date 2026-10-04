import { describe, expect, it } from 'vitest'
import type { RecentSale } from '../../../domain/comp-intelligence/comps-evidence-api'
import { RECENT_LAYER_LABEL, recentCollection, recentPoints, rgba, squareImage } from './recent-sales-layer'

const row = (over: Partial<RecentSale>): RecentSale => ({
  key: 'm:t:1', propertyId: null, address: '1 Main St', city: null, state: null, zip: null, lat: 45.02, lng: -93.29,
  soldOn: '2026-08-17', price: 250000, priced: true, ppsf: 200, saleSource: 'public_record', docType: null, armsLength: null, cash: null,
  buyerCompany: null, buyerClass: null, investor: false, portfolioSize: 1, propertyType: null, beds: null, baths: null, sqft: null,
  yearBuilt: null, units: null, distanceMiles: 0.4, ...over,
})

describe('recent market sales map layer', () => {
  it('is labelled as outside the valuation', () => {
    expect(RECENT_LAYER_LABEL).toBe('Recent market sales · not in valuation')
  })

  it('draws only rows with coordinates, and activity-only rows carry no price', () => {
    const pts = recentPoints([
      row({ key: 'm:a' }),
      row({ key: 'm:b', price: null, priced: false }),
      row({ key: 'm:c', lat: null, lng: null }),
      row({ key: 'm:d', lat: 0, lng: 0 }),
    ], (n) => `$${n / 1000}K`)
    expect(pts.map((p) => [p.key, p.priced, p.label])).toEqual([['m:a', true, '$250K'], ['m:b', false, 'activity']])
  })

  it('is its own collection, empty when toggled off', () => {
    const pts = recentPoints([row({})], String)
    const on = recentCollection(pts, true)
    expect(on.features).toHaveLength(1)
    expect(on.features[0].properties).toMatchObject({ layer: 'recent_market_sales', priced: 1 })
    // no evidence tier is ever attached, so no evidence paint can match it
    expect(on.features[0].properties).not.toHaveProperty('tier')
    expect(recentCollection(pts, false).features).toHaveLength(0)
  })

  it('builds solid (priced) and hollow (activity) square markers as raw pixels', () => {
    expect(rgba('#fff')).toEqual([255, 255, 255, 255])
    expect(rgba('rgba(4,6,11,0.5)')).toEqual([4, 6, 11, 128])
    const solid = squareImage(28, '#eef2f8', 'rgba(4,6,11,0.88)', false)
    const hollow = squareImage(28, '#eef2f8', 'rgba(4,6,11,0.88)', true)
    expect(solid.data).toHaveLength(28 * 28 * 4)
    const centre = (img: typeof solid) => img.data[(14 * 28 + 14) * 4 + 3]
    expect(centre(solid)).toBe(255)
    expect(centre(hollow)).toBe(0)
    expect(solid.data[3]).toBe(0) // corner transparent
  })
})
