/**
 * MapLibre drawing for the context overlays (cameras, crime, investor
 * presence). Each overlay owns one GeoJSON source and a couple of symbol
 * layers. A theme swap drops custom sources and images; `ensure*` re-adds
 * them from the last data.
 *
 * VISUAL HIERARCHY (owner): comps, properties, execution / live actions and
 * seller pins stay DOMINANT. Context overlays are legible but secondary:
 *
 *   z-order     above the basemap (labels, night tint, city lights — nothing
 *               washes them out) and directly BELOW the first operational
 *               layer, so every operational pin draws on top. Within the
 *               overlays: presence < crime < cameras.
 *   collision   icon-allow-overlap false + icon-ignore-placement true: an
 *               overlay tile hides where it would cover an operational
 *               symbol (those layers sit above, so they are placed first)
 *               and never pushes a label or a pin out.
 *   declutter   clustered sources (cameras to z10, crime to z12) drawn as a
 *               stacked tile + count, never as a dot; tiles are smaller than
 *               property pins and ease in with zoom (size and opacity).
 *
 * DOTS ARE RESERVED FOR PROPERTIES: no layer here is a circle layer. Cameras
 * and incidents are glyph tiles (context-icons.ts); presence is grid squares.
 */
import type maplibregl from 'maplibre-gl'
import { PRESENCE_COLORS, presenceFeatures, type CamerasReply, type CrimeReply, type PresenceReply, type PresenceView } from './context-model'
import { crimeGlyph, ensureContextIcons, iconName, type Ground } from './context-icons'

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
export const CTX_IDS = {
  camSrc: 'mxd-ctx-cam', camGroup: 'mxd-ctx-cam-group', camIcons: 'mxd-ctx-cam-icons',
  crimeSrc: 'mxd-ctx-crime', crimeGroup: 'mxd-ctx-crime-group', crimeIcons: 'mxd-ctx-crime-icons',
  presSrc: 'mxd-ctx-pres', presEntity: 'mxd-ctx-pres-entity', presBuys: 'mxd-ctx-pres-buys',
} as const

/** Every layer this module draws, bottom → top. */
export const CTX_LAYER_ORDER = [CTX_IDS.presEntity, CTX_IDS.presBuys, CTX_IDS.crimeGroup, CTX_IDS.crimeIcons, CTX_IDS.camGroup, CTX_IDS.camIcons] as const

/**
 * Operational layers — the ones that must stay on top of every context
 * overlay: property pins/tiles, comps, seller pins, execution/command pins,
 * live activity, lens and focus layers, buyer layers, market aggregates.
 */
export const OPERATIONAL_LAYER = /^(command-|sold-comps-|prop-|map-agg-|map-market|seller-pins-|inbox-|buyer-|nx-lens|nx-live|nx-area|nx-comp|nx-dots|nx-focus|nx-orbs|nx-mx-|nx-world-markets|nx-world-sel)/

type LayerRef = { id: string; type?: string }
/** Operational PINS (symbol / circle). Operational area fills and lines may sit low in the stack; anchoring on them would drop the overlays back under the labels and the night tint. */
const isOperationalPin = (l: LayerRef) => OPERATIONAL_LAYER.test(l.id) && (l.type === 'symbol' || l.type === 'circle')
const ctxRank = (id: string) => CTX_LAYER_ORDER.indexOf(id as (typeof CTX_LAYER_ORDER)[number])

/**
 * Where a context layer goes: directly below the first operational pin layer,
 * and below any context layer that ranks above it. undefined = on top (no
 * operational layer yet; they are appended above us when they arrive).
 */
export function overlayBefore(layers: LayerRef[], layerId: string): string | undefined {
  const rank = ctxRank(layerId)
  for (const l of layers) {
    if (l.id === layerId) continue
    if (isOperationalPin(l) || (rank >= 0 && ctxRank(l.id) > rank)) return l.id
  }
  return undefined
}

/** True when something that must be above this context layer sits below it. */
export function isMisplaced(layers: LayerRef[], layerId: string): boolean {
  const at = layers.findIndex((l) => l.id === layerId)
  if (at < 0) return false
  const rank = ctxRank(layerId)
  return layers.slice(0, at).some((l) => isOperationalPin(l) || (rank >= 0 && ctxRank(l.id) > rank))
}

const styleLayers = (map: maplibregl.Map): LayerRef[] => { try { return (map.getStyle().layers ?? []).map((l) => ({ id: l.id, type: l.type })) } catch { return [] } }
const addCtxLayer = (map: maplibregl.Map, layer: maplibregl.LayerSpecification) => {
  if (map.getLayer(layer.id)) return
  map.addLayer(layer, overlayBefore(styleLayers(map), layer.id))
}
/** Re-seat a layer when an operational pin layer ended up under it (a lens swap, a late re-add). */
const reseat = (map: maplibregl.Map, id: string) => {
  const layers = styleLayers(map)
  if (!isMisplaced(layers, id)) return
  try { map.moveLayer(id, overlayBefore(layers, id)) } catch { /* style mid-swap */ }
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

const FONT = ['DIN Offc Pro Medium', 'Arial Unicode MS Bold']
const imageExpr = (ground: Ground) => ['concat', 'mxd-ctx-i-', ['get', 'g'], `-${ground}`] as never
/** Tiles ease in with zoom: small and a touch quieter far out, full at street level. */
const sizeExpr = (z0: number) => ['interpolate', ['linear'], ['zoom'], z0, 0.66, z0 + 3, 0.82, z0 + 6, 1] as never
const countText = ['to-string', ['coalesce', ['get', 'total'], ['get', 'n'], ['get', 'point_count']]] as never

function groupLayer(id: string, source: string, glyph: 'cluster-cam' | 'cluster-crime', ground: Ground, z0: number): maplibregl.LayerSpecification {
  const dark = ground === 'd'
  return {
    id, type: 'symbol', source,
    filter: ['any', ['has', 'point_count'], ['==', ['get', 'cell'], 1]] as never,
    layout: {
      'icon-image': iconName(glyph, ground),
      'icon-size': sizeExpr(z0),
      'icon-allow-overlap': false,
      'icon-ignore-placement': true,
      'icon-padding': 1,
      'text-field': countText,
      'text-font': FONT,
      'text-size': ['interpolate', ['linear'], ['zoom'], z0, 10, z0 + 4, 11] as never,
      'text-anchor': 'left',
      'text-offset': [0.95, 0],
      'text-allow-overlap': false,
      'text-ignore-placement': true,
      'text-optional': true,
    },
    paint: {
      'icon-opacity': ['interpolate', ['linear'], ['zoom'], z0, 0.82, z0 + 3, 0.94] as never,
      'text-color': dark ? '#e8edf5' : '#1d2533',
      'text-halo-color': dark ? 'rgba(8,11,18,0.92)' : 'rgba(255,255,255,0.95)',
      'text-halo-width': 1.4,
    },
  }
}

function iconLayer(id: string, source: string, ground: Ground, z0: number, sortKey: unknown, opacityOff: unknown): maplibregl.LayerSpecification {
  return {
    id, type: 'symbol', source,
    filter: ['all', ['!', ['has', 'point_count']], ['!=', ['get', 'cell'], 1]] as never,
    layout: {
      'icon-image': imageExpr(ground),
      'icon-size': sizeExpr(z0),
      'icon-allow-overlap': false,
      'icon-ignore-placement': true,
      'icon-padding': 0.5,
      'symbol-sort-key': sortKey as never,
    },
    paint: {
      'icon-opacity': ['interpolate', ['linear'], ['zoom'], z0, ['case', opacityOff, 0.5, 0.82], z0 + 3, ['case', opacityOff, 0.58, 0.95], z0 + 6, ['case', opacityOff, 0.62, 1]] as never,
    },
  }
}

/* ── cameras ──────────────────────────────────────────────────────────────── */

export const CAMERA_CLUSTER_MAX_ZOOM = 10
export const CRIME_CLUSTER_MAX_ZOOM = 12

export function cameraFeatures(r: CamerasReply | null): GeoJSON.FeatureCollection {
  if (!r) return EMPTY
  if (r.mode === 'coverage') {
    return { type: 'FeatureCollection', features: r.cells.map((c, i) => ({ type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { cell: 1, n: c.cameras } })) }
  }
  return {
    type: 'FeatureCollection',
    features: r.cameras.map((c, i) => ({
      type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      properties: { cell: 0, id: c.id, name: c.name ?? '', g: c.media === 'link' ? 'cam-link' : c.video ? 'cam-video' : 'cam-still', off: c.status === 'OFFLINE' ? 1 : 0, live: c.video ? 1 : 0 },
    })),
  }
}

export function ensureCameras(map: maplibregl.Map, fc: GeoJSON.FeatureCollection, light: boolean) {
  if (!map.style) return
  const ground: Ground = light ? 'l' : 'd'
  ensureContextIcons(map, ground)
  if (!map.getSource(CTX_IDS.camSrc)) {
    map.addSource(CTX_IDS.camSrc, { type: 'geojson', data: fc, cluster: true, clusterMaxZoom: CAMERA_CLUSTER_MAX_ZOOM, clusterRadius: 46, clusterProperties: { total: ['+', ['coalesce', ['get', 'n'], 1]] } as never })
  } else setData(map, CTX_IDS.camSrc, fc)
  addCtxLayer(map, groupLayer(CTX_IDS.camGroup, CTX_IDS.camSrc, 'cluster-cam', ground, 6))
  // live first, offline last when tiles compete for the same spot
  addCtxLayer(map, iconLayer(CTX_IDS.camIcons, CTX_IDS.camSrc, ground, 9, ['case', ['==', ['get', 'live'], 1], 0, ['==', ['get', 'off'], 1], 2, 1], ['==', ['get', 'off'], 1]))
  applyGround(map, [CTX_IDS.camGroup, CTX_IDS.camIcons], ground, 'cluster-cam')
}
export const removeCameras = (map: maplibregl.Map) => drop(map, [CTX_IDS.camIcons, CTX_IDS.camGroup], CTX_IDS.camSrc)

/** A map-look change without a style swap: point the layers at the other ground's tiles. */
function applyGround(map: maplibregl.Map, [group, icons]: [string, string], ground: Ground, glyph: 'cluster-cam' | 'cluster-crime') {
  try {
    map.setLayoutProperty(group, 'icon-image', iconName(glyph, ground))
    map.setLayoutProperty(icons, 'icon-image', imageExpr(ground))
    map.setPaintProperty(group, 'text-color', ground === 'd' ? '#e8edf5' : '#1d2533')
    map.setPaintProperty(group, 'text-halo-color', ground === 'd' ? 'rgba(8,11,18,0.92)' : 'rgba(255,255,255,0.95)')
    reseat(map, group)
    reseat(map, icons)
  } catch { /* style mid-swap */ }
}

/* ── crime ────────────────────────────────────────────────────────────────── */

export function crimeFeatures(r: CrimeReply | null): GeoJSON.FeatureCollection {
  if (!r || r.mode !== 'incidents') return EMPTY
  return {
    type: 'FeatureCollection',
    features: r.incidents.map((c, i) => ({ type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { i, cell: 0, g: crimeGlyph(c.type), v: c.cat === 'violent' ? 1 : 0 } })),
  }
}

export function ensureCrime(map: maplibregl.Map, fc: GeoJSON.FeatureCollection, light: boolean) {
  if (!map.style) return
  const ground: Ground = light ? 'l' : 'd'
  ensureContextIcons(map, ground)
  if (!map.getSource(CTX_IDS.crimeSrc)) map.addSource(CTX_IDS.crimeSrc, { type: 'geojson', data: fc, cluster: true, clusterMaxZoom: CRIME_CLUSTER_MAX_ZOOM, clusterRadius: 40 })
  else setData(map, CTX_IDS.crimeSrc, fc)
  addCtxLayer(map, groupLayer(CTX_IDS.crimeGroup, CTX_IDS.crimeSrc, 'cluster-crime', ground, 11))
  addCtxLayer(map, iconLayer(CTX_IDS.crimeIcons, CTX_IDS.crimeSrc, ground, 12, ['case', ['==', ['get', 'v'], 1], 0, 1], false))
  applyGround(map, [CTX_IDS.crimeGroup, CTX_IDS.crimeIcons], ground, 'cluster-crime')
}
export const removeCrime = (map: maplibregl.Map) => drop(map, [CTX_IDS.crimeIcons, CTX_IDS.crimeGroup], CTX_IDS.crimeSrc)

/** Zoom that opens a cluster (or a coverage cell) under a press. */
export async function expansionZoom(map: maplibregl.Map, src: string, f: maplibregl.MapGeoJSONFeature): Promise<number> {
  const id = Number(f.properties?.cluster_id)
  const now = map.getZoom()
  if (!Number.isFinite(id)) return Math.min(now + 2, 18)
  try {
    const z = await (map.getSource(src) as maplibregl.GeoJSONSource).getClusterExpansionZoom(id)
    return Math.min(Math.max(z, now + 1), 18)
  } catch { return Math.min(now + 2, 18) }
}

/* ── investor presence: grid squares (a cell IS a square), never a dot ───── */

const SQ = 'mxd-ctx-sq'
const SQ_RING = 'mxd-ctx-sq-ring'

/** Two SDF squares (filled + ring) tinted by the layer. */
function ensureSquares(map: maplibregl.Map) {
  if (typeof document === 'undefined') return
  const draw = (ring: boolean) => {
    const px = 48
    const c = document.createElement('canvas')
    c.width = px; c.height = px
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#fff'
    ctx.strokeStyle = '#fff'
    if (ring) { ctx.lineWidth = 5; ctx.strokeRect(6, 6, px - 12, px - 12) } else ctx.fillRect(4, 4, px - 8, px - 8)
    return ctx.getImageData(0, 0, px, px)
  }
  for (const [name, ring] of [[SQ, false], [SQ_RING, true]] as const) {
    if (map.hasImage(name)) continue
    const img = draw(ring)
    if (img) { try { map.addImage(name, img, { sdf: true, pixelRatio: 2 }) } catch { /* concurrent */ } }
  }
}

export function presenceData(r: PresenceReply | null): GeoJSON.FeatureCollection {
  return r && r.mode === 'cells' ? presenceFeatures(r.cells) : EMPTY
}

/** Square scale for a component at a zoom: the grid cell's own scale, sqrt by count (24 px image). */
const squareSize = (prop: 'pr' | 'er', max: number) => ['interpolate', ['linear'], ['zoom'], 9.5, ['*', ['get', prop], max * 0.55], 12, ['*', ['get', prop], max], 15, ['*', ['get', prop], max * 1.5]] as never

export function ensurePresence(map: maplibregl.Map, fc: GeoJSON.FeatureCollection, view: PresenceView) {
  if (!map.style) return
  ensureSquares(map)
  if (!map.getSource(CTX_IDS.presSrc)) map.addSource(CTX_IDS.presSrc, { type: 'geojson', data: fc })
  else setData(map, CTX_IDS.presSrc, fc)
  const common = { 'icon-allow-overlap': true, 'icon-ignore-placement': true } as const
  // Entity ownership: a square outline (a current state), under the purchases square.
  addCtxLayer(map, {
    id: CTX_IDS.presEntity, type: 'symbol', source: CTX_IDS.presSrc, filter: ['>', ['get', 'e'], 0] as never,
    layout: { ...common, 'icon-image': SQ_RING, 'icon-size': squareSize('er', 1.3) },
    paint: { 'icon-color': PRESENCE_COLORS.entity, 'icon-opacity': 0.85 },
  })
  // Investor purchases: a filled square (events in the window).
  addCtxLayer(map, {
    id: CTX_IDS.presBuys, type: 'symbol', source: CTX_IDS.presSrc, filter: ['>', ['get', 'p'], 0] as never,
    layout: { ...common, 'icon-image': SQ, 'icon-size': squareSize('pr', 0.95) },
    paint: { 'icon-color': PRESENCE_COLORS.purchases, 'icon-opacity': 0.6 },
  })
  map.setLayoutProperty(CTX_IDS.presEntity, 'visibility', view === 'purchases' ? 'none' : 'visible')
  map.setLayoutProperty(CTX_IDS.presBuys, 'visibility', view === 'entity' ? 'none' : 'visible')
}
export const removePresence = (map: maplibregl.Map) => drop(map, [CTX_IDS.presBuys, CTX_IDS.presEntity], CTX_IDS.presSrc)
