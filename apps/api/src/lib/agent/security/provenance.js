// Trust labels + intent binding (architecture §3.5, §6) — the structural
// prompt-injection defense. These are server rules, not prompt rules.
//
//  * Only operator-authored messages, operator-approved plans and the frozen
//    system policy are instructions. Every tool result is `untrusted` content.
//  * A turn's intent can only be created from an operator-channel message.
//    Content (SMS, notes, web/research text, tool output) can never create,
//    widen or satisfy an intent, and never reaches the intent classifier.
//  * A T2 call is intent-bound iff it traces to (a) the turn intent with
//    targets inside the attached context / explicit operator references, or
//    (b) an approved plan step. Copying an untrusted string into an
//    action-selecting field (stage, status, recipients, campaign id…) loses
//    intent binding → the call becomes an approval card.
//  * T3 is never intent-bound: it always needs a human approval click.
import { AgentError } from '../runtime/store.js'
import { hashCanonical } from '../runtime/canonical.js'

export const TRUST = Object.freeze({ OPERATOR: 'operator', PLAN: 'plan', SYSTEM: 'system', UNTRUSTED: 'untrusted' })

// Module-private registry: copies (spread, JSON, structuredClone) are NOT branded.
const OPERATOR_MESSAGES = new WeakSet()

/**
 * Brand an operator message. Only the authenticated operator HTTP route may
 * call this (it is never passed to tools or model output handlers).
 */
export function operatorMessage({ text, operator_id, client_msg_id = null }) {
  if (!operator_id) throw new AgentError('OPERATOR_REQUIRED', 'operator messages are attributed')
  const msg = Object.freeze({ channel: 'operator', text: String(text ?? ''), operator_id, client_msg_id })
  OPERATOR_MESSAGES.add(msg)
  return msg
}

export function isOperatorMessage(msg) {
  return Boolean(msg && typeof msg === 'object' && OPERATOR_MESSAGES.has(msg))
}

/** Intent classes → tool families they may authorize (T2 auto only inside these). */
export const INTENT_CLASS_TOOL_FAMILIES = Object.freeze({
  lookup: [],
  navigate: ['ui'],
  draft: ['ui', 'artifact'],
  pipeline_update: ['pipeline'],
  inbox_visibility: ['inbox_visibility'],
  campaign_draft: ['campaign_draft'],
  research: ['research'],
})

const MIN_SPAN = 4

function norm(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Per-turn provenance context.
 * @param {{ message: object, intent_class: string, attached_refs?: string[], approved_plan?: { plan_hash: string, steps: Array<{ family: string, target_refs: string[] }> } | null }} input
 */
export function createTurnContext({ message, intent_class, attached_refs = [], approved_plan = null } = {}) {
  if (!isOperatorMessage(message)) {
    throw new AgentError('UNTRUSTED_INTENT_SOURCE', 'a turn intent can only come from an operator-authored message')
  }
  if (!Object.prototype.hasOwnProperty.call(INTENT_CLASS_TOOL_FAMILIES, intent_class)) {
    throw new AgentError('INTENT_CLASS_UNKNOWN', String(intent_class))
  }
  const untrusted = []
  const explicitRefs = new Set((String(message.text).match(/\b[a-z_]+:[A-Za-z0-9_-]+\b/g) || []))
  return {
    message,
    intent_class,
    attached_refs: new Set(attached_refs),
    explicit_refs: explicitRefs,
    approved_plan,
    /** Record untrusted content seen this turn (tool results, inbound text, documents). */
    recordUntrusted(text, source = 'tool_result') {
      const t = norm(text)
      if (t.length >= MIN_SPAN) untrusted.push({ text: t, source })
    },
    untrustedSpans() {
      return untrusted.slice()
    },
  }
}

/** Wrap a tool result as untrusted content and record it into the turn. */
export function wrapToolResult({ tool, result, source = 'tool_result', ref = null, turn = null }) {
  if (turn) {
    const walk = (v, depth = 0) => {
      if (depth > 6 || v == null) return
      if (typeof v === 'string') turn.recordUntrusted(v, `${tool}:${source}`)
      else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1))
      else if (typeof v === 'object') Object.values(v).forEach((x) => walk(x, depth + 1))
    }
    walk(result)
  }
  return Object.freeze({ trust: TRUST.UNTRUSTED, tool, source, ref, content: result })
}

/** Does `value` appear inside untrusted content while NOT authored by the operator? */
export function untrustedOverlap(value, turn) {
  const v = norm(value)
  if (v.length < MIN_SPAN) return false
  const operatorText = norm(turn.message.text)
  if (operatorText.includes(v)) return false
  return turn.untrustedSpans().some((s) => s.text.includes(v) || (v.length >= 12 && v.includes(s.text)))
}

/**
 * Intent-binding decision for a T2 call.
 * @returns {{ bound: boolean, basis: 'turn'|'plan'|'none', reason: string|null, untrusted_span_overlap: boolean }}
 */
export function checkIntentBinding({ spec, input, target_refs = [], turn }) {
  if (!turn || !isOperatorMessage(turn.message)) return { bound: false, basis: 'none', reason: 'NO_OPERATOR_TURN', untrusted_span_overlap: false }
  const actionFields = spec.action_fields || []
  const overlap = actionFields.some((f) => {
    const v = input?.[f]
    if (Array.isArray(v)) return v.some((x) => untrustedOverlap(x, turn))
    return v != null && untrustedOverlap(v, turn)
  })
  if (overlap) return { bound: false, basis: 'none', reason: 'UNTRUSTED_SPAN_IN_ACTION_FIELD', untrusted_span_overlap: true }

  const family = spec.intent_family
  const inScope = (refs) => target_refs.every((r) => refs.has(r))
  const allowedFamilies = INTENT_CLASS_TOOL_FAMILIES[turn.intent_class] || []
  if (family && allowedFamilies.includes(family)) {
    const refs = new Set([...turn.attached_refs, ...turn.explicit_refs])
    if (inScope(refs)) return { bound: true, basis: 'turn', reason: null, untrusted_span_overlap: false }
  }
  const plan = turn.approved_plan
  if (plan?.plan_hash && Array.isArray(plan.steps)) {
    const step = plan.steps.find((s) => s.family === family && target_refs.every((r) => (s.target_refs || []).includes(r)))
    if (step) return { bound: true, basis: 'plan', reason: null, untrusted_span_overlap: false }
  }
  return { bound: false, basis: 'none', reason: 'NOT_INTENT_BOUND', untrusted_span_overlap: false }
}

export function planHash(plan) {
  return hashCanonical({ steps: plan.steps })
}
