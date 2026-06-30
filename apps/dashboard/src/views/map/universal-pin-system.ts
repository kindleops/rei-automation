/**
 * Universal pin system — shared visual contract for seller pins and thread pins.
 * Center icon = asset type, outer ring = stage/status, glow = priority, pulse = live activity.
 */

import type { CommandMapSellerPin } from '../../lib/data/commandMapData'
import type { CommandMapThemeId } from './commandMapThemes'
import { getCommandMapThemeIdentity } from './command-map-theme-identity'
import {
  type CommandMapIntelligenceModeId,
  computePinModeModifiers,
  getIntelligenceMode,
} from './command-map-intelligence-modes'
import {
  EXECUTION_RING_COLORS,
  UNIVERSAL_STAGE_RING_COLORS,
  getExecutionRingColor,
  getUniversalRingColor,
  resolveExecutionRingKey,
  resolvePulseStyle,
  resolveSellerStateRingKey,
} from './universal-stage-colors'

export type UniversalPinVisualProps = {
  pin_color: string
  ring_color: string
  glass_color: string
  icon_color: string
  glow_strength: number
  focus_opacity: number
  ring_opacity: number
  glass_opacity: number
  icon_scale: number
  pulse_style: string
  execution_ring_color: string
  cluster_signal: string
  marker_state: string
  simplify_pin: 0 | 1
}

export const SELLER_PIN_CLUSTER_PROPERTIES: Record<string, unknown> = {
  hot_count: ['+', ['case', ['in', ['get', 'marker_state'], ['literal', ['hot', 'hot_urgent']]], 1, 0]],
  reply_count: ['+', ['case', ['==', ['get', 'marker_state'], 'active_communication'], 1, 0]],
  urgent_count: ['+', ['case', ['in', ['get', 'marker_state'], ['literal', ['follow_up_due', 'needs_review', 'hot_urgent']]], 1, 0]],
  uncontacted_count: ['+', ['case', ['==', ['get', 'marker_state'], 'uncontacted'], 1, 0]],
  top_priority: ['max', ['coalesce', ['get', 'priority_score'], 0]],
}

const lower = (value: unknown) => String(value ?? '').trim().toLowerCase()

export const resolveEffectiveSellerState = (pin: Partial<CommandMapSellerPin>): string => {
  const normalized = lower(pin.seller_state).replace(/\s+/g, '_')
  const inboxCategory = lower(pin.inbox_category).replace(/\s+/g, '_')
  if (!normalized || normalized === 'none' || normalized === 'null' || normalized === 'unknown') {
    if (inboxCategory === 'not_contacted') return 'not_contacted'
    if (inboxCategory === 'new_reply') return 'new_reply'
    if (inboxCategory === 'needs_review') return 'issue'
    if (inboxCategory === 'suppressed' || inboxCategory === 'dnc_suppressed') return 'blocked'
    return 'not_contacted'
  }
  if (normalized === 'new_replies') return 'new_reply'
  if (normalized === 'positive') return 'positive_intent'
  return normalized
}

export const buildUniversalSellerPinVisuals = (
  pin: Partial<CommandMapSellerPin>,
  themeId: CommandMapThemeId,
  modeId: CommandMapIntelligenceModeId,
): UniversalPinVisualProps => {
  const identity = getCommandMapThemeIdentity(themeId)
  const mode = getIntelligenceMode(modeId)
  const modifiers = computePinModeModifiers(modeId, {
    seller_state: resolveEffectiveSellerState(pin),
    inbox_category: pin.inbox_category,
    operational_status: pin.seller_status,
    lead_temperature: (pin as { lead_temperature?: string }).lead_temperature,
    execution_state: pin.execution_state,
    priority_score: pin.priority_score ?? pin.final_acquisition_score,
  })

  const ringKey = resolveSellerStateRingKey({
    seller_state: resolveEffectiveSellerState(pin),
    seller_status: pin.seller_status,
    inbox_category: pin.inbox_category,
    lead_temperature: (pin as { lead_temperature?: string }).lead_temperature,
  })

  const executionKey = resolveExecutionRingKey(pin.execution_state)
  const stageRingColor = getUniversalRingColor(ringKey)

  let ringColor = stageRingColor
  if (mode.ringSource === 'execution' && executionKey) {
    ringColor = getExecutionRingColor(executionKey)
  } else if (mode.ringSource === 'neutral') {
    ringColor = identity.pinGlowHue
  } else if (mode.ringSource === 'execution' && !executionKey) {
    ringColor = stageRingColor
  }

  const pulseStyle = modifiers.showPulse
    ? resolvePulseStyle({
      seller_state: resolveEffectiveSellerState(pin),
      inbox_category: pin.inbox_category,
      operational_status: pin.seller_status,
      pulse_style: pin.pulse_style,
      execution_state: pin.execution_state,
      lead_temperature: (pin as { lead_temperature?: string }).lead_temperature,
    })
    : 'none'

  const glowColor = identity.pinGlowHue
  const glassColor = identity.pinGlassBody

  return {
    pin_color: glowColor,
    ring_color: ringColor,
    glass_color: glassColor,
    icon_color: identity.pinIconTint,
    glow_strength: modifiers.glowStrength,
    focus_opacity: modifiers.focusOpacity,
    ring_opacity: modifiers.ringOpacity,
    glass_opacity: modifiers.glassOpacity,
    icon_scale: modifiers.iconScale,
    pulse_style: pulseStyle,
    execution_ring_color: executionKey ? getExecutionRingColor(executionKey) : ringColor,
    cluster_signal: ringColor,
    marker_state: ringKey,
    simplify_pin: mode.simplifyPins ? 1 : 0,
  }
}

/** MapLibre cluster ring expression — dominant signal from aggregated counts */
export const buildSellerClusterRingExpr = (baseGlow: string): unknown[] => [
  'case',
  ['>', ['get', 'hot_count'], 0], 'rgba(255, 107, 53, 0.22)',
  ['>', ['get', 'urgent_count'], 0], 'rgba(255, 45, 135, 0.20)',
  ['>', ['get', 'reply_count'], 0], 'rgba(48, 209, 88, 0.18)',
  baseGlow,
]

export const buildSellerClusterCoreExpr = (coreColor: string): unknown[] => [
  'case',
  ['>', ['get', 'hot_count'], 0], 'rgba(255, 107, 53, 0.88)',
  ['>', ['get', 'urgent_count'], 0], 'rgba(255, 45, 135, 0.84)',
  ['>', ['get', 'reply_count'], 0], 'rgba(48, 209, 88, 0.80)',
  coreColor,
]

export const buildSellerClusterStrokeExpr = (strokeColor: string): unknown[] => [
  'case',
  ['>', ['get', 'hot_count'], 0], UNIVERSAL_STAGE_RING_COLORS.hot_urgent,
  ['>', ['get', 'urgent_count'], 0], UNIVERSAL_STAGE_RING_COLORS.follow_up_due,
  ['>', ['get', 'reply_count'], 0], UNIVERSAL_STAGE_RING_COLORS.active_communication,
  strokeColor,
]

export const UNIVERSAL_PIN_GLOW_OPACITY_EXPR: unknown[] = [
  '*',
  ['coalesce', ['get', 'focus_opacity'], 1],
  ['case',
    ['>=', ['coalesce', ['get', 'glow_strength'], 0.4], 0.9], 0.42,
    ['>=', ['coalesce', ['get', 'glow_strength'], 0.4], 0.7], 0.34,
    ['>=', ['coalesce', ['get', 'glow_strength'], 0.4], 0.5], 0.28,
    0.20,
  ],
]

export const UNIVERSAL_PIN_RING_STROKE_EXPR: unknown[] = [
  'coalesce',
  ['get', 'ring_color'],
  ['get', 'execution_ring_color'],
  ['get', 'pin_color'],
  '#38d0f0',
]

export const UNIVERSAL_PIN_RING_WIDTH_EXPR: unknown[] = [
  'case',
  ['==', ['coalesce', ['get', 'simplify_pin'], 0], 1], 1.6,
  2.4,
]

export const UNIVERSAL_PIN_GLASS_OPACITY_EXPR: unknown[] = [
  '*',
  ['coalesce', ['get', 'glass_opacity'], 0.84],
  ['coalesce', ['get', 'focus_opacity'], 1],
]

export const UNIVERSAL_PIN_ICON_SCALE_EXPR: unknown[] = [
  '*',
  ['coalesce', ['get', 'icon_scale'], 1],
  ['interpolate', ['linear'], ['zoom'], 6, 0.24, 10, 0.36, 13, 0.48, 16, 0.58],
]

export const EXECUTION_RING_COLOR_LEGEND = Object.entries(EXECUTION_RING_COLORS).map(([key, color]) => ({
  key,
  color,
}))

export const STAGE_RING_COLOR_LEGEND = Object.entries(UNIVERSAL_STAGE_RING_COLORS).map(([key, color]) => ({
  key,
  color,
}))

/** Thread / activity pin ring color from canonical lead state */
export const resolveCommandPinRingColor = (pin: {
  seller_state?: string | null
  operational_status?: string | null
  conversation_status?: string | null
  lifecycle_stage?: string | null
  conversation_stage?: string | null
  lead_temperature?: string | null
  contactability_status?: string | null
  inbox_bucket?: string | null
  is_archived?: boolean | null
  suppression_status?: string | null
}): string => {
  const ringKey = resolveSellerStateRingKey({
    seller_state: pin.seller_state,
    operational_status: pin.operational_status || pin.conversation_status,
    lifecycle_stage: pin.lifecycle_stage || pin.conversation_stage,
    lead_temperature: pin.lead_temperature,
    inbox_category: pin.inbox_bucket,
    is_archived: pin.is_archived,
    contactability_status:
      pin.contactability_status
      || (pin.suppression_status && pin.suppression_status !== 'clear' ? 'dnc' : null),
  })
  return getUniversalRingColor(ringKey)
}