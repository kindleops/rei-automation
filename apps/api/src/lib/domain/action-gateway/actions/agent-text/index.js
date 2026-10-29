// queue_agent_text (T3, seller-facing; link #32 PROPOSED_20261029100000). OWNER ARCHITECTURE CORRECTION 2026-10-29:
// "Agntei owns the intelligence and conversation. LeadCommand owns messaging infrastructure and compliance enforcement.
// The carrier delivers the SMS." An Agntei AI employee (Sterling, head of acquisitions; Nova, representative …) composes
// EVERY SMS on its own model session and sends LeadCommand the EXACT body. LeadCommand never writes, rewrites or
// regenerates a word of it (no model is constructed anywhere on this path): it validates the text deterministically
// (conversation-ai/agent-text-validator.js), enforces compliance and transports it.
//
// Request-time gates, in order, each refusing with an explicit code (never silently):
//   availability     both emergency stops (R2 agent.runtime_limits, queue_emergency_stop_at) → EMERGENCY_STOP_ACTIVE;
//                    the switch ai_agent_text_enabled (born OFF) → AGENT_TEXT_KILL_SWITCH_OFF
//   scope            ai_conversation_send_policy.scope WHEN SET → LEAD_NOT_IN_AI_SEND_SCOPE
//   the lead         LEAD_NOT_FOUND / LEAD_THREAD_TARGET_MISMATCH; exactly one holder (lead_assignments) → NOT_LEAD_OWNER
//   eligibility      the pool read's order: holds → AUTOMATION_HOLD; the thread's permission (STOP in any language /
//                    suppression / opt-out marks / wrong number / not owner) → STOP_REQUESTED / CONTACT_NOT_PERMITTED;
//                    the purpose rules (in_reply_to = the latest unanswered inbound, one answer per inbound, quiet hours,
//                    the first-touch opener rule …); the send-time contact guard → CONTACT_NOT_ELIGIBLE / ALREADY_CONTACTED;
//                    pre-send eligibility → PRESEND_INELIGIBLE
//   window           the recipient-local window → OUTSIDE_RECIPIENT_WINDOW with next_permitted_at (never scheduled)
//   caps             per lead per day, initiated per lead per day, global per day → DAILY_*_CAP_REACHED (the worker's
//                    reservations bind them)
//   idempotency      the same client_request_id → the same intent; another body under it → IDEMPOTENCY_CONFLICT
//   content          the deterministic validator → CONTENT_REJECTED (reasons[]), MONEY_NOT_AUTHORIZED, STOP_REQUESTED,
//                    CONTACT_NOT_PERMITTED
// The intent's params carry the body's sha256 and the attribution's, never the words (the intent record refuses message
// text): the gateway records the exact text + attribution ONCE (public.action_gateway_agent_text_submit), the handoff
// and LeadCommand's worker read it back by those hashes and re-verify everything at execution.
import { UUID, obj, str, enumOf } from '../../../../agent/capabilities/defs/_schema.js'
import { normalizeSendPolicy, AI_SEND_POLICY_KEY } from '../../../conversation-ai/send-policy.js'
import { normalizeCompanyIdentity, COMPANY_IDENTITY_KEY } from '../../../conversation-ai/company-identity.js'
import { validateAgentText } from '../../../conversation-ai/agent-text-validator.js'
import { moneyMentions } from '../../../conversation-ai/validator.js'
import { loadThreadHistory } from '../../../outreach/agent-message.js'
import {
  AGENT_TEXT_PURPOSES, AGENT_TEXT_HOLD_CAPABILITIES, agentTextPurposeVerdict, agentTextScopeVerdict, evaluateAgentTextContactGuards, agentTextCapVerdict, DEFAULT_AGENT_TEXT_POLICY,
} from '../../../outreach/agent-text.js'
import { gwErr } from '../../errors.js'
import { TIERS, DOMAIN_WRITES } from '../../constants.js'
import { holdDeny, permissionDeny, iso, num } from '../t34/shared.js'
import { LEAD_INPUT, resolveLead, leadParams } from '../t34/queue-agent-message.js'

const CLIENT_KEY = str(80, { minLength: 8, pattern: '^[A-Za-z0-9_.:-]{8,80}$' })
// the agent's exact SMS: 1–320 characters, printable (line breaks allowed), stored verbatim
export const AGENT_TEXT_BODY = str(320, { minLength: 1, pattern: '^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]+$' })
const ATTR = (max) => ({ type: ['string', 'null'], maxLength: max })
/** {employee, model, provider, route, session_id, turn_id}: stored verbatim, never interpreted; employee + route required. */
export const AGENT_TEXT_ATTRIBUTION = obj({ employee: str(80, { minLength: 1 }), model: ATTR(200), provider: ATTR(200), route: str(200, { minLength: 1 }), session_id: ATTR(200), turn_id: ATTR(200) }, ['employee', 'route'])
const MESSAGE_ID = str(80, { minLength: 1, pattern: '^[A-Za-z0-9_.:-]{1,80}$' })

async function definerRead(reads, fn, args) {
  const r = await reads.client.rpc(fn, args)
  if (r?.error) throw Object.assign(new Error(`${fn} read failed`), { code: 'READ_FAILED' })
  return r?.data ?? null
}
/** The database's ONE agent-text verdict + policy + the lead (+ owner, usage, latest message) for the gateway role. */
export const agentTextState = (reads, { campaign_target_id = null, thread_id = null, grant_id = null } = {}) =>
  definerRead(reads, 'action_gateway_agent_text_state', { p_campaign_target_id: campaign_target_id, p_thread_id: thread_id, p_grant_id: grant_id })

export const QUEUE_AGENT_TEXT_SPEC = Object.freeze({
  name: 'queue_agent_text',
  title: 'Send the exact SMS you composed (agent text)',
  description: 'Send ONE SMS you composed yourself, word for word, to a lead you hold (assign_lead first): body is the exact text (1–320 characters); LeadCommand never writes or changes it. It validates it deterministically and transports it. purpose: first_touch (campaign_target_id, no prior contact), followup / nurture / reengage (a quiet thread), or an ANSWER — reply / qualification / negotiation / appointment — which must name in_reply_to_message_id, the thread\'s latest unanswered seller message (one answer per inbound). attribution {employee, model, provider, route, session_id, turn_id} is stored verbatim with the text (employee and route required). Refusals are explicit: EMERGENCY_STOP_ACTIVE, AGENT_TEXT_KILL_SWITCH_OFF, LEAD_NOT_IN_AI_SEND_SCOPE, NOT_LEAD_OWNER, AUTOMATION_HOLD, STOP_REQUESTED, CONTACT_NOT_PERMITTED, CONTACT_NOT_ELIGIBLE, PRESEND_INELIGIBLE, the purpose rules (IN_REPLY_TO_REQUIRED, IN_REPLY_TO_NOT_LATEST_INBOUND, UNANSWERED_SELLER_MESSAGE, ALREADY_CONTACTED, FOLLOWUP_QUIET_HOURS …), OUTSIDE_RECIPIENT_WINDOW (with next_permitted_at; nothing is scheduled), DAILY_LEAD_CAP_REACHED / DAILY_INITIATED_CAP_REACHED / DAILY_GLOBAL_CAP_REACHED, IDEMPOTENCY_CONFLICT, MONEY_NOT_AUTHORIZED (an amount needs a live negotiation send authorization of this lead: send_permit_id), CONTENT_REJECTED with reasons[]. Seller-facing (T3): a human approves each use unless an owner granted standing seller-facing authority for it.',
  capability: 'conversation.queue_agent_text', tier: TIERS.T3, resource: 'thread_or_campaign',
  // an owner-minted standing seller-facing grant authorizes it without a per-use approval (as #31 / #32 for the others)
  standing_reply: true,
  // the attribution is a verbatim record (its key names are not identity / authority keys)
  verbatim_keys: ['attribution'],
  idempotency_conflict_code: 'IDEMPOTENCY_CONFLICT',
  unavailable_reason_is_code: true,
  input: obj({ client_request_id: CLIENT_KEY, ...LEAD_INPUT, purpose: enumOf(AGENT_TEXT_PURPOSES), body: AGENT_TEXT_BODY, in_reply_to_message_id: MESSAGE_ID, send_permit_id: UUID, attribution: AGENT_TEXT_ATTRIBUTION },
    ['client_request_id', 'purpose', 'body', 'attribution']),
  executor: { kind: 'domain_write', fn: DOMAIN_WRITES.handoff },
  recovery: 'reexecute',
  limits: { per_min: 20 },
  wraps: { service: 'handoff → LeadCommand worker action_gateway.execute (agentText): every gate re-verified, the exact body → ai_generated_messages (record_kind agent_text, NO model call) → ONE send_queue row → the queue runner (agent-text row gate) → the provider', module: 'apps/api/src/lib/ai/action-gateway-execution.js' },
  touches: ['agent_runtime_job'],
})

/** A live negotiation send authorization of this lead (the #28 read) that a priced text may use, or null. */
export function moneyAuthorityOf(state, sendPermitId, nowMs) {
  const a = state?.send_authorization
  const e = state?.envelope
  if (!a || !sendPermitId || String(a.send_authorization_id) !== String(sendPermitId) || a.revoked === true) return null
  if (!(Date.parse(a.valid_from) <= nowMs && Date.parse(a.expires_at) > nowMs) || Number(a.uses) >= Number(a.max_sends)) return null
  if (!e || e.revoked === true || Number(e.version) !== Number(e.latest_version ?? e.version) || !(Date.parse(e.valid_from) <= nowMs && Date.parse(e.expires_at) > nowMs)) return null
  const ceiling = Math.min(...[num(a.ceiling), num(e.max_price)].filter((x) => x != null && x > 0))
  return Number.isFinite(ceiling) ? { ceiling, send_permit_id: String(a.send_authorization_id) } : null
}

const deny = (code, evidence = {}) => ({ decision: 'deny', code, evidence })

export const QUEUE_AGENT_TEXT_LOGIC = Object.freeze({
  async available({ reads }) {
    const st = await agentTextState(reads, {})
    return st?.available === true ? { available: true } : { available: false, code: st?.code || 'AGENT_TEXT_STATE_UNREADABLE' }
  },
  resolve: resolveLead,
  async params(input, resource, { reads }) {
    // the exact text + attribution, recorded ONCE (content-addressed); the intent carries their hashes, never the words
    let sub
    try { sub = await definerRead(reads, 'action_gateway_agent_text_submit', { p_body: input.body, p_attribution: input.attribution || {} }) } catch { sub = null }
    if (!sub) throw gwErr('unavailable', 'AGENT_TEXT_SUBMISSION_UNAVAILABLE', 'the text could not be recorded; retry with the same client_request_id')
    if (sub.ok !== true) throw gwErr('invalid_input', sub.reason === 'ATTRIBUTION_EMPLOYEE_AND_ROUTE_REQUIRED' ? 'ATTRIBUTION_INVALID' : `BODY_INVALID`, `the text or its attribution was refused (${sub.reason})`, { reason: sub.reason })
    const amounts = [...new Set(moneyMentions(input.body).map((m) => Math.round(Number(m.amount) || 0)).filter((n) => n > 0))]
    return { ...leadParams(input), purpose: input.purpose, text_hash: sub.text_hash, attribution_hash: sub.attribution_hash, author_employee: String(input.attribution?.employee || '').trim().slice(0, 80),
      ...(input.in_reply_to_message_id ? { in_reply_to_message_id: input.in_reply_to_message_id } : {}),
      ...(amounts.length === 1 && input.send_permit_id ? { money_amount: amounts[0], send_permit_id: input.send_permit_id } : {}), runtime_kind: 'action_gateway.execute' }
  },
  // idempotency is over WHAT is sent and to whom: the same client_request_id with the same text is the same intent
  // whatever its attribution says (the first attribution recorded stays the intent's); another text is a conflict
  hashParams: (params) => { const { attribution_hash, author_employee, ...rest } = params; void attribution_hash; void author_employee; return rest },
  async policy({ input, principal, grant, reads, services, store, now }) {
    let st
    try { st = await agentTextState(reads, { ...leadParams(input), grant_id: grant?.grant_id || null }) } catch { return deny('AGENT_TEXT_STATE_UNREADABLE') }
    if (!st?.available) return deny(st?.code || 'AGENT_TEXT_KILL_SWITCH_OFF')
    const policy = { ...DEFAULT_AGENT_TEXT_POLICY, ...(st.policy || {}) }
    const lead = st.lead
    if (!lead || lead.mismatch) return deny(lead?.mismatch ? 'LEAD_THREAD_TARGET_MISMATCH' : 'LEAD_NOT_FOUND')
    // the AI send policy's scope, WHEN SET
    let aiPolicy
    try { aiPolicy = normalizeSendPolicy((await reads.switches([AI_SEND_POLICY_KEY]))[AI_SEND_POLICY_KEY]) } catch { return deny('AI_SEND_POLICY_UNREADABLE') }
    const sc = agentTextScopeVerdict(aiPolicy, { thread_key: lead.phone, market: st.target?.market || null, campaign_id: lead.campaign_id || null })
    if (sc) return deny(sc.code, sc.evidence)
    // exactly ONE holder per lead
    if (st.owner_agent_id !== principal.agent_id) return deny('NOT_LEAD_OWNER', { owner: st.owner_agent_id ? 'another_agent' : 'unassigned', hint: 'assign_lead first' })
    // eligibility in the pool read's order: holds, the thread's permission, the purpose rules, the send-time guards
    const h = await holdDeny(services, { threadKey: lead.phone, threadId: lead.thread_id || null, propertyId: lead.property_id || null, masterOwnerId: lead.master_owner_id || null }, AGENT_TEXT_HOLD_CAPABILITIES)
    if (h) return h
    if (lead.thread_id) {
      const p = await permissionDeny(reads, { id: lead.thread_id, refs: { thread_key: lead.phone } })
      if (p) return p
    }
    let messages = []
    let prospect = null
    let property = null
    try {
      messages = await loadThreadHistory(reads.client, lead.phone)
      if (lead.prospect_id) { const r = await reads.client.from('prospects').select('*').eq('prospect_id', String(lead.prospect_id)).limit(1); if (r?.error) throw new Error('prospect'); prospect = r?.data?.[0] || null }
      if (lead.property_id) property = await reads.property(lead.property_id)
    } catch { return deny('LEAD_FACTS_UNREADABLE') }
    const at = iso(now())
    const pv = agentTextPurposeVerdict({ purpose: input.purpose, inReplyTo: input.in_reply_to_message_id || null, messages, target: st.target || null, policy, now: at })
    if (!pv.ok) return deny(pv.code, pv.evidence)
    const g = await evaluateAgentTextContactGuards({ supabase: reads.client, lead, target: st.target || null, purpose: input.purpose, prospect, property, now: at, holdChecker: (a) => services.holdCheck(a), answers: pv.answers })
    if (!g.ok) return deny(g.code, g.evidence)
    // the day caps (the worker's reservation is the binding check)
    const cap = agentTextCapVerdict({ usage: st.usage || {}, policy, purpose: input.purpose })
    if (cap) return deny(cap.code, cap.evidence)
    // the content: the exact text, judged deterministically on this thread
    let companyIdentity
    try { companyIdentity = normalizeCompanyIdentity((await reads.switches([COMPANY_IDENTITY_KEY]))[COMPANY_IDENTITY_KEY]) } catch { companyIdentity = normalizeCompanyIdentity(null) }
    let moneyAuthority = null
    if (input.send_permit_id && lead.thread_id && lead.property_id) {
      try { moneyAuthority = moneyAuthorityOf(await store.negotiationState(lead.thread_id, lead.property_id), input.send_permit_id, now()) } catch { moneyAuthority = null }
    }
    const v = validateAgentText(input.body, { purpose: input.purpose, messages, policy, companyIdentity, authorEmployee: input.attribution?.employee || null, moneyAuthority, property,
      firstName: st.target?.seller_first_name || prospect?.first_name || null, now: at })
    if (!v.ok) return deny(v.code, { reasons: v.reasons.slice(0, 20), ...(v.non_owner?.non_owner ? { ownership: v.non_owner.ownership, non_owner_kinds: v.non_owner.kinds } : {}) })
    return { decision: 'allow', evidence: { ...g.evidence, owner: 'self', composer: 'agent', validator: v.version, purpose: input.purpose, answers: pv.answers ? 'latest_inbound' : null, priced: v.money.amount != null } }
  },
  summary: (params) => [`Agent-composed ${params.purpose} text: the exact words of ${params.author_employee || 'the agent'} (LeadCommand writes nothing), validated deterministically and re-checked at execution and dispatch.`, 'Seller-facing (T3): a human approves this one use (unless an owner granted standing seller-facing authority for it).'],
})
