/**
 * HERO ATLAS model (pure): which metrics the map can heat, how a geography is framed,
 * and the GeoJSON the MapLibre layers read. No React, no map instance: unit-tested.
 *
 * Honesty rules carried here:
 *   - one sequential hue, light → dark on light surfaces and dark → bright on dark ones;
 *   - colour = an area's RANK among the areas with a supported value (`t` from the API);
 *   - an area or ZIP whose value is thin / unavailable is drawn quiet, never coloured;
 *   - the density layer exists only for COUNT metrics (a density of shares or medians is meaningless).
 */
import type { MiGeoSummary, MiHeatResult, MiPoint, MiStatusPayload } from '../mi-types'
import { INFERRED_EXPLAINER } from './inferred-copy'

export type AtlasKind = 'count' | 'rate'
export interface AtlasMetric { id: string; label: string; short: string; kind: AtlasKind; hint: string; requires?: 'inferred_investor'; mfOnly?: boolean }

export const ATLAS_METRICS: readonly AtlasMetric[] = [
  { id: 'sales_count', label: 'Sales volume', short: 'Sales', kind: 'count', hint: 'Recorded sales in the period, by ZIP.' },
  { id: 'investor_purchase_count', label: 'Investor purchases · recorded', short: 'Investor buys', kind: 'count', hint: 'Sales whose deed names an investor buyer. A floor, not a share of all sales: most deeds name no buyer.' },
  { id: 'inferred_investor_count', label: 'Investor purchases · inferred', short: 'Inferred', kind: 'count', requires: 'inferred_investor', hint: INFERRED_EXPLAINER },
  { id: 'investor_purchase_share', label: 'Investor share', short: 'Investor %', kind: 'rate', hint: 'Recorded investor purchases ÷ the sales that record a buyer (shown at 20 or more).' },
  { id: 'cash_purchase_share', label: 'Cash share', short: 'Cash %', kind: 'rate', hint: 'Cash purchases ÷ the sales that record cash or financing (shown at 20 or more).' },
  { id: 'median_sale_price', label: 'Median price', short: 'Median $', kind: 'rate', hint: 'Median qualified sale price (10 or more priced sales).' },
  { id: 'median_ppsf', label: 'Median $/sq ft', short: '$/sq ft', kind: 'rate', hint: 'Median price per square foot (10 or more sales with a size).' },
  { id: 'median_price_per_unit', label: 'Multifamily price per door', short: 'MF $/door', kind: 'rate', mfOnly: true, hint: 'Median multifamily price ÷ unit count, only sales with a recorded unit count (5 or more).' },
]
export const ATLAS_BY_ID = new Map(ATLAS_METRICS.map((m) => [m.id, m]))
const MF_ASSETS = new Set(['all', 'mf', 'mf_2_4', 'mf_5_plus'])

/** Can this metric be drawn now? Returns the reason it can't (shown as the option's hint). */
export function atlasAvailability(m: AtlasMetric, asset: string, status: Pick<MiStatusPayload, 'inferred_investor'> | null): { ok: true } | { ok: false; reason: string } {
  if (m.requires === 'inferred_investor' && !status?.inferred_investor?.available) return { ok: false, reason: 'Pending: arrives with the inferred-investor summary build' }
  if (m.mfOnly && !MF_ASSETS.has(asset)) return { ok: false, reason: 'Multifamily only: pick All or a multifamily asset class' }
  return { ok: true }
}

export type Bounds = [[number, number], [number, number]]
export const CONUS: Bounds = [[-125, 24], [-66.5, 49.5]]

/** Camera bounds for a geography: CONUS nationwide, the bbox (padded) otherwise; a ZIP shows its neighbourhood. */
export function atlasFrame(g: Pick<MiGeoSummary, 'level' | 'bbox'>): Bounds {
  if (g.level === 'nation' || !g.bbox) return CONUS
  const [w, s, e, n] = g.bbox
  const k = g.level === 'zip' ? 2.2 : 0.06
  const px = Math.max(0.02, (e - w) * k)
  const py = Math.max(0.02, (n - s) * k)
  return [[w - px, s - py], [e + px, n + py]]
}

/** The outlines request: states nationwide (or for a state), ZIP outlines when the area fits ~3.8°. */
export function areasRequest(g: Pick<MiGeoSummary, 'level' | 'bbox'>): { bbox: string; zoom: number } {
  const nat = { bbox: '-125.0,24.0,-66.5,49.5', zoom: 4 }
  if (g.level === 'nation' || g.level === 'state' || !g.bbox) return nat
  const [[w, s], [e, n]] = atlasFrame(g)
  if (e - w > 3.8 || n - s > 3.8) return nat
  return { bbox: [w, s, e, n].map((x) => x.toFixed(3)).join(','), zoom: 10 }
}

type Props = Record<string, string | number | null>
const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features })

/**
 * Outlined areas → polygons. `member` = inside the subject geography (outside areas are drawn quiet).
 * Nationwide every state is a member; for a state only that state; in a metro the ZIPs the API lists.
 */
export function areasCollection(heat: Pick<MiHeatResult, 'rows' | 'level'> | null, subject: Pick<MiGeoSummary, 'id' | 'level'>, memberIds: ReadonlySet<string> | null): GeoJSON.FeatureCollection {
  if (!heat) return fc([])
  return fc(heat.rows.map((r) => {
    const member = subject.level === 'nation' ? true : subject.level === 'state' ? r.id === subject.id : memberIds ? memberIds.has(r.id) : true
    const props: Props = { id: r.id, label: r.label, t: member ? r.t : null, v: r.v, n: r.n, tip: r.tip, member: member ? 1 : 0 }
    return { type: 'Feature', id: r.id, properties: props, geometry: r.outline }
  }))
}

/** ZIP centroids → points. `w` = density weight (log-scaled count, 0..1); `ok` = a supported value. */
export function pointsCollection(rows: readonly MiPoint[] | null, kind: AtlasKind): GeoJSON.FeatureCollection {
  if (!rows?.length) return fc([])
  const max = rows.reduce((m, r) => (r.v !== null && r.v > m ? r.v : m), 0)
  const lmax = Math.log1p(max)
  return fc(rows.map((r) => {
    const ok = r.v !== null
    const w = kind === 'count' && ok && lmax > 0 ? Math.log1p(Math.max(0, r.v as number)) / lmax : 0
    const props: Props = { id: r.id, label: r.label, v: r.v, n: r.n, s: r.s, t: r.t, sales: r.sales, ok: ok ? 1 : 0, w: Math.round(w * 1000) / 1000 }
    return { type: 'Feature', id: r.id, properties: props, geometry: { type: 'Point', coordinates: r.c } }
  }))
}

/** One sequential hue (cobalt). Dark: deep → bright. Light: pale → deep. Five stops for t = 0, .25, .5, .75, 1. */
export const RAMP = {
  dark: ['#123563', '#1f5aa6', '#3489e0', '#6cc0f7', '#d6f1ff'],
  light: ['#dce9fb', '#a9c9f2', '#5b97e2', '#2563c4', '#0c2f6e'],
} as const
export type RampMode = keyof typeof RAMP
export const rampModeFor = (theme: string): RampMode => (theme === 'light' ? 'light' : 'dark')

/** MapLibre interpolate expression over a property in 0..1 (null handled by the caller's `case`). */
export function rampExpression(mode: RampMode, prop = 't'): unknown[] {
  const r = RAMP[mode]
  return ['interpolate', ['linear'], ['to-number', ['get', prop], 0], 0, r[0], 0.25, r[1], 0.5, r[2], 0.75, r[3], 1, r[4]]
}

/** Density colour ramp (heatmap-density 0..1): transparent at 0, then the same hue. */
export function densityColor(mode: RampMode): unknown[] {
  const r = RAMP[mode]
  const a = (hex: string, alpha: number) => {
    const n = parseInt(hex.slice(1), 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
  }
  return mode === 'dark'
    ? ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.08, a(r[0], 0.35), 0.3, a(r[1], 0.62), 0.55, a(r[2], 0.78), 0.8, a(r[3], 0.9), 1, a(r[4], 0.96)]
    : ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(255,255,255,0)', 0.08, a(r[1], 0.35), 0.3, a(r[2], 0.55), 0.55, a(r[3], 0.7), 0.8, a(r[4], 0.82), 1, a(r[4], 0.92)]
}

/** Legend end values from the drawn rows (real min / max of the supported values). */
export function legendRange(rows: ReadonlyArray<{ v: number | null }>): { min: number; max: number } | null {
  let min = Infinity
  let max = -Infinity
  for (const r of rows) if (r.v !== null && Number.isFinite(r.v)) { if (r.v < min) min = r.v; if (r.v > max) max = r.v }
  return Number.isFinite(min) ? { min, max } : null
}
