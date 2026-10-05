/**
 * Context overlay GLYPHS — the camera and crime marks, drawn once per map
 * ground (dark / light) into MapLibre images.
 *
 * Owner rule: DOTS ARE RESERVED FOR PROPERTIES. Every context mark is a small
 * rounded TILE carrying a glyph (a camera, a car, a house…), never a plain
 * circle, so nobody mistakes a camera or an incident for a property pin.
 *
 * Why the old marks were "really, really faded":
 *   · 4–7 px circles (radius 2.2–3.6 px at z8–12), one colour with a 1 px
 *     same-colour stroke and no contrasting edge — cyan on cyan-ish roads;
 *   · drawn beneath the basemap's labels and, depending on insertion order,
 *     beneath the night tint / city lights (both anchor "before the first
 *     label"), which wash anything under them;
 *   · the mxd-ctx-* ids were not LeadCommand-owned (map-layer-ownership), so
 *     the desk label tone and basemap painter re-toned their symbol layers.
 * The tiles below fix the first; context-layers places them above the
 * basemap (labels and night tint included) and directly below the first
 * operational layer, which fixes the second; ownership fixes the third.
 *
 * Each glyph is an SVG path on a 24-unit grid, so the same drawing feeds the
 * map (Path2D on a canvas, 2× for crisp edges) and the legend / panels
 * (<svg>). The tile is a raster image, not SDF: SDF throws painted colour
 * away (see pin-icons.ts), and a tile needs two colours plus an edge.
 */
import type maplibregl from 'maplibre-gl'

export type GlyphId =
  | 'cam-still' | 'cam-video' | 'cam-link'
  | 'crime-assault' | 'crime-robbery' | 'crime-burglary' | 'crime-theft' | 'crime-vehicle'
  | 'crime-vandalism' | 'crime-drugs' | 'crime-weapons' | 'crime-other'
  | 'cluster-cam' | 'cluster-crime'

export type CrimeType = 'assault' | 'robbery' | 'burglary' | 'theft' | 'vehicle' | 'vandalism' | 'drugs' | 'weapons' | 'other'
export type CrimeCat = 'violent' | 'property' | 'drugs' | 'other'
export const CRIME_TYPES: CrimeType[] = ['assault', 'robbery', 'burglary', 'theft', 'vehicle', 'vandalism', 'drugs', 'weapons', 'other']
export const CRIME_CATS: CrimeCat[] = ['violent', 'property', 'drugs', 'other']
export const TYPE_CAT: Record<CrimeType, CrimeCat> = {
  assault: 'violent', robbery: 'violent', burglary: 'property', theft: 'property', vehicle: 'property', vandalism: 'property', drugs: 'drugs', weapons: 'other', other: 'other',
}

/**
 * Category colours. None is red — red means failure in every LeadCommand
 * theme (Red Ops included), and an incident is not a system failure. Each
 * holds ≥ 3:1 against both tile grounds.
 */
export const CRIME_CAT_STYLE: Record<CrimeCat, { label: string; dark: string; light: string }> = {
  violent: { label: 'Violent', dark: '#f2b45c', light: '#a35f00' },
  property: { label: 'Property', dark: '#9aaeff', light: '#3b4fc4' },
  drugs: { label: 'Drugs', dark: '#5fd4c4', light: '#0b7a6c' },
  other: { label: 'Other', dark: '#b7bfcc', light: '#4a5566' },
}
export const CRIME_TYPE_LABEL: Record<CrimeType, string> = {
  assault: 'Assault / violent', robbery: 'Robbery', burglary: 'Burglary', theft: 'Theft', vehicle: 'Vehicle theft / break-in',
  vandalism: 'Vandalism', drugs: 'Drugs', weapons: 'Weapons', other: 'Other',
}

/** 24-unit paths, filled even-odd (inner shapes cut holes). */
export const GLYPH_PATHS: Record<GlyphId, string> = {
  // a stills camera: body + a lens ring
  'cam-still': 'M4 7.5h3.2l1.6-2.2h6.4l1.6 2.2H20a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18V9A1.5 1.5 0 0 1 4 7.5z M12 9.4a3.9 3.9 0 1 0 0 7.8a3.9 3.9 0 1 0 0-7.8z M12 11.3a2 2 0 1 1 0 4a2 2 0 1 1 0-4z',
  // a video camera: body + the lens cone
  'cam-video': 'M2.5 8A1.5 1.5 0 0 1 4 6.5h9.5A1.5 1.5 0 0 1 15 8v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 16z M16 10.2l5.5-3.2v10l-5.5-3.2z',
  // location only: the stills camera, hollowed
  'cam-link': 'M4 7.5h3.2l1.6-2.2h6.4l1.6 2.2H20a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18V9A1.5 1.5 0 0 1 4 7.5z M4.4 9.4v8.2h15.2V9.4z',
  // assault / violent: an impact bolt
  'crime-assault': 'M13.5 2L5 13.6h5.6L9 22l9.2-12.6h-5.7z',
  // robbery: a money bag
  'crime-robbery': 'M9 2.8h6l-1.7 3.2h-2.6z M8.6 7.2h6.8c2.9 2.5 4.6 5.4 4.6 8.4c0 3.1-2.5 5.1-8 5.1s-8-2-8-5.1c0-3 1.7-5.9 4.6-8.4z M11.2 10.5h1.6v1.2c1.1.2 1.9.8 2.1 1.8l-1.5.4c-.1-.5-.6-.8-1.4-.8c-.8 0-1.2.3-1.2.7c0 .4.4.6 1.5.9c1.8.4 2.7 1 2.7 2.3c0 1.1-.8 1.9-2.2 2.1V20.3h-1.6v-1.2c-1.3-.2-2.2-.9-2.4-2l1.5-.4c.2.6.8 1 1.7 1c.9 0 1.4-.3 1.4-.8c0-.4-.4-.6-1.6-.9c-1.7-.4-2.6-1-2.6-2.3c0-1 .8-1.8 2-2z',
  // burglary: a house, its door open
  'crime-burglary': 'M12 2.6l9.4 8.4h-2.6v10H5.2V11H2.6z M10 13.6v7.4h4v-7.4z',
  // theft: a shopping bag
  'crime-theft': 'M5.8 8h12.4l1.2 13H4.6z M8.6 8V6.6a3.4 3.4 0 0 1 6.8 0V8h-1.7V6.6a1.7 1.7 0 0 0-3.4 0V8z',
  // vehicle theft / break-in: a car
  'crime-vehicle': 'M5.4 10.2l1.7-4.1A2 2 0 0 1 9 4.8h6a2 2 0 0 1 1.9 1.3l1.7 4.1a2.2 2.2 0 0 1 2 2.2v5h-2v2.1h-2.9v-2.1H8.3v2.1H5.4v-2.1h-2v-5a2.2 2.2 0 0 1 2-2.2z M7.6 10h8.8l-1.3-3.2H8.9z M5.5 12.6v2h2.6v-2z M15.9 12.6v2h2.6v-2z',
  // vandalism: a spray can
  'crime-vandalism': 'M7.2 10A1.6 1.6 0 0 1 8.8 8.4h5.4A1.6 1.6 0 0 1 15.8 10v11.4H7.2z M9.3 4.4h4.4v3H9.3z M17 4.2h1.8V6H17z M19.8 2.6h1.8v1.8h-1.8z M19.8 5.8h1.8v1.8h-1.8z M17 8h1.8v1.8H17z',
  // drugs: a capsule
  'crime-drugs': 'M14.6 3.5a4.7 4.7 0 0 1 6.6 6.6L10.3 21a4.7 4.7 0 0 1-6.6-6.6z M7.7 8.6l7.7 7.7 1.1-1.1-7.7-7.7z',
  // weapons: a target reticle
  'crime-weapons': 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 5.6a6.4 6.4 0 1 1 0 12.8a6.4 6.4 0 1 1 0-12.8z M11 1h2v7.2h-2z M11 15.8h2V23h-2z M1 11h7.2v2H1z M15.8 11H23v2h-7.2z',
  // other: a report sheet
  'crime-other': 'M6 2.6h8.4L19 7.2v14.2H6z M8.6 10.6h7.8v1.7H8.6z M8.6 14.2h7.8v1.7H8.6z M8.6 17.8h5.2v1.7H8.6z',
  // cluster tiles: stacked sheets behind the glyph
  'cluster-cam': 'M2.5 8A1.5 1.5 0 0 1 4 6.5h9.5A1.5 1.5 0 0 1 15 8v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 16z M16 10.2l5.5-3.2v10l-5.5-3.2z',
  'cluster-crime': 'M6 2.6h8.4L19 7.2v14.2H6z M8.6 10.6h7.8v1.7H8.6z M8.6 14.2h7.8v1.7H8.6z M8.6 17.8h5.2v1.7H8.6z',
}

export const crimeGlyph = (t: string): GlyphId => (CRIME_TYPES.includes(t as CrimeType) ? (`crime-${t}` as GlyphId) : 'crime-other')

export type Ground = 'd' | 'l'
export const iconName = (g: GlyphId, ground: Ground) => `mxd-ctx-i-${g}-${ground}`

/** What a tile is painted with, per glyph and ground. */
export function tileStyle(g: GlyphId, ground: Ground): { plate: string; edge: string; ink: string; stack: boolean; hollow: boolean } {
  const dark = ground === 'd'
  const plate = dark ? 'rgba(12,17,27,0.94)' : 'rgba(255,255,255,0.97)'
  if (g.startsWith('crime-')) {
    const cat = TYPE_CAT[g.slice(6) as CrimeType] ?? 'other'
    const c = dark ? CRIME_CAT_STYLE[cat].dark : CRIME_CAT_STYLE[cat].light
    return { plate, edge: c, ink: c, stack: false, hollow: false }
  }
  if (g === 'cluster-crime') return { plate, edge: dark ? '#c3cad6' : '#566174', ink: dark ? '#dde3ec' : '#2a3342', stack: true, hollow: false }
  // cameras: neutral steel — cyan/cobalt mean execution in LeadCommand, a camera is context
  const ink = dark ? '#eef3fb' : '#1d2533'
  if (g === 'cam-video') return { plate, edge: dark ? '#3ddc97' : '#0e8a5a', ink, stack: false, hollow: false }
  if (g === 'cam-link') return { plate, edge: dark ? 'rgba(200,210,226,0.55)' : 'rgba(40,52,70,0.45)', ink: dark ? '#c8d2e2' : '#3a4658', stack: false, hollow: true }
  if (g === 'cluster-cam') return { plate, edge: dark ? '#9fb0c8' : '#566174', ink, stack: true, hollow: false }
  return { plate, edge: dark ? '#9fb0c8' : '#5d6b80', ink, stack: false, hollow: false }
}

/** Tile geometry in CSS px (the image is drawn at PIXEL_RATIO×). */
export const TILE_PX = 22
export const PIXEL_RATIO = 2

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** One tile image, or null where there is no canvas (tests, SSR). */
export function drawTile(g: GlyphId, ground: Ground): ImageData | null {
  if (typeof document === 'undefined' || typeof Path2D === 'undefined') return null
  const px = TILE_PX * PIXEL_RATIO
  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const s = PIXEL_RATIO
  const st = tileStyle(g, ground)
  const inset = 2 * s
  const size = px - inset * 2
  // a soft contact shadow so the tile lifts off imagery and dark roads alike
  ctx.save()
  ctx.shadowColor = ground === 'd' ? 'rgba(0,0,0,0.55)' : 'rgba(20,30,50,0.28)'
  ctx.shadowBlur = 2.5 * s
  ctx.shadowOffsetY = 0.6 * s
  if (st.stack) {
    // a second tile peeking behind: "several here"
    roundRect(ctx, inset + 1.6 * s, inset - 1.2 * s, size - 1.6 * s, size - 1.6 * s, 5 * s)
    ctx.fillStyle = st.plate
    ctx.fill()
    ctx.lineWidth = 1 * s
    ctx.strokeStyle = st.edge
    ctx.globalAlpha = 0.55
    ctx.stroke()
    ctx.globalAlpha = 1
  }
  roundRect(ctx, inset, inset + (st.stack ? 0.8 * s : 0), size - (st.stack ? 1.6 * s : 0), size - (st.stack ? 1.6 * s : 0), 5.5 * s)
  ctx.fillStyle = st.plate
  ctx.fill()
  ctx.restore()
  ctx.lineWidth = 1.5 * s
  ctx.strokeStyle = st.edge
  if (st.hollow) ctx.setLineDash([2.2 * s, 1.6 * s])
  ctx.stroke()
  ctx.setLineDash([])
  // the glyph: 24-unit path scaled into the tile's inner square
  const inner = (st.stack ? 11.5 : 13) * s
  const ox = (px - inner) / 2 - (st.stack ? 0.8 * s : 0)
  const oy = (px - inner) / 2 + (st.stack ? 0.8 * s : 0)
  ctx.save()
  ctx.translate(ox, oy)
  ctx.scale(inner / 24, inner / 24)
  ctx.fillStyle = st.ink
  ctx.fill(new Path2D(GLYPH_PATHS[g]), 'evenodd')
  ctx.restore()
  return ctx.getImageData(0, 0, px, px)
}

export const ALL_GLYPHS = Object.keys(GLYPH_PATHS) as GlyphId[]

/** Add every glyph tile for a ground the map does not have yet. Cheap to call on every ensure. */
export function ensureContextIcons(map: Pick<maplibregl.Map, 'hasImage' | 'addImage'>, ground: Ground, glyphs: GlyphId[] = ALL_GLYPHS) {
  for (const g of glyphs) {
    const name = iconName(g, ground)
    if (map.hasImage(name)) continue
    const img = drawTile(g, ground)
    if (!img) continue
    try { map.addImage(name, img, { pixelRatio: PIXEL_RATIO }) } catch { /* added concurrently */ }
  }
}
