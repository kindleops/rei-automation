import type maplibregl from 'maplibre-gl'

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
    tileUrl: CARTO_DARK_NOLABELS_RASTER_TILES,
    attribution: 'CARTO',
  },
  executive: {
    label: 'Executive',
    tileUrl: CARTO_VOYAGER_NOLABELS_RASTER_TILES,
    attribution: 'CARTO',
  },
  blueprint: {
    label: 'Blueprint',
    tileUrl: CARTO_DARK_NOLABELS_RASTER_TILES,
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
    tileUrl: CARTO_DARK_NOLABELS_RASTER_TILES,
    attribution: 'CARTO',
  },
} satisfies Record<string, MapStyleRegistryEntry>

const SATELLITE_MAP_STYLE = buildRasterStyle('satellite', 'satellite', MAP_STYLES.satellite)
const TERRAIN_MAP_STYLE = buildRasterStyle('terrain', 'terrain', MAP_STYLES.terrain)
const OVERLAY_DARK_MAP_STYLE = buildRasterStyle('overlay_dark', 'overlay-dark', MAP_STYLES.dark)
const RED_OPS_MAP_STYLE = buildRasterStyle('overlay_red_ops', 'overlay-red-ops', MAP_STYLES.redOps)
const EXECUTIVE_MAP_STYLE = buildRasterStyle('overlay_executive', 'overlay-executive', MAP_STYLES.executive)
const BLUEPRINT_MAP_STYLE = buildRasterStyle('overlay_blueprint', 'overlay-blueprint', MAP_STYLES.blueprint)
const LIGHT_STREET_MAP_STYLE = buildRasterStyle('light_street', 'light-street', MAP_STYLES.lightStreet)
const MONOCHROME_MAP_STYLE = buildRasterStyle('overlay_monochrome', 'overlay-monochrome', MAP_STYLES.monochrome)
const NIGHT_VISION_MAP_STYLE = buildRasterStyle('overlay_night_vision', 'overlay-night-vision', MAP_STYLES.nightVision)
const MATRIX_MAP_STYLE = buildRasterStyle('overlay_matrix', 'overlay-matrix', MAP_STYLES.matrix)

export type CommandMapThemeId =
  | 'satellite'
  | 'dark_ops'
  | 'red_ops'
  | 'executive'
  | 'blueprint'
  | 'light_street'
  | 'terrain'
  | 'monochrome'
  | 'night_vision'
  | 'matrix'

export type LegacyCommandMapThemeId =
  | 'midnight'
  | 'minimal_black'
  | 'acquisition_radar'

export type MapStyleMode = CommandMapThemeId

type ThemePaintVariant = CommandMapThemeId
type StyleSource = maplibregl.StyleSpecification

export type CommandMapThemeMode = 'basemap' | 'overlay'

export type CommandMapBaseStyleId =
  | 'satellite'
  | 'terrain'
  | 'overlay_dark'
  | 'overlay_red_ops'
  | 'overlay_executive'
  | 'overlay_blueprint'
  | 'light_street'
  | 'overlay_monochrome'
  | 'overlay_night_vision'
  | 'overlay_matrix'

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
  night_vision: {
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

export const commandMapThemes: Record<CommandMapThemeId, CommandMapThemeDefinition> = {
  satellite: {
    id: 'satellite',
    label: 'Satellite',
    mode: 'basemap',
    baseStyleId: 'satellite',
    mapStyleObject: SATELLITE_MAP_STYLE,
    style: SATELLITE_MAP_STYLE,
    accentColor: '#e5edf8',
    pinPalette: PIN_PALETTES.satellite,
    clusterPalette: {
      glow: 'rgba(214, 229, 248, 0.24)',
      core: '#11161c',
      stroke: 'rgba(229, 237, 248, 0.96)',
      label: '#f4f7fb',
      halo: 'rgba(12, 16, 22, 0.92)',
    },
    overlayClassName: 'nx-icm--theme-satellite',
    supportsTerrain: false,
    supportsSatellite: true,
    isHighContrast: false,
    fallbackThemeId: 'monochrome',
    cardTheme: {
      '--nx-card-accent': '#e5edf8',
      '--nx-card-accent-rgb': '229, 237, 248',
      '--nx-card-accent-soft': 'rgba(229, 237, 248, 0.12)',
      '--nx-card-shell-top': 'rgba(14, 16, 18, 0.9)',
      '--nx-card-shell-bottom': 'rgba(10, 12, 14, 0.84)',
      '--nx-card-border': 'rgba(218, 230, 244, 0.12)',
      '--nx-card-glow': 'rgba(16, 18, 20, 0.2)',
      '--nx-card-shadow': 'rgba(0, 0, 0, 0.52)',
      '--nx-card-tile': 'rgba(255, 255, 255, 0.03)',
      '--nx-card-tile-border': 'rgba(255, 255, 255, 0.07)',
      '--nx-card-message': 'rgba(255, 255, 255, 0.026)',
      '--nx-card-live': '#f4f7fb',
      '--nx-card-input': 'rgba(18, 20, 22, 0.8)',
    },
    heatmapStops: ['rgba(0,0,0,0)', '#31444f', '#5f8c95', '#c2aa6b', '#eedfb0'],
    soldCompColor: '#ef4444',
    buyerAccent: '#f0b25a',
    baseStyleTone: 'satellite',
  },

  dark_ops: {
    id: 'dark_ops',
    label: 'Dark',
    mode: 'overlay',
    baseStyleId: 'overlay_dark',
    mapStyleObject: OVERLAY_DARK_MAP_STYLE,
    style: OVERLAY_DARK_MAP_STYLE,
    accentColor: '#63d7ff',
    pinPalette: PIN_PALETTES.dark_ops,
    clusterPalette: {
      glow: 'rgba(82, 196, 255, 0.18)',
      core: '#09121d',
      stroke: 'rgba(98, 217, 255, 0.94)',
      label: '#eaf7ff',
      halo: 'rgba(8, 12, 18, 0.94)',
    },
    overlayClassName: 'nx-icm--theme-dark-ops',
    supportsTerrain: false,
    supportsSatellite: false,
    isHighContrast: false,
    fallbackThemeId: 'monochrome',
    cardTheme: {
      '--nx-card-accent': '#63d7ff',
      '--nx-card-accent-rgb': '99, 215, 255',
      '--nx-card-accent-soft': 'rgba(99, 215, 255, 0.18)',
      '--nx-card-shell-top': 'rgba(8, 14, 24, 0.96)',
      '--nx-card-shell-bottom': 'rgba(5, 10, 18, 0.94)',
      '--nx-card-border': 'rgba(132, 191, 255, 0.18)',
      '--nx-card-glow': 'rgba(42, 118, 255, 0.22)',
      '--nx-card-shadow': 'rgba(4, 12, 28, 0.58)',
      '--nx-card-tile': 'rgba(255, 255, 255, 0.045)',
      '--nx-card-tile-border': 'rgba(167, 204, 255, 0.08)',
      '--nx-card-message': 'rgba(255, 255, 255, 0.038)',
      '--nx-card-live': '#68d9ff',
      '--nx-card-input': 'rgba(10, 16, 28, 0.82)',
    },
    heatmapStops: ['rgba(0,0,0,0)', '#0c2434', '#1683a6', '#4cd0b0', '#9ff5cb'],
    soldCompColor: '#ef4444',
    buyerAccent: '#f0b25a',
    baseStyleTone: 'dark_ops',
  },

  red_ops: {
    id: 'red_ops',
    label: 'Red Ops',
    mode: 'overlay',
    baseStyleId: 'overlay_red_ops',
    mapStyleObject: RED_OPS_MAP_STYLE,
    style: RED_OPS_MAP_STYLE,
    accentColor: '#ff4d4d',
    pinPalette: PIN_PALETTES.red_ops,
    clusterPalette: {
      glow: 'rgba(255, 107, 99, 0.18)',
      core: '#16090d',
      stroke: 'rgba(255, 129, 122, 0.92)',
      label: '#fff2ee',
      halo: 'rgba(14, 6, 8, 0.96)',
    },
    overlayClassName: 'nx-icm--theme-red-ops',
    supportsTerrain: false,
    supportsSatellite: false,
    isHighContrast: true,
    fallbackThemeId: 'monochrome',
    cardTheme: {
      '--nx-card-accent': '#ff4d4d',
      '--nx-card-accent-rgb': '255, 77, 77',
      '--nx-card-accent-soft': 'rgba(255, 107, 99, 0.16)',
      '--nx-card-shell-top': 'rgba(15, 8, 10, 0.97)',
      '--nx-card-shell-bottom': 'rgba(10, 5, 8, 0.95)',
      '--nx-card-border': 'rgba(255, 118, 118, 0.2)',
      '--nx-card-glow': 'rgba(191, 29, 29, 0.28)',
      '--nx-card-shadow': 'rgba(24, 3, 5, 0.62)',
      '--nx-card-tile': 'rgba(255, 107, 99, 0.045)',
      '--nx-card-tile-border': 'rgba(255, 137, 128, 0.1)',
      '--nx-card-message': 'rgba(255, 255, 255, 0.03)',
      '--nx-card-live': '#ff4d4d',
      '--nx-card-input': 'rgba(18, 10, 14, 0.84)',
    },
    heatmapStops: ['rgba(0,0,0,0)', '#5b1015', '#c43e35', '#ff8e45', '#ffd67a'],
    soldCompColor: '#ff6b63',
    buyerAccent: '#ff9c6e',
    baseStyleTone: 'red_ops',
  },

  executive: {
    id: 'executive',
    label: 'Executive',
    mode: 'overlay',
    baseStyleId: 'overlay_executive',
    mapStyleObject: EXECUTIVE_MAP_STYLE,
    style: EXECUTIVE_MAP_STYLE,
    accentColor: '#dcbf74',
    pinPalette: PIN_PALETTES.executive,
    clusterPalette: {
      glow: 'rgba(220, 191, 116, 0.16)',
      core: '#111014',
      stroke: 'rgba(220, 191, 116, 0.94)',
      label: '#fff9e8',
      halo: 'rgba(6, 6, 10, 0.94)',
    },
    overlayClassName: 'nx-icm--theme-executive',
    supportsTerrain: false,
    supportsSatellite: false,
    isHighContrast: false,
    fallbackThemeId: 'dark_ops',
    cardTheme: {
      '--nx-card-accent': '#dcbf74',
      '--nx-card-accent-rgb': '220, 191, 116',
      '--nx-card-accent-soft': 'rgba(220, 191, 116, 0.18)',
      '--nx-card-shell-top': 'rgba(16, 15, 18, 0.97)',
      '--nx-card-shell-bottom': 'rgba(8, 8, 12, 0.95)',
      '--nx-card-border': 'rgba(220, 191, 116, 0.22)',
      '--nx-card-glow': 'rgba(220, 191, 116, 0.18)',
      '--nx-card-shadow': 'rgba(3, 3, 8, 0.6)',
      '--nx-card-tile': 'rgba(220, 191, 116, 0.05)',
      '--nx-card-tile-border': 'rgba(220, 191, 116, 0.1)',
      '--nx-card-message': 'rgba(255, 255, 255, 0.038)',
      '--nx-card-live': '#f3ddb0',
      '--nx-card-input': 'rgba(10, 10, 14, 0.84)',
    },
    heatmapStops: ['rgba(0,0,0,0)', '#221c10', '#705f32', '#dcbf74', '#fff4c2'],
    soldCompColor: '#f97316',
    buyerAccent: '#dcbf74',
    baseStyleTone: 'executive',
  },

  blueprint: {
    id: 'blueprint',
    label: 'Blueprint',
    mode: 'overlay',
    baseStyleId: 'overlay_blueprint',
    mapStyleObject: BLUEPRINT_MAP_STYLE,
    style: BLUEPRINT_MAP_STYLE,
    accentColor: '#56d9e8',
    pinPalette: PIN_PALETTES.blueprint,
    clusterPalette: {
      glow: 'rgba(80, 204, 255, 0.18)',
      core: '#071c26',
      stroke: 'rgba(103, 224, 255, 0.94)',
      label: '#dff8ff',
      halo: 'rgba(3, 11, 18, 0.94)',
    },
    overlayClassName: 'nx-icm--theme-blueprint',
    supportsTerrain: false,
    supportsSatellite: false,
    isHighContrast: false,
    fallbackThemeId: 'dark_ops',
    cardTheme: {
      '--nx-card-accent': '#56d9e8',
      '--nx-card-accent-rgb': '86, 217, 232',
      '--nx-card-accent-soft': 'rgba(86, 217, 232, 0.2)',
      '--nx-card-shell-top': 'rgba(6, 23, 30, 0.97)',
      '--nx-card-shell-bottom': 'rgba(4, 15, 21, 0.95)',
      '--nx-card-border': 'rgba(122, 214, 255, 0.18)',
      '--nx-card-glow': 'rgba(29, 120, 170, 0.22)',
      '--nx-card-shadow': 'rgba(2, 10, 18, 0.6)',
      '--nx-card-tile': 'rgba(105, 215, 255, 0.05)',
      '--nx-card-tile-border': 'rgba(172, 233, 255, 0.08)',
      '--nx-card-message': 'rgba(255, 255, 255, 0.038)',
      '--nx-card-live': '#8ff2fa',
      '--nx-card-input': 'rgba(7, 19, 28, 0.84)',
    },
    heatmapStops: ['rgba(0,0,0,0)', '#0a3148', '#1c668f', '#57c0d9', '#d4fbff'],
    soldCompColor: '#f87171',
    buyerAccent: '#83e6ff',
    baseStyleTone: 'blueprint',
  },

  light_street: {
    id: 'light_street',
    label: 'Light Street',
    mode: 'basemap',
    baseStyleId: 'light_street',
    mapStyleObject: LIGHT_STREET_MAP_STYLE,
    style: LIGHT_STREET_MAP_STYLE,
    accentColor: '#1d4ed8',
    pinPalette: PIN_PALETTES.light_street,
    clusterPalette: {
      glow: 'rgba(37, 99, 235, 0.14)',
      core: '#ffffff',
      stroke: 'rgba(37, 99, 235, 0.82)',
      label: '#0f172a',
      halo: 'rgba(255, 255, 255, 0.96)',
    },
    overlayClassName: 'nx-icm--theme-light-street',
    supportsTerrain: false,
    supportsSatellite: false,
    isHighContrast: true,
    fallbackThemeId: 'satellite',
    cardTheme: {
      '--nx-card-accent': '#1d4ed8',
      '--nx-card-accent-rgb': '29, 78, 216',
      '--nx-card-accent-soft': 'rgba(29, 78, 216, 0.12)',
      '--nx-card-shell-top': 'rgba(255, 255, 255, 0.96)',
      '--nx-card-shell-bottom': 'rgba(244, 248, 252, 0.96)',
      '--nx-card-border': 'rgba(59, 130, 246, 0.18)',
      '--nx-card-glow': 'rgba(37, 99, 235, 0.14)',
      '--nx-card-shadow': 'rgba(15, 23, 42, 0.12)',
      '--nx-card-tile': 'rgba(15, 23, 42, 0.03)',
      '--nx-card-tile-border': 'rgba(37, 99, 235, 0.08)',
      '--nx-card-message': 'rgba(15, 23, 42, 0.03)',
      '--nx-card-live': '#1d4ed8',
      '--nx-card-input': 'rgba(255, 255, 255, 0.94)',
    },
    heatmapStops: ['rgba(0,0,0,0)', '#dbeafe', '#93c5fd', '#60a5fa', '#1d4ed8'],
    soldCompColor: '#dc2626',
    buyerAccent: '#2563eb',
    baseStyleTone: 'light_street',
  },

  terrain: {
    id: 'terrain',
    label: 'Terrain',
    mode: 'basemap',
    baseStyleId: 'terrain',
    mapStyleObject: TERRAIN_MAP_STYLE,
    style: TERRAIN_MAP_STYLE,
    accentColor: '#b7d86c',
    pinPalette: PIN_PALETTES.terrain,
    clusterPalette: {
      glow: 'rgba(34, 197, 94, 0.16)',
      core: '#13161b',
      stroke: 'rgba(196, 255, 125, 0.92)',
      label: '#f6fee7',
      halo: 'rgba(14, 15, 17, 0.94)',
    },
    overlayClassName: 'nx-icm--theme-terrain',
    supportsTerrain: true,
    supportsSatellite: false,
    isHighContrast: false,
    fallbackThemeId: 'satellite',
    cardTheme: {
      '--nx-card-accent': '#b7d86c',
      '--nx-card-accent-rgb': '183, 216, 108',
      '--nx-card-accent-soft': 'rgba(183, 216, 108, 0.16)',
      '--nx-card-shell-top': 'rgba(14, 17, 14, 0.95)',
      '--nx-card-shell-bottom': 'rgba(11, 14, 10, 0.93)',
      '--nx-card-border': 'rgba(190, 223, 121, 0.18)',
      '--nx-card-glow': 'rgba(93, 125, 36, 0.22)',
      '--nx-card-shadow': 'rgba(10, 12, 9, 0.56)',
      '--nx-card-tile': 'rgba(195, 223, 124, 0.05)',
      '--nx-card-tile-border': 'rgba(214, 240, 152, 0.08)',
      '--nx-card-message': 'rgba(255, 255, 255, 0.03)',
      '--nx-card-live': '#d3f191',
      '--nx-card-input': 'rgba(13, 17, 12, 0.84)',
    },
    heatmapStops: ['rgba(0,0,0,0)', '#2f3e1f', '#6f8847', '#c0c96b', '#f2f7c9'],
    soldCompColor: '#f97316',
    buyerAccent: '#d4ff7d',
    baseStyleTone: 'terrain',
  },

  monochrome: {
    id: 'monochrome',
    label: 'Monochrome',
    mode: 'overlay',
    baseStyleId: 'overlay_monochrome',
    mapStyleObject: MONOCHROME_MAP_STYLE,
    style: MONOCHROME_MAP_STYLE,
    accentColor: '#cdd6e0',
    pinPalette: PIN_PALETTES.monochrome,
    clusterPalette: {
      glow: 'rgba(255, 255, 255, 0.08)',
      core: '#040506',
      stroke: 'rgba(164, 180, 199, 0.82)',
      label: '#f8fafc',
      halo: 'rgba(3, 4, 5, 0.96)',
    },
    overlayClassName: 'nx-icm--theme-monochrome',
    supportsTerrain: false,
    supportsSatellite: false,
    isHighContrast: true,
    fallbackThemeId: 'satellite',
    cardTheme: {
      '--nx-card-accent': '#cdd6e0',
      '--nx-card-accent-rgb': '205, 214, 224',
      '--nx-card-accent-soft': 'rgba(211, 221, 232, 0.12)',
      '--nx-card-shell-top': 'rgba(8, 10, 12, 0.97)',
      '--nx-card-shell-bottom': 'rgba(4, 5, 7, 0.95)',
      '--nx-card-border': 'rgba(148, 163, 184, 0.18)',
      '--nx-card-glow': 'rgba(148, 163, 184, 0.14)',
      '--nx-card-shadow': 'rgba(0, 0, 0, 0.58)',
      '--nx-card-tile': 'rgba(255, 255, 255, 0.035)',
      '--nx-card-tile-border': 'rgba(255, 255, 255, 0.07)',
      '--nx-card-message': 'rgba(255, 255, 255, 0.03)',
      '--nx-card-live': '#eef2f6',
      '--nx-card-input': 'rgba(8, 10, 12, 0.86)',
    },
    heatmapStops: ['rgba(0,0,0,0)', '#0b1220', '#1f2937', '#4b5563', '#e5e7eb'],
    soldCompColor: '#f87171',
    buyerAccent: '#d3dde8',
    baseStyleTone: 'monochrome',
  },

  night_vision: {
    id: 'night_vision',
    label: 'Night Vision',
    mode: 'overlay',
    baseStyleId: 'overlay_night_vision',
    mapStyleObject: NIGHT_VISION_MAP_STYLE,
    style: NIGHT_VISION_MAP_STYLE,
    accentColor: '#72ffb2',
    pinPalette: PIN_PALETTES.night_vision,
    clusterPalette: {
      glow: 'rgba(69, 255, 181, 0.14)',
      core: '#081513',
      stroke: 'rgba(114, 255, 178, 0.88)',
      label: '#e8fff2',
      halo: 'rgba(5, 11, 9, 0.94)',
    },
    overlayClassName: 'nx-icm--theme-night-vision',
    supportsTerrain: false,
    supportsSatellite: false,
    isHighContrast: false,
    fallbackThemeId: 'dark_ops',
    cardTheme: {
      '--nx-card-accent': '#72ffb2',
      '--nx-card-accent-rgb': '114, 255, 178',
      '--nx-card-accent-soft': 'rgba(114, 255, 178, 0.16)',
      '--nx-card-shell-top': 'rgba(6, 19, 15, 0.97)',
      '--nx-card-shell-bottom': 'rgba(4, 12, 10, 0.94)',
      '--nx-card-border': 'rgba(114, 255, 178, 0.18)',
      '--nx-card-glow': 'rgba(41, 163, 110, 0.2)',
      '--nx-card-shadow': 'rgba(1, 10, 8, 0.58)',
      '--nx-card-tile': 'rgba(114, 255, 178, 0.05)',
      '--nx-card-tile-border': 'rgba(160, 255, 205, 0.08)',
      '--nx-card-message': 'rgba(255, 255, 255, 0.03)',
      '--nx-card-live': '#c8ffe0',
      '--nx-card-input': 'rgba(8, 18, 15, 0.84)',
    },
    heatmapStops: ['rgba(0,0,0,0)', '#113127', '#1f6f5a', '#4cdd9b', '#d8ffe8'],
    soldCompColor: '#f87171',
    buyerAccent: '#72ffb2',
    baseStyleTone: 'night_vision',
  },

  matrix: {
    id: 'matrix',
    label: 'Matrix',
    mode: 'overlay',
    baseStyleId: 'overlay_matrix',
    mapStyleObject: MATRIX_MAP_STYLE,
    style: MATRIX_MAP_STYLE,
    accentColor: '#00ff88',
    pinPalette: PIN_PALETTES.matrix,
    clusterPalette: {
      glow: 'rgba(0, 255, 136, 0.14)',
      core: '#020805',
      stroke: 'rgba(0, 255, 136, 0.9)',
      label: '#d8ffe8',
      halo: 'rgba(2, 8, 5, 0.96)',
    },
    overlayClassName: 'nx-icm--theme-matrix',
    supportsTerrain: false,
    supportsSatellite: false,
    isHighContrast: true,
    fallbackThemeId: 'monochrome',
    cardTheme: {
      '--nx-card-accent': '#00ff88',
      '--nx-card-accent-rgb': '0, 255, 136',
      '--nx-card-accent-soft': 'rgba(0, 255, 136, 0.14)',
      '--nx-card-shell-top': 'rgba(2, 8, 5, 0.97)',
      '--nx-card-shell-bottom': 'rgba(0, 0, 0, 0.95)',
      '--nx-card-border': 'rgba(0, 196, 106, 0.18)',
      '--nx-card-glow': 'rgba(0, 255, 136, 0.16)',
      '--nx-card-shadow': 'rgba(0, 0, 0, 0.64)',
      '--nx-card-tile': 'rgba(0, 255, 136, 0.04)',
      '--nx-card-tile-border': 'rgba(73, 255, 171, 0.08)',
      '--nx-card-message': 'rgba(216, 255, 232, 0.03)',
      '--nx-card-live': '#c6ffd9',
      '--nx-card-input': 'rgba(1, 8, 5, 0.84)',
    },
    heatmapStops: ['rgba(0,0,0,0)', '#072114', '#0b5834', '#00c46a', '#d8ffe8'],
    soldCompColor: '#ff6767',
    buyerAccent: '#00ff88',
    baseStyleTone: 'matrix',
  },
}

export const legacyCommandMapThemeAliases: Record<LegacyCommandMapThemeId, CommandMapThemeId> = {
  midnight: 'executive',
  minimal_black: 'monochrome',
  acquisition_radar: 'night_vision',
}

export const normalizeCommandMapThemeId = (
  themeId: CommandMapThemeId | LegacyCommandMapThemeId | string | null | undefined,
): CommandMapThemeId => {
  if (!themeId) return 'dark_ops'
  if (themeId in commandMapThemes) return themeId as CommandMapThemeId
  if (themeId in legacyCommandMapThemeAliases) return legacyCommandMapThemeAliases[themeId as LegacyCommandMapThemeId]
  return 'dark_ops'
}

export const COMMAND_MAP_THEME_OPTIONS = Object.values(commandMapThemes)

export const getCommandMapTheme = (
  themeId: CommandMapThemeId | LegacyCommandMapThemeId | string,
): CommandMapThemeDefinition => commandMapThemes[normalizeCommandMapThemeId(themeId)]

export const getCommandMapThemeStyle = (
  themeId: CommandMapThemeId | LegacyCommandMapThemeId | string,
): StyleSource => getCommandMapTheme(themeId).style

export const getCommandMapBaseStyleId = (
  themeId: CommandMapThemeId | LegacyCommandMapThemeId | string,
): CommandMapBaseStyleId => getCommandMapTheme(themeId).baseStyleId

export const isCommandMapBasemapTheme = (
  themeId: CommandMapThemeId | LegacyCommandMapThemeId | string,
): boolean => getCommandMapTheme(themeId).mode === 'basemap'