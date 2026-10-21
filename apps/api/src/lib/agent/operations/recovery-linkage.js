// Recovery → research / valuation linkage (8.5.21-b, owner directive Phase 9).
//
// recoveryNextAction(candidate)      ONE evidence-backed next action per recovery class (an
//                                    operator act, a research / valuation request, or none) —
//                                    never a send: an old reply never authorizes a new text.
// recoveryLinkRequests(candidates)   property.research requests (trigger recovery_finding) and
//                                    valuation-refresh candidates (class recoverable_conversation)
//                                    for the conversations worth underwriting.
// detectMisclassifiedCounteroffer()  a seller message that states a price, on a thread whose final
//                                    classification is former_owner / unclear / a denial — a
//                                    counteroffer the classifier lost (owner eval 10-16).
// Pure. Ids only in the outputs (message bodies are read, never returned).
import { decodePropertyRef } from '../missions/mission-codec.js'
import { extractMoneyAmounts } from '../../domain/negotiation/seller-facing-guard.js'

export const RECOVERY_LINKAGE_VERSION = 'recovery-linkage.v1'

const VIABLE = new Set(['previous_selling_interest', 'unanswered_offer_request', 'abandoned_negotiation', 'old_price_expectation', 'material_new_evidence'])
const REVIEW_ACTION = Object.freeze({
  reply_failed_after_provider_accepted_never_resend_automatically: 'human_review_failed_send_never_resend_automatically',
  reply_failed_before_provider: 'review_then_requeue_internal_failure_through_send_queue',
  seller_message_unanswered: 'operator_answer_the_seller',
  offer_request_unanswered: 'operator_answer_offer_request_after_research',
  identity_question_unanswered: 'operator_answer_identity_question',
  third_party_respondent: 'operator_identify_decision_maker',
  hostile_or_legal_language: 'operator_review_hostile_or_legal',
  language_without_approved_copy: 'operator_review_language_no_approved_copy',
  no_approved_reengagement_scope: 'owner_decide_reengagement_program',
  followup_date_expired_without_program: 'owner_decide_reengagement_program',
  permission_not_verified: 'verify_contact_permission',
  ownership_unverified: 'verify_ownership_before_any_followup',
  reopened_by_seller_after_close: 'operator_review_reopened_deal',
})

const codesOf = (c) => new Set((c.detections || []).map((d) => d.code))
const pidOf = (c) => {
  if (c.property_id) return String(c.property_id)
  if (!c.property_ref) return null
  try { const p = decodePropertyRef(String(c.property_ref)); return /^[0-9A-Za-z_-]{1,64}$/.test(p) ? p : null } catch { return null }
}

/**
 * @param {object} c  classifyRecoveryCandidate() output (or the recovery.candidate finding value)
 * @returns {{ action: string, owner: 'operator'|'owner'|'system'|'none', research: boolean, valuation: boolean, sends: 0, evidence_refs: Array }}
 */
export function recoveryNextAction(c = {}) {
  const reasons = c.reasons || []
  const codes = codesOf(c)
  const hasProperty = Boolean(pidOf(c))
  const out = (action, owner, extra = {}) => ({ version: RECOVERY_LINKAGE_VERSION, action, owner, research: false, valuation: false, sends: 0, evidence_refs: (c.evidence_refs || []).slice(0, 8), ...extra })
  switch (c.class) {
    case 'suppressed': return out('none_suppressed_no_contact', 'none')
    // owner 2026-10-17: declined the ownership question, ownership unverified — hold; no outreach, no nurture
    case 'ownership_declined_hold': return out('none_ownership_declined_unverified_hold', 'none')
    case 'wrong_owner_or_number': return out(reasons.includes('ownership_denied') ? 'none_ownership_denied_for_this_property' : 'none_wrong_number_no_owner_outreach', 'none')
    case 'previously_closed':
      return reasons.includes('closed_after_not_interested_policy_says_30_day_follow_up')
        ? out('propose_state_correction_to_30_day_follow_up', 'owner', { plan: 'dead-deal-correction' })
        : out('none_closed', 'none')
    case 'currently_unworkable':
      return reasons.includes('inside_not_interested_nurture_window') ? out('wait_inside_30_day_nurture_window', 'system') : reasons.includes('economics_pass') ? out('none_economics_pass', 'none') : out('none_no_recovery_signal', 'none')
    case 'eligible_for_approved_followup':
      return out(`review_followup_inside_program:${c.program}`, 'operator', { research: hasProperty, valuation: hasProperty })
    case 'research_worthy':
      return out(hasProperty ? 'research_and_value_before_any_recontact' : 'link_property_then_research', 'system', { research: hasProperty, valuation: hasProperty })
    case 'needs_human_review': {
      const last = [...reasons].reverse().find((r) => REVIEW_ACTION[r]) || null
      const viable = [...codes].some((x) => VIABLE.has(x))
      return out(last ? REVIEW_ACTION[last] : 'operator_review', last === 'no_approved_reengagement_scope' || last === 'followup_date_expired_without_program' ? 'owner' : 'operator', { research: hasProperty && viable, valuation: hasProperty && viable })
    }
    default: return out('operator_review', 'operator')
  }
}

/**
 * @param {Array<object>} candidates  recovery candidates (classified)
 * @returns {{ research: Array<{ property_id, trigger, discriminator, conversation_id }>, valuation: Array<{ property_id, recovery_class, conversation_id }>, by_action: Record<string,number> }}
 */
export function recoveryLinkRequests(candidates = []) {
  const research = []
  const valuation = []
  const by_action = {}
  const seen = new Set()
  for (const c of candidates) {
    const n = recoveryNextAction(c)
    by_action[n.action] = (by_action[n.action] || 0) + 1
    const pid = pidOf(c)
    if (!pid || seen.has(pid)) continue
    if (n.research) research.push({ property_id: pid, trigger: 'recovery_finding', discriminator: `recovery:${c.class}:${String(c.conversation_id || '').slice(0, 36)}`, conversation_id: c.conversation_id || null })
    if (n.valuation) valuation.push({ property_id: pid, recovery_class: c.class, conversation_id: c.conversation_id || null, status: 'recovery' })
    if (n.research || n.valuation) seen.add(pid)
  }
  return { version: RECOVERY_LINKAGE_VERSION, research, valuation, by_action }
}

/** Final classifications that LOSE a counteroffer when the seller stated a price. */
export const COUNTER_LOSING_INTENTS = Object.freeze(['former_owner_respondent', 'unclear', 'unknown', 'property_specific_non_owner', 'acknowledgement', 'reaction_only'])
const PRICE_CONTEXT_RE = /\b(ask(ing)?|want|take|need|accept|would do|could do|for|offer|price|at least|no less|firm|bottom|best)\b/i

/**
 * @param {object} t
 * @param {Array<{ id: string, direction: string, body: string, intent?: string|null, at?: string }>} t.messages  the thread (bodies are read, never returned)
 * @param {string|null} t.final_intent        the thread's final classification (inbox_thread_state.last_intent / opportunity.latest_intent)
 * @param {string|null} [t.disposition]
 */
export function detectMisclassifiedCounteroffer({ messages = [], final_intent = null, disposition = null } = {}) {
  const fin = String(final_intent || '').toLowerCase()
  const losing = COUNTER_LOSING_INTENTS.includes(fin) || ['former_owner', 'unclear'].includes(String(disposition || '').toLowerCase())
  const priced = []
  for (const m of messages) {
    if (String(m.direction || '').toLowerCase() !== 'inbound') continue
    const body = String(m.body || '')
    const amounts = extractMoneyAmounts(body).filter((a) => a >= 10_000 && a < 50_000_000)
    if (!amounts.length) continue
    if (!PRICE_CONTEXT_RE.test(body) && !/\$/.test(body)) continue
    priced.push({ message_id: String(m.id), intent: m.intent || null })
  }
  const lostAt = priced.filter((p) => !['asking_price_provided', 'asking_price_implausible', 'counter_offer', 'asks_offer'].includes(String(p.intent || '').toLowerCase()))
  return {
    version: RECOVERY_LINKAGE_VERSION,
    misclassified: losing && priced.length > 0,
    final_intent: fin || null,
    priced_messages: priced.length,
    priced_messages_not_classified_as_price: lostAt.length,
    message_ids: priced.map((p) => p.message_id).slice(0, 10),
    next_action: losing && priced.length ? 'operator_review_counteroffer_and_reclassify' : null,
  }
}
