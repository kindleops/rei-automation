// THE CANONICAL AI CONVERSATION RUNTIME (rc-8.5.21, owner directive "AUTONOMOUS INTELLIGENCE
// INTEGRATION & EXECUTION", Phases 1 + 2). ONE exported entry, decideAndCompose(), is the only way
// seller-facing AI words are decided and written. Every caller uses THIS function reference:
//
//   live shadow           ai/conversation-ai-shadow-wiring.js#runConversationAiShadowForInbound
//   durable turns         ai/conversation-turn-wiring.js#createCanonicalTurnDecider (conversation.turn)
//   R3 dispatcher         ai/conversation-ai-r3-executor.js — re-validates the SAME record with the
//                         shared outbound validator on fresh state (no second writer, no model call)
//   review API drafts     ai/conversation-ai-draft-service.js → POST /api/cockpit/agent/conversation-ai/draft
//   capability            agent/capabilities/defs/inbox.js `inbox.draft_ai_reply` (Agntei / MCP)
//   evaluations           runtime/evaluation-entry.js#replayTurnForEvaluation
// (contract test: conversation-ai-canonical-runtime-contract.test.mjs proves the identity.)
//
//   context (bounded, read-only rows) → R1 understanding (INPUT STAGE ONLY: intent, facts,
//   confidence, escalation claim; its proposed_message is discarded and never sent) → the
//   pipeline (pipeline/run.js: decide first, then playbook-v3 text) → the shared outbound
//   validator with the existing eligibility + the shared send-time function → ONE record that
//   carries every version that produced it.
//
// The R1 proposed_message composer is RETIRED for outbound drafts (engine.js#composeDraft throws).
// There is no silent fallback: a missing model, an invalid judgment or a rejected composition is a
// HOLD / escalation with the reason, never a template or another writer.
// Pure apart from the injected model client / negotiation authority. Writes nothing.
import { ContextError, CONTEXT_VERSION, buildConversationContext } from '../context-builder.js'
import { UNDERSTAND_VERSION, understandInbound } from '../understand.js'
import { runConversationPipeline } from '../pipeline/run.js'
import { ACTIONS, PIPELINE_VERSION, TERMINAL_ACTIONS } from '../pipeline/outcomes.js'
import { COMPOSE_PROMPT_VERSION, PLAYBOOK_VERSION } from '../playbook/v3/index.js'
import { OUTBOUND_VALIDATOR_VERSION, validateOutbound } from '../outbound-validator.js'
import { FACT_LEDGER_VERSION, ledgerSummary } from '../fact-ledger.js'
import { NO_COMPANY_IDENTITY } from '../company-identity.js'
import { multiPropertyEvidence } from '../escalation-evidence.js'
import { mixedAnswerTarget } from '../property-ownership.js'
import { perPropertyObjective } from '../property-facts.js'
import { createEscalatingNegotiationAuthority } from '../pipeline/negotiation-authority.js'
import { maskText } from '../pii.js'

export const CANONICAL_RUNTIME_VERSION = 'conv-ai.canonical-runtime.v1'
/** The writer identity recorded on every decision: pipeline + playbook + compose prompt. */
export const WRITER_VERSION = `${PIPELINE_VERSION}+${PLAYBOOK_VERSION}+${COMPOSE_PROMPT_VERSION}`
export const CANONICAL_CALLERS = Object.freeze(['turn', 'shadow', 'r3_revalidation', 'review_api', 'capability', 'evaluation'])
export const CANONICAL_VERSIONS = Object.freeze({
  runtime: CANONICAL_RUNTIME_VERSION, writer: WRITER_VERSION, pipeline: PIPELINE_VERSION, playbook: PLAYBOOK_VERSION,
  compose_prompt: COMPOSE_PROMPT_VERSION, understand: UNDERSTAND_VERSION, validator: OUTBOUND_VALIDATOR_VERSION,
  context: CONTEXT_VERSION, fact_ledger: FACT_LEDGER_VERSION,
})

/** The terminal action of a plan (exactly one, validatePlan guarantees it). */
export function terminalOf(plan) {
  return (plan?.actions || []).find((a) => TERMINAL_ACTIONS.has(a?.type)) || { type: ACTIONS.HOLD, reason: 'no_terminal' }
}

/**
 * THE canonical entry. One inbound (the latest of a turn), its bounded context rows, the existing
 * eligibility verdict → one decision record.
 * @param {object} a
 * @param {object} a.input                 buildConversationContext() argument rows (context-loader.js)
 * @param {object|null} [a.deterministic]  the existing classifier verdict
 * @param {object|null} [a.eligibility]    eligibility-bridge.js#dryRunEligibility (guard + timing)
 * @param {object|null} [a.modelClient]    createConversationModelClient(); null ⇒ deterministic only (no text)
 * @param {object|null} [a.spend]          composition spend caps
 * @param {object} [a.negotiationAuthority]
 * @param {boolean} [a.ownerHandled]
 * @param {string|null} [a.establishedPersona]
 * @param {object} [a.companyIdentity]
 * @param {object} [a.deterministicTemplate]
 * @param {string} a.caller                one of CANONICAL_CALLERS
 * @param {string} [a.now]
 */
export async function decideAndCompose({
  input, deterministic = null, eligibility = null, modelClient = null, spend = null,
  negotiationAuthority = createEscalatingNegotiationAuthority(), ownerHandled = false, establishedPersona = null,
  companyIdentity = NO_COMPANY_IDENTITY, deterministicTemplate = { available: false }, personaPolicy = { allow_established_persona: true },
  caller, now = null, maskOpts = null, enabledLanguages = ['en'],
} = {}) {
  if (!CANONICAL_CALLERS.includes(caller)) throw Object.assign(new Error('CANONICAL_CALLER_REQUIRED'), { code: 'CANONICAL_CALLER_REQUIRED' })
  const at = now || input?.now || new Date().toISOString()
  const base = { record_kind: 'conv-ai.canonical-decision', versions: CANONICAL_VERSIONS, caller, inbound_message_id: String(input?.inbound?.id ?? ''), decided_at: at }
  let context
  try {
    context = buildConversationContext({ ...input, eligibility, deterministic, now: at })
    context.multi_property_evidence = multiPropertyEvidence({ inboundText: input.inbound.body, thread: input.thread || [], inbound: input.inbound })
  } catch (err) {
    const code = err instanceof ContextError ? err.code : 'CONTEXT_FAILED'
    const plan = { version: PIPELINE_VERSION, actions: [{ type: ACTIONS.HOLD, reason: `context:${code}` }], reasons: [`context:${code}`] }
    return { ...base, plan, terminal: terminalOf(plan), reply: null, validation: null, judgment: null, model_calls: [], composition: null, ledger_summary: null, eligibility: summarizeEligibility(eligibility), cost_usd: 0 }
  }
  // R1 understanding: an INPUT stage. Its text is discarded here, before anything else sees it.
  const r1 = await understandInbound({ context, inboundText: input.inbound.body, inboundId: input.inbound.id, deterministic, eligibility, modelClient })
  const judgment = r1.decision ? { ...r1.decision, proposed_message: null } : null
  const out = await runConversationPipeline({
    input, deterministic, eligibility, judgment, deterministicTemplate, modelClient, spend, negotiationAuthority, ownerHandled,
    personaPolicy, establishedPersona, companyIdentity, maskOpts: maskOpts || context?.mask || {}, now: at, enabledLanguages,
  })
  let plan = out.plan
  const replyAction = plan.actions.find((a) => a.type === ACTIONS.AI_GENERATED_REPLY) || null
  let validation = null
  let reply = null
  if (replyAction && out.composition?.ok) {
    const previousOutbound = [...(input.thread || [])].filter((m) => m.direction === 'outbound').sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)).pop()?.body || null
    validation = validateOutbound(out.composition.text, {
      ledger: out.ledger, objective: replyAction.objective, category: replyAction.category, inboundIntent: judgment?.intent || null, personaPolicy, establishedPersona,
      companyIdentity, followupScheduled: plan.actions.find((a) => a.type === ACTIONS.SCHEDULE_FOLLOWUP) || replyAction.followup_scheduled || null,
      previousOutbound, knownNumbers: knownNumbersOf(input), firstName: input.names?.first_name || null, eligibility,
      replyLanguage: plan.reply_language === 'es' ? 'es' : 'en',
    })
    if (validation.content_reasons.length) {
      // the composition loop and this check are the same function: a difference is a defect, held
      plan = { ...plan, actions: plan.actions.map((a) => (a === replyAction ? { type: ACTIONS.HOLD, reason: 'final_validation_rejected', evidence: { reasons: validation.content_reasons.slice(0, 8) } } : a)) }
    } else {
      reply = { text: out.composition.text, category: replyAction.category, objective: replyAction.objective, target_property: replyAction.target_property || null, question_kind: validation.question_kind, send_ready: validation.ok, blocked_by: [...validation.eligibility_reasons, ...validation.timing_reasons] }
    }
  }
  const calls = [...(r1.calls || []).map((c) => ({ ...c, stage: 'understand' })), ...((out.composition?.attempts || []).map((c) => ({ ...c, stage: 'compose' })))]
  const cost = calls.reduce((s, c) => s + (Number(c.usd) || 0), 0)
  return {
    ...base,
    plan,
    terminal: terminalOf(plan),
    reply,
    validation: validation ? { status: validation.status, reasons: validation.reasons, content_reasons: validation.content_reasons, eligibility_reasons: validation.eligibility_reasons, timing_reasons: validation.timing_reasons, version: validation.version, style_version: validation.style_version } : null,
    judgment: judgment ? { intent: judgment.intent, seller_interest: judgment.seller_interest, outcome: judgment.outcome, next_objective: judgment.next_objective, confidence: judgment.confidence, escalation_reason: judgment.escalation_reason || null, facts_extracted: judgment.facts_extracted || [], source_message_ids: judgment.source_message_ids || [], contract_version: judgment.contract_version } : null,
    understand_path: r1.trace?.path || null,
    model_calls: calls.map((c) => ({ stage: c.stage, route: c.route || null, model: c.model || null, usd: Number(c.usd) || 0, valid: c.valid ?? null, errors: (c.errors || (c.error ? [c.error] : [])).slice(0, 4), input_tokens: c.usage?.input_tokens ?? null, output_tokens: c.usage?.output_tokens ?? null })),
    composition: out.composition ? { ok: out.composition.ok, reason: out.composition.reason || null, model: out.composition.model || null, route: out.composition.route || null, usd: out.composition.usd ?? 0, usage: out.composition.usage || null, attempts: (out.composition.attempts || []).length,
      // blind-eval reply-rate diagnosis: WHY each attempt was rejected (codes only; never the text)
      attempt_reasons: (out.composition.attempts || []).map((x) => (x.reasons || (x.error ? [String(x.error)] : [])).slice(0, 8)), playbook_version: out.composition.playbook_version || PLAYBOOK_VERSION, prompt_version: out.composition.prompt_version || COMPOSE_PROMPT_VERSION } : null,
    ledger_summary: ledgerSummary(out.ledger),
    eligibility: summarizeEligibility(eligibility),
    company_identity: { configured: Boolean(companyIdentity?.configured), version: companyIdentity?.version || null },
    seller_message_masked: maskText(input.inbound.body, context?.mask || {}).slice(0, 480),
    cost_usd: Math.round(cost * 1e6) / 1e6,
  }
}

function knownNumbersOf(input = {}) {
  return [...new Set((input.thread || []).flatMap((m) => String(m.body || '').match(/[0-9]{3,}/g) || []))]
}

function summarizeEligibility(e) {
  if (!e) return null
  return { blocked: Boolean(e.blocked), reasons: (e.reasons || []).slice(0, 6), guard_reason: e.guard?.reason || null, timing: e.timing ? { lawful: e.timing.lawful, basis: e.timing.basis, certainty: e.timing.certainty || null, next_permitted_at: e.timing.next_permitted_at || null } : null }
}

// ── canonical routine scope (what R3 may send without a person) ─────────────────────────────
// Routine = the decided category of an AI_GENERATED_REPLY, never the model's self-reported
// confidence for deterministic-backed categories (eval #16 / #64 / #102: correct replies held by
// policy_low_confidence). The confidence floor applies only where the MODEL decided the reply
// (clarification). Deterministic blocks are unchanged and evaluated first.
export const ROUTINE_REPLY_CATEGORIES = Object.freeze(['next_missing_fact', 'identity_answer', 'not_interested_close', 'conditional_interest_clarify', 'clarification'])
const FINANCIAL_RE = /\b(?:mortgage|loan|lien|equity|owe|payoff|refinanc\w*|bank|credit|financ\w*|interest\s+rate|taxes?|appraisal|cash\s+offer|proof\s+of\s+funds|closing\s+costs?|commission)\b/i
const LEGAL_CONTRACT_RE = /\b(?:contract|agreement|sign|signature|attorney|lawyer|legal|title\s+company|escrow|deed|probate|court|lawsuit|sue|purchase\s+agreement|binding|earnest)\b/i
const NEGOTIATION_RE = /\b(?:counter|lowest|highest|best\s+(?:offer|price)|meet\s+(?:me\s+)?in\s+the\s+middle|firm|negotiat\w*|come\s+up|go\s+(?:up|higher|lower)|other\s+offers?|another\s+buyer)\b/i
const NEGATED_FINANCING_RE = /\b(?:no|without|not\s+(?:a|any))\s+(?:creative\s+|owner\s+|seller\s+)?financ\w*(?:\s+(?:involved|deal|structure|terms))?\b/gi

/**
 * @param {object} record        decideAndCompose() result
 * @param {{ languageEnglish: boolean, languageReason?: string|null, policy: { categories: string[], min_confidence: number }, inboundText?: string, ledger?: object|null, thread?: Array, inbound?: object|null }} o
 * @returns {{ in_scope: boolean, category: string|null, reasons: string[] }}
 */
export function canonicalRoutineScope(record, { languageEnglish = false, languageReason = null, policy, inboundText = '', ledger = null, thread = [], inbound = null } = {}) {
  const reasons = []
  const term = record?.terminal
  if (!term) return { in_scope: false, category: null, reasons: ['no_decision'] }
  if (term.type === ACTIONS.NO_RESPONSE) return { in_scope: true, category: 'no_response', reasons: [] }
  if (term.type !== ACTIONS.AI_GENERATED_REPLY || !record.reply?.text) return { in_scope: false, category: null, reasons: [`terminal_${String(term.type).toLowerCase()}`] }
  const category = record.reply.category
  const draft = String(record.reply.text)
  const inboundBody = String(inbound?.body ?? inboundText ?? '')
  if (!ROUTINE_REPLY_CATEGORIES.includes(category)) reasons.push('not_a_routine_category')
  else if (!(policy?.categories || []).includes(category)) reasons.push(`category_not_enabled:${category}`)
  if (!languageEnglish) reasons.push(`excluded_language:${languageReason || 'not_english'}`)
  // a clause-resolved mixed answer targets ONE confirmed property (the validator forbids naming any
  // other): not an unresolved multi-property thread
  const mixed = mixedAnswerTarget(ledger?.property?.ownership)
  const s1First = perPropertyObjective(ledger?.property?.ownership, ledger?.next_missing)
  const mixedTarget = (mixed && record.reply.target_property === mixed.property && record.reply.objective === mixed.objective) ||
    (s1First && record.reply.target_property === s1First.property && record.reply.objective === 'ownership')
  if (!mixedTarget && multiPropertyEvidence({ inboundText: inboundBody, ledger, thread, inbound })) reasons.push('excluded_multi_property')
  // OWNER DECISION 2026-10-18: the one in-scope offer turn — THIS inbound asked what we would pay,
  // nothing is on the table, and the reply only asks their number (no amount)
  const askNumberOnce = category === 'next_missing_fact' && record.reply.objective === 'asking_price' && !/[0-9]/.test(draft) &&
    // rc-8.5.21 v3 (RT-11 / RT-05): an offer request in an earlier fragment of THIS burst is this turn's
    (ledger?.offer_requests || []).every((id) => id === (inbound?.id ?? record.inbound_message_id) || (ledger?.open_inbound_ids || []).includes(id)) && !(ledger?.existing_offers || []).length && !(ledger?.outbound_quotes || []).length
  if (((ledger?.offer_requests || []).length && !askNumberOnce) || (ledger?.existing_offers || []).length) reasons.push('excluded_offer_on_thread')
  if ((ledger?.outbound_quotes || []).length) reasons.push('excluded_live_negotiation')
  const draftMoneyFree = draft.replace(NEGATED_FINANCING_RE, ' ')
  if (FINANCIAL_RE.test(draftMoneyFree)) reasons.push('excluded_financial')
  if (category !== 'conditional_interest_clarify' && FINANCIAL_RE.test(inboundBody)) reasons.push('excluded_financial')
  if (LEGAL_CONTRACT_RE.test(draft) || LEGAL_CONTRACT_RE.test(inboundBody)) reasons.push('excluded_legal_or_contract')
  if (NEGOTIATION_RE.test(draft) || NEGOTIATION_RE.test(inboundBody) || (ledger?.objections || []).some((o) => o.kind === 'price_objection')) reasons.push('excluded_negotiation')
  if (category === 'next_missing_fact' && ledger && ledger.next_missing && record.reply.objective !== ledger.next_missing && !mixedTarget && !askNumberOnce) reasons.push(`not_next_missing_fact:${record.reply.objective}`)
  if (category === 'not_interested_close' && /\?/.test(draft)) reasons.push('not_interested_close_must_not_ask')
  // model-decided replies only: the judgment's confidence must clear the policy floor
  if (category === 'clarification' && !(Number(record.judgment?.confidence) >= (policy?.min_confidence ?? 0.85))) reasons.push('low_confidence_model_decided_reply')
  const uniq = [...new Set(reasons)]
  return { in_scope: uniq.length === 0, category, reasons: uniq }
}
