// DETERMINISTIC PRE-CHECK — runs BEFORE any model call; the model never overrides it.
//
// Authority stays with the existing deterministic engine. This module only READS
// its verdicts (the classifier result, the existing STOP / opt-out matchers, the
// pre-send eligibility verdict) and maps them onto the R1 contract:
//
//   STOP / opt-out (any registry language, outreach-stop scope) → SUPPRESS, no model call
//   legal threat / hostile-legal                                → SUPPRESS, no model call
//   eligibility blocked (suppressed / DNC / opted out)          → SUPPRESS, no model call
//   wrong number / not the owner (deterministic)                → UPDATE_ONLY, no model call
//   empty body (media-only)                                      → NEEDS_REVIEW, no model call
//   POSSIBLE opt-out (a stop / remove / contact-negation family token in a
//   non-English message, no confident family; P0 2026-10-19)        → NEEDS_REVIEW, no model call
//     (the classifier path writes the precautionary contact-wide hold)
//
// "stop calling, text me" (stop_other_action scope) is NOT an opt-out: it passes
// to the model, and the AI policy lists it as a never-auto category anyway.
import { matchMultilingualOptOut } from '../classification/multilingual-opt-out.js'
import { analyzeContactRevocation } from '../classification/multilingual-contact-revocation.js'
import { classifyStopScope, STOP_SCOPE } from '../classification/stop-scope.js'
import { bareNoAnswer } from './answers.js'
import { makeDecision } from './contract.js'
import { ABSOLUTE_SUPPRESSION_REASONS } from './ownership-evidence.js'

export const PRECHECK_VERSION = 'conv-ai.precheck.v3'

const BARE_STOP_RE = /^\s*(?:stop|stopall|stop\s*all|unsubscribe|cancel|end|quit|remove\s+me|opt\s*out|parar|alto|basta)\s*[.!]*\s*$/i
// classifyStopScope only judges the SCOPE of a stop; it is not a stop detector
// ("número equivocado" names a number). A stop verb / phrase must be present first.
// Unicode word edges (P0 2026-10-19): with ASCII \b the Spanish "Quité" read as the English "quit".
const STOP_VERB_RE = /(?<![\p{L}\p{N}])(?:stop|stp|quit|cease|unsubscribe|remove\s+(?:me|my)|take\s+me\s+off|lose\s+my\s+number|leave\s+me\s+alone|do\s*n[o']?t\s+(?:text|contact|call|message|msg|email|bother)|no\s+more\s+(?:texts?|messages?|calls?)|para\s+de|deja\s+de|no\s+me\s+(?:escriba|escribas|mande|mandes|contacte|contactes|llame|llames|moleste|molestes))(?![\p{L}\p{N}])/iu
const LEGAL_RE = /\b(?:attorney|lawyer|lawsuit|sue\s+(?:you|u)|suing|cease\s+and\s+desist|tcpa|harass(?:ment|ing)?|report(?:ing)?\s+(?:you|this)\s+to|fcc|ftc|attorney\s+general|police)\b/i

const SUPPRESS_INTENTS = new Set(['opt_out', 'stop_texting'])
// insults / hostility without a stop or a legal threat never suppress (owner 10-06):
// no reply, no model call
const NO_RESPONSE_INTENTS = new Set(['hostile_or_legal', 'hostile_or_troll'])
const UPDATE_ONLY_INTENTS = new Set(['wrong_number'])

/**
 * @param {{ text: string, inboundId: string, deterministic?: { intent?: string|null, compliance_flag?: string|null }|null, eligibility?: { blocked: boolean, reasons?: string[] }|null }} a
 * @returns {{ decided: boolean, decision?: object, reason?: string, signals: object }}
 */
// RC 8.5.15 (owner 2026-10-14): ownership denied -> UPDATE_ONLY, no nurture,
// no further ownership question, no model call. The classifier (which reads the
// reply against our last question) names it property_specific_non_owner; the
// pre-check also reads a bare "No" against our last question itself.
const OWNERSHIP_DENIED_INTENTS = new Set(['property_specific_non_owner', 'ownership_denied'])

export function deterministicPrecheck({ text, inboundId, deterministic = null, eligibility = null, lastQuestionKind = null, ownershipAmbiguous = false }) {
  const body = String(text ?? '')
  const scope = classifyStopScope(body)
  const revocation = analyzeContactRevocation(body)
  const signals = {
    precheck_version: PRECHECK_VERSION,
    bare_stop: BARE_STOP_RE.test(body),
    multilingual_opt_out: matchMultilingualOptOut(body)?.rule_id || null,
    possible_opt_out: revocation.possible_opt_out?.rule_id || null,
    multilingual_wrong_number: revocation.wrong_number?.rule_id || null,
    stop_verb: STOP_VERB_RE.test(body),
    stop_scope: scope,
    legal: LEGAL_RE.test(body),
    deterministic_intent: deterministic?.intent ?? null,
    compliance_flag: deterministic?.compliance_flag ?? null,
    eligibility_blocked: eligibility ? Boolean(eligibility.blocked) : null,
  }
  const src = [String(inboundId)]
  const suppress = (reason, intent = 'opt_out') => ({
    decided: true, reason, signals,
    decision: makeDecision({ intent, seller_interest: 'unknown', outcome: 'SUPPRESS', next_objective: 'none', response_needed: false, confidence: 1, source_message_ids: src, stage_evidence: { stage: 'closed', evidence_message_ids: src, rationale: `deterministic pre-check: ${reason}` } }),
  })
  const otherAction = scope === STOP_SCOPE.OTHER_ACTION
  // a multilingual revocation names a communication / list / our-outreach object, so it wins over
  // an other-action stop scope exactly as in classify() ("Dejen de preguntarme por la casa")
  if (signals.multilingual_opt_out || (!otherAction && (signals.bare_stop || (signals.stop_verb && scope === STOP_SCOPE.COMMUNICATION)))) return suppress('stop_or_opt_out')
  if (signals.compliance_flag === 'stop_texting' && !otherAction) return suppress('classifier_stop_texting')
  if (SUPPRESS_INTENTS.has(String(signals.deterministic_intent)) && !otherAction) return suppress(`classifier_${signals.deterministic_intent}`)
  if (signals.legal) return suppress('legal_language', 'hostile_or_legal')
  // fail-safe (P0 2026-10-19): never "unclear and contactable" — a person decides; no model call
  if (signals.possible_opt_out && !otherAction && !UPDATE_ONLY_INTENTS.has(String(signals.deterministic_intent)) && !OWNERSHIP_DENIED_INTENTS.has(String(signals.deterministic_intent))) {
    return { decided: true, reason: 'possible_opt_out_unconfirmed', signals, decision: makeDecision({ outcome: 'NEEDS_REVIEW', response_needed: false, confidence: 1, source_message_ids: src, stage_evidence: { stage: 'unknown', evidence_message_ids: src, rationale: 'deterministic pre-check: possible opt-out in a non-English message — precautionary hold, a person decides' } }) }
  }
  // rc-8.5.21 (Phase 3B, eval #41): only a VALID suppression state suppresses. A stored not-owner
  // label (prior_reply_not_owner) or an unreadable guard is resolved against the thread's own
  // evidence (ownership-evidence.js) — never a global SUPPRESS, never a cancel of pending sends.
  if (eligibility?.blocked) {
    const r = String(eligibility.guard?.reason || (eligibility.reasons || ['blocked'])[0])
    if (ABSOLUTE_SUPPRESSION_REASONS.has(r)) return suppress(`eligibility:${r}`, 'unclear')
    if (r === 'wrong_number') {
      return { decided: true, reason: 'eligibility:wrong_number', signals, decision: makeDecision({ intent: 'wrong_number', seller_interest: 'unknown', outcome: 'UPDATE_ONLY', next_objective: 'none', response_needed: false, confidence: 1, source_message_ids: src, stage_evidence: { stage: 'closed', evidence_message_ids: src, rationale: 'deterministic pre-check: wrong number on record (no owner outreach)' } }) }
    }
    return { decided: true, reason: `eligibility:${r}`, signals, decision: makeDecision({ outcome: 'NEEDS_REVIEW', confidence: 1, source_message_ids: src, stage_evidence: { stage: 'unknown', evidence_message_ids: src, rationale: `deterministic pre-check: eligibility ${r} is resolved by ownership evidence, not by the model` } }) }
  }
  if (NO_RESPONSE_INTENTS.has(String(signals.deterministic_intent))) {
    return {
      decided: true, reason: 'hostile_no_reply', signals,
      decision: makeDecision({ intent: 'hostile_or_legal', seller_interest: 'not_interested', outcome: 'NO_RESPONSE', next_objective: 'none', response_needed: false, confidence: 1, source_message_ids: src, stage_evidence: { stage: 'nurture', evidence_message_ids: src, rationale: 'deterministic pre-check: hostile without stop or legal threat — no reply, not suppressed' } }),
    }
  }
  // rc-8.5.20: the ONE shared bare-No matcher (answers.js), also used by the fact ledger
  const bareOwnershipDenial = lastQuestionKind === 'ownership' && bareNoAnswer(body).ownership_denial
  // rc-8.5.21 P0: a denial after ownership questions about SEVERAL properties (separate messages and
  // follow-up fragments included) is never a property denial: it is resolved by a person (the thread hold)
  if (ownershipAmbiguous === true && (OWNERSHIP_DENIED_INTENTS.has(String(signals.deterministic_intent)) || bareOwnershipDenial || bareNoAnswer(body).matched)) {
    return {
      decided: true, reason: 'ownership_attribution_unresolved', signals: { ...signals, last_question_kind: lastQuestionKind, ownership_ambiguous: true },
      decision: makeDecision({ outcome: 'NEEDS_REVIEW', confidence: 1, source_message_ids: src, stage_evidence: { stage: 'unknown', evidence_message_ids: src, rationale: 'deterministic pre-check: one answer to ownership questions about several properties — which property is unresolved (thread hold, a person decides)' } }),
    }
  }
  if (OWNERSHIP_DENIED_INTENTS.has(String(signals.deterministic_intent)) || bareOwnershipDenial) {
    return {
      decided: true, reason: 'ownership_denied', signals: { ...signals, last_question_kind: lastQuestionKind, bare_no_after_ownership: bareOwnershipDenial },
      decision: makeDecision({ intent: 'ownership_denied', seller_interest: 'unknown', outcome: 'UPDATE_ONLY', next_objective: 'none', response_needed: false, confidence: 1, source_message_ids: src, facts_extracted: [{ fact: 'ownership', value: 'denied', source_message_id: src[0], confidence: 1 }], stage_evidence: { stage: 'closed', evidence_message_ids: src, rationale: 'deterministic pre-check: ownership denied for this property (no nurture, no further ownership question, not suppressed)' } }),
    }
  }
  if (UPDATE_ONLY_INTENTS.has(String(signals.deterministic_intent))) {
    return {
      decided: true, reason: 'wrong_number', signals,
      decision: makeDecision({ intent: 'wrong_number', seller_interest: 'unknown', outcome: 'UPDATE_ONLY', next_objective: 'none', response_needed: false, confidence: 1, source_message_ids: src, facts_extracted: [{ fact: 'ownership', value: 'denied', source_message_id: src[0], confidence: 1 }], stage_evidence: { stage: 'closed', evidence_message_ids: src, rationale: 'deterministic pre-check: wrong number' } }),
    }
  }
  if (!body.trim()) {
    return { decided: true, reason: 'empty_body', signals, decision: makeDecision({ outcome: 'NEEDS_REVIEW', confidence: 1, source_message_ids: src, stage_evidence: { stage: 'unknown', evidence_message_ids: [], rationale: 'empty or media-only message' } }) }
  }
  return { decided: false, signals }
}
