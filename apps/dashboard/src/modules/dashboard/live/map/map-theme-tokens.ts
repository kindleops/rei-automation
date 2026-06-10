/**
 * Property universe layer theme tokens.
 *
 * Maps the active NexusTheme to per-theme colors for the property universe
 * map layers (clusters, individual markers). Each theme has a distinct
 * visual identity while preserving universal urgency signal colors
 * (hot = red, positive = green) so operators can read state at a glance.
 */

import { commandMapThemes } from '../../../../views/map/commandMapThemes'
import type { CommandMapThemeId } from '../../../../views/map/commandMapThemes'
import { nexusGlobalThemes } from '../../../../domain/theme/nexusThemes'
import type { NexusGlobalThemeId } from '../../../../domain/theme/nexusThemes'

export interface PropertyLayerTokens {
  // Cluster ring glow
  clusterRingHot: string
  clusterRingReply: string
  clusterRingPositive: string
  clusterRingBase: string
  // Cluster core fill
  clusterCoreHot: string
  clusterCoreReply: string
  clusterCorePositive: string
  clusterCoreBase: string
  // Cluster stroke border
  clusterStrokeHot: string
  clusterStrokeReply: string
  clusterStrokePositive: string
  clusterStrokeBase: string
  // Cluster label
  clusterLabelColor: string
  clusterLabelHalo: string
  // Individual marker rendering
  markerGlowOpacity: number
  markerGlowBlur: number
  markerIconOpacity: number
  markerIconHaloColor: string
  markerIconHaloWidth: number
  // Marker state colors
  colorHot: string
  colorNewReply: string
  colorPositive: string
  colorNegotiating: string
  colorBlocked: string
  colorQueued: string
  colorDelivered: string
  colorSuppressed: string
  colorBuyerComp: string
  colorSoldComp: string
  colorNotContacted: string
  colorBase: string
}

// Legacy NexusTheme IDs → CommandMapThemeId
const LEGACY_MAP: Record<string, CommandMapThemeId> = {
  'dark-matter':     'dark_ops',
  'midnight-glass':  'midnight',
  'tactical-blue':   'blueprint',
  'carbon-gold':     'midnight',
  'monochrome-ops':  'minimal_black',
  'infrared':        'red_ops',
  'arctic-signal':   'acquisition_radar',
  'operator-black':  'dark_ops',
}

function resolveMapThemeId(nexusTheme: string): CommandMapThemeId {
  const global = nexusGlobalThemes[nexusTheme as NexusGlobalThemeId]
  if (global) return global.mapThemeId
  if (nexusTheme in commandMapThemes) return nexusTheme as CommandMapThemeId
  return LEGACY_MAP[nexusTheme] ?? 'dark_ops'
}

// Per-theme reply cluster core fill — the theme's primary accent at cluster opacity
const REPLY_CORE: Record<CommandMapThemeId, string> = {
  satellite:         'rgba(180,206,230,0.76)',
  dark_ops:          'rgba(56,208,240,0.76)',
  red_ops:           'rgba(255,115,107,0.78)',
  midnight:          'rgba(126,172,255,0.76)',
  blueprint:         'rgba(80,204,255,0.76)',
  light_street:      'rgba(37,99,235,0.80)',
  terrain:           'rgba(166,210,96,0.76)',
  minimal_black:     'rgba(148,163,184,0.74)',
  acquisition_radar: 'rgba(72,255,178,0.76)',
  matrix:            'rgba(0,255,136,0.76)',
}

// Per-theme reply cluster ring glow
const REPLY_RING: Record<CommandMapThemeId, string> = {
  satellite:         'rgba(180,206,230,0.13)',
  dark_ops:          'rgba(56,208,240,0.13)',
  red_ops:           'rgba(255,115,107,0.14)',
  midnight:          'rgba(109,147,255,0.14)',
  blueprint:         'rgba(80,204,255,0.14)',
  light_street:      'rgba(37,99,235,0.12)',
  terrain:           'rgba(166,210,96,0.13)',
  minimal_black:     'rgba(148,163,184,0.08)',
  acquisition_radar: 'rgba(69,255,181,0.13)',
  matrix:            'rgba(0,255,136,0.13)',
}

export function getMapThemeTokens(nexusTheme: string): PropertyLayerTokens {
  const mapThemeId = resolveMapThemeId(nexusTheme)
  const theme = commandMapThemes[mapThemeId] ?? commandMapThemes.dark_ops
  const cp = theme.clusterPalette
  const pp = theme.pinPalette
  const isLight = theme.baseStyleTone === 'light_street'

  // Dim base stroke — replace last opacity component with 0.36
  const baseStroke = cp.stroke.replace(/[\d.]+\)$/, '0.36)')

  return {
    // Ring glow: hot = red, positive = green, reply/base = theme accent
    clusterRingHot:      isLight ? 'rgba(220,38,38,0.16)' : 'rgba(212,64,76,0.14)',
    clusterRingReply:    REPLY_RING[mapThemeId],
    clusterRingPositive: isLight ? 'rgba(5,150,105,0.14)' : 'rgba(44,184,122,0.12)',
    clusterRingBase:     cp.glow,

    // Core fill
    clusterCoreHot:      isLight ? 'rgba(220,38,38,0.80)' : 'rgba(212,64,76,0.80)',
    clusterCoreReply:    REPLY_CORE[mapThemeId],
    clusterCorePositive: isLight ? 'rgba(5,150,105,0.78)' : 'rgba(44,184,122,0.74)',
    clusterCoreBase:     cp.core,

    // Stroke border
    clusterStrokeHot:      isLight ? 'rgba(220,38,38,0.92)' : 'rgba(212,64,76,0.90)',
    clusterStrokeReply:    cp.stroke,
    clusterStrokePositive: isLight ? 'rgba(5,150,105,0.84)' : 'rgba(44,184,122,0.82)',
    clusterStrokeBase:     baseStroke,

    // Label text
    clusterLabelColor: cp.label,
    clusterLabelHalo:  cp.halo,

    // Individual marker rendering
    markerGlowOpacity:  isLight ? 0.14 : 0.18,
    markerGlowBlur:     0.85,
    markerIconOpacity:  isLight ? 0.88 : 0.92,
    markerIconHaloColor: isLight ? 'rgba(255,255,255,0.86)' : 'rgba(4,6,12,0.85)',
    markerIconHaloWidth: isLight ? 1.0 : 1.2,

    // State colors from theme's pin palette
    colorHot:          (pp.hot           as string | undefined) ?? '#d4404c',
    colorNewReply:     (pp.new_reply      as string | undefined) ?? '#38d0f0',
    colorPositive:     (pp.positive_intent as string | undefined) ?? '#2cb87a',
    colorNegotiating:  (pp.negotiating   as string | undefined) ?? '#d89530',
    colorBlocked:      (pp.blocked       as string | undefined) ?? '#d4404c',
    colorQueued:       (pp.queued        as string | undefined) ?? '#5b9cf6',
    colorDelivered:    (pp.delivered     as string | undefined) ?? '#2cb87a',
    colorSuppressed:   (pp.suppressed    as string | undefined) ?? '#4e6e88',
    colorBuyerComp:    theme.buyerAccent,
    colorSoldComp:     theme.soldCompColor,
    colorNotContacted: (pp.not_contacted as string | undefined) ?? '#4e6e88',
    colorBase:         isLight ? '#64748b' : '#4e6e88',
  }
}

// ── MapLibre expression builders ─────────────────────────────────────────────

export function buildClusterRingExpr(t: PropertyLayerTokens): unknown[] {
  return ['case',
    ['>', ['get', 'hot_count'], 0],   t.clusterRingHot,
    ['>', ['get', 'reply_count'], 0], t.clusterRingReply,
    ['>', ['get', 'pos_count'], 0],   t.clusterRingPositive,
    t.clusterRingBase,
  ]
}

export function buildClusterCoreExpr(t: PropertyLayerTokens): unknown[] {
  return ['case',
    ['>', ['get', 'hot_count'], 0],   t.clusterCoreHot,
    ['>', ['get', 'reply_count'], 0], t.clusterCoreReply,
    ['>', ['get', 'pos_count'], 0],   t.clusterCorePositive,
    t.clusterCoreBase,
  ]
}

export function buildClusterStrokeExpr(t: PropertyLayerTokens): unknown[] {
  return ['case',
    ['>', ['get', 'hot_count'], 0],   t.clusterStrokeHot,
    ['>', ['get', 'reply_count'], 0], t.clusterStrokeReply,
    ['>', ['get', 'pos_count'], 0],   t.clusterStrokePositive,
    t.clusterStrokeBase,
  ]
}

export function buildMarkerColorExpr(t: PropertyLayerTokens): unknown[] {
  return ['match', ['get', 'markerState'],
    'hot',           t.colorHot,
    'new_reply',     t.colorNewReply,
    'positive',      t.colorPositive,
    'negotiating',   t.colorNegotiating,
    'needs_review',  t.colorNegotiating,
    'blocked',       t.colorBlocked,
    'queued',        t.colorQueued,
    'scheduled',     t.colorQueued,
    'active_sending', t.colorQueued,
    'sent',          t.colorDelivered,
    'delivered',     t.colorDelivered,
    'suppressed',    t.colorSuppressed,
    'buyer_comp',    t.colorBuyerComp,
    'sold_comp',     t.colorSoldComp,
    'not_contacted', t.colorNotContacted,
    t.colorBase,
  ]
}

// Priority marker states shown at zoom 11.75–13 (before full individual marker reveal)
export const PRIORITY_MARKER_STATES = ['new_reply', 'hot', 'positive', 'negotiating', 'needs_review', 'blocked'] as const
export const PRIORITY_ASSET_TYPES = ['storage', 'shopping_plaza', 'industrial', 'office', 'hotel', 'mhp', 'mixed_use'] as const
