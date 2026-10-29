// queue_agent_message (T3, seller-facing; link #32 PROPOSED_20261029100000). An agent asks LeadCommand to send ONE
// message on its OWN initiative — a first touch to a lead with no conversation (a campaign target), a re-engagement of
// a quiet thread, a follow-up — with NO preceding inbound. LeadCommand WRITES the message itself through its canonical
// composer (runtime/canonical.js#composeAgentOutbound: playbook v3, the shared outbound validator, the thread's history
// when there is one); the agent supplies a BRIEF (context, never sent verbatim) and may name a governed template as
// the explicit fallback for when the composer is unavailable or refuses. purpose 'answer' is a reply: the certified
// queue_authorized_reply path (the Action MCP routes sms_send_agent_message {purpose:'answer'} there).
//
// AVAILABLE ONLY when (a) the AI-reply certification gate is on (ai_conversation_send_enabled + an enabled
// ai_conversation_send_policy; the owner turns it on after the blind evaluation) AND (b) this action's own switch
// (ai_agent_message_enabled + an enabled ai_agent_message_policy), with neither emergency stop engaged; otherwise
// capability_unavailable whatever the grants. A human approves each use — unless an owner minted a STANDING
// seller-facing grant for conversation.queue_agent_message (confined by CHECK, re-verified at the handoff and in the
// worker). The sending agent must hold the lead (assign_lead): otherwise NOT_LEAD_OWNER.
//
// Guards here (before any approval is filed, and again when it is consumed; LeadCommand's worker re-runs all of them
// at execution, the queue runner re-checks at dispatch): the hold registry, the lead's owner, the AI send policy's
// category + scope, the purpose rules, the send-time contact guard (suppression / DNC / stop history in any language /
// wrong number / not owner / the opener rule for a first touch), the pre-send eligibility engine, the recipient-local
// window, the day caps, the fallback template's governance.
import { UUID, obj, str, enumOf } from '../../../../agent/capabilities/defs/_schema.js'
import { normalizeSendPolicy, AI_SEND_POLICY_KEY } from '../../../conversation-ai/send-policy.js'
import { applyGovernance, indexGovernance } from '../../../campaigns/template-governance.js'
import { gwErr } from '../../errors.js'
import { TIERS, DOMAIN_WRITES } from '../../constants.js'
import { mustThread, threadResource, holdDeny, permissionDeny, iso } from './shared.js'
import { TEXT } from '../t2/_schema.js'
import { cleanText } from '../t2/shared.js'
import { AGENT_MESSAGE_PURPOSES, AGENT_MESSAGE_HOLD_CAPABILITIES, evaluateAgentMessageGuards, loadThreadHistory, capVerdict } from '../../../outreach/agent-message.js'

const CLIENT_KEY = str(80, { minLength: 8, pattern: '^[A-Za-z0-9_.:-]{8,80}$' })
export const TEMPLATE_ID = str(64, { minLength: 1, pattern: '^[A-Za-z0-9_.:-]{1,64}$' })

/** A lead: a thread, a campaign target, or both (they must be the same person × number). */
export const LEAD_INPUT = Object.freeze({ campaign_target_id: UUID, thread_id: UUID })

async function definerRead(reads, fn, args) {
  const r = await reads.client.rpc(fn, args)
  if (r?.error) throw Object.assign(new Error(`${fn} read failed`), { code: 'READ_FAILED' })
  return r?.data ?? null
}
/** The database's ONE activation verdict + policy + the lead (+ owner, usage) for the gateway role. */
export const agentMessageState = (reads, { campaign_target_id = null, thread_id = null, grant_id = null } = {}) =>
  definerRead(reads, 'action_gateway_agent_message_state', { p_campaign_target_id: campaign_target_id, p_thread_id: thread_id, p_grant_id: grant_id })

/** Resolve a lead input to the intent's resource: its thread when one is named, else its campaign. */
export async function resolveLead(input, { reads }) {
  if (!input.thread_id && !input.campaign_target_id) throw gwErr('invalid_input', 'LEAD_REQUIRED', 'name the lead: a thread_id, a campaign_target_id, or both')
  if (input.thread_id) {
    const t = await mustThread(reads, input.thread_id)
    return threadResource(t, input.campaign_target_id ? { campaign_target_id: input.campaign_target_id } : {})
  }
  const st = await agentMessageState(reads, { campaign_target_id: input.campaign_target_id })
  if (!st?.target?.id || !st?.lead) throw gwErr('not_found', 'CAMPAIGN_TARGET_NOT_FOUND', 'no campaign target with this id (or it has no number)')
  if (!st.target.campaign_id) throw gwErr('not_found', 'CAMPAIGN_TARGET_WITHOUT_CAMPAIGN', 'the campaign target belongs to no campaign')
  return { type: 'campaign', id: String(st.target.campaign_id).toLowerCase(), refs: { campaign_target_id: input.campaign_target_id, property_id: st.target.property_id || null, market: st.target.market || null } }
}
export const leadParams = (input) => ({ ...(input.thread_id ? { thread_id: input.thread_id } : {}), ...(input.campaign_target_id ? { campaign_target_id: input.campaign_target_id } : {}) })

export const QUEUE_AGENT_MESSAGE_SPEC = Object.freeze({
  name: 'queue_agent_message',
  title: 'Send an agent-initiated message (LeadCommand writes it)',
  description: 'Ask LeadCommand to send ONE message on your initiative to a lead you hold (assign_lead first): a first touch to a lead with no conversation (campaign_target_id), a re-engagement of a quiet thread, or a follow-up (thread_id). LeadCommand writes the text itself with its canonical AI writer and validators, from your brief and the thread history; you never supply the words. Optional template_id: a governed fallback template (list_message_templates) used only if the writer is unavailable or refuses. purpose "answer" is a reply to an inbound: use queue_authorized_reply (sms_send_agent_message routes it). Available only when the AI send capability AND agent messages are activated; suppression, STOP history in any language, wrong number, not-owner, holds, the first-touch already-contacted rule, the 08:00–21:00 recipient window, the pre-send eligibility engine and the day caps all apply. A human approves each use unless an owner granted standing seller-facing authority for it.',
  capability: 'conversation.queue_agent_message', tier: TIERS.T3, resource: 'thread_or_campaign',
  // link #32: an owner-minted standing seller-facing grant authorizes it without a per-use approval (as #31 for the reply)
  standing_reply: true,
  input: obj({ client_request_id: CLIENT_KEY, ...LEAD_INPUT, purpose: enumOf(AGENT_MESSAGE_PURPOSES), brief: TEXT(500, 8), template_id: TEMPLATE_ID }, ['client_request_id', 'purpose', 'brief']),
  executor: { kind: 'domain_write', fn: DOMAIN_WRITES.handoff },
  recovery: 'reexecute',
  limits: { per_min: 6 },
  wraps: { service: 'handoff → LeadCommand worker action_gateway.execute: conversation-ai/runtime/canonical#composeAgentOutbound → the AI-message ledger (agent_outbound) → insertSupabaseSendQueueRow → the queue runner (AI row gate + agent-message row gate); fallback: a governed template through the canonical queue writer', module: 'apps/api/src/lib/ai/action-gateway-execution.js' },
  touches: ['agent_runtime_job'],
})

/** The template's governance verdict (the campaign path's applyGovernance over its rotation row). */
export function templateGovernanceVerdict(t) {
  if (!t) return { ok: false, reason: 'template_not_found' }
  const { eligible, rejected } = applyGovernance([{ ...t, is_active: t.is_active === true }], indexGovernance(t.governance ? [{ template_id: t.template_id, ...t.governance }] : []), t.use_case || '')
  return eligible.length === 1 ? { ok: true, reason: 'governed' } : { ok: false, reason: rejected[0]?.reason || 'not_eligible' }
}

export const QUEUE_AGENT_MESSAGE_LOGIC = Object.freeze({
  async available({ reads }) {
    const st = await agentMessageState(reads, {})
    return st?.available === true ? { available: true } : { available: false, code: st?.code || 'AGENT_MESSAGE_OFF' }
  },
  resolve: resolveLead,
  async params(input) {
    return { ...leadParams(input), purpose: input.purpose, brief: cleanText(input.brief, 500), ...(input.template_id ? { template_id: input.template_id } : {}), runtime_kind: 'action_gateway.execute' }
  },
  async policy({ input, principal, grant, reads, services, now }) {
    if (input.purpose === 'answer') return { decision: 'deny', code: 'ANSWER_USES_CERTIFIED_REPLY', evidence: { use: 'queue_authorized_reply' } }
    let st
    try { st = await agentMessageState(reads, { ...leadParams(input), grant_id: grant?.grant_id || null }) } catch { return { decision: 'deny', code: 'AGENT_MESSAGE_STATE_UNREADABLE', evidence: {} } }
    if (!st?.available) return { decision: 'deny', code: 'CAPABILITY_UNAVAILABLE', evidence: { reason: st?.code || null } }
    const lead = st.lead
    if (!lead || lead.mismatch) return { decision: 'deny', code: lead?.mismatch ? 'LEAD_THREAD_TARGET_MISMATCH' : 'LEAD_NOT_FOUND', evidence: {} }
    // the lead's owner: exactly one principal sends to a seller
    if (st.owner_agent_id !== principal.agent_id) return { decision: 'deny', code: 'NOT_LEAD_OWNER', evidence: { owner: st.owner_agent_id ? 'another_agent' : 'unassigned', hint: 'assign_lead first' } }
    const h = await holdDeny(services, { threadKey: lead.phone, threadId: lead.thread_id || null, propertyId: lead.property_id || null, masterOwnerId: lead.master_owner_id || null }, AGENT_MESSAGE_HOLD_CAPABILITIES)
    if (h) return h
    if (lead.thread_id) {
      const p = await permissionDeny(reads, { id: lead.thread_id, refs: { thread_key: lead.phone } })
      if (p) return p
    }
    // the fallback template (when named): in the policy's list for this purpose, active, governed
    if (input.template_id) {
      if (!((st.policy?.fallback_templates || {})[input.purpose] || []).includes(input.template_id)) return { decision: 'deny', code: 'TEMPLATE_NOT_ALLOWED', evidence: { template_id: input.template_id, purpose: input.purpose } }
      let tpl
      try { tpl = ((await definerRead(reads, 'action_gateway_message_templates', {})) || []).find((t) => t.template_id === input.template_id) } catch { return { decision: 'deny', code: 'TEMPLATE_UNREADABLE', evidence: {} } }
      const gv = templateGovernanceVerdict(tpl)
      if (!gv.ok) return { decision: 'deny', code: 'TEMPLATE_NOT_GOVERNED', evidence: { reason: gv.reason } }
    }
    let aiPolicy
    try { aiPolicy = normalizeSendPolicy((await reads.switches([AI_SEND_POLICY_KEY]))[AI_SEND_POLICY_KEY]) } catch { return { decision: 'deny', code: 'AI_SEND_POLICY_UNREADABLE', evidence: {} } }
    let messages = []
    let prospect = null
    let property = null
    try {
      messages = await loadThreadHistory(reads.client, lead.phone)
      if (lead.prospect_id) { const r = await reads.client.from('prospects').select('*').eq('prospect_id', String(lead.prospect_id)).limit(1); if (r?.error) throw new Error('prospect'); prospect = r?.data?.[0] || null }
      if (lead.property_id) property = await reads.property(lead.property_id)
    } catch { return { decision: 'deny', code: 'LEAD_FACTS_UNREADABLE', evidence: {} } }
    const holdChecker = (a) => services.holdCheck(a)
    const g = await evaluateAgentMessageGuards({ supabase: reads.client, lead, target: st.target || null, purpose: input.purpose, policy: st.policy, aiPolicy, messages, prospect, property, now: iso(now()), holdChecker })
    if (!g.ok) return { decision: 'deny', code: g.code, evidence: g.evidence }
    // the day caps (the worker's reservation is the binding check)
    const cap = capVerdict({ usage: st.usage || {}, policy: st.policy || {}, grantLeadDayCap: st.grant_lead_day_cap })
    if (cap) return { decision: 'deny', code: cap.code, evidence: cap.evidence }
    return { decision: 'allow', evidence: { ...g.evidence, owner: 'self', writer: 'canonical_ai', fallback_template: input.template_id ? 'named' : 'none' } }
  },
  summary: (params) => [`Agent-initiated ${params.purpose} message: LeadCommand writes it with its canonical AI writer from the agent's brief (never the agent's words), validates it and re-checks every send guard.`, 'Seller-facing (T3): a human approves this one use (unless an owner granted standing seller-facing authority for it).'],
})

// ── list_message_templates (T1 read) ──────────────────────────────────────────
export const MESSAGE_TEMPLATES_READ_SPEC = Object.freeze({
  name: 'list_message_templates',
  title: 'Governed fallback / campaign templates for agent messages',
  description: 'The governed LeadCommand templates the agent-message policy allows as the explicit fallback (and configured campaign content), per purpose (first_touch, reengage, followup): id, name, use case, language, the body with its merge fields ({{seller_first_name}}, {{agent_name}}, {{property_address}} …, filled by LeadCommand), and whether governance currently admits it. Agent messages are normally written by LeadCommand\'s AI writer; a template is used only when you name one and the writer is unavailable or refuses.',
  capability: 'conversation.read_message_templates', tier: TIERS.T1, scope: null, resource: 'system',
  input: obj({ purpose: enumOf(['first_touch', 'reengage', 'followup']) }, []),
  limits: { per_min: 20 },
  wraps: { service: 'public.action_gateway_message_templates (link #32): sms_templates ⋈ ownership_template_rotation_control, filtered by ai_agent_message_policy.fallback_templates' },
})
export const MESSAGE_TEMPLATES_READ_LOGIC = Object.freeze({
  async read({ input, reads }) {
    const rows = (await definerRead(reads, 'action_gateway_message_templates', {})) || []
    const st = await agentMessageState(reads, {}).catch(() => null)
    const out = rows.filter((t) => !input.purpose || (t.purposes || []).includes(input.purpose)).map((t) => {
      const gv = templateGovernanceVerdict(t)
      return { template_id: t.template_id, template_name: t.template_name || null, use_case: t.use_case || null, language: t.language || null, purposes: t.purposes || [], body: t.template_body || '', governed: gv.ok, governance_reason: gv.reason }
    })
    return { resource_type: 'system', templates: out, agent_messages_available: st?.available === true, unavailable_reason: st?.available ? null : st?.code || null,
      note: 'Template bodies are LeadCommand copy with merge fields; LeadCommand fills them. Agent messages are written by LeadCommand\'s AI writer; a template is only the named fallback.' }
  },
})
