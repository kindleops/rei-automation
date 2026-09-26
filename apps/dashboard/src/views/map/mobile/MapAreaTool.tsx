/**
 * Draw an area → read what's inside it.
 *
 *   Lasso   drag a finger around the leads; the path closes on release
 *   Circle  drag out from a centre; the radius follows the finger
 *
 * The shape stays on the map (marching outline) until cleared. Inside it,
 * get_map_area_summary (read-only) counts every property and summarises value,
 * equity, housing age, motivation, tax delinquency, free & clear, how many
 * have already been contacted, property types and markets.
 *
 * Nothing here sends. Acting on the area hands the property ids to the
 * campaign builder as a draft the operator reviews and launches there.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type maplibregl from 'maplibre-gl'
import { getSupabaseClient } from '../../../lib/supabaseClient'
import { shouldUseSupabase } from '../../../lib/data/shared'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { createAreaCampaignDraft } from './map-area-campaign'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export type DrawShape = 'lasso' | 'circle'
export type Ring = Array<[number, number]>

export interface AreaSummary {
  count: number
  avg_equity_pct: number | null
  median_value: number | null
  total_value: number | null
  median_year_built: number | null
  avg_motivation: number | null
  tax_delinquent: number
  free_clear: number
  contacted: number
  types: Array<{ type: string; n: number }>
  markets: Array<{ market: string; n: number }>
  property_ids: string[]
}

const SRC = 'nx-draw'
const L_FILL = 'nx-draw-fill'
const L_GLOW = 'nx-draw-glow'
const L_LINE = 'nx-draw-line'

/** Drop points closer than `px` on screen — a finger path has hundreds. */
export function simplifyPath(points: Array<{ x: number; y: number }>, px = 6): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= px) out.push(p)
  }
  return out
}

/** A circle as a 64-point ring, in lng/lat, from a centre and an edge point. */
export function circleRing(center: [number, number], edge: [number, number], steps = 64): Ring {
  const [lng0, lat0] = center
  const kx = Math.cos((lat0 * Math.PI) / 180)
  const dx = (edge[0] - lng0) * kx
  const dy = edge[1] - lat0
  const r = Math.hypot(dx, dy)
  const ring: Ring = []
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2
    ring.push([lng0 + (Math.cos(a) * r) / kx, lat0 + Math.sin(a) * r])
  }
  return ring
}

/** Radius of a circle ring in miles (for the label). */
export function circleMiles(center: [number, number], edge: [number, number]): number {
  const kx = Math.cos((center[1] * Math.PI) / 180)
  return Math.hypot((edge[0] - center[0]) * kx, edge[1] - center[1]) * 69.05
}

const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--nexus-accent').trim() || '#38bdf8'

function ensureLayers(map: maplibregl.Map) {
  if (!map.style) return
  if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  const c = accent()
  if (!map.getLayer(L_FILL)) map.addLayer({ id: L_FILL, type: 'fill', source: SRC, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': c, 'fill-opacity': 0.1 } })
  if (!map.getLayer(L_GLOW)) map.addLayer({ id: L_GLOW, type: 'line', source: SRC, paint: { 'line-color': c, 'line-width': 9, 'line-blur': 7, 'line-opacity': 0.55 } })
  if (!map.getLayer(L_LINE)) map.addLayer({ id: L_LINE, type: 'line', source: SRC, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 2.2, 'line-dasharray': [2, 2] } })
}

function setShape(map: maplibregl.Map, ring: Ring | null, closed: boolean) {
  try {
    ensureLayers(map)
    const src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined
    if (!src) return
    if (!ring || ring.length < 2) { src.setData({ type: 'FeatureCollection', features: [] }); return }
    const coords = closed ? [...ring, ring[0]] : ring
    src.setData({
      type: 'FeatureCollection',
      features: [closed && ring.length >= 3
        ? { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} }
        : { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }],
    })
  } catch { /* style mid-swap */ }
}

const money = (v?: number | null) => (v == null ? '—' : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1000)}K`)

export interface MapAreaToolProps {
  map: maplibregl.Map | null
  epoch: number
  drawing: boolean
  onDrawingChange: (v: boolean) => void
  reducedMotion: boolean
  /** The area was cleared or replaced. */
  onAreaChange?: (has: boolean) => void
}

export function MapAreaTool({ map, epoch, drawing, onDrawingChange, reducedMotion, onAreaChange }: MapAreaToolProps) {
  const [draft, setDraft] = useState<'idle' | 'confirm' | 'creating' | { error: string }>('idle')
  const [shape, setShapeMode] = useState<DrawShape>('lasso')
  const [ring, setRing] = useState<Ring | null>(null)
  const [label, setLabel] = useState<string | null>(null)
  const [summary, setSummary] = useState<AreaSummary | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [sheetOpen, setSheetOpen] = useState(false)
  const pts = useRef<Array<{ x: number; y: number }>>([])
  const centre = useRef<[number, number] | null>(null)
  const surface = useRef<HTMLDivElement | null>(null)

  // Keep the drawn shape across style swaps.
  const ringRef = useRef(ring)
  ringRef.current = ring
  useEffect(() => {
    if (!map) return
    const redraw = () => { if (ringRef.current) setShape(map, ringRef.current, true) }
    map.on('styledata', redraw)
    return () => { map.off('styledata', redraw) }
  }, [map, epoch])

  // Marching outline while an area is held.
  useEffect(() => {
    if (!map || !ring || reducedMotion) return
    const seq: number[][] = [[0, 2, 2], [0.5, 2, 1.5], [1, 2, 1], [1.5, 2, 0.5], [2, 2, 0], [0, 0.5, 2, 1.5], [0, 1, 2, 1], [0, 1.5, 2, 0.5]]
    let i = 0
    const t = window.setInterval(() => {
      i = (i + 1) % seq.length
      try { if (map.getLayer(L_LINE)) map.setPaintProperty(L_LINE, 'line-dasharray', seq[i]) } catch { /* ignore */ }
    }, 90)
    return () => window.clearInterval(t)
  }, [map, ring, reducedMotion])

  const summarise = useCallback(async (r: Ring) => {
    if (!shouldUseSupabase()) { setState('error'); return }
    setState('loading')
    setSummary(null)
    setDraft('idle')
    const { data, error } = await getSupabaseClient().rpc('get_map_area_summary', { p_ring: r })
    if (error || !data) { setState('error'); return }
    setSummary(data as AreaSummary)
    setState('idle')
  }, [])

  const finish = useCallback((r: Ring | null, text: string | null) => {
    onDrawingChange(false)
    if (!map || !r || r.length < 3) { setShape(map!, ringRef.current, true); return }
    setRing(r)
    setLabel(text)
    setShape(map, r, true)
    onAreaChange?.(true)
    setSheetOpen(true)
    void summarise(r)
  }, [map, onDrawingChange, onAreaChange, summarise])

  const clear = useCallback(() => {
    setRing(null)
    setSummary(null)
    setLabel(null)
    setSheetOpen(false)
    if (map) setShape(map, null, false)
    onAreaChange?.(false)
  }, [map, onAreaChange])

  // Pointer capture on a surface over the map while drawing.
  const toLngLat = (e: React.PointerEvent): [number, number] | null => {
    if (!map) return null
    const rect = map.getCanvas().getBoundingClientRect()
    const ll = map.unproject([e.clientX - rect.left, e.clientY - rect.top])
    return [ll.lng, ll.lat]
  }
  const onDown = (e: React.PointerEvent) => {
    if (!map) return
    e.preventDefault()
    surface.current?.setPointerCapture(e.pointerId)
    const rect = map.getCanvas().getBoundingClientRect()
    pts.current = [{ x: e.clientX - rect.left, y: e.clientY - rect.top }]
    centre.current = toLngLat(e)
  }
  const onMove = (e: React.PointerEvent) => {
    if (!map || !pts.current.length) return
    const rect = map.getCanvas().getBoundingClientRect()
    const p = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    if (shape === 'circle' && centre.current) {
      const edge = toLngLat(e)
      if (!edge) return
      pts.current = [pts.current[0], p]
      setShape(map, circleRing(centre.current, edge), true)
      const mi = circleMiles(centre.current, edge)
      setLabel(`${mi < 1 ? mi.toFixed(2) : mi.toFixed(1)} mi radius`)
      return
    }
    pts.current.push(p)
    const simple = simplifyPath(pts.current)
    setShape(map, simple.map((q) => { const ll = map.unproject([q.x, q.y]); return [ll.lng, ll.lat] as [number, number] }), false)
  }
  const onUp = () => {
    if (!map || !pts.current.length) return
    const got = pts.current
    pts.current = []
    if (shape === 'circle' && centre.current && got.length === 2) {
      const e = map.unproject([got[1].x, got[1].y])
      const edge: [number, number] = [e.lng, e.lat]
      if (Math.hypot(got[1].x - got[0].x, got[1].y - got[0].y) < 14) { finish(null, null); return }
      const mi = circleMiles(centre.current, edge)
      finish(circleRing(centre.current, edge), `${mi < 1 ? mi.toFixed(2) : mi.toFixed(1)} mi radius`)
      return
    }
    const simple = simplifyPath(got, 8)
    if (simple.length < 4) { finish(null, null); return }
    finish(simple.map((q) => { const ll = map.unproject([q.x, q.y]); return [ll.lng, ll.lat] as [number, number] }), null)
  }

  const zoomTo = () => {
    if (!map || !ring) return
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
    for (const [x, y] of ring) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y) }
    map.fitBounds([[w, s], [e, n]], { padding: { top: 140, bottom: 380, left: 40, right: 72 }, duration: reducedMotion ? 0 : 900 })
  }

  const s = summary
  const contactedPct = s && s.count ? Math.round((s.contacted / s.count) * 100) : 0
  const maxType = s?.types?.[0]?.n ?? 1

  return (
    <>
      {drawing && (
        <div
          ref={surface}
          className={cls('mx-draw-surface', `is-${shape}`)}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          aria-label={shape === 'circle' ? 'Drag out a circle' : 'Draw around an area'}
        />
      )}
      {drawing && (
        <div className="mx-draw-bar" role="toolbar" aria-label="Draw an area">
          <div className="mx-draw-bar__modes">
            {(['lasso', 'circle'] as const).map((m) => (
              <button key={m} type="button" className={cls('mx-draw-bar__mode', shape === m && 'is-active')} aria-pressed={shape === m} onClick={() => setShapeMode(m)}>
                {m === 'lasso' ? 'Lasso' : 'Circle'}
              </button>
            ))}
          </div>
          <span className="mx-draw-bar__hint">{label ?? (shape === 'circle' ? 'Drag out from a centre' : 'Draw around the leads')}</span>
          <button type="button" className="mx-btn is-sm" aria-label="Stop drawing" onClick={() => { onDrawingChange(false); pts.current = []; if (map) setShape(map, ringRef.current, true) }}>
            <Icon name="close" size={13} />
          </button>
        </div>
      )}

      {ring && !sheetOpen && !drawing && (
        <button type="button" className="mx-area-chip mx-glass" data-map-control="area" onClick={() => setSheetOpen(true)}>
          <span className="mx-area-chip__dot" aria-hidden="true" />
          {s ? `${s.count.toLocaleString()} properties in area` : state === 'loading' ? 'Reading area…' : 'Area'}
        </button>
      )}

      {sheetOpen && ring && createPortal(
        <div className="mx-sheet mx-area-sheet" role="presentation">
          <button type="button" className="mx-sheet__backdrop is-clear" aria-label="Close" onClick={() => setSheetOpen(false)} />
          <section className="mx-sheet__panel" role="dialog" aria-modal="true" aria-label="Area">
            <span className="mx-sheet__grip" aria-hidden="true" />
            <header className="mx-sheet__head">
              <strong>Area</strong>
              {label && <span className="mx-area__label">{label}</span>}
              <button type="button" className="mx-btn is-sm" onClick={() => setSheetOpen(false)} aria-label="Close" data-map-sheet-close><Icon name="close" size={14} /></button>
            </header>
            <div className="mx-sheet__body">
              {state === 'loading' && <div className="mx-area__loading"><span /><span /><span /></div>}
              {state === 'error' && <p className="mx-note">Couldn't read this area. Try drawing it again.</p>}
              {s && (
                <>
                  <div className="mx-area__hero">
                    <div><strong>{s.count.toLocaleString()}</strong><span>properties</span></div>
                    <div><strong>{money(s.total_value)}</strong><span>total value</span></div>
                    <div><strong>{contactedPct}%</strong><span>already contacted</span></div>
                  </div>
                  <div className="mx-area__grid">
                    {[
                      ['Median value', money(s.median_value)],
                      ['Avg equity', s.avg_equity_pct == null ? '—' : `${Math.round(s.avg_equity_pct)}%`],
                      ['Free & clear', s.count ? `${Math.round((s.free_clear / s.count) * 100)}%` : '—'],
                      ['Median built', s.median_year_built ? String(Math.round(s.median_year_built)) : '—'],
                      ['Motivation', s.avg_motivation == null ? '—' : String(Math.round(s.avg_motivation))],
                      ['Tax delinquent', s.tax_delinquent.toLocaleString()],
                    ].map(([k, v], i) => (
                      <div key={k} className="mx-area__cell" style={{ animationDelay: `${i * 35}ms` }}><span>{k}</span><strong>{v}</strong></div>
                    ))}
                  </div>
                  {s.types.length > 0 && (
                    <section className="mx-block">
                      <h3>Property types</h3>
                      <div className="mx-area__bars">
                        {s.types.map((t, i) => (
                          <div key={t.type} className="mx-area__bar">
                            <span>{t.type}</span>
                            <i style={{ width: `${Math.max(4, (t.n / maxType) * 100)}%`, animationDelay: `${i * 50}ms` }} />
                            <em>{t.n.toLocaleString()}</em>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                  {s.markets.length > 1 && <p className="mx-note">{s.markets.map((m) => `${m.market} ${m.n.toLocaleString()}`).join(' · ')}</p>}
                  <div className="mx-area__actions">
                    {s.count > 0 && draft === 'idle' && (
                      <button type="button" className="mx-act is-primary" data-area-action="draft" onClick={() => setDraft('confirm')}>
                        Build campaign draft · {s.property_ids.length.toLocaleString()}
                      </button>
                    )}
                    {draft === 'confirm' && (
                      <div className="mx-area__confirm">
                        <p>Create a <strong>draft</strong> campaign targeting these {s.property_ids.length.toLocaleString()} properties{s.count > s.property_ids.length ? ` (first ${s.property_ids.length.toLocaleString()} of ${s.count.toLocaleString()})` : ''}? It opens in the builder; nothing is queued or sent.</p>
                        <div className="mx-area__row is-two">
                          <button type="button" className="mx-act" onClick={() => setDraft('idle')}>Cancel</button>
                          <button
                            type="button"
                            className="mx-act is-primary"
                            data-area-action="confirm-draft"
                            onClick={async () => {
                              setDraft('creating')
                              try {
                                const id = await createAreaCampaignDraft(s, ring, label)
                                setSheetOpen(false)
                                setDraft('idle')
                                pushRoutePath(`/campaign-command?campaign=${encodeURIComponent(id)}&builder=edit`)
                              } catch (err) {
                                setDraft({ error: err instanceof Error ? err.message : 'campaign_create_failed' })
                              }
                            }}
                          >
                            Create draft
                          </button>
                        </div>
                      </div>
                    )}
                    {draft === 'creating' && <button type="button" className="mx-act is-primary" disabled>Creating draft…</button>}
                    {typeof draft === 'object' && (
                      <p className="mx-note is-error">Couldn't create the draft ({draft.error}). <button type="button" className="mx-link" onClick={() => setDraft('idle')}>Try again</button></p>
                    )}
                    <div className="mx-area__row">
                      <button type="button" className="mx-act" onClick={() => { setSheetOpen(false); zoomTo() }}>Zoom to area</button>
                      <button type="button" className="mx-act" onClick={() => { setSheetOpen(false); onDrawingChange(true) }}>Redraw</button>
                      <button type="button" className="mx-act is-quiet" onClick={clear}>Clear</button>
                    </div>
                    {draft === 'idle' && <p className="mx-note">A draft opens in the campaign builder for review. Nothing is sent from the map.</p>}
                  </div>
                </>
              )}
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  )
}
