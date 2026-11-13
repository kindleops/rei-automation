// ADOPT AN ORPHAN PROVIDER CALLBACK onto the ONE crashed send it can only be (rc-8.5.21 v4, rt-cr-06).
//
// THE GAP. A worker that dies AFTER the provider accepted a message and BEFORE the seam recorded the
// response leaves: the send_queue row `processing` (or, after the lease reaper ran, `expired` in manual
// review) with NO provider id, and its §11 attempt STARTED but never completed — no provider id either.
// The carrier then delivers and posts the status callback with the SID. The live delivery lane matches
// callbacks by SID only (message_events / send_queue projection), finds nothing, and marks the callback
// `unmatched`; the §11 orphan adoption (reconcile-provider-callback.js) is not wired into the live lane
// (no callbackStore). The v3fix RT-15 path reconciles only when the ATTEMPT already carries the id, which
// this crash shape never has. So a message the seller received stayed "processing" forever and its
// provider_accepted event was never written.
//
// THE RULE (fail closed at every step, never a send, never a resend):
//   - only an AUTHENTICATED live provider receipt (signature verified) may adopt;
//   - the SID must be unknown everywhere (no queue row, no attempt carries it);
//   - candidates = queue rows to the callback's recipient FROM the callback's sender, created inside the
//     window, with NO provider evidence, in `processing` or in the lease manual-review hold;
//   - a candidate must have EXACTLY ONE §11 attempt that STARTED and never completed with an outcome
//     (the crash-after-start shape) and NO attempt carrying any provider id;
//   - EXACTLY ONE candidate across the window — zero or several ⇒ nothing is adopted (the callback stays
//     unmatched; a person reconciles), never a "best" guess.
// Then: the attempt records the SID (compare-and-set on provider_message_id IS NULL — the column is
// immutable once set), the row becomes `sent` with that provider id (compare-and-set on its held state),
// the outbound message event is written (so the projection now matches the SID), and an AI row's immutable
// record gets its provider_accepted event. The caller re-runs the delivery projection for the SID.
import { loadQueueRowAttemptEvidence } from '@/lib/domain/communications/queue-row-attempt-evidence.js'
import { rowProviderEvidence, LEASE_MANUAL_REVIEW_REASON, LEASE_RECOVERY_VERSION } from '@/lib/domain/queue/processing-lease-recovery.js'

export const ORPHAN_CALLBACK_ADOPTION_VERSION = 'adopt-orphan-provider-callback.v1'
export const ORPHAN_CALLBACK_RECONCILED_REASON = 'reconciled_sent_from_orphan_provider_callback'
export const ORPHAN_CALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000

const clean = (v) => String(v ?? '').trim()
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const rowsOf = (r) => (Array.isArray(r?.data) ? r.data : r?.data ? [r.data] : [])
export function e164(v) {
  const d = clean(v).replace(/\D/g, '')
  if (!d) return ''
  if (d.length === 10) return `+1${d}`
  if (d.length === 11 && d.startsWith('1')) return `+${d}`
  return `+${d}`
}

/** Is this attempt the crash-after-start shape (started, no outcome, no provider id)? Pure. */
export function isStartedUnresolvedAttempt(a = {}) {
  if (clean(a.provider_message_id)) return false
  if (!a.provider_request_started_at) return false
  if (!a.completed_at) return true
  return ['may_have_been_sent', 'unknown', ''].includes(clean(a.delivery_possibility)) && !clean(a.provider_status) && (a.http_status === null || a.http_status === undefined)
}

/** Is a queue row a candidate for the orphan SID (from its own fields + its attempts)? Pure. */
export function orphanCandidateVerdict(row = {}, attempts = []) {
  const status = clean(row.queue_status).toLowerCase()
  const held = status === 'processing' || (status === 'expired' && clean(row.failed_reason) === LEASE_MANUAL_REVIEW_REASON)
  if (!held) return { candidate: false, reason: 'row_not_in_crash_state' }
  if (rowProviderEvidence(row).length) return { candidate: false, reason: 'row_has_provider_evidence' }
  if ((attempts || []).some((a) => clean(a.provider_message_id))) return { candidate: false, reason: 'attempt_has_provider_id' }
  const open = (attempts || []).filter(isStartedUnresolvedAttempt)
  if (open.length !== 1) return { candidate: false, reason: open.length ? 'several_open_attempts' : 'no_started_unresolved_attempt' }
  return { candidate: true, attempt: open[0] }
}

/** Was the live receipt authenticated (signature verified)? Pure. */
export function receiptAuthenticated(verification = {}) {
  const v = obj(verification)
  // a cryptographically verified signature only: a bypass / observe-mode pass / unconfigured secret never adopts
  return v.ok === true && v.verified === true && v.signature_bypassed !== true && clean(v.signature_verification_mode).toLowerCase() !== 'off'
}

/**
 * @param {{ supabase: object, provider_message_sid: string, to: string, from: string, verification?: object, now?: string }} a
 * @param {{ writeOutboundSuccessMessageEvent?: Function, recordAiRowProviderOutcome?: Function }} [deps]
 * @returns {Promise<{ adopted: boolean, reason: string, queue_row_id?: string, attempt_id?: string, candidate_count?: number }>}
 */
export async function adoptOrphanProviderCallback({ supabase, provider_message_sid, to, from, verification = {}, now = new Date().toISOString() } = {}, deps = {}) {
  const sid = clean(provider_message_sid)
  const seller = e164(to)
  const ours = e164(from)
  if (!supabase?.from || !sid) return { adopted: false, reason: 'unwired' }
  if (!seller || !ours) return { adopted: false, reason: 'orphan_without_routing' }
  if (!receiptAuthenticated(verification)) return { adopted: false, reason: 'orphan_adoption_requires_authenticated_receipt' }
  try {
    // the SID must be unknown everywhere
    const known = await supabase.from('send_queue').select('id').or(`provider_message_id.eq.${sid},textgrid_message_id.eq.${sid}`).limit(1)
    if (known?.error) return { adopted: false, reason: 'queue_unreadable' }
    if (rowsOf(known).length) return { adopted: false, reason: 'sid_already_known' }
    const knownAttempt = await supabase.from('seller_communication_attempts').select('id').eq('provider_message_id', sid).limit(1)
    if (knownAttempt?.error) return { adopted: false, reason: 'attempt_ledger_unreadable' }
    if (rowsOf(knownAttempt).length) return { adopted: false, reason: 'sid_already_on_attempt' }

    const since = new Date((Date.parse(now) || Date.now()) - ORPHAN_CALLBACK_WINDOW_MS).toISOString()
    const r = await supabase.from('send_queue').select('*').eq('to_phone_number', seller).eq('from_phone_number', ours)
      .in('queue_status', ['processing', 'expired']).is('provider_message_id', null).gte('created_at', since).limit(20)
    if (r?.error) return { adopted: false, reason: 'queue_unreadable' }
    const rows = rowsOf(r)
    if (!rows.length) return { adopted: false, reason: 'orphan_zero_candidates', candidate_count: 0 }
    const evidence = await loadQueueRowAttemptEvidence(supabase, rows.map((x) => x.id))
    if (!evidence.ok) return { adopted: false, reason: 'attempt_ledger_unreadable' }
    const candidates = []
    for (const row of rows) {
      const v = orphanCandidateVerdict(row, evidence.byRow.get(clean(row.id)) || [])
      if (v.candidate) candidates.push({ row, attempt: v.attempt })
    }
    if (candidates.length !== 1) return { adopted: false, reason: candidates.length ? 'orphan_multiple_candidates' : 'orphan_zero_candidates', candidate_count: candidates.length }
    const { row, attempt } = candidates[0]

    // 1. the attempt records the SID (immutable once set; the CAS refuses a raced writer)
    const at = Date.parse(now) >= Date.parse(attempt.provider_request_started_at) ? now : attempt.provider_request_started_at
    const ua = await supabase.from('seller_communication_attempts')
      .update({ provider_message_id: sid, provider_response_received_at: at, completed_at: attempt.completed_at || at, outcome_class: 'provider_accepted', delivery_possibility: 'provider_accepted', retry_authority: 'retry_denied', transport_phase: 'response_inferred_from_provider_callback' })
      .eq('id', attempt.id).is('provider_message_id', null).select('id')
    if (ua?.error || rowsOf(ua).length !== 1) return { adopted: false, reason: 'attempt_adoption_refused' }
    if (clean(attempt.logical_communication_id)) {
      try {
        await supabase.from('seller_logical_communications')
          .update({ state: 'provider_accepted', delivery_possibility: 'provider_accepted', retry_authority: 'retry_denied', updated_at: now })
          .eq('id', attempt.logical_communication_id).in('state', ['provider_request_started', 'ambiguous_provider_outcome', 'reconciliation_pending'])
      } catch { /* the attempt is the evidence; the logical state is a projection of it */ }
    }

    // 2. the row is sent with that provider id (compare-and-set on the held state)
    const m = obj(row.metadata)
    const patch = {
      queue_status: 'sent', sent_at: at, delivery_confirmed: 'pending', provider_message_id: sid, failed_reason: null,
      is_locked: false, locked_at: null, lock_token: null, processing_run_id: null, updated_at: now,
      metadata: {
        ...m, processing_started_at: null, processing_worker_id: null, processing_timeout_at: null, provider_message_sid: sid,
        lease_recovery: { version: LEASE_RECOVERY_VERSION, action: 'reconciled_sent_from_orphan_callback', at: now, attempt_id: attempt.id, provider_message_id: sid, reason: ORPHAN_CALLBACK_RECONCILED_REASON, adoption_version: ORPHAN_CALLBACK_ADOPTION_VERSION, previous_status: clean(row.queue_status) },
      },
    }
    const ur = await supabase.from('send_queue').update(patch).eq('id', row.id).eq('queue_status', clean(row.queue_status)).is('provider_message_id', null).select('*')
    if (ur?.error || rowsOf(ur).length !== 1) return { adopted: false, reason: 'row_reconcile_refused', attempt_id: attempt.id }
    const finalized = rowsOf(ur)[0]
    const sendResult = { ok: true, success: true, sid, provider_message_id: sid, message_id: sid, status: 'sent', inferred_from_callback: true }

    // 3. bookkeeping: the outbound message event (the projection now matches the SID) + the AI record
    const out = { adopted: true, reason: ORPHAN_CALLBACK_RECONCILED_REASON, queue_row_id: String(row.id), attempt_id: String(attempt.id), candidate_count: 1, message_event: false, ai_event: null }
    try {
      const write = deps.writeOutboundSuccessMessageEvent || (await import('@/lib/supabase/sms-engine.js')).writeOutboundSuccessMessageEvent
      await write(finalized, sendResult, { supabase, now })
      out.message_event = true
    } catch { /* the row + attempt carry the truth */ }
    if (clean(m.ai_message_id)) {
      try {
        const rec = deps.recordAiRowProviderOutcome || (await import('@/lib/domain/messages/ai-generated-message.js')).recordAiRowProviderOutcome
        out.ai_event = await rec(supabase, finalized, { eventType: 'provider_accepted', providerResult: sendResult, detail: { queue_status: 'sent', reason: ORPHAN_CALLBACK_RECONCILED_REASON } })
      } catch { out.ai_event = { ok: false } }
    }
    return out
  } catch (e) {
    return { adopted: false, reason: `adoption_threw:${clean(e?.message).slice(0, 60)}` }
  }
}

export default adoptOrphanProviderCallback
