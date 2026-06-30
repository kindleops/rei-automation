import type maplibregl from 'maplibre-gl'
import {
  CARTO_VECTOR_DARK_STYLE_URL,
  CARTO_VECTOR_LIGHT_STYLE_URL,
  getMapVisualPreset,
  normalizeMapVisualPresetId,
  type MapVisualPresetId,
} from './map-visual-presets'

const CARTO_DARK_RASTER_TILES = [
  'https://a.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png',
  'https://b.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png',
  'https://c.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png',
  'https://d.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png',
]

const CARTO_LIGHT_RASTER_TILES = [
  'https://a.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png',
  'https://b.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png',
  'https://c.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png',
  'https://d.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png',
]

const CARTO_DARK_NOLABELS_RASTER_TILES = [
  'https://a.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}.png',
  'https://b.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}.png',
  'https://c.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}.png',
  'https://d.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}.png',
]

const CARTO_LIGHT_NOLABELS_RASTER_TILES = [
  'https://a.basemaps.cartocdn.com/rastertiles/light_nolabels/{z}/{x}/{y}.png',
  'https://b.basemaps.cartocdn.com/rastertiles/light_nolabels/{z}/{x}/{y}.png',
  'https://c.basemaps.cartocdn.com/rastertiles/light_nolabels/{z}/{x}/{y}.png',
  'https://d.basemaps.cartocdn.com/rastertiles/light_nolabels/{z}/{x}/{y}.png',
]

const CARTO_VOYAGER_NOLABELS_RASTER_TILES = [
  'https://a.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png',
  'https://b.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png',
  'https://c.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png',
  'https://d.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png',
]

const ESRI_SATELLITE_TILES = [
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
]

const OPENTOPO_TILES = [
  'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
  'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
  'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
]

type MapStyleRegistryEntry = {
  label: string
  tileUrl: string[]
  attribution: string
  maxzoom?: number
}

const buildRasterStyle = (
  sourceId: string,
  layerId: string,
  entry: MapStyleRegistryEntry,
): maplibregl.StyleSpecification => ({
  version: 8,
  sources: {
    [sourceId]: {
      type: 'raster',
      tiles: entry.tileUrl,
      tileSize: 256,
      attribution: entry.attribution,
      maxzoom: entry.maxzoom ?? 20,
    },
  },
  layers: [
    {
      id: layerId,
      type: 'raster',
      source: sourceId,
    },
  ],
})

const MAP_STYLES = {
  satellite: {
    label: 'Satellite',
    tileUrl: ESRI_SATELLITE_TILES,
    attribution: 'Esri World Imagery',
    maxzoom: 19,
  },
  dark: {
    label: 'Dark',
    tileUrl: CARTO_DARK_RASTER_TILES,
    attribution: 'CARTO',
  },
  redOps: {
    label: 'Red Ops',
    tileUrl: ESRI_SATELLITE_TILES,
    attribution: 'Esri World Imagery',
    maxzoom: 19,
  },
  executive: {
    label: 'Executive',
    tileUrl: CARTO_VOYAGER_NOLABELS_RASTER_TILES,
    attribution: 'CARTO',
  },
  blueprint: {
    label: 'Blueprint',
    tileUrl: CARTO_DARK_RASTER_TILES,
    attribution: 'CARTO',
  },
  lightStreet: {
    label: 'Light Street',
    tileUrl: CARTO_LIGHT_RASTER_TILES,
    attribution: 'CARTO',
  },
  terrain: {
    label: 'Terrain',
    tileUrl: OPENTOPO_TILES,
    attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
    maxzoom: 17,
  },
  monochrome: {
    label: 'Monochrome',
    tileUrl: CARTO_LIGHT_NOLABELS_RASTER_TILES,
    attribution: 'CARTO',
  },
  nightVision: {
    label: 'Night Vision',
    tileUrl: CARTO_DARK_NOLABELS_RASTER_TILES,
    attribution: 'CARTO',
  },
  matrix: {
    label: 'Matrix',
    tileUrl: CARTO_DARK_RASTER_TILES,
    attribution: 'CARTO',
  },
} satisfies Record<string, MapStyleRegistryEntry>

const SATELLITE_MAP_STYLE = buildRasterStyle('satellite', 'satellite', MAP_STYLES.satellite)
const TERRAIN_MAP_STYLE = buildRasterStyle('terrain', 'terrain', MAP_STYLES.terrain)
export type CommandMapThemeId = MapVisualPresetId

export type LegacyCommandMapThemeId =
  | 'midnight'
  | 'minimal_black'
  | 'acquisition_radar'
  | 'night_vision'

export type MapStyleMode = CommandMapThemeId

type ThemePaintVariant = CommandMapThemeId
type StyleSource = maplibregl.StyleSpecification | string

export type CommandMapThemeMode = 'basemap' | 'overlay'

export type CommandMapBaseStyleId =
  | 'satellite'
  | 'terrain'
  | 'vector_dark'
  | 'vector_light'

export type CommandMapThemeDefinition = {
  id: CommandMapThemeId
  label: string
  mode: CommandMapThemeMode
  baseStyleId: CommandMapBaseStyleId
  mapStyleUrl?: string
  mapStyleObject?: maplibregl.StyleSpecification
  /** Primary accent for pin fallbacks and map chrome */
  accentColor: string
  pinPalette: Record<string, string>
  clusterPalette: {
    glow: string
    core: string
    stroke: string
    label: string
    halo: string
  }
  overlayClassName: string
  supportsTerrain: boolean
  supportsSatellite: boolean
  isHighContrast: boolean
  fallbackThemeId: CommandMapThemeId
  cardTheme: Record<string, string>
  heatmapStops: string[]
  soldCompColor: string
  buyerAccent: string
  baseStyleTone: ThemePaintVariant
  style: StyleSource
}

const PIN_PALETTES: Record<CommandMapThemeId, Record<string, string>> = {
  satellite: {
    not_contacted: '#8fa4bc',
    contacted: '#6b9fd4',
    new_reply: '#8ec8f0',
    positive_intent: '#6db89a',
    asking_price_provided: '#d4b86a',
    negotiating: '#a88fd4',
    hot: '#e8b84a',
    issue: '#e06060',
    blocked: '#e06060',
    suppressed: '#e06060',
    wrong_number: '#e06060',
    queued: '#7aaee0',
    scheduled: '#8ec4e8',
    ready: '#7ec8d8',
    active: '#7ec8d8',
    sent: '#7aaee0',
    delivered: '#6db88a',
  },
  dark_ops: {
    not_contacted: '#7a8fa8',
    contacted: '#5aa9ff',
    new_reply: '#62d9ff',
    positive_intent: '#42e7c6',
    asking_price_provided: '#ffd76a',
    negotiating: '#b188ff',
    hot: '#f5b84c',
    issue: '#ff6b63',
    blocked: '#ff6b63',
    suppressed: '#ff6b63',
    wrong_number: '#ff6b63',
    queued: '#5aa9ff',
    scheduled: '#4db8ff',
    ready: '#38d8f0',
    active: '#38d8f0',
    sent: '#5aa9ff',
    delivered: '#3ee89a',
  },
  red_ops: {
    not_contacted: '#9a5050',
    contacted: '#ff5a50',
    new_reply: '#ff7a6e',
    positive_intent: '#ff9a5a',
    asking_price_provided: '#ffc44d',
    negotiating: '#ff4d6a',
    hot: '#ff3344',
    issue: '#ff1a1a',
    blocked: '#ff1a1a',
    suppressed: '#ff1a1a',
    wrong_number: '#ff1a1a',
    queued: '#ff6b5a',
    scheduled: '#ff8578',
    ready: '#ffaa7a',
    active: '#ffaa7a',
    sent: '#ff6e60',
    delivered: '#ff8f4a',
  },
  executive: {
    not_contacted: '#6e6555',
    contacted: '#b8954a',
    new_reply: '#d4b76a',
    positive_intent: '#c9a85c',
    asking_price_provided: '#f0d080',
    negotiating: '#a88850',
    hot: '#f5de9c',
    issue: '#d45a5a',
    blocked: '#d45a5a',
    suppressed: '#d45a5a',
    wrong_number: '#d45a5a',
    queued: '#b8954a',
    scheduled: '#c9a85c',
    ready: '#dcc070',
    active: '#dcc070',
    sent: '#b8954a',
    delivered: '#c4a85a',
  },
  blueprint: {
    not_contacted: '#4d7a8a',
    contacted: '#3ec8e0',
    new_reply: '#5ee8f8',
    positive_intent: '#3ee0c8',
    asking_price_provided: '#8ef0ff',
    negotiating: '#5cc8e8',
    hot: '#7ee8ff',
    issue: '#f08080',
    blocked: '#f08080',
    suppressed: '#f08080',
    wrong_number: '#f08080',
    queued: '#3ec8e0',
    scheduled: '#50d8f0',
    ready: '#68e8f8',
    active: '#68e8f8',
    sent: '#3ec8e0',
    delivered: '#40e0c0',
  },
  light_street: {
    not_contacted: '#64748b',
    contacted: '#2563eb',
    new_reply: '#0ea5e9',
    positive_intent: '#059669',
    asking_price_provided: '#ca8a04',
    negotiating: '#7c3aed',
    hot: '#d97706',
    issue: '#dc2626',
    blocked: '#dc2626',
    suppressed: '#dc2626',
    wrong_number: '#dc2626',
    queued: '#2563eb',
    scheduled: '#0284c7',
    ready: '#0891b2',
    active: '#0891b2',
    sent: '#2563eb',
    delivered: '#059669',
  },
  terrain: {
    not_contacted: '#7a8a5a',
    contacted: '#5c8d4c',
    new_reply: '#68a68e',
    positive_intent: '#74c365',
    asking_price_provided: '#c8a85d',
    negotiating: '#8ea476',
    hot: '#e0c060',
    issue: '#d66b5f',
    blocked: '#d66b5f',
    suppressed: '#d66b5f',
    wrong_number: '#d66b5f',
    queued: '#5c8d4c',
    scheduled: '#6a9a5a',
    ready: '#7aaa68',
    active: '#7aaa68',
    sent: '#5c8d4c',
    delivered: '#74c365',
  },
  monochrome: {
    not_contacted: '#8a9098',
    contacted: '#b0b8c4',
    new_reply: '#d0d8e4',
    positive_intent: '#c8d0dc',
    asking_price_provided: '#e0e6ee',
    negotiating: '#a8b0bc',
    hot: '#f0f4f8',
    issue: '#d07070',
    blocked: '#d07070',
    suppressed: '#d07070',
    wrong_number: '#d07070',
    queued: '#b0b8c4',
    scheduled: '#c0c8d4',
    ready: '#d0d8e4',
    active: '#d0d8e4',
    sent: '#b0b8c4',
    delivered: '#c8d0dc',
  },
  radar_night: {
    not_contacted: '#3a6a58',
    contacted: '#51d6ff',
    new_reply: '#7cf7ff',
    positive_intent: '#72ffb2',
    asking_price_provided: '#d3ff7a',
    negotiating: '#5ee8b0',
    hot: '#c8ff7a',
    issue: '#ff7a7a',
    blocked: '#ff7a7a',
    suppressed: '#ff7a7a',
    wrong_number: '#ff7a7a',
    queued: '#51d6ff',
    scheduled: '#62e8c8',
    ready: '#7cf7cf',
    active: '#7cf7cf',
    sent: '#51d6ff',
    delivered: '#72ffb2',
  },
  matrix: {
    not_contacted: '#3a5a48',
    contacted: '#0ee08c',
    new_reply: '#4dffb6',
    positive_intent: '#00ff88',
    asking_price_provided: '#c8ff4d',
    negotiating: '#9d7cff',
    hot: '#c8ff4d',
    issue: '#ff3b3b',
    blocked: '#ff3b3b',
    suppressed: '#ff3b3b',
    wrong_number: '#ff3b3b',
    queued: '#0ee08c',
    scheduled: '#2ef0a0',
    ready: '#4dffb6',
    active: '#4dffb6',
    sent: '#0ee08c',
    delivered: '#00ff88',
  },
}

const hexToRgbTuple = (hex: string): string => {
  const normalized = hex.replace('#', '')
  const full = normalized.length === 3 ? normalized.split('').map((c) => c + c).join('') : normalized
  return `${parseInt(full.slice(0, 2), 16)}, ${parseInt(full.slice(2, 4), 16)}, ${parseInt(full.slice(4, 6), 16)}`
}

const buildCardThemeFromPreset = (presetId: CommandMapThemeId): Record<string, string> => {
  const preset = getMapVisualPreset(presetId)
  const iface = preset.interface
  return {
    '--nx-card-accent': iface.accent,
    '--nx-card-accent-rgb': hexToRgbTuple(iface.accent),
    '--nx-card-accent-soft': iface.ambientGlow,
    '--nx-card-shell-top': iface.glassTintStrong,
    '--nx-card-shell-bottom': iface.glassTint,
    '--nx-card-border': iface.glassBorder,
    '--nx-card-glow': iface.ambientGlow,
    '--nx-card-shadow': 'rgba(0, 0, 0, 0.56)',
    '--nx-card-tile': 'rgba(255, 255, 255, 0.04)',
    '--nx-card-tile-border': iface.glassBorder,
    '--nx-card-message': 'rgba(255, 255, 255, 0.03)',
    '--nx-card-live': iface.activityAccent,
    '--nx-card-input': iface.glassTint,
  }
}

const clusterPaletteFromPreset = (presetId: CommandMapThemeId) => {
  const preset = getMapVisualPreset(presetId)
  const b = preset.basemap
  const m = preset.markers
  return {
    glow: m.clusterTint,
    core: b.land,
    stroke: m.inactiveStroke,
    label: b.labelPrimary,
    halo: b.labelHalo,
  }
}

export const commandMapThemes: Record<CommandMapThemeId, CommandMapThemeDefinition> = {
  satellite: {
    id: 'satellite',
    label: 'Satellite Recon',
    mode: 'basemap',
    baseStyleId: 'satellite',
    mapStyleObject: SATELLITE_MAP_STYLE,
    style: SATELLITE_MAP_STYLE,
    accentColor: getMapVisualPreset('satellite').interface.accent,
    pinPalette: PIN_PALETTES.satellite,
    clusterPalette: clusterPaletteFromPreset('satellite'),
    overlayClassName: 'nx-icm--theme-satellite',
    supportsTerrain: false,
    supportsSatellite: true,
    isHighContrast: false,
    fallbackThemeId: 'monochrome',
    cardTheme: buildCardThemeFromPreset('satellite'),
    heatmapStops: ['rgba(0,0,0,0)', '#31444f', '#5f8c95', '#c2aa6b', '#eedfb0'],
    soldCompColor: '#ef4444',
    buyerAccent: '#49C8FF',
    baseStyleTone: 'satellite',
  },

  dark_ops: {
    id: 'dark_ops',
    label: 'DarkOps',
    mode: 'basemap',
    baseStyleId: 'vector_dark',
    mapStyleUrl: CARTO_VECTOR_DARK_STYLE_URL,
    style: CARTO_VECTOR_DARK_STYLE_URL,
    accentColor: getMapVisualPreset('dark_ops').interface.accent,
    pinPalette: PIN_PALETTES.dark_ops,
    clusterPalette: clusterPaletteFromPreset('dark_ops'),
    overlayClassName: 'nx-icm--theme-dark-ops',
    supportsTerrain: false,
    supportsSatellite: false,
    isHighContrast: false,
    fallbackThemeId: 'monochrome',
    cardTheme: buildCardThemeFromPreset('dark_ops'),
    heatmapStops: ['rgba(0,0,0,0)', '#0c2434', '#1683a6', '#4cd0b0', '#9ff5cb'],
    soldCompColor: '#ef4444',
    buyerAccent: '#719CFF',
    baseStyleTone: 'dark_ops',
  },

  red_ops: {
    id: 'red_ops',
    label: 'RedOps',
    mode: 'basemap',
    baseStyleId: 'vector_dark',
    mapStyleUrl: CARTO_VECTOR_DARK_STYLE_URL,
    style: CARTO_VECTOR_DARK_STYLE_URL,
    accentColor: getMapVisualPreset('red_ops').interface.accent,
    pinPalette: PIN_PALETTES.red_ops,
    clusterPalette: clusterPaletteFromPreset('red_ops'),
    overlayClassName: 'nx-icm--theme-red-ops',
    supportsTerrain: false,
    supportsSatellite: false,
    isHighContrast: true,
    fallbackThemeId: 'monochrome',
    cardTheme: buildCardThemeFromPreset('red_ops'),
    heatmapStops: ['rgba(0,0,0,0)', '#5b1015', '#c43e35', '#ff8e45', '#ffd67a'],
    soldCompColor: '#ff6b63',
    buyerAccent: '#FF9B87',
    baseStyleTone: 'red_ops',
  },

  executive: {
    id: 'executive',
    label: 'Executive',
    mode: 'basemap',
    baseStyleId: 'vector_dark',
    mapStyleUrl: CARTO_VECTOR_DARK_STYLE_URL,
    style: CARTO_VECTOR_DARK_STYLE_URL,
    accentColor: getMapVisualPreset('executive').interface.accent,
    pinPalette: PIN_PALETTES.executive,
    clusterPalette: clusterPaletteFromPreset('executive'),
    overlayClassName: 'nx-icm--theme-executive',
    supportsTerrain: false,
    supportsSatellite: false,
    isHighContrast: false,
    fallbackThemeId: 'dark_ops',
    cardTheme: buildCardThemeFromPreset('executive'),
    heatmapStops: ['rgba(0,0,0,0)', '#221c10', '#705f32', '#dcbf74', '#fff4c2'],
    soldCompColor: '#f97316',
    buyerAccent: '#D7B66A',
    baseStyleTone: 'executive',
  },

  blueprint: {
    id: 'blueprint',
    label: 'Blueprint',
    mode: 'basemap',
    baseStyleId: 'vector_dark',
    mapStyleUrl: CARTO_VECTOR_DARK_STYLE_URL,
    style: CARTO_VECTOR_DARK_STYLE_URL,
    accentColor: getMapVisualPreset('blueprint').interface.accent,
    pinPalette: PIN_PALETTES.blueprint,
    clusterPalette: clusterPaletteFromPreset('blueprint'),
    overlayClassName: 'nx-icm--theme-blueprint',
    supportsTerrain: false,
    supportsSatellite: false,
    isHighContrast: false,
    fallbackThemeId: 'dark_ops',
    cardTheme: buildCardThemeFromPreset('blueprint'),
    heatmapStops: ['rgba(0,0,0,0)', '#0a3148', '#1c668f', '#57c0d9', '#d4fbff'],
    soldCompColor: '#f87171',
    buyerAccent: '#26D7FF',
    baseStyleTone: 'blueprint',
  },

  light_street: {
    id: 'light_street',
    label: 'Light Street',
    mode: 'basemap',
    baseStyleId: 'vector_light',
    mapStyleUrl: CARTO_VECTOR_LIGHT_STYLE_URL,
    style: CARTO_VECTOR_LIGHT_STYLE_URL,
    accentColor: getMapVisualPreset('light_street').interface.accent,
    pinPalette: PIN_PALETTES.light_street,
    clusterPalette: clusterPaletteFromPreset('light_street'),
    overlayClassName: 'nx-icm--theme-light-street',
    supportsTerrain: false,
    supportsSatellite: false,
    isHighContrast: true,
    fallbackThemeId: 'satellite',
    cardTheme: buildCardThemeFromPreset('light_street'),
    heatmapStops: ['rgba(0,0,0,0)', '#dbeafe', '#93c5fd', '#60a5fa', '#1d4ed8'],
    soldCompColor: '#dc2626',
    buyerAccent: '#247CFF',
    baseStyleTone: 'light_street',
  },

  terrain: {
    id: 'terrain',
    label: 'Terrain',
    mode: 'basemap',
    baseStyleId: 'terrain',
    mapStyleObject: TERRAIN_MAP_STYLE,
    style: TERRAIN_MAP_STYLE,
    accentColor: getMapVisualPreset('terrain').interface.accent,
    pinPalette: PIN_PALETTES.terrain,
    clusterPalette: clusterPaletteFromPreset('terrain'),
    overlayClassName: 'nx-icm--theme-terrain',
    supportsTerrain: true,
    supportsSatellite: false,
    isHighContrast: false,
    fallbackThemeId: 'satellite',
    cardTheme: buildCardThemeFromPreset('terrain'),
    heatmapStops: ['rgba(0,0,0,0)', '#2f3e1f', '#6f8847', '#c0c96b', '#f2f7c9'],
    soldCompColor: '#f97316',
    buyerAccent: '#45C4A2',
    baseStyleTone: 'terrain',
  },

  monochrome: {
    id: 'monochrome',
    label: 'Monochrome',
    mode: 'basemap',
    baseStyleId: 'vector_dark',
    mapStyleUrl: CARTO_VECTOR_DARK_STYLE_URL,
    style: CARTO_VECTOR_DARK_STYLE_URL,
    accentColor: getMapVisualPreset('monochrome').interface.accent,
    pinPalette: PIN_PALETTES.monochrome,
    clusterPalette: clusterPaletteFromPreset('monochrome'),
    overlayClassName: 'nx-icm--theme-monochrome',
    supportsTerrain: false,
    supportsSatellite: false,
    isHighContrast: true,
    fallbackThemeId: 'satellite',
    cardTheme: buildCardThemeFromPreset('monochrome'),
    heatmapStops: ['rgba(0,0,0,0)', '#0b1220', '#1f2937', '#4b5563', '#e5e7eb'],
    soldCompColor: '#f87171',
    buyerAccent: '#CBD6E4',
    baseStyleTone: 'monochrome',
  },

  radar_night: {
    id: 'radar_night',
    label: 'Radar Night',
    mode: 'basemap',
    baseStyleId: 'vector_dark',
    mapStyleUrl: CARTO_VECTOR_DARK_STYLE_URL,
    style: CARTO_VECTOR_DARK_STYLE_URL,
    accentColor: getMapVisualPreset('radar_night').interface.accent,
    pinPalette: PIN_PALETTES.radar_night,
    clusterPalette: clusterPaletteFromPreset('radar_night'),
    overlayClassName: 'nx-icm--theme-radar-night',
    supportsTerrain: false,
    supportsSatellite: false,
    isHighContrast: false,
    fallbackThemeId: 'dark_ops',
    cardTheme: buildCardThemeFromPreset('radar_night'),
    heatmapStops: ['rgba(0,0,0,0)', '#113127', '#1f6f5a', '#4cdd9b', '#d8ffe8'],
    soldCompColor: '#f87171',
    buyerAccent: '#48E2A0',
    baseStyleTone: 'radar_night',
  },

  matrix: {
    id: 'matrix',
    label: 'Matrix',
    mode: 'basemap',
    baseStyleId: 'vector_dark',
    mapStyleUrl: CARTO_VECTOR_DARK_STYLE_URL,
    style: CARTO_VECTOR_DARK_STYLE_URL,
    accentColor: getMapVisualPreset('matrix').interface.accent,
    pinPalette: PIN_PALETTES.matrix,
    clusterPalette: clusterPaletteFromPreset('matrix'),
    overlayClassName: 'nx-icm--theme-matrix',
    supportsTerrain: false,
    supportsSatellite: false,
    isHighContrast: true,
    fallbackThemeId: 'monochrome',
    cardTheme: buildCardThemeFromPreset('matrix'),
    heatmapStops: ['rgba(0,0,0,0)', '#072114', '#0b5834', '#00c46a', '#d8ffe8'],
    soldCompColor: '#ff6767',
    buyerAccent: '#2FF58A',
    baseStyleTone: 'matrix',
  },
}

export const legacyCommandMapThemeAliases: Record<LegacyCommandMapThemeId, CommandMapThemeId> = {
  midnight: 'executive',
  minimal_black: 'monochrome',
  acquisition_radar: 'radar_night',
  night_vision: 'radar_night',
}

export const normalizeCommandMapThemeId = (
  themeId: CommandMapThemeId | LegacyCommandMapThemeId | string | null | undefined,
): CommandMapThemeId => normalizeMapVisualPresetId(themeId)

export const COMMAND_MAP_THEME_OPTIONS = Object.values(commandMapThemes)

export const getCommandMapTheme = (
  themeId: CommandMapThemeId | LegacyCommandMapThemeId | string,
): CommandMapThemeDefinition => commandMapThemes[normalizeCommandMapThemeId(themeId)]

export const getCommandMapThemeStyle = (
  themeId: CommandMapThemeId | LegacyCommandMapThemeId | string,
): StyleSource => {
  const theme = getCommandMapTheme(themeId)
  return theme.mapStyleUrl ?? theme.style
}

export const getCommandMapBaseStyleId = (
  themeId: CommandMapThemeId | LegacyCommandMapThemeId | string,
): CommandMapBaseStyleId => getCommandMapTheme(themeId).baseStyleId

export const isCommandMapBasemapTheme = (
  themeId: CommandMapThemeId | LegacyCommandMapThemeId | string,
): boolean => getCommandMapTheme(themeId).mode === 'basemap'