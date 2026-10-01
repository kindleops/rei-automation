import { describe, expect, it } from 'vitest'
import type { CompsWorkspace, EvidenceComp } from '../../../domain/comp-intelligence/comps-evidence-api'
import { NO_FILTERS } from '../../../domain/comp-intelligence/comps-workstation-model'
import { deriveWorkstation } from './derive-workstation'
import type { OperatorState } from './use-operator-set'

const comp = (key: string, over: Partial<EvidenceComp> = {}): EvidenceComp => ({
  key, corpus: 'engine_pool', compId: key, propertyId: `P-${key}`, address: `${key} Test St`, city: 'Minneapolis', zip: '55430',
  lat: 45.05, lng: -93.31, salePrice: 280000, saleDate: '2026-05-01', distanceMiles: 0.5, propertyType: 'Single Family', units: 1,
  beds: 3, baths: 1, sqft: 1100, lotSqft: 5000, yearBuilt: 1955, condition: 'Average', renovation: null, ppsf: 255, ppu: 280000,
  source: 'MLS sold', mls: true, buyerKind: null, buyerCompany: null, buyerId: null, buyerAcquisitions: null, buyerActivity: null,
  sellerKind: null, armsLength: null, cash: null, docType: null, photo: null, assetMatch: true, state: 'candidate', reasons: [],
  engine: { origin: 'live', eligible: true, reasons: [], score: 90, completeness: 60, weight: 0.6, adjustedPrice: 280000, saleSource: 'mls_sold' },
  compare: { sqftPct: 0, beds: 0, baths: 0, years: 1, lotPct: 0, units: 0, days: 150 },
  ...over,
})

// Two stored system comps whose stored valuation the replay must reproduce.
const s1 = comp('s1', { state: 'system', engine: { origin: 'stored', eligible: true, reasons: [], score: 96.52, completeness: 62.39, weight: 0.7794, adjustedPrice: 263300, saleSource: 'mls_sold' } })
const s2 = comp('s2', { state: 'system', engine: { origin: 'stored', eligible: true, reasons: [], score: 94.22, completeness: 62.39, weight: 0.7496, adjustedPrice: 300700, saleSource: 'mls_sold' } })
const c1 = comp('c1', { distanceMiles: 0.4 })
const c2 = comp('c2', { distanceMiles: 3.2 })
const x1 = comp('x1', { state: 'excluded', engine: { origin: 'live', eligible: false, reasons: ['outside_radius'] }, reasons: [{ code: 'outside_radius', label: 'x' }], distanceMiles: 4.4 })

const w = {
  generatedAt: '2026-10-01T15:00:00Z',
  query: { radiusMiles: 4, months: 30, radiusOptions: [1, 2, 4], monthOptions: [12, 30] },
  subject: { propertyId: 'S', address: 'Subject', city: null, state: null, zip: '55430', lat: 45.048, lng: -93.311, propertyType: 'Single Family', family: 'residential', familyLabel: 'Single family', units: 1, beds: 3, baths: 1.5, sqft: 1122, lotSqft: 6098, yearBuilt: 1954, condition: 'Average', estimatedValue: 260000, mlsStatus: null, mlsListPrice: null, dimensions: [] },
  counts: { system: 2, candidates: 2, excluded: 1, enginePool: 5, transactions: 0, transactionsInRadius: 0, transactionsSameFamily: 0, transactionsReturned: 0 },
  systemStats: { count: 2, medianPrice: null, low: null, high: null, medianPpsf: null, medianPpu: null, medianAdjusted: null, medianDistance: null, medianAgeDays: null },
  sufficiency: { level: 'moderate', usable: 4, withinMile: 3, withinMileLastYear: 3 },
  conclusion: null,
  market: null,
  comps: [s1, s2, c1, c2, x1],
} as unknown as CompsWorkspace

const operatorWith = (keys: string[], snapshots: Record<string, EvidenceComp> = {}): OperatorState => ({
  propertyId: 'S', base: 'system', versions: [{ v: 1, at: 0, keys, change: { kind: 'exclude', key: 's1', address: null } }], snapshots,
})

describe('the workstation derivation', () => {
  it('without an operator set the lens is the system set', () => {
    const m = deriveWorkstation(w, null, null, 'operator', NO_FILTERS)
    expect(m.lens).toBe('system')
    expect(m.lensComps.map((c) => c.key)).toEqual(['s1', 's2'])
    expect(m.candidates.map((c) => c.key)).toEqual(['c1', 'c2'])
    expect(m.excluded.map((c) => c.key)).toEqual(['x1'])
    expect(m.universeCount).toBe(4)
    expect(m.excludedCount).toBe(1)
  })

  it('an operator set shows what was removed and added, and keeps the system set intact', () => {
    const op = operatorWith(['s2', 'c1'])
    const m = deriveWorkstation(w, op, new Set(['s2', 'c1']), 'operator', NO_FILTERS)
    expect(m.lens).toBe('operator')
    expect(m.lensComps.map((c) => c.key).sort()).toEqual(['c1', 's2'])
    expect(m.removed.map((c) => c.key)).toEqual(['s1'])
    expect([...m.added]).toEqual(['c1'])
    expect(m.tiers.get('s1')).toBe('removed')
    expect(m.tiers.get('c1')).toBe('added')
    expect([...m.systemKeys].sort()).toEqual(['s1', 's2'])
    expect(m.candidates.map((c) => c.key)).toEqual(['c2'])
    expect(m.systemReplay.result?.count).toBe(2)
    expect(m.operatorReplay?.result?.count).toBe(2)
  })

  it('switching the lens back to system keeps the operator set for comparison', () => {
    const m = deriveWorkstation(w, operatorWith(['s2']), new Set(['s2']), 'system', NO_FILTERS)
    expect(m.lens).toBe('system')
    expect(m.lensComps.map((c) => c.key)).toEqual(['s1', 's2'])
    expect(m.operatorReplay?.result?.count).toBe(1)
  })

  it('filters narrow the universe, never the shown set', () => {
    const m = deriveWorkstation(w, null, null, 'system', { ...NO_FILTERS, maxDistance: 1 })
    expect(m.lensComps.map((c) => c.key)).toEqual(['s1', 's2'])
    expect(m.candidates.map((c) => c.key)).toEqual(['c1'])
    expect(m.excluded).toEqual([])
  })

  it('a comp the operator added stays priced after it leaves the loaded search', () => {
    const gone = comp('gone', { distanceMiles: 6, engine: { origin: 'live', eligible: true, reasons: [], score: 80, completeness: 55, weight: 0.5, adjustedPrice: 310000, saleSource: 'mls_sold' } })
    const m = deriveWorkstation(w, operatorWith(['s1', 's2', 'gone'], { gone }), new Set(['s1', 's2', 'gone']), 'operator', NO_FILTERS)
    expect(m.lensComps.find((c) => c.key === 'gone')?.outsideSearch).toBe(true)
    expect(m.operatorReplay?.result?.count).toBe(3)
  })

  it('a stored record-estimate fallback is never treated as a comparable valuation', () => {
    const fallback = { ...w, conclusion: { valueLow: 213200, valueMid: 260000, valueHigh: 299000, valuationConfidence: 25, recommendedOffer: null, floor: null, tier: null, computedAt: null, ask: null, method: 'subject_value_fallback' } } as CompsWorkspace
    const m = deriveWorkstation(fallback, null, null, 'system', NO_FILTERS)
    expect(m.comparableValuation).toBe(false)
    expect(m.parity).toEqual({ state: 'not_comparable', reason: 'fallback_valuation' })
  })

  it('ages are measured from when the evidence was read', () => {
    const m = deriveWorkstation(w, null, null, 'system', NO_FILTERS)
    expect(m.now).toBe(Date.parse('2026-10-01T15:00:00Z'))
  })
})
