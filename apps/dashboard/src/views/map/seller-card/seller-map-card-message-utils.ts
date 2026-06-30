import type { ThreadMessage } from '../../../lib/data/inboxData'
import { formatMessageDateTime } from '../../../shared/formatters'

export type DeliveryBadge = 'sending' | 'sent' | 'delivered' | 'failed' | 'scheduled' | 'cancelled'

export const messageTimestampIso = (message: ThreadMessage): string =>
  message.createdAt || message.sentAt || message.timelineAt || new Date().toISOString()

export const normalizeDeliveryBadge = (message: ThreadMessage): DeliveryBadge => {
  const status = String(message.deliveryStatusDisplay || message.deliveryStatus || '').toLowerCase()
  const raw = String(message.rawStatus || '').toLowerCase()
  const source = String(message.source || '').toLowerCase()
  const failedAt = String((message as { failedAt?: string | null; failed_at?: string | null }).failedAt
    ?? (message as { failed_at?: string | null }).failed_at
    ?? '').trim()
  const isFinalFailure = Boolean(
    (message as { isFinalFailure?: boolean; is_final_failure?: boolean }).isFinalFailure
    ?? (message as { is_final_failure?: boolean }).is_final_failure,
  )
  const statusEvidence = [status, raw].filter(Boolean)

  if (statusEvidence.some((value) => value.includes('cancel'))) return 'cancelled'

  const hasFailure = isFinalFailure
    || Boolean(failedAt)
    || Boolean(message.error)
    || statusEvidence.some((value) => (
      value.includes('fail')
      || value.includes('undeliv')
      || value.includes('rejected')
      || value === 'error'
      || value.includes('error')
    ))
  if (hasFailure) return 'failed'

  const isScheduled = source === 'send_queue'
    && statusEvidence.some((value) => value.includes('schedul') || value === 'queued' || value === 'approval' || value === 'pending')
    && !message.sentAt
  if (isScheduled) return 'scheduled'

  if (message.deliveredAt) return 'delivered'
  if (statusEvidence.some((value) => value.includes('deliver') && !value.includes('undeliv'))) return 'delivered'

  const messageAt = String(message.sentAt || message.deliveredAt || message.createdAt || '').trim()
  const messageAgeMs = messageAt ? Math.max(0, Date.now() - new Date(messageAt).getTime()) : Number.POSITIVE_INFINITY
  const isActivelySending = messageAgeMs < 45_000 && statusEvidence.some((value) => (
    value.includes('pending')
    || value.includes('queue')
    || value.includes('process')
    || value === 'queued'
    || value === 'sending'
  ))
  if (isActivelySending) return 'sending'

  if (message.sentAt) return 'delivered'
  if (statusEvidence.some((value) => value === 'sent' || value === 'success' || value === 'accepted')) return 'delivered'

  return 'delivered'
}

export const deliveryBadgeMeta = (badge: DeliveryBadge): { icon: string; label: string } => {
  switch (badge) {
    case 'sending': return { icon: '◷', label: 'Sending' }
    case 'sent': return { icon: '✓', label: 'Sent' }
    case 'delivered': return { icon: '✓✓', label: 'Delivered' }
    case 'failed': return { icon: '!', label: 'Failed' }
    case 'scheduled': return { icon: '◷', label: 'Scheduled' }
    case 'cancelled': return { icon: '×', label: 'Cancelled' }
    default: return { icon: '•', label: badge }
  }
}

const sameCalendarDay = (leftIso: string, rightIso: string): boolean => {
  const left = new Date(leftIso)
  const right = new Date(rightIso)
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

export const formatDateSeparator = (iso: string): string => {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return iso
  }
}

export const buildMessageTimelineMeta = (messages: ThreadMessage[]) =>
  messages.map((message, index) => {
    const timestampIso = messageTimestampIso(message)
    const previousIso = index > 0 ? messageTimestampIso(messages[index - 1]) : null
    const showDateSeparator = !previousIso || !sameCalendarDay(previousIso, timestampIso)
    const deliveryBadge = normalizeDeliveryBadge(message)
    return {
      message,
      timestampIso,
      showDateSeparator,
      deliveryBadge,
      receiptMeta: deliveryBadgeMeta(deliveryBadge),
      formattedTime: formatMessageDateTime(timestampIso),
    }
  })