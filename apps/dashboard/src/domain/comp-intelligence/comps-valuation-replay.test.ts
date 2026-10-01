import { describe, expect, it } from 'vitest'
import { leaveOneOut, outlierBand, parityWithStored, replayValuation, type ReplayInput } from './comps-valuation-replay'

/**
 * Production fixtures: the engine's STORED selected comps (adjusted price,
 * weight, comparability score, data completeness, sale source) and the
 * valuation the engine stored for them (property_acquisition_scores, read
 * 2026-10-01). The replay must reproduce every one exactly — it is the
 * engine's formula or it is nothing.
 */
type Row = [source: string, adjusted: number, weight: number, score: number, completeness: number]
const inputs = (rows: Row[]): ReplayInput[] => rows.map(([saleSource, adjustedPrice, weight, score, completeness], i) => ({ key: `c${i}`, saleSource, adjustedPrice, weight, score, completeness }))

const RUSSELL_SFR: Row[] = [
  ['mls_sold', 263300, 0.7794, 96.52, 62.39], ['mls_sold', 300700, 0.7496, 94.22, 62.39], ['mls_sold', 247400, 0.7217, 92.03, 62.39],
  ['mls_sold', 319200, 0.6527, 86.42, 62.39], ['mls_sold', 278000, 0.6429, 94.48, 62.39], ['mls_sold', 235100, 0.6312, 85.03, 60.35],
  ['mls_sold', 364100, 0.6231, 83.93, 62.39], ['mls_sold', 279200, 0.6073, 91.23, 62.39], ['mls_sold', 288700, 0.5994, 90.49, 62.39],
  ['mls_sold', 259200, 0.5684, 87.55, 62.39], ['mls_sold', 349400, 0.5566, 86.42, 62.39], ['mls_sold', 375600, 0.5549, 78.38, 60.35],
]
const THOMAS_4UNIT: Row[] = [
  ['public_record_sold', 317200, 0.4681, 72.85, 67.06], ['mls_sold', 354200, 0.4565, 75.36, 67.06], ['mls_sold', 421200, 0.4547, 75.17, 67.06],
  ['mls_sold', 406300, 0.4333, 65.58, 67.06], ['mls_sold', 645500, 0.4318, 65.43, 67.06], ['mls_sold', 621700, 0.4165, 63.89, 67.06],
  ['mls_sold', 517400, 0.4036, 62.57, 67.06], ['mls_sold', 510700, 0.3993, 69.51, 65.08], ['public_record_sold', 379700, 0.3954, 72.49, 67.06],
  ['mls_sold', 336400, 0.387, 67.73, 67.06], ['mls_sold', 460100, 0.3848, 60.6, 67.06], ['mls_sold', 515600, 0.3749, 66.72, 65.08],
]
const SEFTON_DUPLEX: Row[] = [
  ['public_record_sold', 208500, 0.5274, 80.1, 59.92], ['public_record_sold', 308100, 0.5246, 88.24, 59.92], ['mls_sold', 262300, 0.4946, 80.76, 59.92],
  ['mls_sold', 406600, 0.4536, 76.47, 59.92], ['public_record_sold', 405600, 0.4431, 71.67, 59.92], ['public_record_sold', 260600, 0.4395, 79.01, 59.92],
  ['public_record_sold', 297700, 0.4159, 68.79, 59.92], ['public_record_sold', 299800, 0.4104, 68.19, 59.92], ['public_record_sold', 320300, 0.4069, 67.82, 59.92],
  ['mls_sold', 441800, 0.4069, 71.37, 59.92], ['public_record_sold', 177300, 0.4052, 67.64, 59.92], ['public_record_sold', 199700, 0.4048, 75.01, 59.92],
]
const SPOONER_TWO: Row[] = [['public_record_sold', 711900, 0.228, 48.81, 29.76], ['mls_sold', 1045800, 0.2232, 47.65, 31.75]]
const ATASCOSA_ONE: Row[] = [['public_record_sold', 332498300, 0.376, 88.58, 29.76]]

describe('engine valuation replay', () => {
  it.each([
    ['5124 Russell Ave N (SFR, 12 MLS comps)', RUSSELL_SFR, [263300, 294600, 319200, 84]],
    ['4363 Thomas Ave N (4-unit, mixed sources)', THOMAS_4UNIT, [354200, 455200, 517400, 78]],
    ['81 Sefton Dr (duplex, tied weights)', SEFTON_DUPLEX, [208500, 298100, 320300, 77]],
    ['408 Spooner St (2 comps)', SPOONER_TWO, [711900, 877100, 1045800, 44]],
    ['5314 Atascosa Dr (1 comp)', ATASCOSA_ONE, [303903900, 332498300, 361092700, 55]],
  ] as const)('reproduces the stored valuation of %s', (_name, rows, [low, mid, high, confidence]) => {
    const r = replayValuation(inputs([...rows] as Row[]))
    expect(r).not.toBeNull()
    expect([r!.low, r!.mid, r!.high, r!.confidence]).toEqual([low, mid, high, confidence])
  })

  it('reports the same confidence components the engine stored', () => {
    const r = replayValuation(inputs(RUSSELL_SFR))!
    // valuation_calculation_summary.components (rounded to 1 dp by the engine)
    expect(r.components.depth).toBe(100)
    expect(Math.round(r.components.compScore * 10) / 10).toBe(89.3)
    expect(Math.round(r.components.completeness * 10) / 10).toBe(62.1)
    expect(Math.round(r.components.consistency * 10) / 10).toBe(72.9)
    expect(r.components.sourceDiversity).toBe(70)
    expect(Math.round(r.dispersion * 1e4) / 1e4).toBe(0.1503)
    expect(Math.round(r.totalWeight * 1e4) / 1e4).toBe(7.6872)
  })

  it('does not depend on the order comps are given in', () => {
    const a = replayValuation(inputs(THOMAS_4UNIT))
    const b = replayValuation(inputs([...THOMAS_4UNIT].reverse()))
    expect(b).toEqual(a)
  })

  it('a second sale source lifts source diversity to 100', () => {
    const one = replayValuation(inputs(RUSSELL_SFR))!
    const mixed = replayValuation(inputs([...RUSSELL_SFR.slice(0, 11), ['public_record_sold', 375600, 0.5549, 78.38, 60.35]]))!
    expect(one.components.sourceDiversity).toBe(70)
    expect(mixed.components.sourceDiversity).toBe(100)
  })

  it('an empty set has no comparable valuation — never the record-estimate fallback', () => {
    expect(replayValuation([])).toBeNull()
  })

  it('parity: exact against the stored run, differs when inputs drift, not comparable for a fallback', () => {
    const r = replayValuation(inputs(RUSSELL_SFR))
    const stored = { valueLow: 263300, valueMid: 294600, valueHigh: 319200, valuationConfidence: 84, recommendedOffer: null, floor: null, tier: null, computedAt: null, ask: null, method: 'weighted_adjusted_comp_value' }
    expect(parityWithStored(stored, r)).toEqual({ state: 'exact' })
    const drifted = replayValuation(inputs(RUSSELL_SFR.slice(1)))
    expect(parityWithStored(stored, drifted).state).toBe('differs')
    expect(parityWithStored({ ...stored, method: 'subject_value_fallback' }, r)).toEqual({ state: 'not_comparable', reason: 'fallback_valuation' })
    expect(parityWithStored(null, r)).toEqual({ state: 'not_comparable', reason: 'no_stored_valuation' })
  })

  it('leave-one-out replays the set without each comp and measures the move', () => {
    const set = inputs(RUSSELL_SFR)
    const base = replayValuation(set)!
    const loo = leaveOneOut(set)
    expect(loo).toHaveLength(12)
    const highest = loo.find((x) => x.key === 'c11')! // $375,600 — the highest adjusted value
    expect(highest.result!.count).toBe(11)
    expect(highest.deltaMid).toBe(highest.result!.mid - base.mid)
    expect(highest.deltaMid!).toBeLessThan(0)
    const lowest = loo.find((x) => x.key === 'c5')! // $235,100 — the lowest
    expect(lowest.deltaMid!).toBeGreaterThan(0)
    expect(loo.reduce((s, x) => s + x.weightShare, 0)).toBeCloseTo(1, 10)
  })

  it('the MAD band is the stored median ± allowed deviation', () => {
    const run = { engine: 'acquisition_decision_engine', version: '2.0.0', computedAt: null, method: null, formula: null, selectedCount: null, totalWeight: null, dispersion: null, sourceTypes: [], sourceValue: null, components: { depth: null, compScore: null, completeness: null, consistency: null, sourceDiversity: null }, pool: { status: null, rawCandidates: null, eligibleCandidates: null, rejectionBreakdown: {} } }
    expect(outlierBand({ ...run, outlier: { method: 'median_absolute_deviation', median: 320800, mad: 31600, allowedDeviation: 110400 } })).toEqual({ low: 210400, high: 431200, median: 320800, allowed: 110400 })
    expect(outlierBand({ ...run, outlier: { method: 'insufficient_count_for_mad', median: null, mad: null, allowedDeviation: null } })).toBeNull()
  })
})
