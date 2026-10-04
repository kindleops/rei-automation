/**
 * Draws the active intelligence lens on the map.
 *
 *   value lenses    soft, blurred value fields (colour = the stored value, so a
 *                   dense area never reads "hotter" just for being dense), then
 *                   one dot per property from street zoom
 *   density lenses  a true heatmap (Territory, Execution): brightness = count
 *
 * Data: get_map_lens_points for the current viewport, debounced on camera
 * stops, newest request wins. Layers sit under the property markers so a tap
 * still lands on a property.
 */
import { useEffect, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { getSupabaseClient } from '../../../lib/supabaseClient'
import { shouldUseSupabase } from '../../../lib/data/shared'
import { normalize, rampExpression, type LensStyle, type MapLens } from './map-lenses'
import { bindIntelAreaInteractions, fetchIntelAreas } from '../../../modules/market-intelligence/map/mi-map-lenses'

const SRC = 'nx-lens'
const L_FIELD = 'nx-lens-field'
const L_HEAT = 'nx-lens-heat'
const L_DOTS = 'nx-lens-dots'
const AREA_SRC = 'nx-lens-areas'
const L_AREA_FILL = 'nx-lens-area-fill'
const L_AREA_LINE = 'nx-lens-area-line'

export interface LensState {
  loading: boolean
  error: string | null
  count: number
  /** Value range actually in view (raw units, 5th–95th percentile). */
  inView: [number, number] | null
  /** Which lens this state describes (a lens switch never shows the old range). */
  lensId?: string
}

/** Grid the RPC aggregates to at this zoom (degrees; 0 = one point per property). */
export function lensGridForZoom(zoom: number): number {
  if (zoom >= 13) return 0
  if (zoom >= 11) return 0.004
  if (zoom >= 9) return 0.015
  if (zoom >= 7) return 0.06
  if (zoom >= 5) return 0.22
  return 0.6
}

/** Pixel size of `deg` degrees of longitude at `zoom` (512px world tiles). */
const degToPx = (deg: number, zoom: number, lat: number) =>
  (deg / 360) * 512 * Math.pow(2, zoom) * Math.max(0.35, Math.cos((lat * Math.PI) / 180) ** 0.5)

const isDensity = (lens: MapLens) => (Boolean(lens.density) || lens.id === 'territory') && lens.id !== 'execution'
const OWN_PREFIX = /^(nx-|prop-|command-|map-agg|inbox-|seller-|buyer-)/

/**
 * Heat sits UNDER the basemap's labels (place names, road names stay crisp on
 * top of the colour) and under every marker we draw.
 */
function beforeLayer(map: maplibregl.Map): string | undefined {
  try {
    for (const l of map.getStyle().layers ?? []) {
      if (l.type === 'symbol' && !OWN_PREFIX.test(l.id)) return l.id
    }
  } catch { /* style mid-swap */ }
  for (const id of ['prop-tiles-hit', 'prop-tiles-halo', 'command-pin-glow-raw', 'map-market-aggregates-glow']) {
    if (map.getLayer(id)) return id
  }
  return undefined
}

/** Last data drawn per map, so a style swap (which drops custom sources) restores it. */
const LAST_DATA = new WeakMap<maplibregl.Map, GeoJSON.FeatureCollection>()

function ensureLayers(map: maplibregl.Map) {
  if (!map.style) return
  if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: LAST_DATA.get(map) ?? { type: 'FeatureCollection', features: [] } })
  const before = beforeLayer(map)
  if (!map.getLayer(L_FIELD)) {
    map.addLayer({ id: L_FIELD, type: 'circle', source: SRC, layout: { visibility: 'none' }, paint: {} }, before)
  }
  if (!map.getLayer(L_HEAT)) {
    map.addLayer({ id: L_HEAT, type: 'heatmap', source: SRC, layout: { visibility: 'none' }, paint: {} }, before)
  }
  if (!map.getLayer(L_DOTS)) {
    map.addLayer({ id: L_DOTS, type: 'circle', source: SRC, layout: { visibility: 'none' }, paint: {} }, before)
  }
  if (!map.getSource(AREA_SRC)) map.addSource(AREA_SRC, { type: 'geojson', data: LAST_AREAS.get(map) ?? { type: 'FeatureCollection', features: [] } })
  if (!map.getLayer(L_AREA_FILL)) {
    map.addLayer({ id: L_AREA_FILL, type: 'fill', source: AREA_SRC, layout: { visibility: 'none' }, paint: { 'fill-opacity': 0.5 } }, before)
  }
  if (!map.getLayer(L_AREA_LINE)) {
    map.addLayer({ id: L_AREA_LINE, type: 'line', source: AREA_SRC, layout: { visibility: 'none', 'line-join': 'round' }, paint: { 'line-color': 'rgba(255,255,255,0.35)', 'line-width': 0.8 } }, before)
  }
}

const LAST_AREAS = new WeakMap<maplibregl.Map, GeoJSON.FeatureCollection>()

/** `opacity` (0.2–1, desktop Layers) scales every lens paint; absent = 1, exactly as before. */
export interface LensLook { style: LensStyle; blend: number; opacity?: number }
export const DEFAULT_LOOK: LensLook = { style: 'surface', blend: 0.7 }

function styleFor(map: maplibregl.Map, lens: MapLens, fetchZoom?: number, look: LensLook = DEFAULT_LOOK) {
  const ramp = lens.ramp ?? 'heat'
  const density = isDensity(lens) || Boolean(lens.ambient)
  const areas = look.style === 'areas' && !lens.ambient
  // 0 = crisp individual dots, 1 = one melted surface.
  const b = look.style === 'dots' ? 0 : Math.min(1, Math.max(0, look.blend))
  const o = typeof look.opacity === 'number' && Number.isFinite(look.opacity) ? Math.min(1, Math.max(0, look.opacity)) : 1
  const vis = (on: boolean) => (on ? 'visible' : 'none')
  try {
    // Execution Live: every send is its own marker, coloured by what happened
    // to it. As a density heat, ~600 sends a fortnight read as nothing at all.
    if (lens.id === 'execution' && !areas) {
      // Its own branch, never a restyle on top of the generic one: flipping
      // visibility/paint twice per styledata re-fired styledata forever and
      // the source never drew.
      map.setLayoutProperty(L_AREA_FILL, 'visibility', 'none')
      map.setLayoutProperty(L_AREA_LINE, 'visibility', 'none')
      map.setLayoutProperty(L_HEAT, 'visibility', 'none')
      map.setLayoutProperty(L_DOTS, 'visibility', 'none')
      map.setLayoutProperty(L_FIELD, 'visibility', 'visible')
      map.setPaintProperty(L_FIELD, 'circle-radius', ['interpolate', ['linear'], ['zoom'], 3, 3.5, 8, 5.5, 12, 7.5, 16, 11] as never)
      map.setPaintProperty(L_FIELD, 'circle-color', ['case',
        ['>=', ['get', 'v'], 1], '#34e89e',
        ['>=', ['get', 'v'], 0.6], '#22d3ee',
        ['>=', ['get', 'v'], 0.3], '#7aa2ff',
        '#ff5a64'] as never)
      map.setPaintProperty(L_FIELD, 'circle-blur', 0.12)
      map.setPaintProperty(L_FIELD, 'circle-opacity', 0.95 * o)
      map.setPaintProperty(L_FIELD, 'circle-stroke-width', ['interpolate', ['linear'], ['zoom'], 3, 0.6, 12, 1.4] as never)
      map.setPaintProperty(L_FIELD, 'circle-stroke-color', 'rgba(255,255,255,0.75)')
      map.setPaintProperty(L_FIELD, 'circle-pitch-alignment', 'map')
      return
    }
    map.setLayoutProperty(L_FIELD, 'visibility', vis(!density && !areas))
    map.setLayoutProperty(L_HEAT, 'visibility', vis(density && !areas))
    map.setLayoutProperty(L_DOTS, 'visibility', vis(!lens.areal && !lens.ambient && !areas))
    map.setLayoutProperty(L_AREA_FILL, 'visibility', vis(areas))
    map.setLayoutProperty(L_AREA_LINE, 'visibility', vis(areas))
    if (areas) {
      map.setPaintProperty(L_AREA_FILL, 'fill-color', rampExpression(ramp, ['get', 't']) as never)
      map.setPaintProperty(L_AREA_FILL, 'fill-opacity', ['interpolate', ['linear'], ['zoom'], 3, 0.5 * o, 10, 0.42 * o, 14, 0.28 * o] as never)
    }

    // Value field: big soft discs, colour by value.
    // Property cells: a disc a little larger than its grid cell, so neighbouring
    // cells melt into one continuous surface; it scales exactly with the camera
    // (base 2) until the next read re-grids.
    let radius: unknown
    const mult = 0.3 + b * 0.95
    if (lens.areal) {
      radius = ['interpolate', ['exponential', 1.6], ['zoom'], 3, 10 * mult, 5, 22 * mult, 7, 42 * mult, 9, 90 * mult, 11, 190 * mult, 13, 380 * mult]
    } else {
      const z = fetchZoom ?? map.getZoom()
      const g = lensGridForZoom(z)
      const r = g ? Math.max(4, degToPx(g, z, map.getCenter().lat) * (0.35 + b * 0.7)) : 0
      radius = !g
        ? 0
        : z < 12.9
          ? ['interpolate', ['exponential', 2], ['zoom'], z - 3, r / 8, z, r, 12.95, r * Math.pow(2, 12.95 - z), 13, 0]
          : ['interpolate', ['linear'], ['zoom'], 12.95, r, 13, 0]
    }
    map.setPaintProperty(L_FIELD, 'circle-radius', radius as never)
    map.setPaintProperty(L_FIELD, 'circle-color', rampExpression(ramp, ['get', 't']) as never)
    map.setPaintProperty(L_FIELD, 'circle-blur', 0.12 + b * (lens.areal ? 0.88 : 0.8))
    // Market fields stay translucent so the map (and its names) read through.
    map.setPaintProperty(L_FIELD, 'circle-opacity', (lens.areal
      ? ['interpolate', ['linear'], ['zoom'], 3, (0.5 + (1 - b) * 0.3) * o, 10, (0.42 + (1 - b) * 0.3) * o, 13, 0.3 * o]
      : ['interpolate', ['linear'], ['zoom'], 3, (0.72 + (1 - b) * 0.2) * o, 12.5, (0.68 + (1 - b) * 0.2) * o, 13, 0]) as never)
    map.setPaintProperty(L_FIELD, 'circle-stroke-width', b < 0.25 ? 0.6 : 0)
    map.setPaintProperty(L_FIELD, 'circle-stroke-color', 'rgba(255,255,255,0.35)')
    map.setPaintProperty(L_FIELD, 'circle-pitch-alignment', 'map')

    // Density heatmap.
    map.setPaintProperty(L_HEAT, 'heatmap-weight', ['interpolate', ['linear'], ['get', 't'], 0, 0.05, 1, 1] as never)
    map.setPaintProperty(L_HEAT, 'heatmap-intensity', ['interpolate', ['linear'], ['zoom'], 3, 1.4, 9, 2, 14, 3] as never)
    const hm = 0.45 + b * 0.85
    map.setPaintProperty(L_HEAT, 'heatmap-radius', (lens.ambient
      ? ['interpolate', ['linear'], ['zoom'], 3, 42, 6, 56, 9, 64]
      : ['interpolate', ['linear'], ['zoom'], 3, 14 * hm, 7, 22 * hm, 10, 30 * hm, 13, 36 * hm, 16, 48 * hm]) as never)
    map.setPaintProperty(L_HEAT, 'heatmap-color', rampExpression(ramp, ['heatmap-density'], true) as never)
    map.setPaintProperty(L_HEAT, 'heatmap-opacity', (lens.ambient
      ? ['interpolate', ['linear'], ['zoom'], 3, 0.6 * o, 8, 0.5 * o, 9.5, 0]
      : ['interpolate', ['linear'], ['zoom'], 3, 0.85 * o, 15, 0.7 * o, 17, 0.35 * o]) as never)

    // Street level: every property glows its own value — a soft coloured
    // aura under its marker, so the marker still reads and taps as normal.
    map.setPaintProperty(L_DOTS, 'circle-radius', ['interpolate', ['linear'], ['zoom'], 12.9, 0, 13, 10, 16, 20] as never)
    map.setPaintProperty(L_DOTS, 'circle-color', rampExpression(ramp, ['get', 't']) as never)
    map.setPaintProperty(L_DOTS, 'circle-blur', 0.55)
    map.setPaintProperty(L_DOTS, 'circle-opacity', ['interpolate', ['linear'], ['zoom'], 12.9, 0, 13.2, 0.85 * o] as never)
    map.setPaintProperty(L_DOTS, 'circle-pitch-alignment', 'map')

  } catch { /* style mid-swap */ }
}

function hideAll(map: maplibregl.Map) {
  for (const id of [L_FIELD, L_HEAT, L_DOTS, L_AREA_FILL, L_AREA_LINE]) {
    try { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none') } catch { /* ignore */ }
  }
}

const countLens = (lens: MapLens) => lens.id === 'territory' || lens.id === 'execution' || Boolean(lens.ambient) || lens.id === 'investor_buys' || lens.id === 'institutional_buys'

export function useMapLens(map: maplibregl.Map | null, epoch: number, lens: MapLens, look: LensLook = DEFAULT_LOOK): LensState {
  const [state, setState] = useState<LensState>({ loading: false, error: null, count: 0, inView: null })
  const seq = useRef(0)
  const timer = useRef<number | null>(null)
  // [desktop] Market Intelligence lenses are area lenses only (values per ZIP / state).
  const intel = lens.family === 'intel'
  const effLook: LensLook = intel ? { ...look, style: 'areas' } : look
  const lookRef = useRef(effLook)
  lookRef.current = effLook
  const areasMode = effLook.style === 'areas' && !lens.ambient

  // [desktop] MI areas: hover reads the honest one-line summary, click opens the Inspector in MI.
  useEffect(() => {
    if (!map || !intel) return undefined
    return bindIntelAreaInteractions(map, L_AREA_FILL)
  }, [map, epoch, intel])

  // Layers exist for the lifetime of the style; re-added after a style swap.
  // A look change (dots ↔ surface) restyles in place — no refetch.
  useEffect(() => {
    if (!map) return
    const ensure = () => { try { ensureLayers(map); if (lens.source) styleFor(map, lens, undefined, lookRef.current); else hideAll(map) } catch { /* ignore */ } }
    ensure()
    map.on('styledata', ensure)
    return () => { map.off('styledata', ensure) }
  }, [map, epoch, lens, effLook.style, look.blend, look.opacity])

  useEffect(() => {
    if (!map) return
    setState({ loading: Boolean(lens.source), error: null, count: 0, inView: null, lensId: lens.id })
    LAST_DATA.delete(map)
    if (!lens.source) {
      hideAll(map)
      LAST_DATA.delete(map)
      try { (map.getSource(SRC) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] }) } catch { /* ignore */ }
      setState({ loading: false, error: null, count: 0, inView: null, lensId: lens.id })
      return
    }
    if (!intel && !shouldUseSupabase()) {
      setState({ loading: false, error: 'Data unavailable', count: 0, inView: null, lensId: lens.id })
      return
    }
    const load = async () => {
      const id = ++seq.current
      const b = map.getBounds()
      const zoom = map.getZoom()
      // The ambient glow is gone by z9.5 — don't fetch what can't be seen.
      if (lens.ambient && zoom >= 10) {
        LAST_DATA.delete(map)
        try { (map.getSource(SRC) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] }) } catch { /* ignore */ }
        setState({ loading: false, error: null, count: 0, inView: null, lensId: lens.id })
        return
      }
      // A little beyond the edges so a pan doesn't reveal an empty border.
      const padLat = (b.getNorth() - b.getSouth()) * 0.15
      const padLng = (b.getEast() - b.getWest()) * 0.15
      setState((s) => ({ ...s, loading: true, error: null }))
      if (areasMode && intel) {
        const res = await fetchIntelAreas(lens, { west: b.getWest() - padLng, south: b.getSouth() - padLat, east: b.getEast() + padLng, north: b.getNorth() + padLat }, zoom)
        if (id !== seq.current) return
        if (!res.ok) { setState({ loading: false, error: res.error || 'Layer unavailable', count: 0, inView: null, lensId: lens.id }); return }
        const features = res.rows.map((r) => ({ type: 'Feature' as const, geometry: r.outline, properties: { v: r.v, t: r.t, n: r.n, key: r.key, id: r.id, tip: r.tip } }))
        const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features }
        try {
          ensureLayers(map)
          styleFor(map, lens, zoom, lookRef.current)
          LAST_AREAS.set(map, fc)
          ;(map.getSource(AREA_SRC) as maplibregl.GeoJSONSource | undefined)?.setData(fc)
        } catch { /* style mid-swap */ }
        const values = res.rows.map((r) => r.v).sort((x, y) => x - y)
        const qa = (p: number) => values[Math.min(values.length - 1, Math.max(0, Math.round(p * (values.length - 1))))]
        setState({ loading: false, error: res.rows.length ? null : res.note, count: features.length, inView: values.length ? [qa(0.05), qa(0.95)] : null, lensId: lens.id })
        return
      }
      if (areasMode) {
        const { data, error } = await getSupabaseClient().rpc('get_map_lens_areas', {
          p_lens: lens.source,
          p_min_lat: b.getSouth() - padLat, p_min_lng: b.getWest() - padLng,
          p_max_lat: b.getNorth() + padLat, p_max_lng: b.getEast() + padLng,
          p_zoom: zoom,
        })
        if (id !== seq.current) return
        if (error || !Array.isArray(data)) { setState({ loading: false, error: 'Layer unavailable', count: 0, inView: null, lensId: lens.id }); return }
        const rowsIn = (data as Array<{ key: string; v: number | null; n: number; outline: GeoJSON.Geometry | null }>).filter((r) => r.outline && r.v != null && Number.isFinite(Number(r.v)))
        const maxV = rowsIn.reduce((m, r) => Math.max(m, Number(r.v)), 1)
        const values: number[] = []
        const features = rowsIn.map((r) => {
          const v = Number(r.v)
          values.push(v)
          const t = countLens(lens) ? Math.min(1, Math.log10(v + 1) / Math.log10(maxV + 1)) : normalize(lens, v)
          return { type: 'Feature' as const, geometry: r.outline as GeoJSON.Geometry, properties: { v, t, n: Number(r.n) || 1, key: r.key } }
        })
        const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features }
        try {
          ensureLayers(map)
          styleFor(map, lens, zoom, lookRef.current)
          LAST_AREAS.set(map, fc)
          ;(map.getSource(AREA_SRC) as maplibregl.GeoJSONSource | undefined)?.setData(fc)
        } catch { /* style mid-swap */ }
        values.sort((x, y) => x - y)
        const qa = (p: number) => values[Math.min(values.length - 1, Math.max(0, Math.round(p * (values.length - 1))))]
        setState({ loading: false, error: null, count: features.length, inView: values.length && !countLens(lens) ? [qa(0.05), qa(0.95)] : null, lensId: lens.id })
        return
      }
      const { data, error } = await getSupabaseClient().rpc('get_map_lens_points', {
        p_lens: lens.source,
        p_min_lat: b.getSouth() - padLat,
        p_min_lng: b.getWest() - padLng,
        p_max_lat: b.getNorth() + padLat,
        p_max_lng: b.getEast() + padLng,
        p_zoom: zoom,
      })
      if (id !== seq.current) return
      if (error || !Array.isArray(data)) {
        setState({ loading: false, error: 'Layer unavailable', count: 0, inView: null, lensId: lens.id })
        return
      }
      const values: number[] = []
      const maxN = data.reduce((m: number, r: { n?: number }) => Math.max(m, Number(r.n) || 1), 1)
      const features = []
      for (const r of data as Array<{ lat: number; lng: number; v: number; n: number; id: string | null }>) {
        const v = Number(r.v)
        if (!Number.isFinite(v) || !Number.isFinite(r.lat) || !Number.isFinite(r.lng)) continue
        if ((lens.id === 'comps_price' || lens.id === 'comps_ppsf' || lens.id === 'value') && v <= 0) continue
        values.push(v)
        const t = countLens(lens)
          ? Math.min(1, Math.log10((Number(r.n) || 1) + 1) / Math.log10(maxN + 1))
          : normalize(lens, v)
        features.push({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [r.lng, r.lat] },
          properties: { v, t, n: Number(r.n) || 1, id: r.id ?? null },
        })
      }
      try {
        ensureLayers(map)
        styleFor(map, lens, zoom, lookRef.current)
        const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features }
        LAST_DATA.set(map, fc)
        ;(map.getSource(SRC) as maplibregl.GeoJSONSource | undefined)?.setData(fc)
      } catch { /* style mid-swap */ }
      values.sort((a, b) => a - b)
      const q = (p: number) => values[Math.min(values.length - 1, Math.max(0, Math.round(p * (values.length - 1))))]
      setState({ loading: false, error: null, count: features.length, inView: values.length ? [q(0.05), q(0.95)] : null, lensId: lens.id })
    }
    const schedule = () => {
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => { void load() }, 260)
    }
    schedule()
    map.on('moveend', schedule)
    return () => {
      map.off('moveend', schedule)
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [map, epoch, lens, areasMode, intel])

  return state
}

/** Read the lens value under a screen point (for the tap-to-read callout). */
export function lensValueAt(map: maplibregl.Map, point: { x: number; y: number }): { v: number; n: number } | null {
  try {
    if (map.getLayer(L_AREA_FILL) && map.getLayoutProperty(L_AREA_FILL, 'visibility') !== 'none') {
      const area = map.queryRenderedFeatures([point.x, point.y], { layers: [L_AREA_FILL] })[0]
      const v = Number((area?.properties as Record<string, unknown> | undefined)?.v)
      return area && Number.isFinite(v) ? { v, n: Number((area.properties as Record<string, unknown>)?.n) || 1 } : null
    }
    const layers = [L_DOTS, L_FIELD, L_HEAT].filter((l) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none')
    if (!layers.length) return null
    const box: [[number, number], [number, number]] = [[point.x - 14, point.y - 14], [point.x + 14, point.y + 14]]
    const feats = map.queryRenderedFeatures(box, { layers })
    if (!feats.length) return null
    // nearest feature to the tap
    let best: { v: number; n: number; d: number } | null = null
    for (const f of feats) {
      const g = f.geometry as { type: string; coordinates: [number, number] }
      if (g.type !== 'Point') continue
      const p = map.project(g.coordinates)
      const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2
      const v = Number((f.properties as Record<string, unknown>)?.v)
      if (!Number.isFinite(v)) continue
      if (!best || d < best.d) best = { v, n: Number((f.properties as Record<string, unknown>)?.n) || 1, d }
    }
    return best ? { v: best.v, n: best.n } : null
  } catch {
    return null
  }
}
