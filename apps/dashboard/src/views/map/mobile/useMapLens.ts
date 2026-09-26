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
import { normalize, rampExpression, type MapLens } from './map-lenses'

const SRC = 'nx-lens'
const L_FIELD = 'nx-lens-field'
const L_HEAT = 'nx-lens-heat'
const L_DOTS = 'nx-lens-dots'

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

const DENSITY_LENSES = new Set(['territory', 'execution'])

function beforeLayer(map: maplibregl.Map): string | undefined {
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
}

function styleFor(map: maplibregl.Map, lens: MapLens, fetchZoom?: number) {
  const ramp = lens.ramp ?? 'heat'
  const density = DENSITY_LENSES.has(lens.id) || Boolean(lens.ambient)
  const vis = (on: boolean) => (on ? 'visible' : 'none')
  try {
    map.setLayoutProperty(L_FIELD, 'visibility', vis(!density))
    map.setLayoutProperty(L_HEAT, 'visibility', vis(density))
    map.setLayoutProperty(L_DOTS, 'visibility', vis(!lens.areal && !lens.ambient))

    // Value field: big soft discs, colour by value.
    // Property cells: a disc a little larger than its grid cell, so neighbouring
    // cells melt into one continuous surface; it scales exactly with the camera
    // (base 2) until the next read re-grids.
    let radius: unknown
    if (lens.areal) {
      radius = ['interpolate', ['exponential', 1.6], ['zoom'], 3, 10, 5, 22, 7, 42, 9, 90, 11, 190, 13, 380]
    } else {
      const z = fetchZoom ?? map.getZoom()
      const g = lensGridForZoom(z)
      const r = g ? Math.max(6, degToPx(g, z, map.getCenter().lat) * 0.95) : 0
      radius = !g
        ? 0
        : z < 12.9
          ? ['interpolate', ['exponential', 2], ['zoom'], z - 3, r / 8, z, r, 12.95, r * Math.pow(2, 12.95 - z), 13, 0]
          : ['interpolate', ['linear'], ['zoom'], 12.95, r, 13, 0]
    }
    map.setPaintProperty(L_FIELD, 'circle-radius', radius as never)
    map.setPaintProperty(L_FIELD, 'circle-color', rampExpression(ramp, ['get', 't']) as never)
    map.setPaintProperty(L_FIELD, 'circle-blur', lens.areal ? 1 : 0.9)
    map.setPaintProperty(L_FIELD, 'circle-opacity', (lens.areal
      ? ['interpolate', ['linear'], ['zoom'], 3, 0.6, 10, 0.55, 13, 0.36]
      : ['interpolate', ['linear'], ['zoom'], 3, 0.78, 12.5, 0.72, 13, 0]) as never)
    map.setPaintProperty(L_FIELD, 'circle-pitch-alignment', 'map')

    // Density heatmap.
    map.setPaintProperty(L_HEAT, 'heatmap-weight', ['interpolate', ['linear'], ['get', 't'], 0, 0.05, 1, 1] as never)
    map.setPaintProperty(L_HEAT, 'heatmap-intensity', ['interpolate', ['linear'], ['zoom'], 3, 1.4, 9, 2, 14, 3] as never)
    map.setPaintProperty(L_HEAT, 'heatmap-radius', (lens.ambient
      ? ['interpolate', ['linear'], ['zoom'], 3, 42, 6, 56, 9, 64]
      : ['interpolate', ['linear'], ['zoom'], 3, 14, 7, 22, 10, 30, 13, 36, 16, 48]) as never)
    map.setPaintProperty(L_HEAT, 'heatmap-color', rampExpression(ramp, ['heatmap-density'], true) as never)
    map.setPaintProperty(L_HEAT, 'heatmap-opacity', (lens.ambient
      ? ['interpolate', ['linear'], ['zoom'], 3, 0.6, 8, 0.5, 9.5, 0]
      : ['interpolate', ['linear'], ['zoom'], 3, 0.85, 15, 0.7, 17, 0.35]) as never)

    // Street level: every property glows its own value — a soft coloured
    // aura under its marker, so the marker still reads and taps as normal.
    map.setPaintProperty(L_DOTS, 'circle-radius', ['interpolate', ['linear'], ['zoom'], 12.9, 0, 13, 10, 16, 20] as never)
    map.setPaintProperty(L_DOTS, 'circle-color', rampExpression(ramp, ['get', 't']) as never)
    map.setPaintProperty(L_DOTS, 'circle-blur', 0.55)
    map.setPaintProperty(L_DOTS, 'circle-opacity', ['interpolate', ['linear'], ['zoom'], 12.9, 0, 13.2, 0.85] as never)
    map.setPaintProperty(L_DOTS, 'circle-pitch-alignment', 'map')
  } catch { /* style mid-swap */ }
}

function hideAll(map: maplibregl.Map) {
  for (const id of [L_FIELD, L_HEAT, L_DOTS]) {
    try { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none') } catch { /* ignore */ }
  }
}

export function useMapLens(map: maplibregl.Map | null, epoch: number, lens: MapLens): LensState {
  const [state, setState] = useState<LensState>({ loading: false, error: null, count: 0, inView: null })
  const seq = useRef(0)
  const timer = useRef<number | null>(null)

  // Layers exist for the lifetime of the style; re-added after a style swap.
  useEffect(() => {
    if (!map) return
    const ensure = () => { try { ensureLayers(map); if (lens.source) styleFor(map, lens); else hideAll(map) } catch { /* ignore */ } }
    ensure()
    map.on('styledata', ensure)
    return () => { map.off('styledata', ensure) }
  }, [map, epoch, lens])

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
    if (!shouldUseSupabase()) {
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
        const t = lens.id === 'territory' || lens.ambient
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
        styleFor(map, lens, zoom)
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
  }, [map, epoch, lens])

  return state
}

/** Read the lens value under a screen point (for the tap-to-read callout). */
export function lensValueAt(map: maplibregl.Map, point: { x: number; y: number }): { v: number; n: number } | null {
  try {
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
