// R1 UNDERSTANDING — orchestration (SHADOW ONLY).
//
//   1. deterministic pre-check (STOP / opt-out / legal / eligibility / wrong number)
//      → decided ⇒ NO model call
//   2. Haiku (default route): forced-tool structured decision → strict validation
//   3. escalate to Sonnet when: the decision asks for it, it is invalid, it
//      contradicts the deterministic ledger, or the context shows multiple
//      properties / owners, financing, nonstandard deals, complex negotiation
//   4. Sonnet output is validated the same way; Sonnet gains NO send authority
//      (ESCALATE_TO_SONNET from Sonnet ⇒ NEEDS_REVIEW)
//   5. anything still invalid ⇒ fail closed to NEEDS_REVIEW
//
// THE ESCALATION POLICY (merged in rc-8.5.20 from 8.5.15 + 8.5.16; kept as is — review item e;
// tests: conversation-ai-escalation-policy.test.mjs, conversation-ai-r1r2.test.mjs):
//   REPAIR  an invalid Haiku answer gets ONE Haiku repair that is shown its validation errors
//           (8.5.16). Repair valid ⇒ that decision continues; repair invalid ⇒ fail closed to
//           NEEDS_REVIEW. Sonnet is never asked to fix an invalid answer (no candidate to improve).
//   HOLD    a turn a human handles anyway is NOT sent to Sonnet: multiple properties / owners,
//           financing, nonstandard deal, legal, complex negotiation with an offer on record, a
//           non-English inbound or an offer request ("what's your offer?"). A REPLY_CANDIDATE on such
//           a turn loses its draft and becomes NEEDS_REVIEW with escalation_required + the reason;
//           a Haiku ESCALATE_TO_SONNET becomes NEEDS_REVIEW. Two seller asking prices more than 1.5×
//           apart are a deterministic contradiction HOLD (escalation_reason 'contradiction').
//   SONNET  only a Haiku REPLY_CANDIDATE with a remaining reason (the model's own escalation, a
//           contradiction with the deterministic ledger) on a turn that is not human-bound. Sonnet
//           gains no authority: its ESCALATE and any remaining ledger contradiction ⇒ NEEDS_REVIEW.
//   The deterministic pre-check (stop, legal, eligibility, ownership denial, hostile) runs before
//   all of it and is never overridden. Spend: every call reserves on the runtime job first.
import { DECISION_JSON_SCHEMA, failClosedDecision, validateDecision } from './contract.js'
import { deterministicPrecheck } from './precheck.js'
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts.js'
import { isDeflectionToOffer } from './questions.js'

const NON_ENGLISH_RE = /[¿¡ñáéíóú]|\b(?:hola|gracias|vender|casa|propiedad|usted|due[nñ]o|oferta|precio)\b/i

export const UNDERSTAND_VERSION = 'conv-ai.understand.v2'

const FINANCING_RE = /\b(?:owner\s+financ\w*|seller\s+financ\w*|subject[\s-]?to|take\s+over\s+(?:the\s+)?(?:payments|mortgage|loan)|lease\s+option|rent\s+to\s+own|land\s+contract|wrap(?:around)?\s+mortgage|terms|monthly\s+payments|novation)\b/i
const MULTI_PROPERTY_RE = /\b(?:(?:both|all|several|multiple|two|three|other)\s+(?:of\s+(?:my|the)\s+)?(?:properties|houses|homes|lots|units|addresses)|i\s+(?:own|have)\s+(?:a\s+few|several|multiple|[0-9]+)\s+(?:properties|houses|homes)|which\s+(?:property|house|one))\b/i
const MULTI_OWNER_RE = /\b(?:my\s+(?:brother|sister|siblings|wife|husband|partner|ex|mom|mother|dad|father)\s+(?:and\s+i\s+)?(?:own|co-?own|is\s+on\s+the\s+title)|co-?owner|joint(?:ly)?\s+owned|on\s+the\s+(?:title|deed)\s+with|have\s+to\s+(?:ask|talk\s+to|check\s+with)\s+my\s+(?:wife|husband|partner|brother|sister|family))\b/i
const NEGOTIATION_RE = /\b(?:counter|lowest\s+(?:i|we)\s+(?:would|will|can)|best\s+(?:you\s+can|offer)|come\s+up|meet\s+(?:me\s+)?in\s+the\s+middle|firm\s+(?:on|at)|bottom\s+line|other\s+offers?|another\s+(?:buyer|offer))\b/i

/** Context-level escalation triggers (deterministic; the model can add its own). */
export function escalationTriggers({ inboundText = '', context }) {
  const t = String(inboundText)
  const out = []
  // rc-8.5.21 (Phase 3D): thread events carrying several property ids are not evidence of a
  // multi-property conversation (eval #29: single-property threads escalated); seller text is
  if (MULTI_PROPERTY_RE.test(t) || context?.multi_property_evidence) out.push('multiple_properties')
  if (MULTI_OWNER_RE.test(t)) out.push('multiple_owners')
  if (FINANCING_RE.test(t)) out.push('financing')
  if (NEGOTIATION_RE.test(t) && (context?.offers?.length || 0) > 0) out.push('complex_negotiation')
  const hist = context?.model?.asking_price_history || []
  const amounts = [...new Set(hist.map((h) => h.amount).filter(Boolean))]
  if (amounts.length >= 2) {
    const lo = Math.min(...amounts); const hi = Math.max(...amounts)
    if (hi / lo > 1.5) out.push('contradiction')
  }
  return out
}

/** A decision that contradicts what the deterministic ledger already proves. */
export function contradictsLedger(decision, context) {
  const issues = []
  const facts = context?.facts || {}
  if (facts.asking_price?.current && decision.next_objective === 'get_asking_price') issues.push('asks_known_asking_price')
  if (context?.ledger?.asking_price?.deflected && decision.next_objective === 'get_asking_price') issues.push('asks_price_after_deflection')
  if (facts.condition?.current && decision.next_objective === 'get_condition') issues.push('asks_known_condition')
  if (facts.ownership?.current?.value === 'confirmed' && decision.next_objective === 'confirm_ownership') issues.push('asks_known_ownership')
  return issues
}

/**
 * @param {object} a
 * @param {object} a.context          buildConversationContext() result
 * @param {string} a.inboundText      raw current inbound (pre-check reads the real text)
 * @param {string} a.inboundId
 * @param {object|null} a.deterministic  existing classifier result ({ intent, compliance_flag, confidence })
 * @param {object|null} a.eligibility    existing eligibility verdict ({ blocked, reasons })
 * @param {{ decide: Function }|null} a.modelClient  createConversationModelClient(); null ⇒ deterministic-only
 * @param {{ escalate?: boolean }} [a.options]
 */
export async function understandInbound({ context, inboundText, inboundId, deterministic = null, eligibility = null, modelClient = null, options = {} }) {
  const calls = []
  const trace = { version: UNDERSTAND_VERSION, path: null, escalation_triggers: [], contradictions: [], errors: [] }
  const pre = deterministicPrecheck({ text: inboundText, inboundId, deterministic, eligibility, lastQuestionKind: context?.last_question_kind ?? context?.model?.last_question_kind ?? null, ownershipAmbiguous: context?.ownership_ambiguous === true })
  trace.precheck = pre.signals
  if (pre.decided) {
    trace.path = 'deterministic_precheck'
    return { decision: pre.decision, calls, trace }
  }
  if (!modelClient) {
    trace.path = 'no_model'
    return { decision: failClosedDecision({ errors: ['model_unavailable'], sourceMessageIds: [inboundId], producedBy: 'no_model' }), calls, trace }
  }
  const ids = { messageIds: context.message_ids, inboundMessageIds: context.inbound_ids }
  const triggers = escalationTriggers({ inboundText, context })
  trace.escalation_triggers = triggers

  const run = async (route, priorAttempt = null) => {
    try {
      const r = await modelClient.decide({ route, system: SYSTEM_PROMPT, user: buildUserPrompt(context.model, { escalation: route === 'escalation', priorAttempt }), inputSchema: DECISION_JSON_SCHEMA })
      const v = r.input ? validateDecision(r.input, ids) : { ok: false, errors: ['no_tool_output'] }
      calls.push({ route, model: r.model, usd: r.usd, usd_is_actual: r.usd_is_actual, latency_ms: r.latency_ms, usage: r.usage, stop_reason: r.stop_reason, valid: v.ok, errors: v.ok ? [] : v.errors.slice(0, 10) })
      return { v, raw: r.input }
    } catch (err) {
      // a job-level stop (the runtime's budget refusal, cancel, deadline) is never swallowed
      if (err?.abortJob === true) throw err
      calls.push({ route, model: null, usd: 0, latency_ms: 0, usage: null, valid: false, errors: [err?.code || 'MODEL_CALL_FAILED'] })
      trace.errors.push(err?.code || 'MODEL_CALL_FAILED')
      return { v: { ok: false, errors: [err?.code || 'MODEL_CALL_FAILED'] }, raw: null, refused: true }
    }
  }

  // RC 8.5.15 escalation policy (eval: Sonnet was 84% of spend and fixed no
  // next action): an invalid Haiku answer is retried ONCE on Haiku; Sonnet is
  // consulted only when a REPLY_CANDIDATE is on the table and a trigger could
  // change it. A Haiku ESCALATE_TO_SONNET without a candidate is a human item.
  // RC 8.5.16 eval (merged in 8.5.20): the one Haiku retry is a REPAIR that sees
  // the validation errors. A repair that also fails closes to NEEDS_REVIEW (no
  // Sonnet — there is no candidate to improve).
  let first = await run('default')
  if (!first.v.ok && !first.refused && options.repair !== false) {
    trace.default_retry = true
    const repair = await run('default', { invalid: (first.v.errors || []).slice(0, 8) })
    trace.repair = { attempted: true, ok: repair.v.ok }
    if (repair.v.ok || repair.refused) first = repair
  }
  let decision = first.v.ok ? first.v.decision : null
  const why = []
  if (decision?.escalation_required) why.push(decision.escalation_reason || 'other')
  for (const t of triggers) why.push(t)
  if (decision) {
    const c = contradictsLedger(decision, context)
    trace.contradictions = c
    if (c.length) why.push('contradiction')
  }
  const candidate = decision?.outcome === 'REPLY_CANDIDATE'
  // 8.5.16 eval: Sonnet only when it can change the outcome. A turn the pipeline hands to a
  // human anyway (multi-property / multi-owner / financing / negotiation with an offer, a
  // non-English thread, an offer request) is NOT escalated; two far-apart asking prices are a
  // deterministic HOLD (decide.js), not a Sonnet call.
  const HUMAN_BOUND = new Set(['multiple_properties', 'multiple_owners', 'financing', 'complex_negotiation', 'nonstandard_deal', 'legal'])
  const humanBound = why.some((w) => HUMAN_BOUND.has(w)) || isDeflectionToOffer(inboundText) || NON_ENGLISH_RE.test(String(inboundText || ''))
  const priceContradiction = triggers.includes('contradiction')
  if (priceContradiction || humanBound) {
    trace.escalation_skipped = priceContradiction ? 'price_contradiction_hold' : 'human_bound'
    trace.escalation_reasons = [...new Set(why)]
    if (decision) {
      trace.path = trace.default_retry ? 'haiku(retry)' : 'haiku'
      if (decision.outcome === 'ESCALATE_TO_SONNET') {
        trace.escalation_withheld = [...new Set(why)]
        decision = { ...decision, outcome: 'NEEDS_REVIEW', proposed_message: null }
      }
      if (priceContradiction) decision = { ...decision, outcome: 'NEEDS_REVIEW', proposed_message: null, escalation_required: true, escalation_reason: 'contradiction' }
      else if (!decision.escalation_required && why.some((w) => HUMAN_BOUND.has(w))) decision = { ...decision, escalation_required: true, escalation_reason: why.find((w) => HUMAN_BOUND.has(w)) }
      // RC 8.5.20 (8.5.15 + 8.5.16): a candidate that must go to a human keeps no draft — the
      // pipeline escalates it to an operator (decide.js) and the shadow records a hold
      if (decision.outcome === 'REPLY_CANDIDATE' && decision.escalation_required) {
        trace.escalation_withheld = [...new Set(why)]
        decision = { ...decision, outcome: 'NEEDS_REVIEW', proposed_message: null }
      }
      return { decision, calls, trace }
    }
  }
  const shouldEscalate = options.escalate !== false && candidate && why.length > 0 && !first.refused && !priceContradiction && !humanBound
  if (shouldEscalate) {
    trace.escalation_reasons = [...new Set(why)]
    const second = await run('escalation', { intent: decision.intent, outcome: decision.outcome, next_objective: decision.next_objective, escalation_reason: decision.escalation_reason })
    if (second.v.ok) {
      decision = second.v.decision
      // Sonnet gains no authority: it cannot escalate further or keep a contradiction
      if (decision.outcome === 'ESCALATE_TO_SONNET') decision = { ...decision, outcome: 'NEEDS_REVIEW', proposed_message: null, response_needed: decision.response_needed }
      const c2 = contradictsLedger(decision, context)
      if (c2.length) { trace.contradictions_after_escalation = c2; decision = { ...decision, outcome: 'NEEDS_REVIEW', proposed_message: null } }
      trace.path = 'haiku→sonnet'
    } else {
      trace.path = 'haiku→sonnet(invalid)'
      decision = failClosedDecision({ errors: second.v.errors, sourceMessageIds: [inboundId], producedBy: 'escalation', raw: second.raw })
    }
  } else if (!decision) {
    trace.path = first.refused ? 'haiku(refused)' : 'haiku(invalid)'
    decision = failClosedDecision({ errors: first.v.errors, sourceMessageIds: [inboundId], producedBy: 'default', raw: first.raw })
  } else {
    trace.path = trace.default_retry ? 'haiku(retry)' : 'haiku'
    if (decision.outcome === 'ESCALATE_TO_SONNET') {
      trace.escalation_withheld = [...new Set(why)]
      decision = { ...decision, outcome: 'NEEDS_REVIEW', proposed_message: null }
    } else if (candidate && why.length) {
      // a candidate that would have escalated (triggers present) but escalation is off
      trace.escalation_withheld = [...new Set(why)]
    }
  }
  // the model never overrides the deterministic pre-check: re-assert on the final decision
  return { decision, calls, trace }
}
