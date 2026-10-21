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
import { acceptsOurProposal } from '../acceptance.js'
import { deterministicPrecheck } from '../precheck.js'
import { isStopRequest } from '../stop-request.js'
import { languageEnabledFor, languageVerdict } from '../send-policy.js'
import { ACTIONS, PIPELINE_VERSION, validatePlan } from './outcomes.js'
import { ownershipDenialTerminal, resolveOwnershipEvidence } from '../ownership-evidence.js'
import { mixedAnswerTarget } from '../property-ownership.js'
import { escalation, mapModelEscalation, multiOwnerEvidence, multiPropertyEvidence } from '../escalation-evidence.js'
import { FINANCING_OBJECTION_RE } from '../fact-ledger.js'
import { NO_COMPANY_IDENTITY } from '../company-identity.js'

const FINANCING_RE = /\b(?:owner\s+financ\w*|seller\s+financ\w*|subject[\s-]?to|take\s+over\s+(?:the\s+)?(?:payments|mortgage|loan)|lease\s+option|rent\s+to\s+own|land\s+contract|wrap(?:around)?\s+mortgage|novation)\b/i
const LEGAL_TOPIC_RE = /\b(?:contract|agreement|attorney|lawyer|probate|court|title\s+(?:issue|problem)|lien|deed|divorce|bankrupt\w*|foreclos\w*)\b/i
// rc-8.5.20 (owner persona rule): a seller who asks whether this is automated gets a truthful
// answer from a person; the engine never drafts it (and playbook v2 refuses any denial)
export const AUTOMATION_QUESTION_RE = /\b(?:are\s+(?:you|u)|is\s+(?:this|it|that)|r\s+u|am\s+i\s+(?:talking|texting|chatting)\s+(?:to|with))\s+(?:a\s+|an\s+)?(?:real\s+(?:person|human)|human|person|bot|robot|ai|a\.i\.|automated|computer|machine|auto(?:mated)?\s*(?:text|message|reply)|chat\s*bot|chatgpt|recording)\b|\b(?:bot|robot|automated|ai)\s*\?\s*$/i
const ACK_ONLY_RE = /^\s*(?:ok(?:ay)?|k|thanks?|thank\s+you|thx|ty|got\s+it|cool|sounds\s+good)\s*[.!]*\s*$/i

// rc-8.5.21 v3 (RT-11 / RT-05): a BURST consolidated into one turn is decided on ALL its member inbounds —
// a fact, request or offer request stated in an earlier member counts for the turn (it used to count only
// when it was in the LATEST fragment, so a correct merge was held as ambiguous)
const newFactsFrom = (ledger, turnIds) => Object.entries(ledger?.facts || {}).filter(([, f]) => (f.source_message_ids || []).some((id) => turnIds.has(id))).map(([k]) => k)

/**
 * @param {object} a
 * @param {object} a.ledger            buildCanonicalLedger() as of this inbound (validated model facts merged)
 * @param {string} a.inboundText
 * @param {string} a.inboundId
 * @param {object|null} a.deterministic  the existing classifier verdict { intent, compliance_flag }
 * @param {object|null} a.eligibility    the existing eligibility verdict { blocked, reasons, guard }
 * @param {object|null} a.judgment      the R1 understanding (model nuance), validated; its text is never used
 * @param {{ available: boolean, use_case?: string|null }} [a.deterministicTemplate] the existing template path for this turn
 * @param {boolean} [a.ownerHandled]
 * @param {string|null} [a.language]
 * @param {number} [a.propertyCount]
 * @param {Array} [a.thread]           the loaded thread rows (escalation evidence)
 * @param {object|null} [a.inbound]    the inbound row { id, property_id }
 * @param {object} [a.companyIdentity] company-identity.js (absent ⇒ not configured)
 */
export function decideActions({ ledger, inboundText = '', inboundId, deterministic = null, eligibility = null, judgment = null, deterministicTemplate = { available: false }, ownerHandled = false, language = null, propertyCount = 1, thread = [], inbound = null, companyIdentity = NO_COMPANY_IDENTITY, enabledLanguages = ['en'], memberIds = [] }) {
  const turnIds = new Set([String(inboundId), ...(Array.isArray(memberIds) ? memberIds.map(String) : [])])
  // rc-8.5.21 v3 (RT-11 / RT-05): the LANGUAGE of a burst is read from all its fragments ("lol" / a name as
  // the last fragment is not an unknown language); a single inbound reads as before
  const burstText = turnIds.size > 1
    ? [...(thread || []).filter((m) => String(m?.direction || '').startsWith('in') && turnIds.has(String(m.id))).map((m) => m.body ?? m.message_body ?? ''), inboundText].filter(Boolean).join('\n')
    : inboundText
  const replyLangFor = () => languageEnabledFor({ language, inboundText: burstText, languages: enabledLanguages }).language
  const plan = (actions, reason, extra = {}) => {
    const v = validatePlan(actions)
    if (!v.ok) return { version: PIPELINE_VERSION, actions: [{ type: ACTIONS.HOLD, reason: 'plan_conflict' }], reasons: ['plan_conflict', ...v.reasons], conflict_from: actions.map((a) => a.type) }
    return { version: PIPELINE_VERSION, actions, reasons: [reason], reply_language: replyLangFor(), ...extra }
  }
  const facts = newFactsFrom(ledger, turnIds)
  const update = facts.length ? [{ type: ACTIONS.UPDATE_SELLER_FACTS, facts: Object.fromEntries(facts.map((k) => [k, ledger.facts[k].value])), source_message_id: inboundId }] : []
  const evCtx = { inboundText, ledger, thread, inbound: inbound || { id: inboundId } }

  // 1. stop: ANY stop request (incl. a glued "…STOP 🛑") beats everything, the model included
  if (isStopRequest(inboundText) || ['opt_out', 'stop_texting'].includes(String(deterministic?.intent)) || deterministic?.compliance_flag === 'stop_texting') {
    return plan([{ type: ACTIONS.UPDATE_SELLER_FACTS, facts: { opt_out: 'stop_requested' }, source_message_id: inboundId }, { type: ACTIONS.SUPPRESS, cancel_pending: true, reason: 'stop_request' }], 'stop_request_suppression')
  }
  // 2. ownership evidence precedence (Phase 3B): valid suppression / wrong number are absolute; a
  //    stored not-owner label is resolved against the thread's own statements, never global SUPPRESS
  const own = resolveOwnershipEvidence({ ledger, eligibility, inboundId, inboundText, deterministic })
  const ownership = { class: own.class, action: own.action, reasons: own.reasons, version: own.version }
  if (own.action === 'suppressed_existing') return plan([{ type: ACTIONS.SUPPRESS, cancel_pending: false, reason: own.reasons[0] }], 'existing_suppression', { ownership })
  if (own.action === 'no_owner_outreach') return plan([{ type: ACTIONS.UPDATE_SELLER_FACTS, facts: { ownership: 'wrong_number' }, source_message_id: inboundId }, { type: ACTIONS.NO_RESPONSE, reason: 'wrong_number_no_owner_outreach' }], 'wrong_number_no_owner_outreach', { ownership })
  // blind-eval S1 (SCONV-03) + rc-8.5.21 P0: one bare answer to ownership questions about SEVERAL properties
  // (one message naming both, or SEPARATE questions / follow-up fragments) says nothing about which one —
  // a thread HOLD for a person (owner 10-17 rule), never a denial of the latest, never a nurture or a close.
  // Decided before the generic eligibility holds so the reason stays precise (the recorded thread hold).
  if (ledger?.property?.ownership?.inbound?.ambiguous && ledger.property.ownership.thread_hold) {
    return plan([{ type: ACTIONS.HOLD, reason: 'ownership_denial_property_unresolved', evidence: { basis: ledger.property.ownership.inbound.basis } }], 'ownership_denial_property_unresolved', { ownership })
  }
  if (own.action === 'hold_conflict') return plan([{ type: ACTIONS.HOLD, reason: 'ownership_evidence_conflict', evidence: own.evidence }], 'ownership_evidence_conflict', { ownership })
  if (own.action === 'hold_unreadable') return plan([{ type: ACTIONS.HOLD, reason: own.reasons[0] || 'eligibility_unreadable' }], 'eligibility_unreadable', { ownership })
  const pOwn = ledger?.property?.ownership
  // blind-eval v2 (MUL-02/05/14): a mixed per-property answer records each property's answer and
  // CONTINUES the conversation on the one property they own / would sell (its next stage question);
  // the denied / not-for-sale property is closed for it (its denial / nurture is the inbound path's)
  const mixed = mixedAnswerTarget(pOwn)
  if (mixed && languageEnabledFor({ language, inboundText, languages: enabledLanguages }).enabled) {
    const byProperty = Object.fromEntries((pOwn.inbound.clauses || []).map((c) => [c.property, { ownership: c.ownership, interest: c.interest }]))
    return plan([{ type: ACTIONS.UPDATE_SELLER_FACTS, facts: { ownership_by_property: byProperty }, source_message_id: inboundId }, { type: ACTIONS.AI_GENERATED_REPLY, category: 'next_missing_fact', objective: mixed.objective, target_property: mixed.property }], 'mixed_property_answer_continue_on_confirmed', { ownership })
  }
  // OWNER DECISION 2026-10-17: the polite decline to the ownership question — never a nurture, never a
  // selling question, never composed; the property × contact hold is the guard's / contact resolution's
  if (own.action === 'ownership_declined_no_reply') {
    return plan([{ type: ACTIONS.NO_RESPONSE, reason: 'ownership_declined_unverified_hold' }], 'ownership_declined_unverified_no_nurture', { ownership })
  }
  if (own.action === 'property_denial_no_reply' && (eligibility?.blocked || own.class === 'tenant')) {
    return plan([{ type: ACTIONS.UPDATE_SELLER_FACTS, facts: { ownership: own.class }, source_message_id: inboundId }, { type: ACTIONS.NO_RESPONSE, reason: 'property_scoped_denial' }], 'ownership_denied_no_nurture', { ownership })
  }
  // 2b. the existing deterministic pre-check (legal threat, wrong number, hostile, empty); the
  //     eligibility verdict was resolved above
  const pre = deterministicPrecheck({ text: inboundText, inboundId, deterministic, eligibility: null })
  if (pre.decided) {
    const o = pre.decision.outcome
    if (o === 'SUPPRESS') return plan([{ type: ACTIONS.SUPPRESS, cancel_pending: true, reason: pre.reason }], `precheck:${pre.reason}`, { ownership })
    if (o === 'UPDATE_ONLY') return plan([{ type: ACTIONS.UPDATE_SELLER_FACTS, facts: { ownership: 'denied' }, source_message_id: inboundId }, { type: ACTIONS.NO_RESPONSE }], 'ownership_denied_no_nurture', { ownership })
    if (o === 'NO_RESPONSE') return plan([{ type: ACTIONS.NO_RESPONSE }], `precheck:${pre.reason}`, { ownership })
    return plan([{ type: ACTIONS.HOLD, reason: pre.reason }], `precheck:${pre.reason}`, { ownership })
  }
  if (ownerHandled) return plan([{ type: ACTIONS.HOLD, reason: 'owner_handled_thread' }], 'owner_handled_thread', { ownership })
  // rc-8.5.21 v4 (rt-pl-05): an inbound that NAMES another property of the thread whose ownership is not
  // known yet ("hey is this about the house on Elm?" after a denial of Main St) is about THAT property:
  // its S1 question, never the denied property's closure (the denial stays on its own property)
  const namedOther = pOwn?.inbound?.basis === 'named_in_reply' ? String(pOwn.inbound.property || '') : ''
  if (namedOther && namedOther !== String(inbound?.property_id || '') && Object.keys(pOwn.by_property || {}).length > 1 &&
    (pOwn.by_property?.[namedOther]?.state || 'unknown') === 'unknown' && languageEnabledFor({ language, inboundText, languages: enabledLanguages }).enabled) {
    return plan([{ type: ACTIONS.AI_GENERATED_REPLY, category: 'next_missing_fact', objective: 'ownership', target_property: namedOther, named_other_property: true }], 'named_other_property_ownership_first', { ownership })
  }

  // 3. ownership denial read against the actual previous question ("No" to "do you own it?"), or
  //    the model's validated denial — terminal ONLY when the same message does not take it back,
  //    carry a price, answer a live negotiation or contradict recent statements (Phase 3A)
  const ownFact = ledger?.facts?.ownership
  // OWNER DECISION 2026-10-18: the seller's language from the INBOUND evidence; the reply is composed
  // in it ONLY when the language policy enables it (Spanish), never an English fallback
  const replyLang = languageEnabledFor({ language, inboundText: burstText, languages: enabledLanguages })
  const lang = { english: replyLang.enabled, reason: replyLang.reason, language: replyLang.language }
  const confident = (j) => j && Number(j.confidence) >= 0.85
  const detPositive = ['ownership_confirmed', 'seller_interested', 'interested', 'latent_interest', 'asks_offer'].includes(String(deterministic?.intent))
  const denial = ownershipDenialTerminal({ ledger, inboundId, inboundText })
  const ledgerDenied = ownFact && ['denied', 'former_owner'].includes(ownFact.value) && (ownFact.source_message_ids || []).includes(inboundId)
  const priceOrNegotiation = (ledger?.facts?.asking_price?.source_message_ids || []).includes(inboundId) || (ledger?.existing_offers || []).length > 0 || (ledger?.outbound_quotes || []).length > 0
  const modelDeniedRaw = confident(judgment) && !detPositive && (judgment.outcome === 'UPDATE_ONLY' || ['ownership_denied', 'wrong_number'].includes(judgment.intent)) &&
    (['ownership_denied', 'wrong_number'].includes(judgment.intent) || (judgment.facts_extracted || []).some((f) => f.fact === 'ownership' && ['denied', 'former_owner', 'not_owner'].includes(String(f.value)) && f.source_message_id === inboundId))
  const modelDenied = modelDeniedRaw && !(judgment.intent !== 'wrong_number' && priceOrNegotiation) && !(ledger?.retractions || []).some((r) => r.source_message_id === inboundId)
  let ownershipConflict = null
  if (ledgerDenied && !denial.terminal) ownershipConflict = denial.reasons
  else if (ledgerDenied || modelDenied) {
    return plan([{ type: ACTIONS.UPDATE_SELLER_FACTS, facts: { ownership: ledgerDenied ? ownFact.value : 'denied' }, source_message_id: inboundId }, { type: ACTIONS.NO_RESPONSE }], ledgerDenied ? 'ownership_denied_no_nurture' : 'ownership_denied_no_nurture:model', { ownership })
  } else if (modelDeniedRaw) ownershipConflict = ['model_denial_vs_price_or_negotiation']

  const requestHere = (kind) => (ledger?.requests || []).some((r) => r.kind === kind && turnIds.has(String(r.source_message_id)))
  const objectionHere = (kind) => (ledger?.objections || []).some((o) => o.kind === kind && turnIds.has(String(o.source_message_id)))
  const financingObjection = objectionHere('financing_terms_objection') || FINANCING_OBJECTION_RE.test(String(inboundText || ''))

  // 3c. rc-8.5.21 v3: ACCEPTANCE of OUR proposal ("No, I'm good with the amount you proposed") — read with the
  //     outbound that carried our number; never the "I'm good" decline, never acted on automatically: a person
  //     verifies the actual offer, the property and the authority (no automatic contract, no reply)
  const weProposed = (ledger?.outbound_quotes || []).length > 0 || (ledger?.existing_offers || []).length > 0
  if (!ownershipConflict && acceptsOurProposal(inboundText, { weProposed })) {
    return plan([{ type: ACTIONS.UPDATE_SELLER_FACTS, facts: { ...(update[0]?.facts || {}), offer_response: 'accepted_candidate' }, source_message_id: inboundId },
      escalation('seller_accepted_proposal', { source_message_id: inboundId, outbound_quotes: (ledger?.outbound_quotes || []).length, existing_offers: (ledger?.existing_offers || []).map((o) => o.id).slice(0, 5), verify: ['actual_offer', 'property', 'authority'], contract: 'never_automatic' })],
    'seller_accepted_proposal_verify', { ownership })
  }

  // 4. disinterest → the existing 30-day follow-up, whatever the language; only the reply text
  //    is language-gated. The model's validated not_interested counts when nothing contradicts it.
  //    A financing-terms objection is CONDITIONAL interest, never disinterest (Phase 3C).
  const interest = ledger?.facts?.seller_interest
  const ledgerNotInterested = !ownershipConflict && interest?.value === 'not_interested' && (interest.source_message_ids || []).includes(inboundId)
  const ledgerInterestedNow = interest && interest.value !== 'not_interested' && (interest.source_message_ids || []).includes(inboundId)
  const modelNotInterested = !ownershipConflict && !financingObjection && confident(judgment) && judgment.intent === 'not_interested' && !detPositive && !ledgerInterestedNow && !(ledger?.offer_requests || []).includes(inboundId)
  if (ledgerNotInterested || modelNotInterested) {
    const f = { ...(update[0]?.facts || {}), seller_interest: 'not_interested' }
    const follow = { type: ACTIONS.SCHEDULE_FOLLOWUP, kind: 'nurture_30_day', days: 30 }
    // "email me your card": the 30-day follow-up is kept AND a person handles the request (never a promise)
    if (requestHere('email_or_card')) return plan([{ type: ACTIONS.UPDATE_SELLER_FACTS, facts: f, source_message_id: inboundId }, follow, escalation('requested_email_or_card', { source_message_id: inboundId })], 'disinterest_30_day_followup:email_request_human', { ownership })
    const close = deterministicTemplate?.available ? { type: ACTIONS.DETERMINISTIC_REPLY, use_case: deterministicTemplate.use_case || null }
      : lang.english ? { type: ACTIONS.AI_GENERATED_REPLY, category: 'not_interested_close', objective: 'close_no_question', followup_scheduled: { kind: 'nurture_30_day', days: 30 } }
        : { type: ACTIONS.NO_RESPONSE }
    return plan([{ type: ACTIONS.UPDATE_SELLER_FACTS, facts: f, source_message_id: inboundId }, follow, close], ledgerNotInterested ? 'disinterest_30_day_followup' : 'disinterest_30_day_followup:model', { ownership })
  }

  // 5. language: only English threads get engine text (a missing language with English text is English)
  if (!lang.english) return plan([...update, escalation('language_not_enabled', { reason: lang.reason })], 'language_not_enabled', { ownership, reply_language: lang.language })

  // 5b. two stated asking prices far apart: a plain HOLD (no model escalation)
  if (judgment?.escalation_reason === 'contradiction' || judgment?._hold === 'price_contradiction') return plan([...update, { type: ACTIONS.HOLD, reason: 'price_contradiction' }], 'price_contradiction', { ownership })

  // 6. hard escalations — every reason carries its evidence (Phase 3D)
  const mp = multiPropertyEvidence(evCtx)
  if (mp) return plan([...update, { type: ACTIONS.RESEARCH_PROPERTY }, escalation('multiple_properties', mp)], 'multi_property', { ownership })
  const mo = multiOwnerEvidence(evCtx)
  if (mo) return plan([...update, escalation('multiple_owners', mo)], 'multi_owner', { ownership })
  const moneyTurn = (ledger?.offer_requests || []).includes(inboundId) || (ledger?.objections || []).some((o) => o.kind === 'price_objection' && o.source_message_id === inboundId) || judgment?.intent === 'counter_or_negotiation'
  if (financingObjection && !moneyTurn && !ownershipConflict) {
    // "Not if it involves creative financing": conditional interest; the objection is recorded and
    // the next step is the cash-purchase path (the next missing fact, usually the asking price)
    const f = { ...(update[0]?.facts || {}), seller_interest: 'conditional', objection: 'financing_terms' }
    return plan([{ type: ACTIONS.UPDATE_SELLER_FACTS, facts: f, source_message_id: inboundId }, { type: ACTIONS.AI_GENERATED_REPLY, category: 'conditional_interest_clarify', objective: ledger?.next_missing || 'asking_price' }], 'financing_objection_conditional_interest', { ownership })
  }
  if (FINANCING_RE.test(inboundText)) return plan([...update, escalation('incompatible_term', { kind: 'financing_structure_proposed' })], 'financing', { ownership })
  if (LEGAL_TOPIC_RE.test(inboundText)) return plan([...update, escalation('incompatible_term', { kind: 'legal_or_title_topic' })], 'legal_topic', { ownership })


  // 7. money: an offer request / a counter is the negotiation authority's, never the model's
  const offerRequested = (ledger?.offer_requests || []).some((id) => turnIds.has(String(id)))
  const counter = (ledger?.objections || []).some((o) => o.kind === 'price_objection' && o.source_message_id === inboundId) || judgment?.intent === 'counter_or_negotiation'
  const numberHere = /\b[0-9]{2,3}(?:k|,[0-9]{3})?\b|\$\s?[0-9]/i.test(String(inboundText || ''))
  const quoted = (ledger?.outbound_quotes || []).length > 0
  if (counter && (ledger?.existing_offers || []).length) return plan([...update, { type: ACTIONS.NEGOTIATE_WITHIN_AUTHORITY, request: 'counter' }], 'counter_to_offer', { ownership })
  // OWNER DECISION 2026-10-18 (offer before price): "What would you pay?" is an explicit offer request.
  //  - no asking price yet and we have not asked it: ask ONCE, naturally, whether they have a number
  //    in mind (no amount, no fabricated offer)
  //  - otherwise (asked / deflected / given): an asking price is NOT required — property research,
  //    comps and valuation, then the authorization-gated offer recommendation (the envelope system).
  //    The authority escalates only at the point a NUMBER would be sent; no price without an envelope.
  const askedPrice = (ledger?.questions?.asking_price?.asked_count || 0) > 0
  if (offerRequested && judgment?.outcome === 'REPLY_CANDIDATE' && !judgment.escalation_required && !judgment.escalation_reason && !(ledger?.existing_offers || []).length && !quoted && ledger?.facts?.asking_price?.value == null && !askedPrice && ['asking_price', 'interest'].includes(ledger?.next_missing)) {
    return plan([...update, { type: ACTIONS.AI_GENERATED_REPLY, category: 'next_missing_fact', objective: 'asking_price', offer_request: true }], 'offer_request_ask_number_once', { ownership })
  }
  if (offerRequested) return plan([...update, { type: ACTIONS.RESEARCH_PROPERTY, reason: 'offer_request_valuation' }, { type: ACTIONS.PREPARE_OFFER, request: 'offer_request' }], 'offer_request_research_then_authorized_offer', { ownership })
  if (counter || (quoted && numberHere)) return plan([...update, escalation('missing_negotiation_authority', { kind: counter ? 'counter_without_offer_record' : 'number_answering_our_quoted_amount', outbound_quotes: (ledger?.outbound_quotes || []).length })], 'negotiation_needs_authority', { ownership })
  // the model's own escalation, evidence-checked (after the deterministic money rules: a live
  // negotiation is named as such, never as the model's generic claim)
  if (judgment?.escalation_required) {
    const esc = mapModelEscalation(judgment, evCtx)
    return plan([...update, esc], `model_escalation:${esc.reason}`, { ownership })
  }
  if (ownershipConflict) return plan([...update, { type: ACTIONS.HOLD, reason: 'ownership_signal_not_terminal', evidence: { reasons: ownershipConflict } }], 'ownership_signal_not_terminal', { ownership })
  if (ledger?.stage?.stage === 'S5_offer' && !(ledger?.existing_offers || []).length) return plan([...update, { type: ACTIONS.PREPARE_OFFER, request: 'price_and_condition_known' }], 'facts_complete_offer_is_authority_step', { ownership })

  // 8. need time: the follow-up, no reply needed
  if (objectionHere('need_time')) return plan([...update, { type: ACTIONS.SCHEDULE_FOLLOWUP, kind: 'need_time', days: 14 }, { type: ACTIONS.NO_RESPONSE }], 'need_time_followup', { ownership })

  // 8a. an e-mail / card / website request: a person sends it (the AI never promises it)
  if (requestHere('email_or_card')) return plan([...update, escalation('requested_email_or_card', { source_message_id: inboundId })], 'email_or_card_request_human', { ownership })
  // 8a'. a visit request ("can you stop by Thursday at 3"): an operator task — the AI never promises a visit
  if (requestHere('visit_request')) return plan([...update, escalation('requested_visit', { source_message_id: inboundId })], 'visit_request_operator_task', { ownership })

  // 8a''. rc-8.5.21 v3: a CALLBACK request ("call me", "give me a call") — an operator task; never a
  //       text that promises a call, never dropped into the ambiguous hold
  if (requestHere('callback')) return plan([...update, escalation('requested_callback', { source_message_id: inboundId })], 'callback_request_operator_task', { ownership })

  // 8b. "is this a bot / a real person?": a person answers it, truthfully (never a denial)
  if (AUTOMATION_QUESTION_RE.test(String(inboundText || ''))) return plan([...update, escalation('asked_if_automated', { source_message_id: inboundId })], 'automation_question_human_answers', { ownership })

  // 8c. "which company are you with?": only the configured identity answers it, else a person
  if (requestHere('company_identity')) {
    if (!companyIdentity?.configured) return plan([...update, escalation('company_identity_not_configured', { source_message_id: inboundId })], 'company_question_identity_not_configured', { ownership })
    return plan([...update, { type: ACTIONS.AI_GENERATED_REPLY, category: 'identity_answer', objective: ledger?.next_missing || 'none', company_question: true }], 'company_question_configured_identity', { ownership })
  }

  // 9. who is this: answer truthfully, then the open stage question (once)
  if ((ledger?.requests || []).some((r) => r.kind === 'identity' && r.source_message_id === inboundId)) return plan([...update, { type: ACTIONS.AI_GENERATED_REPLY, category: 'identity_answer', objective: ledger?.next_missing || 'none' }], 'identity_question', { ownership })

  // 10. the next missing fact (S1–S4). A simple turn with an existing template stays deterministic.
  if (ledger?.next_missing) {
    const simple = facts.length <= 1 && String(inboundText).trim().length <= 40 && !/\?/.test(inboundText)
    if (simple && deterministicTemplate?.available) return plan([...update, { type: ACTIONS.DETERMINISTIC_REPLY, use_case: deterministicTemplate.use_case || null }], 'simple_turn_existing_template', { ownership })
    if (facts.length || /\?/.test(inboundText) || !ACK_ONLY_RE.test(inboundText)) {
      if (!facts.length && !(judgment && judgment.outcome === 'REPLY_CANDIDATE' && judgment.confidence >= 0.85)) {
        // nothing recognised and no confident judgment: ambiguous, review it
        return plan([{ type: ACTIONS.HOLD, reason: 'ambiguous_needs_review' }], 'ambiguous', { ownership })
      }
      return plan([...update, { type: ACTIONS.AI_GENERATED_REPLY, category: facts.length ? 'next_missing_fact' : 'clarification', objective: ledger.next_missing }], 'next_missing_fact', { ownership })
    }
  }
  if (ACK_ONLY_RE.test(inboundText)) return plan([...update, { type: ACTIONS.NO_RESPONSE }], 'acknowledgement_only', { ownership })
  return plan([...update, { type: ACTIONS.HOLD, reason: 'no_safe_next_step' }], 'no_safe_next_step', { ownership })
}
