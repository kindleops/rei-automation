/**
 * MAP DESK · BASEMAP LABELS — places read as context, not headlines.
 *
 * The shared basemap painter (map-basemap-paint) colours every place and road
 * label with the preset's labelPrimary on a 1px halo; on a desk that reads as
 * white headlines over the data. On the desk only, this tones the BASEMAP's own
 * label layers per kind (city, town, minor place, region, road, water, poi) and
 * per ground (dark vector, light vector, imagery overlay): opacity, a thinner and
 * softer halo, a slightly smaller size, the style's own Regular stack instead of
 * Medium for towns and minor places, and tracked capitals where the style already
 * sets capitals.
 *
 * It never touches a LeadCommand layer (pins, lenses, comps, live activity),
 * never changes a label's colour (the theme owns colour) and never hides one.
 * Layers are enumerated with getLayersOrder()/getLayer() — never getStyle(),
 * which serialises the whole style. Every write is drift-checked: a value is
 * re-derived only when someone else (a theme swap, the painter) changed it, so
 * the tone's own writes cannot loop; and the style's own values come back when
 * the desk chrome unmounts.
 */
import { useEffect } from 'react'
import type maplibregl from 'maplibre-gl'
import { isOwnedMapLayer } from '../map-layer-ownership'
import { getMapVisualPreset } from '../map-visual-presets'

export type LabelKind = 'city' | 'town' | 'minor' | 'region' | 'road' | 'water' | 'poi' | 'other'
export type LabelGround = 'dark' | 'light' | 'imagery'

export interface LabelTone {
  /** Multiplies a numeric text-opacity (or sets it when the style has none). */
  opacity: number
  haloWidth: number
  haloBlur: number
  /** Scales text-size (numbers, legacy stops, interpolate/step outputs). */
  size: number
  /** Swap a "<Family> Medium" stack for the style's own "<Family> Regular" stack. */
  regular?: boolean
  /** Letter-spacing (em) for labels the style already sets in capitals. */
  tracking?: number
}

type ToneRow = Record<LabelKind, LabelTone>

/** Dark grounds barely need a halo; light grounds keep a soft white one; imagery keeps contrast. */
export const LABEL_TONES: Record<LabelGround, ToneRow> = {
  dark: {
    city: { opacity: 0.8, haloWidth: 1, haloBlur: 0.5, size: 0.86, tracking: 0.08 },
    town: { opacity: 0.7, haloWidth: 0.9, haloBlur: 0.5, size: 0.9, regular: true },
    minor: { opacity: 0.56, haloWidth: 0.8, haloBlur: 0.4, size: 0.9, regular: true, tracking: 0.06 },
    region: { opacity: 0.44, haloWidth: 0.6, haloBlur: 0.4, size: 0.88, tracking: 0.16 },
    road: { opacity: 0.56, haloWidth: 0.9, haloBlur: 0.4, size: 0.94 },
    water: { opacity: 0.58, haloWidth: 0.8, haloBlur: 0.4, size: 0.94 },
    poi: { opacity: 0.52, haloWidth: 0.8, haloBlur: 0.4, size: 0.94 },
    other: { opacity: 0.6, haloWidth: 0.8, haloBlur: 0.4, size: 0.94 },
  },
  light: {
    city: { opacity: 0.84, haloWidth: 1.2, haloBlur: 0.6, size: 0.86, tracking: 0.08 },
    town: { opacity: 0.76, haloWidth: 1.1, haloBlur: 0.6, size: 0.9, regular: true },
    minor: { opacity: 0.64, haloWidth: 1, haloBlur: 0.5, size: 0.9, regular: true, tracking: 0.06 },
    region: { opacity: 0.5, haloWidth: 0.8, haloBlur: 0.5, size: 0.88, tracking: 0.16 },
    road: { opacity: 0.66, haloWidth: 1.1, haloBlur: 0.5, size: 0.94 },
    water: { opacity: 0.7, haloWidth: 1, haloBlur: 0.5, size: 0.94 },
    poi: { opacity: 0.6, haloWidth: 1, haloBlur: 0.5, size: 0.94 },
    other: { opacity: 0.66, haloWidth: 1, haloBlur: 0.5, size: 0.94 },
  },
  imagery: {
    city: { opacity: 0.92, haloWidth: 1.3, haloBlur: 0.6, size: 0.9, tracking: 0.08 },
    town: { opacity: 0.88, haloWidth: 1.2, haloBlur: 0.6, size: 0.92, regular: true },
    minor: { opacity: 0.8, haloWidth: 1.1, haloBlur: 0.5, size: 0.92, regular: true },
    region: { opacity: 0.7, haloWidth: 1, haloBlur: 0.5, size: 0.9, tracking: 0.14 },
    road: { opacity: 0.82, haloWidth: 1.2, haloBlur: 0.5, size: 0.96 },
    water: { opacity: 0.8, haloWidth: 1.1, haloBlur: 0.5, size: 0.96 },
    poi: { opacity: 0.78, haloWidth: 1.1, haloBlur: 0.5, size: 0.96 },
    other: { opacity: 0.8, haloWidth: 1.1, haloBlur: 0.5, size: 0.96 },
  },
}

/** The satellite theme's roads & places are clones of the dark style's labels. */
const HYBRID = 'nx-icm-hybrid-'

/** What a basemap label layer names, from its id and source layer (CARTO ids first, then generic tokens). */
export function labelKind(id: string, sourceLayer?: string | null): LabelKind | null {
  const raw = id.startsWith(HYBRID) ? id.slice(HYBRID.length) : id
  const t = `${raw} ${sourceLayer ?? ''}`.toLowerCase()
  if (t.includes('housenumber') || t.includes('shield')) return null
  if (/(^|[_\-\s])(city|capital)/.test(t)) return 'city'
  if (t.includes('town')) return 'town'
  if (/village|suburb|hamlet|neighbo|quarter|locality/.test(t)) return 'minor'
  if (/state|country|continent|admin/.test(t)) return 'region'
  if (/water|ocean|lake|river|marine|(^|[_\-\s])sea/.test(t)) return 'water'
  if (/road|street|highway|transport|motorway/.test(t)) return 'road'
  if (/poi|park|stadium|landmark|airport|aerodrome/.test(t)) return 'poi'
  if (t.includes('place')) return 'minor'
  return 'other'
}

/** Which ground the theme's labels sit on; null = the theme has no vector labels (terrain raster). */
export function labelGround(styleMode: string): LabelGround | null {
  const p = getMapVisualPreset(styleMode)
  if (p.basemap.family === 'terrain') return null
  if (p.basemap.family === 'satellite') return 'imagery'
  return p.basemap.isLight ? 'light' : 'dark'
}

const round = (n: number) => Math.round(n * 1000) / 1000

/** text-size × k for numbers, legacy {stops} functions and zoom interpolate/step curves; anything else is left alone. */
export function scaleTextSize(v: unknown, k: number): unknown {
  if (k === 1) return v
  const out = (x: unknown) => (typeof x === 'number' ? round(x * k) : Array.isArray(x) ? ['*', k, x] : x)
  if (typeof v === 'number') return round(v * k)
  if (Array.isArray(v)) {
    if (v[0] === 'interpolate' && v.length >= 5) return [...v.slice(0, 3), ...v.slice(3).map((x, i) => (i % 2 === 1 ? out(x) : x))]
    if (v[0] === 'step' && v.length >= 3) return [v[0], v[1], out(v[2]), ...v.slice(3).map((x, i) => (i % 2 === 1 ? out(x) : x))]
    return v
  }
  if (v && typeof v === 'object' && Array.isArray((v as { stops?: unknown }).stops)) {
    const f = v as { stops: unknown[] }
    if (!f.stops.every((s) => Array.isArray(s) && typeof s[1] === 'number')) return v
    return { ...f, stops: (f.stops as Array<[unknown, number]>).map(([z, s]) => [z, round(s * k)]) }
  }
  return v
}

/** The minimal map surface the tone needs (maplibregl.Map satisfies it). */
export interface LabelToneMap {
  getLayersOrder(): string[]
  getLayer(id: string): { type?: string; sourceLayer?: string } | undefined
  getLayoutProperty(id: string, name: string): unknown
  getPaintProperty(id: string, name: string): unknown
  setLayoutProperty(id: string, name: string, value: unknown): unknown
  setPaintProperty(id: string, name: string, value: unknown): unknown
}

type Kind = 'layout' | 'paint'
/** Per layer, per property: the style's own value and what the desk wrote over it. */
export type ToneMemo = Map<string, Map<string, { kind: Kind; base: unknown; applied: unknown }>>

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const read = (map: LabelToneMap, kind: Kind, id: string, prop: string) => (kind === 'layout' ? map.getLayoutProperty(id, prop) : map.getPaintProperty(id, prop))

/** One property: untouched since our write → nothing; otherwise re-derive from the new base and write. */
function settle(map: LabelToneMap, slot: Map<string, { kind: Kind; base: unknown; applied: unknown }>, id: string, kind: Kind, prop: string, derive: (base: unknown) => unknown): number {
  const cur = read(map, kind, id, prop)
  const rec = slot.get(prop)
  if (rec && same(cur, rec.applied)) return 0
  const next = derive(cur)
  if (same(next, cur)) { slot.set(prop, { kind, base: cur, applied: cur }); return 0 }
  if (kind === 'layout') map.setLayoutProperty(id, prop, next)
  else map.setPaintProperty(id, prop, next)
  // what MapLibre now reports is the truth to compare against (never compound a scale)
  slot.set(prop, { kind, base: cur, applied: read(map, kind, id, prop) })
  return 1
}

/** Applies the desk tone to every basemap label layer; returns how many properties were written. */
export function applyDeskLabelTone(map: LabelToneMap, ground: LabelGround, memo: ToneMemo): number {
  const order = map.getLayersOrder()
  let regularStacks: Map<string, unknown[]> | null = null
  /** "Montserrat Medium…" → the style's own "Montserrat Regular…" stack (its glyphs are already served). */
  const regularFor = (stack: unknown): unknown => {
    if (!Array.isArray(stack) || typeof stack[0] !== 'string' || !/ Medium$/.test(stack[0])) return stack
    if (!regularStacks) {
      regularStacks = new Map()
      for (const lid of order) {
        if (map.getLayer(lid)?.type !== 'symbol') continue
        const f = map.getLayoutProperty(lid, 'text-font')
        if (Array.isArray(f) && typeof f[0] === 'string' && / Regular$/.test(f[0]) && !regularStacks.has(f[0])) regularStacks.set(f[0], f)
      }
    }
    return regularStacks.get(stack[0].replace(/ Medium$/, ' Regular')) ?? stack
  }
  let writes = 0
  for (const id of order) {
    const layer = map.getLayer(id)
    if (!layer || layer.type !== 'symbol') continue
    if (isOwnedMapLayer(id) && !id.startsWith(HYBRID)) continue
    const kind = labelKind(id, layer.sourceLayer)
    if (!kind || map.getLayoutProperty(id, 'text-field') == null) continue
    const tone = LABEL_TONES[ground][kind]
    let slot = memo.get(id)
    if (!slot) { slot = new Map(); memo.set(id, slot) }
    writes += settle(map, slot, id, 'layout', 'text-size', (b) => scaleTextSize(b, tone.size))
    if (tone.regular) writes += settle(map, slot, id, 'layout', 'text-font', regularFor)
    if (tone.tracking && map.getLayoutProperty(id, 'text-transform') === 'uppercase') {
      writes += settle(map, slot, id, 'layout', 'text-letter-spacing', (b) => (b === undefined || typeof b === 'number' ? Math.max(typeof b === 'number' ? b : 0, tone.tracking!) : b))
    }
    writes += settle(map, slot, id, 'paint', 'text-opacity', (b) => (b === undefined ? tone.opacity : typeof b === 'number' ? round(b * tone.opacity) : b))
    writes += settle(map, slot, id, 'paint', 'text-halo-width', () => tone.haloWidth)
    writes += settle(map, slot, id, 'paint', 'text-halo-blur', () => tone.haloBlur)
  }
  return writes
}

/** Puts the style's own values back wherever the desk's value is still in place. */
export function restoreDeskLabelTone(map: LabelToneMap, memo: ToneMemo): void {
  for (const [id, slot] of memo) {
    if (!map.getLayer(id)) continue
    for (const [prop, rec] of slot) {
      if (!same(read(map, rec.kind, id, prop), rec.applied) || same(rec.base, rec.applied)) continue
      if (rec.kind === 'layout') map.setLayoutProperty(id, prop, rec.base)
      else map.setPaintProperty(id, prop, rec.base)
    }
  }
  memo.clear()
}

/**
 * [desk only — mounted by MapDeskChrome] Keeps the basemap labels quiet across
 * style swaps and the painter's re-colouring. Coalesced to one pass per frame;
 * if something keeps undoing it, it stops fighting for that window.
 */
export function useDeskLabelTone(map: maplibregl.Map | null, epoch: number, styleMode: string) {
  useEffect(() => {
    if (!map) return undefined
    const ground = labelGround(styleMode)
    const target = map as unknown as LabelToneMap
    const memo: ToneMemo = new Map()
    let raf = 0
    let windowAt = 0
    let writingRuns = 0
    const run = () => {
      raf = 0
      if (!ground || !map.style) return
      const now = performance.now()
      if (now - windowAt > 2000) { windowAt = now; writingRuns = 0 }
      if (writingRuns > 8) return
      try { if (applyDeskLabelTone(target, ground, memo) > 0) writingRuns += 1 } catch { /* style mid-swap: the next styledata runs again */ }
    }
    const schedule = () => { if (!raf) raf = window.requestAnimationFrame(run) }
    schedule()
    map.on('styledata', schedule)
    return () => {
      map.off('styledata', schedule)
      if (raf) window.cancelAnimationFrame(raf)
      try { restoreDeskLabelTone(target, memo) } catch { /* map or style gone */ }
    }
  }, [map, epoch, styleMode])
}
