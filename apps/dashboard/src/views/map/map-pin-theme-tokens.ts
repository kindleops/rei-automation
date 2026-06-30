/**
 * Map pin theme tokens — visual preset layer only.
 * Semantic state colors live in acquisition-radar-state-matrix.ts
 */

import type { CommandMapThemeId } from './commandMapThemes'

export type MapPinThemeTokens = {
  glassFill: string
  glassFillStrong: string
  neutralIcon: string
  ambientAccent: string
  selectedAccent: string
  hoverAccent: string
  clusterFill: string
  clusterBorder: string
  clusterGlow: string
  inactiveOpacity: number
  satelliteContrastBoost: number
  haloBlendMode: 'normal' | 'screen'
}

export const MAP_PIN_THEME_TOKENS: Record<CommandMapThemeId, MapPinThemeTokens> = {
  satellite: {
    glassFill: 'rgba(14, 22, 34, 0.78)',
    glassFillStrong: 'rgba(10, 16, 26, 0.88)',
    neutralIcon: '#91B8E8',
    ambientAccent: '#55C8FF',
    selectedAccent: '#A7ECFF',
    hoverAccent: '#7ED4FF',
    clusterFill: 'rgba(12, 28, 48, 0.72)',
    clusterBorder: 'rgba(85, 200, 255, 0.55)',
    clusterGlow: 'rgba(85, 200, 255, 0.22)',
    inactiveOpacity: 0.76,
    satelliteContrastBoost: 1.08,
    haloBlendMode: 'screen',
  },
  dark_ops: {
    glassFill: 'rgba(6, 10, 20, 0.82)',
    glassFillStrong: 'rgba(4, 8, 16, 0.90)',
    neutralIcon: '#8193AF',
    ambientAccent: '#789EFF',
    selectedAccent: '#B7D3FF',
    hoverAccent: '#96B4FF',
    clusterFill: 'rgba(8, 12, 24, 0.74)',
    clusterBorder: 'rgba(120, 158, 255, 0.48)',
    clusterGlow: 'rgba(120, 158, 255, 0.18)',
    inactiveOpacity: 0.72,
    satelliteContrastBoost: 1,
    haloBlendMode: 'screen',
  },
  red_ops: {
    glassFill: 'rgba(18, 6, 10, 0.84)',
    glassFillStrong: 'rgba(12, 4, 8, 0.92)',
    neutralIcon: '#D98992',
    ambientAccent: '#FF4D5E',
    selectedAccent: '#FF9A76',
    hoverAccent: '#FF7078',
    clusterFill: 'rgba(22, 8, 12, 0.76)',
    clusterBorder: 'rgba(255, 77, 94, 0.52)',
    clusterGlow: 'rgba(255, 77, 94, 0.20)',
    inactiveOpacity: 0.74,
    satelliteContrastBoost: 1.04,
    haloBlendMode: 'screen',
  },
  executive: {
    glassFill: 'rgba(14, 12, 16, 0.84)',
    glassFillStrong: 'rgba(10, 9, 12, 0.92)',
    neutralIcon: '#C8B788',
    ambientAccent: '#DDBD72',
    selectedAccent: '#FFF0B3',
    hoverAccent: '#E8CF8E',
    clusterFill: 'rgba(16, 14, 12, 0.74)',
    clusterBorder: 'rgba(221, 189, 114, 0.50)',
    clusterGlow: 'rgba(221, 189, 114, 0.18)',
    inactiveOpacity: 0.74,
    satelliteContrastBoost: 1,
    haloBlendMode: 'normal',
  },
  blueprint: {
    glassFill: 'rgba(4, 18, 32, 0.84)',
    glassFillStrong: 'rgba(2, 12, 24, 0.92)',
    neutralIcon: '#6FC9E8',
    ambientAccent: '#2DD8FF',
    selectedAccent: '#A9F3FF',
    hoverAccent: '#5CE4FF',
    clusterFill: 'rgba(6, 22, 38, 0.74)',
    clusterBorder: 'rgba(45, 216, 255, 0.50)',
    clusterGlow: 'rgba(45, 216, 255, 0.20)',
    inactiveOpacity: 0.76,
    satelliteContrastBoost: 1.02,
    haloBlendMode: 'screen',
  },
  matrix: {
    glassFill: 'rgba(2, 10, 6, 0.86)',
    glassFillStrong: 'rgba(0, 6, 4, 0.94)',
    neutralIcon: '#75C99B',
    ambientAccent: '#31F58A',
    selectedAccent: '#A8FFC9',
    hoverAccent: '#5CFFA8',
    clusterFill: 'rgba(4, 14, 8, 0.76)',
    clusterBorder: 'rgba(49, 245, 138, 0.48)',
    clusterGlow: 'rgba(49, 245, 138, 0.18)',
    inactiveOpacity: 0.74,
    satelliteContrastBoost: 1.06,
    haloBlendMode: 'screen',
  },
  light_street: {
    glassFill: 'rgba(255, 255, 255, 0.88)',
    glassFillStrong: 'rgba(248, 252, 255, 0.94)',
    neutralIcon: '#315F9B',
    ambientAccent: '#247CFF',
    selectedAccent: '#004DCC',
    hoverAccent: '#1A6FE8',
    clusterFill: 'rgba(240, 248, 255, 0.82)',
    clusterBorder: 'rgba(36, 124, 255, 0.45)',
    clusterGlow: 'rgba(36, 124, 255, 0.14)',
    inactiveOpacity: 0.82,
    satelliteContrastBoost: 1.12,
    haloBlendMode: 'normal',
  },
  terrain: {
    glassFill: 'rgba(14, 18, 14, 0.80)',
    glassFillStrong: 'rgba(10, 14, 10, 0.88)',
    neutralIcon: '#7EA392',
    ambientAccent: '#45BFA1',
    selectedAccent: '#A1FFE0',
    hoverAccent: '#6AD4B8',
    clusterFill: 'rgba(16, 22, 18, 0.72)',
    clusterBorder: 'rgba(69, 191, 161, 0.48)',
    clusterGlow: 'rgba(69, 191, 161, 0.18)',
    inactiveOpacity: 0.76,
    satelliteContrastBoost: 1,
    haloBlendMode: 'screen',
  },
  monochrome: {
    glassFill: 'rgba(10, 12, 16, 0.82)',
    glassFillStrong: 'rgba(6, 8, 12, 0.90)',
    neutralIcon: '#98A5B4',
    ambientAccent: '#D7E1EE',
    selectedAccent: '#FFFFFF',
    hoverAccent: '#E8EEF5',
    clusterFill: 'rgba(12, 14, 18, 0.74)',
    clusterBorder: 'rgba(215, 225, 238, 0.42)',
    clusterGlow: 'rgba(215, 225, 238, 0.12)',
    inactiveOpacity: 0.70,
    satelliteContrastBoost: 1,
    haloBlendMode: 'normal',
  },
  radar_night: {
    glassFill: 'rgba(6, 18, 14, 0.84)',
    glassFillStrong: 'rgba(4, 12, 10, 0.92)',
    neutralIcon: '#7EC9A8',
    ambientAccent: '#48E2A0',
    selectedAccent: '#B6FFD8',
    hoverAccent: '#7AE8B8',
    clusterFill: 'rgba(8, 20, 16, 0.74)',
    clusterBorder: 'rgba(72, 226, 160, 0.44)',
    clusterGlow: 'rgba(72, 226, 160, 0.16)',
    inactiveOpacity: 0.74,
    satelliteContrastBoost: 1.04,
    haloBlendMode: 'screen',
  },
}

export const getMapPinThemeTokens = (themeId: CommandMapThemeId): MapPinThemeTokens =>
  MAP_PIN_THEME_TOKENS[themeId] ?? MAP_PIN_THEME_TOKENS.dark_ops