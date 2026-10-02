/**
 * BOUNDARIES — the Map's administrative outline overlay (desktop).
 *
 * State and ZIP outlines are US Census geometry LeadCommand owns
 * (risk_private.geography_authoritative), served by the API's server-only
 * GET /api/cockpit/map/boundaries (viewport-bounded, simplified, cached).
 * Nothing is drawn that the server did not return: a level it refuses (ZIP
 * zoomed out) or cannot serve (function not installed) reports why, and the
 * legend says so. County, city and market have no polygon source.
 *
 * The lines sit above the colour lens and under the basemap's labels and every
 * marker; a theme swap (which drops custom sources) restores them.
 */
import { useEffect, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { callBackend } from '../../../lib/api/backendClient'

export type BoundaryLevel = 'state' | 'zip'
export type BoundaryStatus = {
  level: BoundaryLevel
  on: boolean
  state: 'off' | 'loading' | 'on' | 'waiting' | 'unavailable'
  count: number
  /** A plain reason when nothing is drawn (zoomed out, not installed …). */
  reason: string | null
  source: string | null
}
type ApiReply = {
  ok: boolean
  available: boolean
  reason?: string
  source?: string
  data?: GeoJSON.FeatureCollection
}

export const ZIP_MIN_ZOOM = 9
const LIGHT_BASEMAPS = new Set(['light_street', 'terrain'])
const SRC: Record<BoundaryLevel, string> = { state: 'mxd-bnd-state', zip: 'mxd-bnd-zip' }
const LINE: Record<BoundaryLevel, string> = { state: 'mxd-bnd-state-line', zip: 'mxd-bnd-zip-line' }
const ZIP_LABEL = 'mxd-bnd-zip-label'
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
const LAST = new WeakMap<maplibregl.Map, Partial<Record<BoundaryLevel, GeoJSON.FeatureCollection>>>()

export const BOUNDARY_REASON: Record<string, string> = {
  zoom_out: `Zoom in to see ZIP outlines (from z${ZIP_MIN_ZOOM})`,
  too_large: 'Zoom in to see ZIP outlines',
  not_installed: 'Waiting on the boundary migration',
  no_source: 'No boundary source',
  unavailable: 'Boundaries unavailable right now',
}

/** Where the boundary request for a viewport would be refused before any call (mirrors the server). */
export function boundaryRequestFor(level: BoundaryLevel, b: { west: number; south: number; east: number; north: number }, zoom: number): string | null {
  if (level === 'zip' && zoom < ZIP_MIN_ZOOM) return null
  const w = Math.max(-180, b.west)
  const e = Math.min(180, b.east)
  const s = Math.max(-85, b.south)
  const n = Math.min(85, b.north)
  if (!(w < e && s < n)) return null
  if (level === 'zip' && (e - w > 4 || n - s > 4)) return null
  return `/api/cockpit/map/boundaries?level=${level}&bbox=${[w, s, e, n].map((v) => v.toFixed(4)).join(',')}&zoom=${zoom.toFixed(1)}`
}

function firstLabelLayer(map: maplibregl.Map): string | undefined {
  try {
    for (const l of map.getStyle().layers ?? []) if (l.type === 'symbol' && !/^(nx-|prop-|command-|map-agg|inbox-|seller-|buyer-|mxd-)/.test(l.id)) return l.id
  } catch { /* style mid-swap */ }
  return undefined
}

function ensure(map: maplibregl.Map, level: BoundaryLevel, light: boolean) {
  if (!map.style) return
  const ink = light ? 'rgba(28, 34, 48, 0.62)' : 'rgba(226, 232, 244, 0.62)'
  const halo = light ? 'rgba(255, 255, 255, 0.7)' : 'rgba(6, 9, 16, 0.65)'
  if (!map.getSource(SRC[level])) map.addSource(SRC[level], { type: 'geojson', data: LAST.get(map)?.[level] ?? EMPTY })
  const before = firstLabelLayer(map)
  if (!map.getLayer(LINE[level])) {
    map.addLayer({
      id: LINE[level], type: 'line', source: SRC[level],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: level === 'state'
        ? { 'line-color': ink, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1, 8, 1.8, 12, 2.4] as never, 'line-opacity': 0.9 }
        : { 'line-color': ink, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 13, 1.2] as never, 'line-dasharray': [3, 2], 'line-opacity': 0.75 },
    }, before)
  } else {
    map.setPaintProperty(LINE[level], 'line-color', ink)
  }
  if (level === 'zip') {
    if (!map.getLayer(ZIP_LABEL)) {
      map.addLayer({
        id: ZIP_LABEL, type: 'symbol', source: SRC.zip, minzoom: 11.5,
        layout: {
          'symbol-placement': 'point',
          'text-field': ['get', 'key'] as never,
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
          'text-size': 11,
          'text-letter-spacing': 0.08,
          'text-allow-overlap': false,
          'text-padding': 6,
        },
        paint: { 'text-color': ink, 'text-halo-color': halo, 'text-halo-width': 1.2 },
      })
    } else {
      map.setPaintProperty(ZIP_LABEL, 'text-color', ink)
      map.setPaintProperty(ZIP_LABEL, 'text-halo-color', halo)
    }
  }
}

function remove(map: maplibregl.Map, level: BoundaryLevel) {
  try {
    if (level === 'zip' && map.getLayer(ZIP_LABEL)) map.removeLayer(ZIP_LABEL)
    if (map.getLayer(LINE[level])) map.removeLayer(LINE[level])
    if (map.getSource(SRC[level])) map.removeSource(SRC[level])
  } catch { /* style mid-swap */ }
}

const OFF = (level: BoundaryLevel): BoundaryStatus => ({ level, on: false, state: 'off', count: 0, reason: null, source: null })

/** One boundary level on the map; returns its status for the Layers row and the legend. */
export function useMapBoundaryLevel(map: maplibregl.Map | null, mapEpoch: number, level: BoundaryLevel, on: boolean, styleMode: string): BoundaryStatus {
  const [status, setStatus] = useState<BoundaryStatus>(() => OFF(level))
  const seq = useRef(0)
  const light = LIGHT_BASEMAPS.has(styleMode)

  useEffect(() => {
    if (!map) return undefined
    if (!on) {
      remove(map, level)
      const last = LAST.get(map)
      if (last) delete last[level]
      return undefined
    }
    let alive = true
    let timer: number | undefined
    const ctl: { abort: AbortController | null } = { abort: null }
    const apply = () => { try { ensure(map, level, light) } catch { /* style mid-swap */ } }
    const draw = (fc: GeoJSON.FeatureCollection) => {
      LAST.set(map, { ...(LAST.get(map) ?? {}), [level]: fc })
      apply()
      ;(map.getSource(SRC[level]) as maplibregl.GeoJSONSource | undefined)?.setData(fc)
    }
    const load = async () => {
      const id = ++seq.current
      const b = map.getBounds()
      const zoom = map.getZoom()
      const path = boundaryRequestFor(level, { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }, zoom)
      if (!path) {
        draw(EMPTY)
        setStatus({ level, on: true, state: 'waiting', count: 0, reason: BOUNDARY_REASON.zoom_out, source: null })
        return
      }
      ctl.abort?.abort()
      ctl.abort = new AbortController()
      setStatus((s) => ({ ...s, on: true, state: s.count ? s.state : 'loading' }))
      const res = await callBackend<ApiReply>(path, { signal: ctl.abort.signal, timeoutMs: 15_000 })
      if (!alive || id !== seq.current) return
      const body = res.ok ? (res.data as ApiReply | undefined) : undefined
      if (!body || !body.ok) {
        setStatus({ level, on: true, state: 'unavailable', count: 0, reason: BOUNDARY_REASON.unavailable, source: null })
        return
      }
      if (!body.available || !body.data) {
        draw(EMPTY)
        const reason = body.reason ?? 'unavailable'
        setStatus({ level, on: true, state: reason === 'zoom_out' || reason === 'too_large' ? 'waiting' : 'unavailable', count: 0, reason: BOUNDARY_REASON[reason] ?? BOUNDARY_REASON.unavailable, source: null })
        return
      }
      draw(body.data)
      setStatus({ level, on: true, state: 'on', count: body.data.features.length, reason: null, source: body.source ?? null })
    }
    const schedule = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => { void load() }, 320)
    }
    apply()
    schedule()
    map.on('moveend', schedule)
    map.on('styledata', apply)
    return () => {
      alive = false
      if (timer) window.clearTimeout(timer)
      ctl.abort?.abort()
      map.off('moveend', schedule)
      map.off('styledata', apply)
    }
  }, [map, mapEpoch, level, on, light])

  return on ? status : OFF(level)
}
