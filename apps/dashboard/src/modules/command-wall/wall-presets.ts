/**
 * Command Wall presets (§16–§21, §65). Each preset decides map framing, layers,
 * the metric rail, the side panel, the feed and the default camera behaviour.
 * Ids mirror apps/api/src/lib/domain/command-wall/wall-config.js PRESET_IDS.
 */
import type { WallCameraMode, WallLayerId, WallPresetId } from './wall-types'

export type WallFraming = 'footprint' | 'focus_market' | 'conus'
export type WallRailMetric = 'sent' | 'replies' | 'positive' | 'offers' | 'campaigns' | 'queue' | 'senders'
export type WallPanel = 'none' | 'funnel' | 'campaigns' | 'mi_zips' | 'spatial_legend'

export interface WallPreset {
  id: WallPresetId
  label: string
  framing: WallFraming
  /** zoom used when framing a single market */
  focusZoom: number
  layers: WallLayerId[]
  rail: WallRailMetric[]
  panel: WallPanel
  feed: boolean
  needsMi: boolean
  camera: WallCameraMode
}

export const WALL_PRESET_IDS: readonly WallPresetId[] = ['national_command', 'acquisition_pulse', 'campaign_operations', 'market_intelligence', 'spatial_intelligence', 'custom']

export const WALL_PRESETS: Record<WallPresetId, WallPreset> = {
  national_command: {
    id: 'national_command', label: 'National Command', framing: 'footprint', focusZoom: 9,
    layers: ['campaigns', 'activity', 'boundaries'],
    rail: ['sent', 'replies', 'positive', 'offers', 'campaigns', 'queue', 'senders'],
    panel: 'none', feed: true, needsMi: false, camera: 'static',
  },
  acquisition_pulse: {
    id: 'acquisition_pulse', label: 'Acquisition Pulse', framing: 'footprint', focusZoom: 9,
    layers: ['activity', 'pipeline', 'boundaries'],
    rail: ['replies', 'positive', 'offers', 'campaigns'],
    panel: 'funnel', feed: true, needsMi: false, camera: 'event_follow',
  },
  campaign_operations: {
    id: 'campaign_operations', label: 'Campaign Operations', framing: 'footprint', focusZoom: 9,
    layers: ['campaigns', 'activity', 'boundaries'],
    rail: ['sent', 'campaigns', 'queue', 'senders', 'replies'],
    panel: 'campaigns', feed: true, needsMi: false, camera: 'static',
  },
  market_intelligence: {
    id: 'market_intelligence', label: 'Market Intelligence', framing: 'focus_market', focusZoom: 9,
    layers: ['mi_heat', 'sales', 'boundaries'],
    rail: ['campaigns', 'replies', 'offers'],
    panel: 'mi_zips', feed: false, needsMi: true, camera: 'tour',
  },
  spatial_intelligence: {
    id: 'spatial_intelligence', label: 'Spatial Intelligence', framing: 'focus_market', focusZoom: 11.2,
    layers: ['cameras', 'crime', 'investor', 'activity'],
    rail: ['replies', 'positive', 'offers'],
    panel: 'spatial_legend', feed: false, needsMi: false, camera: 'static',
  },
  custom: {
    id: 'custom', label: 'Custom', framing: 'footprint', focusZoom: 9,
    layers: ['campaigns', 'activity', 'boundaries'],
    rail: ['sent', 'replies', 'positive', 'offers', 'campaigns', 'queue', 'senders'],
    panel: 'none', feed: true, needsMi: false, camera: 'static',
  },
}

export function presetFor(id: string | null | undefined): WallPreset {
  return WALL_PRESETS[(id as WallPresetId) || 'national_command'] ?? WALL_PRESETS.national_command
}

/** Custom keeps the operator-approved layers; every other preset owns its layers. */
export function effectiveLayers(preset: WallPreset, configured: WallLayerId[] | null): WallLayerId[] {
  if (preset.id === 'custom' && configured && configured.length) return configured
  return preset.layers
}

export const CONUS_BOUNDS: [[number, number], [number, number]] = [[-124.8, 24.4], [-66.9, 49.4]]
