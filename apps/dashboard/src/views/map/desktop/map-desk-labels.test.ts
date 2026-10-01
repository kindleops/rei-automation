import { describe, expect, it } from 'vitest'
import { applyDeskLabelTone, LABEL_TONES, labelGround, labelKind, restoreDeskLabelTone, scaleTextSize, type LabelToneMap, type ToneMemo } from './map-desk-labels'

type L = { id: string; type: string; sourceLayer?: string; layout?: Record<string, unknown>; paint?: Record<string, unknown> }

/** A style held in memory, read and written through the same surface MapLibre offers. */
function fakeMap(layers: L[]) {
  const byId = new Map(layers.map((l) => [l.id, { ...l, layout: { ...(l.layout ?? {}) }, paint: { ...(l.paint ?? {}) } }]))
  const clone = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
  let writes = 0
  const map: LabelToneMap = {
    getLayersOrder: () => [...byId.keys()],
    getLayer: (id) => byId.get(id),
    getLayoutProperty: (id, n) => clone(byId.get(id)!.layout[n]),
    getPaintProperty: (id, n) => clone(byId.get(id)!.paint[n]),
    setLayoutProperty: (id, n, v) => { writes += 1; byId.get(id)!.layout[n] = clone(v) },
    setPaintProperty: (id, n, v) => { writes += 1; byId.get(id)!.paint[n] = clone(v) },
  }
  return { map, layer: (id: string) => byId.get(id)!, writes: () => writes }
}

const MEDIUM = ['Montserrat Medium', 'Open Sans Bold', 'Noto Sans Regular']
const REGULAR = ['Montserrat Regular', 'Open Sans Regular', 'Noto Sans Regular']
const carto = (): L[] => [
  { id: 'place_city_r5', type: 'symbol', sourceLayer: 'place', layout: { 'text-field': '{name}', 'text-font': MEDIUM, 'text-size': { stops: [[8, 14], [14, 22]] }, 'text-transform': 'uppercase' }, paint: { 'text-color': '#DCEAFF', 'text-halo-width': 1 } },
  { id: 'place_town', type: 'symbol', sourceLayer: 'place', layout: { 'text-field': '{name}', 'text-font': MEDIUM, 'text-size': 12 }, paint: { 'text-color': '#DCEAFF', 'text-halo-width': 1 } },
  { id: 'roadname_major', type: 'symbol', sourceLayer: 'transportation_name', layout: { 'text-field': '{name}', 'text-font': REGULAR, 'text-size': 10 }, paint: { 'text-color': '#DCEAFF', 'text-halo-width': 1 } },
  { id: 'housenumber', type: 'symbol', sourceLayer: 'housenumber', layout: { 'text-field': '{housenumber}', 'text-size': 9 } },
  { id: 'road_pri', type: 'line', sourceLayer: 'transportation' },
  // LeadCommand's own labels are never the basemap's
  { id: 'prop-tiles-label', type: 'symbol', layout: { 'text-field': '{n}', 'text-size': 11 }, paint: { 'text-halo-width': 1 } },
  { id: 'command-pin-cluster-count', type: 'symbol', layout: { 'text-field': '{c}', 'text-size': 12 } },
]

describe('basemap label kinds', () => {
  it('reads CARTO ids and generic tokens', () => {
    expect(labelKind('place_city_r5', 'place')).toBe('city')
    expect(labelKind('place_capital_dot_z7', 'place')).toBe('city')
    expect(labelKind('place_town', 'place')).toBe('town')
    expect(labelKind('place_villages', 'place')).toBe('minor')
    expect(labelKind('place_suburbs', 'place')).toBe('minor')
    expect(labelKind('place_state', 'place')).toBe('region')
    expect(labelKind('place_country_1', 'place')).toBe('region')
    expect(labelKind('roadname_sec', 'transportation_name')).toBe('road')
    expect(labelKind('watername_lake', 'water_name')).toBe('water')
    expect(labelKind('waterway_label', 'waterway')).toBe('water')
    expect(labelKind('poi_park', 'poi')).toBe('poi')
    expect(labelKind('housenumber', 'housenumber')).toBeNull()
    // the satellite theme's roads & places are clones of the dark style's labels
    expect(labelKind('nx-icm-hybrid-place_town', 'place')).toBe('town')
  })
  it('knows each theme’s ground; a raster theme has no vector labels', () => {
    expect(labelGround('dark_ops')).toBe('dark')
    expect(labelGround('red_ops')).toBe('dark')
    expect(labelGround('light_street')).toBe('light')
    expect(labelGround('satellite')).toBe('imagery')
    expect(labelGround('terrain')).toBeNull()
  })
})

describe('text-size scaling', () => {
  it('scales numbers, legacy stops and zoom curves; leaves other expressions alone', () => {
    expect(scaleTextSize(12, 0.9)).toBe(10.8)
    expect(scaleTextSize({ stops: [[8, 14], [14, 22]] }, 0.5)).toEqual({ stops: [[8, 7], [14, 11]] })
    expect(scaleTextSize(['interpolate', ['linear'], ['zoom'], 8, 10, 14, 20], 0.5)).toEqual(['interpolate', ['linear'], ['zoom'], 8, 5, 14, 10])
    expect(scaleTextSize(['step', ['zoom'], 10, 12, 14], 0.5)).toEqual(['step', ['zoom'], 5, 12, 7])
    expect(scaleTextSize(['interpolate', ['linear'], ['zoom'], 8, ['get', 's'], 14, 20], 0.5)).toEqual(['interpolate', ['linear'], ['zoom'], 8, ['*', 0.5, ['get', 's']], 14, 10])
    const other = ['coalesce', ['get', 'size'], 12]
    expect(scaleTextSize(other, 0.5)).toBe(other)
    expect(scaleTextSize(12, 1)).toBe(12)
  })
})

describe('desk label tone', () => {
  it('quiets the basemap labels, never a LeadCommand layer, never a colour', () => {
    const f = fakeMap(carto())
    const memo: ToneMemo = new Map()
    expect(applyDeskLabelTone(f.map, 'dark', memo)).toBeGreaterThan(0)
    const t = LABEL_TONES.dark
    const city = f.layer('place_city_r5')
    expect(city.layout['text-size']).toEqual({ stops: [[8, 12.04], [14, 18.92]] })
    expect(city.layout['text-letter-spacing']).toBe(t.city.tracking)
    expect(city.layout['text-font']).toEqual(MEDIUM) // cities keep their weight
    expect(city.paint['text-opacity']).toBe(t.city.opacity)
    expect(city.paint['text-halo-width']).toBe(t.city.haloWidth)
    expect(city.paint['text-color']).toBe('#DCEAFF')
    const town = f.layer('place_town')
    expect(town.layout['text-font']).toEqual(REGULAR) // the style's own Regular stack
    expect(town.layout['text-letter-spacing']).toBeUndefined() // not set in capitals
    expect(f.layer('roadname_major').paint['text-opacity']).toBe(t.road.opacity)
    expect(f.layer('housenumber').paint['text-opacity']).toBeUndefined()
    expect(f.layer('prop-tiles-label').paint['text-opacity']).toBeUndefined()
    expect(f.layer('prop-tiles-label').layout['text-size']).toBe(11)
    expect(f.layer('command-pin-cluster-count').layout['text-size']).toBe(12)
  })
  it('is idempotent, and re-asserts only what someone else changed — without compounding', () => {
    const f = fakeMap(carto())
    const memo: ToneMemo = new Map()
    applyDeskLabelTone(f.map, 'dark', memo)
    const before = f.writes()
    expect(applyDeskLabelTone(f.map, 'dark', memo)).toBe(0)
    expect(f.writes()).toBe(before)
    // the shared painter re-colours on a theme pass and resets the halo
    f.map.setPaintProperty('place_town', 'text-halo-width', 1)
    expect(applyDeskLabelTone(f.map, 'dark', memo)).toBe(1)
    expect(f.layer('place_town').paint['text-halo-width']).toBe(LABEL_TONES.dark.town.haloWidth)
    expect(f.layer('place_town').layout['text-size']).toBe(10.8) // 12 × 0.9, once
  })
  it('a new base value (a style swap) is toned from scratch', () => {
    const f = fakeMap(carto())
    const memo: ToneMemo = new Map()
    applyDeskLabelTone(f.map, 'dark', memo)
    f.map.setLayoutProperty('place_town', 'text-size', 20)
    f.map.setPaintProperty('place_town', 'text-opacity', undefined)
    applyDeskLabelTone(f.map, 'light', memo)
    expect(f.layer('place_town').layout['text-size']).toBe(18)
    expect(f.layer('place_town').paint['text-opacity']).toBe(LABEL_TONES.light.town.opacity)
  })
  it('restores the style’s own values', () => {
    const f = fakeMap(carto())
    const memo: ToneMemo = new Map()
    applyDeskLabelTone(f.map, 'dark', memo)
    restoreDeskLabelTone(f.map, memo)
    const city = f.layer('place_city_r5')
    expect(city.layout['text-size']).toEqual({ stops: [[8, 14], [14, 22]] })
    expect(city.layout['text-letter-spacing']).toBeUndefined()
    expect(city.paint['text-opacity']).toBeUndefined()
    expect(city.paint['text-halo-width']).toBe(1)
    expect(f.layer('place_town').layout['text-font']).toEqual(MEDIUM)
    expect(memo.size).toBe(0)
  })
})
