/**
 * Solar engine — deterministic, checked against known astronomy.
 */
import { describe, expect, it } from 'vitest'
import { containsPoint, darkRegion, LIGHT_BANDS, lightState, solarPosition, subsolarPoint } from './solar'

const MPLS = { lat: 44.9778, lng: -93.265 }

describe('sun position', () => {
  it('June solstice: the sun stands over the Tropic of Cancer', () => {
    const s = subsolarPoint(new Date('2026-06-21T12:00:00Z'))
    expect(s.lat).toBeGreaterThan(23.2)
    expect(s.lat).toBeLessThan(23.6)
    // at 12:00 UTC it is near local noon on the prime meridian (± equation of time)
    expect(Math.abs(s.lng)).toBeLessThan(3)
  })

  it('September equinox: subsolar latitude ~0', () => {
    expect(Math.abs(subsolarPoint(new Date('2026-09-23T00:00:00Z')).lat)).toBeLessThan(0.6)
  })

  it('Minneapolis solar noon at the solstice is ~68.5° high', () => {
    // Solar noon in Minneapolis ≈ 18:18 UTC on the June solstice.
    const p = solarPosition(new Date('2026-06-21T18:18:00Z'), MPLS.lat, MPLS.lng)
    expect(p.altitude).toBeGreaterThan(67.9)
    expect(p.altitude).toBeLessThan(68.9)
    expect(p.azimuth).toBeGreaterThan(170)
    expect(p.azimuth).toBeLessThan(190)
  })

  it('Minneapolis sunrise (NOAA 05:26 CDT on 2026-06-21) sits at the -0.83° horizon', () => {
    const p = solarPosition(new Date('2026-06-21T10:26:00Z'), MPLS.lat, MPLS.lng)
    expect(Math.abs(p.altitude + 0.833)).toBeLessThan(0.6)
    expect(p.rising).toBe(true)
    expect(p.azimuth).toBeGreaterThan(45)
    expect(p.azimuth).toBeLessThan(70)
  })

  it('is deterministic', () => {
    const d = new Date('2026-09-29T23:42:00Z')
    expect(solarPosition(d, 44.98, -93.27)).toEqual(solarPosition(new Date(d.valueOf()), 44.98, -93.27))
    expect(darkRegion(d, 0)).toEqual(darkRegion(new Date(d.valueOf()), 0))
  })
})

describe('the sun is overhead at the subsolar point — at every hour', () => {
  // Tests pinned to 12:00Z / 00:00Z cannot see a mirrored longitude (±0, ±180
  // are their own mirrors). Sweep the whole day on several dates instead.
  const instants: Date[] = []
  for (const day of ['2026-03-20', '2026-06-21', '2026-09-29', '2026-12-21']) {
    for (let m = 0; m < 1440; m += 97) instants.push(new Date(Date.parse(`${day}T00:00:00Z`) + m * 60e3))
  }
  it('solarPosition at subsolarPoint is ~90° high', () => {
    for (const at of instants) {
      const s = subsolarPoint(at)
      expect(solarPosition(at, s.lat, s.lng).altitude, at.toISOString()).toBeGreaterThan(89.4)
    }
  })
  it('18:00Z on the equinox: the sun is over ~90°W (± equation of time)', () => {
    const s = subsolarPoint(new Date('2026-09-23T18:00:00Z'))
    expect(s.lng).toBeGreaterThan(-93.5)
    expect(s.lng).toBeLessThan(-86.5)
  })
})

describe('dark bands agree with the sun everywhere, at every hour', () => {
  it('a point is inside the band exactly when the sun there is below the band altitude', () => {
    let checked = 0
    for (const iso of ['2026-09-30T00:38:26Z', '2026-09-29T14:10:00Z', '2026-06-21T03:30:00Z', '2026-12-21T21:45:00Z', '2026-03-20T09:05:00Z']) {
      const at = new Date(iso)
      for (const band of LIGHT_BANDS) {
        const poly = darkRegion(at, band.altitude)
        for (let lat = -60; lat <= 70; lat += 10) {
          for (let lng = -170; lng <= 170; lng += 10) {
            const alt = solarPosition(at, lat, lng).altitude
            if (Math.abs(alt - band.altitude) < 2) continue // the polygon is a 3° approximation of the circle
            expect(containsPoint(poly, lng, lat), `${iso} band ${band.altitude}° at ${lng},${lat} (sun ${alt.toFixed(1)}°)`).toBe(alt < band.altitude)
            checked++
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10000)
  })
})

describe('light across the country at one instant', () => {
  it('New York can be dark while Los Angeles is still lit', () => {
    // 2026-09-29 23:55 UTC = 19:55 EDT (after sunset) / 16:55 PDT (daylight)
    const d = new Date('2026-09-29T23:55:00Z')
    const ny = lightState(d, 40.71, -74.0)
    const la = lightState(d, 34.05, -118.24)
    expect(ny.phase === 'twilight' || ny.phase === 'night').toBe(true)
    expect(la.phase === 'day' || la.phase === 'golden').toBe(true)
    expect(la.light).toBeGreaterThan(ny.light)
  })
})

describe('dark region geometry', () => {
  const cases = [
    new Date('2026-06-21T12:00:00Z'), // northern summer — north pole lit, south pole dark
    new Date('2026-12-21T04:00:00Z'), // northern winter
    new Date('2026-09-23T18:00:00Z'), // equinox
    new Date('2026-09-29T23:55:00Z'),
  ]
  for (const d of cases) {
    for (const alt of [6, 0, -6, -12, -16]) {
      it(`${d.toISOString()} below ${alt}°: contains the antisolar point, never the subsolar point`, () => {
        const sun = subsolarPoint(d)
        const poly = darkRegion(d, alt)
        // 10° east of the antisolar point: deep inside the dark side, clear of
        // the polygon's closing seam (which lies exactly on the antisolar meridian).
        const antiLat = -sun.lat
        const antiLng = ((sun.lng + 190 + 540) % 360) - 180
        expect(containsPoint(poly, antiLng, antiLat)).toBe(true)
        expect(containsPoint(poly, sun.lng, sun.lat)).toBe(false)
      })
    }
  }

  it('agrees with the sun position at sample cities', () => {
    const d = new Date('2026-09-29T23:55:00Z')
    const sunset = darkRegion(d, -0.833)
    for (const [lat, lng] of [[40.71, -74.0], [34.05, -118.24], [44.98, -93.27], [25.77, -80.19], [47.61, -122.33]]) {
      const dark = solarPosition(d, lat, lng).altitude < -0.833
      expect(containsPoint(sunset, lng, lat)).toBe(dark)
    }
  })

  it('every dark polygon spans at most one world width (no stacked tint when wrapped)', () => {
    for (const d of [new Date('2026-06-21T12:00:00Z'), new Date('2026-09-23T18:00:00Z'), new Date('2026-12-21T04:00:00Z')]) {
      for (const alt of [6, 2, -0.833, -4, -8, -12, -16]) {
        const lngs = darkRegion(d, alt).coordinates[0].map((c) => c[0])
        expect(Math.max(...lngs) - Math.min(...lngs)).toBeLessThanOrEqual(360.0001)
      }
    }
  })

  it('polar day: in June the north pole is never dark; polar night: the south pole is', () => {
    const d = new Date('2026-06-21T06:00:00Z')
    const night = darkRegion(d, -0.833)
    expect(containsPoint(night, 0, 84)).toBe(false)
    expect(containsPoint(night, 0, -84)).toBe(true)
  })
})

describe('next sunrise / sunset', () => {
  it('Minneapolis on 2026-06-21 after noon → sunset ≈ 21:03 CDT (02:03Z next day)', async () => {
    const { nextSunEvent } = await import('./solar')
    const e = nextSunEvent(new Date('2026-06-21T18:00:00Z'), 44.9778, -93.265)!
    expect(e.kind).toBe('sunset')
    expect(Math.abs(e.at.valueOf() - Date.parse('2026-06-22T02:03:00Z'))).toBeLessThan(4 * 60_000)
  })
  it('before dawn → sunrise ≈ 05:26 CDT', async () => {
    const { nextSunEvent } = await import('./solar')
    const e = nextSunEvent(new Date('2026-06-21T08:00:00Z'), 44.9778, -93.265)!
    expect(e.kind).toBe('sunrise')
    expect(Math.abs(e.at.valueOf() - Date.parse('2026-06-21T10:26:00Z'))).toBeLessThan(4 * 60_000)
  })
})
