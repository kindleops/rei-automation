import { describe, expect, it } from 'vitest'
import type { WindowTransaction } from '../../../domain/buyer-match/buyer-match-workspace-api'
import { assignBuyerColors, buildGeoModel, buyerGeoLabel, GEO_OTHER, GEO_PALETTE, listOrder, pointCollection, radiusBounds } from './buyer-geo-model'

const subject = { lat: 44.98, lng: -93.27 }
const tx = (i: number, buyerId: string, dLat = 0.001 * i, extra: Partial<WindowTransaction> = {}): WindowTransaction => ({
  txnId: i, buyerId, propertyId: `p${i}`, lat: subject.lat + dLat, lng: subject.lng, address: `${i} Main St, City`, city: 'City', zip: '55411',
  date: '2026-05-01', price: 150_000 + i, nominal: false, family: 'single_family', sameFamily: true, beds: 3, baths: 1, sqft: 1200, yearBuilt: 1950,
  cash: true, docType: 'Warranty Deed', miles: null, ...extra,
})
const buyers = [
  { id: 'A', name: 'Alpha Homes LLC', kind: 'company' as const, nameWithheld: false },
  { id: 'B', name: 'Beta Holdings LLC', kind: 'company' as const, nameWithheld: false },
  { id: 'C', name: 'Secret Name LLC', kind: 'company' as const, nameWithheld: true },
  { id: 'P', name: 'Jane Person', kind: 'person' as const, nameWithheld: false },
]
const ws = (rows: WindowTransaction[], radius = 1) => ({
  subject: { ...subject } as never,
  query: { radiusMiles: radius, months: 24, radiusOptions: [1, 2, 5], monthOptions: [12, 24] },
  transactions: { available: true, reason: null, radiusMiles: radius, months: 24, total: rows.length, returned: rows.length, truncated: false, rows },
})

describe('buyer geography model', () => {
  it('colours by buyer, most active first, stable across calls; ties break by id', () => {
    const rows = [tx(1, 'B'), tx(2, 'B'), tx(3, 'A'), tx(4, 'C'), tx(5, 'A'), tx(6, 'B')]
    const known = new Set(['A', 'B', 'C'])
    const a = assignBuyerColors(rows, known, null)
    expect(a.get('B')).toEqual({ key: 'b0', color: GEO_PALETTE[0] })
    expect(a.get('A')?.key).toBe('b1')
    expect(a.get('C')?.key).toBe('b2')
    expect(assignBuyerColors([...rows].reverse(), known, null)).toEqual(a)
    const tie = assignBuyerColors([tx(1, 'B'), tx(2, 'A')], known, null)
    expect(tie.get('A')?.key).toBe('b0')
  })

  it('buyers beyond the palette fall into the neutral "Other buyers" bucket; the selected buyer always gets a colour', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `X${i}`)
    const rows = ids.flatMap((id, i) => Array.from({ length: 10 - i }, (_, j) => tx(i * 20 + j, id, 0.0005)))
    const many = ids.map((id) => ({ id, name: `${id} LLC`, kind: 'company' as const }))
    const m = buildGeoModel({ w: ws(rows) as never, buyers: many, selectedId: null })
    const other = m.points.filter((p) => p.colorKey === 'other')
    expect(other.length).toBeGreaterThan(0)
    expect(other.every((p) => p.color === GEO_OTHER)).toBe(true)
    expect(m.legend.at(-1)?.label).toBe('Other buyers')
    const sel = buildGeoModel({ w: ws(rows) as never, buyers: many, selectedId: 'X9' })
    expect(sel.points.find((p) => p.buyerId === 'X9')?.colorKey).not.toBe('other')
  })

  it('never names a person or a withheld company', () => {
    expect(buyerGeoLabel(buyers[3])).toBe('Private individual')
    expect(buyerGeoLabel(buyers[2])).toBe('Registered entity')
    expect(buyerGeoLabel(buyers[0])).toBe('Alpha Homes LLC')
    const m = buildGeoModel({ w: ws([tx(1, 'C'), tx(2, 'P'), tx(3, 'A')]) as never, buyers, selectedId: null })
    const text = JSON.stringify([m.points.map((p) => p.buyerLabel), m.legend.map((l) => l.label)])
    expect(text).not.toContain('Secret Name')
    expect(text).not.toContain('Jane')
  })

  it('keeps only purchases inside the radius, by buyers on the page', () => {
    const rows = [tx(1, 'A', 0.005), tx(2, 'A', 0.05), tx(3, 'Z', 0.001), tx(4, 'B', 0.01, { miles: 3 })]
    const m = buildGeoModel({ w: ws(rows, 1) as never, buyers, selectedId: null })
    expect(m.points.map((p) => p.key)).toEqual(['t:1'])
    expect(m.outside).toBe(3)
    expect(m.points[0].miles).toBeGreaterThan(0)
  })

  it('emphasises the selected buyer and dims the rest; the list puts it first', () => {
    const rows = [tx(1, 'A', 0.001), tx(2, 'B', 0.002), tx(3, 'B', 0.003)]
    const m = buildGeoModel({ w: ws(rows) as never, buyers, selectedId: 'B' })
    expect(m.points.filter((p) => p.selected).map((p) => p.buyerId)).toEqual(['B', 'B'])
    const fc = pointCollection(m.points, true)
    expect(fc.features.find((f) => f.id === 't:1')?.properties).toMatchObject({ sel: 0, dim: 1 })
    expect(fc.features.find((f) => f.id === 't:2')?.properties).toMatchObject({ sel: 1, dim: 0 })
    expect(listOrder(m.points).slice(0, 2).every((p) => p.selected)).toBe(true)
    expect(m.legend.find((l) => l.buyerId === 'B')?.selected).toBe(true)
  })

  it('falls back to the selected buyer’s own purchases and holdings without a window read', () => {
    const w = { ...ws([]), transactions: undefined }
    const receipts = [{ key: 'r1', lat: subject.lat + 0.001, lng: subject.lng, miles: 0.07, address: '1 A St', city: 'C', date: '2026-01-01', price: 1, nominal: false, family: 'sf', sameFamily: true }, { key: 'r2', lat: null, lng: null }] as never
    const holdings = [{ key: 'o:1', propertyId: '1', address: '2 B St', lat: subject.lat, lng: subject.lng + 0.001, miles: 0.05, value: 9, propertyType: 'SFR', basis: 'Owns' }]
    const m = buildGeoModel({ w: w as never, buyers, selectedId: 'A', receipts, holdings })
    expect(m.source).toBe('selected')
    expect(m.points.map((p) => p.kind)).toEqual(['purchase', 'holding'])
    expect(m.legend.map((l) => l.label)).toEqual(['Alpha Homes LLC', 'Holdings'])
  })

  it('radius bounds contain the radius', () => {
    const [[w, s], [e, n]] = radiusBounds(subject.lat, subject.lng, 1)
    expect(n - s).toBeCloseTo(2 / 69, 5)
    expect(e - w).toBeGreaterThan(n - s)
  })
})
