/**
 * Canonical visual preset registry for the Command Map.
 * Visual presets control appearance only — never functional map modes.
 */

export type MapBasemapFamily = 'satellite' | 'street' | 'terrain' | 'hybrid'

export type MapVisualPresetId =
  | 'satellite'
  | 'red_ops'
  | 'executive'
  | 'dark_ops'
  | 'blueprint'
  | 'radar_night'
  | 'matrix'
  | 'light_street'
  | 'terrain'
  | 'monochrome'

export type MapVisualPresetBasemap = {
  family: MapBasemapFamily
  styleId: string
  background: string
  land: string
  landSecondary: string
  water: string
  roadPrimary: string
  roadSecondary: string
  roadLocal: string
  highway: string
  highwayGlow: string
  boundary: string
  building: string
  park: string
  poi: string
  labelPrimary: string
  labelSecondary: string
  labelHalo: string
  isLight: boolean
}

export type MapVisualPresetInterface = {
  accent: string
  accentBright: string
  accentMuted: string
  glassTint: string
  glassTintStrong: string
  glassBorder: string
  specularHighlight: string
  ambientGlow: string
  selectedRing: string
  hoverRing: string
  controlAccent: string
  activityAccent: string
  composerAccent: string
}

export type MapVisualPresetMarkers = {
  bodyTint: string
  inactiveStroke: string
  iconLuminance: number
  haloHue: string
  haloOpacity: number
  selectedGlow: string
  clusterTint: string
  iconHaloColor: string
  iconHaloWidth: number
}

export type MapVisualPreset = {
  id: MapVisualPresetId
  label: string
  description: string
  basemap: MapVisualPresetBasemap
  interface: MapVisualPresetInterface
  markers: MapVisualPresetMarkers
}

export const CARTO_VECTOR_DARK_STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
export const CARTO_VECTOR_LIGHT_STYLE_URL = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
export const CARTO_VECTOR_VOYAGER_STYLE_URL = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'
export const CARTO_VECTOR_GLYPHS_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/{fontstack}/{range}.pbf'

export const MAP_VISUAL_PRESETS: Record<MapVisualPresetId, MapVisualPreset> = {
  satellite: {
    id: 'satellite',
    label: 'Satellite Recon',
    description: 'Premium satellite intelligence with cool tactical glass',
    basemap: {
      family: 'satellite',
      styleId: 'satellite',
      background: '#0c1018',
      land: '#141820',
      landSecondary: '#1a2030',
      water: '#0a1420',
      roadPrimary: '#8aa4c0',
      roadSecondary: '#6a8098',
      roadLocal: '#4a5a70',
      highway: '#b8d0e8',
      highwayGlow: 'rgba(73, 200, 255, 0.12)',
      boundary: '#5a7090',
      building: '#1e2838',
      park: '#1a2820',
      poi: '#7eb8e8',
      labelPrimary: '#f0f8ff',
      labelSecondary: '#b8d4f0',
      labelHalo: 'rgba(8, 12, 20, 0.92)',
      isLight: false,
    },
    interface: {
      accent: '#49C8FF',
      accentBright: '#B7F1FF',
      accentMuted: '#397FA5',
      glassTint: 'rgba(10, 18, 32, 0.78)',
      glassTintStrong: 'rgba(8, 14, 26, 0.88)',
      glassBorder: 'rgba(73, 200, 255, 0.22)',
      specularHighlight: 'rgba(183, 241, 255, 0.35)',
      ambientGlow: 'rgba(73, 200, 255, 0.18)',
      selectedRing: '#A7ECFF',
      hoverRing: '#7ED4FF',
      controlAccent: '#49C8FF',
      activityAccent: '#5AD8FF',
      composerAccent: '#65C7FF',
    },
    markers: {
      bodyTint: 'rgba(14, 22, 34, 0.78)',
      inactiveStroke: 'rgba(85, 200, 255, 0.45)',
      iconLuminance: 1.04,
      haloHue: '#55C8FF',
      haloOpacity: 0.22,
      selectedGlow: '#A7ECFF',
      clusterTint: 'rgba(85, 200, 255, 0.22)',
      iconHaloColor: 'rgba(0, 0, 0, 0.90)',
      iconHaloWidth: 1.8,
    },
  },

  red_ops: {
    id: 'red_ops',
    label: 'RedOps',
    description: 'Full red tactical vector operations environment',
    basemap: {
      family: 'street',
      styleId: 'vector_dark',
      background: '#090506',
      land: '#16080C',
      landSecondary: '#220A10',
      water: '#08080C',
      roadPrimary: '#A62939',
      roadSecondary: '#711725',
      roadLocal: '#48101A',
      highway: '#E44754',
      highwayGlow: 'rgba(228, 71, 84, 0.14)',
      boundary: '#8E2634',
      building: '#2A0B12',
      park: '#240D12',
      poi: '#FA8793',
      labelPrimary: '#FFF4F5',
      labelSecondary: '#FFB7BE',
      labelHalo: '#18070B',
      isLight: false,
    },
    interface: {
      accent: '#FF4055',
      accentBright: '#FF9B87',
      accentMuted: '#9E2535',
      glassTint: 'rgba(18, 6, 10, 0.84)',
      glassTintStrong: 'rgba(12, 4, 8, 0.92)',
      glassBorder: 'rgba(255, 64, 85, 0.24)',
      specularHighlight: 'rgba(255, 155, 135, 0.30)',
      ambientGlow: 'rgba(255, 64, 85, 0.20)',
      selectedRing: '#FF9A76',
      hoverRing: '#FF7078',
      controlAccent: '#FF4055',
      activityAccent: '#FF5566',
      composerAccent: '#E8356A',
    },
    markers: {
      bodyTint: 'rgba(22, 8, 12, 0.76)',
      inactiveStroke: 'rgba(255, 77, 94, 0.52)',
      iconLuminance: 1.02,
      haloHue: '#FF4D5E',
      haloOpacity: 0.20,
      selectedGlow: '#FF9A76',
      clusterTint: 'rgba(255, 77, 94, 0.20)',
      iconHaloColor: 'rgba(24, 7, 11, 0.92)',
      iconHaloWidth: 1.8,
    },
  },

  executive: {
    id: 'executive',
    label: 'Executive',
    description: 'Institutional charcoal and champagne boardroom intelligence',
    basemap: {
      family: 'street',
      styleId: 'vector_dark',
      background: '#11120F',
      land: '#1C1D19',
      landSecondary: '#242520',
      water: '#0F1718',
      roadPrimary: '#A28D62',
      roadSecondary: '#6A6250',
      roadLocal: '#444238',
      highway: '#D5B977',
      highwayGlow: 'rgba(213, 185, 119, 0.12)',
      boundary: '#74684F',
      building: '#2B2A24',
      park: '#20251D',
      poi: '#DABF83',
      labelPrimary: '#FFF8E8',
      labelSecondary: '#CFC3A5',
      labelHalo: '#12120F',
      isLight: false,
    },
    interface: {
      accent: '#D7B66A',
      accentBright: '#FFF0B0',
      accentMuted: '#7E6A43',
      glassTint: 'rgba(14, 12, 16, 0.84)',
      glassTintStrong: 'rgba(10, 9, 12, 0.92)',
      glassBorder: 'rgba(221, 189, 114, 0.22)',
      specularHighlight: 'rgba(255, 240, 176, 0.28)',
      ambientGlow: 'rgba(221, 189, 114, 0.16)',
      selectedRing: '#FFF0B3',
      hoverRing: '#E8CF8E',
      controlAccent: '#D7B66A',
      activityAccent: '#F0D080',
      composerAccent: '#E8D090',
    },
    markers: {
      bodyTint: 'rgba(16, 14, 12, 0.74)',
      inactiveStroke: 'rgba(221, 189, 114, 0.50)',
      iconLuminance: 0.96,
      haloHue: '#DDBD72',
      haloOpacity: 0.14,
      selectedGlow: '#FFF0B3',
      clusterTint: 'rgba(221, 189, 114, 0.18)',
      iconHaloColor: 'rgba(18, 18, 15, 0.90)',
      iconHaloWidth: 1.6,
    },
  },

  dark_ops: {
    id: 'dark_ops',
    label: 'DarkOps',
    description: 'Midnight navy stealth with visible street grids',
    basemap: {
      family: 'street',
      styleId: 'vector_dark',
      background: '#02050A',
      land: '#050911',
      landSecondary: '#081018',
      water: '#020307',
      roadPrimary: '#30466D',
      roadSecondary: '#1E2B42',
      roadLocal: '#111827',
      highway: '#486EA5',
      highwayGlow: 'rgba(72, 110, 165, 0.12)',
      boundary: '#253754',
      building: '#0B101A',
      park: '#07100E',
      poi: '#7C9DC8',
      labelPrimary: '#DCEAFF',
      labelSecondary: '#7289AA',
      labelHalo: '#02050A',
      isLight: false,
    },
    interface: {
      accent: '#719CFF',
      accentBright: '#C4DAFF',
      accentMuted: '#344F85',
      glassTint: 'rgba(6, 10, 20, 0.82)',
      glassTintStrong: 'rgba(4, 8, 16, 0.90)',
      glassBorder: 'rgba(113, 156, 255, 0.20)',
      specularHighlight: 'rgba(196, 218, 255, 0.28)',
      ambientGlow: 'rgba(113, 156, 255, 0.16)',
      selectedRing: '#B7D3FF',
      hoverRing: '#96B4FF',
      controlAccent: '#719CFF',
      activityAccent: '#5AA9FF',
      composerAccent: '#8098FF',
    },
    markers: {
      bodyTint: 'rgba(8, 12, 24, 0.74)',
      inactiveStroke: 'rgba(120, 158, 255, 0.48)',
      iconLuminance: 1.0,
      haloHue: '#789EFF',
      haloOpacity: 0.18,
      selectedGlow: '#B7D3FF',
      clusterTint: 'rgba(120, 158, 255, 0.18)',
      iconHaloColor: 'rgba(2, 5, 10, 0.92)',
      iconHaloWidth: 1.8,
    },
  },

  blueprint: {
    id: 'blueprint',
    label: 'Blueprint',
    description: 'Technical navy engineering and planning intelligence',
    basemap: {
      family: 'street',
      styleId: 'vector_dark',
      background: '#031427',
      land: '#071D34',
      landSecondary: '#0A2540',
      water: '#020F20',
      roadPrimary: '#2DA6CA',
      roadSecondary: '#1E6286',
      roadLocal: '#16405E',
      highway: '#69DEF4',
      highwayGlow: 'rgba(105, 222, 244, 0.14)',
      boundary: '#2483A6',
      building: '#0A2945',
      park: '#08283A',
      poi: '#53CDE7',
      labelPrimary: '#E9FCFF',
      labelSecondary: '#7DD6E8',
      labelHalo: '#031427',
      isLight: false,
    },
    interface: {
      accent: '#26D7FF',
      accentBright: '#B7F7FF',
      accentMuted: '#187B9A',
      glassTint: 'rgba(4, 18, 28, 0.84)',
      glassTintStrong: 'rgba(3, 14, 24, 0.92)',
      glassBorder: 'rgba(38, 215, 255, 0.22)',
      specularHighlight: 'rgba(183, 247, 255, 0.32)',
      ambientGlow: 'rgba(38, 215, 255, 0.18)',
      selectedRing: '#B7F7FF',
      hoverRing: '#6EE8FF',
      controlAccent: '#26D7FF',
      activityAccent: '#4DE4FF',
      composerAccent: '#3CC8F0',
    },
    markers: {
      bodyTint: 'rgba(6, 22, 34, 0.76)',
      inactiveStroke: 'rgba(38, 215, 255, 0.50)',
      iconLuminance: 1.06,
      haloHue: '#26D7FF',
      haloOpacity: 0.16,
      selectedGlow: '#B7F7FF',
      clusterTint: 'rgba(38, 215, 255, 0.18)',
      iconHaloColor: 'rgba(3, 20, 39, 0.92)',
      iconHaloWidth: 1.7,
    },
  },

  radar_night: {
    id: 'radar_night',
    label: 'Radar Night',
    description: 'Tactical green signal detection over dark street map',
    basemap: {
      family: 'street',
      styleId: 'vector_dark',
      background: '#06100E',
      land: '#0B1814',
      landSecondary: '#102018',
      water: '#040B0D',
      roadPrimary: '#3B7F62',
      roadSecondary: '#285442',
      roadLocal: '#1B352C',
      highway: '#64B98B',
      highwayGlow: 'rgba(100, 185, 139, 0.12)',
      boundary: '#376B55',
      building: '#10231C',
      park: '#0D261B',
      poi: '#6BC99A',
      labelPrimary: '#E5FFF1',
      labelSecondary: '#81BFA0',
      labelHalo: '#06100E',
      isLight: false,
    },
    interface: {
      accent: '#48E2A0',
      accentBright: '#B6FFD8',
      accentMuted: '#257B59',
      glassTint: 'rgba(6, 19, 15, 0.84)',
      glassTintStrong: 'rgba(4, 12, 10, 0.92)',
      glassBorder: 'rgba(72, 226, 160, 0.20)',
      specularHighlight: 'rgba(182, 255, 216, 0.28)',
      ambientGlow: 'rgba(72, 226, 160, 0.16)',
      selectedRing: '#B6FFD8',
      hoverRing: '#7AE8B8',
      controlAccent: '#48E2A0',
      activityAccent: '#5AE8A8',
      composerAccent: '#40D8B0',
    },
    markers: {
      bodyTint: 'rgba(8, 22, 18, 0.76)',
      inactiveStroke: 'rgba(72, 226, 160, 0.48)',
      iconLuminance: 1.02,
      haloHue: '#48E2A0',
      haloOpacity: 0.18,
      selectedGlow: '#B6FFD8',
      clusterTint: 'rgba(72, 226, 160, 0.18)',
      iconHaloColor: 'rgba(6, 16, 14, 0.92)',
      iconHaloWidth: 1.8,
    },
  },

  matrix: {
    id: 'matrix',
    label: 'Matrix',
    description: 'Computational black-emerald systems intelligence',
    basemap: {
      family: 'street',
      styleId: 'vector_dark',
      background: '#010704',
      land: '#031009',
      landSecondary: '#05140C',
      water: '#010503',
      roadPrimary: '#16803E',
      roadSecondary: '#105329',
      roadLocal: '#0B321B',
      highway: '#24C967',
      highwayGlow: 'rgba(36, 201, 103, 0.14)',
      boundary: '#146332',
      building: '#071A0E',
      park: '#052013',
      poi: '#35E67B',
      labelPrimary: '#C9FFDB',
      labelSecondary: '#62C984',
      labelHalo: '#010704',
      isLight: false,
    },
    interface: {
      accent: '#2FF58A',
      accentBright: '#B3FFD0',
      accentMuted: '#167844',
      glassTint: 'rgba(2, 10, 6, 0.86)',
      glassTintStrong: 'rgba(1, 7, 4, 0.94)',
      glassBorder: 'rgba(47, 245, 138, 0.18)',
      specularHighlight: 'rgba(179, 255, 208, 0.26)',
      ambientGlow: 'rgba(47, 245, 138, 0.16)',
      selectedRing: '#B3FFD0',
      hoverRing: '#6EFFC0',
      controlAccent: '#2FF58A',
      activityAccent: '#4DFFB6',
      composerAccent: '#40E878',
    },
    markers: {
      bodyTint: 'rgba(4, 12, 8, 0.78)',
      inactiveStroke: 'rgba(47, 245, 138, 0.48)',
      iconLuminance: 1.04,
      haloHue: '#2FF58A',
      haloOpacity: 0.18,
      selectedGlow: '#B3FFD0',
      clusterTint: 'rgba(47, 245, 138, 0.16)',
      iconHaloColor: 'rgba(1, 7, 4, 0.94)',
      iconHaloWidth: 1.8,
    },
  },

  light_street: {
    id: 'light_street',
    label: 'Light Street',
    description: 'Premium daylight field operations vector map',
    basemap: {
      family: 'street',
      styleId: 'vector_light',
      background: '#EEF2F6',
      land: '#F5F7FA',
      landSecondary: '#E8EDF2',
      water: '#BCDDF3',
      roadPrimary: '#BCCCDC',
      roadSecondary: '#DBE3EC',
      roadLocal: '#FFFFFF',
      highway: '#8FB2D7',
      highwayGlow: 'rgba(36, 124, 255, 0.08)',
      boundary: '#A7B6C7',
      building: '#DDE3EA',
      park: '#D7EBD8',
      poi: '#47698E',
      labelPrimary: '#14243A',
      labelSecondary: '#526A83',
      labelHalo: '#FFFFFF',
      isLight: true,
    },
    interface: {
      accent: '#247CFF',
      accentBright: '#65C7FF',
      accentMuted: '#7098C9',
      glassTint: 'rgba(255, 255, 255, 0.88)',
      glassTintStrong: 'rgba(248, 251, 255, 0.96)',
      glassBorder: 'rgba(36, 124, 255, 0.20)',
      specularHighlight: 'rgba(101, 199, 255, 0.24)',
      ambientGlow: 'rgba(36, 124, 255, 0.10)',
      selectedRing: '#247CFF',
      hoverRing: '#4D9AFF',
      controlAccent: '#247CFF',
      activityAccent: '#0EA5E9',
      composerAccent: '#5B7CFF',
    },
    markers: {
      bodyTint: 'rgba(255, 255, 255, 0.88)',
      inactiveStroke: 'rgba(37, 99, 235, 0.55)',
      iconLuminance: 0.92,
      haloHue: '#247CFF',
      haloOpacity: 0.10,
      selectedGlow: '#247CFF',
      clusterTint: 'rgba(37, 99, 235, 0.14)',
      iconHaloColor: 'rgba(255, 255, 255, 0.96)',
      iconHaloWidth: 1.4,
    },
  },

  terrain: {
    id: 'terrain',
    label: 'Terrain',
    description: 'Geographic land intelligence with earth-aqua accents',
    basemap: {
      family: 'terrain',
      styleId: 'terrain',
      background: '#111613',
      land: '#1a2018',
      landSecondary: '#222a1e',
      water: '#14241b',
      roadPrimary: '#93a172',
      roadSecondary: '#6a8058',
      roadLocal: '#45533a',
      highway: '#c0c96b',
      highwayGlow: 'rgba(69, 196, 162, 0.10)',
      boundary: '#667F63',
      building: '#2a3024',
      park: '#1d2818',
      poi: '#8ea476',
      labelPrimary: '#f7f5d0',
      labelSecondary: '#cfdb9c',
      labelHalo: 'rgba(14, 15, 17, 0.94)',
      isLight: false,
    },
    interface: {
      accent: '#45C4A2',
      accentBright: '#A8FFE1',
      accentMuted: '#667F63',
      glassTint: 'rgba(14, 17, 12, 0.80)',
      glassTintStrong: 'rgba(11, 14, 10, 0.88)',
      glassBorder: 'rgba(69, 196, 162, 0.20)',
      specularHighlight: 'rgba(168, 255, 225, 0.24)',
      ambientGlow: 'rgba(69, 196, 162, 0.14)',
      selectedRing: '#A8FFE1',
      hoverRing: '#72E8C8',
      controlAccent: '#45C4A2',
      activityAccent: '#5AD8B0',
      composerAccent: '#48B8C8',
    },
    markers: {
      bodyTint: 'rgba(14, 17, 12, 0.80)',
      inactiveStroke: 'rgba(69, 196, 162, 0.42)',
      iconLuminance: 1.0,
      haloHue: '#45C4A2',
      haloOpacity: 0.16,
      selectedGlow: '#A8FFE1',
      clusterTint: 'rgba(69, 196, 162, 0.16)',
      iconHaloColor: 'rgba(0, 0, 0, 0.88)',
      iconHaloWidth: 1.7,
    },
  },

  monochrome: {
    id: 'monochrome',
    label: 'Monochrome',
    description: 'Reduced-noise grayscale review mode',
    basemap: {
      family: 'street',
      styleId: 'vector_dark',
      background: '#060708',
      land: '#0c0d0f',
      landSecondary: '#121416',
      water: '#08090b',
      roadPrimary: '#58616e',
      roadSecondary: '#3b424c',
      roadLocal: '#2b3038',
      highway: '#8a939f',
      highwayGlow: 'rgba(203, 214, 228, 0.08)',
      boundary: '#4a525c',
      building: '#16181c',
      park: '#121416',
      poi: '#9aa5b2',
      labelPrimary: '#f0f4f8',
      labelSecondary: '#a4b0bf',
      labelHalo: '#060708',
      isLight: false,
    },
    interface: {
      accent: '#CBD6E4',
      accentBright: '#FFFFFF',
      accentMuted: '#788696',
      glassTint: 'rgba(8, 10, 12, 0.82)',
      glassTintStrong: 'rgba(4, 5, 7, 0.90)',
      glassBorder: 'rgba(203, 214, 228, 0.16)',
      specularHighlight: 'rgba(255, 255, 255, 0.20)',
      ambientGlow: 'rgba(203, 214, 228, 0.10)',
      selectedRing: '#FFFFFF',
      hoverRing: '#E2E8F0',
      controlAccent: '#CBD6E4',
      activityAccent: '#B8C8DC',
      composerAccent: '#C0C8E0',
    },
    markers: {
      bodyTint: 'rgba(8, 10, 12, 0.82)',
      inactiveStroke: 'rgba(203, 214, 224, 0.40)',
      iconLuminance: 0.88,
      haloHue: '#CBD6E4',
      haloOpacity: 0.08,
      selectedGlow: '#FFFFFF',
      clusterTint: 'rgba(203, 214, 228, 0.10)',
      iconHaloColor: 'rgba(3, 4, 5, 0.94)',
      iconHaloWidth: 1.6,
    },
  },
}

export type LegacyMapVisualPresetId = 'night_vision' | 'acquisition_radar' | 'midnight' | 'minimal_black'

export const LEGACY_MAP_VISUAL_PRESET_ALIASES: Record<LegacyMapVisualPresetId | string, MapVisualPresetId> = {
  night_vision: 'radar_night',
  'night-vision': 'radar_night',
  'night vision': 'radar_night',
  acquisition_radar: 'radar_night',
  'acquisition-radar': 'radar_night',
  'acquisition radar': 'radar_night',
  midnight: 'executive',
  minimal_black: 'monochrome',
}

export const MAP_VISUAL_PRESET_OPTIONS = Object.values(MAP_VISUAL_PRESETS)

export const normalizeMapVisualPresetId = (
  presetId: MapVisualPresetId | LegacyMapVisualPresetId | string | null | undefined,
): MapVisualPresetId => {
  if (!presetId) return 'dark_ops'
  if (presetId in MAP_VISUAL_PRESETS) return presetId as MapVisualPresetId
  if (presetId in LEGACY_MAP_VISUAL_PRESET_ALIASES) {
    return LEGACY_MAP_VISUAL_PRESET_ALIASES[presetId]
  }
  return 'dark_ops'
}

export const getMapVisualPreset = (
  presetId: MapVisualPresetId | LegacyMapVisualPresetId | string,
): MapVisualPreset => MAP_VISUAL_PRESETS[normalizeMapVisualPresetId(presetId)]

export const resolveVectorStyleUrl = (presetId: MapVisualPresetId): string | null => {
  const preset = MAP_VISUAL_PRESETS[presetId]
  if (preset.basemap.family === 'satellite' || preset.basemap.family === 'terrain') return null
  if (preset.basemap.styleId === 'vector_light') return CARTO_VECTOR_LIGHT_STYLE_URL
  if (preset.basemap.styleId === 'vector_dark') return CARTO_VECTOR_DARK_STYLE_URL
  return CARTO_VECTOR_DARK_STYLE_URL
}

export const THEME_TRANSITION_MS = 340

export const MAP_VISUAL_PRESET_STORAGE_KEY = 'nx.map.visual-preset'