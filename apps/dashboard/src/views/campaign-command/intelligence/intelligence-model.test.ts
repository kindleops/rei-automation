import { describe, expect, it } from 'vitest'
import { angleLabel, buildExpression, catalogReason, componentWords, coverageVerdict, histogramBars, opsForType, share, situationLabel, TIER_LABEL } from './intelligence-model'
import type { CatalogMetric } from './intelligence-types'
import { isScreenerOff } from './intelligence-api'

const metric = (over: Partial<CatalogMetric>): CatalogMetric => ({ key: 'k', label: 'K', source: 'graph', type: 'number', column: null, formula: null, threshold: 0.6, coverage: { ratio: 1, known: 10, total: 10 }, exposed: true, reason: null, ...over })

describe('share — a percentage only from both numbers', () => {
  it('renders count / denominator with its %', () => {
    expect(share(162, 2689)).toMatchObject({ text: '162 / 2,689', pct: '6.0%' })
    expect(share(1560, 2689).pct).toBe('58%')
    expect(share(0, 50).pct).toBe('0%')
    expect(share(1, 5000).pct).toBe('<0.1%')
  })
  it('never invents a % without a denominator', () => {
    expect(share(5, 0)).toMatchObject({ pct: null, ratio: null, text: '5 / —' })
    expect(share(null, null).pct).toBeNull()
  })
})

describe('labels', () => {
  it('tiers, situations, angles', () => {
    expect(TIER_LABEL.A).toBe('A · Acute pressure')
    expect(situationLabel('FATIGUED_LANDLORD')).toBe('Fatigued landlord')
    expect(situationLabel(null)).toBe('Not known')
    expect(angleLabel(null)).toBe('No angle supported by evidence')
    expect(angleLabel('SPEED_CERTAINTY')).toBe('Speed / certainty')
  })
  it('null component is unknown, never zero', () => {
    expect(componentWords('forced_sale_pressure', null)).toEqual({ level: 'unknown', text: 'forced-sale pressure not known' })
    expect(componentWords('forced_sale_pressure', 0).text).toBe('Low forced-sale pressure (0)')
    expect(componentWords('equity_unlock', 72).text).toBe('High equity unlock (72)')
  })
})

describe('coverage verdicts', () => {
  it('states exposure with n', () => {
    expect(coverageVerdict({ ratio: 0.3, threshold: 0.6, exposed: false, known: 3, total: 10 })).toBe('30% known (3 / 10) · below the 60% exposure threshold')
    expect(coverageVerdict({ ratio: 1, threshold: 0.6, exposed: true, known: 10, total: 10 })).toBe('100% known (10 / 10) · exposed (≥ 60%)')
    expect(coverageVerdict(null)).toMatch(/not measured/)
    expect(catalogReason(metric({ exposed: false, reason: 'coverage_below_threshold', coverage: { ratio: 0.2, known: 2, total: 10 } }))).toBe('Only 20% of sellers have a value (needs 60%)')
    expect(catalogReason(metric({ exposed: false, reason: 'coverage_not_measured', coverage: null }))).toMatch(/not measured/)
  })
})

describe('buildExpression', () => {
  const catalog = [metric({ key: 'state', type: 'text' }), metric({ key: 'forced_sale_pressure' }), metric({ key: 'tax_pain' }), metric({ key: 'landlord_fatigue' }), metric({ key: 'mobile_reachable', type: 'boolean' })]
  it('builds the brief’s stacked example: AND + one ANY group', () => {
    const expr = buildExpression(
      [{ id: '1', metric: 'state', op: 'in', value: 'TX' }, { id: '2', metric: 'forced_sale_pressure', op: 'gte', value: '70' }, { id: '3', metric: 'mobile_reachable', op: 'is_true', value: '' }],
      [{ id: '4', metric: 'tax_pain', op: 'gte', value: '50' }, { id: '5', metric: 'landlord_fatigue', op: 'gte', value: '65' }],
      catalog,
    )
    expect(expr).toEqual({ all: [{ m: 'state', op: 'in', v: ['TX'] }, { m: 'forced_sale_pressure', op: 'gte', v: 70 }, { m: 'mobile_reachable', op: 'is_true' }, { any: [{ m: 'tax_pain', op: 'gte', v: 50 }, { m: 'landlord_fatigue', op: 'gte', v: 65 }] }] })
  })
  it('drops incomplete rows and unknown metrics', () => {
    expect(buildExpression([{ id: '1', metric: 'forced_sale_pressure', op: 'gte', value: 'x' }, { id: '2', metric: 'nope', op: 'gte', value: '1' }], [], catalog)).toEqual({ all: [] })
  })
  it('ops follow the metric type', () => {
    expect(opsForType('boolean').map((o) => o.value)).toEqual(['is_true', 'is_false'])
    expect(opsForType('text')[0].value).toBe('in')
  })
})

describe('flag-off detection and histograms', () => {
  it('only the disabled 404 is "off"', () => {
    expect(isScreenerOff(404, { error: 'seller_screener_disabled' })).toBe(true)
    expect(isScreenerOff(404, { error: 'not_found' })).toBe(false)
    expect(isScreenerOff(500, { error: 'seller_screener_disabled' })).toBe(false)
  })
  it('bars keep their counts', () => {
    expect(histogramBars([{ lo: 0, hi: 10, n: 5 }, { lo: 10, hi: 20, n: 10 }]).map((b) => [b.n, b.h])).toEqual([[5, 0.5], [10, 1]])
  })
})
