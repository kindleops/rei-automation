/**
 * Dynamic (sun) — the day/night overlay: exact stacked gradient, the right
 * side dark, and no seams or double tint across the antimeridian.
 */
import { describe, expect, it } from 'vitest'
import { containsPoint, darkRegion, litRegion, solarPosition } from './solar'
import { buildDynamicSun, compositeOf, DYNAMIC_NIGHT_STOPS, nightCurve, stackOpacities, sunEventHint } from './sun-dynamic'

// 2026-10-03 23:30Z: after sunset on the East Coast (19:30 EDT), daylight on the West Coast (16:30 PDT).
const AT = new Date('2026-10-03T23:30:00Z')

describe('stacked gradient', () => {
  it('the composite after each band equals the target exactly', () => {
    const targets = [0.05, 0.2, 0.35, 0.5, 0.6]
    const ops = stackOpacities(targets)
    targets.forEach((t, i) => expect(compositeOf(ops.slice(0, i + 1))).toBeCloseTo(t, 9))
    for (const o of ops) { expect(o).toBeGreaterThanOrEqual(0); expect(o).toBeLessThan(1) }
  })
  it('the night curve is monotonic: 0 at the horizon, 1 at astronomical night', () => {
    expect(nightCurve(0)).toBe(0)
    expect(nightCurve(-18)).toBeCloseTo(1, 9)
    let prev = -1
    for (const a of DYNAMIC_NIGHT_STOPS) { expect(nightCurve(a)).toBeGreaterThan(prev); prev = nightCurve(a) }
  })
})

describe('the overlay at a fixed instant', () => {
  const fc = buildDynamicSun(AT, 'light_street')
  const night = fc.features.filter((f) => f.properties?.role === 'night')
  const darknessAt = (lng: number, lat: number) => compositeOf(night.filter((f) => containsPoint(f.geometry as GeoJSON.Polygon, lng, lat)).map((f) => Number(f.properties?.o)))

  it('New York is dark and Los Angeles is light', () => {
    expect(solarPosition(AT, 40.71, -74.0).altitude).toBeLessThan(-4)
    expect(solarPosition(AT, 34.05, -118.24).altitude).toBeGreaterThan(10)
    expect(darknessAt(-74.0, 40.71)).toBeGreaterThan(0.12)
    expect(darknessAt(-118.24, 34.05)).toBe(0)
  })
  it('deep night (Europe · Africa) reaches the full theme darkness; noon (Pacific) has none', () => {
    expect(darknessAt(10, 0)).toBeCloseTo(0.6, 2)
    expect(darknessAt(-170, 0)).toBe(0)
  })
  it('darkness rises monotonically across the terminator (W → E along 40°N)', () => {
    let prev = -1
    for (let lng = -125; lng <= -40; lng += 5) {
      const d = darknessAt(lng, 40)
      expect(d).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = d
    }
  })
  it('light basemaps get no day-side lift; dark basemaps do', () => {
    expect(fc.features.some((f) => f.properties?.role === 'day')).toBe(false)
    expect(buildDynamicSun(AT, 'dark_ops').features.some((f) => f.properties?.role === 'day')).toBe(true)
  })
})

describe('antimeridian: no seam, no double tint', () => {
  // Instants that put the terminator / dark side across ±180°.
  const instants = ['2026-10-03T23:30:00Z', '2026-10-03T06:00:00Z', '2026-06-21T12:00:00Z', '2026-12-21T00:00:00Z', '2026-03-20T18:00:00Z']
  it('every band spans at most one world width', () => {
    for (const iso of instants) {
      for (const f of buildDynamicSun(new Date(iso), 'dark_ops').features) {
        if (f.geometry.type !== 'Polygon') continue
        const lngs = f.geometry.coordinates[0].map((c) => c[0])
        expect(Math.max(...lngs) - Math.min(...lngs), iso).toBeLessThanOrEqual(360.0001)
      }
    }
  })
  it('points just either side of ±180° agree with the sun (no seam)', () => {
    for (const iso of instants) {
      const at = new Date(iso)
      for (const alt of [0, -6, -12, -18]) {
        const poly = darkRegion(at, alt)
        for (let lat = -60; lat <= 60; lat += 15) {
          for (const lng of [179.9, -179.9]) {
            const sun = solarPosition(at, lat, lng).altitude
            if (Math.abs(sun - alt) < 2) continue
            expect(containsPoint(poly, lng, lat), `${iso} ${alt}° ${lng},${lat}`).toBe(sun < alt)
          }
        }
      }
    }
  })
  it('the lit region is the exact complement of the dark region', () => {
    for (const iso of instants) {
      const at = new Date(iso)
      const lit = litRegion(at, 0)
      for (let lat = -70; lat <= 70; lat += 10) {
        for (let lng = -180; lng < 180; lng += 10) {
          const sun = solarPosition(at, lat, lng).altitude
          if (Math.abs(sun) < 2) continue
          expect(containsPoint(lit, lng, lat), `${iso} ${lng},${lat}`).toBe(sun > 0)
        }
      }
    }
  })
})

describe('hint', () => {
  it('formats the next sun event', () => {
    const now = new Date('2026-10-03T23:00:00Z')
    expect(sunEventHint({ kind: 'sunset', at: new Date('2026-10-03T23:42:00Z') }, now)).toBe('Sunset in 42m')
    expect(sunEventHint({ kind: 'sunrise', at: new Date('2026-10-04T02:10:00Z') }, now)).toBe('Sunrise in 3h 10m')
    expect(sunEventHint(null, now)).toBeNull()
  })
})
