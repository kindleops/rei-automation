import type { ExpressionSpecification, StyleSpecification } from 'maplibre-gl'
import { CARTO_VECTOR_DARK_STYLE_URL, CARTO_VECTOR_LIGHT_STYLE_URL } from '../../map/map-visual-presets'

/** Map analysis modes (§12) — only the ones the data can honestly support. */
export type MapMode = 'evidence' | 'ppsf' | 'price' | 'recency' | 'score'

export const SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  glyphs: 'https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf',
  sources: { sat: { type: 'raster', tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, attribution: 'Esri, Maxar, Earthstar Geographics' } },
  layers: [{ id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-saturation': -0.35, 'raster-brightness-max': 0.82 } }],
}

export function styleFor(theme: string, imagery: boolean): string | StyleSpecification {
  if (imagery) return SATELLITE_STYLE
  return theme === 'light' ? CARTO_VECTOR_LIGHT_STYLE_URL : CARTO_VECTOR_DARK_STYLE_URL
}

/**
 * Sequential ramps — one hue, low → high (§14). Dark themes anchor low values
 * dim and high values bright; light anchors low pale and high deep. Never a
 * rainbow, never the semantic red or amber.
 */
export function rampFor(theme: string): string[] {
  return theme === 'light'
    ? ['#c9e4f3', '#8cc6e6', '#4b9fd0', '#1f74b0', '#0d4b7c']
    : ['#1e4a63', '#24709a', '#2f9bcf', '#5cc8f0', '#b8efff']
}

export interface MapPalette {
  set: string
  added: string
  cand: string
  excl: string
  attn: string
  subject: string
  ink: string
  halo: string
  ring: string
  surface: string
}

/** Reads the workstation's semantic tokens off the map host so theme, accent and Red Ops all apply. */
export function readPalette(el: Element | null, theme: string, imagery: boolean): MapPalette {
  const cs = el ? getComputedStyle(el) : null
  const v = (name: string, fallback: string) => (cs?.getPropertyValue(name).trim() || fallback)
  const light = theme === 'light' && !imagery
  return {
    set: v('--ciw-set', '#4cc9f0'),
    added: v('--ciw-added', '#e6edf7'),
    cand: v('--ciw-cand', light ? '#5c6678' : '#8d9ab0'),
    excl: v('--ciw-excl', light ? '#7c8596' : '#6b7486'),
    attn: v('--ciw-attn', '#f0b64a'),
    subject: v('--ciw-subject', '#5eead4'),
    ink: light ? '#0b1220' : '#eef2f8',
    halo: light ? 'rgba(255,255,255,0.92)' : 'rgba(4,6,11,0.88)',
    ring: v('--ciw-ring', light ? 'rgba(11,18,32,0.55)' : 'rgba(255,255,255,0.9)'),
    surface: light ? '#f7f8fa' : '#070a10',
  }
}

/** Robust domain (5th–95th percentile) so one extreme sale cannot flatten the scale. */
export function robustDomain(values: number[]): [number, number] | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length < 2) return null
  const at = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))]
  const lo = at(0.05)
  const hi = at(0.95)
  return lo === hi ? [v[0], v[v.length - 1] || v[0] + 1] : [lo, hi]
}

export const MODE_PROP: Record<Exclude<MapMode, 'evidence'>, string> = { ppsf: 'unit', price: 'price', recency: 'age', score: 'score' }

/** Circle colour for a mode: the evidence state, or a sequential ramp over the mode's metric. */
export function colorExpression(mode: MapMode, base: string, palette: MapPalette, ramp: string[], domain: [number, number] | null): ExpressionSpecification | string {
  if (mode === 'evidence' || !domain) return base
  const prop = MODE_PROP[mode]
  const [lo, hi] = domain
  const span = hi - lo || 1
  // recency: recent = strongest, so the ramp runs high → low over age
  const colors = mode === 'recency' ? [...ramp].reverse() : ramp
  const stops: Array<number | string> = []
  colors.forEach((c, i) => { stops.push(lo + (span * i) / (colors.length - 1), c) })
  return ['case', ['==', ['typeof', ['get', prop]], 'number'], ['interpolate', ['linear'], ['get', prop], ...stops] as unknown as ExpressionSpecification, palette.excl] as unknown as ExpressionSpecification
}

/** Ring polygons (as lines) at round distances inside the search, plus the search radius itself. */
export function ringFeatures(lat: number, lng: number, searchMiles: number) {
  const steps = [0.25, 0.5, 1, 2, 3, 5, 10].filter((m) => m < searchMiles - 1e-9)
  const circle = (miles: number, n = 96): Array<[number, number]> => {
    const out: Array<[number, number]> = []
    const dLat = miles / 69.0
    const dLng = miles / (69.0 * Math.cos((lat * Math.PI) / 180))
    for (let i = 0; i <= n; i += 1) {
      const t = (i / n) * Math.PI * 2
      out.push([lng + dLng * Math.sin(t), lat + dLat * Math.cos(t)])
    }
    return out
  }
  // keep a readable count: at most 4 interior rings, the largest ones
  const interior = steps.slice(-4)
  return {
    type: 'FeatureCollection' as const,
    features: [
      ...interior.map((m) => ({ type: 'Feature' as const, properties: { kind: 'ring', miles: m, label: `${m} mi` }, geometry: { type: 'LineString' as const, coordinates: circle(m) } })),
      { type: 'Feature' as const, properties: { kind: 'search', miles: searchMiles, label: `${searchMiles} mi search` }, geometry: { type: 'LineString' as const, coordinates: circle(searchMiles) } },
    ],
  }
}

export function ringLabelFeatures(lat: number, lng: number, searchMiles: number) {
  const rings = ringFeatures(lat, lng, searchMiles).features
  return {
    type: 'FeatureCollection' as const,
    features: rings.map((f) => ({
      type: 'Feature' as const,
      properties: { label: f.properties.label, kind: f.properties.kind },
      geometry: { type: 'Point' as const, coordinates: [lng, lat + f.properties.miles / 69.0] },
    })),
  }
}
