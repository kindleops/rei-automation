/**
 * send-outcome-confirmation.ts
 *
 * A LOST RESPONSE IS NOT A FAILED SEND.
 *
 * 2026-09-30 14:51Z: the phone composer showed "Send Failed — backend_network_error
 * ... Load failed" with a Retry button for a message the seller had already
 * received (send_queue fc39b22b: provider-accepted, finalized `sent`, delivered
 * 14:54Z). "Load failed" is WebKit's generic network error: the phone gave up
 * on the request, so the client knew NOTHING about the outcome -- and reported
 * the one outcome that invites a duplicate SMS.
 *
 * When the send-now call ends without an authoritative answer from the API
 * (network error, client deadline, cancelled request, a gateway error page),
 * the client now asks the server what happened to that exact click, by the
 * client_send_id it stamped on the request, and reports only what the server
 * confirms. Until then it says "not confirmed" -- never "failed".
 *
 * Pure: every effect (the status fetch, sleeping, the clock) is injected.
 */

export type SendOutcomeState = 'delivered' | 'sent' | 'in_flight' | 'failed' | 'not_found'

/** Body of GET /api/cockpit/inbox/send-status (see apps/api send-now-outcome.js). */
export interface SendStatusSnapshot {
  ok: boolean
  state?: SendOutcomeState
  terminal?: boolean
  queue_row_id?: string | null
  queue_status?: string | null
  provider_message_id?: string | null
  failed_reason?: string | null
}

/** The subset of a BackendResult this module reads. */
export interface BackendFailureLike {
  ok: boolean
  status?: number
  error?: string
  upstream?: unknown
}

/**
 * callBackend error codes that mean the API never answered this request:
 * the browser could not complete it, gave up on it, or received a proxy's
 * page instead of the API's JSON. The request may still have been executed.
 */
const INDETERMINATE_ERRORS = new Set([
  'BACKEND_NETWORK_ERROR',
  'BACKEND_TIMEOUT',
  'BACKEND_UNAVAILABLE',
  'BACKEND_REQUEST_CANCELLED',
  'BACKEND_CORS_ERROR',
  'BACKEND_HTML_ERROR',
  'INVALID_JSON_RESPONSE',
])

/** Gateway statuses (incl. Cloudflare 52x) that can front a request the API still ran. */
const GATEWAY_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530])

function hasApiVerdict(upstream: unknown): boolean {
  if (!upstream || typeof upstream !== 'object') return false
  const body = upstream as Record<string, unknown>
  return 'ok' in body || 'reason' in body
}

/**
 * True when a failed send-now result carries NO authoritative verdict from the
 * API, so the send may or may not have happened. A JSON refusal from the API
 * (423 compliance block, 400 validation, 503 operator_action_not_durable, ...)
 * is authoritative and is NOT indeterminate.
 */
export function isIndeterminateSendFailure(result: BackendFailureLike | null | undefined): boolean {
  if (!result || result.ok) return false
  const error = String(result.error ?? '').trim().toUpperCase()
  if (INDETERMINATE_ERRORS.has(error)) return true
  return GATEWAY_STATUSES.has(Number(result.status)) && !hasApiVerdict(result.upstream)
}

export type ConfirmedState = 'delivered' | 'sent' | 'failed' | 'in_flight' | 'not_found' | 'unreachable'

export interface ConfirmedSendOutcome {
  state: ConfirmedState
  /** A terminal answer (delivered / sent / failed) was obtained from the server. */
  confirmed: boolean
  attempts: number
  snapshot: SendStatusSnapshot | null
}

export interface ConfirmSendOutcomeOptions {
  clientSendId: string
  threadKey: string
  fetchStatus: (clientSendId: string, threadKey: string) => Promise<SendStatusSnapshot | null>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** How long to keep asking before settling for "not confirmed". */
  windowMs?: number
  /** Delay before each re-check; the last entry repeats. The first check is immediate. */
  scheduleMs?: number[]
}

/**
 * 60s: on 2026-09-30 the API needed ~19s from receiving a send to writing its
 * queue row and ~27s to the provider under database saturation. The window
 * outlasts that so a slow-but-successful send is confirmed, not abandoned.
 */
export const DEFAULT_CONFIRM_WINDOW_MS = 60_000
export const DEFAULT_CONFIRM_SCHEDULE_MS = [1_500, 2_500, 4_000, 6_000, 8_000, 10_000]

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Ask the server, by client_send_id, what happened to one send. Stops at the
 * first terminal answer; otherwise keeps asking until the window closes.
 * Never throws.
 */
export async function confirmSendOutcome(options: ConfirmSendOutcomeOptions): Promise<ConfirmedSendOutcome> {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? (() => Date.now())
  const windowMs = options.windowMs ?? DEFAULT_CONFIRM_WINDOW_MS
  const schedule = options.scheduleMs && options.scheduleMs.length > 0 ? options.scheduleMs : DEFAULT_CONFIRM_SCHEDULE_MS
  const deadline = now() + windowMs

  let attempts = 0
  let lastReachable: SendStatusSnapshot | null = null
  let last: SendStatusSnapshot | null = null

  for (let index = 0; ; index += 1) {
    attempts += 1
    let snapshot: SendStatusSnapshot | null = null
    try {
      snapshot = await options.fetchStatus(options.clientSendId, options.threadKey)
    } catch {
      snapshot = null
    }
    last = snapshot

    if (snapshot?.ok && snapshot.state) {
      lastReachable = snapshot
      if (snapshot.state === 'delivered' || snapshot.state === 'sent' || snapshot.state === 'failed') {
        return { state: snapshot.state, confirmed: true, attempts, snapshot }
      }
    }

    const delay = schedule[Math.min(index, schedule.length - 1)]
    if (now() + delay > deadline) break
    await sleep(delay)
  }

  if (lastReachable) {
    return {
      state: lastReachable.state === 'in_flight' ? 'in_flight' : 'not_found',
      confirmed: false,
      attempts,
      snapshot: lastReachable,
    }
  }
  return { state: 'unreachable', confirmed: false, attempts, snapshot: last }
}

export interface ConfirmationVerdict {
  ok: boolean
  /** The outcome is still unknown: show "not confirmed", never "failed", and never offer a blind retry. */
  outcomeUnknown: boolean
  deliveryStatus: 'delivered' | 'sent' | 'failed' | 'unconfirmed'
  reason: string
  message: string | null
  queueId: string | null
  providerMessageSid: string | null
}

/** Turn a confirmation into what the composer shows. Pure. */
export function verdictFromConfirmation(confirmation: ConfirmedSendOutcome): ConfirmationVerdict {
  const snapshot = confirmation.snapshot
  const queueId = snapshot?.queue_row_id ?? null
  const providerMessageSid = snapshot?.provider_message_id ?? null

  switch (confirmation.state) {
    case 'delivered':
    case 'sent':
      return {
        ok: true,
        outcomeUnknown: false,
        deliveryStatus: confirmation.state,
        reason: 'confirmed_after_transport_error',
        message: null,
        queueId,
        providerMessageSid,
      }
    case 'failed': {
      const reason = String(snapshot?.failed_reason || snapshot?.queue_status || 'send_failed')
      return {
        ok: false,
        outcomeUnknown: false,
        deliveryStatus: 'failed',
        reason,
        message: `Send failed — ${reason.replace(/_/g, ' ')}.`,
        queueId,
        providerMessageSid,
      }
    }
    case 'in_flight':
      return {
        ok: false,
        outcomeUnknown: true,
        deliveryStatus: 'unconfirmed',
        reason: 'send_not_confirmed_in_flight',
        message: 'Not confirmed yet — the server is still processing this send. Do not resend; the thread will update when it settles.',
        queueId,
        providerMessageSid,
      }
    case 'not_found':
      return {
        ok: false,
        outcomeUnknown: true,
        deliveryStatus: 'unconfirmed',
        reason: 'send_not_confirmed_no_record',
        message: 'Not confirmed — the connection dropped and the server has no record of this send yet. Check the thread before resending.',
        queueId,
        providerMessageSid,
      }
    case 'unreachable':
    default:
      return {
        ok: false,
        outcomeUnknown: true,
        deliveryStatus: 'unconfirmed',
        reason: 'send_not_confirmed_unreachable',
        message: 'Not confirmed — the server could not be reached to check this send. Check the thread before resending.',
        queueId,
        providerMessageSid,
      }
  }
}
