/**
 * Canonical TextGrid provider-event state machine — shared by live and recovery lanes.
 *
 * Monotonic precedence: delivered > failed/undelivered > sent > queued/pending
 */

import { normalizeTextGridFailure } from '@/lib/domain/messaging/textgrid-failure-normalization.js'
import {
  deliveryStatusRank,
  providerStatusRank,
  normalizeIncomingDeliveryStatus,
} from '@/lib/domain/delivery/delivery-receipt-reconcile.js'

export const WEBHOOK_PROCESSOR_VERSION = 'textgrid-webhook-v2'

const TERMINAL_STATUSES = new Set(['delivered', 'failed', 'undelivered'])
const INBOUND_STATUSES = new Set(['received', 'inbound'])

function clean(value) {
  return String(value ?? '').trim()
}

function lower(value) {
  return clean(value).toLowerCase()
}

export function extractProviderMessageSid(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {}
  const raw = payload.raw && typeof payload.raw === 'object' ? payload.raw : {}
  return (
    clean(row.provider_message_sid) ||
    clean(payload.message_id) ||
    clean(raw.MessageSid) ||
    clean(raw.SmsSid) ||
    null
  )
}

export function extractProviderStatus(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {}
  const raw = payload.raw && typeof payload.raw === 'object' ? payload.raw : {}
  return (
    lower(payload.status) ||
    lower(raw.MessageStatus) ||
    lower(raw.SmsStatus) ||
    lower(row.event_type) ||
    null
  )
}

export function extractProviderEventTimestamp(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {}
  const raw = payload.raw && typeof payload.raw === 'object' ? payload.raw : {}
  const candidates = [
    payload.delivered_at,
    payload.timestamp,
    payload.updated_at,
    raw.DateUpdated,
    raw.date_updated,
    row.created_at,
  ]
  for (const value of candidates) {
    const ts = clean(value)
    if (!ts) continue
    const parsed = new Date(ts).getTime()
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return row.created_at || null
}

export function normalizeProviderEventPayload(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {}
  const status = extractProviderStatus(row)
  const carrier_raw =
    payload.raw && typeof payload.raw === 'object' ? payload.raw : {}

  const normalized_failure = normalizeTextGridFailure({
    status: payload.status || status,
    error_message: payload.error_message,
    error_status: payload.error_status,
    reason: payload.reason,
    raw: carrier_raw,
    metadata: payload.metadata,
  })

  const canonical_status = normalized_failure.failure_class
    ? 'failed'
    : status === 'delivered'
      ? 'delivered'
      : status === 'undelivered'
        ? 'undelivered'
        : ['failed', 'error', 'delivery_failed'].includes(status)
          ? 'failed'
          : INBOUND_STATUSES.has(status)
            ? 'received'
            : ['sent', 'sending'].includes(status)
              ? 'sent'
              : ['queued', 'accepted', 'pending', 'awaiting_response'].includes(status)
                ? 'pending'
                : status || 'pending'

  return {
    provider_message_sid: extractProviderMessageSid(row),
    provider_status: status,
    canonical_status,
    event_timestamp: extractProviderEventTimestamp(row),
    webhook_log_id: row.id || null,
    webhook_created_at: row.created_at || null,
    normalized_failure,
    payload,
    error_message: clean(payload.error_message) || normalized_failure.provider_failure_reason || null,
    error_status: clean(payload.error_status) || normalized_failure.error_status || null,
    delivered_at: payload.delivered_at || payload.timestamp || null,
    sent_at: payload.sent_at || null,
    from: clean(payload.from) || null,
    to: clean(payload.to) || null,
  }
}

export function compareProviderEvents(a = {}, b = {}) {
  const a_ts = new Date(a.event_timestamp || a.webhook_created_at || 0).getTime()
  const b_ts = new Date(b.event_timestamp || b.webhook_created_at || 0).getTime()
  if (a_ts !== b_ts) return a_ts - b_ts
  return deliveryStatusRank(a.canonical_status) - deliveryStatusRank(b.canonical_status)
}

export function selectTerminalDeliveryEvent(events = []) {
  if (!events.length) return null

  const ordered = [...events].sort(compareProviderEvents)
  const terminal = ordered.filter((event) => TERMINAL_STATUSES.has(event.canonical_status))

  if (terminal.length) {
    const delivered = terminal.filter((e) => e.canonical_status === 'delivered')
    if (delivered.length) return delivered[delivered.length - 1]

    const undelivered = terminal.filter((e) => e.canonical_status === 'undelivered')
    if (undelivered.length) return undelivered[undelivered.length - 1]

    return terminal[terminal.length - 1]
  }

  return ordered[ordered.length - 1]
}

export function groupDeliveryEventsByProvider(rows = []) {
  const groups = new Map()

  for (const row of rows) {
    const normalized = normalizeProviderEventPayload(row)
    const sid = normalized.provider_message_sid
    if (!sid || !normalized.provider_status) continue

    if (!groups.has(sid)) groups.set(sid, { provider_message_sid: sid, rows: [], events: [] })
    const group = groups.get(sid)
    group.rows.push(row)
    group.events.push(normalized)
  }

  return groups
}

export function detectContradictoryTerminalStates(events = []) {
  const terminals = events.filter((e) => TERMINAL_STATUSES.has(e.canonical_status))
  const has_delivered = terminals.some((e) => e.canonical_status === 'delivered')
  const has_failed = terminals.some((e) => e.canonical_status === 'failed' || e.canonical_status === 'undelivered')
  if (has_delivered && has_failed) {
    return {
      contradictory: true,
      delivered_count: terminals.filter((e) => e.canonical_status === 'delivered').length,
      failed_count: terminals.filter((e) => e.canonical_status !== 'delivered').length,
    }
  }
  return { contradictory: false }
}

export function buildSyncPayloadFromTerminalEvent(event = {}) {
  const incoming = normalizeIncomingDeliveryStatus({
    provider_status: event.canonical_status === 'undelivered' ? 'undelivered' : event.provider_status,
    failure_class: event.normalized_failure?.failure_class || null,
  })

  return {
    message_id: event.provider_message_sid,
    provider_message_sid: event.provider_message_sid,
    status: event.provider_status || event.canonical_status,
    provider_delivery_status: event.provider_status,
    error_message: event.error_message,
    error_status: event.error_status,
    delivered_at: event.canonical_status === 'delivered' ? event.delivered_at || event.event_timestamp : null,
    sent_at: event.sent_at || null,
    webhook_log_id: event.webhook_log_id,
    raw: event.payload?.raw || event.payload,
    ...event.payload,
    _canonical_status: incoming,
    _processor_terminal_status: event.canonical_status,
  }
}

export function isInboundWebhookRow(row = {}) {
  const event_type = lower(row.event_type)
  const direction = lower(row.direction)
  if (event_type === 'inbound' || direction === 'inbound') return true
  const status = extractProviderStatus(row)
  return INBOUND_STATUSES.has(status)
}

export function isDeliveryWebhookRow(row = {}) {
  const event_type = lower(row.event_type)
  if (['delivery', 'status', 'outbound'].includes(event_type)) return true
  const status = extractProviderStatus(row)
  return status && !INBOUND_STATUSES.has(status)
}

export function inboundProcessingPriority(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {}
  const body = lower(payload.message_body || payload.message || payload.body || payload.Body)
  let priority = 0
  if (/\b(stop|unsubscribe|cancel|end|quit)\b/.test(body)) priority += 1000
  if (/\b(dnc|do not call|wrong number)\b/.test(body)) priority += 900
  const age_ms = Date.now() - new Date(row.created_at || 0).getTime()
  if (age_ms < 24 * 60 * 60 * 1000) priority += 500
  if (age_ms < 60 * 1000) priority += 200
  return priority
}

export { deliveryStatusRank, providerStatusRank, normalizeIncomingDeliveryStatus }