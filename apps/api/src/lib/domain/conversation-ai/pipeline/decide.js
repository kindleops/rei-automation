// DECIDE FIRST, THEN TEXT (8.5.16). Deterministic rules decide suppression, eligibility,
// identity and hard authorisation; the model's judgment (the R1 decision) only covers
// nuance inside what the rules allow. The locked owner policies are applied here and are
// identical for the deterministic and the AI path:
//   STOP / any stop request              → SUPPRESS (cancels queued / scheduled sends; no AI override)
//   "No" to ownership / wrong number     → ownership denied: facts only, NO reply, NO nurture
//   disinterest                          → the existing 30-day follow-up (+ a graceful close)
//   asking price                         → recorded, never re-asked
//   offer request                        → no fabricated offer: the approved next step only
//                                          (PREPARE_OFFER → NegotiationAuthority; stub escalates)
//   ambiguous                            → context, then a useful clarification or review
// The model's validated verdict (confidence ≥ 0.85) is honoured for ownership denial and
// disinterest when the deterministic pre-check does not contradict it.
import { deterministicPrecheck } from '../precheck.js'
import { isStopRequest } from '../stop-request.js'
import { languageVerdict } from '../send-policy.js'
import { ACTIONS, PIPELINE_VERSION, validatePlan } from './outcomes.js'

const FINANCING_RE = /\b(?:owner\s+financ\w*|seller\s+financ\w*|subject[\s-]?to|take\s+over\s+(?:the\s+)?(?:payments|mortgage|loan)|lease\s+option|rent\s+to\s+own|land\s+contract|wrap(?:around)?\s+mortgage|novation)\b/i
const LEGAL_TOPIC_RE = /\b(?:contract|agreement|attorney|lawyer|probate|court|title\s+(?:issue|problem)|lien|deed|divorce|bankrupt\w*|foreclos\w*)\b/i
// rc-8.5.20 (owner persona rule): a seller who asks whether this is automated gets a truthful
// answer from a person; the engine never drafts it (and playbook v2 refuses any denial)
export const AUTOMATION_QUESTION_RE = /\b(?:are\s+(?:you|u)|is\s+(?:this|it|that)|r\s+u|am\s+i\s+(?:talking|texting|chatting)\s+(?:to|with))\s+(?:a\s+|an\s+)?(?:real\s+(?:person|human)|human|person|bot|robot|ai|a\.i\.|automated|computer|machine|auto(?:mated)?\s*(?:text|message|reply)|chat\s*bot|chatgpt|recording)\b|\b(?:bot|robot|automated|ai)\s*\?\s*$/i
const ACK_ONLY_RE = /^\s*(?:ok(?:ay)?|k|thanks?|thank\s+you|thx|ty|got\s+it|cool|sounds\s+good)\s*[.!]*\s*$/i

const newFactsFrom = (ledger, inboundId) => Object.entries(ledger?.facts || {}).filter(([, f]) => (f.source_message_ids || []).includes(inboundId)).map(([k]) => k)

/**
 * @param {object} a
 * @param {object} a.ledger            buildCanonicalLedger() as of this inbound (validated model facts merged)
 * @param {string} a.inboundText
 * @param {string} a.inboundId
 * @param {object|null} a.deterministic  the existing classifier verdict { intent, compliance_flag }
 * @param {object|null} a.eligibility    the existing eligibility verdict { blocked, reasons }
 * @param {object|null} a.judgment      the R1 decision (model nuance), validated
 * @param {{ available: boolean, use_case?: string|null }} [a.deterministicTemplate] the existing template path for this turn
 * @param {boolean} [a.ownerHandled]
 * @param {string|null} [a.language]
 * @param {number} [a.propertyCount]
 */
export function decideActions({ ledger, inboundText = '', inboundId, deterministic = null, eligibility = null, judgment = null, deterministicTemplate = { available: false }, ownerHandled = false, language = null, propertyCount = 1 }) {
  const plan = (actions, reason, extra = {}) => {
    const v = validatePlan(actions)
    if (!v.ok) return { version: PIPELINE_VERSION, actions: [{ type: ACTIONS.HOLD, reason: 'plan_conflict' }], reasons: ['plan_conflict', ...v.reasons], conflict_from: actions.map((a) => a.type) }
    return { version: PIPELINE_VERSION, actions, reasons: [reason], ...extra }
  }
  const facts = newFactsFrom(ledger, inboundId)
  const update = facts.length ? [{ type: ACTIONS.UPDATE_SELLER_FACTS, facts: Object.fromEntries(facts.map((k) => [k, ledger.facts[k].value])), source_message_id: inboundId }] : []

  // 1. stop: ANY stop request (incl. a glued "…STOP 🛑") beats everything, the model included
  if (isStopRequest(inboundText) || ['opt_out', 'stop_texting'].includes(String(deterministic?.intent)) || deterministic?.compliance_flag === 'stop_texting') {
    return plan([{ type: ACTIONS.UPDATE_SELLER_FACTS, facts: { opt_out: 'stop_requested' }, source_message_id: inboundId }, { type: ACTIONS.SUPPRESS, cancel_pending: true, reason: 'stop_request' }], 'stop_request_suppression')
  }
  // 2. the existing deterministic pre-check (legal threat, eligibility, wrong number, hostile, empty)
  const pre = deterministicPrecheck({ text: inboundText, inboundId, deterministic, eligibility })
  if (pre.decided) {
    const o = pre.decision.outcome
    if (o === 'SUPPRESS') return plan([{ type: ACTIONS.SUPPRESS, cancel_pending: true, reason: pre.reason }], `precheck:${pre.reason}`)
    if (o === 'UPDATE_ONLY') return plan([{ type: ACTIONS.UPDATE_SELLER_FACTS, facts: { ownership: 'denied' }, source_message_id: inboundId }, { type: ACTIONS.NO_RESPONSE }], 'ownership_denied_no_nurture')
    if (o === 'NO_RESPONSE') return plan([{ type: ACTIONS.NO_RESPONSE }], `precheck:${pre.reason}`)
    return plan([{ type: ACTIONS.HOLD, reason: pre.reason }], `precheck:${pre.reason}`)
  }
  if (eligibility?.blocked) return plan([{ type: ACTIONS.HOLD, reason: 'eligibility_blocked' }], 'eligibility_blocked')
  if (ownerHandled) return plan([{ type: ACTIONS.HOLD, reason: 'owner_handled_thread' }], 'owner_handled_thread')

  // 3. ownership denial read against the actual previous question ("No" to "do you own it?"),
  //    or the model's validated ownership denial when the deterministic pre-check agrees
  const own = ledger?.facts?.ownership
  const lang = languageVerdict({ language, inboundText })
  const confident = (j) => j && Number(j.confidence) >= 0.85
  const detPositive = ['ownership_confirmed', 'seller_interested', 'interested', 'latent_interest', 'asks_offer'].includes(String(deterministic?.intent))
  const ledgerDenied = own && ['denied', 'former_owner'].includes(own.value) && (own.source_message_ids || []).includes(inboundId)
  const modelDenied = confident(judgment) && !detPositive && (judgment.outcome === 'UPDATE_ONLY' || ['ownership_denied', 'wrong_number'].includes(judgment.intent)) &&
    (['ownership_denied', 'wrong_number'].includes(judgment.intent) || (judgment.facts_extracted || []).some((f) => f.fact === 'ownership' && ['denied', 'former_owner', 'not_owner'].includes(String(f.value)) && f.source_message_id === inboundId))
  if (ledgerDenied || modelDenied) {
    return plan([{ type: ACTIONS.UPDATE_SELLER_FACTS, facts: { ownership: ledgerDenied ? own.value : 'denied' }, source_message_id: inboundId }, { type: ACTIONS.NO_RESPONSE }], ledgerDenied ? 'ownership_denied_no_nurture' : 'ownership_denied_no_nurture:model')
  }

  // 4. disinterest → the existing 30-day follow-up, whatever the language; only the reply text
  //    is language-gated. The model's validated not_interested counts when nothing contradicts it.
  const interest = ledger?.facts?.seller_interest
  const ledgerNotInterested = interest?.value === 'not_interested' && (interest.source_message_ids || []).includes(inboundId)
  const ledgerInterestedNow = interest && interest.value !== 'not_interested' && (interest.source_message_ids || []).includes(inboundId)
  const modelNotInterested = confident(judgment) && judgment.intent === 'not_interested' && !detPositive && !ledgerInterestedNow && !(ledger?.offer_requests || []).includes(inboundId)
  if (ledgerNotInterested || modelNotInterested) {
    const facts = { ...(update[0]?.facts || {}), seller_interest: 'not_interested' }
    const close = deterministicTemplate?.available ? { type: ACTIONS.DETERMINISTIC_REPLY, use_case: deterministicTemplate.use_case || null }
      : lang.english ? { type: ACTIONS.AI_GENERATED_REPLY, category: 'not_interested_close', objective: 'close_no_question', followup_scheduled: { kind: 'nurture_30_day', days: 30 } }
        : { type: ACTIONS.NO_RESPONSE }
    return plan([{ type: ACTIONS.UPDATE_SELLER_FACTS, facts, source_message_id: inboundId }, { type: ACTIONS.SCHEDULE_FOLLOWUP, kind: 'nurture_30_day', days: 30 }, close], ledgerNotInterested ? 'disinterest_30_day_followup' : 'disinterest_30_day_followup:model')
  }

  // 5. language: only English threads get engine text (a missing language with English text is English)
  if (!lang.english) return plan([...update, { type: ACTIONS.ESCALATE_TO_OPERATOR, reason: `language:${lang.reason}` }], 'language_not_enabled')

  // 5b. two stated asking prices far apart: a plain HOLD (no model escalation)
  if (judgment?.escalation_reason === 'contradiction' || judgment?._hold === 'price_contradiction') return plan([...update, { type: ACTIONS.HOLD, reason: 'price_contradiction' }], 'price_contradiction')

  // 6. hard escalations: multiple properties, financing structures, legal topics, the model's own escalation
  if ((Number(propertyCount) || 1) > 1 || ledger?.property?.identity_requested) return plan([...update, { type: ACTIONS.RESEARCH_PROPERTY }, { type: ACTIONS.ESCALATE_TO_OPERATOR, reason: 'multiple_properties_or_property_identity' }], 'multi_property')
  if (FINANCING_RE.test(inboundText)) return plan([...update, { type: ACTIONS.ESCALATE_TO_OPERATOR, reason: 'financing_structure' }], 'financing')
  if (LEGAL_TOPIC_RE.test(inboundText)) return plan([...update, { type: ACTIONS.ESCALATE_TO_OPERATOR, reason: 'legal_or_title_topic' }], 'legal_topic')
  if (judgment?.escalation_required) return plan([...update, { type: ACTIONS.ESCALATE_TO_OPERATOR, reason: `model:${judgment.escalation_reason || 'other'}` }], 'model_escalation')

  // 7. money: an offer request / a counter is the negotiation authority's, never the model's
  const offerRequested = (ledger?.offer_requests || []).includes(inboundId)
  const counter = (ledger?.objections || []).some((o) => o.kind === 'price_objection' && o.source_message_id === inboundId) || judgment?.intent === 'counter_or_negotiation'
  if (counter && (ledger?.existing_offers || []).length) return plan([...update, { type: ACTIONS.NEGOTIATE_WITHIN_AUTHORITY, request: 'counter' }], 'counter_to_offer')
  if (offerRequested) return plan([...update, { type: ACTIONS.PREPARE_OFFER, request: 'offer_request' }], 'offer_request_no_fabricated_offer')
  if (counter) return plan([...update, { type: ACTIONS.ESCALATE_TO_OPERATOR, reason: 'price_objection_without_offer' }], 'price_objection')
  if (ledger?.stage?.stage === 'S5_offer' && !(ledger?.existing_offers || []).length) return plan([...update, { type: ACTIONS.PREPARE_OFFER, request: 'price_and_condition_known' }], 'facts_complete_offer_is_authority_step')

  // 8. need time: the follow-up, no reply needed
  if ((ledger?.objections || []).some((o) => o.kind === 'need_time' && o.source_message_id === inboundId)) return plan([...update, { type: ACTIONS.SCHEDULE_FOLLOWUP, kind: 'need_time', days: 14 }, { type: ACTIONS.NO_RESPONSE }], 'need_time_followup')

  // 8b. "is this a bot / a real person?": a person answers it, truthfully (never a denial)
  if (AUTOMATION_QUESTION_RE.test(String(inboundText || ''))) return plan([...update, { type: ACTIONS.ESCALATE_TO_OPERATOR, reason: 'asked_if_automated' }], 'automation_question_human_answers')

  // 9. who is this: answer truthfully, then the open stage question (once)
  if ((ledger?.requests || []).some((r) => r.kind === 'identity' && r.source_message_id === inboundId)) return plan([...update, { type: ACTIONS.AI_GENERATED_REPLY, category: 'identity_answer', objective: ledger?.next_missing || 'none' }], 'identity_question')

  // 10. the next missing fact (S1–S4). A simple turn with an existing template stays deterministic.
  if (ledger?.next_missing) {
    const simple = facts.length <= 1 && String(inboundText).trim().length <= 40 && !/\?/.test(inboundText)
    if (simple && deterministicTemplate?.available) return plan([...update, { type: ACTIONS.DETERMINISTIC_REPLY, use_case: deterministicTemplate.use_case || null }], 'simple_turn_existing_template')
    if (facts.length || /\?/.test(inboundText) || !ACK_ONLY_RE.test(inboundText)) {
      if (!facts.length && !(judgment && judgment.outcome === 'REPLY_CANDIDATE' && judgment.confidence >= 0.85)) {
        // nothing recognised and no confident judgment: ambiguous, review it
        return plan([{ type: ACTIONS.HOLD, reason: 'ambiguous_needs_review' }], 'ambiguous')
      }
      return plan([...update, { type: ACTIONS.AI_GENERATED_REPLY, category: facts.length ? 'next_missing_fact' : 'clarification', objective: ledger.next_missing }], 'next_missing_fact')
    }
  }
  if (ACK_ONLY_RE.test(inboundText)) return plan([...update, { type: ACTIONS.NO_RESPONSE }], 'acknowledgement_only')
  return plan([...update, { type: ACTIONS.HOLD, reason: 'no_safe_next_step' }], 'no_safe_next_step')
}
