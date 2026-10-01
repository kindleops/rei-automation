import { describe, expect, it } from 'vitest'
import {
  contrast, deltaE, hsvToRgb, hueDistance, maxChroma, normalizeHex, oklchToRgb, parseColor, rgbToHsl, rgbToHsv,
  rgbToOklch, rotateToward, solveLightness, toHex, toTriplet,
} from './oklch'

describe('parseColor — what an operator pastes', () => {
  it('accepts hex with and without #, short and long, any case', () => {
    expect(normalizeHex('#22D3EE')).toBe('#22D3EE')
    expect(normalizeHex('22d3ee')).toBe('#22D3EE')
    expect(normalizeHex('#2de')).toBe('#22DDEE')
    expect(normalizeHex('  #22D3EE80 ')).toBe('#22D3EE')
  })
  it('accepts rgb(), rgba(), modern space syntax and a bare triplet', () => {
    expect(normalizeHex('rgb(34, 211, 238)')).toBe('#22D3EE')
    expect(normalizeHex('rgba(34,211,238,0.4)')).toBe('#22D3EE')
    expect(normalizeHex('rgb(34 211 238 / 50%)')).toBe('#22D3EE')
    expect(normalizeHex('34, 211, 238')).toBe('#22D3EE')
    expect(normalizeHex('rgb(100%, 0%, 0%)')).toBe('#FF0000')
  })
  it('accepts hsl() and oklch()', () => {
    expect(normalizeHex('hsl(0, 100%, 50%)')).toBe('#FF0000')
    expect(normalizeHex('hsl(240 100% 50%)')).toBe('#0000FF')
    const fromOklch = parseColor('oklch(0.628 0.2577 29.23)')
    expect(fromOklch && deltaE(fromOklch, { r: 255, g: 0, b: 0 })).toBeLessThan(0.01)
  })
  it('rejects anything that is not a colour instead of guessing', () => {
    for (const bad of ['', 'cyan', '#12', '#ggg', 'rgb(300, 0, 0)', 'rgb(1,2)', 'hsl(0, 200%, 50%)', 'oklch(2 0.1 10)', null, 42, {}]) {
      expect(parseColor(bad)).toBeNull()
    }
  })
})

describe('OKLCH round trips', () => {
  it('is stable for representative colours', () => {
    for (const hex of ['#06B6D4', '#7C3AED', '#EAB308', '#000000', '#FFFFFF', '#808080', '#FEF9C3', '#1E1B4B']) {
      const rgb = parseColor(hex)!
      expect(toHex(oklchToRgb(rgbToOklch(rgb)))).toBe(hex)
    }
  })
  it('maps out-of-gamut colours by reducing chroma, keeping hue', () => {
    const lch = { l: 0.7, c: 0.4, h: 150 }
    const rgb = oklchToRgb(lch)
    const back = rgbToOklch(rgb)
    expect(back.c).toBeLessThanOrEqual(maxChroma(0.7, 150) + 0.002)
    expect(hueDistance(back.h, 150)).toBeLessThan(2)
    expect(Math.abs(back.l - 0.7)).toBeLessThan(0.01)
  })
  it('gives achromatic colours a deterministic hue', () => {
    expect(rgbToOklch({ r: 128, g: 128, b: 128 }).h).toBe(0)
  })
})

describe('HSV / HSL', () => {
  it('round-trips through HSV (the picker surface)', () => {
    for (const hex of ['#22D3EE', '#FF8800', '#123456', '#FFFFFF']) {
      const rgb = parseColor(hex)!
      expect(toHex(hsvToRgb(rgbToHsv(rgb)))).toBe(hex)
    }
  })
  it('reads HSL for the Advanced values', () => {
    const hsl = rgbToHsl({ r: 255, g: 0, b: 0 })
    expect(hsl).toEqual({ h: 0, s: 1, l: 0.5 })
  })
})

describe('contrast + lightness solving', () => {
  it('computes WCAG ratios', () => {
    expect(contrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 1)
    expect(contrast({ r: 118, g: 118, b: 118 }, { r: 255, g: 255, b: 255 })).toBeGreaterThan(4.5)
  })
  it('moves only lightness, only as far as needed', () => {
    const pale = rgbToOklch(parseColor('#FEF9C3')!)
    const white = { r: 255, g: 255, b: 255 }
    const solved = solveLightness(pale, (c) => contrast(c, white) >= 4.5, -1)
    expect(contrast(solved.rgb, white)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(solved.rgb, white)).toBeLessThan(4.8)
    expect(hueDistance(rgbToOklch(solved.rgb).h, pale.h)).toBeLessThan(6)
  })
  it('rotates hue the short way and never overshoots', () => {
    expect(rotateToward(350, 10, 30)).toBe(10)
    expect(rotateToward(350, 10, 5)).toBe(355)
    expect(rotateToward(100, 245, 30)).toBe(130)
  })
  it('formats triplets for the existing token shapes', () => {
    expect(toTriplet({ r: 6, g: 182, b: 212 })).toBe('6, 182, 212')
  })
})
