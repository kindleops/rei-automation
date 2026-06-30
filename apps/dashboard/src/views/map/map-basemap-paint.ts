/**
 * Applies canonical visual-preset colors to MapLibre vector basemap layers.
 */

import type maplibregl from 'maplibre-gl'
import {
  getMapVisualPreset,
  normalizeMapVisualPresetId,
  type MapVisualPreset,
  type MapVisualPresetBasemap,
} from './map-visual-presets'

type StyleLayerLike = {
  id?: string
  type?: string
  'source-layer'?: string
  paint?: Record<string, unknown>
}

const lower = (value: string | undefined) => (value ?? '').toLowerCase()

const isWaterToken = (token: string) =>
  token.includes('water') || token.includes('river') || token.includes('ocean') || token.includes('marine')

const isParkToken = (token: string) =>
  token.includes('park') || token.includes('landcover') || token.includes('landuse') || token.includes('green')

const isBuildingToken = (token: string) =>
  token.includes('building') || token.includes('structure')

const isBoundaryToken = (token: string) =>
  token.includes('boundary') || token.includes('admin') || token.includes('border')

const isRoadToken = (token: string) =>
  token.includes('road') || token.includes('transport') || token.includes('street') || token.includes('highway')

const roadTier = (token: string): 'highway' | 'primary' | 'secondary' | 'local' | 'other' => {
  if (token.includes('motorway') || token.includes('trunk') || token.includes('highway')) return 'highway'
  if (token.includes('primary') || token.includes('main')) return 'primary'
  if (token.includes('secondary') || token.includes('tertiary')) return 'secondary'
  if (isRoadToken(token)) return 'local'
  return 'other'
}

const isPlaceLabel = (token: string) =>
  token.includes('place') || token.includes('city') || token.includes('town') || token.includes('village') || token.includes('neighbourhood') || token.includes('neighborhood')

const isRoadLabel = (token: string) =>
  token.includes('road') || token.includes('street') || token.includes('highway') || token.includes('transport')

const isPoiToken = (token: string) => token.includes('poi')

const isPostalToken = (token: string) => token.includes('postal') || token.includes('zip')

const roadColorForTier = (tier: ReturnType<typeof roadTier>, b: MapVisualPresetBasemap): string => {
  switch (tier) {
    case 'highway': return b.highway
    case 'primary': return b.roadPrimary
    case 'secondary': return b.roadSecondary
    case 'local': return b.roadLocal
    default: return b.roadSecondary
  }
}

const labelColorForToken = (token: string, b: MapVisualPresetBasemap): string => {
  if (isPlaceLabel(token) || isRoadLabel(token)) return b.labelPrimary
  if (isPoiToken(token)) return b.poi
  if (isPostalToken(token)) return b.labelSecondary
  if (isWaterToken(token)) return b.labelSecondary
  return b.labelSecondary
}

export const applyVisualPresetBasemapPaint = (
  map: maplibregl.Map,
  presetId: string,
  isCustomLayer: (id?: string) => boolean,
): void => {
  const preset = getMapVisualPreset(normalizeMapVisualPresetId(presetId))
  const b = preset.basemap
  const layers = map.getStyle()?.layers ?? []

  layers.forEach((layer) => {
    const typedLayer = layer as StyleLayerLike
    if (!typedLayer.id || isCustomLayer(typedLayer.id)) return
    const id = lower(typedLayer.id)
    const sourceLayer = lower(typedLayer['source-layer'])
    const token = `${id} ${sourceLayer}`

    try {
      if (typedLayer.type === 'background') {
        map.setPaintProperty(typedLayer.id, 'background-color', b.background)
      }

      if (typedLayer.type === 'fill') {
        let fillColor = b.land
        if (isWaterToken(token)) fillColor = b.water
        else if (isParkToken(token)) fillColor = b.park
        else if (isBuildingToken(token)) fillColor = b.building
        else if (token.includes('land') && token.includes('cover')) fillColor = b.landSecondary
        map.setPaintProperty(typedLayer.id, 'fill-color', fillColor)
        map.setPaintProperty(typedLayer.id, 'fill-opacity', b.isLight ? 0.88 : preset.id === 'terrain' ? 0.22 : 0.92)
      }

      if (typedLayer.type === 'fill-extrusion') {
        map.setPaintProperty(typedLayer.id, 'fill-extrusion-color', b.building)
        map.setPaintProperty(typedLayer.id, 'fill-extrusion-opacity', b.isLight ? 0.55 : 0.72)
      }

      if (typedLayer.type === 'line') {
        if (isBoundaryToken(token)) {
          map.setPaintProperty(typedLayer.id, 'line-color', b.boundary)
          map.setPaintProperty(typedLayer.id, 'line-opacity', 0.78)
        } else if (isRoadToken(token)) {
          const tier = roadTier(token)
          map.setPaintProperty(typedLayer.id, 'line-color', roadColorForTier(tier, b))
          map.setPaintProperty(typedLayer.id, 'line-opacity', tier === 'highway' ? 0.96 : tier === 'primary' ? 0.9 : 0.82)
          if (tier === 'highway' && typedLayer.paint && 'line-blur' in typedLayer.paint) {
            map.setPaintProperty(typedLayer.id, 'line-blur', 0.6)
          }
        } else if (isWaterToken(token)) {
          map.setPaintProperty(typedLayer.id, 'line-color', b.water)
          map.setPaintProperty(typedLayer.id, 'line-opacity', 0.7)
        } else {
          map.setPaintProperty(typedLayer.id, 'line-color', b.boundary)
          map.setPaintProperty(typedLayer.id, 'line-opacity', 0.55)
        }
      }

      if (typedLayer.type === 'symbol') {
        const textColor = labelColorForToken(token, b)
        if (typedLayer.paint && 'text-color' in typedLayer.paint) {
          map.setPaintProperty(typedLayer.id, 'text-color', textColor)
        }
        if (typedLayer.paint && 'text-halo-color' in typedLayer.paint) {
          map.setPaintProperty(typedLayer.id, 'text-halo-color', b.labelHalo)
        }
        if (typedLayer.paint && 'text-halo-width' in typedLayer.paint) {
          map.setPaintProperty(typedLayer.id, 'text-halo-width', b.isLight ? 1.2 : 1.0)
        }
        if (typedLayer.paint && 'icon-color' in typedLayer.paint) {
          map.setPaintProperty(typedLayer.id, 'icon-color', isPoiToken(token) ? b.poi : b.labelSecondary)
        }
      }

      if (typedLayer.type === 'raster') {
        applyRasterPresetPaint(map, typedLayer.id, preset)
      }
    } catch {
      // Keep map resilient when a style layer lacks a property.
    }
  })
}

const applyRasterPresetPaint = (map: maplibregl.Map, layerId: string, preset: MapVisualPreset): void => {
  const { id, basemap: b } = preset

  if (id === 'satellite') {
    map.setPaintProperty(layerId, 'raster-saturation', -0.12)
    map.setPaintProperty(layerId, 'raster-contrast', 0.14)
    map.setPaintProperty(layerId, 'raster-brightness-min', 0.05)
    map.setPaintProperty(layerId, 'raster-brightness-max', 0.94)
    map.setPaintProperty(layerId, 'raster-hue-rotate', 195)
    return
  }

  if (id === 'terrain') {
    map.setPaintProperty(layerId, 'raster-saturation', 0.12)
    map.setPaintProperty(layerId, 'raster-contrast', 0.1)
    map.setPaintProperty(layerId, 'raster-brightness-min', 0.05)
    map.setPaintProperty(layerId, 'raster-brightness-max', 0.86)
    map.setPaintProperty(layerId, 'raster-hue-rotate', 0)
    return
  }

  if (id === 'monochrome') {
    map.setPaintProperty(layerId, 'raster-saturation', -1)
    map.setPaintProperty(layerId, 'raster-contrast', 0.28)
    map.setPaintProperty(layerId, 'raster-brightness-min', 0.04)
    map.setPaintProperty(layerId, 'raster-brightness-max', 0.78)
    map.setPaintProperty(layerId, 'raster-hue-rotate', 0)
    return
  }

  // Fallback raster tint — should not be used once vector presets are active.
  map.setPaintProperty(layerId, 'raster-saturation', b.isLight ? 0 : -0.2)
  map.setPaintProperty(layerId, 'raster-contrast', 0.16)
  map.setPaintProperty(layerId, 'raster-brightness-min', 0.04)
  map.setPaintProperty(layerId, 'raster-brightness-max', 0.9)
  map.setPaintProperty(layerId, 'raster-hue-rotate', 0)
}

export const buildPresetInterfaceCssVars = (presetId: string): Record<string, string> => {
  const preset = getMapVisualPreset(normalizeMapVisualPresetId(presetId))
  const iface = preset.interface
  const markers = preset.markers
  const rgb = hexToRgbTuple(iface.accent)

  return {
    '--map-accent': iface.accent,
    '--map-accent-bright': iface.accentBright,
    '--map-accent-muted': iface.accentMuted,
    '--map-accent-soft': hexToRgba(iface.accent, 0.16),
    '--map-glass-tint': iface.glassTint,
    '--map-glass-border': iface.glassBorder,
    '--map-ambient-glow': iface.ambientGlow,
    '--map-selected-ring': iface.selectedRing,
    '--map-hover-ring': iface.hoverRing,
    '--map-selected-border': hexToRgba(iface.selectedRing, 0.88),
    '--map-menu-accent': iface.controlAccent,
    '--map-activity-accent': iface.activityAccent,
    '--map-composer-accent': iface.composerAccent,
    '--map-pin-glow': markers.clusterTint,
    '--nx-card-accent': iface.accent,
    '--nx-card-accent-rgb': rgb,
    '--nx-card-accent-soft': hexToRgba(iface.accent, 0.14),
    '--nx-card-live': iface.activityAccent,
    '--nx-card-border': iface.glassBorder,
    '--nx-card-glow': iface.ambientGlow,
    '--nx-theme-transition-ms': '340ms',
  }
}

function hexToRgbTuple(hex: string): string {
  const normalized = hex.replace('#', '')
  const full = normalized.length === 3
    ? normalized.split('').map((c) => c + c).join('')
    : normalized
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `${r}, ${g}, ${b}`
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '')
  const full = normalized.length === 3
    ? normalized.split('').map((c) => c + c).join('')
    : normalized
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}