/**
 * resolve-orphaned-attempts.js (rc-8.5.21 v3, RT-14 / RT-15)
 *
 * The processing-lease reaper (domain/queue/processing-lease-recovery.js) found a worker that died while
 * holding a row. Two §11 attempt shapes left by such a crash are NOT ambiguous, and treating them as
 * ambiguous left a seller turn in manual review forever (RT-14) or a sent message "processing" forever
 * (RT-15):
 *
 *   UNSTARTED  the attempt was allocated (completed_at NULL) but provider_request_started_at was never
 *              committed. The seam NEVER calls the provider before that marker is durable
 *              (canonical-communication-dispatch.js §13-14), so the provider was provably not invoked.
 *              It is resolved here as failed_provably_unsent / definitely_not_sent / retry_allowed and
 *              the logical communication goes CLAIMED → READY (the transition authority's one edge
 *              back), so the row's ONE re-dispatch can allocate a fresh attempt. The write is a
 *              compare-and-set on (started IS NULL, completed IS NULL); the seam's start marker requires
 *              completed_at IS NULL too, so a stalled worker can never start an attempt resolved here.
 *   ACCEPTED   the attempt carries the provider message id (written with completed_at by
 *              recordAttemptOutcome): the provider ACCEPTED it. The queue row is reconciled to `sent`
 *              from that evidence — never re-submitted.
 *
 * Anything else (started without an id, an unknown possibility) stays ambiguous: manual review, and the
 * caller makes it visible. The §11 tables are written only from this domain.
 */
import { ATTEMPT_STATES, DELIVERY_POSSIBILITY, LOGICAL_STATES, RETRY_AUTHORITY } from './communication-transition-authority.js'

export const ORPHAN_RESOLUTION_VERSION = 'resolve-orphaned-attempts.v1'
export const ORPHAN_FAILURE_CLASS = 'crashed_before_provider_request_start'
const clean = (v) => String(v ?? '').trim()

/** Pure: the shape of one attempt for crash recovery. */
export function classifyCrashedAttempt(a = {}) {
  if (clean(a.provider_message_id)) return 'accepted'
  const noTransport = !a.provider_request_started_at && (a.http_status === null || a.http_status === undefined) && !clean(a.provider_status)
  if (!a.completed_at && noTransport) return 'unstarted'
  if (a.completed_at && clean(a.delivery_possibility) === DELIVERY_POSSIBILITY.DEFINITELY_NOT_SENT) return 'resolved_unsent'
  return 'ambiguous'
}

/**
 * Resolve every UNSTARTED attempt in `attempts` (compare-and-set). Returns the attempts as they now are.
 * A failed write leaves that attempt as it was (⇒ the row stays in manual review). Never throws.
 */
export async function resolveUnstartedAttempts(supabase, attempts = [], { now = new Date().toISOString() } = {}) {
  const out = []
  for (const a of attempts || []) {
    if (classifyCrashedAttempt(a) !== 'unstarted' || !supabase?.from) { out.push(a); continue }
    try {
      const { data, error } = await supabase.from('seller_communication_attempts')
        .update({ completed_at: now, outcome_class: ATTEMPT_STATES.FAILED_PROVABLY_UNSENT, delivery_possibility: DELIVERY_POSSIBILITY.DEFINITELY_NOT_SENT, retry_authority: RETRY_AUTHORITY.RETRY_ALLOWED, failure_class: ORPHAN_FAILURE_CLASS, transport_phase: 'not_started' })
        .eq('id', a.id).is('provider_request_started_at', null).is('completed_at', null)
        .select('id')
      if (error || !Array.isArray(data) || data.length !== 1) { out.push(a); continue }
      if (clean(a.logical_communication_id)) {
        await supabase.from('seller_logical_communications')
          .update({ state: LOGICAL_STATES.READY, delivery_possibility: DELIVERY_POSSIBILITY.DEFINITELY_NOT_SENT, retry_authority: RETRY_AUTHORITY.RETRY_ALLOWED, last_failure_class: ORPHAN_FAILURE_CLASS, updated_at: now })
          .eq('id', a.logical_communication_id).eq('state', LOGICAL_STATES.CLAIMED).eq('current_attempt_id', a.id)
      }
      out.push({ ...a, completed_at: now, outcome_class: ATTEMPT_STATES.FAILED_PROVABLY_UNSENT, delivery_possibility: DELIVERY_POSSIBILITY.DEFINITELY_NOT_SENT, transport_phase: 'not_started', resolved_by: ORPHAN_RESOLUTION_VERSION })
    } catch {
      out.push(a)
    }
  }
  return out
}

/** The accepted attempt (provider id) of a crashed row, when there is exactly one. Pure. */
export function acceptedAttemptOf(attempts = []) {
  const acc = (attempts || []).filter((a) => classifyCrashedAttempt(a) === 'accepted')
  return acc.length === 1 ? acc[0] : null
}
