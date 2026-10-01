/**
 * Retry send, as a state rather than a button.
 *
 * Owner (2026-09-30): "For Retry Send especially, show the actual failure /
 * retry eligibility state rather than making it a generic resend button."
 *
 * A Live Activity event is history: by the time the operator opens it the
 * queue row behind a failed message may already be back in the queue, retried
 * and delivered, cancelled, or held by a guard. So the verdict reads the row as
 * it is NOW, and for a row that is still failed it asks the queue's own retry
 * authority (POST /api/cockpit/queue/retry with dry_run, which writes nothing)
 * whether it would accept a retry. Only then is "Retry send" offered, and the
 * retry itself is the same authority with dry_run false.
 *
 * What the engine does on its own (sms-engine.js): a retryable failure with
 * attempts left goes back to `queued` with next_retry_at five minutes out; a
 * row left at `failed` is one the engine decided not to retry (terminal
 * outcome or out of attempts).
 */
import { agoLabel } from './map-mobile-model'

export interface QueueRetryRow {
  id: string
  queue_status: string | null
  retry_count: number | null
  max_retries: number | null
  next_retry_at: string | null
  failed_reason: string | null
  blocked_reason: string | null
  paused_reason: string | null
  guard_reason: string | null
  sent_at: string | null
  delivered_at: string | null
  scheduled_for_utc: string | null
  scheduled_for: string | null
  updated_at: string | null
}

export const QUEUE_RETRY_ROW_COLUMNS = 'id,queue_status,retry_count,max_retries,next_retry_at,failed_reason,blocked_reason,paused_reason,guard_reason,sent_at,delivered_at,scheduled_for_utc,scheduled_for,updated_at'

/** The authority's dry-run verdict: undefined while asking. */
export type RetryAuthority = { ok: true } | { ok: false; reason: string } | undefined

export type RetryStateKind =
  | 'checking'   // still reading the row or asking the authority
  | 'eligible'   // the authority would requeue it: the button is offered
  | 'in_queue'   // already back in the queue (an automatic retry, or due)
  | 'went_out'   // a later attempt was sent or delivered
  | 'closed'     // final failure, suppressed, cancelled, expired
  | 'held'       // a guard or the authority refuses; a retry would not help
  | 'unknown'    // the row could not be read

export interface RetryState {
  kind: RetryStateKind
  /** One sentence: what is true about this message now. */
  line: string
  /** Attempts used, the recorded reason; null when there is nothing real to say. */
  meta: string | null
}

const FAILED = new Set(['failed', 'failed_transport', 'retry', 'retrying'])
const WAITING = new Set(['queued', 'ready', 'pending', 'approved', 'scheduled'])
const SENDING = new Set(['sending', 'processing'])
/** A guard is holding the row; requeueing it would only cycle it past the same guard. */
const HELD_PREFIXES = ['blocked', 'paused_', 'incident_quarantine', 'duplicate_blocked']

const AUTHORITY_REFUSALS: Record<string, string> = {
  outbound_sms_disabled: 'Outbound SMS is switched off, so nothing can be requeued.',
  queue_runner_disabled: 'The queue runner is off, so a requeued message would not move.',
  duplicate_active_or_sent_queue_row: 'Another message to this number is already queued or sent. A retry would double-text the seller.',
  paused_review: 'Held for operator review in the Queue.',
  incident_quarantine: 'Quarantined by an incident. The Queue decides when it is released.',
  queue_item_not_found: 'The queue row behind this message is no longer there.',
}

const words = (s?: string | null) => (s ? s.replace(/_/g, ' ').trim() : '')
const sentence = (s: string) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s)

/** "in 4 min", "at 3:40 PM", "Tue 9:15 AM": a future instant, for a person. */
export function dueLabel(ms: number, now: number): string {
  const diff = ms - now
  if (diff <= 60_000) return 'now'
  if (diff < 60 * 60_000) return `in ${Math.round(diff / 60_000)} min`
  const d = new Date(ms)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return new Date(now).toDateString() === d.toDateString()
    ? `at ${time}`
    : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

function attempts(row: QueueRetryRow): string | null {
  const used = Number(row.retry_count)
  const max = Number(row.max_retries)
  if (!Number.isFinite(used) || used <= 0) return null
  return Number.isFinite(max) && max > 0 ? `${used} of ${max} attempts used` : `${used} attempt${used === 1 ? '' : 's'} used`
}

function meta(row: QueueRetryRow, reason: string | null): string | null {
  const parts = [attempts(row), reason ? sentence(words(reason)) : null].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

/** "5m ago", or "just now" (agoLabel says "now", which reads badly mid-sentence). */
const since = (t: number, now: number) => {
  const label = agoLabel(t, now)
  return label === 'now' ? 'just now' : label
}

const at = (iso: string | null | undefined) => {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? t : null
}

export function retryVerdict(input: {
  /** undefined while loading; null when the row does not exist. */
  row: QueueRetryRow | null | undefined
  /** message_events.is_final_failure for the failed attempt. */
  finalFailure: boolean
  /** inbox_thread_state.is_suppressed for the conversation. */
  suppressed: boolean
  authority: RetryAuthority
  now: number
}): RetryState {
  const { row, finalFailure, suppressed, authority, now } = input
  if (row === undefined) return { kind: 'checking', line: 'Checking the queue…', meta: null }
  if (row === null) return { kind: 'unknown', line: AUTHORITY_REFUSALS.queue_item_not_found, meta: null }

  const status = String(row.queue_status || '').toLowerCase()
  if (suppressed) {
    return { kind: 'closed', line: 'This number is suppressed. Nothing more is sent to it.', meta: meta(row, row.failed_reason) }
  }

  // The row has moved on since the event: say where it is, offer nothing.
  if (status === 'delivered' || (status === 'sent' && row.delivered_at)) {
    const t = at(row.delivered_at) ?? at(row.sent_at)
    return { kind: 'went_out', line: `A later attempt was delivered${t ? ` ${since(t, now)}` : ''}.`, meta: attempts(row) }
  }
  if (status === 'sent') {
    const t = at(row.sent_at)
    return { kind: 'went_out', line: `A later attempt went out${t ? ` ${since(t, now)}` : ''}. Delivery is not confirmed yet.`, meta: attempts(row) }
  }
  if (SENDING.has(status)) return { kind: 'in_queue', line: 'Sending now.', meta: attempts(row) }
  if (WAITING.has(status)) {
    const retryAt = at(row.next_retry_at)
    if (retryAt && retryAt > now) {
      return { kind: 'in_queue', line: `The queue retries this automatically ${dueLabel(retryAt, now)}.`, meta: meta(row, row.failed_reason) }
    }
    const due = at(row.scheduled_for_utc) ?? at(row.scheduled_for)
    return {
      kind: 'in_queue',
      line: due && due > now ? `Already back in the queue, due ${dueLabel(due, now)}.` : 'Already back in the queue.',
      meta: meta(row, row.failed_reason),
    }
  }
  if (status === 'cancelled') return { kind: 'closed', line: 'Cancelled in the queue. It will not be retried.', meta: meta(row, row.failed_reason) }
  if (status === 'expired') return { kind: 'closed', line: 'Expired before it could go out.', meta: meta(row, row.failed_reason) }
  if (status === 'replied_before_send') return { kind: 'closed', line: 'The seller replied before it went out.', meta: null }

  if (status !== 'paused_max_retries' && HELD_PREFIXES.some((prefix) => status.startsWith(prefix))) {
    const why = row.blocked_reason || row.paused_reason || row.guard_reason || status
    return { kind: 'held', line: `Held by the queue: ${words(why)}. The guard decides, not a retry.`, meta: attempts(row) }
  }

  if (finalFailure) {
    return { kind: 'closed', line: 'The carrier marked this failure final. It will not be retried.', meta: meta(row, row.failed_reason) }
  }

  if (FAILED.has(status) || status === 'paused_max_retries') {
    if (authority === undefined) return { kind: 'checking', line: 'Asking the queue whether it would take a retry…', meta: meta(row, row.failed_reason) }
    if (!authority.ok && /^(BACKEND_|INVALID_JSON)/.test(authority.reason)) {
      return { kind: 'unknown', line: 'Could not reach the queue to check whether it would take a retry.', meta: meta(row, row.failed_reason) }
    }
    if (!authority.ok) {
      return {
        kind: 'held',
        line: AUTHORITY_REFUSALS[authority.reason] ?? `The queue would refuse a retry: ${words(authority.reason)}.`,
        meta: meta(row, row.failed_reason),
      }
    }
    const failedAt = at(row.updated_at)
    const lead = status === 'paused_max_retries'
      ? 'The queue stopped after its last attempt.'
      : `Not retried automatically${failedAt ? `; failed ${since(failedAt, now)}` : ''}.`
    return {
      kind: 'eligible',
      line: `${lead} A retry puts it back in the queue, and the queue's checks still decide whether it goes.`,
      meta: meta(row, row.failed_reason),
    }
  }

  return { kind: 'unknown', line: `Queue status: ${words(status) || 'unknown'}.`, meta: attempts(row) }
}
