/**
 * Map intelligence modes — functional overlays, pin emphasis, and behavior.
 * Separate from visual theme presets.
 */

export type CommandMapIntelligenceModeId =
  | 'acquisition'
  | 'buyer_demand'
  | 'comps'
  | 'execution'
  | 'opportunity_heat'
  | 'territory'
  | 'census'
  | 'command'

export type CommandMapIntelligenceModeDefinition = {
  id: CommandMapIntelligenceModeId
  label: string
  description: string
  swatches: string[]
  /** Seller pin base opacity when not emphasized */
  sellerPinBaseOpacity: number
  /** Dim uncontacted pins in this mode */
  dimUncontacted: boolean
  /** Emphasize high-priority signals */
  emphasizePriority: boolean
  /** Ring color source: stage/status vs execution state */
  ringSource: 'stage' | 'execution' | 'neutral'
  /** Simplify pin visuals (territory scan) */
  simplifyPins: boolean
  /** Overlay-first mode — pins become secondary */
  overlayPrimary: boolean
}

export const COMMAND_MAP_INTELLIGENCE_MODES: CommandMapIntelligenceModeDefinition[] = [
  {
    id: 'acquisition',
    label: 'Acquisition Radar',
    description: 'Seller leads, threads, motivation, urgency',
    swatches: ['#7a8fa8', '#30d158', '#ff6b35'],
    sellerPinBaseOpacity: 1,
    dimUncontacted: true,
    emphasizePriority: false,
    ringSource: 'stage',
    simplifyPins: false,
    overlayPrimary: false,
  },
  {
    id: 'buyer_demand',
    label: 'Buyer Demand',
    description: 'Buyer comps, repeat buyers, liquidity hotspots',
    swatches: ['#2563eb', '#14b8a6', '#8b5cf6'],
    sellerPinBaseOpacity: 0.4,
    dimUncontacted: true,
    emphasizePriority: false,
    ringSource: 'stage',
    simplifyPins: false,
    overlayPrimary: false,
  },
  {
    id: 'comps',
    label: 'Comps Intel',
    description: 'Sold comps, price anchors, valuation context',
    swatches: ['#ef4444', '#f97316', '#eab308'],
    sellerPinBaseOpacity: 0.55,
    dimUncontacted: true,
    emphasizePriority: false,
    ringSource: 'stage',
    simplifyPins: false,
    overlayPrimary: false,
  },
  {
    id: 'execution',
    label: 'Execution Live',
    description: 'Queued, sent, delivered, failed, replies',
    swatches: ['#8f9bad', '#5bb6ff', '#30d158'],
    sellerPinBaseOpacity: 1,
    dimUncontacted: true,
    emphasizePriority: false,
    ringSource: 'execution',
    simplifyPins: false,
    overlayPrimary: false,
  },
  {
    id: 'opportunity_heat',
    label: 'Opportunity Heat',
    description: 'Equity, distress, motivation, census pressure',
    swatches: ['#3b82f6', '#14b8a6', '#f97316', '#ef4444'],
    sellerPinBaseOpacity: 0.45,
    dimUncontacted: true,
    emphasizePriority: false,
    ringSource: 'stage',
    simplifyPins: false,
    overlayPrimary: true,
  },
  {
    id: 'territory',
    label: 'Territory Scan',
    description: 'Property universe, asset mix, boundaries',
    swatches: ['#64748b', '#94a3b8', '#a6d260'],
    sellerPinBaseOpacity: 0.85,
    dimUncontacted: false,
    emphasizePriority: false,
    ringSource: 'stage',
    simplifyPins: true,
    overlayPrimary: false,
  },
  {
    id: 'census',
    label: 'Census Intel',
    description: 'Demographic and economic overlays',
    swatches: ['#06b6d4', '#8b5cf6', '#38bdf8'],
    sellerPinBaseOpacity: 0.38,
    dimUncontacted: true,
    emphasizePriority: false,
    ringSource: 'neutral',
    simplifyPins: false,
    overlayPrimary: true,
  },
  {
    id: 'command',
    label: 'Command Mode',
    description: 'Highest-priority leads, follow-ups, replies, urgent activity',
    swatches: ['#ff2d87', '#ff6b35', '#30d158'],
    sellerPinBaseOpacity: 0.28,
    dimUncontacted: true,
    emphasizePriority: true,
    ringSource: 'stage',
    simplifyPins: false,
    overlayPrimary: false,
  },
]

export const getIntelligenceMode = (
  modeId: CommandMapIntelligenceModeId | string,
): CommandMapIntelligenceModeDefinition =>
  COMMAND_MAP_INTELLIGENCE_MODES.find((m) => m.id === modeId)
  ?? COMMAND_MAP_INTELLIGENCE_MODES[0]

export type PinModeModifiers = {
  focusOpacity: number
  glowStrength: number
  ringOpacity: number
  iconScale: number
  showPulse: boolean
  glassOpacity: number
}

const isHighPriorityPin = (input: {
  seller_state?: string | null
  inbox_category?: string | null
  operational_status?: string | null
  lead_temperature?: string | null
  execution_state?: string | null
  priority_score?: number | null
}): boolean => {
  const state = String(input.seller_state ?? '').toLowerCase()
  const inbox = String(input.inbox_category ?? '').toLowerCase()
  const operational = String(input.operational_status ?? '').toLowerCase()
  const temp = String(input.lead_temperature ?? '').toLowerCase()
  const execution = String(input.execution_state ?? '').toLowerCase()
  const priority = Number(input.priority_score ?? 0)
  return (
    state === 'hot'
    || state === 'new_reply'
    || state === 'negotiating'
    || inbox === 'new_reply'
    || inbox === 'follow_up_due'
    || operational === 'follow_up_due'
    || operational === 'active_communication'
    || operational === 'needs_review'
    || temp === 'hot'
    || execution === 'active'
    || execution === 'replied'
    || execution === 'issue'
    || priority >= 75
  )
}

const isUncontactedPin = (input: {
  seller_state?: string | null
  inbox_category?: string | null
}): boolean => {
  const state = String(input.seller_state ?? '').toLowerCase()
  const inbox = String(input.inbox_category ?? '').toLowerCase()
  return !state || state === 'not_contacted' || inbox === 'not_contacted'
}

export const computePinModeModifiers = (
  modeId: CommandMapIntelligenceModeId,
  pin: {
    seller_state?: string | null
    inbox_category?: string | null
    operational_status?: string | null
    lead_temperature?: string | null
    execution_state?: string | null
    priority_score?: number | null
  },
): PinModeModifiers => {
  const mode = getIntelligenceMode(modeId)
  const highPriority = isHighPriorityPin(pin)
  const uncontacted = isUncontactedPin(pin)

  let focusOpacity = mode.sellerPinBaseOpacity
  let glowStrength = 0.45
  let ringOpacity = 0.92
  let iconScale = 1
  let showPulse = true
  let glassOpacity = 0.88

  if (mode.id === 'command') {
    focusOpacity = highPriority ? 1 : mode.sellerPinBaseOpacity
    glowStrength = highPriority ? 1 : 0.22
    ringOpacity = highPriority ? 1 : 0.55
    iconScale = highPriority ? 1.08 : 0.92
    showPulse = highPriority
    glassOpacity = highPriority ? 0.94 : 0.62
  } else if (mode.emphasizePriority && highPriority) {
    focusOpacity = 1
    glowStrength = 0.88
  } else if (mode.dimUncontacted && uncontacted) {
    focusOpacity = Math.min(focusOpacity, mode.id === 'acquisition' ? 0.62 : focusOpacity)
    glowStrength = 0.28
    ringOpacity = 0.68
    glassOpacity = 0.72
  } else if (highPriority) {
    glowStrength = 0.78
    focusOpacity = Math.max(focusOpacity, 0.92)
  }

  if (mode.simplifyPins) {
    glowStrength *= 0.72
    ringOpacity *= 0.82
    glassOpacity *= 0.9
  }

  if (mode.overlayPrimary) {
    glowStrength *= 0.65
    ringOpacity *= 0.75
  }

  const priority = Number(pin.priority_score ?? 0)
  if (priority >= 90) glowStrength = Math.max(glowStrength, 0.95)
  else if (priority >= 70) glowStrength = Math.max(glowStrength, 0.72)
  else if (priority >= 40) glowStrength = Math.max(glowStrength, 0.52)

  return {
    focusOpacity,
    glowStrength,
    ringOpacity,
    iconScale,
    showPulse,
    glassOpacity,
  }
}