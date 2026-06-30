/**
 * Visual identity tokens per map theme preset.
 * Themes control appearance only — not pin logic or intelligence behavior.
 */

import type { CommandMapThemeId } from './commandMapThemes'

export type CommandMapThemeIdentity = {
  /** Primary map chrome / HUD accent */
  mapAccentTint: string
  /** Pin halo / glow hue */
  pinGlowHue: string
  /** Liquid-glass card accent */
  cardAccentHue: string
  /** Controls menu accent */
  menuAccentHue: string
  /** Activity bar / live rail accent */
  activityBarAccentHue: string
  /** Selected-state border */
  selectedBorderColor: string
  /** Cluster dominant tint */
  clusterTint: string
  /** Glass body fill for pins (rgba) */
  pinGlassBody: string
  /** Icon tint on dark glass */
  pinIconTint: string
  /** Is this a light basemap theme */
  isLight: boolean
}

export const COMMAND_MAP_THEME_IDENTITIES: Record<CommandMapThemeId, CommandMapThemeIdentity> = {
  satellite: {
    mapAccentTint: '#8ec8f0',
    pinGlowHue: '#6b9fd4',
    cardAccentHue: '#e5edf8',
    menuAccentHue: '#7eb8e8',
    activityBarAccentHue: '#5aa9e8',
    selectedBorderColor: 'rgba(142, 200, 240, 0.88)',
    clusterTint: 'rgba(107, 159, 212, 0.28)',
    pinGlassBody: 'rgba(14, 20, 28, 0.78)',
    pinIconTint: '#e8f4fc',
    isLight: false,
  },
  dark_ops: {
    mapAccentTint: '#63d7ff',
    pinGlowHue: '#38d0f0',
    cardAccentHue: '#63d7ff',
    menuAccentHue: '#52c4ff',
    activityBarAccentHue: '#4db8ff',
    selectedBorderColor: 'rgba(99, 215, 255, 0.90)',
    clusterTint: 'rgba(56, 208, 240, 0.24)',
    pinGlassBody: 'rgba(6, 12, 22, 0.82)',
    pinIconTint: '#dff8ff',
    isLight: false,
  },
  red_ops: {
    mapAccentTint: '#ff4d4d',
    pinGlowHue: '#ff5a50',
    cardAccentHue: '#ff4d4d',
    menuAccentHue: '#ff6b63',
    activityBarAccentHue: '#ff3344',
    selectedBorderColor: 'rgba(255, 77, 77, 0.92)',
    clusterTint: 'rgba(255, 90, 80, 0.26)',
    pinGlassBody: 'rgba(18, 6, 8, 0.84)',
    pinIconTint: '#fff0ee',
    isLight: false,
  },
  executive: {
    mapAccentTint: '#dcbf74',
    pinGlowHue: '#c9a85c',
    cardAccentHue: '#dcbf74',
    menuAccentHue: '#d4b76a',
    activityBarAccentHue: '#f0d080',
    selectedBorderColor: 'rgba(220, 191, 116, 0.90)',
    clusterTint: 'rgba(220, 191, 116, 0.22)',
    pinGlassBody: 'rgba(12, 11, 14, 0.84)',
    pinIconTint: '#fff9e8',
    isLight: false,
  },
  blueprint: {
    mapAccentTint: '#56d9e8',
    pinGlowHue: '#3ec8e0',
    cardAccentHue: '#56d9e8',
    menuAccentHue: '#50d8f0',
    activityBarAccentHue: '#67e0f4',
    selectedBorderColor: 'rgba(86, 217, 232, 0.90)',
    clusterTint: 'rgba(80, 204, 255, 0.24)',
    pinGlassBody: 'rgba(4, 18, 28, 0.84)',
    pinIconTint: '#dff8ff',
    isLight: false,
  },
  matrix: {
    mapAccentTint: '#00ff88',
    pinGlowHue: '#0ee08c',
    cardAccentHue: '#00ff88',
    menuAccentHue: '#2ef0a0',
    activityBarAccentHue: '#4dffb6',
    selectedBorderColor: 'rgba(0, 255, 136, 0.88)',
    clusterTint: 'rgba(0, 255, 136, 0.22)',
    pinGlassBody: 'rgba(2, 10, 6, 0.86)',
    pinIconTint: '#d8ffe8',
    isLight: false,
  },
  light_street: {
    mapAccentTint: '#2563eb',
    pinGlowHue: '#3b82f6',
    cardAccentHue: '#1d4ed8',
    menuAccentHue: '#2563eb',
    activityBarAccentHue: '#0ea5e9',
    selectedBorderColor: 'rgba(37, 99, 235, 0.82)',
    clusterTint: 'rgba(37, 99, 235, 0.18)',
    pinGlassBody: 'rgba(255, 255, 255, 0.88)',
    pinIconTint: '#1e3a8a',
    isLight: true,
  },
  terrain: {
    mapAccentTint: '#a6d260',
    pinGlowHue: '#74c365',
    cardAccentHue: '#b7d86c',
    menuAccentHue: '#8ea476',
    activityBarAccentHue: '#c8a85d',
    selectedBorderColor: 'rgba(183, 216, 108, 0.88)',
    clusterTint: 'rgba(116, 195, 101, 0.22)',
    pinGlassBody: 'rgba(14, 17, 12, 0.80)',
    pinIconTint: '#f6fee7',
    isLight: false,
  },
  monochrome: {
    mapAccentTint: '#cdd6e0',
    pinGlowHue: '#b0b8c4',
    cardAccentHue: '#cdd6e0',
    menuAccentHue: '#a8b0bc',
    activityBarAccentHue: '#d0d8e4',
    selectedBorderColor: 'rgba(205, 214, 224, 0.82)',
    clusterTint: 'rgba(148, 163, 184, 0.16)',
    pinGlassBody: 'rgba(8, 10, 12, 0.82)',
    pinIconTint: '#f0f4f8',
    isLight: false,
  },
  radar_night: {
    mapAccentTint: '#48E2A0',
    pinGlowHue: '#48E2A0',
    cardAccentHue: '#48E2A0',
    menuAccentHue: '#48E2A0',
    activityBarAccentHue: '#5AE8A8',
    selectedBorderColor: 'rgba(72, 226, 160, 0.86)',
    clusterTint: 'rgba(72, 226, 160, 0.18)',
    pinGlassBody: 'rgba(6, 19, 15, 0.84)',
    pinIconTint: '#e8fff2',
    isLight: false,
  },
}

export const getCommandMapThemeIdentity = (themeId: CommandMapThemeId): CommandMapThemeIdentity =>
  COMMAND_MAP_THEME_IDENTITIES[themeId] ?? COMMAND_MAP_THEME_IDENTITIES.dark_ops

/** CSS custom properties for map chrome — applied to .nx-icm root */
export const buildThemeIdentityCssVars = (identity: CommandMapThemeIdentity): Record<string, string> => ({
  '--map-accent': identity.cardAccentHue,
  '--map-accent-soft': hexToRgba(identity.cardAccentHue, 0.16),
  '--map-pin-glow': identity.clusterTint,
  '--map-selected-border': identity.selectedBorderColor,
  '--map-menu-accent': identity.menuAccentHue,
  '--map-activity-accent': identity.activityBarAccentHue,
  '--nx-card-accent': identity.cardAccentHue,
  '--nx-card-accent-rgb': hexToRgbTuple(identity.cardAccentHue),
  '--nx-card-accent-soft': hexToRgba(identity.cardAccentHue, 0.14),
  '--nx-card-live': identity.activityBarAccentHue,
})

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