import { describe, expect, it, vi } from 'vitest'
import type maplibregl from 'maplibre-gl'
import { CTX_IDS, CTX_LAYER_ORDER, OPERATIONAL_LAYER, cameraFeatures, crimeFeatures, ensureCameras, ensureCrime, ensurePresence, isMisplaced, overlayBefore } from './context-layers'
import { bindOverlayPointer } from './context-pointer'
import { CRIME_CAT_STYLE, CRIME_TYPES, GLYPH_PATHS, crimeGlyph, tileStyle } from './context-icons'
import type { CamerasReply, CrimeReply } from './context-model'

type L = { id: string; type: string; layout?: Record<string, unknown>; paint?: Record<string, unknown> }

/** A style stack that honours addLayer(before) / moveLayer exactly like MapLibre. */
function fakeMap(initial: L[]) {
  const layers: L[] = [...initial]
  const sources = new Map<string, unknown>()
  const images = new Set<string>()
  const insert = (l: L, before?: string) => {
    const at = before ? layers.findIndex((x) => x.id === before) : -1
    if (at < 0) layers.push(l)
    else layers.splice(at, 0, l)
  }
  const map = {
    style: {},
    getStyle: () => ({ layers }),
    getLayer: (id: string) => layers.find((l) => l.id === id),
    addLayer: (l: L, before?: string) => insert(l, before),
    moveLayer: (id: string, before?: string) => { const i = layers.findIndex((l) => l.id === id); const [l] = layers.splice(i, 1); insert(l, before) },
    removeLayer: (id: string) => { const i = layers.findIndex((l) => l.id === id); if (i >= 0) layers.splice(i, 1) },
    getSource: (id: string) => (sources.has(id) ? { setData: vi.fn() } : undefined),
    addSource: (id: string, s: unknown) => { sources.set(id, s) },
    removeSource: (id: string) => { sources.delete(id) },
    hasImage: (n: string) => images.has(n),
    addImage: (n: string) => { images.add(n) },
    setLayoutProperty: (id: string, k: string, v: unknown) => { const l = layers.find((x) => x.id === id); if (l) l.layout = { ...l.layout, [k]: v } },
    setPaintProperty: (id: string, k: string, v: unknown) => { const l = layers.find((x) => x.id === id); if (l) l.paint = { ...l.paint, [k]: v } },
  }
  return { map: map as unknown as maplibregl.Map, layers, sources }
}

// A realistic stack: basemap, its labels, the night tint, then operational pins on top.
const BASE: L[] = [
  { id: 'background', type: 'background' }, { id: 'water', type: 'fill' }, { id: 'roads', type: 'line' },
  { id: 'nx-lens-area-fill', type: 'fill' }, // an operational AREA low in the stack: never an anchor
  { id: 'place-labels', type: 'symbol' }, { id: 'nx-world-light', type: 'fill' },
  { id: 'prop-tiles-core', type: 'circle' }, { id: 'sold-comps-marker', type: 'symbol' },
  { id: 'command-pin-core-live', type: 'circle' }, { id: 'seller-pins-icon', type: 'symbol' },
]
const cams: CamerasReply = { ok: true, mode: 'points', cells: [], attributions: [], cameras: [
  { id: 'mn:1', name: 'A', road: null, direction: null, lat: 44.9, lng: -93.2, status: 'LIVE', feed: 'HLS', media: 'still', video: true, freshness: 'live', provider: 'MnDOT' },
  { id: 'tx:2', name: 'B', road: null, direction: null, lat: 32.8, lng: -96.8, status: 'OFFLINE', feed: 'REFRESHING_STILL', media: 'still', freshness: 'stale', provider: 'TxDOT' },
  { id: 'md:3', name: 'C', road: null, direction: null, lat: 39.3, lng: -76.6, status: 'LIVE', feed: 'PROVIDER_PAGE_ONLY', media: 'link', freshness: 'live', provider: 'CHART' },
] }
const crime: CrimeReply = { ok: true, mode: 'incidents', covered: true, window_days: 30, categories: [], sources: [], incidents: [
  { id: 'a', source_id: 's', category: 'Robbery', offense: null, family: 'person', type: 'robbery', cat: 'violent', occurred_on: '2026-10-01', occurred_at: null, lat: 44.9, lng: -93.2 },
  { id: 'b', source_id: 's', category: 'Theft', offense: null, family: 'property', type: 'theft', cat: 'property', occurred_on: '2026-10-01', occurred_at: null, lat: 44.91, lng: -93.21 },
] }

describe('z-order: operational layers stay above every context overlay', () => {
  it('overlays sit above the basemap labels and night tint, directly below the first operational PIN layer', () => {
    const { map, layers } = fakeMap(BASE)
    ensurePresence(map, { type: 'FeatureCollection', features: [] }, 'composite')
    ensureCrime(map, crimeFeatures(crime), false)
    ensureCameras(map, cameraFeatures(cams), false)
    const ids = layers.map((l) => l.id)
    const firstPin = ids.findIndex((id, i) => OPERATIONAL_LAYER.test(id) && ['symbol', 'circle'].includes(layers[i].type))
    for (const id of CTX_LAYER_ORDER) {
      const at = ids.indexOf(id)
      expect(at, id).toBeGreaterThan(ids.indexOf('place-labels'))
      expect(at, id).toBeGreaterThan(ids.indexOf('nx-world-light'))
      expect(at, id).toBeLessThan(firstPin)
    }
    // presence < crime < cameras
    expect(CTX_LAYER_ORDER.map((id) => ids.indexOf(id))).toEqual([...CTX_LAYER_ORDER.map((id) => ids.indexOf(id))].sort((a, b) => a - b))
    for (const op of ['prop-tiles-core', 'sold-comps-marker', 'command-pin-core-live', 'seller-pins-icon']) {
      for (const id of CTX_LAYER_ORDER) expect(ids.indexOf(op), `${op} above ${id}`).toBeGreaterThan(ids.indexOf(id))
    }
  })

  it('order holds whatever order the overlays are switched on in', () => {
    const { map, layers } = fakeMap(BASE)
    ensureCameras(map, cameraFeatures(cams), true)
    ensureCrime(map, crimeFeatures(crime), true)
    ensurePresence(map, { type: 'FeatureCollection', features: [] }, 'composite')
    const ids = layers.map((l) => l.id)
    expect(CTX_LAYER_ORDER.map((id) => ids.indexOf(id))).toEqual([...CTX_LAYER_ORDER.map((id) => ids.indexOf(id))].sort((a, b) => a - b))
  })

  it('a pin layer that lands under an overlay is detected and the overlay re-seated on the next ensure', () => {
    const { map, layers } = fakeMap([{ id: 'place-labels', type: 'symbol' }])
    ensureCameras(map, cameraFeatures(cams), false) // no operational layer yet → on top
    layers.splice(1, 0, { id: 'seller-pins-icon', type: 'symbol' }) // a pin re-added BELOW the overlay
    expect(isMisplaced(layers, CTX_IDS.camIcons)).toBe(true)
    ensureCameras(map, cameraFeatures(cams), false)
    const ids = layers.map((l) => l.id)
    expect(ids.indexOf(CTX_IDS.camIcons)).toBeLessThan(ids.indexOf('seller-pins-icon'))
    expect(overlayBefore(layers, CTX_IDS.camGroup)).toBe(CTX_IDS.camIcons)
  })
})

describe('dots are reserved for properties', () => {
  it('no context overlay layer is a circle; marks are glyph tiles that yield to pins', () => {
    const { map, layers } = fakeMap(BASE)
    ensurePresence(map, { type: 'FeatureCollection', features: [] }, 'composite')
    ensureCrime(map, crimeFeatures(crime), false)
    ensureCameras(map, cameraFeatures(cams), false)
    for (const l of layers.filter((x) => x.id.startsWith('mxd-ctx-'))) {
      expect(l.type, l.id).toBe('symbol')
      // collision: an overlay tile hides under an operational symbol, never pushes a pin or label out
      expect(l.layout?.['icon-ignore-placement'], l.id).toBe(true)
    }
    for (const id of [CTX_IDS.camIcons, CTX_IDS.camGroup, CTX_IDS.crimeIcons, CTX_IDS.crimeGroup]) expect(layers.find((l) => l.id === id)?.layout?.['icon-allow-overlap'], id).toBe(false)
  })

  it('features carry the glyph: live video / still / location-only cameras; a glyph per crime type', () => {
    expect(cameraFeatures(cams).features.map((f) => f.properties?.g)).toEqual(['cam-video', 'cam-still', 'cam-link'])
    expect(crimeFeatures(crime).features.map((f) => f.properties?.g)).toEqual(['crime-robbery', 'crime-theft'])
    for (const t of CRIME_TYPES) expect(GLYPH_PATHS[crimeGlyph(t)], t).toBeTruthy()
    expect(crimeGlyph('unknown-type')).toBe('crime-other')
  })

  it('clustered sources declutter at low zoom (cameras to z10, crime to z12)', () => {
    const { map, sources } = fakeMap(BASE)
    ensureCameras(map, cameraFeatures(cams), false)
    ensureCrime(map, crimeFeatures(crime), false)
    expect(sources.get(CTX_IDS.camSrc)).toMatchObject({ cluster: true, clusterMaxZoom: 10 })
    expect(sources.get(CTX_IDS.crimeSrc)).toMatchObject({ cluster: true, clusterMaxZoom: 12 })
  })

  it('no category colour is red (red means failure in every theme, Red Ops included)', () => {
    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min
      if (!d) return -1
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
      return (h * 60 + 360) % 360
    }
    for (const c of Object.values(CRIME_CAT_STYLE)) for (const v of [c.dark, c.light]) { const h = hue(v); expect(h === -1 || (h > 20 && h < 340), v).toBe(true) }
    for (const t of CRIME_TYPES) for (const g of ['d', 'l'] as const) { const h = hue(tileStyle(crimeGlyph(t), g).edge); expect(h === -1 || (h > 20 && h < 340), `${t}/${g}`).toBe(true) }
  })
})

describe('hover never costs a request', () => {
  it('hover only changes the cursor; a press picks; nothing is fetched by either', () => {
    const handlers = new Map<string, (e: unknown) => void>()
    const canvas = { style: { cursor: '' } }
    const map = { on: (ev: string, _l: string, h: (e: unknown) => void) => { handlers.set(ev, h) }, off: vi.fn(), getCanvas: () => canvas }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('no fetch on hover')))
    const onPick = vi.fn()
    const off = bindOverlayPointer(map as never, CTX_IDS.camIcons, onPick)
    for (let i = 0; i < 25; i += 1) { handlers.get('mouseenter')?.({}); handlers.get('mouseleave')?.({}) }
    handlers.get('mouseenter')?.({})
    expect(canvas.style.cursor).toBe('pointer')
    expect(onPick).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    handlers.get('click')?.({ features: [{ properties: { id: 'mn:1' } }] })
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    off()
    expect(map.off).toHaveBeenCalledTimes(3)
    fetchSpy.mockRestore()
  })
})
