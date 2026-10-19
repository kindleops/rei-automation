// PROCESSING-LEASE RECOVERY (rc-8.5.21 blind-eval RUN-09).
//
// A worker that dies after claiming a row (queue_status 'processing', lease held) leaves the row stuck.
// Since the 08-31 hardening every such row went to the canonical non-dispatchable hold (`expired` +
// processing_lease_expired_manual_review) because "lease expiry does not prove the provider request
// never started". Correct as a default — and it left a seller's reply unsent forever even when the
// durable evidence PROVES no provider call happened.
//
// THE PROOF. The §11 seam (canonical-communication-dispatch.js) is the ONLY path to the provider, and it
// never invokes it before (a) a numbered attempt is allocated in the §11 attempt ledger with this
// queue_row_id and (b) provider_request_started_at is committed on that attempt. So a row is PROVABLY
// unsent when ALL of these hold, read fresh:
//   - the row carries no provider evidence (provider / textgrid message id, sent_at, delivered_at, or a
//     provider SID / id in metadata);
//   - the attempt ledger is READABLE and holds NO attempt for this row that is not a completed,
//     definitely-not-sent attempt (an allocated attempt, a started marker, any provider id / HTTP status /
//     provider status, any delivery possibility other than definitely_not_sent ⇒ a call may have begun);
//   - the row was never re-dispatched for an expired lease before (at most ONE re-dispatch, ever).
// Then the row returns to `queued` EXACTLY ONCE (lock released, retry_count untouched: this is not an
// ambiguous retry — AI rows keep max_retries 1), with the evidence recorded on the row. Every gate
// (STOP, suppression, holds, windows, the AI / follow-up row gates, dispatch authorization, the §11
// attempt allocation) runs again on the next claim. Anything else — unreadable ledger, any attempt,
// any evidence, a second expiry — keeps today's manual-review hold.
//
// A STALLED (not dead) worker cannot double-send through this: its lock token no longer authorizes
// dispatch, and the §11 allocation refuses a second attempt while one is unresolved or after acceptance.

import { loadQueueRowAttemptEvidence } from '../communications/queue-row-attempt-evidence.js'

export const LEASE_RECOVERY_VERSION = 'processing-lease-recovery.v1'
export const LEASE_MANUAL_REVIEW_REASON = 'processing_lease_expired_manual_review'
export const LEASE_REDISPATCH_REASON = 'processing_lease_expired_redispatched_no_provider_call'
export const MAX_LEASE_REDISPATCHES = 1

const clean = (v) => String(v ?? '').trim()
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

/** Provider evidence on the queue row itself (columns or metadata). Pure. */
export function rowProviderEvidence(row = {}) {
  const m = obj(row.metadata)
  const found = []
  if (clean(row.provider_message_id)) found.push('provider_message_id')
  if (clean(row.textgrid_message_id)) found.push('textgrid_message_id')
  if (row.sent_at) found.push('sent_at')
  if (row.delivered_at) found.push('delivered_at')
  for (const k of ['provider_message_sid', 'provider_message_id', 'textgrid_message_id', 'provider_sid', 'sid']) if (clean(m[k])) found.push(`metadata.${k}`)
  return found
}

/** Is this attempt row compatible with "no provider call happened for this row"? Pure. */
function attemptBlockers(a = {}) {
  const b = []
  if (clean(a.provider_message_id)) b.push('attempt_provider_message_id')
  if (a.provider_request_started_at && !(a.completed_at && clean(a.delivery_possibility) === 'definitely_not_sent')) b.push('attempt_provider_request_started')
  if (a.http_status !== null && a.http_status !== undefined && clean(a.delivery_possibility) !== 'definitely_not_sent') b.push('attempt_http_status')
  if (clean(a.provider_status) && clean(a.delivery_possibility) !== 'definitely_not_sent') b.push('attempt_provider_status')
  if (!a.completed_at) b.push('attempt_unresolved')
  else if (clean(a.delivery_possibility) !== 'definitely_not_sent') b.push(`attempt_delivery_possibility_${clean(a.delivery_possibility) || 'unknown'}`)
  return b
}

/**
 * The verdict for ONE processing row whose lease expired. Pure.
 * @param {object} row  the send_queue row (status processing)
 * @param {{ attempts_readable: boolean, attempts: object[] }} evidence  the row's §11 attempts
 * @returns {{ action: 'redispatch'|'manual_review', reason: string, blockers: string[] }}
 */
export function evaluateExpiredProcessingLease(row = {}, { attempts_readable = false, attempts = [] } = {}) {
  const blockers = []
  blockers.push(...rowProviderEvidence(row).map((k) => `row_${k}`))
  if (!attempts_readable) blockers.push('attempt_ledger_unreadable')
  for (const a of attempts || []) blockers.push(...attemptBlockers(a))
  const prior = Number(obj(row.metadata).lease_redispatch_count || 0)
  if (prior >= MAX_LEASE_REDISPATCHES) blockers.push('lease_redispatch_exhausted')
  const unique = [...new Set(blockers)]
  return unique.length
    ? { action: 'manual_review', reason: LEASE_MANUAL_REVIEW_REASON, blockers: unique }
    : { action: 'redispatch', reason: LEASE_REDISPATCH_REASON, blockers: [] }
}

/**
 * The §11 attempts of a set of queue rows, one read (the communications domain owns every §11 read). A
 * failed read ⇒ { ok: false } (every row is then ambiguous ⇒ manual review). Never throws.
 * @returns {Promise<{ ok: boolean, byRow: Map<string, object[]> }>}
 */
export function loadLeaseDispatchEvidence(supabase, queueRowIds = []) {
  return loadQueueRowAttemptEvidence(supabase, queueRowIds)
}

/** The patch for a verdict. Pure. A re-dispatch never touches retry_count. */
export function buildLeaseRecoveryPatch(row = {}, verdict = {}, { now = new Date().toISOString() } = {}) {
  const metadata = obj(row.metadata)
  const cleared = { processing_started_at: null, processing_worker_id: null, processing_timeout_at: null }
  if (verdict.action === 'redispatch') {
    const count = Number(metadata.lease_redispatch_count || 0) + 1
    return {
      queue_status: 'queued',
      failed_reason: null,
      is_locked: false,
      lock_token: null,
      locked_at: null,
      processing_run_id: null,
      metadata: {
        ...metadata,
        ...cleared,
        lease_redispatch_count: count,
        lease_redispatch: {
          version: LEASE_RECOVERY_VERSION,
          reason: LEASE_REDISPATCH_REASON,
          at: now,
          count,
          expired_lock_token: clean(row.lock_token) || null,
          expired_locked_at: row.locked_at || null,
          evidence: 'no_row_provider_evidence+no_s11_attempt_for_row',
        },
      },
      updated_at: now,
    }
  }
  return {
    queue_status: 'expired',
    failed_reason: LEASE_MANUAL_REVIEW_REASON,
    is_locked: false,
    lock_token: null,
    locked_at: null,
    processing_run_id: null,
    metadata: {
      ...metadata,
      ...cleared,
      lease_recovery: { version: LEASE_RECOVERY_VERSION, action: 'manual_review', at: now, blockers: verdict.blockers || [] },
    },
    updated_at: now,
  }
}

/**
 * Recover a set of expired-lease processing rows (the run-send-queue tick's recovery step). Each row is
 * patched with a compare-and-set on queue_status = 'processing' (+ its lock token when it has one), so a
 * row that moved on meanwhile is never touched. Never throws.
 * @returns {Promise<{ examined: number, redispatched: string[], manual_review: string[], skipped: string[], evidence_readable: boolean }>}
 */
export async function recoverExpiredProcessingLeases(supabase, rows = [], { now = new Date().toISOString(), log = null } = {}) {
  const out = { examined: 0, redispatched: [], manual_review: [], skipped: [], evidence_readable: true }
  const list = (rows || []).filter((r) => clean(r?.id))
  out.examined = list.length
  if (!list.length) return out
  const evidence = await loadLeaseDispatchEvidence(supabase, list.map((r) => r.id))
  out.evidence_readable = evidence.ok
  for (const row of list) {
    const verdict = evaluateExpiredProcessingLease(row, { attempts_readable: evidence.ok, attempts: evidence.byRow.get(clean(row.id)) || [] })
    const patch = buildLeaseRecoveryPatch(row, verdict, { now })
    try {
      let q = supabase.from('send_queue').update(patch).eq('id', row.id).eq('queue_status', 'processing')
      if (clean(row.lock_token)) q = q.eq('lock_token', clean(row.lock_token))
      const { data, error } = await q.select('id')
      if (error || !Array.isArray(data) || data.length !== 1) { out.skipped.push(row.id); continue }
      ;(verdict.action === 'redispatch' ? out.redispatched : out.manual_review).push(row.id)
      log?.(verdict.action === 'redispatch' ? 'queue.processing_lease_redispatched' : 'queue.processing_lease_manual_review', { queue_row_id: row.id, blockers: verdict.blockers })
    } catch {
      out.skipped.push(row.id)
    }
  }
  return out
}
