/**
 * ANALYTICS MAP — where performance happened in the period, and how it moved.
 *
 * An analytical surface, not the operational Map: canonical-market orbs,
 * a ZIP-level intensity field, and state areas — each only where the metric
 * has trustworthy geographic attribution (property → canonical market; replies
 * inherit the market of the send that prompted them). Values in labels and
 * the inspector are exact; only VISUAL size/heat is scaled (√ with a 95th-
 * percentile clip) so one outlier cannot flatten every other market.
 *
 * Areas (state fills) are offered for RATE and CHANGE views only — shading an
 * area by a raw count reads as density and makes big states look like markets.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Icon } from '../../../shared/icons'
import type { AnalyticsPerformance, MarketRow } from '../../../domain/analytics/analytics-performance-api'
import { fmtInt, fmtPct } from '../../../domain/analytics/analytics-performance-api'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const DARK = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const LIGHT = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
const STATES_URL = '/geo/us-states.json'

export type GeoView = 'count' | 'rate' | 'change'
export type GeoViz = 'dots' | 'surface' | 'areas'

type GeoMetric = {
  key: string
  label: string
  short: string
  count: (m: MarketRow, per: 'cur' | 'prev') => number
  zip?: 'replied' | 'delivered' | 'failed' | 'buyerPurchases'
  zipGrain?: string
  rate?: (m: MarketRow) => number | null
  rateLabel?: string
  good: 'up' | 'down' | 'neutral'
  grain: string
  state?: boolean
  note?: (w: AnalyticsPerformance) => string | null
}

export const GEO_METRICS: GeoMetric[] = [
  { key: 'replied', label: 'Seller replies', short: 'Replies', count: (m, p) => m[p].replied_conversations ?? 0, zip: 'replied', zipGrain: 'sellers replied', rate: (m) => (m.replyRate === null ? null : m.replyRate / 100), rateLabel: 'Reply rate (replied ÷ reached, ≥20 reached)', good: 'up', grain: 'distinct seller conversations' },
  { key: 'reached', label: 'Sellers reached', short: 'Reached', count: (m, p) => m[p].delivered_conversations ?? 0, zip: 'delivered', zipGrain: 'messages delivered', good: 'neutral', grain: 'distinct conversations delivered to' },
  { key: 'opportunities', label: 'Opportunities created', short: 'Created', count: (m, p) => m[p].opportunities_created ?? 0, good: 'up', grain: 'opportunity_created events' },
  { key: 'advancements', label: 'Stage advancements', short: 'Advanced', count: (m, p) => m[p].stage_advancements ?? 0, good: 'up', grain: 'stage transitions' },
  { key: 'active', label: 'Live pipeline (now)', short: 'Live now', count: (m) => Math.max(0, m.activeOpportunities - m.dormantOpportunities), good: 'neutral', grain: 'active, non-dormant opportunities — current state, not the period', state: true },
  { key: 'optouts', label: 'Opt-outs', short: 'Opt-outs', count: (m, p) => m[p].opt_out_conversations ?? 0, rate: (m) => (m.optOutRate === null ? null : m.optOutRate / 100), rateLabel: 'Opt-out rate (÷ reached, ≥20 reached)', good: 'down', grain: 'distinct conversations' },
  { key: 'failures', label: 'Delivery failures', short: 'Failures', count: (m, p) => m[p].failed ?? 0, zip: 'failed', zipGrain: 'failed messages', good: 'down', grain: 'messages' },
  { key: 'automation', label: 'Automation exceptions', short: 'Exceptions', count: (m, p) => m[p].automation_exceptions ?? 0, good: 'down', grain: 'autopilot runs failed or held for review' },
  { key: 'buyers', label: 'Buyer purchases', short: 'Buyers', count: (m, p) => m[p].buyer_purchases ?? 0, zip: 'buyerPurchases', zipGrain: 'recorded buyer purchases', good: 'neutral', grain: 'identity-resolved buyers’ recorded purchases',
    note: (w) => (w.buyers.dataThrough ? `Recorded transactions through ${new Date(w.buyers.dataThrough).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : null) },
]

/** Compatible secondary layers only — two dimensions, never a blended "score". */
const SECONDARY: Record<string, string[]> = {
  replied: ['buyers', 'reached'], opportunities: ['buyers'], active: ['buyers'], advancements: ['buyers'], failures: ['reached'], optouts: ['reached'], automation: ['reached'],
}

const pctl = (xs: number[], q: number) => {
  const v = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b)
  if (!v.length) return 0
  return v[Math.min(v.length - 1, Math.floor(q * (v.length - 1)))]
}

type Bounds = [[number, number], [number, number]]
function bboxOf(coords: unknown, b: Bounds | null = null): Bounds | null {
  if (!Array.isArray(coords)) return b
  if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    const [x, y] = coords as [number, number]
    if (!b) return [[x, y], [x, y]]
    return [[Math.min(b[0][0], x), Math.min(b[0][1], y)], [Math.max(b[1][0], x), Math.max(b[1][1], y)]]
  }
  let out = b
  for (const c of coords) out = bboxOf(c, out)
  return out
}

export type GeoSelection = { state: string | null; market: string | null }

export function AnalyticsGeo({ w, theme, selection, onSelect, metricKey, setMetricKey, view, setView, viz, setViz, fullscreen, onFullscreen, onInspect, onOpenMap }: {
  w: AnalyticsPerformance; theme: string
  selection: GeoSelection; onSelect: (s: GeoSelection) => void
  metricKey: string; setMetricKey: (k: string) => void
  view: GeoView; setView: (v: GeoView) => void
  viz: GeoViz; setViz: (v: GeoViz) => void
  fullscreen: boolean; onFullscreen: () => void
  onInspect: (marketId: string) => void
  onOpenMap: () => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [ready, setReady] = useState(false)
  const [states, setStates] = useState<{ type: 'FeatureCollection'; features: Array<{ properties: { abbr: string; name: string }; geometry: { coordinates: unknown } }> } | null>(null)
  const [secondary, setSecondary] = useState<string | null>(null)
  const metric = GEO_METRICS.find((m) => m.key === metricKey) ?? GEO_METRICS[0]
  const secondaryMetric = secondary ? GEO_METRICS.find((m) => m.key === secondary) ?? null : null
  const canRate = !!metric.rate
  const effView: GeoView = view === 'rate' && !canRate ? 'count' : view === 'change' && metric.state ? 'count' : view
  const effViz: GeoViz = viz === 'areas' && effView === 'count' ? 'dots' : viz === 'surface' && !metric.zip ? 'dots' : viz

  const markets = useMemo(() => w.markets.filter((m) => m.lat !== null && m.lng !== null && (!selection.state || m.state === selection.state)), [w.markets, selection.state])

  // values per market for the active view
  const values = useMemo(() => markets.map((m) => {
    const cur = metric.count(m, 'cur')
    const prev = metric.state ? cur : metric.count(m, 'prev')
    const rate = metric.rate ? metric.rate(m) : null
    const v = effView === 'count' ? cur : effView === 'rate' ? rate : cur - prev
    return { m, cur, prev, rate, v }
  }), [markets, metric, effView])
  const mag = values.map((x) => Math.abs(x.v ?? 0))
  // A 95th-percentile clip only means something with enough markets; with a
  // handful it lands on the runner-up and draws 3 as large as 39.
  const maxMag = Math.max(0, ...mag)
  const p95 = pctl(mag, 0.95)
  const clipped = mag.filter((x) => x > 0).length >= 20 && maxMag > 4 * p95
  const clip = Math.max(1e-9, clipped ? p95 : maxMag)
  const lo = Math.min(...values.map((x) => x.v ?? 0).filter((v) => effView !== 'count' || v > 0), 0)
  const hi = Math.max(...values.map((x) => x.v ?? 0), 0)
  const shown = values.filter((x) => x.v !== null && (effView === 'change' ? x.v !== 0 : (x.v ?? 0) > 0))

  // state aggregation (areas: rate / change only)
  const stateAgg = useMemo(() => {
    const out = new Map<string, { cur: number; prev: number; num: number; den: number }>()
    for (const m of w.markets) {
      const s = out.get(m.state) ?? { cur: 0, prev: 0, num: 0, den: 0 }
      s.cur += metric.count(m, 'cur'); s.prev += metric.state ? metric.count(m, 'cur') : metric.count(m, 'prev')
      if (metric.key === 'replied') { s.num += m.cur.replied_conversations ?? 0; s.den += m.cur.delivered_conversations ?? 0 }
      if (metric.key === 'optouts') { s.num += m.cur.opt_out_conversations ?? 0; s.den += m.cur.delivered_conversations ?? 0 }
      out.set(m.state, s)
    }
    return out
  }, [w.markets, metric])

  const tone = (x: number) => (metric.good === 'neutral' ? (x > 0 ? 'up' : 'down') : (x > 0) === (metric.good === 'up') ? 'good' : 'bad')

  /* ── map lifecycle ── */
  useEffect(() => {
    if (!hostRef.current) return
    const map = new maplibregl.Map({ container: hostRef.current, style: theme === 'light' ? LIGHT : DARK, center: [-96.5, 38.6], zoom: 2.55, attributionControl: false, pitchWithRotate: false, dragRotate: false, maxZoom: 12 })
    map.touchZoomRotate.disableRotation()
    mapRef.current = map
    map.on('load', () => setReady(true))
    return () => { map.remove(); mapRef.current = null; setReady(false) }
  }, [theme])

  useEffect(() => { fetch(STATES_URL).then((r) => (r.ok ? r.json() : null)).then((j) => j && setStates(j)).catch(() => {}) }, [])

  // sources + layers (created once per style)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const empty = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection
    const add = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: empty }) }
    add('anx-states'); add('anx-markets'); add('anx-zips'); add('anx-zips2')
    const light = theme === 'light'
    if (!map.getLayer('anx-state-fill')) {
      map.addLayer({ id: 'anx-state-fill', type: 'fill', source: 'anx-states', paint: { 'fill-color': ['coalesce', ['get', 'color'], 'rgba(0,0,0,0)'], 'fill-opacity': ['coalesce', ['get', 'alpha'], 0], 'fill-opacity-transition': { duration: 700 } } })
      map.addLayer({ id: 'anx-state-line', type: 'line', source: 'anx-states', paint: { 'line-color': light ? 'rgba(8,19,26,0.22)' : 'rgba(255,255,255,0.16)', 'line-width': ['case', ['boolean', ['get', 'sel'], false], 1.8, 0.6] } })
      map.addLayer({ id: 'anx-heat2', type: 'heatmap', source: 'anx-zips2', maxzoom: 12, paint: {
        'heatmap-weight': ['get', 'w'], 'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 9, 1.8],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 2, 20, 5, 28, 9, 38],
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.2, 'rgba(245,200,96,0.10)', 0.5, 'rgba(245,200,96,0.32)', 1, 'rgba(255,226,150,0.62)'],
        'heatmap-opacity': 0.85 } })
      map.addLayer({ id: 'anx-heat', type: 'heatmap', source: 'anx-zips', maxzoom: 12, paint: {
        'heatmap-weight': ['get', 'w'], 'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 2, 1.6, 9, 2.4],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 2, 18, 5, 26, 9, 36],
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.15, 'rgba(60,200,240,0.12)', 0.4, 'rgba(60,200,240,0.38)', 0.7, 'rgba(52,227,164,0.62)', 1, 'rgba(230,255,248,0.9)'],
        'heatmap-opacity': 0.9 } })
      map.addLayer({ id: 'anx-halo', type: 'circle', source: 'anx-markets', paint: { 'circle-radius': ['*', ['get', 'r'], 2.1], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16, 'circle-blur': 0.9, 'circle-radius-transition': { duration: 750 } } })
      map.addLayer({ id: 'anx-dot', type: 'circle', source: 'anx-markets', paint: {
        'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.9,
        'circle-stroke-color': ['case', ['boolean', ['get', 'sel'], false], '#f4c860', light ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.75)'],
        'circle-stroke-width': ['case', ['boolean', ['get', 'sel'], false], 2.6, 1],
        'circle-radius-transition': { duration: 750 }, 'circle-color-transition': { duration: 500 } } })
      map.addLayer({ id: 'anx-label', type: 'symbol', source: 'anx-markets', filter: ['>=', ['get', 'rank'], 0], layout: {
        'text-field': ['get', 'label'], 'text-font': ['Open Sans Bold'], 'text-size': 11, 'text-offset': [0, 1.35], 'text-anchor': 'top', 'text-allow-overlap': false, 'symbol-sort-key': ['get', 'rank'] },
        paint: { 'text-color': light ? '#08131a' : '#eef6f7', 'text-halo-color': light ? 'rgba(255,255,255,0.9)' : 'rgba(3,6,10,0.85)', 'text-halo-width': 1.4 } })
      map.on('click', 'anx-dot', (e) => { const id = e.features?.[0]?.properties?.id; if (id) onInspect(String(id)) })
      map.on('click', 'anx-state-fill', (e) => {
        if (map.queryRenderedFeatures(e.point, { layers: ['anx-dot'] }).length) return
        const abbr = e.features?.[0]?.properties?.abbr
        if (abbr) onSelect({ state: String(abbr), market: null })
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, theme])

  // data → sources
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !map.getSource('anx-markets')) return
    const good = theme === 'light' ? '#0c9f6c' : '#34e3a4'
    const bad = theme === 'red_ops' ? '#c9a3a3' : theme === 'light' ? '#c2410c' : '#ff9b6b'
    const neutral = theme === 'light' ? '#0b8fb8' : '#3cc8f0'
    const slate = '#7b8796'
    const colorFor = (v: number) => (effView === 'change' ? ({ good, bad, up: neutral, down: slate } as Record<string, string>)[tone(v)] : neutral)
    const ranked = [...shown].sort((a, b) => Math.abs(b.v ?? 0) - Math.abs(a.v ?? 0))
    const rankOf = new Map(ranked.map((x, i) => [x.m.id, i]))
    const fmtV = (x: typeof shown[number]) => (effView === 'rate' ? fmtPct(x.v) : effView === 'change' ? `${(x.v ?? 0) > 0 ? '+' : ''}${fmtInt(x.v)}` : fmtInt(x.v))
    const marketsFc = {
      type: 'FeatureCollection', features: effViz === 'areas' || (effViz === 'surface' && !selection.market) ? [] : shown.map((x) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [x.m.lng, x.m.lat] },
        properties: {
          id: x.m.id, sel: selection.market === x.m.id, color: colorFor(x.v ?? 0),
          r: effView === 'rate' ? 5 + 13 * Math.min(1, (x.v ?? 0) / Math.max(1e-9, hi)) : 4 + 16 * Math.sqrt(Math.min(1, Math.abs(x.v ?? 0) / clip)),
          rank: (rankOf.get(x.m.id) ?? 99) < 10 ? rankOf.get(x.m.id) : -1,
          label: `${x.m.name.split(',')[0]} ${fmtV(x)}`,
        },
      })),
    }
    ;(map.getSource('anx-markets') as maplibregl.GeoJSONSource).setData(marketsFc as unknown as GeoJSON.FeatureCollection)
    const zipFc = (mk: GeoMetric | null, only: boolean) => {
      if (!mk?.zip || !only) return { type: 'FeatureCollection', features: [] }
      const pts = w.zips.filter((z) => z.lat !== null && z.lng !== null && (!selection.market || z.market === selection.market))
      const vals = pts.map((z) => Number(z[mk.zip as keyof typeof z] ?? 0))
      const c = Math.max(1e-9, pctl(vals, 0.95))
      return { type: 'FeatureCollection', features: pts.map((z, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [z.lng, z.lat] }, properties: { w: Math.min(1, vals[i] / c) } })).filter((f) => f.properties.w > 0) }
    }
    ;(map.getSource('anx-zips') as maplibregl.GeoJSONSource).setData(zipFc(metric, effViz === 'surface' && effView === 'count') as unknown as GeoJSON.FeatureCollection)
    ;(map.getSource('anx-zips2') as maplibregl.GeoJSONSource).setData(zipFc(secondaryMetric, !!secondaryMetric) as unknown as GeoJSON.FeatureCollection)
    if (states) {
      const fc = { type: 'FeatureCollection', features: states.features.map((f) => {
        const s = stateAgg.get(f.properties.abbr)
        let color: string | null = null
        let alpha = 0
        if (effViz === 'areas' && s) {
          if (effView === 'rate' && s.den >= 20) { const r = s.num / s.den; color = neutral; alpha = 0.08 + 0.5 * Math.min(1, r / Math.max(1e-9, Math.max(...[...stateAgg.values()].filter((x) => x.den >= 20).map((x) => x.num / x.den)))) }
          if (effView === 'change' && s.cur - s.prev !== 0) { const d = s.cur - s.prev; color = colorFor(d); alpha = 0.1 + 0.45 * Math.min(1, Math.sqrt(Math.abs(d) / Math.max(1, pctl([...stateAgg.values()].map((x) => Math.abs(x.cur - x.prev)), 0.95)))) }
        }
        return { ...f, properties: { ...f.properties, color, alpha, sel: selection.state === f.properties.abbr } }
      }) }
      ;(map.getSource('anx-states') as maplibregl.GeoJSONSource).setData(fc as unknown as GeoJSON.FeatureCollection)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, shown, states, stateAgg, effView, effViz, selection, metric, secondaryMetric, w.zips, theme])

  // camera follows the geographic level
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    if (selection.market) {
      const pts = w.zips.filter((z) => z.market === selection.market && z.lat !== null && z.lng !== null)
      const m = w.markets.find((x) => x.id === selection.market)
      if (pts.length >= 2) {
        const b = bboxOf(pts.map((z) => [z.lng, z.lat]))
        if (b) map.fitBounds(b as maplibregl.LngLatBoundsLike, { padding: 48, maxZoom: 10.5, duration: 1100 })
      } else if (m?.lat && m?.lng) map.easeTo({ center: [m.lng, m.lat], zoom: 8.5, duration: 1100 })
    } else if (selection.state && states) {
      const f = states.features.find((x) => x.properties.abbr === selection.state)
      const b = f ? bboxOf(f.geometry.coordinates) : null
      if (b) map.fitBounds(b as maplibregl.LngLatBoundsLike, { padding: 36, duration: 1100 })
    } else {
      map.fitBounds([[-124.8, 24.6], [-66.9, 49.2]], { padding: 14, duration: 1100 })
    }
  }, [ready, selection.market, selection.state, states, w.zips, w.markets])

  useEffect(() => { const t = setTimeout(() => mapRef.current?.resize(), 360); return () => clearTimeout(t) }, [fullscreen])

  const state = selection.state
  const marketName = selection.market ? w.markets.find((m) => m.id === selection.market)?.name ?? null : null
  const scaleNote = effView === 'rate' ? 'linear' : clipped ? 'size ∝ √value, clipped at the 95th percentile' : 'size ∝ √value'
  const note = metric.note?.(w) ?? null
  const unresolved = metric.key === 'replied' ? w.unresolved.replies : metric.key === 'buyers' ? w.unresolved.buyer_purchases : ['reached', 'failures'].includes(metric.key) ? w.unresolved.send_rows : ['opportunities', 'advancements'].includes(metric.key) ? w.unresolved.transitions : 0
  const top = [...shown].sort((a, b) => Math.abs(b.v ?? 0) - Math.abs(a.v ?? 0)).slice(0, 6)

  return (
    <section className={cls('anx-geo', fullscreen && 'is-full')}>
      <div className="anx-geo__map">
        <div ref={hostRef} className="anx-geo__canvas" />
        <div className="anx-geo__vignette" aria-hidden="true" />
        <div className="anx-geo__top">
          <nav className="anx-crumbs" aria-label="Geography">
            <button type="button" className={cls(!state && 'is-on')} onClick={() => onSelect({ state: null, market: null })}>US</button>
            {state ? <><i>›</i><button type="button" className={cls(!selection.market && 'is-on')} onClick={() => onSelect({ state, market: null })}>{state}</button></> : null}
            {marketName ? <><i>›</i><button type="button" className="is-on" onClick={() => onInspect(selection.market as string)}>{marketName.split(',')[0]}</button></> : null}
          </nav>
          <div className="anx-geo__tools">
            {state || selection.market ? <button type="button" className="anx-round" onClick={() => onSelect(selection.market ? { state, market: null } : { state: null, market: null })} aria-label="Up one level"><Icon name="arrow-up-right" /></button> : null}
            <button type="button" className="anx-round" onClick={onFullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}><Icon name={fullscreen ? 'close' : 'maximize'} /></button>
          </div>
        </div>
        <div className="anx-legend">
          <b>{effView === 'rate' ? metric.rateLabel?.split(' (')[0] : effView === 'change' ? `${metric.short} · change vs prior` : metric.label}</b>
          <span>{effView === 'rate' ? `${fmtPct(lo)} – ${fmtPct(hi)}` : `${effView === 'change' && lo < 0 ? fmtInt(lo) : fmtInt(Math.max(lo, 0))} – ${effView === 'change' && hi > 0 ? '+' : ''}${fmtInt(hi)}`}</span>
          <em>{metric.state ? 'Now' : w.period.range.toUpperCase()} · {selection.market ? 'ZIP' : 'market'} · {scaleNote}</em>
          {secondaryMetric ? <em className="is-2"><i />{secondaryMetric.label} · surface</em> : null}
        </div>
      </div>

      <div className="anx-geo__controls">
        <div className="anx-metricbar" role="tablist" aria-label="Map metric">
          {GEO_METRICS.map((m) => (
            <button key={m.key} type="button" role="tab" aria-selected={m.key === metric.key} className={cls('anx-pill', m.key === metric.key && 'is-on')} onClick={() => { setMetricKey(m.key); if (secondary && !(SECONDARY[m.key] ?? []).includes(secondary)) setSecondary(null) }}>{m.short}</button>
          ))}
        </div>
        <div className="anx-segrow">
          <div className="anx-seg">
            {(['count', 'rate', 'change'] as GeoView[]).map((v) => (
              <button key={v} type="button" disabled={(v === 'rate' && !canRate) || (v === 'change' && (!!metric.state || !w.priorHasData))} className={cls(effView === v && 'is-on')} onClick={() => setView(v)}>{v === 'count' ? 'Volume' : v === 'rate' ? 'Rate' : 'Change'}</button>
            ))}
          </div>
          <div className="anx-seg">
            {(['dots', 'surface', 'areas'] as GeoViz[]).map((v) => (
              <button key={v} type="button" disabled={(v === 'surface' && (!metric.zip || effView !== 'count')) || (v === 'areas' && effView === 'count')} className={cls(effViz === v && 'is-on')} onClick={() => setViz(v)}>{v === 'dots' ? 'Markets' : v === 'surface' ? 'Surface' : 'States'}</button>
            ))}
          </div>
        </div>
        {(SECONDARY[metric.key] ?? []).length ? (
          <div className="anx-second">
            <span>Overlay</span>
            <button type="button" className={cls('anx-pill', 'is-sm', !secondary && 'is-on')} onClick={() => setSecondary(null)}>None</button>
            {(SECONDARY[metric.key] ?? []).map((k) => <button key={k} type="button" className={cls('anx-pill', 'is-sm', 'is-gold', secondary === k && 'is-on')} onClick={() => setSecondary(k)}>{GEO_METRICS.find((m) => m.key === k)?.short}</button>)}
          </div>
        ) : null}
        <p className="anx-note">
          {metric.grain}. {effView === 'rate' ? `${metric.rateLabel}. ` : ''}{note ? `${note}. ` : ''}
          {unresolved ? `${fmtInt(unresolved)} ${metric.key === 'buyers' ? 'purchases' : 'records'} could not be placed in a canonical market and are not shown. ` : ''}
          Values are exact; only visual size is scaled.
        </p>
        {top.length ? (
          <ol className="anx-rank">
            {top.map((x, i) => (
              <li key={x.m.id} style={{ '--i': i } as CSSProperties}>
                <button type="button" className={cls(selection.market === x.m.id && 'is-on')} onClick={() => onInspect(x.m.id)}>
                  <span className="n">{i + 1}</span>
                  <span className="t">{x.m.name}</span>
                  <b className={cls(effView === 'change' && `t-${tone(x.v ?? 0)}`)}>{effView === 'rate' ? fmtPct(x.v) : effView === 'change' ? `${(x.v ?? 0) > 0 ? '+' : ''}${fmtInt(x.v)}` : fmtInt(x.v)}</b>
                  <i style={{ '--w': `${Math.min(100, (Math.abs(x.v ?? 0) / Math.max(1e-9, Math.abs(top[0].v ?? 1))) * 100)}%` } as CSSProperties} />
                </button>
              </li>
            ))}
          </ol>
        ) : <p className="anx-note is-empty">No {metric.label.toLowerCase()} {metric.state ? 'right now' : 'in this period'}{state ? ` in ${state}` : ''}.</p>}
        <button type="button" className="anx-btn" onClick={onOpenMap}><Icon name="map" />Open operational Map</button>
      </div>
    </section>
  )
}
