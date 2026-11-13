// rc-8.5.21 v3: the ops supervisor's AUTO-RECOVERY source. BORN OFF: wired only when
// OPS_SUPERVISOR_AUTO_RECOVERY=true (env) — and each sweep keeps its own gates (the conversation inbound
// sweep runs only with the AI shadow flag; the follow-up trigger only in its follow-up mode).
//   1. stranded inbounds   (recoverStrandedInbounds): persisted inbound, no decide job ⇒ exactly one job
//   2. missed follow-ups   (recoverMissedDeliveryFollowUps): delivered anchor, next action never planned ⇒
//                          exactly one plan (the trigger's own guards + its per-anchor idempotency)
//   3. crash manual review (send_queue processing rows the lease reaper could NOT prove sent or unsent)
//                          ⇒ surfaced, never acted on
// Everything a sweep could not do is returned as `unrecoverable` (the supervisor escalates it).
import { recoverStrandedInbounds } from '../../ai/conversation-inbound-sweep.js'
import { recoverMissedDeliveryFollowUps } from '../../domain/seller-flow/recover-missed-delivery-followups.js'

export const AUTO_RECOVERY_ENV = 'OPS_SUPERVISOR_AUTO_RECOVERY'
export const autoRecoveryEnabled = (env = process.env) => String(env?.[AUTO_RECOVERY_ENV] ?? '').trim() === 'true'
const LEASE_MANUAL_REVIEW = 'processing_lease_expired_manual_review'

/**
 * @param {{ supabase: object, runtimeStore?: object|null, env?: object, lookbackDays?: number }} deps
 */
export function createAutoRecoverySource({ supabase, runtimeStore = null, env = process.env, lookbackDays = 7 } = {}) {
  return Object.freeze({
    async run({ now = new Date().toISOString() } = {}) {
      const inbound = runtimeStore ? await recoverStrandedInbounds({ supabase, runtimeStore, env, now }) : { ok: false, examined: 0, enqueued: 0, failed: [{ message_event_id: null, reason: 'runtime_store_unavailable' }] }
      const followups = await recoverMissedDeliveryFollowUps({ supabase, now })
      const unrecoverable = [
        ...(inbound.failed || []).map((f) => ({ kind: 'stranded_inbound', ref: f.message_event_id, reason: f.reason })),
        ...(followups.failed || []).map((f) => ({ kind: 'missed_followup', ref: f.queue_row_id, reason: f.reason })),
      ]
      let lease_manual_review = 0
      const since = new Date((Date.parse(now) || Date.now()) - lookbackDays * 86_400_000).toISOString()
      const r = await supabase.from('send_queue').select('id,metadata').eq('queue_status', 'expired').eq('failed_reason', LEASE_MANUAL_REVIEW).gte('updated_at', since).limit(50)
      if (r?.error) unrecoverable.push({ kind: 'lease_manual_review', ref: null, reason: 'lease_review_read_failed' })
      else {
        lease_manual_review = (r.data || []).length
        for (const row of r.data || []) unrecoverable.push({ kind: 'lease_manual_review', ref: String(row.id), reason: (row.metadata?.lease_recovery?.blockers || []).join(',').slice(0, 120) || LEASE_MANUAL_REVIEW })
      }
      return { inbound: { examined: inbound.examined, enqueued: inbound.enqueued, already_present: inbound.already_present || 0, skipped: inbound.skipped || null }, followups: { examined: followups.examined, scheduled: followups.scheduled, not_needed: followups.not_needed }, lease_manual_review, unrecoverable }
    },
  })
}
