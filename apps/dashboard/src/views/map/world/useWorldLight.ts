/**
 * WORLD LIGHT — real day, golden hour, twilight and night, beneath the theme.
 *
 * Seven soft bands of "the sun is below X°" (solar.ts, deterministic) are
 * drawn as translucent fills UNDER the basemap labels and under every
 * LeadCommand layer, so intelligence always stays on top and legible. At
 * national zoom they read as a soft terminator crossing the country; zoomed
 * into one city the whole view sits inside (or outside) the bands, so the
 * city takes its own local light — New York can be dark while Los Angeles is
 * still in daylight, with no clock logic at all.
 *
 * The user's theme stays the identity: band strength is scaled per theme
 * (light basemaps darken more at night, dark themes barely deepen), and the
 * tilted sky + building light follow the real sun at the map centre.
 * Updates once a minute, and not at all while the page is hidden.
 *
 * [8.3] mode 'dynamic' (desktop "Dynamic (sun)") swaps only the DATA for
 * sun-dynamic.ts's night side + twilight falloff + day lift; same source, same
 * layers, so the minute tick is one setData and pins are never re-rendered.
 */
import { useEffect, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { darkRegion, LIGHT_BANDS, lightState, terminatorLine, type LightState } from './solar'
import { getMapVisualPreset } from '../map-visual-presets'
import { buildDynamicSun, type SunMode } from './sun-dynamic'
import { sunNow } from './sun-clock'

const SRC = 'nx-world-light'
const LAYER = 'nx-world-light'
const TICK_MS = 60_000
const LINE = 'nx-world-terminator'

/** Earliest of: the first basemap label, or the first LeadCommand layer. */
export function worldUnderlay(map: maplibregl.Map): string | undefined {
  const layers = map.getStyle()?.layers ?? []
  const ours = /^(command-|census-|buyer-demand-|sold-comps-|prop-|map-agg-|map-market|seller-pins-|nx-lens|nx-live|nx-area|nx-comp|nx-dots|nx-focus|nx-world-markets|nx-world-sel)/
  for (const l of layers) {
    if (l.id === LAYER || l.id === LINE || l.id.startsWith('nx-world-bld') || l.id.startsWith('nx-relief') || l.id.startsWith('nx-hybrid')) continue
    if (l.type === 'symbol' || ours.test(l.id)) return l.id
  }
  return undefined
}

function themeFactor(theme: string) {
  const p = getMapVisualPreset(theme)
  if (p.basemap.isLight) return { factor: 1.3, dusk: '#1d2c5e', night: '#0b1530' }
  if (p.basemap.family === 'satellite') return { factor: 1.05, dusk: '#121d3f', night: '#02040a' }
  if (p.basemap.family === 'terrain') return { factor: 1.15, dusk: '#1a2850', night: '#08101f' }
  return { factor: 0.8, dusk: '#101a3a', night: '#000000' }
}

const BAND_OPACITY = { golden: 0.028, dusk: 0.06, night: 0.075 } as const
const LINE_COLOR = '#ffb070'
const LINE_OPACITY = ['interpolate', ['linear'], ['zoom'], 2, 0.42, 5.5, 0.28, 7, 0]

export function buildLightBands(at: Date, theme: string): GeoJSON.FeatureCollection {
  const t = themeFactor(theme)
  return {
    type: 'FeatureCollection',
    features: [
      ...LIGHT_BANDS.map((b) => ({
        type: 'Feature' as const,
        geometry: darkRegion(at, b.altitude) as GeoJSON.Geometry,
        properties: { kind: 'band', role: b.role, o: Math.min(0.2, BAND_OPACITY[b.role] * t.factor), color: b.role === 'golden' ? '#ffa04d' : b.role === 'dusk' ? t.dusk : t.night },
      })),
      // The sunset line itself — a faint warm edge where the day is ending now.
      { type: 'Feature' as const, geometry: terminatorLine(at) as GeoJSON.Geometry, properties: { kind: 'line' } },
    ],
  }
}

const mix = (a: string, b: string, t: number) => {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [x, y] = [p(a), p(b)]
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`
}

/** Sky, horizon and fog for the light at the centre, blended into the theme. */
export function skyFor(ls: LightState, theme: string) {
  const p = getMapVisualPreset(theme)
  const base = /^#[0-9a-f]{6}$/i.test(p.basemap.background) ? p.basemap.background : '#05070b'
  const k = p.basemap.isLight ? 0.8 : 0.4
  const phase = ls.phase === 'day' ? { sky: p.basemap.isLight ? '#8fb8e8' : '#1f3558', horizon: p.basemap.isLight ? '#dbe9f7' : '#3a5580' }
    : ls.phase === 'golden' ? { sky: '#27335c', horizon: '#f2a25c' }
      : ls.phase === 'twilight' ? { sky: '#141c3d', horizon: '#3d3a6e' }
        : { sky: '#03050c', horizon: '#0b1328' }
  return {
    'sky-color': mix(base, phase.sky, k),
    'horizon-color': mix(base, phase.horizon, k),
    'fog-color': mix(base, phase.sky, k * 0.6),
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.7,
    'fog-ground-blend': 0.25,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 1, 12, 0],
  }
}

/** Directional light for building volumes, from the real sun (or a cool moon at night). */
export function lightFor(ls: LightState) {
  if (ls.altitude < -6) return { anchor: 'map' as const, position: [1.15, 200, 35] as [number, number, number], color: '#9fb3d9', intensity: 0.28 }
  const polar = Math.min(88, Math.max(12, 90 - ls.altitude))
  const color = ls.phase === 'golden' ? '#ffc38a' : '#fff4e3'
  return { anchor: 'map' as const, position: [1.15, ls.azimuth, polar] as [number, number, number], color, intensity: ls.phase === 'golden' ? 0.5 : 0.42 }
}

const DEFAULT_LIGHT = { anchor: 'viewport' as const, position: [1.15, 210, 30] as [number, number, number], color: '#ffffff', intensity: 0.5 }

/** [dev] Cost of the last minute tick (build + setData), for the frame-cost proof. */
type SunCost = { buildMs: number; setDataMs: number; features: number; vertices: number; mode: SunMode }

export function useWorldLight(map: maplibregl.Map | null, epoch: number, opts: { enabled: boolean; theme: string; tilted: boolean; reducedMotion: boolean; mode?: SunMode }) {
  const { enabled, theme, tilted, reducedMotion } = opts
  const mode: SunMode = opts.mode ?? 'ambient'
  const [center, setCenter] = useState<LightState | null>(null)
  const last = useRef<string>('')

  useEffect(() => {
    if (!map) return
    let cancelled = false
    const remove = () => {
      try { if (map.getLayer(LINE)) map.removeLayer(LINE) } catch { /* ignore */ }
      try { if (map.getLayer(LAYER)) map.removeLayer(LAYER) } catch { /* ignore */ }
      try { if (map.getSource(SRC)) map.removeSource(SRC) } catch { /* ignore */ }
    }
    if (!enabled) {
      remove()
      try { map.setLight(DEFAULT_LIGHT as never) } catch { /* ignore */ }
      setCenter(null)
      return
    }
    const readCenter = () => {
      const c = map.getCenter()
      const ls = lightState(sunNow(), c.lat, c.lng)
      setCenter((prev) => (prev && prev.phase === ls.phase && Math.abs(prev.altitude - ls.altitude) < 0.25 ? prev : ls))
      return ls
    }
    const apply = () => {
      if (cancelled || !map.style || document.visibilityState === 'hidden') return
      try {
        const now = sunNow()
        const t0 = performance.now()
        const data = mode === 'dynamic' ? buildDynamicSun(now, theme) : buildLightBands(now, theme)
        const t1 = performance.now()
        const src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined
        // Only this one source changes each minute: pins, labels and every other layer are untouched.
        if (src) src.setData(data as never)
        else map.addSource(SRC, { type: 'geojson', data: data as never, tolerance: 0.6 })
        if (import.meta.env.DEV) {
          const vertices = data.features.reduce((n, f) => n + JSON.stringify(f.geometry).split('],[').length, 0)
          ;(window as unknown as { __nxSunCost?: SunCost }).__nxSunCost = { buildMs: t1 - t0, setDataMs: performance.now() - t1, features: data.features.length, vertices, mode }
        }
        if (!map.getLayer(LAYER)) {
          map.addLayer({
            id: LAYER, type: 'fill', source: SRC, filter: ['==', ['get', 'kind'], 'band'],
            paint: {
              'fill-color': ['get', 'color'],
              'fill-opacity': ['get', 'o'],
              'fill-antialias': false,
              'fill-opacity-transition': { duration: reducedMotion ? 0 : 1600, delay: 0 },
            },
          } as never, worldUnderlay(map))
        }
        if (!map.getLayer(LINE)) {
          map.addLayer({
            id: LINE, type: 'line', source: SRC, filter: ['==', ['get', 'kind'], 'line'], maxzoom: 7,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
              'line-color': LINE_COLOR,
              'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.4, 6, 2.2],
              'line-blur': ['interpolate', ['linear'], ['zoom'], 2, 2.5, 6, 4],
              'line-opacity': LINE_OPACITY,
            },
          } as never, worldUnderlay(map))
        }
        const ls = readCenter()
        try { map.setLight(lightFor(ls) as never) } catch { /* old style */ }
        const setSky = (map as unknown as { setSky?: (s: unknown) => void }).setSky
        if (typeof setSky === 'function') {
          const key = `${tilted}|${ls.phase}|${Math.round(ls.altitude)}|${theme}`
          if (key !== last.current) { last.current = key; setSky.call(map, tilted ? skyFor(ls, theme) : {}) }
        }
      } catch { /* style mid-swap: styledata calls again */ }
    }
    // A style swap wipes the layers; a foreign painter may flatten the
    // data-driven paint into one opaque colour. Either way: put it back.
    const drifted = () => {
      try { return !Array.isArray(map.getPaintProperty(LAYER, 'fill-color')) || !Array.isArray(map.getPaintProperty(LAYER, 'fill-opacity')) } catch { return false }
    }
    const onStyle = () => {
      if (!map.getLayer(LAYER)) { apply(); return }
      if (drifted()) {
        try {
          map.setPaintProperty(LAYER, 'fill-color', ['get', 'color'])
          map.setPaintProperty(LAYER, 'fill-opacity', ['get', 'o'])
          if (map.getLayer(LINE)) { map.setPaintProperty(LINE, 'line-color', LINE_COLOR); map.setPaintProperty(LINE, 'line-opacity', LINE_OPACITY as never) }
        } catch { /* ignore */ }
      }
    }
    const onMove = () => {
      if (cancelled) return
      const ls = readCenter()
      const setSky = (map as unknown as { setSky?: (s: unknown) => void }).setSky
      if (tilted && typeof setSky === 'function') {
        const key = `${tilted}|${ls.phase}|${Math.round(ls.altitude)}|${theme}`
        if (key !== last.current) { last.current = key; try { setSky.call(map, skyFor(ls, theme)) } catch { /* ignore */ } }
      }
      try { map.setLight(lightFor(ls) as never) } catch { /* ignore */ }
    }
    last.current = ''
    apply()
    const tick = window.setInterval(apply, TICK_MS)
    const onVis = () => { if (document.visibilityState === 'visible') apply() }
    map.on('styledata', onStyle)
    map.on('moveend', onMove)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      window.clearInterval(tick)
      map.off('styledata', onStyle)
      map.off('moveend', onMove)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [map, epoch, enabled, theme, tilted, reducedMotion, mode])

  // Leaving (or turning the world off) restores the untouched map.
  useEffect(() => () => {
    if (!map) return
    try { if (map.getLayer(LINE)) map.removeLayer(LINE) } catch { /* ignore */ }
    try { if (map.getLayer(LAYER)) map.removeLayer(LAYER) } catch { /* ignore */ }
    try { if (map.getSource(SRC)) map.removeSource(SRC) } catch { /* ignore */ }
  }, [map])

  return center
}
