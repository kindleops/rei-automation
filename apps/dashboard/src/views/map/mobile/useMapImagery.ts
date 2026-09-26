/**
 * Imagery add-ons that sit on top of whatever base style is loaded.
 *
 *   true colour  Satellite without the tactical colour grade (the base theme
 *           hue-rotates imagery purple): the real photo, plus Esri's road and
 *           place reference tiles — a true hybrid.
 *   labels  Roads & places over imagery. True colour uses the Esri reference
 *           tiles; the tactical imagery themes keep their own vector overlay,
 *           which this toggles.
 *   relief  Terrain shading from open elevation tiles (AWS Terrarium). With
 *           the Tilted perspective the ground is lifted into true 3D and the
 *           sky gets an atmosphere.
 *
 * Both are re-added after every style swap (the base style wipes custom
 * sources), and both sit under the property / lens layers.
 */
import { useEffect } from 'react'
import type maplibregl from 'maplibre-gl'

const LABELS_SRC = 'nx-hybrid-labels'
const ROADS_SRC = 'nx-hybrid-roads'
const DEM_SRC = 'nx-relief-dem'
const TERRAIN_SRC = 'nx-relief-terrain'
const HILLSHADE = 'nx-relief-hillshade'

const SKY_APPLIED = new WeakMap<object, boolean>()

/** Themes that carry a roads/places overlay the operator can toggle. */
export const HYBRID_THEMES = new Set(['satellite', 'red_ops'])
const TRUE_COLOR_THEME = 'satellite'
const SAT_RASTER = 'satellite'
const TRUE_COLOR_PAINT: Record<string, number> = {
  'raster-saturation': 0.08,
  'raster-contrast': 0.06,
  'raster-brightness-min': 0,
  'raster-brightness-max': 1,
  'raster-hue-rotate': 0,
}
const GRADE_ORIGINALS = new WeakMap<object, Record<string, unknown>>()

const ESRI_REF = (layer: string) => `https://services.arcgisonline.com/ArcGIS/rest/services/Reference/${layer}/MapServer/tile/{z}/{y}/{x}`
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

/** First layer we draw under: lens heat, then properties, then pins. */
function underlay(map: maplibregl.Map): string | undefined {
  for (const id of ['nx-lens-field', 'nx-lens-heat', 'prop-tiles-hit', 'prop-tiles-halo', 'map-market-aggregates-glow', 'command-pin-glow-raw']) {
    if (map.getLayer(id)) return id
  }
  return undefined
}

function removeLayer(map: maplibregl.Map, id: string) {
  try { if (map.getLayer(id)) map.removeLayer(id) } catch { /* ignore */ }
}

export interface ImageryOptions {
  labels: boolean
  trueColor: boolean
  relief: boolean
  tilted: boolean
  theme: string
  reducedMotion: boolean
}

export function useMapImagery(map: maplibregl.Map | null, epoch: number, opts: ImageryOptions) {
  const { labels, relief, tilted, theme, trueColor } = opts
  const truePhoto = trueColor && theme === TRUE_COLOR_THEME
  const esriLabels = labels && truePhoto

  useEffect(() => {
    if (!map) return
    const apply = () => {
      if (!map.style) return
      try {
        const before = underlay(map)
        // ── True colour: undo the tactical grade, remember it to restore ──
        const styleObj = map.style as object
        if (map.getLayer(SAT_RASTER)) {
          if (truePhoto) {
            if (!GRADE_ORIGINALS.has(styleObj)) {
              const orig: Record<string, unknown> = {}
              for (const k of Object.keys(TRUE_COLOR_PAINT)) orig[k] = map.getPaintProperty(SAT_RASTER, k as never)
              GRADE_ORIGINALS.set(styleObj, orig)
            }
            for (const [k, v] of Object.entries(TRUE_COLOR_PAINT)) {
              if (map.getPaintProperty(SAT_RASTER, k as never) !== v) map.setPaintProperty(SAT_RASTER, k as never, v as never)
            }
          } else if (GRADE_ORIGINALS.has(styleObj)) {
            const orig = GRADE_ORIGINALS.get(styleObj)!
            GRADE_ORIGINALS.delete(styleObj)
            for (const [k, v] of Object.entries(orig)) map.setPaintProperty(SAT_RASTER, k as never, (v ?? undefined) as never)
          }
        }
        // The theme's own vector roads/places: hidden under true colour (Esri
        // tiles replace them), otherwise they follow the labels toggle.
        const vectorVis = !truePhoto && labels ? 'visible' : 'none'
        for (const l of map.getStyle().layers ?? []) {
          if (!l.id.startsWith('nx-icm-hybrid-')) continue
          if (map.getLayoutProperty(l.id, 'visibility') !== vectorVis) map.setLayoutProperty(l.id, 'visibility', vectorVis)
        }

        // ── Esri roads + places over the true-colour photo ────────────
        if (esriLabels) {
          if (!map.getSource(ROADS_SRC)) map.addSource(ROADS_SRC, { type: 'raster', tiles: [ESRI_REF('World_Transportation')], tileSize: 256, maxzoom: 19, attribution: 'Esri' })
          if (!map.getSource(LABELS_SRC)) map.addSource(LABELS_SRC, { type: 'raster', tiles: [ESRI_REF('World_Boundaries_and_Places')], tileSize: 256, maxzoom: 19, attribution: 'Esri' })
          if (!map.getLayer(ROADS_SRC)) map.addLayer({ id: ROADS_SRC, type: 'raster', source: ROADS_SRC, paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.35, 10, 0.8, 15, 0.9], 'raster-fade-duration': 240 } }, before)
          if (!map.getLayer(LABELS_SRC)) map.addLayer({ id: LABELS_SRC, type: 'raster', source: LABELS_SRC, paint: { 'raster-opacity': 0.95, 'raster-fade-duration': 240 } }, before)
        } else {
          removeLayer(map, LABELS_SRC)
          removeLayer(map, ROADS_SRC)
        }

        // ── Relief ────────────────────────────────────────────────────
        if (relief) {
          if (!map.getSource(DEM_SRC)) map.addSource(DEM_SRC, { type: 'raster-dem', tiles: [TERRARIUM], tileSize: 256, encoding: 'terrarium', maxzoom: 15, attribution: 'Mapzen Terrain · AWS' })
          const beforeShade = map.getLayer(ROADS_SRC) ? ROADS_SRC : before
          if (!map.getLayer(HILLSHADE)) {
            map.addLayer({
              id: HILLSHADE, type: 'hillshade', source: DEM_SRC,
              paint: {
                'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 4, 0.55, 10, 0.4, 14, 0.25],
                'hillshade-shadow-color': 'rgba(0,0,0,0.55)',
                'hillshade-highlight-color': 'rgba(255,255,255,0.18)',
                'hillshade-accent-color': 'rgba(0,0,0,0.25)',
              },
            }, beforeShade)
          }
          if (tilted) {
            // A separate DEM source for terrain (MapLibre advises not sharing it with hillshade).
            if (!map.getSource(TERRAIN_SRC)) map.addSource(TERRAIN_SRC, { type: 'raster-dem', tiles: [TERRARIUM], tileSize: 256, encoding: 'terrarium', maxzoom: 14 })
            if (map.getTerrain()?.source !== TERRAIN_SRC) map.setTerrain({ source: TERRAIN_SRC, exaggeration: 1.35 })
          } else if (map.getTerrain()) {
            map.setTerrain(null)
          }
        } else {
          removeLayer(map, HILLSHADE)
          if (map.getTerrain()) map.setTerrain(null)
        }

        // Atmosphere whenever the camera is tilted — the horizon fades into sky.
        // Set once per style + tilt, so our own style events can't loop.
        const setSky = (map as unknown as { setSky?: (s: unknown) => void }).setSky
        if (typeof setSky === 'function' && SKY_APPLIED.get(styleObj) !== tilted) {
          SKY_APPLIED.set(styleObj, tilted)
          setSky.call(map, tilted
            ? { 'sky-color': '#0b1a33', 'horizon-color': '#1d3a66', 'fog-color': '#0a1222', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.2, 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 1, 12, 0] }
            : {})
        }
      } catch { /* style mid-swap: styledata will call again */ }
    }
    apply()
    map.on('styledata', apply)
    return () => { map.off('styledata', apply) }
  }, [map, epoch, esriLabels, truePhoto, labels, relief, tilted])

  // Leaving the component (e.g. desktop layout) drops terrain so desktop keeps its 2D contract.
  useEffect(() => () => {
    if (!map) return
    try { if (map.getTerrain()) map.setTerrain(null) } catch { /* ignore */ }
  }, [map])
}
