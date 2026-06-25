/**
 * Canonical inbox thread-row presentation for latest conversational message.
 * Inbound latest → "Inbound" only; outbound latest → provider delivery state.
 */

export type LatestMessageDirection = 'inbound' | 'outbound' | 'unknown'

export const normalizeLatestMessageDirection = (value: unknown): LatestMessageDirection => {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return 'unknown'
  if (raw === 'in' || raw.startsWith('in_') || raw.startsWith('in-') || raw.startsWith('in ')) return 'inbound'
  if (raw === 'out' || raw.startsWith('out_') || raw.startsWith('out-') || raw.startsWith('out ')) return 'outbound'
  if (raw.includes('inbound') || raw.includes('incoming') || raw.includes('received')) return 'inbound'
  if (raw.includes('outbound') || raw.includes('outgoing') || raw.includes('sent')) return 'outbound'
  return 'unknown'
}

const deliveryTokens = (row: Record<string, unknown>): string[] => [
  row.latest_delivery_status,
  row.delivery_status,
  row.latest_provider_delivery_status,
  row.provider_delivery_status,
  row.latestDeliveryStatus,
  row.deliveryStatus,
  row.queue_status,
  row.queueStatus,
].map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean)

export const gateDeliveryFieldsForDirection = <T extends Record<string, unknown>>(
  row: T,
  direction: LatestMessageDirection,
): T => {
  if (direction !== 'inbound') return row
  return {
    ...row,
    delivery_status: null,
    deliveryStatus: null,
    latest_delivery_status: null,
    latestDeliveryStatus: null,
    provider_delivery_status: null,
    providerDeliveryStatus: null,
    latest_provider_delivery_status: null,
    latestProviderDeliveryStatus: null,
    queue_status: undefined,
    queueStatus: undefined,
  }
}

export const resolveLatestMessageStatusLabel = (
  row: Record<string, unknown>,
  directionInput?: unknown,
): string => {
  const direction = normalizeLatestMessageDirection(
    directionInput ?? row.latest_message_direction ?? row.latestDirection ?? row.direction,
  )
  if (direction === 'inbound') return 'Inbound'

  const tokens = deliveryTokens(row)
  const failedAt = String(row.latest_failed_at ?? row.latestFailedAt ?? row.failed_at ?? '').trim()
  const failureReason = String(
    row.latest_failure_reason ?? row.latestFailureReason ?? row.failure_reason ?? '',
  ).trim()
  const isFinalFailure = row.is_final_failure === true || row.isFinalFailure === true

  if (
    isFinalFailure
    || Boolean(failedAt)
    || Boolean(failureReason)
    || tokens.some((s) => s.includes('fail') || s.includes('undeliv') || s === 'error')
  ) {
    return 'Failed'
  }

  const deliveredAt = String(row.latest_delivered_at ?? row.latestDeliveredAt ?? '').trim()
  if (
    Boolean(deliveredAt)
    || tokens.some((s) => s.includes('deliver') && !s.includes('undeliv'))
  ) {
    return 'Delivered'
  }

  const sentAt = String(row.latest_sent_at ?? row.latestSentAt ?? row.sent_at ?? '').trim()
  if (sentAt || tokens.some((s) => s === 'sent' || s === 'success' || s === 'accepted')) {
    return 'Sent'
  }

  if (
    tokens.some((s) => s.includes('queue') || s.includes('pending') || s.includes('process') || s === 'queued')
  ) {
    return 'Queued'
  }

  if (direction === 'outbound') return 'Pending'
  return 'Inbound'
}