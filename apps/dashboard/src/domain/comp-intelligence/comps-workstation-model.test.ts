import { describe, expect, it } from 'vitest'
import type { CompsWorkspace, EngineRules, EvidenceComp } from './comps-evidence-api'
import {
  assetKind, describeFilters, evidenceDepth, filterCount, fmtDate, fmtMiles, matchesPreset, NO_FILTERS, passesFilters, PRESETS,
  engineAgeMonths, recencyStepOf, recencySteps, sameSet, setDiff, subjectImplied, unitMetricFor, unitValue, weaknesses, whyExcluded, whyIncluded,
} from './comps-workstation-model'

const NOW = Date.parse('2026-10-01T15:00:00Z')
const subject = {
  propertyId: 'S1', address: '5124 Russell Ave N', city: 'Minneapolis', state: 'MN', zip: '55430', lat: 45.048, lng: -93.311,
  propertyType: 'Single Family', family: 'residential', familyLabel: 'Single family', units: 1, beds: 3, baths: 1.5, sqft: 1122,
  lotSqft: 6098, yearBuilt: 1954, condition: 'Average', estimatedValue: 260000, mlsStatus: null, mlsListPrice: null, dimensions: [],
} as CompsWorkspace['subject']

const rules: EngineRules = {
  family: 'residential', radiusMiles: 4, months: 30, size: { field: 'sqft', label: 'Building sq ft', min: 0.5, max: 1.9, reason: 'square_feet_outside_range' },
  minSalePrice: 10000, nominalPriceToValue: 0.25, minCompScore: 30, maxSelected: 12, pool: { source: 'engine pool', limit: 100 },
  outlier: { method: 'median_absolute_deviation', minObservations: 5, madMultiple: 3.5, floorShareOfMedian: 0.28 },
  weight: { formula: '', mlsFactor: 1, otherFactor: 0.92 },
  recency: [{ maxMonths: 3, score: 100 }, { maxMonths: 6, score: 94 }, { maxMonths: 12, score: 82 }, { maxMonths: null, score: 10 }],
  confidence: { formula: '', depthFullAt: 8, weights: { depth: 0.32, compScore: 0.25, completeness: 0.18, consistency: 0.2, sourceDiversity: 0.05 } },
}

const comp = (over: Partial<EvidenceComp> = {}): EvidenceComp => ({
  key: 'p:1', corpus: 'engine_pool', compId: '1', propertyId: 'P1', address: '5148 Washburn Ave N', city: 'Minneapolis', zip: '55430',
  lat: 45.049, lng: -93.317, salePrice: 265000, saleDate: '2026-04-22', distanceMiles: 0.31, propertyType: 'Single Family', units: 1,
  beds: 3, baths: 1, sqft: 1140, lotSqft: 5227, yearBuilt: 1952, condition: 'Average', renovation: null, ppsf: 232, ppu: 265000,
  source: 'MLS sold', mls: true, buyerKind: null, buyerCompany: null, buyerId: null, buyerAcquisitions: null, buyerActivity: null,
  sellerKind: null, armsLength: null, cash: null, docType: null, photo: null, assetMatch: true, state: 'system', reasons: [],
  engine: { origin: 'stored', eligible: true, reasons: [], score: 96.52, completeness: 62.39, weight: 0.7794, adjustedPrice: 263300, recency: 94, saleSource: 'mls_sold', dims: [{ f: 'asset_type', c: 'single_family', st: 'exact_or_near' }, { f: 'zip', c: '55430', st: 'exact_or_near' }] },
  compare: { sqftPct: 2, beds: 0, baths: -0.5, years: -2, lotPct: -14, units: 0, days: 162 },
  ...over,
})

describe('formatting', () => {
  it('formats a sale date as the calendar date it is, whatever the time zone', () => {
    expect(fmtDate('2026-04-22', 'long')).toBe('Apr 22, 2026')
    expect(fmtDate('2026-01-01', 'long')).toBe('Jan 1, 2026')
    expect(fmtDate(null)).toBeNull()
  })
  it('distance under a tenth of a mile reads in feet', () => {
    expect(fmtMiles(0.03)).toBe('158 ft')
    expect(fmtMiles(0.31)).toBe('0.31 mi')
  })
})

describe('asset-aware metrics', () => {
  it('picks $/sf for houses, $/unit for multifamily, $/acre for land', () => {
    expect(unitMetricFor(assetKind('residential')).key).toBe('ppsf')
    expect(unitMetricFor(assetKind('multifamily')).key).toBe('ppu')
    expect(unitMetricFor(assetKind('land')).key).toBe('ppa')
  })
  it('never derives a unit value from a missing or zero size', () => {
    const m = unitMetricFor('sfr')
    expect(unitValue(comp(), m)).toBe(232)
    expect(unitValue(comp({ sqft: 0 }), m)).toBeNull()
    expect(unitValue(comp({ sqft: null }), m)).toBeNull()
    expect(unitValue(comp({ units: 1 }), unitMetricFor('multifamily'))).toBeNull()
    expect(unitValue(comp({ salePrice: 87120, lotSqft: 43560 }), unitMetricFor('land'))).toBe(87120)
  })
  it('subject implied value divides by the subject’s own size', () => {
    expect(subjectImplied(294600, subject, unitMetricFor('sfr'))).toBeCloseTo(262.57, 1)
    expect(subjectImplied(294600, { ...subject, sqft: null }, unitMetricFor('sfr'))).toBeNull()
  })
})

describe('explanations', () => {
  const ctx = { subject, rules, now: NOW, outlierBand: { low: 210400, high: 431200 }, setMedianDistance: 0.64 }
  it('why included states only recorded facts', () => {
    const why = whyIncluded(comp(), ctx).map((r) => r.text)
    expect(why).toContain('Same asset type · Single family')
    expect(why).toContain('0.31 mi from the subject')
    expect(why.find((t) => t.startsWith('Sold'))).toBe('Sold 5 mo ago · engine recency 94%')
    expect(why).toContain('Size within 2% (1,140 vs 1,122 sf)')
    expect(why).toContain('Same ZIP')
    expect(why).toContain('MLS-recorded sale')
  })
  it('why excluded uses the engine’s real limits', () => {
    const far = whyExcluded(comp({ state: 'excluded', distanceMiles: 4.7, reasons: [{ code: 'outside_radius', label: 'x' }] }), ctx)
    expect(far[0].text).toBe('4.70 mi from the subject — the engine’s limit is 4 mi')
    const big = whyExcluded(comp({ state: 'excluded', sqft: 2950, reasons: [{ code: 'square_feet_outside_range', label: 'x' }] }), ctx)
    expect(big[0].text).toBe('2,950 sf vs the subject’s 1,122 sf (+163%) — the engine allows −50% to +90%')
    const mf = whyExcluded(comp({ state: 'excluded', propertyType: 'Multi-Family', units: 4, reasons: [{ code: 'asset_type_mismatch', label: 'x' }] }), ctx)
    expect(mf[0].text).toBe('Multi-Family · 4 units — the subject is Single family')
    const deed = whyExcluded(comp({ state: 'excluded', docType: 'Quit Claim Deed', reasons: [{ code: 'distress_or_transfer_deed', label: 'x' }] }), ctx)
    expect(deed[0].text).toBe('Quit Claim Deed — a foreclosure / transfer deed, not a market sale')
  })
  it('weaknesses flag drift, the outlier band and deed-only evidence', () => {
    const rejectsToday = weaknesses(comp({ today: { eligible: false, reasons: ['sale_too_old'], weight: null, adjustedPrice: null, recency: null } }), ctx)
    expect(rejectsToday.find((r) => r.code === 'today_rejects')?.tone).toBe('crit')
    const aged = weaknesses(comp({ today: { eligible: true, reasons: [], weight: 0.6121, adjustedPrice: 263300, recency: 82 } }), ctx)
    expect(aged.find((r) => r.code === 'aged')?.text).toBe('Weight has aged since the engine ran (0.7794 → 0.6121)')
    const outlier = weaknesses(comp({ engine: { ...comp().engine!, adjustedPrice: 455000 } }), ctx)
    expect(outlier.some((r) => r.code === 'outlier_band')).toBe(true)
    const deedOnly = weaknesses(comp({ corpus: 'transaction_corpus', mls: false }), ctx)
    expect(deedOnly.some((r) => r.code === 'deed_only')).toBe(true)
  })
})

describe('filters and presets', () => {
  it('a preset is a visible definition', () => {
    expect(describeFilters(PRESETS.strict.filters, 'sfr')).toEqual(['≤ 1 mi', 'sold ≤ 12 mo', 'sq ft ±15%', 'beds ±1'])
    expect(describeFilters(PRESETS.strict.filters, 'multifamily')).toEqual(['≤ 1 mi', 'sold ≤ 12 mo', 'units ±15%'])
    expect(matchesPreset(PRESETS.balanced.filters)).toBe('balanced')
    expect(matchesPreset({ ...NO_FILTERS, sameZip: true })).toBeNull()
    expect(filterCount(PRESETS.strict.filters)).toBe(4)
    expect(filterCount(NO_FILTERS)).toBe(0)
  })
  it('SFR ≤2 mi ≤12 mo sq ft ±20% sold combines exactly', () => {
    const f = { ...NO_FILTERS, maxDistance: 2, maxAgeMonths: 12, sizePct: 20 }
    expect(passesFilters(comp(), f, subject, NOW)).toBe(true)
    expect(passesFilters(comp({ distanceMiles: 2.01 }), f, subject, NOW)).toBe(false)
    expect(passesFilters(comp({ compare: { ...comp().compare, days: 370 } }), f, subject, NOW)).toBe(false)
    expect(passesFilters(comp({ compare: { ...comp().compare, sqftPct: 21 } }), f, subject, NOW)).toBe(false)
    expect(passesFilters(comp({ compare: { ...comp().compare, sqftPct: null } }), f, subject, NOW)).toBe(false)
  })
})

describe('sets and depth', () => {
  it('diffs the operator set against the system set', () => {
    expect(setDiff(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toEqual({ added: ['d'], removed: ['a'] })
    expect(sameSet(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true)
  })
  it('evidence depth is counted, not scored', () => {
    const d = evidenceDepth([comp(), comp({ key: 'p:2', distanceMiles: 3.9, compare: { ...comp().compare, days: 40 } }), comp({ key: 'p:3', mls: false, compare: { ...comp().compare, days: 400 } })], unitMetricFor('sfr'), NOW)
    expect(d.count).toBe(3)
    expect(d.within1mi).toBe(2)
    expect(d.within90d).toBe(1)
    expect(d.within12mo).toBe(2)
    expect(d.mlsCount).toBe(2)
  })
  it('recency buckets are the engine’s calendar-month steps', () => {
    // Sep 30 → Oct 1 ages every sale a month: the engine counts calendar months
    expect(engineAgeMonths('2026-09-30', Date.parse('2026-09-30T23:00:00Z'))).toBe(0)
    expect(engineAgeMonths('2026-09-30', Date.parse('2026-10-01T01:00:00Z'))).toBe(1)
    expect(engineAgeMonths('2024-04-15', NOW)).toBe(30)
    const steps = recencySteps(rules)
    expect(steps.map((x) => [x.label, x.factor])).toEqual([['≤ 3 mo', 100], ['4–6 mo', 94], ['7–12 mo', 82], ['13+ mo', 10]])
    expect(recencyStepOf(steps, 3)?.factor).toBe(100)
    expect(recencyStepOf(steps, 4)?.factor).toBe(94)
    expect(recencyStepOf(steps, 13)?.factor).toBe(10)
    expect(recencyStepOf(steps, null)).toBeNull()
  })
})
