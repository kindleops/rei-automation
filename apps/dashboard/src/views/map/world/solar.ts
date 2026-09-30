/**
 * SOLAR ENGINE — where the sun is, for any instant and any place.
 *
 * Pure and deterministic (same instant + place → same answer): the standard
 * low-precision solar model (mean anomaly, equation of centre, obliquity
 * 23.4397°), accurate to well under half a degree — far below what a map can
 * show. Day/night is ASTRONOMY, not the operator's clock: it depends only on
 * the UTC instant and the coordinates being viewed.
 *
 *   solarPosition   altitude/azimuth of the sun at a place
 *   subsolarPoint   where the sun is directly overhead right now
 *   darkRegion      GeoJSON of everywhere the sun is below a given altitude
 *                   (0° = sunset line, −6° civil, −12° nautical dusk …)
 *   lightState      one smooth description of the light at a place
 */

const RAD = Math.PI / 180
const DAY_MS = 86400000
const J1970 = 2440588
const J2000 = 2451545
const OBLIQUITY = RAD * 23.4397

const toDays = (date: Date) => date.valueOf() / DAY_MS - 0.5 + J1970 - J2000
const meanAnomaly = (d: number) => RAD * (357.5291 + 0.98560028 * d)
const eclipticLongitude = (M: number) => {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M))
  return M + C + RAD * 102.9372 + Math.PI
}
const declination = (L: number) => Math.asin(Math.sin(OBLIQUITY) * Math.sin(L))
const rightAscension = (L: number) => Math.atan2(Math.sin(L) * Math.cos(OBLIQUITY), Math.cos(L))
const siderealTime = (d: number, lw: number) => RAD * (280.16 + 360.9856235 * d) - lw

function sunCoords(d: number) {
  const L = eclipticLongitude(meanAnomaly(d))
  return { dec: declination(L), ra: rightAscension(L) }
}

const wrapLng = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180

export interface SolarPosition {
  /** Degrees above the horizon (negative = below). */
  altitude: number
  /** Compass bearing of the sun, degrees clockwise from north. */
  azimuth: number
  /** True before local solar noon. */
  rising: boolean
}

export function solarPosition(date: Date, lat: number, lng: number): SolarPosition {
  const lw = RAD * -lng
  const phi = RAD * lat
  const d = toDays(date)
  const c = sunCoords(d)
  const H = siderealTime(d, lw) - c.ra
  // Clamped: directly under the sun rounding lands a hair past 1 and asin → NaN.
  const altitude = Math.asin(Math.min(1, Math.max(-1, Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H))))
  // atan2 form measured from south, westward → convert to a compass bearing.
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(c.dec) * Math.cos(phi))
  const hourAngle = ((H / RAD) % 360 + 540) % 360 - 180
  return { altitude: altitude / RAD, azimuth: ((az / RAD + 180) % 360 + 360) % 360, rising: hourAngle < 0 }
}

/** The point where the sun is directly overhead. */
export function subsolarPoint(date: Date): { lat: number; lng: number } {
  const d = toDays(date)
  const c = sunCoords(d)
  // Hour angle H = GMST + lng − RA (solarPosition's convention) is zero where
  // lng = RA − GMST. The reverse sign mirrors the sun about 0/180° longitude —
  // invisible near 00:00 UTC, ~20° wrong by evening in the Americas.
  const lng = (c.ra - RAD * (280.16 + 360.9856235 * d)) / RAD
  return { lat: c.dec / RAD, lng: wrapLng(lng) }
}

/** Point at angular distance `r` (degrees) and bearing `theta` (degrees) from a centre. */
function destination(lat: number, lng: number, r: number, theta: number): [number, number] {
  const p1 = lat * RAD, l1 = lng * RAD, d = r * RAD, t = theta * RAD
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t))
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2))
  return [l2 / RAD, p2 / RAD]
}

const MAX_LAT = 85.05

export type DarkGeometry = GeoJSON.Polygon

/**
 * Everywhere the sun is below `altitude` degrees at `date`.
 *
 * The boundary is a small circle around the subsolar point (radius 90° −
 * altitude). Which side is "dark" depends on whether each pole is dark: the
 * sun's altitude at the north pole equals its declination, at the south pole
 * minus it — so the geometry is built exactly, including polar day/night,
 * with no hard-coded seasons.
 */
export function darkRegion(date: Date, altitude: number, step = 3): DarkGeometry {
  const sun = subsolarPoint(date)
  const radius = 90 - altitude
  const northDark = sun.lat < altitude
  const southDark = -sun.lat < altitude
  const ring: Array<[number, number]> = []
  for (let theta = 0; theta <= 360; theta += step) ring.push(destination(sun.lat, sun.lng, radius, theta))
  // Unwrap longitudes into one continuous run.
  for (let i = 1; i < ring.length; i++) {
    let [lng] = ring[i]
    const prev = ring[i - 1][0]
    while (lng - prev > 180) lng -= 360
    while (lng - prev < -180) lng += 360
    ring[i] = [lng, Math.max(-MAX_LAT, Math.min(MAX_LAT, ring[i][1]))]
  }
  ring[0] = [ring[0][0], Math.max(-MAX_LAT, Math.min(MAX_LAT, ring[0][1]))]
  const winds = Math.abs(ring[ring.length - 1][0] - ring[0][0]) > 180

  if (winds) {
    // The circle wraps a pole: the dark side is the band between it and the dark pole.
    if (ring[ring.length - 1][0] < ring[0][0]) ring.reverse()
    const poleLat = northDark ? MAX_LAT : -MAX_LAT
    const first = ring[0][0], last = ring[ring.length - 1][0]
    return { type: 'Polygon', coordinates: [[...ring, [last, poleLat], [first, poleLat], ring[0]]] }
  }
  // Circle does not wrap a pole. Shift the WHOLE ring next to the sun (points
  // near the poles swing far in longitude; shifting them one by one tears it).
  const k = Math.round((ring[0][0] - sun.lng) / 360) * 360
  const lit = ring.map(([x, y]) => [x - k, y] as [number, number])
  if (northDark && southDark) {
    // Both poles dark: the dark side is one world width, centred on the sun,
    // minus the lit disc. Exactly one world: the GeoJSON tiler wraps anything
    // wider back onto the map, and each copy would stack another layer of tint.
    const w0 = sun.lng - 180, w1 = sun.lng + 180
    const world: Array<[number, number]> = [[w0, -MAX_LAT], [w1, -MAX_LAT], [w1, MAX_LAT], [w0, MAX_LAT], [w0, -MAX_LAT]]
    return { type: 'Polygon', coordinates: [world, lit.slice().reverse()] }
  }
  // Neither pole dark: the dark side is the small disc itself (deep night, short winter days).
  const antiLng = sun.lng + 180
  const center: [number, number] = [antiLng, -sun.lat]
  const disc: Array<[number, number]> = []
  for (let theta = 0; theta <= 360; theta += step) {
    const [x, y] = destination(center[1], center[0], 90 + altitude, theta)
    disc.push([x - Math.round((x - antiLng) / 360) * 360, Math.max(-MAX_LAT, Math.min(MAX_LAT, y))])
  }
  return { type: 'Polygon', coordinates: [disc] }
}

export type LightPhase = 'day' | 'golden' | 'twilight' | 'night'

export interface LightState {
  altitude: number
  azimuth: number
  rising: boolean
  phase: LightPhase
  /** 0 = deep night … 1 = full day, smooth. */
  light: number
  /** 0…1 golden-hour warmth, peaks just above the horizon. */
  warmth: number
  label: string
}

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

export function lightState(date: Date, lat: number, lng: number): LightState {
  const p = solarPosition(date, lat, lng)
  const a = p.altitude
  const phase: LightPhase = a >= 10 ? 'day' : a >= -0.833 ? 'golden' : a >= -12 ? 'twilight' : 'night'
  const light = smooth(-12, 8, a)
  const warmth = Math.max(0, 1 - Math.abs(a - 2) / 9)
  const label = phase === 'day' ? 'Daylight'
    : phase === 'golden' ? (p.rising ? 'Sunrise light' : 'Golden hour')
      : phase === 'twilight' ? (p.rising ? 'Dawn' : 'Twilight')
        : 'Night'
  return { altitude: a, azimuth: p.azimuth, rising: p.rising, phase, light, warmth, label }
}

/** Band thresholds (degrees) from bright to deep night, with their tint role. */
export const LIGHT_BANDS: ReadonlyArray<{ altitude: number; role: 'golden' | 'dusk' | 'night' }> = [
  { altitude: 6, role: 'golden' },
  { altitude: 2, role: 'golden' },
  { altitude: -0.833, role: 'dusk' },
  { altitude: -4, role: 'dusk' },
  { altitude: -8, role: 'night' },
  { altitude: -12, role: 'night' },
  { altitude: -16, role: 'night' },
]

/** Point-in-polygon for tests and hit checks (ray casting, first ring minus holes). */
export function containsPoint(poly: DarkGeometry, lng: number, lat: number): boolean {
  const inRing = (ring: number[][], x: number, y: number) => {
    let c = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j]
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
    }
    return c
  }
  for (const shift of [0, 360, -360]) {
    const x = lng + shift
    if (inRing(poly.coordinates[0], x, lat) && !poly.coordinates.slice(1).some((h) => inRing(h, x, lat))) return true
  }
  return false
}

/**
 * The next sunrise or sunset after `from` at a place (standard −0.833°
 * horizon), found by stepping forward and bisecting. Null under polar
 * day/night, when the sun does not cross the horizon within a day.
 */
export function nextSunEvent(from: Date, lat: number, lng: number): { kind: 'sunrise' | 'sunset'; at: Date } | null {
  const H = -0.833
  const alt = (t: number) => solarPosition(new Date(t), lat, lng).altitude - H
  const t0 = from.valueOf()
  let prevT = t0
  let prevA = alt(t0)
  for (let t = t0 + 5 * 60_000; t <= t0 + 26 * 3600_000; t += 5 * 60_000) {
    const a = alt(t)
    if ((prevA < 0) !== (a < 0)) {
      let lo = prevT, hi = t
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2
        if ((alt(mid) < 0) === (prevA < 0)) lo = mid
        else hi = mid
      }
      return { kind: prevA < 0 ? 'sunrise' : 'sunset', at: new Date(Math.round(hi)) }
    }
    prevT = t
    prevA = a
  }
  return null
}

/**
 * The sunset/sunrise line itself (sun at `altitude`) as a line — only the
 * small circle, never the edges a polygon uses to close around a pole.
 * Longitudes are unwrapped so the line is continuous across the dateline.
 */
export function terminatorLine(date: Date, altitude = -0.833, step = 2): GeoJSON.LineString {
  const sun = subsolarPoint(date)
  const pts: Array<[number, number]> = []
  for (let theta = 0; theta <= 360; theta += step) pts.push(destination(sun.lat, sun.lng, 90 - altitude, theta))
  for (let i = 1; i < pts.length; i++) {
    let [lng] = pts[i]
    const prev = pts[i - 1][0]
    while (lng - prev > 180) lng -= 360
    while (lng - prev < -180) lng += 360
    pts[i] = [lng, pts[i][1]]
  }
  return { type: 'LineString', coordinates: pts.map(([x, y]) => [x, Math.max(-MAX_LAT, Math.min(MAX_LAT, y))]) }
}
