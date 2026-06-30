/**
 * Universal Acquisition Radar pin renderer — precomputes marker attributes
 * and MapLibre paint expressions for the property universe layer stack.
 */

import type { CommandMapThemeId } from './commandMapThemes'
import {
  ACQUISITION_RADAR_STATE_MATRIX,
  type AcquisitionRadarMotion,
  type AcquisitionRadarSemanticKey,
  getPriorityGlowTier,
  isPriorityBreakoutPin,
  resolveAcquisitionRadarSemanticKey,
} from './acquisition-radar-state-matrix'
import {
  ASSET_TYPE_ICON_COLORS,
  buildAssetIconColorExpr,
  buildAssetIconImageExpr,
  resolveAcquisitionAssetFamily,
} from './acquisition-radar-asset-icons'
import { PIN_ICON } from './pin-icons'
import { getMapPinThemeTokens } from './map-pin-theme-tokens'

export type AcquisitionRadarPinProps = {
  property_id: string
  assetType: string
  markerState: string
  acquisitionScore: number
  semanticKey: AcquisitionRadarSemanticKey
  ring_color: string
  ring_highlight: string
  glass_color: string
  icon_color: string
  halo_color: string
  halo_scale: number
  halo_opacity: number
  marker_scale: number
  base_opacity: number
  ring_opacity: number
  glass_opacity: number
  motion: AcquisitionRadarMotion
  badge: string
  breakout: 0 | 1
  priority_tier: number
  double_ring: 0 | 1
  dashed_ring: 0 | 1
  pin_selected: 0 | 1
  pin_hovered: 0 | 1
}

const clusterCountForFamily = (family: string) => [
  '+', ['case', ['==', ['get', 'asset_family'], family], 1, 0],
] as unknown

export const ACQUISITION_RADAR_CLUSTER_PROPERTIES: Record<string, unknown> = {
  new_reply_count: ['+', ['case', ['==', ['get', 'semanticKey'], 'new_reply'], 1, 0]],
  urgent_count: ['+', ['case', ['==', ['get', 'semanticKey'], 'hot_urgent'], 1, 0]],
  negotiating_count: ['+', ['case', ['==', ['get', 'semanticKey'], 'negotiating'], 1, 0]],
  follow_up_count: ['+', ['case', ['==', ['get', 'semanticKey'], 'follow_up_due'], 1, 0]],
  active_comm_count: ['+', ['case', ['==', ['get', 'semanticKey'], 'active_communication'], 1, 0]],
  waiting_count: ['+', ['case', ['==', ['get', 'semanticKey'], 'waiting_on_seller'], 1, 0]],
  needs_review_count: ['+', ['case', ['==', ['get', 'semanticKey'], 'needs_review'], 1, 0]],
  uncontacted_count: ['+', ['case', ['==', ['get', 'semanticKey'], 'uncontacted'], 1, 0]],
  suppressed_count: ['+', ['case', ['==', ['get', 'semanticKey'], 'suppressed_dnc'], 1, 0]],
  sfr_count: clusterCountForFamily('sfr'),
  mf24_count: clusterCountForFamily('mf24'),
  mf5plus_count: clusterCountForFamily('mf5plus'),
  retail_count: clusterCountForFamily('retail'),
  commercial_count: clusterCountForFamily('commercial'),
  land_count: clusterCountForFamily('land'),
  sum_score: ['+', ['get', 'acquisitionScore']],
}

export const enrichAcquisitionRadarFeature = (
  feature: {
    properties: Record<string, unknown>
  },
  themeId: CommandMapThemeId,
  options?: { selectedPropertyId?: string | null; hoveredPropertyId?: string | null },
): Record<string, unknown> => {
  const props = feature.properties
  const theme = getMapPinThemeTokens(themeId)
  const score = Number(props.acquisitionScore ?? props.acquisition_score ?? 0)
  const unscored = !Number.isFinite(score) || score <= 0
  const semanticKey = resolveAcquisitionRadarSemanticKey({
    markerState: String(props.markerState ?? props.marker_state ?? ''),
    contactStatus: String(props.contactStatus ?? props.contact_status ?? ''),
    activityStatus: String(props.activityStatus ?? props.activity_status ?? ''),
    acquisitionScore: score,
  })
  const stateSpec = ACQUISITION_RADAR_STATE_MATRIX[semanticKey]
  const priorityTier = getPriorityGlowTier(score, unscored)
  const propertyId = String(props.property_id ?? props.propertyId ?? '')

  const assetFamily = resolveAcquisitionAssetFamily(String(props.assetType ?? props.asset_type ?? ''))
  const passiveUncontacted = semanticKey === 'uncontacted'
  const haloOpacity = Math.min(
    passiveUncontacted ? 0.14 : 0.18,
    stateSpec.haloOpacity * priorityTier.haloOpacityMultiplier,
  )
  const baseOpacity = stateSpec.baseOpacity * theme.inactiveOpacity / 0.82
  const markerScale = semanticKey === 'uncontacted'
    ? priorityTier.markerScale * 0.94
    : priorityTier.markerScale
  const isSelected = options?.selectedPropertyId && propertyId === options.selectedPropertyId ? 1 : 0
  const isHovered = options?.hoveredPropertyId && propertyId === options.hoveredPropertyId ? 1 : 0

  return {
    ...props,
    property_id: propertyId,
    semanticKey,
    asset_family: assetFamily,
    ring_color: stateSpec.ring,
    ring_highlight: stateSpec.highlight,
    glass_color: theme.glassFill,
    icon_color: ASSET_TYPE_ICON_COLORS[assetFamily],
    halo_color: theme.ambientAccent,
    halo_scale: priorityTier.haloScale,
    halo_opacity: haloOpacity,
    marker_scale: markerScale,
    base_opacity: Math.min(1, baseOpacity),
    ring_opacity: 0.92,
    glass_opacity: stateSpec.baseOpacity * stateSpec.bodySaturation,
    motion: stateSpec.motion,
    badge: stateSpec.badge,
    breakout: isPriorityBreakoutPin(semanticKey) || score >= 85 ? 1 : 0,
    priority_tier: priorityTier.min,
    double_ring: priorityTier.doubleRing ? 1 : 0,
    dashed_ring: priorityTier.dashedSecondary ? 1 : 0,
    pin_selected: isSelected,
    pin_hovered: isHovered,
    acquisitionScore: score,
  }
}

/** Cluster ring radius by count — spec diameters / 2 */
export const CLUSTER_RADIUS_EXPR: unknown[] = [
  'step', ['get', 'point_count'],
  15, 10, 18,
  50, 22,
  150, 26,
  500, 30,
  60,
]

export const CLUSTER_HALO_RADIUS_EXPR: unknown[] = [
  '+',
  ['step', ['get', 'point_count'], 18, 10, 22, 50, 28, 150, 32, 500, 36, 42],
  4,
]

export const buildClusterSemanticRingExpr = (ambientAccent: string): unknown[] => [
  'case',
  ['>', ['get', 'new_reply_count'], 0], '#22D9FF',
  ['>', ['get', 'urgent_count'], 0], '#FF4D52',
  ['>', ['get', 'negotiating_count'], 0], '#FF8A3D',
  ['>', ['get', 'follow_up_count'], 0], '#FF4FD8',
  ['>', ['get', 'active_comm_count'], 0], '#2EE58B',
  ambientAccent,
]

export const buildClusterHaloExpr = (clusterGlow: string): unknown[] => [
  'case',
  ['>', ['get', 'new_reply_count'], 0], 'rgba(34, 217, 255, 0.28)',
  ['>', ['get', 'urgent_count'], 0], 'rgba(255, 77, 82, 0.26)',
  ['>', ['get', 'negotiating_count'], 0], 'rgba(255, 138, 61, 0.22)',
  ['>', ['get', 'follow_up_count'], 0], 'rgba(255, 79, 216, 0.22)',
  ['>', ['get', 'active_comm_count'], 0], 'rgba(46, 229, 139, 0.18)',
  clusterGlow,
]

export const PIN_INTERACTION_SCALE_EXPR: unknown[] = [
  'case',
  ['==', ['coalesce', ['get', 'pin_selected'], 0], 1], 1.35,
  ['==', ['coalesce', ['get', 'pin_hovered'], 0], 1], 1.14,
  1,
]

export const PIN_GLASS_RADIUS_EXPR: unknown[] = [
  '*',
  ['interpolate', ['linear'], ['zoom'], 8, 8, 12, 9.5, 16, 11.5],
  ['coalesce', ['get', 'marker_scale'], 1],
  PIN_INTERACTION_SCALE_EXPR,
]

/** Halo capped at 1.75× glass radius — never a standalone orb */
export const PIN_HALO_RADIUS_EXPR: unknown[] = [
  'min',
  ['*', PIN_GLASS_RADIUS_EXPR, 1.75],
  ['+', PIN_GLASS_RADIUS_EXPR, ['interpolate', ['linear'], ['coalesce', ['get', 'halo_scale'], 1], 1, 5, 1.42, 8]],
]

export const PIN_HALO_OPACITY_EXPR: unknown[] = [
  'min',
  0.18,
  ['*',
    ['coalesce', ['get', 'halo_opacity'], 0.10],
    ['coalesce', ['get', 'base_opacity'], 0.82],
    ['case', ['==', ['coalesce', ['get', 'pin_selected'], 0], 1], 1.35, ['==', ['coalesce', ['get', 'pin_hovered'], 0], 1], 1.2, 1],
  ],
]

export const PIN_RING_STROKE_EXPR: unknown[] = [
  'coalesce',
  ['get', 'ring_color'],
  '#6F9BFF',
]

export const PIN_RING_WIDTH_EXPR: unknown[] = [
  'case',
  ['==', ['coalesce', ['get', 'pin_selected'], 0], 1], 3.2,
  ['==', ['coalesce', ['get', 'double_ring'], 0], 1], 2.8,
  2.2,
]

export const PIN_ICON_SCALE_EXPR: unknown[] = [
  '*',
  ['coalesce', ['get', 'marker_scale'], 1],
  PIN_INTERACTION_SCALE_EXPR,
  ['interpolate', ['linear'], ['zoom'], 8, 0.32, 11, 0.40, 13, 0.48, 16, 0.56],
]

export const PIN_ICON_IMAGE_EXPR = buildAssetIconImageExpr()
export const PIN_ICON_COLOR_EXPR = buildAssetIconColorExpr()

export const PIN_HIT_RADIUS_EXPR: unknown[] = [
  'case',
  ['boolean', ['feature-state', 'mobile'], false], 21,
  14,
]

export const PIN_BADGE_TEXT_EXPR: unknown[] = [
  'case',
  ['==', ['coalesce', ['get', 'pin_selected'], 0], 1], '✦',
  ['==', ['get', 'badge'], 'lock'], '🔒',
  ['==', ['get', 'badge'], 'warning'], '⚠',
  ['==', ['get', 'badge'], 'unread'], '●',
  '',
]

export const shouldShowIndividualPin = (
  zoom: number,
  props: { breakout?: number; pin_selected?: number },
): boolean => {
  if (props.pin_selected === 1) return true
  if (zoom >= 13.5) return true
  if (zoom >= 11.5) return true
  if (zoom >= 9.5 && props.breakout === 1) return true
  if (zoom < 9.5 && props.breakout === 1) return true
  return false
}

export const BREAKOUT_SEMANTIC_KEYS = ['new_reply', 'hot_urgent', 'negotiating', 'follow_up_due'] as const

export const buildBreakoutPinVisibilityFilter = (
  selectedPropertyId: string | null,
): unknown[] => {
  const breakoutAny: unknown[] = [
    ['==', ['get', 'breakout'], 1],
    ['in', ['get', 'semanticKey'], ['literal', [...BREAKOUT_SEMANTIC_KEYS]]],
    ['>=', ['get', 'acquisitionScore'], 70],
  ]
  if (selectedPropertyId) {
    breakoutAny.push(['==', ['get', 'property_id'], selectedPropertyId])
  }
  return ['all', ['!', ['has', 'point_count']], ['any', ...breakoutAny]]
}

/** Coupled filter — halo cannot render without icon (same expression on every marker layer). */
export const buildIndividualPinVisibilityFilter = (
  selectedPropertyId: string | null,
): unknown[] => {
  const breakoutAny: unknown[] = [
    ['==', ['get', 'breakout'], 1],
    ['in', ['get', 'semanticKey'], ['literal', [...BREAKOUT_SEMANTIC_KEYS]]],
    ['>=', ['get', 'acquisitionScore'], 70],
  ]
  if (selectedPropertyId) {
    breakoutAny.push(['==', ['get', 'property_id'], selectedPropertyId])
  }

  return [
    'all',
    ['!', ['has', 'point_count']],
    ['any',
      ['>=', ['zoom'], 13.75],
      ['all', ['>=', ['zoom'], 12.5], ['<', ['zoom'], 13.75]],
      ['all', ['>=', ['zoom'], 11], ['<', ['zoom'], 12.5],
        ['any', ...breakoutAny, ['>=', ['get', 'acquisitionScore'], 85]],
      ],
      ['all', ['>=', ['zoom'], 8], ['<', ['zoom'], 11], ['any', ...breakoutAny]],
      ['all', ['<', ['zoom'], 8], ['any', ...breakoutAny]],
    ],
  ]
}

export const buildClusterDominantIconExpr = (): unknown[] => [
  'case',
  ['all',
    ['>=', ['get', 'sfr_count'], ['get', 'mf24_count']],
    ['>=', ['get', 'sfr_count'], ['get', 'mf5plus_count']],
    ['>=', ['get', 'sfr_count'], ['get', 'commercial_count']],
    ['>=', ['get', 'sfr_count'], ['get', 'retail_count']],
  ], PIN_ICON.sfr,
  ['all',
    ['>=', ['get', 'mf5plus_count'], ['get', 'sfr_count']],
    ['>=', ['get', 'mf5plus_count'], ['get', 'mf24_count']],
  ], PIN_ICON.apt,
  ['>=', ['get', 'mf24_count'], ['get', 'sfr_count']], PIN_ICON.multi,
  ['>=', ['get', 'retail_count'], ['get', 'land_count']], PIN_ICON.retail,
  ['>', ['get', 'land_count'], 0], PIN_ICON.land,
  PIN_ICON.default,
]

export type PropertyUniverseClusterStats = {
  total: number
  sfr: number
  mf24: number
  mf5plus: number
  commercial: number
  land: number
  uncontacted: number
  activeComm: number
  waiting: number
  followUp: number
  newReply: number
  negotiating: number
  avgScore: number
  dominantAssetType: string
}

export const aggregatePropertyUniverseClusterStats = (
  leaves: Array<{ properties?: Record<string, unknown> }>,
): PropertyUniverseClusterStats => {
  const counts = {
    uncontacted: 0,
    active_communication: 0,
    waiting_on_seller: 0,
    follow_up_due: 0,
    new_reply: 0,
    negotiating: 0,
  }
  const familyCounts = {
    sfr: 0,
    mf24: 0,
    mf5plus: 0,
    commercial: 0,
    land: 0,
  }
  const assetCounts = new Map<string, number>()
  let scoreSum = 0
  let scoreCount = 0

  for (const leaf of leaves) {
    const props = leaf.properties ?? {}
    const key = String(props.semanticKey ?? props.markerState ?? 'uncontacted')
    if (key in counts) counts[key as keyof typeof counts] += 1
    else if (key === 'uncontacted' || key === 'not_contacted' || key === 'base_property') counts.uncontacted += 1

    const family = String(props.asset_family ?? resolveAcquisitionAssetFamily(String(props.assetType ?? '')))
    if (family in familyCounts) familyCounts[family as keyof typeof familyCounts] += 1
    const asset = String(props.assetType ?? family)
    assetCounts.set(asset, (assetCounts.get(asset) ?? 0) + 1)

    const score = Number(props.acquisitionScore ?? props.acquisition_score ?? NaN)
    if (Number.isFinite(score) && score > 0) {
      scoreSum += score
      scoreCount += 1
    }
  }

  const dominantAssetType = [...assetCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other'

  return {
    total: leaves.length,
    sfr: familyCounts.sfr,
    mf24: familyCounts.mf24,
    mf5plus: familyCounts.mf5plus,
    commercial: familyCounts.commercial + (assetCounts.get('retail') ?? 0),
    land: familyCounts.land,
    uncontacted: counts.uncontacted,
    activeComm: counts.active_communication,
    waiting: counts.waiting_on_seller,
    followUp: counts.follow_up_due,
    newReply: counts.new_reply,
    negotiating: counts.negotiating,
    avgScore: scoreCount > 0 ? Math.round(scoreSum / scoreCount) : 0,
    dominantAssetType,
  }
}

export const isBreakoutFeature = (props: Record<string, unknown>, selectedPropertyId?: string | null): boolean => {
  const propertyId = String(props.property_id ?? props.propertyId ?? '')
  if (selectedPropertyId && propertyId === selectedPropertyId) return true
  if (Number(props.breakout) === 1) return true
  const semantic = String(props.semanticKey ?? '')
  if ((BREAKOUT_SEMANTIC_KEYS as readonly string[]).includes(semantic)) return true
  return Number(props.acquisitionScore ?? 0) >= 70
}

/** Motion-specific pulse radius for RAF animation loop */
export const acquisitionRadarPulseRadius = (
  motion: string,
  frame: number,
  baseGlassRadius = 11,
): number => {
  const phase = frame / 60
  switch (motion) {
    case 'breathing':
      return baseGlassRadius + 4 + Math.sin(phase * 0.55) * 3.5
    case 'follow_up_pulse': {
      const wave = Math.max(0, Math.sin(phase * (Math.PI * 2) / 2.2))
      return baseGlassRadius + 2 + wave * 10
    }
    case 'reply_ripple': {
      const ripple = Math.max(0, Math.sin(phase * 2.4))
      const ripple2 = Math.max(0, Math.sin(phase * 2.4 - 0.6))
      return baseGlassRadius + Math.max(ripple, ripple2 * 0.85) * 12
    }
    case 'urgent_pulse':
      return baseGlassRadius + 3 + Math.sin(phase * (Math.PI * 2) / 1.6) * 5
    case 'failure_flicker':
      return baseGlassRadius + 2 + (Math.sin(phase * 6) > 0.7 ? 4 : 0)
    default:
      return baseGlassRadius
  }
}

export const acquisitionRadarPulseOpacity = (
  motion: string,
  frame: number,
  baseOpacity = 0.28,
): number => {
  const phase = frame / 60
  switch (motion) {
    case 'breathing':
      return baseOpacity * (0.72 + Math.sin(phase * 0.55) * 0.28)
    case 'follow_up_pulse': {
      const wave = Math.max(0, Math.sin(phase * (Math.PI * 2) / 2.2))
      return baseOpacity * (1 - wave * 0.55)
    }
    case 'reply_ripple': {
      const ripple = Math.max(0, Math.sin(phase * 2.4))
      return baseOpacity * ripple * 0.85
    }
    case 'urgent_pulse':
      return baseOpacity * (0.65 + Math.sin(phase * (Math.PI * 2) / 1.6) * 0.35)
    case 'failure_flicker':
      return baseOpacity * (Math.sin(phase * 6) > 0.7 ? 0.9 : 0.15)
    default:
      return 0
  }
}