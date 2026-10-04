import { describe, expect, it } from 'vitest'
import {
  CORPUS_LABEL,
  DASH,
  buildCompCardModel,
  compSubjectFrom,
  corpusOf,
  credibleUnits,
  hoverPreviewFromFeature,
  pricePerUnit,
  type CompRecord,
} from './comp-card-model'

const NOW = Date.parse('2026-10-04T12:00:00Z')

const deed = (over: Partial<CompRecord> = {}): CompRecord => ({
  comp_id: 't:991',
  source: 'public_record',
  sold_on: '2026-08-19',
  price: 412500,
  ppsf: 275,
  lat: 45.0229,
  lng: -93.2954,
  property_id: '273330226',
  address: '3722 FREMONT AVE N, MINNEAPOLIS, MN 55412',
  city: 'MINNEAPOLIS',
  state: 'mn',
  zip: '55412',
  property_type: 'Single Family',
  beds: 3,
  baths: 2.5,
  sqft: 1500,
  year_built: 1924,
  units: null,
  buyer: 'MAPLE HOLDINGS LLC',
  buyer_class: 'llc_investor',
  buyer_kind: 'company',
  is_investor: true,
  portfolio_size: 1,
  sources: 'T',
  price_src: 'T',
  observations: 2,
  is_cash_purchase: true,
  is_arms_length: true,
  doc_type: 'Warranty Deed',
  details: { lot_square_feet: 5200, apn: '123-45', corpus: 'comp + seller' },
  ...over,
})

describe('corpus label — market sale (display) vs valuation comp in the engine pool', () => {
  it('labels a deed-only sale as a display-only market sale', () => {
    const m = buildCompCardModel(deed({ sources: 'T' }), null, NOW)
    expect(m.corpus).toBe('market_sale')
    expect(m.corpusTitle).toBe('Market sale · display only')
    expect(m.corpusNote).toMatch(/not in the valuation/)
  })
  it('labels a sale whose cluster holds an engine-pool observation as a valuation comp', () => {
    expect(buildCompCardModel(deed({ sources: 'PT' }), null, NOW).corpusTitle).toBe('Valuation comp · engine pool')
    expect(corpusOf('p:4411', null)).toBe('engine_pool')
  })
  it('says nothing about a deed id before hydration tells it the sources', () => {
    expect(corpusOf('t:991', undefined)).toBeNull()
    expect(CORPUS_LABEL.engine_pool.title).toMatch(/engine pool/)
  })
})

describe('price per unit needs a real positive unit count', () => {
  it('never divides by an inferred 1', () => {
    expect(pricePerUnit(400000, null, 'Multi-Family', 3000)).toBeNull()
    expect(pricePerUnit(400000, 0, 'Multi-Family', 3000)).toBeNull()
    expect(pricePerUnit(400000, undefined, 'Multi-Family', 3000)).toBeNull()
    const m = buildCompCardModel(deed({ units: null }), null, NOW)
    expect(m.ppu).toBe(DASH)
    expect(m.specs.find((s) => s.label === 'Units')?.value).toBe(DASH)
  })
  it('divides by a recorded unit count', () => {
    expect(pricePerUnit(800000, 4, 'Multi-Family', 4000)).toBe(200000)
    expect(buildCompCardModel(deed({ units: 4, property_type: 'Multi-Family', price: 800000, sqft: 4000 }), null, NOW).ppu).toBe('$200K')
  })
  it('refuses a single-family record whose unit count fails ≥350 sf/unit', () => {
    expect(credibleUnits(12, 'Single Family', 1800).units).toBeNull()
    expect(credibleUnits(3, 'Single Family', null).units).toBeNull()
    expect(credibleUnits(2, 'Single Family', 2400).units).toBe(2)
    const m = buildCompCardModel(deed({ units: 12, sqft: 1800 }), null, NOW)
    expect(m.ppu).toBe(DASH)
    expect(m.ppuHint).toMatch(/not credible/)
  })
  it('uses the per-door figure for a portfolio sale', () => {
    const m = buildCompCardModel(deed({ portfolio_size: 5, price: 1_000_000, per_door: 200_000, units: 2, property_type: 'Duplex', sqft: 1800 }), null, NOW)
    expect(m.headline).toBe('$200,000')
    expect(m.headlineBasis).toBe('per door')
    expect(m.ppu).toBe('$100K')
  })
})

describe('missing data shows "—", never 0', () => {
  const bare = deed({ price: 0, ppsf: null, beds: 0, baths: null, sqft: null, year_built: 0, units: null, estimated_value: null, is_cash_purchase: null, is_arms_length: null, doc_type: null, observations: null, details: null, price_src: null, buyer: null, buyer_kind: null, buyer_class: 'unknown', sold_on: null })
  const m = buildCompCardModel(bare, null, NOW)
  it('renders every absent figure as the dash', () => {
    expect(m.headline).toBe(DASH)
    expect(m.priced).toBe(false)
    expect(m.ppsf).toBe(DASH)
    expect(m.ppu).toBe(DASH)
    expect(m.estimatedValue).toBe(DASH)
    expect(m.saleDate).toBe(DASH)
    for (const f of [...m.specs.filter((s) => s.label !== 'Type'), ...m.money]) expect(f.value).toBe(DASH)
    expect(m.buyer.name).toBe('Buyer not on record')
  })
  it('never prints a zero for a missing number', () => {
    const json = JSON.stringify(m)
    expect(json).not.toMatch(/"\$0"|"0"|"0 sf"|"0 mi"/)
  })
  it('the hover preview dashes what the feature does not carry', () => {
    const h = hoverPreviewFromFeature({ comp_id: 't:1', n: 1, price: 0, sold_on: null }, [-93.29, 45.02], null, NOW)
    expect(h.headline).toBe(DASH)
    expect(h.specs.map((s) => s.value)).toEqual([DASH, DASH, DASH, DASH])
  })
})

describe('hover preview — only what the feature carries (no I/O)', () => {
  const subject = { lat: 45.03, lng: -93.30, propertyId: '1', estimatedValue: 380000, sqft: 1400 }
  it('shows price, date, age and distance to the subject from the feature', () => {
    const h = hoverPreviewFromFeature({ comp_id: 't:991', n: 1, price: 412500, sold_on: '2026-08-19', source: 'mls', buyer_class: 'individual', portfolio_size: 1 }, [-93.2954, 45.0229], subject, NOW)
    expect(h.headline).toBe('$413K')
    expect(h.date).toBe('Aug 19, 2026')
    expect(h.age).toBe('2 mo ago')
    expect(h.distance).toMatch(/mi|ft/)
    expect(h.source).toBe('MLS sale')
    expect(h.buyer).toBe('Individual buyer')
  })
  it('fills specs from a record already hydrated by an earlier click', () => {
    const h = hoverPreviewFromFeature({ comp_id: 't:991', n: 1, price: 412500 }, [-93.2954, 45.0229], null, NOW, deed())
    expect(h.specs.map((s) => s.value)).toEqual(['$275', '3', '2.5', '1,500'])
    expect(h.corpus).toBe('market_sale')
  })
  it('labels a cluster as an average over its sales', () => {
    const h = hoverPreviewFromFeature({ comp_id: null, n: 14, price: 300000, sold_on: '2026-09-01' }, [-93.3, 45.0], null, NOW)
    expect(h.cluster).toBe(true)
    expect(h.headlineNote).toBe('average')
    expect(h.specs).toEqual([])
  })
})

describe('buyer identity — Buyer Match rules', () => {
  it('never names a person buyer', () => {
    const m = buildCompCardModel(deed({ buyer_kind: 'person', buyer_class: 'individual', buyer: 'JOHN Q PUBLIC', is_investor: false }), null, NOW)
    expect(m.buyer.name).toBe('Individual buyer')
    expect(m.buyer.withheld).toBe(true)
    expect(JSON.stringify(m)).not.toMatch(/JOHN|John Q/)
  })
  it('names a company and keeps entity ownership apart from an investor purchase', () => {
    const m = buildCompCardModel(deed({ is_investor: false, buyer: null, buyer_kind: null, buyer_class: 'unknown', investor_inferred_current_owner: true }), null, NOW)
    expect(m.buyer.investor).toBe(false)
    expect(m.buyer.entityNote).toMatch(/not an investor purchase/)
    expect(buildCompCardModel(deed(), null, NOW).buyer.name).toBe('Maple Holdings LLC')
  })
})

describe('against the selected subject', () => {
  it('compares the sale with the subject ESTIMATE, labelled as such', () => {
    const m = buildCompCardModel(deed(), { lat: 45.03, lng: -93.3, label: 'Subject', estimatedValue: 375000, sqft: 1500 }, NOW)
    const [dist, dPrice, dPpsf] = m.subject!.deltas
    expect(dist.value).toMatch(/mi|ft/)
    expect(dPrice.value).toBe('+$38K · +10%')
    expect(dPrice.direction).toBe('up')
    expect(dPrice.basis).toMatch(/estimated value/)
    expect(dPpsf.value).toBe('+$25 · +10%')
  })
  it('dashes a delta the subject cannot support', () => {
    const m = buildCompCardModel(deed(), { lat: 45.03, lng: -93.3, estimatedValue: null, sqft: null }, NOW)
    expect(m.subject!.deltas[1].value).toBe(DASH)
    expect(m.subject!.deltas[2].value).toBe(DASH)
  })
  it('reads the subject from the selected card record and its map position', () => {
    const rec = { property_id: 7, property_address_full: '10 MAIN ST, X', estimated_value: 0, building_square_feet: 1200 }
    const s = compSubjectFrom(rec, [-93.3, 45.0])!
    expect(s).toMatchObject({ propertyId: '7', label: '10 Main St', estimatedValue: null, sqft: 1200 })
    expect(compSubjectFrom(rec, [-93.3, 45.0])).toBe(s)
    expect(compSubjectFrom(rec, null)).toBeNull()
  })
})

describe('cash and financing evidence', () => {
  it('shows only what the record holds', () => {
    const m = buildCompCardModel(deed({ is_cash_purchase: false, details: { financing: 'conventional_loan' } }), null, NOW)
    expect(m.money.find((f) => f.label === 'Payment')?.value).toBe('Financed')
    expect(m.money.find((f) => f.label === 'Financing')?.value).toBe('Conventional Loan')
    expect(buildCompCardModel(deed(), null, NOW).money.find((f) => f.label === 'Payment')?.value).toBe('Cash')
  })
})
