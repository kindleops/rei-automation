// AGENT-INITIATED MESSAGES (Action Gateway queue_agent_message, link #32): the guards shared by the gateway's policy
// (lc_action_gateway's client, before authorization) and LeadCommand's worker (its backend client, again at execution).
// Every fact is re-read by the caller; a read that fails is a refusal (fail closed). Nothing here writes or sends.
//
//   purpose rules   first_touch needs a campaign target (routing ready, identity verified, suppression clear) and no
//                   prior outbound; reengage / followup need a conversation whose latest message is NOT an unanswered
//                   seller message (that is a reply: queue_authorized_reply) — a re-engagement also needs the thread
//                   quiet for the policy's hours.
//   AI-reply gate   the purpose must be a category the AI send policy lists, and the recipient inside its scope (the
//                   SAME scope test the AI row gate applies at dispatch).
//   send-time guard queue/send-time-contact-guard.js on the row this message would be: suppression / DNC, automation
//                   suppressions, a stop-like latest inbound (any language), thread suppressed / opted out, wrong number,
//                   not-owner, the hold registry, the recontact guard, no nurture on a hostile thread, and — first touch
//                   only — the opener rule (already contacted: pair, phone, person, property).
//   pre-send        outbound/presend-eligibility-engine.js: renter-not-owner hard block, identity mismatch (a first
//                   touch also needs a verified / probable identity; a live conversation's identity is judged by the
//                   conversation guards above).
//   window          queue/reply-timing.js#evaluateReplyTiming, purpose campaign (first touch) / followup: 08:00–21:00 in
//                   every plausible recipient zone. Outside it the message is REFUSED with the next permitted time
//                   (nothing is scheduled: the agent asks again then).
import { loadSendTimeContactFacts, evaluateSendTimeContactGuard } from '@/lib/domain/queue/send-time-contact-guard.js'
import { evaluatePreSendEligibility } from '@/lib/domain/outbound/presend-eligibility-engine.js'
import { evaluateReplyTiming, resolveRecipientZones } from '@/lib/domain/queue/reply-timing.js'
import { threadInPolicyScope } from '@/lib/domain/conversation-ai/send-policy.js'

export const AGENT_MESSAGE_VERSION = 'agent-message.v1'
export const AGENT_MESSAGE_PURPOSES = Object.freeze(['first_touch', 'reengage', 'followup', 'answer'])
export const AGENT_OUTBOUND_PURPOSES = Object.freeze(['first_touch', 'reengage', 'followup'])
/** The registry capabilities an agent message exercises (mirrors action_gateway.t34_hold_capabilities('queue_agent_message')). */
export const AGENT_MESSAGE_HOLD_CAPABILITIES = Object.freeze(['ai_action', 'auto_reply', 'campaign', 'follow_up', 'outbound_send'])

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const deny = (code, evidence = {}) => ({ ok: false, code, evidence })

/** A thread's messages, chronological, in the canonical ledger's shape. */
export async function loadThreadHistory(supabase, threadKey, { limit = 40 } = {}) {
  if (!clean(threadKey)) return []
  const r = await supabase.from('message_events').select('id,direction,message_body,created_at,detected_intent,queue_id').eq('thread_key', threadKey).order('created_at', { ascending: false }).limit(limit)
  if (r?.error) throw Object.assign(new Error('THREAD_HISTORY_UNREADABLE'), { code: 'THREAD_HISTORY_UNREADABLE' })
  const rows = (r?.data || []).reverse()
  const kinds = await outboundKindsOf(supabase, rows.filter((m) => !lower(m.direction).startsWith('in')).map((m) => clean(m.queue_id)).filter(Boolean))
  return rows.map((m) => {
    const out = !lower(m.direction).startsWith('in')
    return { id: String(m.id), direction: out ? 'outbound' : 'inbound', body: m.message_body || '', at: m.created_at, intent: m.detected_intent || null,
      ...(out && kinds.get(clean(m.queue_id)) === 'non_answer' ? { non_answer: true } : {}) }
  })
}

// An outbound that is NOT an answer to the seller: an initiated touch (an agent's first touch / follow-up / nurture /
// re-engagement, a template follow-up). Blind v15 Q11: a follow-up that crossed with the seller's reply left the reply
// unanswerable ("not the latest inbound"). Everything else (an agent's answer, a person's manual send, any outbound whose
// queue row cannot be read or is unknown) still counts as an answer: the fail-safe reading.
const NON_ANSWER_SEND_KINDS = new Set(['agent_first_touch', 'agent_followup', 'agent_nurture', 'agent_reengage'])
async function outboundKindsOf(supabase, queueIds) {
  const kinds = new Map()
  if (!queueIds.length) return kinds
  try {
    const q = await supabase.from('send_queue').select('id,message_origin,message_type,metadata').in('id', [...new Set(queueIds)])
    if (q?.error) return kinds
    for (const row of q?.data || []) {
      const origin = lower(row.message_origin); const sendKind = lower(row.metadata?.send_kind); const type = lower(row.message_type)
      const nonAnswer = NON_ANSWER_SEND_KINDS.has(sendKind) || (origin === 'template' && ['followup', 'campaign_opener'].includes(type))
      kinds.set(clean(row.id), nonAnswer ? 'non_answer' : 'answer')
    }
  } catch { /* unreadable: every outbound stays an answer */ }
  return kinds
}



/** The send_queue-shaped row the send-time guard judges (the message as it would be queued). */
export function guardRowOf({ lead, target = null, purpose }) {
  const first = purpose === 'first_touch'
  return {
    id: null, to_phone_number: lead.phone, thread_key: lead.phone, property_id: lead.property_id || target?.property_id || null,
    prospect_id: lead.prospect_id || target?.prospect_id || null, master_owner_id: lead.master_owner_id || target?.master_owner_id || null, phone_id: target?.phone_id || null,
    message_type: first ? 'campaign_opener' : 'followup', type: first ? 'outbound' : 'followup', is_first_touch: first, touch_number: first ? 1 : null,
    created_at: new Date().toISOString(), metadata: { send_kind: first ? 'agent_first_touch' : `agent_${purpose}`, is_first_touch: first },
  }
}

/**
 * Every guard except the activation / grant / ownership (the gateway and the database own those). Pure apart from the
 * injected reads.
 * @param {{ supabase: object, lead: object, target?: object|null, purpose: string, policy: object, aiPolicy: object, messages: Array,
 *           prospect?: object|null, property?: object|null, now: string, holdChecker?: Function|null }} a
 */
export async function evaluateAgentMessageGuards({ supabase, lead, target = null, purpose, policy, aiPolicy, messages = [], prospect = null, property = null, now, holdChecker = null, purposeRules = true, window = true, categoryCheck = true }) {
  if (!lead?.phone) return deny('LEAD_NOT_FOUND')
  if (!AGENT_OUTBOUND_PURPOSES.includes(purpose)) return deny(purpose === 'answer' ? 'ANSWER_USES_CERTIFIED_REPLY' : 'PURPOSE_INVALID', purpose === 'answer' ? { use: 'queue_authorized_reply' } : {})
  // the purpose rules (the pool read judges a continuation without them: it only asks whether the lead is contactable)
  const latest = messages[messages.length - 1] || null
  if (!purposeRules && purpose !== 'first_touch') { /* contactability only */ } else if (purpose === 'first_touch') {
    if (!target) return deny('FIRST_TOUCH_REQUIRES_CAMPAIGN_TARGET')
    if (lower(target.target_status) !== 'ready' || lower(target.routing_status) !== 'ready' || lower(target.identity_status) !== 'verified' || lower(target.suppression_status) !== 'clear') {
      return deny('CAMPAIGN_TARGET_NOT_READY', { target_status: target.target_status || null, routing_status: target.routing_status || null, identity_status: target.identity_status || null, suppression_status: target.suppression_status || null })
    }
    if (messages.some((m) => m.direction === 'outbound')) return deny('ALREADY_CONTACTED', { rule: 'first_touch_opener', source: 'thread_history' })
  } else {
    if (!messages.length) return deny('NO_CONVERSATION_TO_CONTINUE', { hint: 'a lead with no conversation gets a first_touch' })
    if (latest?.direction === 'inbound') return deny('UNANSWERED_SELLER_MESSAGE', { use: 'queue_authorized_reply' })
    if (purpose === 'reengage') {
      const quietMs = Date.parse(now) - (Date.parse(latest?.at || 0) || 0)
      const minH = Number(policy?.reengage_min_quiet_hours) || 72
      if (quietMs < minH * 3600_000) return deny('THREAD_NOT_QUIET', { min_quiet_hours: minH, quiet_hours: Math.floor(Math.max(quietMs, 0) / 3600_000) })
    }
  }
  // the AI-reply certification gate's own scope (the AI row gate applies the same test at dispatch)
  if (categoryCheck && !(aiPolicy?.categories || []).includes(purpose)) return deny('AI_CATEGORY_NOT_ENABLED', { category: purpose })
  if (!threadInPolicyScope(aiPolicy, { thread_key: lead.phone })) return deny('LEAD_NOT_IN_AI_SEND_SCOPE')
  // the send-time contact guard (fail closed)
  const row = guardRowOf({ lead, target, purpose })
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
  // the pre-send eligibility engine (renter-not-owner, identity)
  const contact = { ...(prospect || {}), ...(target?.identity_status && lower(target.identity_status) === 'verified' ? { identity_alignment: { status: 'verified' } } : {}) }
  const pe = evaluatePreSendEligibility(contact, purpose === 'first_touch' ? {} : { allow_identity_unknown: true })
  if (!pe.eligible) return deny('PRESEND_INELIGIBLE', { reason: pe.reason, block_reason: pe.block_reason })
  // the recipient-local window (campaign / follow-up: 08:00–21:00 in every plausible zone)
  if (!window) return { ok: true, code: null, evidence: { purpose, guard: 'clear', presend: pe.reason } }
  const zr = resolveRecipientZones({ recipientPhone: lead.phone, propertyGeography: property ? { state: property.property_address_state || null, zip: property.property_address_zip || null } : null })
  const timing = evaluateReplyTiming({ purpose: purpose === 'first_touch' ? 'campaign' : 'followup', at: now, zones: zr.zones, jurisdictions: zr.jurisdictions })
  if (timing.lawful !== true) return deny('OUTSIDE_RECIPIENT_WINDOW', { next_permitted_at: timing.next_permitted_at || null, zones: timing.zones })
  return { ok: true, code: null, evidence: { purpose, guard: 'clear', presend: pe.reason, window: 'lawful', zones: timing.zones }, timing, zones: zr }
}

/** The day caps, as the gateway reads them (the worker's reservation is the binding check). */
export function capVerdict({ usage = {}, policy = {}, grantLeadDayCap = null }) {
  const leadCap = Number(grantLeadDayCap) || Number(policy.max_per_lead_per_day) || 0
  const globalCap = Number(policy.max_per_day_global) || 0
  if (Number(usage.lead_today) >= leadCap) return deny('DAILY_LEAD_CAP_REACHED', { cap: leadCap })
  if (Number(usage.global_today) >= globalCap) return deny('DAILY_GLOBAL_CAP_REACHED', { cap: globalCap })
  return null
}

/** The window alone (the pool read reports it beside eligibility: it is a time, not a property of the lead). */
export function agentMessageWindow({ phone, property = null, purpose, now }) {
  const zr = resolveRecipientZones({ recipientPhone: phone, propertyGeography: property ? { state: property.property_address_state || null, zip: property.property_address_zip || null } : null })
  const t = evaluateReplyTiming({ purpose: purpose === 'first_touch' ? 'campaign' : 'followup', at: now, zones: zr.zones, jurisdictions: zr.jurisdictions })
  return { open: t.lawful === true, next_permitted_at: t.lawful === true ? null : t.next_permitted_at || null }
}

/** The purpose an agent's next message to a lead would take (its thread history; no history = a first touch). */
export function nextPurposeOf(messages = [], { now, reengageQuietHours = 72 } = {}) {
  const latest = messages[messages.length - 1] || null
  if (!latest || !messages.some((m) => m.direction === 'outbound')) return messages.length ? 'answer' : 'first_touch'
  if (latest.direction === 'inbound') return 'answer'
  return Date.parse(now) - (Date.parse(latest.at || 0) || 0) >= reengageQuietHours * 3600_000 ? 'reengage' : 'followup'
}
