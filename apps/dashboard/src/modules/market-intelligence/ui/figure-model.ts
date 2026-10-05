import type { MiGeoSummary } from '../mi-types'

/** The viewport request for a geography: ZIP outlines for areas ≤ ~3.5°, else states. */
export function figureRequest(g: Pick<MiGeoSummary, 'level' | 'bbox' | 'centroid'>): { bbox: string; zoom: number } | null {
  if (g.level === 'nation' || g.level === 'state' || !g.bbox) return { bbox: '-125.0,24.0,-66.5,49.5', zoom: 4 }
  let [w, s, e, n] = g.bbox
  const pad = Math.max(0.03, (e - w) * (g.level === 'zip' ? 1.6 : 0.08), (n - s) * (g.level === 'zip' ? 1.6 : 0.08))
  w -= pad; e += pad; s -= pad; n += pad
  if (e - w > 3.8 || n - s > 3.8) return { bbox: '-125.0,24.0,-66.5,49.5', zoom: 4 }
  return { bbox: [w, s, e, n].map((x) => x.toFixed(3)).join(','), zoom: 10 }
}

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * (180 / Math.PI)

/** Pure: GeoJSON outlines → SVG paths fitted to a viewBox. */
export function projectOutlines(rows: Array<{ id: string; outline: GeoJSON.Geometry }>, W: number, H: number) {
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity
  const ringsOf = (g: GeoJSON.Geometry): number[][][] => (g.type === 'Polygon' ? (g.coordinates as number[][][]) : g.type === 'MultiPolygon' ? (g.coordinates as number[][][][]).flat() : [])
  for (const r of rows) for (const ring of ringsOf(r.outline)) for (const [x, y] of ring) { const my = mercY(y); if (x < minX) minX = x; if (x > maxX) maxX = x; if (my < minY) minY = my; if (my > maxY) maxY = my }
  if (!Number.isFinite(minX)) return { paths: [], ok: false }
  const sx = W / Math.max(1e-6, maxX - minX); const sy = H / Math.max(1e-6, maxY - minY)
  const k = Math.min(sx, sy) * 0.94
  const ox = (W - (maxX - minX) * k) / 2; const oy = (H - (maxY - minY) * k) / 2
  const px = (x: number) => (ox + (x - minX) * k).toFixed(1)
  const py = (y: number) => (oy + (maxY - mercY(y)) * k).toFixed(1)
  const paths = rows.map((r) => ({ id: r.id, d: ringsOf(r.outline).map((ring) => `M${ring.map(([x, y]) => `${px(x)},${py(y)}`).join('L')}Z`).join('') }))
  return { paths, ok: true }
}

