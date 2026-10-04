import type { RecentSale } from '../../../domain/comp-intelligence/comps-evidence-api'

/**
 * RECENT MARKET SALES — the comps map's own layer (display only, 2026-10-04).
 *
 * Canonical recorded sales near the subject (mv_map_market_sales). They are
 * NOT valuation evidence, so the layer never borrows the valuation set's
 * styling: it is a square (every evidence tier is a circle; the subject is a
 * diamond), neutral ink (no
 * set / candidate / attention colour), never coloured by the analysis ramp,
 * never clustered with the universe, drawn beneath every evidence layer and
 * not clickable into the comp inspector. Priced sales are solid squares;
 * activity-only rows (no usable price) are hollow.
 */
export const RECENT_LAYER_LABEL = 'Recent market sales · not in valuation'
export const RECENT_SOURCE = 'ci-recent'
export const RECENT_LAYERS = ['ci-recent'] as const
export const RECENT_ICON_PRICED = 'ci-recent-priced'
export const RECENT_ICON_ACTIVITY = 'ci-recent-activity'

export interface RecentPoint {
  key: string
  lat: number
  lng: number
  priced: boolean
  label: string
}

const finite = (v: number | null): v is number => v !== null && Number.isFinite(v) && Math.abs(v) > 0.0001

/** Pure: recent-sale rows → map points (rows without coordinates are not drawn). */
export function recentPoints(rows: RecentSale[] | null | undefined, fmtPrice: (n: number) => string): RecentPoint[] {
  const out: RecentPoint[] = []
  for (const r of rows ?? []) {
    if (!finite(r.lat) || !finite(r.lng)) continue
    out.push({
      key: r.key,
      lat: r.lat,
      lng: r.lng,
      priced: r.priced && r.price !== null,
      label: r.priced && r.price !== null ? fmtPrice(r.price) : 'activity',
    })
  }
  return out
}

/** Pure: points → the layer's GeoJSON (its own source; never the evidence sources). */
export function recentCollection(points: RecentPoint[], show: boolean) {
  return {
    type: 'FeatureCollection' as const,
    features: (show ? points : []).map((p) => ({
      type: 'Feature' as const,
      id: p.key,
      properties: { key: p.key, priced: p.priced ? 1 : 0, label: p.label, layer: 'recent_market_sales' },
      geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
    })),
  }
}

/** Parses '#rgb' / '#rrggbb' / 'rgb(a)(…)' into RGBA bytes; unknown → opaque white. */
export function rgba(color: string): [number, number, number, number] {
  const c = color.trim()
  const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((x) => x + x).join('') : hex[1]
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255]
  }
  const fn = c.match(/^rgba?\(([^)]+)\)$/i)
  if (fn) {
    const [r, g, b, a] = fn[1].split(/[,\s/]+/).filter(Boolean).map(Number)
    if ([r, g, b].every(Number.isFinite)) return [r, g, b, Math.round((Number.isFinite(a) ? a : 1) * 255)]
  }
  return [255, 255, 255, 255]
}

/**
 * Pure: a square marker as raw RGBA pixels (map.addImage accepts this
 * directly — no canvas, no font glyphs). Solid = priced; hollow = activity.
 */
export function squareImage(size: number, ink: string, halo: string, hollow: boolean): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(size * size * 4)
  const c = (size - 1) / 2
  const outer = c * 0.78
  const haloW = Math.max(1.2, size * 0.1)
  const strokeW = Math.max(1.4, size * 0.13)
  const inkRGBA = rgba(ink)
  const haloRGBA = rgba(halo)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.max(Math.abs(x - c), Math.abs(y - c))
      let px: [number, number, number, number] | null = null
      if (d <= outer - haloW) {
        const inStroke = d > outer - haloW - strokeW
        px = hollow && !inStroke ? null : inkRGBA
      } else if (d <= outer) px = haloRGBA
      if (!px) continue
      const i = (y * size + x) * 4
      data[i] = px[0]; data[i + 1] = px[1]; data[i + 2] = px[2]; data[i + 3] = px[3]
    }
  }
  return { width: size, height: size, data }
}
