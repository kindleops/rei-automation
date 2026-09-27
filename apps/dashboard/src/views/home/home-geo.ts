/**
 * Albers USA, lower 48, matching us-atlas `states-albers-10m` exactly
 * (d3.geoAlbersUsa().scale(1300).translate([487.5, 305])): conic equal-area,
 * standard parallels 29.5°N / 45.5°N, rotated to 96°W, centred on 38.7°N.
 *
 * Verified against the Census geometry when the dot matrix was generated: the
 * projected bounding box of Colorado's lon/lat boundary equals the pre-projected
 * one to 0.1 units. Alaska and Hawaii are drawn as insets with their own
 * projections, so points there return null rather than a wrong location.
 */

const RAD = Math.PI / 180
const PHI0 = 29.5 * RAD
const PHI1 = 45.5 * RAD
const N = (Math.sin(PHI0) + Math.sin(PHI1)) / 2
const C = 1 + Math.sin(PHI0) * (2 * N - Math.sin(PHI0))
const R0 = Math.sqrt(C) / N
const K = 1300
const TX = 487.5
const TY = 305

const raw = (lambda: number, phi: number): [number, number] => {
  const r = Math.sqrt(C - 2 * N * Math.sin(phi)) / N
  return [r * Math.sin(lambda * N), R0 - r * Math.cos(lambda * N)]
}

const [CX, CY] = raw(-0.6 * RAD, 38.7 * RAD)

export function projectAlbersUsa(lng: number, lat: number): [number, number] | null {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  // Lower 48 only (with a margin for the coasts and Keys).
  if (lat < 24 || lat > 50 || lng < -125.5 || lng > -66) return null
  const [x, y] = raw((lng + 96) * RAD, lat * RAD)
  return [TX + K * (x - CX), TY - K * (y - CY)]
}
