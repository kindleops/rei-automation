import type maplibregl from 'maplibre-gl'
import type { PreviewCollection, PreviewMode, PreviewPaint } from './preview-model'

/**
 * The Campaign Preview layer — a DEDICATED source and its own layers over the
 * Map's normal points (never a repaint of them). One GeoJSON source; the
 * Audience view draws a halo + core dot per target (clustered above
 * CLUSTER_AT, with exact counts on the clusters), the Density view a native
 * heatmap of the same real points. Paint only depends on the accent and the
 * basemap's lightness, so day/night never redraws it; a style swap (theme)
 * re-adds it on the next map epoch.
 */

export const CP_SOURCE = 'lc-campaign-preview'
export const CP_LAYERS = {
  heat: 'lc-cp-heat',
  halo: 'lc-cp-halo',
  dot: 'lc-cp-dot',
  arrive: 'lc-cp-arrive',
  cluster: 'lc-cp-cluster',
  clusterCount: 'lc-cp-cluster-count',
} as const
export const CP_HIT_LAYERS = [CP_LAYERS.dot, CP_LAYERS.cluster] as const

const ALL = Object.values(CP_LAYERS)

type SourceState = { clustered: boolean }
const sourceState = new WeakMap<maplibregl.Map, SourceState>()

/** Remove every preview layer and the source (preview ended, pane closed). */
export function removePreviewLayer(map: maplibregl.Map) {
  try {
    for (const id of ALL) if (map.getLayer(id)) map.removeLayer(id)
    if (map.getSource(CP_SOURCE)) map.removeSource(CP_SOURCE)
  } catch { /* style mid-swap: nothing to remove */ }
  sourceState.delete(map)
}

/**
 * Ensure the source + layers exist for this mode and clustering, then set the
 * data. Re-creates the source only when clustering flips (a source option);
 * otherwise a data update is one setData — no layer churn, no map re-init.
 */
export function syncPreviewLayer(map: maplibregl.Map, data: PreviewCollection, opts: { clustered: boolean; mode: PreviewMode; paint: PreviewPaint }): boolean {
  try {
    if (!map.isStyleLoaded?.() && !map.getStyle?.()) return false
    const state = sourceState.get(map)
    const exists = Boolean(map.getSource(CP_SOURCE))
    if (exists && state && state.clustered !== opts.clustered) removePreviewLayer(map)
    if (!map.getSource(CP_SOURCE)) {
      map.addSource(CP_SOURCE, opts.clustered
        ? { type: 'geojson', data, cluster: true, clusterRadius: 44, clusterMaxZoom: 12, generateId: false }
        : { type: 'geojson', data })
      sourceState.set(map, { clustered: opts.clustered })
      addLayers(map, opts.clustered, opts.paint)
    } else {
      (map.getSource(CP_SOURCE) as maplibregl.GeoJSONSource).setData(data)
      if (!map.getLayer(CP_LAYERS.dot)) addLayers(map, opts.clustered, opts.paint)
    }
    setPreviewMode(map, opts.mode)
    return true
  } catch {
    return false
  }
}

const unclustered: maplibregl.FilterSpecification = ['!', ['has', 'point_count']]

/** The selected-property star (and its focus underlight) stay above the preview. */
const ABOVE_PREVIEW = ['lc-focus-underlight', 'lc-focus-halo', 'command-selected-star-layer']

function addLayers(map: maplibregl.Map, clustered: boolean, paint: PreviewPaint) {
  const before = ABOVE_PREVIEW.find((id) => map.getLayer(id))
  const add = (layer: maplibregl.LayerSpecification) => map.addLayer(layer, before)
  add({
    id: CP_LAYERS.heat,
    type: 'heatmap',
    source: CP_SOURCE,
    layout: { visibility: 'none' },
    paint: {
      'heatmap-weight': clustered ? ['case', ['has', 'point_count'], ['min', 40, ['/', ['get', 'point_count'], 4]], 1] : 1,
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 9, 1.1, 14, 1.6],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 3, 6, 9, 14, 14, 26],
      'heatmap-opacity': 0.78,
      'heatmap-color': heatRamp(paint),
    },
  })
  add({
    id: CP_LAYERS.halo,
    type: 'circle',
    source: CP_SOURCE,
    ...(clustered ? { filter: unclustered } : {}),
    paint: {
      'circle-color': paint.halo,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 4.2, 8, 6.5, 12, 10, 16, 17],
      'circle-blur': 0.85,
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.7, 10, 0.8, 15, 0.55],
      'circle-pitch-alignment': 'map',
    },
  })
  add({
    id: CP_LAYERS.dot,
    type: 'circle',
    source: CP_SOURCE,
    ...(clustered ? { filter: unclustered } : {}),
    paint: {
      'circle-color': paint.core,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2, 8, 3, 12, 4.4, 16, 6.8],
      'circle-stroke-color': paint.stroke,
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 10, 1, 15, 1.6],
      'circle-pitch-alignment': 'map',
    },
  })
  // the arrival ring: drawn only for the market just added, once (see pulseArrival)
  add({
    id: CP_LAYERS.arrive,
    type: 'circle',
    source: CP_SOURCE,
    filter: ['==', ['get', 'm'], -999],
    paint: {
      'circle-color': 'rgba(0,0,0,0)',
      'circle-radius': 4,
      'circle-stroke-color': paint.core,
      'circle-stroke-width': 1.1,
      'circle-stroke-opacity': 0,
      'circle-pitch-alignment': 'map',
    },
  })
  if (clustered) {
    add({
      id: CP_LAYERS.cluster,
      type: 'circle',
      source: CP_SOURCE,
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': paint.halo,
        'circle-opacity': 0.85,
        'circle-radius': ['interpolate', ['linear'], ['get', 'point_count'], 2, 7, 50, 10, 500, 14, 5000, 19],
        'circle-stroke-color': paint.core,
        'circle-stroke-width': 1,
        'circle-stroke-opacity': 0.75,
        'circle-pitch-alignment': 'map',
      },
    })
    add({
      id: CP_LAYERS.clusterCount,
      type: 'symbol',
      source: CP_SOURCE,
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': ['Open Sans Semibold'],
        'text-size': 10.5,
        'text-allow-overlap': true,
      },
      paint: { 'text-color': paint.core, 'text-halo-color': paint.stroke, 'text-halo-width': 1.2 },
    })
  }
}

function heatRamp(paint: PreviewPaint): maplibregl.ExpressionSpecification {
  return ['interpolate', ['linear'], ['heatmap-density'],
    0, 'rgba(0,0,0,0)',
    0.15, paint.halo,
    0.55, paint.core,
    1, paint.stroke === 'rgba(255, 255, 255, 0.95)' ? paint.core : '#ffffff',
  ] as maplibregl.ExpressionSpecification
}

/** Audience ↔ Density: visibility only (the data and source stay). */
export function setPreviewMode(map: maplibregl.Map, mode: PreviewMode) {
  const vis = (id: string, on: boolean) => { try { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none') } catch { /* ignore */ } }
  vis(CP_LAYERS.heat, mode === 'density')
  for (const id of [CP_LAYERS.halo, CP_LAYERS.dot, CP_LAYERS.arrive, CP_LAYERS.cluster, CP_LAYERS.clusterCount]) vis(id, mode === 'audience')
}

/** Accent / basemap change: paint only (never a data reload). */
export function repaintPreviewLayer(map: maplibregl.Map, paint: PreviewPaint) {
  const set = (id: string, prop: string, value: unknown) => { try { if (map.getLayer(id)) map.setPaintProperty(id, prop, value) } catch { /* ignore */ } }
  set(CP_LAYERS.halo, 'circle-color', paint.halo)
  set(CP_LAYERS.dot, 'circle-color', paint.core)
  set(CP_LAYERS.dot, 'circle-stroke-color', paint.stroke)
  set(CP_LAYERS.arrive, 'circle-stroke-color', paint.core)
  set(CP_LAYERS.cluster, 'circle-color', paint.halo)
  set(CP_LAYERS.cluster, 'circle-stroke-color', paint.core)
  set(CP_LAYERS.clusterCount, 'text-color', paint.core)
  set(CP_LAYERS.clusterCount, 'text-halo-color', paint.stroke)
  set(CP_LAYERS.heat, 'heatmap-color', heatRamp(paint))
}

/** The restrained arrival: one ring expands and fades on the added market's points. Never under reduced motion. */
export function pulseArrival(map: maplibregl.Map, marketIndex: number, reducedMotion: boolean) {
  if (reducedMotion || marketIndex < 0) return
  try {
    if (!map.getLayer(CP_LAYERS.arrive)) return
    map.setFilter(CP_LAYERS.arrive, ['all', ['!', ['has', 'point_count']], ['==', ['get', 'm'], marketIndex]] as maplibregl.FilterSpecification)
    map.setPaintProperty(CP_LAYERS.arrive, 'circle-radius-transition', { duration: 0, delay: 0 })
    map.setPaintProperty(CP_LAYERS.arrive, 'circle-stroke-opacity-transition', { duration: 0, delay: 0 })
    map.setPaintProperty(CP_LAYERS.arrive, 'circle-radius', 3)
    map.setPaintProperty(CP_LAYERS.arrive, 'circle-stroke-opacity', 0.8)
    requestAnimationFrame(() => {
      try {
        map.setPaintProperty(CP_LAYERS.arrive, 'circle-radius-transition', { duration: 900, delay: 0 })
        map.setPaintProperty(CP_LAYERS.arrive, 'circle-stroke-opacity-transition', { duration: 900, delay: 0 })
        map.setPaintProperty(CP_LAYERS.arrive, 'circle-radius', 14)
        map.setPaintProperty(CP_LAYERS.arrive, 'circle-stroke-opacity', 0)
      } catch { /* style swapped mid-beat */ }
    })
  } catch { /* style mid-swap */ }
}
