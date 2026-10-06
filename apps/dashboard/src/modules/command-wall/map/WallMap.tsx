/**
 * Command Wall map — the hero (§11). The SAME Map engine pieces the desktop map
 * runs on (MapLibre + commandMapThemes styles + the basemap painter + the
 * owned-layer contract + the camera/crime/presence context layers), mounted
 * read-only: no handlers, no popups, no clicks, nothing that can write.
 *
 * Load discipline for an unattended screen:
 *   - nothing animates on a timer; pulses are one-shot CSS ripples on real
 *     arrivals, and the map only re-renders when data or the camera changes;
 *   - GeoJSON is pushed with setData only when its content changed;
 *   - context layers refetch at most every 10 minutes (server-cached too);
 *   - WebGL context loss or a style that never loads hands over to the SAFE
 *     atlas instead of leaving a blank screen.
 */
import { useEffect, useRef } from 'react'
import type { Map as MlMap, Marker as MlMarker, GeoJSONSource, StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { getCommandMapThemeStyle } from '../../../views/map/commandMapThemes'
import { applyVisualPresetBasemapPaint } from '../../../views/map/map-basemap-paint'
import { isOwnedMapLayer } from '../../../views/map/map-layer-ownership'
import { cameraFeatures, ensureCameras, removeCameras, crimeFeatures, ensureCrime, removeCrime, presenceData, ensurePresence, removePresence } from '../../../views/map/desktop/context/context-layers'
import type { CamerasReply, CrimeReply, PresenceReply } from '../../../views/map/desktop/context/context-model'
import { mapThemeFor, toneVar, type Bounds } from './wall-map-model'
import { flightDurationMs, haversineKm } from '../wall-rotation'
import { mapPixelRatio } from '../render-mode'
import type { WallEvent, WallLayerId, WallRenderMode, WallThemeId } from '../wall-types'

export type WallMapTarget = { kind: 'bounds'; bounds: Bounds; key: string } | { kind: 'center'; lng: number; lat: number; zoom: number; key: string }

export interface WallMapProps {
  mode: Exclude<WallRenderMode, 'safe'>
  theme: WallThemeId
  layers: WallLayerId[]
  target: WallMapTarget
  padding: { top: number; right: number; bottom: number; left: number }
  glow: GeoJSON.FeatureCollection
  activity: GeoJSON.FeatureCollection
  miZips: GeoJSON.FeatureCollection
  reducedMotion: boolean
  /** the one channel's arrival stream (pulses) */
  subscribeArrivals: (fn: (evs: WallEvent[]) => void) => () => void
  pulseFilter: (evs: WallEvent[]) => WallEvent[]
  fetchLayer: (kind: 'cameras' | 'crime' | 'presence', bbox: string, zoom: number) => Promise<unknown>
  onFail: (reason: string) => void
  onStats?: (s: { tilesErrored: number; contextLost: number; styleLoads: number }) => void
}

const SRC = { glow: 'nx-wall-glow-src', activity: 'nx-wall-activity-src', mi: 'nx-wall-mi-src', states: 'nx-wall-states-src' } as const
const LYR = { states: 'nx-wall-states', glowHalo: 'nx-wall-glow-halo', glowCore: 'nx-wall-glow-core', activity: 'nx-wall-activity', mi: 'nx-wall-mi' } as const

let statesData: Promise<GeoJSON.FeatureCollection | null> | null = null
/** The state outlines the app already ships (/geo/us-states.json), loaded once per page. */
function loadStates(): Promise<GeoJSON.FeatureCollection | null> {
  if (!statesData) statesData = fetch('/geo/us-states.json', { cache: 'force-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => { statesData = null; return null })
  return statesData
}
const CONTEXT_REFRESH_MS = 10 * 60_000
const STYLE_TIMEOUT_MS = 25_000

function rgbVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v ? `rgb(${v})` : fallback
}
function rgbaVar(name: string, alpha: number, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v ? `rgba(${v}, ${alpha})` : fallback
}

/** Scales a text-size value (number, zoom interpolate/step, or legacy stops) — TV 4K legibility. */
function scaleTextSize(v: unknown, k: number): unknown {
  if (typeof v === 'number') return Math.round(v * k * 10) / 10
  if (Array.isArray(v) && (v[0] === 'interpolate' || v[0] === 'step')) {
    const out = [...v]
    const first = v[0] === 'interpolate' ? 4 : 3
    if (v[0] === 'step') out[2] = scaleTextSize(v[2], k)
    for (let i = first; i < out.length; i += 2) out[i] = scaleTextSize(out[i], k)
    return out
  }
  if (v && typeof v === 'object' && Array.isArray((v as { stops?: unknown[] }).stops)) {
    return { ...(v as object), stops: (v as { stops: [number, number][] }).stops.map(([z, n]) => [z, typeof n === 'number' ? n * k : n]) }
  }
  return v
}

function setDataIfChanged(map: MlMap, id: string, fc: GeoJSON.FeatureCollection, last: Map<string, string>) {
  const sig = JSON.stringify(fc)
  if (last.get(id) === sig) return
  const src = map.getSource(id) as GeoJSONSource | undefined
  if (src) { src.setData(fc); last.set(id, sig) }
}

export function WallMap(props: WallMapProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MlMap | null>(null)
  const libRef = useRef<typeof import('maplibre-gl') | null>(null)
  const readyRef = useRef(false)
  const lastData = useRef(new Map<string, string>())
  const markersRef = useRef(new Set<MlMarker>())
  const labelsRef = useRef(new Map<string, { marker: MlMarker; html: string }>())
  const propsRef = useRef(props)
  const statsRef = useRef({ tilesErrored: 0, contextLost: 0, styleLoads: 0 })
  const targetKeyRef = useRef<string | null>(null)
  const contextAtRef = useRef(new Map<string, number>())

  useEffect(() => { propsRef.current = props })

  // ── create / destroy (theme or render mode change → new style, same map) ──
  useEffect(() => {
    let disposed = false
    let styleTimer: ReturnType<typeof setTimeout> | null = null
    const host = hostRef.current
    if (!host) return undefined
    const p = propsRef.current
    void import('maplibre-gl').then((mod) => {
      if (disposed) return
      const maplibregl = (mod as unknown as { default?: typeof import('maplibre-gl') }).default ?? mod
      libRef.current = maplibregl
      let map: MlMap
      try {
        map = new maplibregl.Map({
          container: host,
          style: getCommandMapThemeStyle(mapThemeFor(p.theme)) as string | StyleSpecification,
          interactive: false,
          attributionControl: false,
          fadeDuration: p.mode === 'lite' ? 0 : 300,
          pixelRatio: mapPixelRatio(p.mode, window.devicePixelRatio || 1, window.innerWidth),
          bounds: p.target.kind === 'bounds' ? p.target.bounds : undefined,
          center: p.target.kind === 'center' ? [p.target.lng, p.target.lat] : undefined,
          zoom: p.target.kind === 'center' ? p.target.zoom : undefined,
          fitBoundsOptions: { padding: p.padding },
          maxTileCacheSize: p.mode === 'lite' ? 120 : 240,
          refreshExpiredTiles: false,
          canvasContextAttributes: { antialias: p.mode === 'full', preserveDrawingBuffer: false, powerPreference: 'default', failIfMajorPerformanceCaveat: false },
        } as never)
      } catch (error) {
        p.onFail(`map_init_failed:${String((error as Error)?.message || error).slice(0, 80)}`)
        return
      }
      mapRef.current = map
      targetKeyRef.current = p.target.key
      styleTimer = setTimeout(() => { if (!readyRef.current) propsRef.current.onFail('style_timeout') }, STYLE_TIMEOUT_MS)
      map.on('error', (e: { error?: { status?: number; message?: string }; sourceId?: string }) => {
        statsRef.current.tilesErrored += 1
        propsRef.current.onStats?.({ ...statsRef.current })
        void e
      })
      const canvas = map.getCanvas()
      canvas.addEventListener('webglcontextlost', (ev) => {
        ev.preventDefault()
        statsRef.current.contextLost += 1
        propsRef.current.onFail('webgl_context_lost')
      })
      map.on('style.load', () => {
        statsRef.current.styleLoads += 1
        readyRef.current = true
        lastData.current.clear()
        installLayers(map)
        syncData(map)
        void syncContext(map, true)
      })
      map.on('moveend', () => { void syncContext(map, false) })
    })
    const markers = markersRef.current
    const labels = labelsRef.current
    return () => {
      disposed = true
      if (styleTimer) clearTimeout(styleTimer)
      for (const m of markers) m.remove()
      markers.clear()
      for (const l of labels.values()) l.marker.remove()
      labels.clear()
      readyRef.current = false
      mapRef.current?.remove()
      mapRef.current = null
    }
  // Recreated only when the theme or render mode changes; everything else is
  // read through propsRef so data updates never rebuild the map.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.theme, props.mode])

  function installLayers(map: MlMap) {
    const p = propsRef.current
    applyVisualPresetBasemapPaint(map, mapThemeFor(p.theme), isOwnedMapLayer)
    // A 4K TV at DPR 1 draws basemap labels at half their physical size: scale them with the wall's type
    const k = typeof window === 'undefined' ? 1 : Math.min(2.2, Math.max(1, (window.innerHeight * (window.devicePixelRatio || 1)) / 1080 / (window.devicePixelRatio || 1)))
    if (k > 1.15) {
      for (const l of map.getStyle()?.layers ?? []) {
        if (l.type !== 'symbol' || isOwnedMapLayer(l.id)) continue
        try {
          const cur = map.getLayoutProperty(l.id, 'text-size')
          if (cur !== undefined) map.setLayoutProperty(l.id, 'text-size', scaleTextSize(cur, k * 0.92) as never)
        } catch { /* expression shape we do not rewrite */ }
      }
    }
    if (p.theme === 'true_black') {
      for (const l of map.getStyle()?.layers ?? []) {
        if (l.type === 'background') { try { map.setPaintProperty(l.id, 'background-color', '#000000') } catch { /* style variant */ } }
      }
    }
    const exec = rgbVar('--lc-exec-rgb', 'rgb(76,201,240)')
    const ok = rgbVar('--lc-ok-rgb', 'rgb(61,220,151)')
    const attn = rgbVar('--lc-attn-rgb', 'rgb(240,182,74)')
    const ink = p.theme === 'light' ? 'rgba(11,18,32,0.55)' : 'rgba(226,232,244,0.55)'
    const blur = p.mode === 'full' ? 1 : 0.6
    const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
    for (const id of Object.values(SRC)) if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: empty })
    if (!map.getLayer(LYR.states)) {
      map.addLayer({ id: LYR.states, type: 'line', source: SRC.states, paint: { 'line-color': p.theme === 'light' ? 'rgba(11,18,32,0.22)' : 'rgba(170,190,220,0.16)', 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 8, 1.2] } } as never)
      void loadStates().then((fc) => { const src = map.getSource(SRC.states) as GeoJSONSource | undefined; if (fc && src) src.setData(fc) })
    }
    if (!map.getLayer(LYR.glowHalo)) {
      map.addLayer({
        id: LYR.glowHalo, type: 'circle', source: SRC.glow,
        paint: {
          'circle-color': exec,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, ['+', 18, ['*', 34, ['get', 'energy']]], 9, ['+', 46, ['*', 96, ['get', 'energy']]]],
          'circle-blur': blur,
          'circle-opacity': ['case', ['==', ['get', 'active'], 1], ['+', 0.16, ['*', 0.22, ['get', 'energy']]], 0.06],
        },
      } as never)
    }
    if (!map.getLayer(LYR.glowCore)) {
      map.addLayer({
        id: LYR.glowCore, type: 'circle', source: SRC.glow,
        paint: {
          'circle-color': ['case', ['==', ['get', 'active'], 1], exec, ink],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3.5, 9, 6],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': p.theme === 'light' ? 'rgba(255,255,255,0.9)' : 'rgba(5,8,13,0.85)',
        },
      } as never)
    }
    if (!map.getLayer(LYR.mi)) {
      map.addLayer({
        id: LYR.mi, type: 'circle', source: SRC.mi,
        paint: {
          'circle-color': attn,
          'circle-radius': ['interpolate', ['linear'], ['sqrt', ['max', 1, ['get', 'sales']]], 1, 4, 30, 26],
          'circle-opacity': ['case', ['<', ['get', 'inv'], 0], 0.16, ['+', 0.14, ['*', 0.5, ['get', 'inv']]]],
          'circle-stroke-width': 1,
          'circle-stroke-color': rgbaVar('--lc-attn-rgb', 0.55, 'rgba(240,182,74,0.55)'),
        },
      } as never)
    }
    if (!map.getLayer(LYR.activity)) {
      map.addLayer({
        id: LYR.activity, type: 'circle', source: SRC.activity,
        paint: {
          'circle-color': ['match', ['get', 'kind'], 'interest', ok, 'deal', ok, 'offer', attn, 'counter', attn, 'asking_price', attn, exec],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2.5, 10, 5],
          'circle-opacity': ['+', 0.35, ['*', 0.6, ['get', 'fresh']]],
        },
      } as never)
    }
    applyLayerVisibility(map)
  }

  function applyLayerVisibility(map: MlMap) {
    const set = new Set(propsRef.current.layers)
    const vis = (id: string, on: boolean) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none') }
    vis(LYR.states, set.has('boundaries'))
    vis(LYR.glowHalo, set.has('campaigns'))
    vis(LYR.glowCore, set.has('campaigns') || set.has('mi_heat') || set.has('activity'))
    vis(LYR.mi, set.has('mi_heat'))
    vis(LYR.activity, set.has('activity') || set.has('pipeline'))
  }

  function syncLabels(map: MlMap) {
    const lib = libRef.current
    if (!lib) return
    const p = propsRef.current
    const want = new Map<string, { lng: number; lat: number; html: string }>()
    // market labels where markets are the subject; not in MI (city-zoom basemap labels already name places)
    if ((p.layers.includes('campaigns') || p.layers.includes('activity')) && !p.layers.includes('mi_heat')) {
      for (const f of p.glow.features.slice(0, 14)) {
        const pr = f.properties || {}
        const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates
        const name = String(pr.name || '').replace(/,\s*[A-Z]{2}$/, '')
        const bits = [pr.sends ? `${pr.sends} out` : null, pr.replies ? `${pr.replies} repl${pr.replies === 1 ? 'y' : 'ies'}` : null].filter(Boolean)
        const sub = bits.length ? `${bits.join(' · ')} · 30 min` : pr.campaigns ? `${pr.campaigns} campaign${pr.campaigns === 1 ? '' : 's'}` : ''
        want.set(String(pr.id), { lng, lat, html: `<span class="cw-mlabel__n">${name.replace(/[<>&]/g, '')}</span>${sub ? `<span class="cw-mlabel__s">${sub}</span>` : ''}` })
      }
    }
    for (const [id, m] of labelsRef.current) if (!want.has(id)) { m.marker.remove(); labelsRef.current.delete(id) }
    for (const [id, w] of want) {
      const cur = labelsRef.current.get(id)
      if (cur) { if (cur.html !== w.html) { cur.marker.getElement().innerHTML = w.html; cur.html = w.html } continue }
      const el = document.createElement('div')
      el.className = 'cw-mlabel'
      el.innerHTML = w.html
      const marker = new lib.Marker({ element: el, anchor: 'left', offset: [12, 0] }).setLngLat([w.lng, w.lat]).addTo(map)
      labelsRef.current.set(id, { marker, html: w.html })
    }
  }

  function syncData(map: MlMap) {
    if (!readyRef.current) return
    syncLabels(map)
    const p = propsRef.current
    setDataIfChanged(map, SRC.glow, p.glow, lastData.current)
    setDataIfChanged(map, SRC.activity, p.activity, lastData.current)
    setDataIfChanged(map, SRC.mi, p.miZips, lastData.current)
  }

  async function syncContext(map: MlMap, force: boolean) {
    if (!readyRef.current) return
    const p = propsRef.current
    const wanted = new Set(p.layers)
    const zoom = map.getZoom()
    const b = map.getBounds()
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(3)).join(',')
    const light = p.theme === 'light'
    const due = (kind: string) => {
      const key = `${kind}|${bbox.split(',').map((v) => Number(v).toFixed(1)).join(',')}|${Math.round(zoom * 2) / 2}`
      const at = contextAtRef.current.get(key)
      if (!force && at && Date.now() - at < CONTEXT_REFRESH_MS) return null
      contextAtRef.current.set(key, Date.now())
      if (contextAtRef.current.size > 40) contextAtRef.current.delete(contextAtRef.current.keys().next().value as string)
      return key
    }
    if (wanted.has('cameras')) {
      if (due('cameras')) { const r = await p.fetchLayer('cameras', bbox, zoom).catch(() => null) as CamerasReply | null; if (r && mapRef.current === map && r.ok !== false) ensureCameras(map, cameraFeatures(r), light) }
    } else removeCameras(map)
    if (wanted.has('crime') && zoom >= 11) {
      if (due('crime')) { const r = await p.fetchLayer('crime', bbox, zoom).catch(() => null) as CrimeReply | null; if (r && mapRef.current === map && r.ok !== false) ensureCrime(map, crimeFeatures(r), light) }
    } else removeCrime(map)
    if (wanted.has('investor') && zoom >= 9.5) {
      if (due('presence')) { const r = await p.fetchLayer('presence', bbox, zoom).catch(() => null) as PresenceReply | null; if (r && mapRef.current === map && r.ok !== false) ensurePresence(map, presenceData(r), 'composite') }
    } else removePresence(map)
  }

  // ── data + layer changes ──
  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    syncData(map)
    applyLayerVisibility(map)
    void syncContext(map, false)
  // syncData / applyLayerVisibility / syncContext read the latest props through propsRef
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.glow, props.activity, props.miZips, props.layers])

  // ── camera target (framing / tour / follow) ──
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (targetKeyRef.current === props.target.key) return
    targetKeyRef.current = props.target.key
    const t = props.target
    const from = map.getCenter()
    const fromZoom = map.getZoom()
    if (t.kind === 'bounds') {
      const cam = map.cameraForBounds(t.bounds, { padding: props.padding })
      if (!cam?.center) return
      const c = cam.center as { lng: number; lat: number }
      const duration = flightDurationMs(fromZoom, cam.zoom ?? fromZoom, haversineKm(from, c), props.reducedMotion)
      if (duration === 0) map.jumpTo(cam)
      else map.flyTo({ ...cam, duration, curve: 1.2, essential: false })
    } else {
      const duration = flightDurationMs(fromZoom, t.zoom, haversineKm(from, t), props.reducedMotion)
      if (duration === 0) map.jumpTo({ center: [t.lng, t.lat], zoom: t.zoom })
      else map.flyTo({ center: [t.lng, t.lat], zoom: t.zoom, duration, curve: 1.2, essential: false })
    }
  }, [props.target, props.padding, props.reducedMotion])

  // ── pulses: one-shot ripples on REAL arrivals only (§13, §67) ──
  const { subscribeArrivals } = props
  useEffect(() => {
    return subscribeArrivals((evs) => {
      const map = mapRef.current
      const lib = libRef.current
      if (!map || !lib || !readyRef.current) return
      const p = propsRef.current
      const list = p.pulseFilter(evs).slice(0, p.mode === 'lite' ? 3 : 8)
      for (const ev of list) {
        const el = document.createElement('div')
        el.className = `cw-pulse cw-pulse--p${ev.priority} cw-pulse--${ev.kind}`
        el.style.setProperty('--cw-pulse-rgb', toneVar(ev.tone))
        if (p.reducedMotion) el.classList.add('cw-pulse--still')
        const marker = new lib.Marker({ element: el }).setLngLat([ev.geo!.lng as number, ev.geo!.lat as number]).addTo(map)
        markersRef.current.add(marker)
        const ttl = p.reducedMotion ? 6_000 : ev.kind === 'offer' || ev.kind === 'deal' ? 5_200 : 3_600
        setTimeout(() => { marker.remove(); markersRef.current.delete(marker) }, ttl)
      }
    })
  }, [subscribeArrivals])

  return <div ref={hostRef} className="cw-map" aria-hidden="true" data-cw-map-mode={props.mode} />
}
