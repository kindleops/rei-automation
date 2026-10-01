/**
 * ANALYTICS 4.0 — the analytical map's geometry.
 *
 * The same Census dot matrix the desktop uses (us-atlas states, Albers USA,
 * generated once — see views/home/us-dot-matrix.ts) and the same Albers USA
 * projection it was drawn in, so a market centroid lands on the same pixel
 * here as on Home. Pure functions: geometry only, never a number.
 */
import { US_DOTS, US_STATES, US_VIEWBOX } from '../../home/us-dot-matrix'

export const VIEWBOX = US_VIEWBOX
export const DOT_SPACING = 11.5

export interface Dot { x: number; y: number; state: number }

let DOTS: Dot[] | null = null
export function dots(): Dot[] {
  if (DOTS) return DOTS
  const out: Dot[] = []
  for (let i = 0; i < US_DOTS.length; i += 3) out.push({ x: US_DOTS[i] / 10, y: US_DOTS[i + 1] / 10, state: US_DOTS[i + 2] })
  DOTS = out
  return out
}

export const stateAbbr = (index: number) => US_STATES[index]?.abbr ?? null
export const stateName = (index: number) => US_STATES[index]?.name ?? null
const BY_ABBR = new Map(US_STATES.map((s, i) => [s.abbr, i]))
export const stateIndex = (abbr: string | null | undefined) => (abbr ? BY_ABBR.get(abbr.toUpperCase()) ?? null : null)
export const stateLabel = (abbr: string) => US_STATES[stateIndex(abbr) ?? -1]?.name ?? abbr

/* ── Albers USA (d3.geoAlbersUsa().scale(1300).translate([487.5, 305])) ── */

const RAD = Math.PI / 180
function conicEqualArea(phi0: number, phi1: number) {
  const sy0 = Math.sin(phi0)
  const n = (sy0 + Math.sin(phi1)) / 2
  const c = 1 + sy0 * (2 * n - sy0)
  const r0 = Math.sqrt(c) / n
  return (lambda: number, phi: number): [number, number] => {
    const r = Math.sqrt(c - 2 * n * Math.sin(phi)) / n
    const x = lambda * n
    return [r * Math.sin(x), r0 - r * Math.cos(x)]
  }
}
function conic(o: { parallels: [number, number]; rotate: number; center: [number, number]; scale: number; translate: [number, number] }) {
  const raw = conicEqualArea(o.parallels[0] * RAD, o.parallels[1] * RAD)
  const [cx, cy] = raw(o.center[0] * RAD, o.center[1] * RAD)
  const dx = o.translate[0] - o.scale * cx
  const dy = o.translate[1] + o.scale * cy
  return (lng: number, lat: number): [number, number] => {
    let lambda = (lng + o.rotate) * RAD
    if (lambda > Math.PI) lambda -= 2 * Math.PI
    else if (lambda < -Math.PI) lambda += 2 * Math.PI
    const [x, y] = raw(lambda, lat * RAD)
    return [dx + o.scale * x, dy - o.scale * y]
  }
}
const K = 1300
const T: [number, number] = [487.5, 305]
const LOWER48 = conic({ parallels: [29.5, 45.5], rotate: 96, center: [-0.6, 38.7], scale: K, translate: T })
const ALASKA = conic({ parallels: [55, 65], rotate: 154, center: [-2, 58.5], scale: K * 0.35, translate: [T[0] - 0.307 * K, T[1] + 0.201 * K] })
const HAWAII = conic({ parallels: [8, 18], rotate: 157, center: [-3, 19.9], scale: K, translate: [T[0] - 0.205 * K, T[1] + 0.212 * K] })

/** [x, y] in the dot matrix's viewBox, or null outside the US. */
export function project(lng: number, lat: number): [number, number] | null {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  if (lat >= 50 && (lng <= -129 || lng >= 170)) return ALASKA(lng >= 170 ? lng - 360 : lng, lat)
  if (lat >= 18 && lat <= 23 && lng >= -161 && lng <= -154) return HAWAII(lng, lat)
  if (lat < 24 || lat > 50 || lng < -125.5 || lng > -66) return null
  return LOWER48(lng, lat)
}

/* ── nearest dot (spatial hash) ─────────────────────────────────────────── */

let HASH: Map<string, number[]> | null = null
const cellKey = (x: number, y: number) => `${Math.floor(x / DOT_SPACING)}:${Math.floor(y / DOT_SPACING)}`
function hash(): Map<string, number[]> {
  if (HASH) return HASH
  const map = new Map<string, number[]>()
  dots().forEach((d, i) => {
    const k = cellKey(d.x, d.y)
    const list = map.get(k)
    if (list) list.push(i); else map.set(k, [i])
  })
  HASH = map
  return map
}
/** The dot under a viewBox point (within ~1.5 dot spacings), else null. */
export function nearestDot(x: number, y: number, radius = DOT_SPACING * 1.5): number | null {
  const h = hash()
  const all = dots()
  const span = Math.ceil(radius / DOT_SPACING)
  const cx = Math.floor(x / DOT_SPACING)
  const cy = Math.floor(y / DOT_SPACING)
  let best: number | null = null
  let bestD = radius * radius
  for (let gx = cx - span; gx <= cx + span; gx += 1) {
    for (let gy = cy - span; gy <= cy + span; gy += 1) {
      for (const i of h.get(`${gx}:${gy}`) ?? []) {
        const d2 = (all[i].x - x) ** 2 + (all[i].y - y) ** 2
        if (d2 <= bestD) { bestD = d2; best = i }
      }
    }
  }
  return best
}

/** The viewBox rectangle a state's dots occupy (for zooming into it), padded. */
export function stateBox(abbr: string, pad = DOT_SPACING * 2): { x: number; y: number; w: number; h: number } | null {
  const i = stateIndex(abbr)
  if (i === null) return null
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity
  for (const d of dots()) {
    if (d.state !== i) continue
    if (d.x < x0) x0 = d.x
    if (d.y < y0) y0 = d.y
    if (d.x > x1) x1 = d.x
    if (d.y > y1) y1 = d.y
  }
  if (!Number.isFinite(x0)) return null
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 }
}

/** The box that holds a set of projected points (a market's ZIPs), padded and never smaller than `min`. */
export function pointsBox(points: Array<[number, number]>, pad = DOT_SPACING * 3, min = 60): { x: number; y: number; w: number; h: number } | null {
  if (!points.length) return null
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity
  for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  const w = Math.max(min, x1 - x0 + pad * 2)
  const h = Math.max(min * (VIEWBOX.height / VIEWBOX.width), y1 - y0 + pad * 2)
  return { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h }
}

/** Fit a viewBox rectangle into a canvas of the map's aspect ratio (letterboxed, centred). */
export function fitBox(box: { x: number; y: number; w: number; h: number }) {
  const aspect = VIEWBOX.width / VIEWBOX.height
  let { x, y, w, h } = box
  if (w / h > aspect) { const nh = w / aspect; y -= (nh - h) / 2; h = nh } else { const nw = h * aspect; x -= (nw - w) / 2; w = nw }
  return { x, y, w, h, scale: VIEWBOX.width / w }
}
