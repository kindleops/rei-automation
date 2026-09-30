/**
 * REAL BUILDINGS — extruded from the basemap's own building data.
 *
 * Heights come only from the source (`render_height` / `render_min_height`
 * of the CARTO/OpenMapTiles building layer). That schema falls back to 5 m
 * when a building has no height or levels, so an exact 5 m is treated as
 * UNKNOWN and drawn as a flat footprint — never an invented volume. Themes
 * without a vector building source (satellite, terrain imagery) simply have
 * no buildings: nothing is faked to fill the gap.
 *
 * Semantic zoom: nothing below z14, footprints rising into volumes between
 * z14 and z15.4, full height beyond. Only while the camera is tilted — flat
 * top-down views gain nothing from extrusion and pay for it.
 *
 * Selected property: its own structure (when the source has one under the
 * pin) gets a subtle accent, plus a soft ground halo — emphasis, not a tower.
 */
import { useEffect } from 'react'
import type maplibregl from 'maplibre-gl'
import { getMapVisualPreset } from '../map-visual-presets'
import { worldUnderlay } from './useWorldLight'

export const BUILDING_SOURCE = 'carto'
const LAYER = 'nx-world-bld'
const SEL_SRC = 'nx-world-sel'
const SEL_BLD = 'nx-world-sel-bld'
const SEL_HALO = 'nx-world-sel-halo'

const mix = (a: string, b: string, t: number) => {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return a
  const [x, y] = [p(a), p(b)]
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`
}

/** Height expression: exact 5 m is the schema default (unknown) → flat footprint. */
export const HEIGHT_EXPR = ['case', ['==', ['to-number', ['get', 'render_height'], 0], 5], 0.4, ['max', 0.4, ['to-number', ['get', 'render_height'], 0]]]
const BASE_EXPR = ['max', 0, ['to-number', ['get', 'render_min_height'], 0]]

export function buildingPaint(theme: string, night: boolean) {
  const p = getMapVisualPreset(theme)
  const base = /^#[0-9a-f]{6}$/i.test(p.basemap.building) ? p.basemap.building : '#1a2230'
  const lifted = p.basemap.isLight ? mix(base, '#ffffff', 0.25) : mix(base, '#9fb3d9', 0.14)
  // At night dense blocks read as faintly lit — warm, not neon.
  const color = night && !p.basemap.isLight ? mix(lifted, '#6b5236', 0.18) : lifted
  return {
    'fill-extrusion-color': color,
    'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.4, HEIGHT_EXPR],
    'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.4, BASE_EXPR],
    'fill-extrusion-opacity': p.basemap.isLight ? 0.78 : 0.86,
    'fill-extrusion-vertical-gradient': true,
  }
}

function remove(map: maplibregl.Map, ...ids: string[]) {
  for (const id of ids) { try { if (map.getLayer(id)) map.removeLayer(id) } catch { /* ignore */ } }
}

export function useBuildings3D(map: maplibregl.Map | null, epoch: number, opts: { enabled: boolean; tilted: boolean; theme: string; night: boolean; selected: [number, number] | null }) {
  const { enabled, tilted, theme, night, selected } = opts

  // Volumes.
  useEffect(() => {
    if (!map) return
    const apply = () => {
      if (!map.style) return
      try {
        const has = Boolean(map.getSource(BUILDING_SOURCE))
        if (!enabled || !has) { remove(map, LAYER); return }
        const paint = buildingPaint(theme, night)
        if (!map.getLayer(LAYER)) {
          map.addLayer({
            id: LAYER, type: 'fill-extrusion', source: BUILDING_SOURCE, 'source-layer': 'building', minzoom: 14,
            filter: ['!=', ['get', 'hide_3d'], true],
            layout: { visibility: tilted ? 'visible' : 'none' },
            paint,
            // Under the night tint so volumes darken with the city; labels and
            // every LeadCommand layer stay above both.
          } as never, map.getLayer('nx-world-light') ? 'nx-world-light' : worldUnderlay(map))
        } else {
          map.setLayoutProperty(LAYER, 'visibility', tilted ? 'visible' : 'none')
          map.setPaintProperty(LAYER, 'fill-extrusion-color', paint['fill-extrusion-color'])
          map.setPaintProperty(LAYER, 'fill-extrusion-opacity', paint['fill-extrusion-opacity'])
        }
      } catch { /* style mid-swap */ }
    }
    apply()
    // Re-add after a style swap; restore our paint if a foreign painter recoloured it.
    const onStyle = () => {
      if (!enabled || !map.getSource(BUILDING_SOURCE)) return
      if (!map.getLayer(LAYER)) { apply(); return }
      try {
        const want = buildingPaint(theme, night)
        if (map.getPaintProperty(LAYER, 'fill-extrusion-color') !== want['fill-extrusion-color'] || map.getPaintProperty(LAYER, 'fill-extrusion-opacity') !== want['fill-extrusion-opacity']) apply()
      } catch { /* ignore */ }
    }
    map.on('styledata', onStyle)
    return () => { map.off('styledata', onStyle) }
  }, [map, epoch, enabled, tilted, theme, night])

  // Selected structure + ground halo.
  useEffect(() => {
    if (!map) return
    const clear = () => {
      remove(map, SEL_BLD, SEL_HALO)
      try { if (map.getSource(SEL_SRC)) map.removeSource(SEL_SRC) } catch { /* ignore */ }
    }
    if (!enabled || !tilted || !selected) { clear(); return }
    const accent = getMapVisualPreset(theme).interface.accent
    const paintSelected = () => {
      if (!map.style) return
      try {
        const features: GeoJSON.Feature[] = [{ type: 'Feature', geometry: { type: 'Point', coordinates: selected }, properties: { kind: 'halo' } }]
        if (map.getLayer(LAYER) && map.getZoom() >= 15) {
          const hit = map.queryRenderedFeatures(map.project(selected), { layers: [LAYER] })[0]
          if (hit && (hit.geometry.type === 'Polygon' || hit.geometry.type === 'MultiPolygon')) {
            features.push({ type: 'Feature', geometry: hit.geometry, properties: { kind: 'bld', h: Number(hit.properties?.render_height) || 0, b: Number(hit.properties?.render_min_height) || 0 } })
          }
        }
        const data = { type: 'FeatureCollection', features } as GeoJSON.FeatureCollection
        const src = map.getSource(SEL_SRC) as maplibregl.GeoJSONSource | undefined
        if (src) src.setData(data as never)
        else map.addSource(SEL_SRC, { type: 'geojson', data: data as never })
        if (!map.getLayer(SEL_HALO)) {
          map.addLayer({
            id: SEL_HALO, type: 'circle', source: SEL_SRC, filter: ['==', ['get', 'kind'], 'halo'],
            paint: { 'circle-color': accent, 'circle-opacity': 0.16, 'circle-blur': 0.9, 'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 14, 14, 18, 90], 'circle-pitch-alignment': 'map' },
          } as never, worldUnderlay(map))
        }
        if (!map.getLayer(SEL_BLD)) {
          map.addLayer({
            id: SEL_BLD, type: 'fill-extrusion', source: SEL_SRC, filter: ['==', ['get', 'kind'], 'bld'],
            paint: {
              'fill-extrusion-color': accent,
              'fill-extrusion-opacity': 0.5,
              'fill-extrusion-height': ['case', ['==', ['get', 'h'], 5], 0.6, ['+', ['get', 'h'], 0.3]],
              'fill-extrusion-base': ['get', 'b'],
            },
          } as never, worldUnderlay(map))
        }
      } catch { /* ignore */ }
    }
    // After the camera settles the building under the pin is rendered and queryable.
    const once = () => paintSelected()
    paintSelected()
    map.once('idle', once)
    return () => { map.off('idle', once) }
  }, [map, epoch, enabled, tilted, theme, selected?.[0], selected?.[1]])

  useEffect(() => () => {
    if (!map) return
    remove(map, LAYER, SEL_BLD, SEL_HALO)
    try { if (map.getSource(SEL_SRC)) map.removeSource(SEL_SRC) } catch { /* ignore */ }
  }, [map])
}
