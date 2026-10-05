import { describe, expect, it } from 'vitest'
import { applyVisualPresetBasemapPaint } from './map-basemap-paint'
import { isOwnedMapLayer } from './map-layer-ownership'

describe('map layer ownership', () => {
  it('owns every LeadCommand layer family, including Living Map', () => {
    for (const id of ['nx-world-light', 'nx-world-terminator', 'nx-world-bld', 'nx-world-sel-bld', 'nx-lens-area-fill', 'nx-lens-area-line', 'nx-dots', 'nx-orbs-core', 'nx-mx-activity', 'nx-icm-hybrid-road', 'command-pin-glow-raw', 'prop-tiles-hit', 'seller-pins-core', 'map-agg-cluster-count', 'mxd-ctx-cam-icons', 'mxd-ctx-crime-group']) {
      expect(isOwnedMapLayer(id), id).toBe(true)
    }
  })
  it('leaves basemap layers and basemap add-ons to the basemap painter', () => {
    for (const id of ['building', 'building-top', 'road_pri_fill_noramp', 'water', 'landuse', 'place_city_dot_r2', 'nx-hybrid-roads', 'nx-hybrid-labels', 'nx-relief-hillshade', undefined, '']) {
      expect(isOwnedMapLayer(id as string), String(id)).toBe(false)
    }
  })
  it('the basemap painter never repaints an owned translucent layer', () => {
    const calls: Array<[string, string, unknown]> = []
    const layers = [
      { id: 'landuse', type: 'fill', paint: {} },
      { id: 'nx-world-light', type: 'fill', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'o'] } },
      { id: 'nx-world-terminator', type: 'line', paint: {} },
      { id: 'nx-world-bld', type: 'fill-extrusion', 'source-layer': 'building', paint: {} },
    ]
    const map = { getStyle: () => ({ layers }), setPaintProperty: (id: string, k: string, v: unknown) => { calls.push([id, k, v]) } }
    applyVisualPresetBasemapPaint(map as never, 'dark_ops', isOwnedMapLayer)
    expect(calls.some(([id]) => id === 'landuse')).toBe(true)
    expect(calls.filter(([id]) => id.startsWith('nx-world'))).toEqual([])
  })
})
