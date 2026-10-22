// queue_authorized_reply (T3, seller-facing). AVAILABLE ONLY when the production AI send capability is activated
// (system_control ai_conversation_send_enabled = 'true' + an enabled ai_conversation_send_policy, no queue emergency
// stop); otherwise every call answers unavailable / capability_unavailable, whatever the agent's grants.
//
// The agent references a THREAD; it never supplies a phone number, a sender, a persona or text. LeadCommand resolves
// the routing. The gateway authorizes (policy + a per-use HUMAN approval: T3 never runs on a standing grant alone),
// then its handoff domain write enqueues ONE action_gateway.execute job; LeadCommand's worker runs the CANONICAL path:
// decideAndCompose (conversation-turn-wiring#createCanonicalTurnDecider) → the shared outbound validator → R3 (send
// policy, scope, holds, eligibility, timing, language, reservations, the immutable ai_generated_messages record) →
// insertSupabaseSendQueueRow → the queue runner (every dispatch guard; one dispatch; an ambiguous accept is never
// retried). Every guard below is re-run there.
//
// Guards here (before the approval is even filed, and again when the approval is consumed):
//   the thread is in the send policy's scope; the hold registry (ai_reply_dispatch); STOP / suppression / opt-out;
//   the conversational-reply category only (the latest message is the seller's, unanswered); the established
//   persona + sender of the thread (never a number change); the send-time eligibility dry run (suppression in any
//   language, wrong number, not-owner, property × contact holds); the recipient-window policy (a reply outside it
//   is refused with the next permitted time); the language policy (the seller's language must be an enabled one,
//   never an English fallback).
import { UUID, obj, str } from '../../../../agent/capabilities/defs/_schema.js'
import { languageEnabledFor, threadInPolicyScope } from '../../../conversation-ai/send-policy.js'
import { gwErr } from '../../errors.js'
import { TIERS, DOMAIN_WRITES } from '../../constants.js'
import { mustThread, threadResource, holdDeny, permissionDeny, replyActivation, iso } from './shared.js'

const CLIENT_KEY = str(80, { minLength: 8, pattern: '^[A-Za-z0-9_.:-]{8,80}$' })

export const QUEUE_REPLY_SPEC = Object.freeze({
  name: 'queue_authorized_reply',
  title: 'Queue an authorized seller reply',
  description: 'Ask LeadCommand to answer the latest seller message of a thread through the CANONICAL send path (decideAndCompose → validator → R3 / send policy → canonical queue writer → dispatcher). Only when the production AI send capability is activated (else capability_unavailable). A human approves each use. You reference the thread only: LeadCommand resolves the persona, the sender number and the text; suppression, holds, ownership, the recipient window and the language policy all apply.',
  capability: 'conversation.queue_reply', tier: TIERS.T3, resource: 'thread',
  input: obj({ client_request_id: CLIENT_KEY, thread_id: UUID }, ['client_request_id', 'thread_id']),
  executor: { kind: 'domain_write', fn: DOMAIN_WRITES.handoff },
  recovery: 'reexecute',
  limits: { per_min: 6 },
  wraps: { service: 'handoff → LeadCommand worker action_gateway.execute: conversation-turn-wiring#createCanonicalTurnDecider + conversation-turn-dispatch#createR3TurnDispatcher', module: 'apps/api/src/lib/ai/action-gateway-execution.js' },
  touches: ['agent_runtime_job'],
})

export const QUEUE_REPLY_LOGIC = Object.freeze({
  async available({ reads }) { return replyActivation(reads) },
  async resolve(input, { reads }) { return threadResource(await mustThread(reads, input.thread_id)) },
  async params(input, resource, { reads }) {
    const latest = await reads.latestInbound(resource.refs.thread_key)
    if (!latest?.id) throw gwErr('refused', 'NO_INBOUND', 'the thread has no seller message to answer')
    return { thread_id: resource.id, inbound_message_id: String(latest.id), runtime_kind: 'action_gateway.execute' }
  },
  async policy({ resource, params, reads, services, now }) {
    const act = await replyActivation(reads).catch(() => ({ available: false, code: 'CAPABILITY_STATE_UNREADABLE' }))
    if (!act.available) return { decision: 'deny', code: 'CAPABILITY_UNAVAILABLE', evidence: { reason: act.code } }
    if (!threadInPolicyScope(act.policy, { thread_key: resource.refs.thread_key })) return { decision: 'deny', code: 'THREAD_NOT_IN_AI_SEND_SCOPE', evidence: {} }
    const h = await holdDeny(services, { threadKey: resource.refs.thread_key, threadId: resource.id, propertyId: resource.refs.property_id }, ['ai_reply_dispatch'])
    if (h) return h
    const p = await permissionDeny(reads, resource)
    if (p) return p
    // the conversational-reply category only: the latest message is the seller's, still unanswered
    const last = await reads.latestMessage(resource.refs.thread_key)
    if (!last || String(last.id) !== String(params.inbound_message_id) || String(last.direction).toLowerCase() !== 'inbound') return { decision: 'deny', code: 'NOT_AN_UNANSWERED_SELLER_MESSAGE', evidence: {} }
    const inbound = await reads.message(params.inbound_message_id)
    let ci = null
    try { ci = inbound?.provider_message_sid ? await services.canonicalInputs({ providerMessageSid: inbound.provider_message_sid, now: iso(now()) }) : null } catch { ci = null }
    if (!ci) return { decision: 'deny', code: 'CANONICAL_INPUTS_UNREADABLE', evidence: {} }
    // persona + sender continuity: the thread's established sender, never a number change
    if (!ci.continuity?.ok || !ci.continuity?.sender_number) return { decision: 'deny', code: 'SENDER_CONTINUITY_UNRESOLVED', evidence: { reasons: (ci.continuity?.reasons || []).slice(0, 6) } }
    let el
    try { el = await ci.eligibilityFor({ now: iso(now()) }) } catch { el = { blocked: true, reasons: ['send_time_guard_read_failed'] } }
    if (el?.blocked) return { decision: 'deny', code: 'CONTACT_NOT_ELIGIBLE', evidence: { reasons: (el.reasons || []).map(String).slice(0, 8) } }
    if (el?.timing && el.timing.lawful !== true) return { decision: 'deny', code: 'OUTSIDE_RECIPIENT_WINDOW', evidence: { next_permitted_at: iso(el.timing.next_permitted_at) } }
    const lang = languageEnabledFor({ language: ci.input?.language, inboundText: inbound.message_body || '', languages: act.policy.languages })
    if (!lang.enabled) return { decision: 'deny', code: 'LANGUAGE_NOT_ENABLED', evidence: { reason: lang.reason || null } }
    return { decision: 'allow', evidence: { scope: 'thread', persona: 'established', sender: 'established', window: el?.timing ? 'lawful' : 'unknown', language: lang.language || null } }
  },
  summary: () => ['Answer the latest seller message through the canonical send path (R3): LeadCommand writes and validates the text, keeps the thread\'s persona and sender, and re-checks every dispatch guard.', 'Seller-facing (T3): a human approves this one use.'],
})
