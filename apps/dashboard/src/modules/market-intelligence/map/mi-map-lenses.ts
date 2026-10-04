/**
 * MARKET INTELLIGENCE MODE ON THE EXISTING MAP (brief §11, §12, §27).
 *
 * Not a second map engine: these are entries in the Map's own lens registry
 * (family 'intel', drawn by its useMapLens area layers). Only the data source
 * differs. Values come from GET /api/cockpit/market-intel?op=heat, the same
 * metric registry and sales index every MI surface reads, joined server-side to
 * geometry we own (US Census state + ZCTA outlines). Zoom-adaptive: states, then
 * ZIPs from z9. County, city and market outlines do not exist and are never drawn.
 *
 * Colour = the area's rank among the areas in view (0..1 quantile, server-side),
 * on ONE single-hue ramp ('intel'), never a rainbow.
 */
import type maplibregl from 'maplibre-gl'
import { callBackend } from '../../../lib/api/backendClient'
import type { MapLens } from '../../../views/map/mobile/map-lenses'
export { MI_MAP_LENSES } from './mi-lens-defs'
import { miUrl } from '../mi-api'
import { openGeoInMarketIntel } from '../mi-handoffs'

/** MI lens period / asset (set by the MI app when it opens the Map in this mode). */
const CTX_KEY = 'lc.mi.map.v1'
export function writeMiMapContext(ctx: { period: string; asset: string }) {
  try { localStorage.setItem(CTX_KEY, JSON.stringify(ctx)) } catch { /* private mode */ }
}
export function readMiMapContext(): { period: string; asset: string } {
  try { const v = JSON.parse(localStorage.getItem(CTX_KEY) || '{}'); return { period: String(v.period || '1y'), asset: String(v.asset || 'all') } } catch { return { period: '1y', asset: 'all' } }
}

export interface IntelAreaRow { key: string; id: string; label: string; v: number; n: number; t: number; tip: string; outline: GeoJSON.Geometry }
export interface IntelAreas { ok: boolean; rows: IntelAreaRow[]; note: string | null; level: string | null; error?: string }

/** Fetch heat rows for the viewport (same row contract as get_map_lens_areas, plus t + tip). */
export async function fetchIntelAreas(l: MapLens, bounds: { west: number; south: number; east: number; north: number }, zoom: number): Promise<IntelAreas> {
  const metric = String(l.source || '').replace(/^mi:/, '')
  const ctx = readMiMapContext()
  const bbox = [bounds.west, bounds.south, bounds.east, bounds.north].map((v) => Math.max(-180, Math.min(180, v)).toFixed(3)).join(',')
  const res = await callBackend<{ ok: boolean; rows?: IntelAreaRow[]; note?: string | null; level?: string; status?: string; error?: string }>(miUrl('heat', { metric, bbox, zoom: zoom.toFixed(2), period: ctx.period, asset: ctx.asset }), { timeoutMs: 30_000 })
  if (!res.ok) return { ok: false, rows: [], note: null, level: null, error: 'Layer unavailable' }
  const d = res.data
  if (d.status && d.status !== 'ready' && !d.rows) return { ok: false, rows: [], note: 'Market index is still building', level: null, error: 'Market index is still building' }
  return { ok: true, rows: d.rows || [], note: d.note ?? null, level: d.level ?? null }
}

/**
 * Hover → the honest one-line tooltip; click → the geography's Inspector in
 * Market Intelligence (beside). Returns the unbind function.
 */
export function bindIntelAreaInteractions(map: maplibregl.Map, layerId: string): () => void {
  const container = map.getContainer()
  const tip = document.createElement('div')
  tip.className = 'mi-map-tip'
  tip.setAttribute('role', 'status')
  tip.style.cssText = 'position:absolute;pointer-events:none;z-index:5;display:none;max-width:360px;padding:6px 9px;border-radius:8px;font:500 12px/1.35 var(--lc-font, system-ui);color:var(--lc-ink-1,#fff);background:var(--lc-mat-float-bg, rgba(12,14,20,.92));box-shadow:0 6px 20px rgba(0,0,0,.35);border:1px solid var(--lc-hairline, rgba(255,255,255,.08));font-variant-numeric:tabular-nums'
  container.appendChild(tip)
  const move = (e: maplibregl.MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as { tip?: string } | undefined
    if (!p?.tip) { tip.style.display = 'none'; return }
    tip.textContent = p.tip
    tip.style.display = 'block'
    tip.style.left = `${Math.min(container.clientWidth - 370, e.point.x + 14)}px`
    tip.style.top = `${Math.max(4, e.point.y - 38)}px`
    map.getCanvas().style.cursor = 'pointer'
  }
  const leave = () => { tip.style.display = 'none'; map.getCanvas().style.cursor = '' }
  const click = (e: maplibregl.MapLayerMouseEvent) => {
    const id = (e.features?.[0]?.properties as { id?: string } | undefined)?.id
    if (id) openGeoInMarketIntel(id)
  }
  map.on('mousemove', layerId, move)
  map.on('mouseleave', layerId, leave)
  map.on('click', layerId, click)
  return () => {
    map.off('mousemove', layerId, move)
    map.off('mouseleave', layerId, leave)
    map.off('click', layerId, click)
    tip.remove()
    map.getCanvas().style.cursor = ''
  }
}
