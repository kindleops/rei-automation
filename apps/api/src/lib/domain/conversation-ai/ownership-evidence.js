// OWNERSHIP EVIDENCE PRECEDENCE (rc-8.5.21, Phase 3B). Pure.
//
// One verdict on "who is this person to this property", ranked by evidence, never by whichever
// label was written last somewhere:
//   source reliability   an explicit statement in THIS thread (the canonical ledger) outranks a
//                        stored classifier label (inbox_thread_state / an older message_events
//                        detected_intent, as read by the send-time contact guard)
//   explicit statements  "I own it" / "that's my mom's house" / "I sold it" / "wrong number"
//   identity linkage     the guard's not-owner scope is person × property; wrong number is phone-scoped
//   recency              the latest seller statement wins inside the ledger; a label outside it
//                        carries no time and therefore never outranks a stated confirmation
//   contradictions       a stored not-owner label against a stated confirmation ⇒ HOLD for a human
//   confidence           regex-only "sold" readings are weak (0.6): mixed-intent rules may outrank them
//   property authority   a not-owner verdict is property-scoped (no nurture for THIS property only)
//
// Classes: opt_out | wrong_number | property_non_owner | tenant | former_owner | confirmed_owner |
//          authorized_rep | uncertain
// ABSOLUTE (no inferred ownership correction may override): a stop request, a valid suppression
// (suppression list, automation suppression, suppressed / opted-out thread, an opt-out reply) and
// a wrong number. prior_reply_not_owner is NEVER a global suppression: with newer confirmation it
// holds for a human; without it, it is the property-scoped denial (no reply, no nurture).
import { isStopRequest } from './stop-request.js'

export const OWNERSHIP_EVIDENCE_VERSION = 'conv-ai.ownership-evidence.v1'
export const OWNERSHIP_CLASSES = Object.freeze(['opt_out', 'wrong_number', 'property_non_owner', 'tenant', 'former_owner', 'ownership_declined_unverified', 'confirmed_owner', 'authorized_rep', 'uncertain'])

// send-time-contact-guard.js reasons (SEND_TIME_GUARD_REASONS) that are suppression states
export const ABSOLUTE_SUPPRESSION_REASONS = Object.freeze(new Set(['sms_suppression_list_active', 'automation_suppression_active', 'thread_suppressed', 'thread_opted_out', 'opt_out_reply']))
const TENANT_SIGNALS = new Set(['tenant_respondent', 'tenant_or_occupant'])
const FORMER_SIGNALS = new Set(['former_owner_respondent', 'sold_property', 'sold', 'listed_or_sold'])
const NOT_OWNER_INTENTS = new Set(['property_specific_non_owner', 'former_owner_respondent', 'sold_property', 'sold', 'tenant_respondent', 'non_owner_referral', 'not_owner'])

const classOfSignal = (s) => (TENANT_SIGNALS.has(s) ? 'tenant' : FORMER_SIGNALS.has(s) ? 'former_owner' : 'property_non_owner')
const t = (x) => Date.parse(x || 0) || 0

/** The latest STATED (not inferred) ownership statement in the ledger, or null. */
function latestStated(ledger) {
  const hist = (ledger?.facts?.ownership?.history || []).filter((h) => h.basis !== 'inferred')
  return hist.length ? hist[hist.length - 1] : null
}

/**
 * @param {{ ledger: object, eligibility?: object|null, inboundId?: string|null, inboundText?: string, deterministic?: object|null }} a
 * @returns {{ version: string, class: string, action: 'suppress_stop'|'suppressed_existing'|'no_owner_outreach'|'property_denial_no_reply'|'ownership_declined_no_reply'|'hold_conflict'|'hold_unreadable'|'proceed', absolute: boolean, conflict: boolean, reasons: string[], evidence: object }}
 */
export function resolveOwnershipEvidence({ ledger = null, eligibility = null, inboundId = null, inboundText = '', deterministic = null } = {}) {
  const out = (cls, action, reasons = [], extra = {}) => ({ version: OWNERSHIP_EVIDENCE_VERSION, class: cls, action, absolute: ['suppress_stop', 'suppressed_existing', 'no_owner_outreach'].includes(action), conflict: action === 'hold_conflict', reasons, evidence: extra })
  const detIntent = String(deterministic?.intent || '')
  // 1. a stop request in THIS message (any form) — absolute, immediate
  if (isStopRequest(inboundText) || ['opt_out', 'stop_texting'].includes(detIntent) || deterministic?.compliance_flag === 'stop_texting') return out('opt_out', 'suppress_stop', ['stop_request'])
  const guard = eligibility?.guard || {}
  const reason = String(guard.reason || (eligibility?.blocked ? (eligibility.reasons || [])[0] || '' : ''))
  // 2. a valid suppression state — absolute
  if (eligibility?.blocked && ABSOLUTE_SUPPRESSION_REASONS.has(reason)) return out('opt_out', 'suppressed_existing', [`existing_suppression:${reason}`], { guard_reason: reason })
  // 3. wrong number — absolute (phone-scoped): no owner outreach
  if (eligibility?.blocked && reason === 'wrong_number') return out('wrong_number', 'no_owner_outreach', ['wrong_number'], { guard_reason: reason, source: guard.source || null })
  if (detIntent === 'wrong_number') return out('wrong_number', 'no_owner_outreach', ['wrong_number:classifier'])
  // 4. an unreadable guard is never "no block": a person looks
  if (eligibility?.blocked && reason === 'send_time_guard_read_failed') return out('uncertain', 'hold_unreadable', ['eligibility_unreadable'])

  const own = ledger?.facts?.ownership || null
  const stated = latestStated(ledger)
  const statedHere = stated && stated.source_message_id === inboundId
  // 5. a stored property-scoped not-owner label (the guard's prior_reply_not_owner)
  if (eligibility?.blocked && reason === 'prior_reply_not_owner') {
    const signal = String(guard.signal || '')
    const thisMessage = NOT_OWNER_INTENTS.has(detIntent)
    const confirmed = stated && ['confirmed', 'representative'].includes(stated.value)
    if (confirmed && !thisMessage) {
      // a stated confirmation in the thread vs a stored label with no time: conflict ⇒ a human
      return out(stated.value === 'representative' ? 'authorized_rep' : 'confirmed_owner', 'hold_conflict', ['ownership_evidence_conflict:prior_reply_not_owner_vs_stated_confirmation'], { guard_signal: signal || null, guard_source: guard.source || null, confirmation_message_id: stated.source_message_id })
    }
    return out(classOfSignal(thisMessage ? detIntent : signal), 'property_denial_no_reply', ['prior_reply_not_owner'], { guard_signal: signal || null, guard_source: guard.source || null, from_this_message: thisMessage })
  }
  // 5b. OWNER DECISION 2026-10-17: a recorded / thread-evident polite decline to the ownership question
  //     (ownership UNVERIFIED) — no reply, no nurture, no selling question; NOT a denial fact
  if (eligibility?.blocked && reason === 'ownership_declined_unverified_hold') return out('ownership_declined_unverified', 'ownership_declined_no_reply', ['ownership_declined_unverified_hold'], { guard_source: guard.source || null })
  if (eligibility?.blocked) return out('uncertain', 'hold_unreadable', [`eligibility_blocked:${reason || 'blocked'}`])

  // 6. the ledger itself (this thread's explicit statements, latest wins); a tenant reading of THIS
  //    message (classifier) is the property-scoped non-owner class
  if (TENANT_SIGNALS.has(detIntent)) return out('tenant', 'property_denial_no_reply', ['classifier:tenant'])
  const v = own?.value || null
  if (detIntent === 'ownership_declined_unverified' || (v === 'declined_unverified' && (own.source_message_ids || []).includes(inboundId))) {
    return out('ownership_declined_unverified', 'ownership_declined_no_reply', [detIntent === 'ownership_declined_unverified' ? 'classifier:ownership_declined_unverified' : 'ledger:ownership_declined_unverified'])
  }
  if (v === 'denied') return out('property_non_owner', statedHere || (own.source_message_ids || []).includes(inboundId) ? 'property_denial_no_reply' : 'proceed', ['ledger:ownership_denied'])
  if (v === 'former_owner') return out('former_owner', 'proceed', ['ledger:former_owner'], { confidence: own.confidence ?? null })
  if (v === 'representative') return out('authorized_rep', 'proceed', [])
  if (v === 'confirmed') return out('confirmed_owner', 'proceed', [], { basis: own.basis || null })
  return out('uncertain', 'proceed', [])
}

/**
 * Phase 3A — is an ownership denial / "sold" reading from THIS message terminal?
 * Not terminal when the same message takes it back, carries a price, answers a live negotiation
 * (an offer record or an amount we quoted), or contradicts the thread's recent statements while the
 * reading itself is weak (< 0.85, a regex "sold").
 * @returns {{ terminal: boolean, reasons: string[] }}
 */
export function ownershipDenialTerminal({ ledger = null, inboundId = null, inboundText = '' } = {}) {
  const own = ledger?.facts?.ownership
  if (!own || !['denied', 'former_owner'].includes(own.value) || !(own.source_message_ids || []).includes(inboundId)) return { terminal: false, reasons: ['no_denial_from_this_message'] }
  const reasons = []
  if ((ledger.retractions || []).some((r) => r.source_message_id === inboundId)) reasons.push('retracted_in_same_message')
  const priceHere = (ledger?.facts?.asking_price?.source_message_ids || []).includes(inboundId)
  const numberHere = /\b[0-9]{2,3}(?:k|,[0-9]{3})?\b|\$\s?[0-9]/i.test(String(inboundText || ''))
  const liveOffer = (ledger.existing_offers || []).length > 0 || (ledger.outbound_quotes || []).length > 0
  // an explicit denial ("I don't own it", "wrong number", a bare No to the ownership question) is
  // the locked owner policy; only the weak regex "sold" reading (former_owner, < 0.85) is outranked
  const weak = own.value === 'former_owner' && Number(own.confidence ?? 0.8) < 0.85
  if (priceHere) reasons.push('price_in_same_message')
  if (liveOffer && (weak || numberHere)) reasons.push('live_negotiation')
  const hist = own.history || []
  const prior = hist.filter((h) => h.source_message_id !== inboundId && h.basis !== 'inferred')
  const lastPrior = prior[prior.length - 1]
  const interest = ledger?.facts?.seller_interest
  const recentPositive = (lastPrior && ['confirmed', 'representative'].includes(lastPrior.value) && t(own.history[own.history.length - 1]?.at) - t(lastPrior.at) <= 14 * 864e5) ||
    (interest && ['interested', 'conditional'].includes(interest.value) && !(interest.source_message_ids || []).includes(inboundId))
  if (weak && recentPositive) reasons.push('contradicts_recent_statements')
  if (own.value === 'former_owner' && weak && numberHere) reasons.push('weak_former_owner_with_number')
  return { terminal: reasons.length === 0, reasons }
}
