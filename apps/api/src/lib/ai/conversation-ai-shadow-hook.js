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
// the provider message id with digits letter-encoded, the inbound VERSION (a salted
// sha256 fingerprint, letters only) and the deterministic intent.
//
// IDEMPOTENCY PER INBOUND MESSAGE VERSION (8.5.15): the event key is
// `<provider message id>#<version>`, version = H(message id, body, revision).
// A repeat webhook / parallel duplicate of the same message (same id + same body)
// dedupes onto ONE job; an edited body or an explicit reprocess (revision ≥ 1) is a
// distinct job, and the handler refuses a job whose version no longer matches the
// stored inbound (INBOUND_VERSION_MISMATCH, no model call).
//
// Gates (all default OFF): AI_CONVERSATION_SHADOW_ENABLED=true here, AND the R2
// runtime gate (AGENT_ENABLED + AGENT_RUNTIME_ENABLED) — a job nothing would ever
// claim is never enqueued — AND the DB arming (kind_limits.armed_by).
import { createHash } from 'node:crypto'

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
const VERSION_RE = /^[a-p]{16}$/

/**
 * The inbound message VERSION: 16 letters (64 bits of sha256 over id, NFC-trimmed
 * body and revision, nibble-encoded a–p). Never reversible to the text in practice
 * and digit-free (agent.payload_is_clean). null when the body is unknown.
 */
export function inboundVersionOf(providerMessageSid, body, revision = 0) {
  if (body == null) return null
  const rev = Number.isInteger(revision) && revision >= 0 && revision <= 999 ? revision : 0
  const h = createHash('sha256').update(`conv-ai.inbound.v1\n${String(providerMessageSid)}\n${String(body).normalize('NFC').trim()}\n${rev}`).digest()
  return [...h.subarray(0, 8)].map((b) => NIB[b >> 4] + NIB[b & 15]).join('')
}

/** The runtime event key: one job per inbound message VERSION. */
export function conversationDecideEventKey(providerMessageSid, version = null) {
  const sid = String(providerMessageSid ?? '').trim()
  return version && VERSION_RE.test(version) ? `${sid}#${version}` : sid
}

/** The job input (clean: no digits, no text). Exported for tests. */
export function conversationDecideInput({ providerMessageSid, deterministic = null, version = null, revision = 0 }) {
  const intent = deterministic?.intent && SAFE_INTENT.test(deterministic.intent) ? deterministic.intent : null
  const flag = deterministic?.compliance_flag && SAFE_INTENT.test(deterministic.compliance_flag) ? deterministic.compliance_flag : null
  const rev = Number.isInteger(revision) && revision > 0 && revision <= 999 ? revision : 0
  return { inbound_ref: encodeRef(providerMessageSid), inbound_version: version && VERSION_RE.test(version) ? version : null, inbound_revision: rev ? encodeRef(String(rev)) : null, deterministic_intent: intent, compliance_flag: flag }
}

async function runtimeGateOpen(env) {
  const { runtimeGate } = await import('@/lib/agent/runtime/runtime-service.js')
  return runtimeGate(env)
}

/**
 * @param {{ providerMessageSid: string|null, messageBody?: string|null, revision?: number, deterministic?: object|null }} args
 * @param {{ env?: object, getStore?: () => Promise<object>, gate?: (env: object) => Promise<{enabled: boolean, reason: string|null}>, defer?: (fn: Function) => void, log?: (e: object) => void }} [opts]
 * @returns {{ scheduled: boolean, code: string }}
 */
export function scheduleConversationAiShadow(args = {}, { env = process.env, getStore = null, gate = null, defer = (fn) => setImmediate(fn), log = null } = {}) {
  if (!conversationAiShadowRequested(env)) return { scheduled: false, code: 'SHADOW_ENV_OFF' }
  const sid = String(args?.providerMessageSid ?? '').trim()
  if (!sid || sid.length > 160) return { scheduled: false, code: 'NO_MESSAGE_ID' }
  const version = inboundVersionOf(sid, args?.messageBody ?? null, args?.revision ?? 0)
  defer(async () => {
    try {
      const g = await (gate || runtimeGateOpen)(env)
      if (!g?.enabled) { log?.({ event: 'conversation_ai.enqueue_skipped', code: String(g?.reason || 'RUNTIME_OFF').toUpperCase() }); return }
      const store = getStore ? await getStore() : await (await import('@/lib/agent/runtime/runtime-service.js')).getVerifiedRuntimeStore(env)
      const r = await store.enqueueEvent({ kind: CONVERSATION_DECIDE_KIND, event_key: conversationDecideEventKey(sid, version), input: conversationDecideInput({ providerMessageSid: sid, deterministic: args.deterministic, version, revision: args?.revision ?? 0 }), priority: 120 })
      log?.({ event: 'conversation_ai.enqueue', code: r?.ok ? (r.deduped ? 'DEDUPED' : 'ENQUEUED') : String(r?.reason || 'REFUSED').toUpperCase() })
    } catch (err) {
      log?.({ event: 'conversation_ai.enqueue_failed', code: err?.code || 'ENQUEUE_FAILED' })
    }
  })
  return { scheduled: true, code: 'SHADOW_ENQUEUE_SCHEDULED' }
}
