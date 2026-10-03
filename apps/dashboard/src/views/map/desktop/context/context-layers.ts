/**
 * MapLibre drawing for the context overlays. Each overlay owns one GeoJSON
 * source and a couple of quiet layers, placed under the basemap's labels and
 * every property marker so a press on a pin still lands on the pin. A theme
 * swap drops custom sources; `ensure*` re-adds them from the last data.
 */
import type maplibregl from 'maplibre-gl'
import { CRIME_FAMILY, PRESENCE_COLORS, presenceFeatures, type CamerasReply, type CrimeReply, type PresenceReply, type PresenceView } from './context-model'

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
export const CTX_IDS = {
  camSrc: 'mxd-ctx-cam', camCells: 'mxd-ctx-cam-cells', camCellCount: 'mxd-ctx-cam-cellcount', camDots: 'mxd-ctx-cam-dots', camLive: 'mxd-ctx-cam-live', camHit: 'mxd-ctx-cam-hit',
  crimeSrc: 'mxd-ctx-crime', crimeDots: 'mxd-ctx-crime-dots',
  presSrc: 'mxd-ctx-pres', presEntity: 'mxd-ctx-pres-entity', presBuys: 'mxd-ctx-pres-buys',
} as const

/** Below the basemap's first label layer and every LeadCommand marker layer. */
export function beforeOwnLayers(map: maplibregl.Map): string | undefined {
  try {
    for (const l of map.getStyle().layers ?? []) {
      if (/^(nx-|prop-|command-|map-agg|inbox-|seller-|buyer-)/.test(l.id)) return l.id
      if (l.type === 'symbol' && !/^mxd-/.test(l.id)) return l.id
    }
  } catch { /* style mid-swap */ }
  return undefined
}

const setData = (map: maplibregl.Map, src: string, fc: GeoJSON.FeatureCollection) => {
  ;(map.getSource(src) as maplibregl.GeoJSONSource | undefined)?.setData(fc)
}
const drop = (map: maplibregl.Map, layers: string[], src: string) => {
  try {
    for (const id of layers) if (map.getLayer(id)) map.removeLayer(id)
    if (map.getSource(src)) map.removeSource(src)
  } catch { /* style mid-swap */ }
}

/* ── cameras ──────────────────────────────────────────────────────────────── */

export function cameraFeatures(r: CamerasReply | null): GeoJSON.FeatureCollection {
  if (!r) return EMPTY
  if (r.mode === 'coverage') {
    return { type: 'FeatureCollection', features: r.cells.map((c, i) => ({ type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { cell: 1, n: c.cameras } })) }
  }
  return {
    type: 'FeatureCollection',
    features: r.cameras.map((c, i) => ({
      type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      properties: { cell: 0, id: c.id, name: c.name ?? '', link: c.media === 'link' ? 1 : 0, off: c.status === 'OFFLINE' ? 1 : 0, live: c.video ? 1 : 0 },
    })),
  }
}

export function ensureCameras(map: maplibregl.Map, fc: GeoJSON.FeatureCollection, light: boolean) {
  if (!map.style) return
  const ink = light ? '#1d2533' : '#eef3fb'
  const halo = light ? 'rgba(255,255,255,0.9)' : 'rgba(6,9,16,0.85)'
  const accent = '#5cc8ff'
  if (!map.getSource(CTX_IDS.camSrc)) map.addSource(CTX_IDS.camSrc, { type: 'geojson', data: fc })
  else setData(map, CTX_IDS.camSrc, fc)
  const before = beforeOwnLayers(map)
  if (!map.getLayer(CTX_IDS.camCells)) {
    map.addLayer({
      id: CTX_IDS.camCells, type: 'circle', source: CTX_IDS.camSrc, filter: ['==', ['get', 'cell'], 1],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['sqrt', ['get', 'n']], 1, 6, 10, 14, 30, 22] as never,
        'circle-color': accent, 'circle-opacity': 0.16, 'circle-stroke-color': accent, 'circle-stroke-width': 1, 'circle-stroke-opacity': 0.55,
      },
    }, before)
  }
  if (!map.getLayer(CTX_IDS.camCellCount)) {
    map.addLayer({
      id: CTX_IDS.camCellCount, type: 'symbol', source: CTX_IDS.camSrc, filter: ['==', ['get', 'cell'], 1],
      layout: { 'text-field': ['to-string', ['get', 'n']] as never, 'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'], 'text-size': 10, 'text-allow-overlap': false },
      paint: { 'text-color': ink, 'text-halo-color': halo, 'text-halo-width': 1 },
    })
  }
  if (!map.getLayer(CTX_IDS.camDots)) {
    map.addLayer({
      id: CTX_IDS.camDots, type: 'circle', source: CTX_IDS.camSrc, filter: ['==', ['get', 'cell'], 0],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2.2, 12, 3.6, 15, 5] as never,
        // a still: a solid accent dot; location-only (link): a hollow ring; offline: dimmed
        'circle-color': ['case', ['==', ['get', 'link'], 1], 'rgba(0,0,0,0)', accent] as never,
        'circle-stroke-color': accent, 'circle-stroke-width': ['case', ['==', ['get', 'link'], 1], 1.4, 1] as never,
        'circle-opacity': ['case', ['==', ['get', 'off'], 1], 0.35, 0.9] as never,
        'circle-stroke-opacity': ['case', ['==', ['get', 'off'], 1], 0.35, 0.95] as never,
      },
    }, before)
  }
  // Live video: a quiet outer halo ring — the "live" badge, static (nothing pulses to look alive).
  if (!map.getLayer(CTX_IDS.camLive)) {
    map.addLayer({
      id: CTX_IDS.camLive, type: 'circle', source: CTX_IDS.camSrc, filter: ['all', ['==', ['get', 'cell'], 0], ['==', ['get', 'live'], 1]],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4.4, 12, 6.6, 15, 8.4] as never,
        'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#3ddc97', 'circle-stroke-width': 1.2, 'circle-stroke-opacity': 0.85,
      },
    }, before)
  }
  // A generous invisible target: small markers stay subtle but easy to press.
  if (!map.getLayer(CTX_IDS.camHit)) {
    map.addLayer({ id: CTX_IDS.camHit, type: 'circle', source: CTX_IDS.camSrc, filter: ['==', ['get', 'cell'], 0], paint: { 'circle-radius': 9, 'circle-color': '#000', 'circle-opacity': 0 } }, before)
  }
  map.setPaintProperty(CTX_IDS.camCellCount, 'text-color', ink)
  map.setPaintProperty(CTX_IDS.camCellCount, 'text-halo-color', halo)
}
export const removeCameras = (map: maplibregl.Map) => drop(map, [CTX_IDS.camHit, CTX_IDS.camLive, CTX_IDS.camDots, CTX_IDS.camCellCount, CTX_IDS.camCells], CTX_IDS.camSrc)

/* ── crime ────────────────────────────────────────────────────────────────── */

export function crimeFeatures(r: CrimeReply | null): GeoJSON.FeatureCollection {
  if (!r || r.mode !== 'incidents') return EMPTY
  return {
    type: 'FeatureCollection',
    features: r.incidents.map((c, i) => ({ type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { i, f: c.family } })),
  }
}

export function ensureCrime(map: maplibregl.Map, fc: GeoJSON.FeatureCollection, light: boolean) {
  if (!map.style) return
  if (!map.getSource(CTX_IDS.crimeSrc)) map.addSource(CTX_IDS.crimeSrc, { type: 'geojson', data: fc })
  else setData(map, CTX_IDS.crimeSrc, fc)
  if (!map.getLayer(CTX_IDS.crimeDots)) {
    const color: unknown[] = ['match', ['get', 'f']]
    for (const [k, v] of Object.entries(CRIME_FAMILY)) color.push(k, v.color)
    color.push(CRIME_FAMILY.other.color)
    map.addLayer({
      id: CTX_IDS.crimeDots, type: 'circle', source: CTX_IDS.crimeSrc,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2, 14, 3.4, 16, 4.6] as never,
        'circle-color': color as never,
        'circle-opacity': 0.72,
        'circle-stroke-color': light ? 'rgba(255,255,255,0.8)' : 'rgba(6,9,16,0.7)',
        'circle-stroke-width': 0.6,
      },
    }, beforeOwnLayers(map))
  }
  map.setPaintProperty(CTX_IDS.crimeDots, 'circle-stroke-color', light ? 'rgba(255,255,255,0.8)' : 'rgba(6,9,16,0.7)')
}
export const removeCrime = (map: maplibregl.Map) => drop(map, [CTX_IDS.crimeDots], CTX_IDS.crimeSrc)

/* ── investor presence ────────────────────────────────────────────────────── */

export function presenceData(r: PresenceReply | null): GeoJSON.FeatureCollection {
  return r && r.mode === 'cells' ? presenceFeatures(r.cells) : EMPTY
}

/** Pixel radius for a component at a zoom: the grid cell's own scale, sqrt by count. */
const radiusExpr = (prop: 'pr' | 'er', max: number) => ['interpolate', ['linear'], ['zoom'], 9.5, ['*', ['get', prop], max * 0.55], 12, ['*', ['get', prop], max], 15, ['*', ['get', prop], max * 1.5]] as never

export function ensurePresence(map: maplibregl.Map, fc: GeoJSON.FeatureCollection, view: PresenceView) {
  if (!map.style) return
  if (!map.getSource(CTX_IDS.presSrc)) map.addSource(CTX_IDS.presSrc, { type: 'geojson', data: fc })
  else setData(map, CTX_IDS.presSrc, fc)
  const before = beforeOwnLayers(map)
  if (!map.getLayer(CTX_IDS.presEntity)) {
    // Entity ownership: a ring (a current state), drawn under the purchases disc.
    map.addLayer({
      id: CTX_IDS.presEntity, type: 'circle', source: CTX_IDS.presSrc, filter: ['>', ['get', 'e'], 0],
      paint: {
        'circle-radius': radiusExpr('er', 15),
        'circle-color': PRESENCE_COLORS.entity, 'circle-opacity': 0.08,
        'circle-stroke-color': PRESENCE_COLORS.entity, 'circle-stroke-width': 1.6, 'circle-stroke-opacity': 0.85,
      },
    }, before)
  }
  if (!map.getLayer(CTX_IDS.presBuys)) {
    // Investor purchases: a filled disc (events in the window).
    map.addLayer({
      id: CTX_IDS.presBuys, type: 'circle', source: CTX_IDS.presSrc, filter: ['>', ['get', 'p'], 0],
      paint: { 'circle-radius': radiusExpr('pr', 11), 'circle-color': PRESENCE_COLORS.purchases, 'circle-opacity': 0.62, 'circle-stroke-color': 'rgba(6,9,16,0.6)', 'circle-stroke-width': 0.6 },
    }, before)
  }
  map.setLayoutProperty(CTX_IDS.presEntity, 'visibility', view === 'purchases' ? 'none' : 'visible')
  map.setLayoutProperty(CTX_IDS.presBuys, 'visibility', view === 'entity' ? 'none' : 'visible')
}
export const removePresence = (map: maplibregl.Map) => drop(map, [CTX_IDS.presBuys, CTX_IDS.presEntity], CTX_IDS.presSrc)
