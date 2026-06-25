/**
 * Canonical inbox thread-row presentation for latest conversational message.
 */

function clean(value) {
  return String(value ?? '').trim()
}

export function normalizeLatestMessageDirection(value) {
  const raw = clean(value).toLowerCase()
  if (!raw) return 'unknown'
  if (raw === 'in' || raw.startsWith('in_') || raw.startsWith('in-') || raw.startsWith('in ')) return 'inbound'
  if (raw === 'out' || raw.startsWith('out_') || raw.startsWith('out-') || raw.startsWith('out ')) return 'outbound'
  if (raw.includes('inbound') || raw.includes('incoming') || raw.includes('received')) return 'inbound'
  if (raw.includes('outbound') || raw.includes('outgoing') || raw.includes('sent')) return 'outbound'
  return 'unknown'
}

export function gateDeliveryFieldsForDirection(row = {}, direction) {
  if (direction !== 'inbound') return row
  return {
    ...row,
    delivery_status: null,
    latest_delivery_status: null,
    provider_delivery_status: null,
    latest_provider_delivery_status: null,
    queue_status: null,
  }
}

export function resolveLatestMessageStatusLabel(row = {}, directionInput) {
  const direction = normalizeLatestMessageDirection(
    directionInput ?? row.latest_message_direction ?? row.latest_direction ?? row.direction,
  )
  if (direction === 'inbound') return 'Inbound'

  const tokens = [
    row.latest_delivery_status,
    row.delivery_status,
    row.latest_provider_delivery_status,
    row.provider_delivery_status,
    row.queue_status,
  ].map((v) => clean(v).toLowerCase()).filter(Boolean)

  const failedAt = clean(row.latest_failed_at ?? row.failed_at)
  const failureReason = clean(row.latest_failure_reason ?? row.failure_reason)
  const isFinalFailure = row.is_final_failure === true

  if (
    isFinalFailure
    || failedAt
    || failureReason
    || tokens.some((s) => s.includes('fail') || s.includes('undeliv') || s === 'error')
  ) {
    return 'Failed'
  }

  const deliveredAt = clean(row.latest_delivered_at ?? row.delivered_at)
  if (deliveredAt || tokens.some((s) => s.includes('deliver') && !s.includes('undeliv'))) {
    return 'Delivered'
  }

  const sentAt = clean(row.latest_sent_at ?? row.sent_at)
  if (sentAt || tokens.some((s) => s === 'sent' || s === 'success' || s === 'accepted')) {
    return 'Sent'
  }

  if (tokens.some((s) => s.includes('queue') || s.includes('pending') || s.includes('process') || s === 'queued')) {
    return 'Queued'
  }

  if (direction === 'outbound') return 'Pending'
  return 'Inbound'
}