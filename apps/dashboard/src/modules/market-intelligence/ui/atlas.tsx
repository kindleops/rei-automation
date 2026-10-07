import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { GeoJSONSource, Map as MlMap, MapLayerMouseEvent, StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { LCButton, LCSelect, useLcReducedMotion } from '../../../shared/lc'
import { loadSettings, subscribeSettings } from '../../../shared/settings'
import { getCommandMapThemeStyle } from '../../../views/map/commandMapThemes'
import { applyVisualPresetBasemapPaint } from '../../../views/map/map-basemap-paint'
import { isOwnedMapLayer } from '../../../views/map/map-layer-ownership'
import { miUrl, useMiQuery, dataOf } from '../mi-api'
import { useMi } from '../mi-context'
import { fmtCount, fmtUnit } from '../mi-format'
import { showGeoOnMap } from '../mi-handoffs'
import type { MiGeoSummary, MiHeatResult, MiPointsResult, MiUnit } from '../mi-types'
import { writeMiMapContext } from '../map/mi-map-lenses'
import { ATLAS_BY_ID, ATLAS_METRICS, RAMP, areasCollection, areasRequest, atlasAvailability, atlasFrame, densityColor, legendRange, pointsCollection, rampExpression, rampModeFor, type AtlasMetric, type RampMode } from './atlas-model'

/**
 * HERO ATLAS: the geography on the app's own Map engine pieces (MapLibre + the
 * commandMapThemes basemap + the basemap painter + the owned-layer contract), with
 *   - a choropleth of outlined areas (US Census states nationwide; ZCTA outlines in a metro),
 *   - a ZIP density layer for COUNT metrics (sales, recorded / inferred investor purchases),
 *   - ZIP bubbles for RATE metrics (share, median): colour = rank, size = sales (the sample).
 * Read-only: hover reads real figures, click opens the area's Inspector. Nothing writes.
 * Theme change → new style, layers reinstall on style.load (the Map's own rule).
 */
const SRC = { areas: 'nx-mi-atlas-areas', points: 'nx-mi-atlas-points' } as const
const LYR = { fill: 'nx-mi-atlas-fill', line: 'nx-mi-atlas-line', hover: 'nx-mi-atlas-hover', subject: 'nx-mi-atlas-subject', heat: 'nx-mi-atlas-heat', dots: 'nx-mi-atlas-dots' } as const
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

function useNexusTheme(): string {
  return useSyncExternalStore(subscribeSettings, () => loadSettings().nexusTheme, () => 'dark')
}
const mapThemeFor = (t: string) => (t === 'light' ? 'light_street' : t === 'red_ops' ? 'red_ops' : 'dark_ops')

interface Hover { label: string; value: string; detail: string }
interface Latest { areas: GeoJSON.FeatureCollection; points: GeoJSON.FeatureCollection; kind: 'count' | 'rate'; mode: RampMode; unit: MiUnit; geo: MiGeoSummary; inspect: string | null; reduced: boolean; setInspect: (id: string | null) => void }

function install(map: MlMap, t: string, L: Latest) {
  applyVisualPresetBasemapPaint(map, mapThemeFor(t), isOwnedMapLayer)
  if (t === 'true_black') for (const l of map.getStyle()?.layers ?? []) if (l.type === 'background') { try { map.setPaintProperty(l.id, 'background-color', '#000000') } catch { /* variant */ } }
  const before = (map.getStyle()?.layers ?? []).find((l) => l.type === 'symbol' && !isOwnedMapLayer(l.id))?.id
  for (const id of Object.values(SRC)) if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY, promoteId: 'id' } as never)
  const add = (spec: Record<string, unknown>) => { if (!map.getLayer(spec.id as string)) map.addLayer(spec as never, before) }
  add({ id: LYR.fill, type: 'fill', source: SRC.areas, paint: { 'fill-color': '#000', 'fill-opacity': 0 } })
  add({ id: LYR.line, type: 'line', source: SRC.areas, paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 10, 0.9] } })
  add({ id: LYR.heat, type: 'heatmap', source: SRC.points, paint: {
    'heatmap-weight': ['to-number', ['get', 'w'], 0],
    'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 3, 0.85, 7, 1.25, 11, 1.8],
    'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 3, 17, 6, 26, 9, 38, 12, 58],
    'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.92, 12, 0.66],
  } })
  add({ id: LYR.dots, type: 'circle', source: SRC.points, paint: {} })
  add({ id: LYR.subject, type: 'line', source: SRC.areas, paint: { 'line-width': 2.4 } })
  add({ id: LYR.hover, type: 'line', source: SRC.areas, paint: { 'line-width': 2, 'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0] } })
  paint(map, L)
}

function paint(map: MlMap, L: Latest) {
  const { kind, mode: m } = L
  if (!map.getLayer(LYR.fill)) return
  const dark = m === 'dark'
  const quiet = dark ? 'rgba(160,180,210,0.05)' : 'rgba(20,32,56,0.04)'
  map.setPaintProperty(LYR.fill, 'fill-color', ['case', ['==', ['get', 'member'], 1], rampExpression(m), quiet] as never)
  map.setPaintProperty(LYR.fill, 'fill-opacity', (kind === 'count' ? ['case', ['==', ['get', 'member'], 1], dark ? 0.34 : 0.36, 1] : ['case', ['==', ['get', 'member'], 1], dark ? 0.56 : 0.62, 1]) as never)
  map.setPaintProperty(LYR.line, 'line-color', dark ? 'rgba(180,205,240,0.22)' : 'rgba(20,40,80,0.20)')
  map.setPaintProperty(LYR.hover, 'line-color', dark ? '#e6f4ff' : '#0b2a5e')
  // the subject itself (a ZIP or a state) is outlined so it is found at a glance
  map.setFilter(LYR.subject, ['in', ['get', 'id'], ['literal', [L.geo.id, L.inspect ?? L.geo.id]]] as never)
  map.setPaintProperty(LYR.subject, 'line-color', dark ? 'rgba(255,255,255,0.92)' : 'rgba(8,24,56,0.9)')
  map.setPaintProperty(LYR.heat, 'heatmap-color', densityColor(m) as never)
  map.setLayoutProperty(LYR.heat, 'visibility', kind === 'count' ? 'visible' : 'none')
  const ring = dark ? 'rgba(6,10,18,0.85)' : 'rgba(255,255,255,0.92)'
  const thin = dark ? 'rgba(170,185,210,0.35)' : 'rgba(40,55,80,0.3)'
  if (kind === 'count') {
    // density carries the read; small hover targets appear as you zoom in
    map.setPaintProperty(LYR.dots, 'circle-radius', ['interpolate', ['linear'], ['zoom'], 3, 1.2, 8, 3, 12, 6] as never)
    map.setPaintProperty(LYR.dots, 'circle-color', ['case', ['==', ['get', 'ok'], 1], RAMP[m][4], thin] as never)
    map.setPaintProperty(LYR.dots, 'circle-opacity', ['interpolate', ['linear'], ['zoom'], 3, 0.0, 7, 0.55, 10, 0.85] as never)
    map.setPaintProperty(LYR.dots, 'circle-stroke-width', 0)
  } else {
    map.setPaintProperty(LYR.dots, 'circle-radius', ['interpolate', ['linear'], ['zoom'], 3, ['interpolate', ['linear'], ['sqrt', ['max', 1, ['get', 'sales']]], 1, 1.6, 40, 7], 10, ['interpolate', ['linear'], ['sqrt', ['max', 1, ['get', 'sales']]], 1, 4, 40, 18]] as never)
    map.setPaintProperty(LYR.dots, 'circle-color', ['case', ['==', ['get', 'ok'], 1], rampExpression(m), 'rgba(0,0,0,0)'] as never)
    map.setPaintProperty(LYR.dots, 'circle-opacity', 0.92)
    map.setPaintProperty(LYR.dots, 'circle-stroke-width', ['case', ['==', ['get', 'ok'], 1], 0.8, 1] as never)
    map.setPaintProperty(LYR.dots, 'circle-stroke-color', ['case', ['==', ['get', 'ok'], 1], ring, thin] as never)
  }
}

function sync(map: MlMap, L: Latest) {
  ;(map.getSource(SRC.areas) as GeoJSONSource | undefined)?.setData(L.areas)
  ;(map.getSource(SRC.points) as GeoJSONSource | undefined)?.setData(L.points)
  paint(map, L)
}



export function MiAtlas({ geo, height }: { geo: MiGeoSummary; height: number }) {
  const { state, set, status, setInspect, inspect, metric: metricDef } = useMi()
  const theme = useNexusTheme()
  const reduced = useLcReducedMotion()
  const fallback = ATLAS_METRICS[0]
  const want = ATLAS_BY_ID.get(state.hm) ?? fallback
  const metric: AtlasMetric = atlasAvailability(want, state.asset, status).ok ? want : fallback
  const unit: MiUnit = metricDef(metric.id)?.unit ?? 'count'
  const req = areasRequest(geo)
  const heatQ = useMiQuery<MiHeatResult>(miUrl('heat', { metric: metric.id, bbox: req.bbox, zoom: req.zoom, period: state.period, asset: state.asset }))
  const pointsQ = useMiQuery<MiPointsResult>(miUrl('points', { within: geo.id, metric: metric.id, period: state.period, asset: state.asset }))
  const heat = dataOf(heatQ)
  const pts = dataOf(pointsQ)
  const members = useMemo(() => (pts ? new Set(pts.rows.map((r) => r.id)) : null), [pts])
  const areas = useMemo(() => areasCollection(heat, geo, members), [heat, geo, members])
  const points = useMemo(() => pointsCollection(pts?.rows ?? null, metric.kind), [pts, metric.kind])
  const range = useMemo(() => legendRange(req.zoom === 10 ? (heat?.rows ?? []) : (pts?.rows ?? [])), [heat, pts, req.zoom])
  const [hover, setHover] = useState<Hover | null>(null)
  const [mapState, setMapState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const mode = rampModeFor(theme)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MlMap | null>(null)
  const latest = useRef<Latest>({ areas, points, kind: metric.kind, mode, unit, geo, inspect, reduced, setInspect })
  useEffect(() => { latest.current = { areas, points, kind: metric.kind, mode, unit, geo, inspect, reduced, setInspect } })

  // ── create once per theme; layers reinstall on every style.load ──
  useEffect(() => {
    let disposed = false
    const host = hostRef.current
    if (!host) return undefined
    void import('maplibre-gl').then((mod) => {
      if (disposed) return
      const maplibregl = (mod as unknown as { default?: typeof import('maplibre-gl') }).default ?? mod
      let map: MlMap
      try {
        map = new maplibregl.Map({
          container: host,
          style: getCommandMapThemeStyle(mapThemeFor(theme)) as string | StyleSpecification,
          bounds: atlasFrame(latest.current.geo),
          fitBoundsOptions: { padding: 28 },
          attributionControl: { compact: true },
          cooperativeGestures: true,
          dragRotate: false,
          pitchWithRotate: false,
          fadeDuration: 0,
          maxTileCacheSize: 160,
          canvasContextAttributes: { antialias: true, preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: false },
        } as never)
      } catch {
        setMapState('failed')
        return
      }
      mapRef.current = map
      map.on('style.load', () => { install(map, theme, latest.current); sync(map, latest.current); setMapState('ready') })
      map.on('error', () => { /* a tile error leaves the rest of the map */ })
      map.getCanvas().addEventListener('webglcontextlost', () => setMapState('failed'))
      let hovered: string | number | null = null
      const clearHover = () => { if (hovered !== null) { try { map.setFeatureState({ source: SRC.areas, id: hovered }, { hover: false }) } catch { /* style swap */ } } hovered = null; setHover(null); map.getCanvas().style.cursor = '' }
      const onMove = (e: MapLayerMouseEvent) => {
        const f = e.features?.[0]
        if (!f) return
        const p = f.properties as Record<string, unknown>
        const L = latest.current
        map.getCanvas().style.cursor = 'pointer'
        if (f.layer.id === LYR.fill) {
          if (hovered !== f.id && f.id !== undefined) { clearHover(); hovered = f.id; map.setFeatureState({ source: SRC.areas, id: f.id }, { hover: true }); map.getCanvas().style.cursor = 'pointer' }
          setHover({ label: String(p.label ?? ''), value: p.member ? fmtUnit(L.unit, Number(p.v)) : 'Outside this geography', detail: String(p.tip ?? '') })
        } else {
          const ok = Number(p.ok) === 1
          setHover({ label: String(p.label ?? ''), value: ok ? fmtUnit(L.unit, Number(p.v)) : String(p.s) === 'insufficient' ? 'Thin sample' : 'No value', detail: `${fmtCount(Number(p.sales) || 0)} sales${ok && Number(p.n) ? ` · n ${fmtCount(Number(p.n))}` : ''}` })
        }
      }
      for (const id of [LYR.fill, LYR.dots]) {
        map.on('mousemove', id, onMove)
        map.on('mouseleave', id, clearHover)
        map.on('click', id, (e: MapLayerMouseEvent) => { const f = e.features?.[0]; const gid = f?.properties?.id; if (typeof gid === 'string' && (f?.layer.id !== LYR.fill || Number(f?.properties?.member) === 1)) latest.current.setInspect(gid) })
      }
    })
    return () => { disposed = true; mapRef.current?.remove(); mapRef.current = null }
  }, [theme])

  useEffect(() => { const map = mapRef.current; if (map && mapState === 'ready') sync(map, latest.current) }, [areas, points, metric.kind, mode, mapState, inspect])

  // ── frame the geography (the Map's fly-to, instant under reduced motion) ──
  const frameKey = geo.id
  useEffect(() => {
    const map = mapRef.current
    if (!map || mapState !== 'ready') return
    map.fitBounds(atlasFrame(latest.current.geo), { padding: 28, duration: latest.current.reduced ? 0 : 900 })
  }, [frameKey, mapState])

  const loading = heatQ.kind === 'loading' || pointsQ.kind === 'loading' || mapState === 'loading'
  const note = pts?.note ?? (req.zoom === 10 ? null : geo.level === 'nation' ? null : 'ZIP outlines need an area under ~4°; ZIPs are drawn as points here.')
  const options = ATLAS_METRICS.map((m) => { const a = atlasAvailability(m, state.asset, status); return { value: m.id, label: m.label, disabled: !a.ok, hint: a.ok ? undefined : a.reason } })
  const r = RAMP[mode]
  const zipN = pts?.rows.filter((x) => x.v !== null).length ?? 0
  const quietN = pts?.without_value ? ` · ${fmtCount(pts.without_value)} thin or without a value, drawn quiet` : ''
  const legendLine = req.zoom === 10
    ? `ZIP colour = rank among ${fmtCount(heat?.rows.length ?? 0)} outlined ZIPs with a value${quietN}`
    : `${geo.level === 'nation' ? 'States' : 'State'} coloured by rank · ${metric.kind === 'count' ? 'glow' : 'bubbles'} = ${fmtCount(zipN)} ZIPs (range shown)${quietN}`
  return (
    <section className="mi-atlas-card" aria-label={`${geo.label}: ${metric.label} map`} style={{ height }}>
      <div ref={hostRef} className="mi-atlas" data-state={mapState} data-heat-n={points.features.length} data-area-n={areas.features.length} data-layers={metric.kind === 'count' ? 'areas,density,dots' : 'areas,bubbles'} />
      <header className="mi-atlas__bar">
        <span className="mi-atlas__chip"><LCSelect label="Heat by" prefix="Heat" variant="chip" size="sm" value={metric.id} onChange={(v) => set({ hm: v })} options={options} /></span>
        <span className="mi-atlas__kind">{metric.kind === 'count' ? 'Density of ZIP totals' : 'ZIP bubbles · size = sales'}</span>
        <span className="mi-atlas__spacer" />
        <span className="mi-atlas__chip"><LCButton size="sm" variant="ghost" icon="map" trailingIcon="arrow-up-right" onClick={() => { writeMiMapContext({ period: state.period, asset: state.asset }); showGeoOnMap(geo, { lensMetric: metric.id }) }} title="Opens the full Map beside, framed on this area, with this heat lens">Open in Map</LCButton></span>
      </header>
      <div className="mi-atlas__legend">
        <b>{metric.label}</b>
        <i className="mi-atlas__ramp" style={{ background: `linear-gradient(90deg, ${r.join(', ')})` }} aria-hidden="true" />
        <span className="mi-atlas__ends">{range ? <><span>{fmtUnit(unit, range.min)}</span><span>{fmtUnit(unit, range.max)}</span></> : <span>—</span>}</span>
        <small>{legendLine}</small>
        <small className="mi-atlas__hint">{metric.hint}</small>
      </div>
      <div className={`mi-atlas__read${hover ? ' is-on' : ''}`} role="status" aria-live="polite">
        {hover ? <><span className="mi-atlas__read-name">{hover.label}</span><b>{hover.value}</b><small>{hover.detail}</small></> : <small>Hover a ZIP or state · click to open its panel</small>}
      </div>
      {note ? <p className="mi-atlas__note">{note}</p> : null}
      {loading ? <div className="mi-atlas__loading" aria-hidden="true"><span /></div> : null}
      {mapState === 'failed' ? <div className="mi-atlas__failed" role="status">The map could not start (WebGL unavailable). The leaderboard and figures beside it are unaffected.</div> : null}
    </section>
  )
}

export type { RampMode }
