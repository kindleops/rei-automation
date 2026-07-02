import { firstDefined, text } from './seller-map-card-formatters'
import type { FollowUpEligibilityView } from './seller-map-card.types'

export type FollowUpEligibilityState = FollowUpEligibilityView

const isSyntheticThreadKey = (threadKey: string | null): boolean =>
  Boolean(threadKey?.startsWith('property:'))

export const hasPriorOutboundContact = (record: Record<string, unknown>): boolean => {
  const outboundCount = Number(firstDefined(record, ['outbound_count', 'sent_count']) ?? 0)
  if (outboundCount > 0) return true

  const lastOutboundAt = text(firstDefined(record, [
    'last_outbound_at',
    'lastOutboundAt',
  ]))
  const lastOutboundText = text(firstDefined(record, [
    'last_outbound_text',
    'lastOutboundText',
    'latest_outbound_body',
  ]))
  if (lastOutboundText) return true

  const latestDirection = text(firstDefined(record, ['latest_direction', 'latestDirection', 'latest_message_direction']))
  if (lastOutboundAt && latestDirection === 'outbound') return true

  const latestAt = text(firstDefined(record, ['latest_message_at', 'latestMessageAt']))
  if (latestAt && latestDirection === 'outbound') return true

  return false
}

const isFollowUpDue = (
  record: Record<string, unknown>,
  status: string,
): boolean => {
  if (status === 'follow_up_due') return true

  const inboxCategory = text(firstDefined(record, ['inbox_category', 'inboxCategory', 'inbox_bucket']))
  if (inboxCategory.includes('follow_up')) return true

  const dueAt = text(firstDefined(record, [
    'follow_up_due_at',
    'next_follow_up_at',
    'follow_up_at',
    'nextFollowUpAt',
  ]))
  if (!dueAt) return false
  const dueMs = new Date(dueAt).getTime()
  return Number.isFinite(dueMs) && dueMs <= Date.now()
}

const resolveIneligibleReason = (
  record: Record<string, unknown>,
  state: {
    messagingBlocked: boolean
    messagingBlockReason: string | null
    status: string
    suppressed: boolean
    dnc: boolean
    suppressionReason: string | null
  },
): string => {
  if (state.dnc) return 'DNC'
  if (state.suppressed) return state.suppressionReason || 'Suppressed'
  if (state.messagingBlocked) return state.messagingBlockReason || 'Messaging blocked'

  const automation = text(firstDefined(record, ['automation_state', 'execution_state', 'automationState']))
  if (automation.toLowerCase().includes('paused')) return 'Automation paused'

  const blockState = text(firstDefined(record, ['block_state', 'thread_block_reason', 'suppression_reason']))
  if (blockState) return blockState

  if (!isFollowUpDue(record, state.status)) return 'Follow-up not due'

  const phone = text(firstDefined(record, ['canonical_e164', 'seller_phone', 'phone_number']))
  if (!phone) return 'Invalid contact'

  return 'Follow-up unavailable'
}

export const resolveFollowUpEligibility = (
  record: Record<string, unknown>,
  state: {
    threadKey: string | null
    messagingBlocked: boolean
    messagingBlockReason: string | null
    status: string
    suppressed: boolean
    dnc: boolean
    suppressionReason: string | null
  },
): FollowUpEligibilityState => {
  const uncontacted = isSyntheticThreadKey(state.threadKey) || !hasPriorOutboundContact(record)

  if (uncontacted) {
    const blocked = state.messagingBlocked || state.dnc || state.suppressed
    return {
      visible: true,
      canExecute: !blocked,
      label: 'Send Ownership Check',
      disabledReason: blocked ? resolveIneligibleReason(record, state) : null,
      isUncontacted: true,
    }
  }

  if (state.messagingBlocked || state.dnc || state.suppressed) {
    return {
      visible: true,
      canExecute: false,
      label: 'Follow Up',
      disabledReason: resolveIneligibleReason(record, state),
      isUncontacted: false,
    }
  }

  if (!isFollowUpDue(record, state.status)) {
    return {
      visible: true,
      canExecute: false,
      label: 'Follow Up',
      disabledReason: resolveIneligibleReason(record, state),
      isUncontacted: false,
    }
  }

  return {
    visible: true,
    canExecute: true,
    label: 'Follow Up',
    disabledReason: null,
    isUncontacted: false,
  }
}