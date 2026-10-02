#!/usr/bin/env node
/**
 * Generates the Analytics Lab heat map's boundary geometry —
 * src/views/analytics/intelligence/atlas/us-states.json and
 * atlas/counties/<ST>.json — from us-atlas@3 `counties-albers-10m.json`
 * (US Census Bureau cartographic boundaries, 1:10m, pre-projected to Albers
 * USA with Alaska / Hawaii insets in a 975 × 610 frame — the SAME frame and
 * source as Home's dot matrix, so the two always register; ISC licence).
 *
 * The package is not a dependency: fetch it once and point this script at it.
 *
 *   npm pack us-atlas@3 && tar xzf us-atlas-3.0.1.tgz
 *   node scripts/generate-us-atlas-areas.mjs package/counties-albers-10m.json
 *
 * Arcs are simplified ONCE (Ramer–Douglas–Peucker, per shared arc, so
 * neighbouring areas still meet exactly) and written as SVG path data with
 * 0.1-unit precision. Counties are split per state so a drill loads only the
 * state it opens. Geometry only — no business data is involved.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const source = process.argv[2]
if (!source) {
  console.error('usage: node scripts/generate-us-atlas-areas.mjs <counties-albers-10m.json>')
  process.exit(1)
}
const STATE_TOL = 0.35
const COUNTY_TOL = 0.04

const FIPS = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL',
  '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE',
  '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY', '72': 'PR',
}

const topology = JSON.parse(fs.readFileSync(source, 'utf8'))
const { scale = [1, 1], translate = [0, 0] } = topology.transform ?? {}
const raw = topology.arcs.map((arc) => {
  let x = 0
  let y = 0
  return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * scale[0] + translate[0], y * scale[1] + translate[1]] })
})

function rdp(points, tol) {
  if (points.length <= 2) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1; keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const [ax, ay] = points[a]
    const [bx, by] = points[b]
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy) || 1
    let best = -1
    let bestD = tol
    for (let i = a + 1; i < b; i += 1) {
      const d = Math.abs(dy * points[i][0] - dx * points[i][1] + bx * ay - by * ax) / len
      if (d > bestD) { bestD = d; best = i }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]) }
  }
  return points.filter((_, i) => keep[i])
}
const simplified = (tol) => raw.map((a) => rdp(a, tol))

function pathOf(geom, arcs) {
  const arcPoints = (i) => (i >= 0 ? arcs[i] : [...arcs[~i]].reverse())
  const ring = (indices) => indices.flatMap((idx, k) => (k === 0 ? arcPoints(idx) : arcPoints(idx).slice(1)))
  const polys = geom.type === 'Polygon' ? [geom.arcs] : geom.type === 'MultiPolygon' ? geom.arcs : []
  let d = ''
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity
  let ax = 0; let ay = 0; let aw = 0
  for (const poly of polys) {
    poly.forEach((r, ri) => {
      const pts = ring(r)
      if (pts.length < 3) return
      d += `M${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z`
      if (ri === 0) {
        // the label anchor: area-weighted centroid of outer rings
        let a2 = 0; let cx = 0; let cy = 0
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
          const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]
          a2 += f; cx += (pts[j][0] + pts[i][0]) * f; cy += (pts[j][1] + pts[i][1]) * f
        }
        if (Math.abs(a2) > 1e-9) { const w = Math.abs(a2); ax += (cx / (3 * a2)) * w; ay += (cy / (3 * a2)) * w; aw += w }
      }
      for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y }
    })
  }
  const r1 = (v) => Math.round(v * 10) / 10
  return { d, box: [r1(x0), r1(y0), r1(x1), r1(y1)], at: aw ? [r1(ax / aw), r1(ay / aw)] : [r1((x0 + x1) / 2), r1((y0 + y1) / 2)] }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(here, '../src/views/analytics/intelligence/atlas')
fs.mkdirSync(path.join(outDir, 'counties'), { recursive: true })

const stateArcs = simplified(STATE_TOL)
const states = topology.objects.states.geometries.map((g) => {
  const abbr = FIPS[g.id]
  const p = pathOf(g, stateArcs)
  return { id: g.id, abbr, name: g.properties?.name || abbr, ...p }
}).filter((s) => s.abbr && s.d)
fs.writeFileSync(path.join(outDir, 'us-states.json'), JSON.stringify(states))

const countyArcs = simplified(COUNTY_TOL)
const byState = new Map()
for (const g of topology.objects.counties.geometries) {
  const abbr = FIPS[String(g.id).slice(0, 2)]
  if (!abbr) continue
  const p = pathOf(g, countyArcs)
  if (!p.d) continue
  const list = byState.get(abbr) || []
  list.push({ id: g.id, name: g.properties?.name || g.id, ...p })
  byState.set(abbr, list)
}
let total = 0
for (const [abbr, list] of byState) {
  const body = JSON.stringify(list)
  total += body.length
  fs.writeFileSync(path.join(outDir, 'counties', `${abbr}.json`), body)
}
console.log(`states ${states.length} (${fs.statSync(path.join(outDir, 'us-states.json')).size} B) · counties ${[...byState.values()].reduce((a, l) => a + l.length, 0)} in ${byState.size} files (${total} B)`)
