// rc-8.5.21 v3 (RT-12 / crash recovery A): the inbound → durable-job handoff is two steps — the webhook
// commits the inbound message_events row, then scheduleConversationAiShadow() enqueues the
// conversation.decide job (deferred, never awaited). A crash (or a failed enqueue) between the two left
// the inbound persisted with NO job: the turn was lost, and the turn sweep could not see it (it only
// re-enqueues turns that exist).
//
// THE SWEEP. Every inbound persisted in the lookback window (older than a grace period, so the live hook
// had its chance) is re-offered to the runtime with EXACTLY the hook's event key
// (`<provider message id>#<inbound version>`). The runtime's unique (kind, idempotency_key) index makes
// that idempotent across every job state, completed included: an inbound whose job exists dedupes onto
// it, a stranded one gets EXACTLY ONE job. Nothing is decided, nothing is sent here.
// Gates: the same as the hook (AI_CONVERSATION_SHADOW_ENABLED + the runtime arming of the kind); it runs
// inside the born-disabled conversation-turn-sweep schedule and the ops supervisor's auto-recovery.
import { CONVERSATION_DECIDE_KIND, conversationAiShadowRequested, conversationDecideEventKey, conversationDecideInput, conversationDecidePriority, inboundVersionOf } from './conversation-ai-shadow-hook.js'

export const INBOUND_SWEEP_VERSION = 'conversation-inbound-sweep.v1'
const clean = (v) => String(v ?? '').trim()

/**
 * @param {{ supabase: object, runtimeStore: { enqueueEvent: Function }, env?: object, now?: string, lookbackMinutes?: number, graceSeconds?: number, limit?: number }} a
 * @returns {Promise<{ ok: boolean, examined: number, enqueued: number, already_present: number, failed: Array<{ message_event_id: string, reason: string }>, skipped?: string }>}
 */
export async function recoverStrandedInbounds({ supabase, runtimeStore, env = process.env, now = new Date().toISOString(), lookbackMinutes = 360, graceSeconds = 120, limit = 200 } = {}) {
  const out = { ok: true, version: INBOUND_SWEEP_VERSION, examined: 0, enqueued: 0, already_present: 0, failed: [] }
  if (!conversationAiShadowRequested(env)) return { ...out, skipped: 'SHADOW_ENV_OFF' }
  if (!supabase?.from || typeof runtimeStore?.enqueueEvent !== 'function') return { ...out, ok: false, failed: [{ message_event_id: null, reason: 'sweep_unwired' }] }
  const t = Date.parse(now) || Date.now()
  const from = new Date(t - lookbackMinutes * 60_000).toISOString()
  const to = new Date(t - graceSeconds * 1000).toISOString()
  const { data, error } = await supabase.from('message_events')
    .select('id,provider_message_sid,message_body,created_at')
    .eq('direction', 'inbound').gte('created_at', from).lte('created_at', to)
    .order('created_at', { ascending: true }).limit(limit)
  if (error) return { ...out, ok: false, failed: [{ message_event_id: null, reason: `inbound_read_failed:${clean(error.message).slice(0, 80)}` }] }
  for (const m of data || []) {
    const sid = clean(m.provider_message_sid)
    if (!sid) continue
    out.examined += 1
    const version = inboundVersionOf(sid, m.message_body ?? null, 0)
    try {
      const r = await runtimeStore.enqueueEvent({ kind: CONVERSATION_DECIDE_KIND, event_key: conversationDecideEventKey(sid, version), input: conversationDecideInput({ providerMessageSid: sid, version }), priority: conversationDecidePriority({ messageBody: m.message_body }) })
      if (!r?.ok) { out.failed.push({ message_event_id: String(m.id), reason: clean(r?.reason) || 'enqueue_refused' }); continue }
      if (r.deduped || r.idempotent) out.already_present += 1
      else out.enqueued += 1
    } catch (e) {
      out.failed.push({ message_event_id: String(m.id), reason: clean(e?.code || e?.message) || 'enqueue_failed' })
    }
  }
  if (out.failed.length) out.ok = false
  return out
}
