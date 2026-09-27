/**
 * Every property, at every zoom.
 *
 * Below pin zoom the map used to show only market count bubbles ("it only
 * shows the number"). With Every property on, each property is a glowing dot
 * (get_property_map_dot_tile: points merged per pixel, `n` = true count), the
 * count bubbles step aside, and from pin zoom the density thinning is lifted so
 * every property keeps a real pin. Dots cross-fade into the pins at handoff.
 */
import { useEffect } from 'react'
import type maplibregl from 'maplibre-gl'
import { buildPropertyTilesUrlTemplate } from '../map-property-tile-source'
import { FORCE_ALL_PIN_ZOOM, applyPropertyDensity, getDensitySelection, setForceAllProperties } from '../map-marker-density'
import { getGroupingHandoffZoom } from '../map-property-source'

const SRC = 'nx-dots'
const L_GLOW = 'nx-dots-glow'
const L_CORE = 'nx-dots-core'
const L_HIT = 'nx-dots-hit'
const AGG_LAYERS: Array<[string, string]> = [
  ['map-agg-cluster-halo', 'circle-opacity'],
  ['map-agg-cluster-core', 'circle-opacity'],
  ['map-agg-cluster-core', 'circle-stroke-opacity'],
  ['map-agg-cluster-ring', 'circle-stroke-opacity'],
  ['map-agg-cluster-icon', 'icon-opacity'],
  ['map-agg-cluster-count', 'text-opacity'],
]

/** Stage colour: hot → red, worked → green, untouched → cool glass blue. */
export const DOT_COLOR = [
  'case',
  ['>', ['get', 'hot'], 0], '#ff5a64',
  ['>', ['get', 'contacted'], 0], '#34e89e',
  '#7cc8ff',
] as const

function dotsUrl(): string {
  return buildPropertyTilesUrlTemplate().replace('{z}/{x}/{y}', '{z}/{x}/{y}?dots=1')
}

function beforeLayer(map: maplibregl.Map): string | undefined {
  for (const id of ['map-agg-cluster-halo', 'prop-tiles-hit', 'command-pin-cluster-glow']) if (map.getLayer(id)) return id
  return undefined
}

function ensure(map: maplibregl.Map, fadeFrom: number) {
  if (!map.style) return
  if (!map.getSource(SRC)) {
    map.addSource(SRC, { type: 'vector', tiles: [dotsUrl()], minzoom: 2, maxzoom: 11, attribution: '' })
  }
  const nRadius = (base: number, k: number) => ['+', base, ['*', k, ['ln', ['max', 1, ['get', 'n']]]]]
  const before = beforeLayer(map)
  if (!map.getLayer(L_GLOW)) {
    map.addLayer({
      id: L_GLOW, type: 'circle', source: SRC, 'source-layer': 'dots', maxzoom: fadeFrom + 1,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, nRadius(2.5, 1.2), 7, nRadius(5, 1.6), fadeFrom, nRadius(8, 2)] as never,
        'circle-color': DOT_COLOR as never,
        'circle-blur': 1,
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.32, fadeFrom - 0.4, 0.28, fadeFrom + 0.6, 0] as never,
        'circle-pitch-alignment': 'map',
      },
    }, before)
  }
  if (!map.getLayer(L_HIT)) {
    // A fat, invisible target: a dot is a few pixels, a finger is not.
    map.addLayer({
      id: L_HIT, type: 'circle', source: SRC, 'source-layer': 'dots', maxzoom: fadeFrom + 0.5,
      paint: { 'circle-radius': 14, 'circle-color': '#000', 'circle-opacity': 0.01 },
    }, before)
  }
  if (!map.getLayer(L_CORE)) {
    map.addLayer({
      id: L_CORE, type: 'circle', source: SRC, 'source-layer': 'dots', maxzoom: fadeFrom + 1,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, nRadius(0.9, 0.35), 7, nRadius(1.8, 0.5), fadeFrom, nRadius(3, 0.6)] as never,
        'circle-color': DOT_COLOR as never,
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.9, fadeFrom - 0.4, 0.95, fadeFrom + 0.6, 0] as never,
        'circle-stroke-color': 'rgba(255,255,255,0.55)',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 0, 8, 0.6] as never,
        'circle-pitch-alignment': 'map',
      },
    }, before)
  }
}

function setVisible(map: maplibregl.Map, on: boolean) {
  for (const id of [L_GLOW, L_CORE, L_HIT]) {
    try { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none') } catch { /* ignore */ }
  }
}

const ORIGINALS = new WeakMap<maplibregl.Map, Map<string, unknown>>()

/** Count bubbles step aside while dots are on (their own paint, restored when off). */
function quietAggregates(map: maplibregl.Map, quiet: boolean) {
  let orig = ORIGINALS.get(map)
  if (!orig) { orig = new Map(); ORIGINALS.set(map, orig) }
  for (const [layer, prop] of AGG_LAYERS) {
    try {
      if (!map.getLayer(layer)) continue
      const key = `${layer}:${prop}`
      const current = map.getPaintProperty(layer, prop as never)
      if (quiet) {
        if (current === 0) continue
        orig.set(key, current)
        map.setPaintProperty(layer, prop as never, 0 as never)
      } else if (orig.has(key)) {
        map.setPaintProperty(layer, prop as never, orig.get(key) as never)
        orig.delete(key)
      }
    } catch { /* style mid-swap */ }
  }
}

export type DotOpen = (hit: { propertyId: string; lng: number; lat: number; label: string }) => void

/** `quietBubbles`: count bubbles step aside (dots on, or a heat lens is showing). */
export function usePropertyDots(map: maplibregl.Map | null, epoch: number, on: boolean, quietBubbles: boolean = on, onOpen?: DotOpen, reducedMotion = false) {
  // Tap a dot → that property's preview; a dot that stands for several → fly in.
  useEffect(() => {
    if (!map || !on) return
    const onClick = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      if ((e as { _clickHandled?: boolean })._clickHandled) return
      const f = e.features?.[0]
      if (!f) return
      ;(e as { _clickHandled?: boolean })._clickHandled = true
      const g = f.geometry as { coordinates?: [number, number] }
      const [lng, lat] = g.coordinates ?? [e.lngLat.lng, e.lngLat.lat]
      const pid = f.properties?.property_id
      const n = Number(f.properties?.n) || 1
      if (pid && n === 1 && onOpen) {
        onOpen({ propertyId: String(pid), lng, lat, label: 'Property' })
        map.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 12.5), duration: reducedMotion ? 0 : 900 })
      } else {
        map.easeTo({ center: [lng, lat], zoom: Math.min(16, map.getZoom() + 2.5), duration: reducedMotion ? 0 : 800 })
      }
    }
    map.on('click', L_HIT, onClick)
    return () => { map.off('click', L_HIT, onClick) }
  }, [map, epoch, on, onOpen, reducedMotion])

  useEffect(() => {
    if (!map) return
    const fadeFrom = Math.max(getGroupingHandoffZoom(), FORCE_ALL_PIN_ZOOM)
    const apply = () => {
      try {
        ensure(map, fadeFrom)
        setVisible(map, on)
        quietAggregates(map, quietBubbles)
      } catch { /* style mid-swap */ }
    }
    apply()
    if (setForceAllProperties(on)) {
      try { applyPropertyDensity(map, getDensitySelection()) } catch { /* layers not ready */ }
    }
    map.on('styledata', apply)
    // The map re-writes aggregate paint on data refreshes; keep them quiet.
    const tick = quietBubbles ? window.setInterval(apply, 2000) : 0
    return () => {
      map.off('styledata', apply)
      if (tick) window.clearInterval(tick)
    }
  }, [map, epoch, on, quietBubbles])
}

/** Properties represented by the dots rendered in view (sum of per-pixel counts). */
export function dotsInView(map: maplibregl.Map): number | null {
  try {
    if (!map.getLayer(L_CORE) || map.getLayoutProperty(L_CORE, 'visibility') === 'none') return null
    if (map.getZoom() >= Math.max(getGroupingHandoffZoom(), FORCE_ALL_PIN_ZOOM)) return null
    const seen = new Set<string>()
    let total = 0
    for (const f of map.queryRenderedFeatures({ layers: [L_CORE] })) {
      const g = f.geometry as { coordinates?: [number, number] }
      const k = `${f.properties?.property_id ?? ''}:${g.coordinates?.[0]?.toFixed(5)}:${g.coordinates?.[1]?.toFixed(5)}`
      if (seen.has(k)) continue
      seen.add(k)
      total += Number(f.properties?.n) || 1
    }
    return total
  } catch {
    return null
  }
}
