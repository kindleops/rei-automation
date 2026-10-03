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

/**
 * NOAA solar model (Meeus, "Astronomical Algorithms" — the equations behind
 * the NOAA Solar Calculator): apparent solar declination and the equation of
 * time for an instant. Sunrise/sunset from it match NOAA's published tables to
 * the minute (solar.test.ts).
 */
export function solarEphemeris(date: Date): { declination: number; eqTimeMin: number } {
  const jd = date.valueOf() / DAY_MS + 2440587.5
  const T = (jd - 2451545) / 36525
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T)
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T)
  const Mr = M * RAD
  const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) + Math.sin(3 * Mr) * 0.000289
  const omega = (125.04 - 1934.136 * T) * RAD
  const lambda = (L0 + C - 0.00569 - 0.00478 * Math.sin(omega)) * RAD
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60
  const eps = (eps0 + 0.00256 * Math.cos(omega)) * RAD
  const declination = Math.asin(Math.sin(eps) * Math.sin(lambda)) / RAD
  const y = Math.tan(eps / 2) ** 2
  const L = L0 * RAD
  const eqTime = y * Math.sin(2 * L) - 2 * e * Math.sin(Mr) + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L)
    - 0.5 * y * y * Math.sin(4 * L) - 1.25 * e * e * Math.sin(2 * Mr)
  return { declination, eqTimeMin: (4 * eqTime) / RAD }
}

const utcMinutes = (date: Date) => ((((date.valueOf() % DAY_MS) + DAY_MS) % DAY_MS) / 60000)

const wrapLng = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180

export interface SolarPosition {
  /** Degrees above the horizon (negative = below). Geometric, no refraction. */
  altitude: number
  /** Compass bearing of the sun, degrees clockwise from north. */
  azimuth: number
  /** True before local solar noon. */
  rising: boolean
}

export function solarPosition(date: Date, lat: number, lng: number): SolarPosition {
  const { declination, eqTimeMin } = solarEphemeris(date)
  const dec = declination * RAD
  const phi = RAD * lat
  // True solar time → hour angle (0 at local solar noon, negative in the morning).
  const tst = utcMinutes(date) + eqTimeMin + 4 * lng
  const haDeg = ((((tst / 4 - 180) % 360) + 540) % 360) - 180
  const H = haDeg * RAD
  // Clamped: directly under the sun rounding lands a hair past 1 and asin → NaN.
  const altitude = Math.asin(Math.min(1, Math.max(-1, Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H))))
  // atan2 form measured from south, westward → convert to a compass bearing.
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi))
  return { altitude: altitude / RAD, azimuth: ((az / RAD + 180) % 360 + 360) % 360, rising: haDeg < 0 }
}

/**
 * The point where the sun is directly overhead: latitude = declination,
 * longitude where true solar time is noon (UTC 12:00 shifted by the equation
 * of time — the sun runs up to ~16 minutes ahead of or behind the clock).
 */
export function subsolarPoint(date: Date): { lat: number; lng: number } {
  const { declination, eqTimeMin } = solarEphemeris(date)
  return { lat: declination, lng: wrapLng((720 - utcMinutes(date) - eqTimeMin) / 4) }
}

/**
 * Sunrise, solar noon and sunset (NOAA convention: sun's upper limb on the
 * horizon with standard refraction, altitude −0.833°) for the UTC calendar day
 * of `day`, at a place. Each event is refined against the ephemeris at that
 * event's own instant. Null under polar day/night.
 */
export function sunTimes(day: Date, lat: number, lng: number, altitude = -0.833): { sunrise: Date; noon: Date; sunset: Date } | null {
  const midnight = Math.floor(day.valueOf() / DAY_MS) * DAY_MS
  const at = (min: number) => new Date(midnight + min * 60000)
  const noonAt = (guessMin: number) => 720 - 4 * lng - solarEphemeris(at(guessMin)).eqTimeMin
  const noon = noonAt(noonAt(720 - 4 * lng))
  const event = (sign: 1 | -1) => {
    let t = noon
    for (let i = 0; i < 3; i++) {
      const dec = solarEphemeris(at(t)).declination * RAD
      const phi = lat * RAD
      const cosH = (Math.sin(altitude * RAD) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec))
      if (cosH < -1 || cosH > 1) return null
      const ha = Math.acos(cosH) / RAD
      t = 720 - 4 * (lng - sign * ha) - solarEphemeris(at(t)).eqTimeMin
    }
    return at(t)
  }
  const sunrise = event(-1)
  const sunset = event(1)
  if (!sunrise || !sunset) return null
  return { sunrise, noon: at(noon), sunset }
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
  return regionBelow(subsolarPoint(date), altitude, step)
}

/**
 * Everywhere the sun is ABOVE `altitude` degrees — the lit side. The sun's
 * altitude at a place is minus the altitude of the antisolar point there, so
 * the lit side is the "dark region" of the antisolar point at −altitude.
 */
export function litRegion(date: Date, altitude: number, step = 3): DarkGeometry {
  const s = subsolarPoint(date)
  return regionBelow({ lat: -s.lat, lng: wrapLng(s.lng + 180) }, -altitude, step)
}

function regionBelow(sun: { lat: number; lng: number }, altitude: number, step: number): DarkGeometry {
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
