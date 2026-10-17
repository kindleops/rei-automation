// THE NATIVE AI CONVERSATION PIPELINE for one inbound (8.5.16; rc-8.5.21 the ONLY writer path —
// called exclusively through runtime/canonical.js#decideAndCompose): decide first, then text.
//
//   ledger (as of the inbound, validated model facts merged)
//   → decideActions (deterministic rules first; evidence-ranked ownership, mixed intent,
//     financing objections, evidence-backed escalations; model judgment for nuance only)
//   → PREPARE_OFFER / NEGOTIATE_WITHIN_AUTHORITY resolved by the NegotiationAuthority (stub escalates)
//   → AI_GENERATED_REPLY composed by the model (playbook v3), judged by the shared outbound validator
//   → a CANDIDATE for the R3 dispatcher (which re-validates on fresh state before any enqueue)
//
// Pure apart from the injected model client / negotiation authority. Writes nothing and imports
// no queue / transport module (static test).
import { ledgerFromContextInput, ledgerSummary } from '../fact-ledger.js'
import { ACTIONS, PIPELINE_VERSION } from './outcomes.js'
import { decideActions } from './decide.js'
import { composeReply } from './compose.js'
import { assertNegotiationAuthority, createEscalatingNegotiationAuthority, normalizeNegotiationResult } from './negotiation-authority.js'
import { escalation } from '../escalation-evidence.js'
import { NO_COMPANY_IDENTITY } from '../company-identity.js'

export async function runConversationPipeline({
  input, deterministic = null, eligibility = null, judgment = null, deterministicTemplate = { available: false },
  modelClient = null, spend = null, negotiationAuthority = createEscalatingNegotiationAuthority(), ownerHandled = false,
  personaPolicy, establishedPersona = null, companyIdentity = NO_COMPANY_IDENTITY, maskOpts = {}, now = new Date().toISOString(),
}) {
  const authority = assertNegotiationAuthority(negotiationAuthority)
  const ledger = ledgerFromContextInput(input, { modelFacts: judgment?.facts_extracted || [], now })
  let plan = decideActions({
    ledger, inboundText: input.inbound.body, inboundId: input.inbound.id, deterministic, eligibility, judgment, deterministicTemplate,
    ownerHandled, language: input.language, propertyCount: (input.properties || []).length || 1,
    thread: input.thread || [], inbound: input.inbound, companyIdentity,
  })
  const terminal = plan.actions.find((a) => [ACTIONS.PREPARE_OFFER, ACTIONS.NEGOTIATE_WITHIN_AUTHORITY].includes(a.type))
  if (terminal) {
    const ctx = { inbound_message_id: input.inbound.id, ledger_summary: ledgerSummary(ledger), existing_offers: ledger.existing_offers, asking_price: ledger.facts.asking_price?.value ?? null, request: terminal.request }
    const r = normalizeNegotiationResult(terminal.type === ACTIONS.PREPARE_OFFER ? await authority.prepareOffer(ctx) : await authority.negotiateWithinAuthority(ctx))
    // an escalation from the authority names WHY (Phase 3D): no envelope ⇒ missing authority
    const resolved = r.action === 'DETERMINISTIC_REPLY' ? { type: ACTIONS.DETERMINISTIC_REPLY, use_case: r.template_use_case, authority_ref: r.authority_ref }
      : r.action === 'ESCALATE_TO_OPERATOR' ? escalation(/comps|valuation/i.test(r.reason) ? 'missing_comps' : 'missing_negotiation_authority', { authority_reason: r.reason, request: terminal.request })
        : { type: r.action, reason: r.reason }
    plan = { ...plan, actions: plan.actions.map((a) => (a === terminal ? resolved : a)), negotiation: { requested: terminal.type, result: r, authority_version: authority.version } }
  }
  const reply = plan.actions.find((a) => a.type === ACTIONS.AI_GENERATED_REPLY)
  let composition = null
  if (reply) {
    const messages = (input.thread || []).map((m) => ({ from: m.direction === 'inbound' ? 'seller' : 'us', text: String(m.body || '').slice(0, 300) }))
    composition = await composeReply({
      ledger, inboundText: input.inbound.body, category: reply.category, objective: reply.objective, modelClient, spend, messages, maskOpts,
      threadLength: (input.thread || []).length, inboundIntent: judgment?.intent || null, personaPolicy, establishedPersona, companyIdentity,
      firstName: input.names?.first_name || null, otherNames: otherNamesOf(input),
      followupScheduled: plan.actions.find((a) => a.type === ACTIONS.SCHEDULE_FOLLOWUP) || reply.followup_scheduled || null,
    })
    // a disinterest close is optional (the 30-day follow-up is the owner rule): a rejected close
    // becomes NO_RESPONSE with the follow-up kept; any other rejected reply goes to a human
    const optionalClose = reply.category === 'not_interested_close' && plan.actions.some((a) => a.type === ACTIONS.SCHEDULE_FOLLOWUP)
    if (!composition.ok) {
      const failed = /model|spend|budget|call/i.test(String(composition.reason))
      plan = { ...plan, actions: plan.actions.map((a) => (a === reply ? (optionalClose ? { type: ACTIONS.NO_RESPONSE, reason: `close_dropped:${composition.reason}` } : failed ? escalation('failed_tool', { composition: composition.reason }) : { type: ACTIONS.HOLD, reason: `composition:${composition.reason}` }) : a)) }
    }
  }
  return {
    pipeline_version: PIPELINE_VERSION,
    inbound_message_id: input.inbound.id,
    plan,
    ledger,
    ledger_summary: ledgerSummary(ledger),
    composition,
    send_status: 'not_sent_pipeline', // the pipeline never sends; R3 (OFF) is the only enqueue path
  }
}

/** Owner / co-owner names on the property that are not the seller's own first name (never in our text). */
export function otherNamesOf(input = {}) {
  const first = String(input.names?.first_name || '').toLowerCase()
  return [...new Set((input.names?.full_names || []).flatMap((n) => String(n).split(/\s+/)).filter((w) => w.length >= 3 && /^[A-Za-z'-]+$/.test(w) && w.toLowerCase() !== first))]
}
