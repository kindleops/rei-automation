/**
 * City lights — the per-pixel night mask and the lights extraction.
 */
import { describe, expect, it } from 'vitest'
import { solarPosition } from './solar'
import { extractLights, LIGHTS_FULL_ALT, LIGHTS_ON_ALT, lightsBucket, LIGHTS_BUCKET_MS, nightFactorTile } from './city-lights'

const AT = new Date('2026-10-03T23:30:00Z') // NY after dusk, LA in daylight

/** Pixel centre (lng, lat) of tile z/x/y at (px, py). */
const pixelLngLat = (z: number, x: number, y: number, px: number, py: number, size = 256) => {
  const n = 2 ** z
  const lng = ((x + (px + 0.5) / size) / n) * 360 - 180
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + (py + 0.5) / size)) / n))) * 180) / Math.PI
  return [lng, lat] as const
}

describe('night factor per pixel', () => {
  it('is 0 wherever the sun is above the on-threshold and 1 below full night, matching solarPosition', () => {
    for (const [z, x, y] of [[2, 0, 1], [2, 1, 1], [2, 2, 1], [2, 3, 1], [3, 2, 3], [4, 4, 6]] as const) {
      const f = nightFactorTile(z, x, y, AT, 32)
      for (let py = 0; py < 32; py += 3) {
        for (let px = 0; px < 32; px += 3) {
          const [lng, lat] = pixelLngLat(z, x, y, px, py, 32)
          const alt = solarPosition(AT, lat, lng).altitude
          const v = f[py * 32 + px]
          if (alt > LIGHTS_ON_ALT + 0.05) expect(v, `${lng},${lat} sun ${alt}`).toBe(0)
          else if (alt < LIGHTS_FULL_ALT - 0.05) expect(v, `${lng},${lat} sun ${alt}`).toBe(1)
          else { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1) }
        }
      }
    }
  })
  it('New York tile is lit up, Los Angeles tile is not', () => {
    // z6 tiles: New York x=18,y=24 · Los Angeles x=10,y=25
    const ny = nightFactorTile(6, 18, 24, AT, 16)
    const la = nightFactorTile(6, 10, 25, AT, 16)
    expect(Math.max(...ny)).toBeGreaterThan(0.2)
    expect(Math.max(...la)).toBe(0)
  })
  it('antimeridian: the last column of the east-most tile meets the first column of tile 0', () => {
    for (const at of [new Date('2026-10-03T12:00:00Z'), new Date('2026-06-21T11:00:00Z'), new Date('2026-12-21T13:00:00Z')]) {
      const z = 3, y = 3
      const east = nightFactorTile(z, 2 ** z - 1, y, at, 64)
      const west = nightFactorTile(z, 0, y, at, 64)
      for (let py = 0; py < 64; py++) expect(Math.abs(east[py * 64 + 63] - west[py * 64])).toBeLessThan(0.08)
    }
  })
})

describe('lights extraction', () => {
  it('drops the dim blue land, keeps bright cores warm-white', () => {
    const px = new Uint8ClampedArray([12, 22, 48, 255, 250, 230, 170, 255, 120, 90, 50, 255])
    const { data, lit } = extractLights(px)
    expect(lit).toBe(true)
    expect(data[3]).toBe(0) // land
    expect(data[7]).toBeGreaterThan(220) // city core
    expect(data[11]).toBeGreaterThan(0) // suburb glow
    expect(data[11]).toBeLessThan(data[7])
  })
  it('an all-dark tile has no lights', () => {
    expect(extractLights(new Uint8ClampedArray(64).fill(10)).lit).toBe(false)
  })
  it('the sun instant is quantised to 2 minutes', () => {
    expect(lightsBucket(Date.parse('2026-10-03T23:31:59Z'))).toBe(Date.parse('2026-10-03T23:30:00Z'))
    expect(LIGHTS_BUCKET_MS).toBe(120_000)
  })
})
