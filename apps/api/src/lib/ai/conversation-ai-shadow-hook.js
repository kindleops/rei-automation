// Conversation Engine 2.0 — the ONE hook into the live inbound path (SHADOW ONLY, NO SEND).
//
// handle-textgrid-inbound calls scheduleConversationAiShadow() right after the
// inbound message_events row is written (i.e. after the existing deterministic
// engine has classified, planned and queued — or not). With
// AI_CONVERSATION_SHADOW_ENABLED unset (the default, and the production state) it
// returns at once: nothing is imported, nothing is read, nothing is enqueued.
//
// With the flag on, it ENQUEUES one R2 runtime job (never awaited by the webhook,
// never throws into it):
//     agent.runtime_enqueue_event('conversation.decide', <inbound message id>, input)
// The DB hashes the event key into the job's idempotency key, so a repeat webhook /
// parallel duplicate inbound for the same message id dedupes onto ONE job. The job
// is claimed by the runtime tick (bounded concurrency: tick_max_jobs + the kind's
// max_concurrency) and runs conversation-decide-handler.js in the background —
// browser closed or not. The DB refuses the enqueue unless an operator ARMED the
// kind, and the tick never claims it unless the kind is enabled.
//
// Job input carries no phone, name or message text (agent.payload_is_clean): only
// the provider message id with digits letter-encoded, and the deterministic intent.
export const CONVERSATION_AI_SHADOW_ENV = 'AI_CONVERSATION_SHADOW_ENABLED'
export const CONVERSATION_DECIDE_KIND = 'conversation.decide'

// Reversible, digit-free: each UTF-8 byte → two letters (nibble a–p).
const NIB = 'abcdefghijklmnop'
export const encodeRef = (s) => [...Buffer.from(String(s), 'utf8')].map((b) => NIB[b >> 4] + NIB[b & 15]).join('')
export const decodeRef = (s) => {
  const t = String(s)
  if (!/^(?:[a-p]{2})+$/.test(t)) return null
  return Buffer.from(t.match(/../g).map((p) => (NIB.indexOf(p[0]) << 4) | NIB.indexOf(p[1]))).toString('utf8')
}

export function conversationAiShadowRequested(env = process.env) {
  return String(env?.[CONVERSATION_AI_SHADOW_ENV] ?? '').trim() === 'true'
}

const SAFE_INTENT = /^[a-z_]{1,60}$/

/** The job input (clean: no digits, no text). Exported for tests. */
export function conversationDecideInput({ providerMessageSid, deterministic = null }) {
  const intent = deterministic?.intent && SAFE_INTENT.test(deterministic.intent) ? deterministic.intent : null
  const flag = deterministic?.compliance_flag && SAFE_INTENT.test(deterministic.compliance_flag) ? deterministic.compliance_flag : null
  return { inbound_ref: encodeRef(providerMessageSid), deterministic_intent: intent, compliance_flag: flag }
}

/**
 * @param {{ providerMessageSid: string|null, deterministic?: object|null }} args
 * @param {{ env?: object, getStore?: () => Promise<object>, defer?: (fn: Function) => void, log?: (e: object) => void }} [opts]
 * @returns {{ scheduled: boolean, code: string }}
 */
export function scheduleConversationAiShadow(args = {}, { env = process.env, getStore = null, defer = (fn) => setImmediate(fn), log = null } = {}) {
  if (!conversationAiShadowRequested(env)) return { scheduled: false, code: 'SHADOW_ENV_OFF' }
  const sid = String(args?.providerMessageSid ?? '').trim()
  if (!sid || sid.length > 160) return { scheduled: false, code: 'NO_MESSAGE_ID' }
  defer(async () => {
    try {
      const store = getStore ? await getStore() : (await import('@/lib/agent/runtime/runtime-service.js')).getRuntimeStore(env)
      const r = await store.enqueueEvent({ kind: CONVERSATION_DECIDE_KIND, event_key: sid, input: conversationDecideInput({ providerMessageSid: sid, deterministic: args.deterministic }), priority: 120 })
      log?.({ event: 'conversation_ai.enqueue', code: r?.ok ? (r.deduped ? 'DEDUPED' : 'ENQUEUED') : String(r?.reason || 'REFUSED').toUpperCase() })
    } catch (err) {
      log?.({ event: 'conversation_ai.enqueue_failed', code: err?.code || 'ENQUEUE_FAILED' })
    }
  })
  return { scheduled: true, code: 'SHADOW_ENQUEUE_SCHEDULED' }
}
