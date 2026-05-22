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
    tileUrl: CARTO_VOYAGER_NOLABELS_RASTER_TILES,
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
  | 'midnight'
  | 'blueprint'
  | 'light_street'
  | 'terrain'
  | 'minimal_black'
  | 'acquisition_radar'
  | 'matrix'

export type MapStyleMode = CommandMapThemeId

type ThemePaintVariant =
  | 'satellite'
  | 'dark_ops'
  | 'red_ops'
  | 'midnight'
  | 'blueprint'
  | 'light_street'
  | 'terrain'
  | 'minimal_black'
  | 'acquisition_radar'
  | 'matrix'

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

const sharedPinPalette = {
  not_contacted: '#94a3b8',
  contacted: '#4d8fff',
  new_reply: '#62d3ff',
  positive_intent: '#30d5c8',
  asking_price_provided: '#facc15',
  negotiating: '#b188ff',
  hot: '#f59e0b',
  issue: '#ff6b63',
  blocked: '#ff6b63',
  suppressed: '#ff6b63',
  wrong_number: '#ff6b63',
  queued: '#4d8fff',
  scheduled: '#38bdf8',
  ready: '#22d3ee',
  active: '#22d3ee',
  sent: '#4d8fff',
  delivered: '#22c55e',
}

export const commandMapThemes: Record<CommandMapThemeId, CommandMapThemeDefinition> = {
  satellite: {
    id: 'satellite',
    label: 'Satellite',
    mode: 'basemap',
    baseStyleId: 'satellite',
    mapStyleObject: SATELLITE_MAP_STYLE,
    style: SATELLITE_MAP_STYLE,
    pinPalette: sharedPinPalette,
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
    fallbackThemeId: 'minimal_black',
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
    baseStyleId: 'overlay_red_ops',
    mapStyleObject: RED_OPS_MAP_STYLE,
    style: RED_OPS_MAP_STYLE,
    pinPalette: {
      ...sharedPinPalette,
      contacted: '#5aa9ff',
      new_reply: '#62d9ff',
      positive_intent: '#42e7c6',
      asking_price_provided: '#ffd76a',
    },
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
    fallbackThemeId: 'minimal_black',
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
    baseStyleId: 'overlay_executive',
    mapStyleObject: EXECUTIVE_MAP_STYLE,
    style: EXECUTIVE_MAP_STYLE,
    pinPalette: {
      ...sharedPinPalette,
      contacted: '#ff7d72',
      new_reply: '#ff9b8d',
      positive_intent: '#ffb86a',
      negotiating: '#ff7373',
      asking_price_provided: '#ffd166',
    },
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
    fallbackThemeId: 'minimal_black',
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
  midnight: {
    id: 'midnight',
    label: 'Executive',
    mode: 'overlay',
    baseStyleId: 'overlay_blueprint',
    mapStyleObject: BLUEPRINT_MAP_STYLE,
    style: BLUEPRINT_MAP_STYLE,
    pinPalette: {
      ...sharedPinPalette,
      contacted: '#dcbf74',
      new_reply: '#f1d992',
      positive_intent: '#d2b36a',
      negotiating: '#bfa46b',
      hot: '#f5de9c',
    },
    clusterPalette: {
      glow: 'rgba(109, 147, 255, 0.16)',
      core: '#09111f',
      stroke: 'rgba(126, 172, 255, 0.94)',
      label: '#f5f7ff',
      halo: 'rgba(6, 9, 18, 0.94)',
    },
    overlayClassName: 'nx-icm--theme-midnight',
    supportsTerrain: false,
    supportsSatellite: false,
    isHighContrast: false,
    fallbackThemeId: 'dark_ops',
    cardTheme: {
      '--nx-card-accent': '#dcbf74',
      '--nx-card-accent-rgb': '220, 191, 116',
      '--nx-card-accent-soft': 'rgba(220, 191, 116, 0.18)',
      '--nx-card-shell-top': 'rgba(8, 18, 42, 0.97)',
      '--nx-card-shell-bottom': 'rgba(5, 12, 31, 0.95)',
      '--nx-card-border': 'rgba(220, 191, 116, 0.22)',
      '--nx-card-glow': 'rgba(220, 191, 116, 0.18)',
      '--nx-card-shadow': 'rgba(3, 8, 24, 0.6)',
      '--nx-card-tile': 'rgba(129, 155, 255, 0.05)',
      '--nx-card-tile-border': 'rgba(183, 200, 255, 0.08)',
      '--nx-card-message': 'rgba(255, 255, 255, 0.038)',
      '--nx-card-live': '#f3ddb0',
      '--nx-card-input': 'rgba(7, 16, 38, 0.84)',
    },
    heatmapStops: ['rgba(0,0,0,0)', '#111d4a', '#274e7c', '#4dd2c0', '#f1f6ff'],
    soldCompColor: '#f97316',
    buyerAccent: '#78c8ff',
    baseStyleTone: 'midnight',
  },
  blueprint: {
    id: 'blueprint',
    label: 'Blueprint',
    mode: 'overlay',
    baseStyleId: 'overlay_monochrome',
    mapStyleObject: OVERLAY_DARK_MAP_STYLE,
    style: OVERLAY_DARK_MAP_STYLE,
    pinPalette: {
      ...sharedPinPalette,
      not_contacted: '#5d8f9a',
      contacted: '#4bc8d8',
      new_reply: '#73ecf5',
      positive_intent: '#46e0cc',
      asking_price_provided: '#a7f2f8',
    },
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
    pinPalette: {
      ...sharedPinPalette,
      not_contacted: '#64748b',
      contacted: '#2563eb',
      new_reply: '#0ea5e9',
      positive_intent: '#059669',
      asking_price_provided: '#ca8a04',
      negotiating: '#7c3aed',
    },
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
    pinPalette: {
      ...sharedPinPalette,
      contacted: '#2c7be5',
      new_reply: '#0ea5e9',
      positive_intent: '#22c55e',
      asking_price_provided: '#eab308',
      negotiating: '#8b5cf6',
    },
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
  minimal_black: {
    id: 'minimal_black',
    label: 'Monochrome',
    mode: 'overlay',
    baseStyleId: 'overlay_dark',
    mapStyleObject: MONOCHROME_MAP_STYLE,
    style: MONOCHROME_MAP_STYLE,
    pinPalette: {
      ...sharedPinPalette,
      not_contacted: '#b8c0cb',
      contacted: '#c9d1dc',
      new_reply: '#dce3eb',
      positive_intent: '#e2e8f0',
      negotiating: '#c3cbd6',
      hot: '#f1f5f9',
    },
    clusterPalette: {
      glow: 'rgba(255, 255, 255, 0.08)',
      core: '#040506',
      stroke: 'rgba(164, 180, 199, 0.82)',
      label: '#f8fafc',
      halo: 'rgba(3, 4, 5, 0.96)',
    },
    overlayClassName: 'nx-icm--theme-minimal-black',
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
    baseStyleTone: 'minimal_black',
  },
  acquisition_radar: {
    id: 'acquisition_radar',
    label: 'Night Vision',
    mode: 'overlay',
    baseStyleId: 'overlay_night_vision',
    mapStyleObject: NIGHT_VISION_MAP_STYLE,
    style: NIGHT_VISION_MAP_STYLE,
    pinPalette: {
      ...sharedPinPalette,
      contacted: '#51d6ff',
      new_reply: '#7cf7ff',
      positive_intent: '#72ffb2',
      asking_price_provided: '#d3ff7a',
    },
    clusterPalette: {
      glow: 'rgba(69, 255, 181, 0.14)',
      core: '#081513',
      stroke: 'rgba(114, 255, 178, 0.88)',
      label: '#e8fff2',
      halo: 'rgba(5, 11, 9, 0.94)',
    },
    overlayClassName: 'nx-icm--theme-acquisition-radar',
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
    baseStyleTone: 'acquisition_radar',
  },
  matrix: {
    id: 'matrix',
    label: 'Matrix',
    mode: 'overlay',
    baseStyleId: 'overlay_matrix',
    mapStyleObject: MATRIX_MAP_STYLE,
    style: MATRIX_MAP_STYLE,
    pinPalette: {
      ...sharedPinPalette,
      not_contacted: '#4f6758',
      contacted: '#0ee08c',
      new_reply: '#4dffb6',
      positive_intent: '#00ff88',
      asking_price_provided: '#c8ff4d',
      negotiating: '#9d7cff',
      issue: '#ff3b3b',
      blocked: '#ff3b3b',
      suppressed: '#ff3b3b',
      wrong_number: '#ff3b3b',
    },
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
    fallbackThemeId: 'minimal_black',
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

export const COMMAND_MAP_THEME_OPTIONS = Object.values(commandMapThemes)

export const getCommandMapTheme = (themeId: CommandMapThemeId): CommandMapThemeDefinition =>
  commandMapThemes[themeId] ?? commandMapThemes.dark_ops

export const getCommandMapThemeStyle = (themeId: CommandMapThemeId): StyleSource =>
  getCommandMapTheme(themeId).style

export const getCommandMapBaseStyleId = (themeId: CommandMapThemeId): CommandMapBaseStyleId =>
  getCommandMapTheme(themeId).baseStyleId

export const isCommandMapBasemapTheme = (themeId: CommandMapThemeId): boolean =>
  getCommandMapTheme(themeId).mode === 'basemap'
