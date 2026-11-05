// TEMPLATE ↔ AI COEXISTENCE (8.5.16, R3). Called by the template auto-reply path for a
// LIVE sms reply only. One automated reply per inbound:
//
//   R3 executor not wired (this release)  → template runs exactly as today, NO reads
//   AI send switch off / policy disabled  → template runs exactly as today
//   AI on AND this thread in the AI scope → the template DEFERS for this inbound
//   AI on, thread NOT in scope            → the template claims the shared per-inbound
//                                           reservation (idempotency_ledger scope
//                                           'inbound_reply'); if the AI already holds it,
//                                           the template defers
//
// Any read failure ⇒ the template runs as today (the AI side fails closed on its own).
import { beginIdempotentProcessing, completeIdempotentProcessing } from '@/lib/domain/events/idempotency-ledger.js'
import {
  AI_SEND_KILL_SWITCH_KEY, AI_SEND_POLICY_KEY, INBOUND_REPLY_RESERVATION_SCOPE, R3_EXECUTOR_WIRED,
  isOwnerHandledThread, normalizeSendPolicy, parseKillSwitch, templateDeferVerdict, threadInPolicyScope,
} from '@/lib/domain/conversation-ai/send-policy.js'

const clean = (v) => String(v ?? '').trim()

export async function evaluateTemplateCoexistence({
  inbound_message_event_id = null, thread_key = null, market_id = null, campaign_id = null,
  getSystemValue = null, executorWired = R3_EXECUTOR_WIRED,
  reservations = { begin: beginIdempotentProcessing, complete: completeIdempotentProcessing },
} = {}) {
  if (!executorWired) return { defer: false, reason: 'r3_executor_not_wired' }
  const inboundId = clean(inbound_message_event_id)
  if (!inboundId || typeof getSystemValue !== 'function') return { defer: false, reason: 'coexistence_not_evaluable' }
  // owner-handled threads: R3 never touches them, so the template path stays exactly as today
  if (isOwnerHandledThread({ thread_key })) return { defer: false, reason: 'owner_handled_thread' }
  let killSwitchOn = false
  let policy = null
  try {
    killSwitchOn = parseKillSwitch(await getSystemValue(AI_SEND_KILL_SWITCH_KEY))
    policy = normalizeSendPolicy(await getSystemValue(AI_SEND_POLICY_KEY))
  } catch {
    return { defer: false, reason: 'coexistence_read_failed' }
  }
  const inScope = threadInPolicyScope(policy, { thread_key, market_id, campaign_id })
  const verdict = templateDeferVerdict({ executorWired, killSwitchOn, policy, inScope })
  if (verdict.defer || !verdict.claim_reservation) return verdict
  try {
    const r = await reservations.begin({ scope: INBOUND_REPLY_RESERVATION_SCOPE, key: inboundId, summary: 'template_auto_reply', metadata: { engine: 'template' }, lease_ms: 24 * 60 * 60 * 1000 })
    if (r?.duplicate) return { defer: true, reason: 'inbound_reply_reserved_by_other_engine' }
    if (r?.record_item_id) await reservations.complete({ record_item_id: r.record_item_id, scope: INBOUND_REPLY_RESERVATION_SCOPE, key: inboundId, metadata: { engine: 'template', outcome: 'template_proceeds' } })
    return { defer: false, reason: 'template_reserved_inbound' }
  } catch {
    return { defer: false, reason: 'coexistence_reservation_failed' }
  }
}

export default evaluateTemplateCoexistence
