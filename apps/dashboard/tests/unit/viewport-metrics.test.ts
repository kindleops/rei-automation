import { describe, expect, it } from 'vitest'
import { resolveViewportMetrics } from '../../src/modules/mobile/viewport-metrics'

describe('resolveViewportMetrics', () => {
  it('keeps normal iPhone portrait dimensions', () => {
    const metrics = resolveViewportMetrics({
      innerWidth: 390,
      innerHeight: 844,
      screenWidth: 390,
      screenHeight: 844,
    })
    expect(metrics.effectiveWidth).toBe(390)
    expect(metrics.isPortrait).toBe(true)
  })

  it('corrects Safari desktop-website inflation on phones', () => {
    const metrics = resolveViewportMetrics({
      innerWidth: 980,
      innerHeight: 844,
      screenWidth: 390,
      screenHeight: 844,
      orientationPortrait: true,
    })
    expect(metrics.effectiveWidth).toBe(390)
    expect(metrics.effectiveHeight).toBe(844)
    expect(metrics.isPortrait).toBe(true)
  })

  it('preserves landscape phone desktop layout width', () => {
    const metrics = resolveViewportMetrics({
      innerWidth: 844,
      innerHeight: 390,
      screenWidth: 390,
      screenHeight: 844,
      orientationPortrait: false,
    })
    expect(metrics.effectiveWidth).toBe(844)
    expect(metrics.isPortrait).toBe(false)
  })
})