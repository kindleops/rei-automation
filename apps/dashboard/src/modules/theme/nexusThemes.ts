import type { CommandMapThemeId } from '../inbox/commandMapThemes'

export type NexusGlobalThemeId =
  | 'dark'
  | 'satellite'
  | 'terrain'
  | 'red_ops'
  | 'matrix'
  | 'blueprint'
  | 'executive'
  | 'night_vision'
  | 'monochrome'
  | 'light'

export type AnimationLevel = 'full' | 'reduced' | 'minimal'

export interface NexusGlobalThemeDefinition {
  id: NexusGlobalThemeId
  label: string
  description: string
  accent: string
  personality: string
  mapThemeId: CommandMapThemeId
  defaultAnimationLevel: AnimationLevel
  isHighContrast: boolean
}

export const nexusGlobalThemes: Record<NexusGlobalThemeId, NexusGlobalThemeDefinition> = {
  light: {
    id: 'light',
    label: 'Light',
    description: 'Clean bright layout — maximized legibility for day ops',
    accent: '#0a84ff',
    personality: 'clean',
    mapThemeId: 'light_street',
    defaultAnimationLevel: 'full',
    isHighContrast: false,
  },
  dark: {
    id: 'dark',
    label: 'Dark',
    description: 'Premium black/blue — default clean command center',
    accent: '#63d7ff',
    personality: 'command',
    mapThemeId: 'dark_ops',
    defaultAnimationLevel: 'full',
    isHighContrast: false,
  },
  satellite: {
    id: 'satellite',
    label: 'Satellite',
    description: 'Recon glass — blue/cyan accents, high readability over imagery',
    accent: '#e5edf8',
    personality: 'recon',
    mapThemeId: 'satellite',
    defaultAnimationLevel: 'full',
    isHighContrast: false,
  },
  terrain: {
    id: 'terrain',
    label: 'Terrain',
    description: 'Field intelligence — muted earth/green accents',
    accent: '#b7d86c',
    personality: 'field',
    mapThemeId: 'terrain',
    defaultAnimationLevel: 'full',
    isHighContrast: false,
  },
  red_ops: {
    id: 'red_ops',
    label: 'Red Ops',
    description: 'Tactical black/red — danger/urgency emphasis',
    accent: '#ff6b63',
    personality: 'tactical',
    mapThemeId: 'red_ops',
    defaultAnimationLevel: 'full',
    isHighContrast: true,
  },
  matrix: {
    id: 'matrix',
    label: 'Matrix',
    description: 'Black/green/cyan — terminal/radar feel with scanline effects',
    accent: '#00ff88',
    personality: 'terminal',
    mapThemeId: 'matrix',
    defaultAnimationLevel: 'full',
    isHighContrast: true,
  },
  blueprint: {
    id: 'blueprint',
    label: 'Blueprint',
    description: 'Navy/cyan/white — schematic/grid feel for property analysis',
    accent: '#69d7ff',
    personality: 'schematic',
    mapThemeId: 'blueprint',
    defaultAnimationLevel: 'full',
    isHighContrast: false,
  },
  executive: {
    id: 'executive',
    label: 'Executive',
    description: 'Black/gold — luxury subdued accents for high-value opportunities',
    accent: '#d8b450',
    personality: 'premium',
    mapThemeId: 'midnight',
    defaultAnimationLevel: 'reduced',
    isHighContrast: false,
  },
  night_vision: {
    id: 'night_vision',
    label: 'Night Vision',
    description: 'Black/green — low-brightness tactical, radar style accents',
    accent: '#72ffb2',
    personality: 'radar',
    mapThemeId: 'acquisition_radar',
    defaultAnimationLevel: 'full',
    isHighContrast: false,
  },
  monochrome: {
    id: 'monochrome',
    label: 'Monochrome',
    description: 'Grayscale focus mode — minimal glow, maximum clarity',
    accent: '#d3dde8',
    personality: 'minimal',
    mapThemeId: 'minimal_black',
    defaultAnimationLevel: 'minimal',
    isHighContrast: true,
  },
}

export const NEXUS_GLOBAL_THEME_OPTIONS = Object.values(nexusGlobalThemes)

export const MAP_THEME_TO_NEXUS_GLOBAL: Partial<Record<CommandMapThemeId, NexusGlobalThemeId>> = {
  satellite: 'satellite',
  dark_ops: 'dark',
  red_ops: 'red_ops',
  midnight: 'executive',
  blueprint: 'blueprint',
  light_street: 'dark',
  terrain: 'terrain',
  minimal_black: 'monochrome',
  acquisition_radar: 'night_vision',
  matrix: 'matrix',
}
