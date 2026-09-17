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
    expect(metrics.isPhoneClass).toBe(true)
  })

  it('corrects Safari desktop-website inflation on phones', () => {
    const metrics = resolveViewportMetrics({
      innerWidth: 980,
      innerHeight: 844,
      screenWidth: 390,
      screenHeight: 844,
      orientationPortrait: false,
    })
    expect(metrics.effectiveWidth).toBe(390)
    expect(metrics.effectiveHeight).toBe(844)
    expect(metrics.isPortrait).toBe(true)
  })

  it('reports the real layout width in landscape but still calls it a phone', () => {
    const metrics = resolveViewportMetrics({
      innerWidth: 844,
      innerHeight: 390,
      screenWidth: 390,
      screenHeight: 844,
      orientationPortrait: false,
    })
    expect(metrics.effectiveWidth).toBe(844)
    expect(metrics.isPortrait).toBe(false)
    // Rotating the handset must not change which product the operator gets.
    expect(metrics.isPhoneClass).toBe(true)
  })

  it('classifies a landscape phone as a phone without screen dimensions', () => {
    const metrics = resolveViewportMetrics({ innerWidth: 844, innerHeight: 390 })
    expect(metrics.isPhoneClass).toBe(true)
    expect(metrics.isPortrait).toBe(false)
  })

  it('keeps small tablets out of the phone class', () => {
    const portrait = resolveViewportMetrics({
      innerWidth: 744,
      innerHeight: 1133,
      screenWidth: 744,
      screenHeight: 1133,
    })
    expect(portrait.isPhoneClass).toBe(false)

    const landscape = resolveViewportMetrics({
      innerWidth: 1133,
      innerHeight: 744,
      screenWidth: 744,
      screenHeight: 1133,
      orientationPortrait: false,
    })
    expect(landscape.isPhoneClass).toBe(false)
  })

  it('keeps a narrow desktop window out of the phone class', () => {
    const metrics = resolveViewportMetrics({
      innerWidth: 900,
      innerHeight: 400,
      screenWidth: 1920,
      screenHeight: 1080,
      orientationPortrait: false,
    })
    expect(metrics.isPhoneClass).toBe(false)
  })
})