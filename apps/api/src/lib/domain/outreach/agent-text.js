// AGENT-COMPOSED TEXTS (Action Gateway queue_agent_text, link #32 — owner architecture correction 2026-10-29: "Agntei
// owns the intelligence and conversation. LeadCommand owns messaging infrastructure and compliance enforcement. The
// carrier delivers the SMS."). An Agntei AI employee (Sterling, Nova …) writes EVERY word on its own model session;
// LeadCommand never composes for it. This module holds the deterministic, model-free rules both the gateway's policy
// (lc_action_gateway's client, at request time) and LeadCommand's worker (its backend client, again at execution) apply
// to a text that is about to be queued. Every fact is re-read by the caller; a read that fails is a refusal. Nothing
// here writes or sends.
//
//   purpose rules   an ANSWER (reply / qualification / negotiation / appointment) names the inbound it answers
//                   (in_reply_to_message_id), which must be the thread's LATEST message and inbound; an INITIATED text
//                   (first_touch / followup / reengage / nurture) answers nothing and is refused over an unanswered
//                   seller message; a first touch needs a campaign target (ready, verified, clear) and no prior
//                   outbound; a follow-up / nurture needs the thread quiet since OUR last text for the policy's
//                   follow-up quiet hours, a re-engagement for its re-engage quiet hours.
//   AI send scope   ai_conversation_send_policy.scope, WHEN SET (any thread_keys / market_ids / campaign_ids listed): the
//                   lead must be inside it. An absent / empty scope does not restrict agent texts (the reply engine's
//                   switch and categories certify LeadCommand's writer, which writes nothing here).
//   send-time guard queue/send-time-contact-guard.js on the row this text would be (suppression / DNC, automation
//                   suppressions, a stop-like latest inbound in any language, thread suppressed / opted out, wrong number,
//                   not owner, the hold registry, the recontact guard, the opener rule for a first touch).
//   pre-send        outbound/presend-eligibility-engine.js (renter-not-owner, identity).
//   window          queue/reply-timing.js: an answer is a conversational reply (the in-session rule, else 08:00–21:00 in
//                   every plausible recipient zone); a first touch a campaign touch; anything else a follow-up. Outside
//                   it the text is REFUSED with the next permitted time — never scheduled silently.
import { loadSendTimeContactFacts, evaluateSendTimeContactGuard } from '@/lib/domain/queue/send-time-contact-guard.js'
import { evaluatePreSendEligibility } from '@/lib/domain/outbound/presend-eligibility-engine.js'
import { evaluateReplyTiming, resolveRecipientZones } from '@/lib/domain/queue/reply-timing.js'

export const AGENT_TEXT_VERSION = 'agent-text.v1'
export const AGENT_TEXT_SWITCH_KEY = 'ai_agent_text_enabled'
export const AGENT_TEXT_POLICY_KEY = 'ai_agent_text_policy'
/** The switch as the database reads it (action_gateway.agent_text_refusal): only the literal 'true' (trimmed, any case) is on. */
export const agentTextSwitchOn = (raw) => String(raw ?? '').trim().toLowerCase() === 'true'
export const AGENT_TEXT_PURPOSES = Object.freeze(['first_touch', 'reply', 'followup', 'reengage', 'nurture', 'qualification', 'negotiation', 'appointment'])
/** The purposes that ANSWER one inbound (in_reply_to_message_id required). */
export const AGENT_TEXT_ANSWER_PURPOSES = Object.freeze(['reply', 'qualification', 'negotiation', 'appointment'])
/** The purposes an agent INITIATES (no inbound): they take the per-lead initiated slot (action_gateway.agent_text_initiated). */
export const AGENT_TEXT_INITIATED_PURPOSES = Object.freeze(['first_touch', 'followup', 'reengage', 'nurture'])
/** The registry capabilities an agent text exercises (mirrors action_gateway.t34_hold_capabilities('queue_agent_text')). */
export const AGENT_TEXT_HOLD_CAPABILITIES = Object.freeze(['ai_action', 'auto_reply', 'campaign', 'follow_up', 'outbound_send'])
export const agentTextQueueKey = (intentId) => `agent_text:${String(intentId ?? '').trim()}`

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const deny = (code, evidence = {}) => ({ ok: false, code, evidence })

/** The normalized agent-text policy as the database computes it (action_gateway.agent_text_policy), for pure callers. */
export const DEFAULT_AGENT_TEXT_POLICY = Object.freeze({ max_per_day_global: 200, max_per_lead_per_day: 6, max_initiated_per_lead_per_day: 1, followup_min_quiet_hours: 24, reengage_min_quiet_hours: 72, allow_links: false, languages: ['en'], policy_version: 'v1' })

/**
 * The purpose rules on the thread's history (chronological, canonical shape {id, direction, body, at}).
 * @returns {{ ok: true, answers: object|null } | { ok: false, code: string, evidence: object }}
 */
export function agentTextPurposeVerdict({ purpose, inReplyTo = null, messages = [], target = null, policy = DEFAULT_AGENT_TEXT_POLICY, now }) {
  if (!AGENT_TEXT_PURPOSES.includes(purpose)) return deny('PURPOSE_INVALID', { purposes: AGENT_TEXT_PURPOSES })
  const latest = messages[messages.length - 1] || null
  const answer = AGENT_TEXT_ANSWER_PURPOSES.includes(purpose)
  if (answer) {
    if (!clean(inReplyTo)) return deny('IN_REPLY_TO_REQUIRED', { purpose, rule: 'an answer names the inbound it answers (the latest unanswered seller message)' })
    if (!latest || clean(latest.id) !== clean(inReplyTo) || latest.direction !== 'inbound') {
      return deny('IN_REPLY_TO_NOT_LATEST_INBOUND', { latest_direction: latest?.direction || null, rule: 'only the thread\'s latest message, an unanswered inbound, can be answered' })
    }
    return { ok: true, answers: latest }
  }
  if (clean(inReplyTo)) return deny('IN_REPLY_TO_NOT_ALLOWED', { purpose, rule: 'an initiated text answers no inbound; use purpose reply' })
  if (latest?.direction === 'inbound') return deny('UNANSWERED_SELLER_MESSAGE', { use: 'purpose reply with in_reply_to_message_id', in_reply_to_message_id: clean(latest.id) || null })
  if (purpose === 'first_touch') {
    if (!target) return deny('FIRST_TOUCH_REQUIRES_CAMPAIGN_TARGET')
    if (lower(target.target_status) !== 'ready' || lower(target.routing_status) !== 'ready' || lower(target.identity_status) !== 'verified' || lower(target.suppression_status) !== 'clear') {
      return deny('CAMPAIGN_TARGET_NOT_READY', { target_status: target.target_status || null, routing_status: target.routing_status || null, identity_status: target.identity_status || null, suppression_status: target.suppression_status || null })
    }
    if (messages.some((m) => m.direction === 'outbound')) return deny('ALREADY_CONTACTED', { rule: 'first_touch_opener', source: 'thread_history' })
    return { ok: true, answers: null }
  }
  if (!messages.length) return deny('NO_CONVERSATION_TO_CONTINUE', { hint: 'a lead with no conversation gets a first_touch' })
  const lastOut = [...messages].reverse().find((m) => m.direction === 'outbound') || null
  const quietMs = Date.parse(now) - (Date.parse(lastOut?.at || latest?.at || 0) || 0)
  const minH = purpose === 'reengage' ? Number(policy?.reengage_min_quiet_hours) || 72 : Number(policy?.followup_min_quiet_hours) || 24
  if (quietMs < minH * 3600_000) return deny(purpose === 'reengage' ? 'THREAD_NOT_QUIET' : 'FOLLOWUP_QUIET_HOURS', { min_quiet_hours: minH, quiet_hours: Math.floor(Math.max(quietMs, 0) / 3600_000) })
  return { ok: true, answers: null }
}

const arr = (v) => (Array.isArray(v) ? v.map((x) => clean(x)).filter(Boolean) : [])
/** The AI send policy's scope WHEN SET: null = no scope configured (no restriction); else whether the lead is inside it. */
export function agentTextScopeVerdict(aiPolicy, { thread_key = null, market = null, campaign_id = null } = {}) {
  const s = aiPolicy?.scope || {}
  const set = arr(s.thread_keys).length + arr(s.market_ids).length + arr(s.campaign_ids).length > 0
  if (!set) return null
  const inside = (thread_key && arr(s.thread_keys).includes(clean(thread_key))) || (market && arr(s.market_ids).includes(clean(market))) || (campaign_id && arr(s.campaign_ids).includes(clean(campaign_id)))
  return inside ? null : deny('LEAD_NOT_IN_AI_SEND_SCOPE', { scope: 'ai_conversation_send_policy.scope' })
}

/** The send_queue-shaped row the send-time guard judges (the text as it would be queued). */
export function agentTextGuardRow({ lead, target = null, purpose }) {
  const first = purpose === 'first_touch'
  const answer = AGENT_TEXT_ANSWER_PURPOSES.includes(purpose)
  return {
    id: null, to_phone_number: lead.phone, thread_key: lead.phone, property_id: lead.property_id || target?.property_id || null,
    prospect_id: lead.prospect_id || target?.prospect_id || null, master_owner_id: lead.master_owner_id || target?.master_owner_id || null, phone_id: target?.phone_id || null,
    message_type: first ? 'campaign_opener' : answer ? 'reply' : 'followup', type: first ? 'outbound' : answer ? 'reply' : 'followup', is_first_touch: first, touch_number: first ? 1 : null,
    created_at: new Date().toISOString(), metadata: { send_kind: `agent_text_${purpose}`, is_first_touch: first },
  }
}

/** The recipient-local window for this text NOW (answer: the conversational reply rule; first touch: campaign; else follow-up). */
export function agentTextWindow({ phone, property = null, purpose, now, answers = null }) {
  const zr = resolveRecipientZones({ recipientPhone: phone, propertyGeography: property ? { state: property.property_address_state || null, zip: property.property_address_zip || null } : null })
  const answer = AGENT_TEXT_ANSWER_PURPOSES.includes(purpose)
  const timing = evaluateReplyTiming({ purpose: answer ? 'reply' : purpose === 'first_touch' ? 'campaign' : 'followup', at: now, zones: zr.zones, jurisdictions: zr.jurisdictions,
    ...(answer && answers ? { inboundId: clean(answers.id), inboundAt: answers.at || null, queuedAt: now } : {}) })
  return { timing, zones: zr }
}

/**
 * The contact guards after the holds and the thread's permission (callers run those first, in the pool read's order):
 * the AI send scope when set, the send-time contact guard, the pre-send eligibility engine, the window.
 */
export async function evaluateAgentTextContactGuards({ supabase, lead, target = null, purpose, aiPolicy = null, prospect = null, property = null, now, holdChecker = null, answers = null, window = true }) {
  if (!lead?.phone) return deny('LEAD_NOT_FOUND')
  const sc = agentTextScopeVerdict(aiPolicy, { thread_key: lead.phone, market: target?.market || null, campaign_id: lead.campaign_id || target?.campaign_id || null })
  if (sc) return sc
  const row = agentTextGuardRow({ lead, target, purpose })
  let g
  try {
    const facts = await loadSendTimeContactFacts(supabase, row, { automationHoldChecker: holdChecker })
    g = evaluateSendTimeContactGuard(row, facts, { now: Date.parse(now) })
  } catch (e) {
    g = { blocked: true, reason: 'send_time_guard_read_failed', detail: { error: clean(e?.message).slice(0, 80) } }
  }
  if (g.blocked) {
    const r = clean(g.reason)
    return deny(/^already_contacted/.test(r) ? 'ALREADY_CONTACTED' : r === 'automation_hold_active' ? 'AUTOMATION_HOLD' : 'CONTACT_NOT_ELIGIBLE', { reason: r, rule: /^already_contacted/.test(r) ? 'first_touch_opener' : null })
  }
  const contact = { ...(prospect || {}), ...(target?.identity_status && lower(target.identity_status) === 'verified' ? { identity_alignment: { status: 'verified' } } : {}) }
  const pe = evaluatePreSendEligibility(contact, purpose === 'first_touch' ? {} : { allow_identity_unknown: true })
  if (!pe.eligible) return deny('PRESEND_INELIGIBLE', { reason: pe.reason, block_reason: pe.block_reason })
  if (!window) return { ok: true, code: null, evidence: { purpose, guard: 'clear', presend: pe.reason } }
  const { timing, zones } = agentTextWindow({ phone: lead.phone, property, purpose, now, answers })
  if (timing.lawful !== true) return deny('OUTSIDE_RECIPIENT_WINDOW', { next_permitted_at: timing.next_permitted_at || null, zones: timing.zones })
  return { ok: true, code: null, evidence: { purpose, guard: 'clear', presend: pe.reason, window: timing.basis || 'lawful', zones: timing.zones }, timing, zones }
}

/** The day caps as the gateway reads them (the worker's reservation is the binding check). */
export function agentTextCapVerdict({ usage = {}, policy = DEFAULT_AGENT_TEXT_POLICY, purpose }) {
  if (Number(usage.lead_today) >= (Number(policy.max_per_lead_per_day) || 0)) return deny('DAILY_LEAD_CAP_REACHED', { cap: Number(policy.max_per_lead_per_day) || 0 })
  if (AGENT_TEXT_INITIATED_PURPOSES.includes(purpose) && Number(usage.initiated_today) >= (Number(policy.max_initiated_per_lead_per_day) || 0)) return deny('DAILY_INITIATED_CAP_REACHED', { cap: Number(policy.max_initiated_per_lead_per_day) || 0 })
  if (Number(usage.global_today) >= (Number(policy.max_per_day_global) || 0)) return deny('DAILY_GLOBAL_CAP_REACHED', { cap: Number(policy.max_per_day_global) || 0 })
  return null
}

/** The attribution as it is stored (the database normalizes the same way): the six keys, strings, trimmed, ≤ 200 chars. */
export function normalizeAttribution(a = {}) {
  const out = {}
  for (const k of ['employee', 'model', 'provider', 'route', 'session_id', 'turn_id']) if (typeof a?.[k] === 'string' && clean(a[k])) out[k] = clean(a[k]).slice(0, 200)
  return out
}
