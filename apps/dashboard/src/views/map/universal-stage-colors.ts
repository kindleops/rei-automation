/**
 * Universal stage / status color rules — shared across map, inbox, queue,
 * composer, pipeline, and deal intelligence. Ring color is the primary carrier.
 */

export const UNIVERSAL_STAGE_RING_COLORS = {
  uncontacted: '#659BFF',
  ownership_check: '#42C4FF',
  needs_review: '#FFB84C',
  active_communication: '#29E68B',
  waiting_on_seller: '#FFD34F',
  negotiating: '#FF893D',
  follow_up_due: '#FF4FD8',
  hot_urgent: '#FF4C55',
  suppressed_dnc: '#C7475D',
  closed_resolved: '#3BC9B5',
  dead_archived: '#697486',
} as const

export type UniversalStageRingKey = keyof typeof UNIVERSAL_STAGE_RING_COLORS

export const EXECUTION_RING_COLORS = {
  queued: '#8f9bad',
  scheduled: '#5bb6ff',
  sent: '#a78bfa',
  delivered: '#30d158',
  replied: '#38d8f0',
  follow_up_due: '#ff2d87',
  failed: '#ff453a',
  blocked_issue: '#ff7a45',
  active: '#22d3ee',
  ready: '#22d3ee',
} as const

export type ExecutionRingKey = keyof typeof EXECUTION_RING_COLORS

const lower = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_')

export const resolveSellerStateRingKey = (input: {
  seller_state?: string | null
  seller_status?: string | null
  inbox_category?: string | null
  operational_status?: string | null
  lifecycle_stage?: string | null
  lead_temperature?: string | null
  contactability_status?: string | null
  is_archived?: boolean | null
}): UniversalStageRingKey => {
  const archived = input.is_archived === true
  if (archived) return 'dead_archived'

  const contactability = lower(input.contactability_status)
  if (['dnc', 'opted_out', 'do_not_text', 'provider_blacklisted'].includes(contactability)) {
    return 'suppressed_dnc'
  }

  const sellerState = lower(input.seller_state)
  const inboxCategory = lower(input.inbox_category)
  const operational = lower(input.operational_status || input.seller_status)
  const temperature = lower(input.lead_temperature)
  const lifecycle = lower(input.lifecycle_stage)

  if (sellerState === 'hot' || temperature === 'hot' || inboxCategory === 'hot') return 'hot_urgent'
  if (operational === 'follow_up_due' || inboxCategory === 'follow_up_due') return 'follow_up_due'
  if (operational === 'needs_review' || inboxCategory === 'needs_review' || sellerState === 'issue') {
    return 'needs_review'
  }
  if (sellerState === 'negotiating' || operational === 'negotiating') return 'negotiating'
  if (
    operational === 'active_communication'
    || sellerState === 'positive_intent'
    || sellerState === 'new_reply'
    || inboxCategory === 'new_reply'
    || sellerState === 'contacted'
  ) {
    return sellerState === 'new_reply' || inboxCategory === 'new_reply'
      ? 'active_communication'
      : 'active_communication'
  }
  if (operational === 'waiting_on_seller' || sellerState === 'asking_price_provided') {
    return 'waiting_on_seller'
  }
  if (
    sellerState === 'blocked'
    || sellerState === 'suppressed'
    || sellerState === 'wrong_number'
    || inboxCategory === 'suppressed'
    || inboxCategory === 'dnc_suppressed'
  ) {
    return 'suppressed_dnc'
  }
  if (lifecycle === 'closed' || sellerState === 'closed') return 'closed_resolved'
  if (lifecycle === 'ownership_confirmation' || lifecycle === 'ownership_check') {
    return 'ownership_check'
  }
  if (!sellerState || sellerState === 'not_contacted' || inboxCategory === 'not_contacted') {
    return 'uncontacted'
  }
  return 'uncontacted'
}

export const resolveExecutionRingKey = (executionState: string | null | undefined): ExecutionRingKey | null => {
  const state = lower(executionState)
  if (!state || state === 'none') return null
  if (state === 'queued') return 'queued'
  if (state === 'scheduled') return 'scheduled'
  if (state === 'sent') return 'sent'
  if (state === 'delivered') return 'delivered'
  if (state === 'replied' || state === 'new_reply') return 'replied'
  if (state === 'follow_up_due') return 'follow_up_due'
  if (state === 'failed' || state === 'issue') return 'failed'
  if (state === 'blocked') return 'blocked_issue'
  if (state === 'active' || state === 'active_sending') return 'active'
  if (state === 'ready') return 'ready'
  return null
}

export const getUniversalRingColor = (ringKey: UniversalStageRingKey): string =>
  UNIVERSAL_STAGE_RING_COLORS[ringKey]

export const getExecutionRingColor = (ringKey: ExecutionRingKey): string =>
  EXECUTION_RING_COLORS[ringKey]

export const shouldPulseForSellerPin = (input: {
  seller_state?: string | null
  inbox_category?: string | null
  operational_status?: string | null
  pulse_style?: string | null
  execution_state?: string | null
}): boolean => {
  const pulse = lower(input.pulse_style)
  if (pulse && pulse !== 'none') return true
  const state = lower(input.seller_state)
  const inbox = lower(input.inbox_category)
  const operational = lower(input.operational_status)
  const execution = lower(input.execution_state)
  return (
    state === 'new_reply'
    || state === 'hot'
    || inbox === 'new_reply'
    || inbox === 'follow_up_due'
    || operational === 'follow_up_due'
    || operational === 'active_communication'
    || execution === 'active'
    || execution === 'replied'
  )
}

export const resolvePulseStyle = (input: {
  seller_state?: string | null
  inbox_category?: string | null
  operational_status?: string | null
  lead_temperature?: string | null
  pulse_style?: string | null
  execution_state?: string | null
}): string => {
  const existing = lower(input.pulse_style)
  if (existing && existing !== 'none') return existing
  const state = lower(input.seller_state)
  const inbox = lower(input.inbox_category)
  const temp = lower(input.lead_temperature)
  const operational = lower(input.operational_status)
  if (state === 'hot' || temp === 'hot' || inbox === 'follow_up_due' || operational === 'follow_up_due') {
    return 'pulse_strong'
  }
  if (state === 'new_reply' || inbox === 'new_reply') return 'pulse_warning'
  if (operational === 'active_communication' || lower(input.execution_state) === 'active') {
    return 'pulse_soft'
  }
  return 'none'
}