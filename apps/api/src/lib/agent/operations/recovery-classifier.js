// Historical opportunity recovery — the classifier (8.5.20 part C, owner directive).
//
// Input: one normalized conversation (conversation-facts.js) + the clock + the
// re-engagement programs the owner has ALREADY approved (default: none).
// Output: exactly one class, the detections that justify it, the permission
// verdict, and the evidence refs (message / opportunity / valuation ids).
//
//   research_worthy                 viable signals, we spoke last: underwrite first
//   eligible_for_approved_followup  a follow-up that an approved program already covers,
//                                   permission verified — still a REVIEW ITEM, never a send
//   needs_human_review              the seller is waiting on us, a send failed, a third
//                                   party / hostile / unsupported language / no approved program
//   currently_unworkable            no recovery signal, inside a nurture window, economics PASS
//   suppressed                      stop request / opt-out / suppression list / do-not-contact
//   wrong_owner_or_number           wrong number, or a property-scoped ownership denial
//   previously_closed               the deal was closed and the seller has not written since
//
// AN OLD REPLY NEVER AUTHORIZES A NEW TEXT. Nothing here sends, queues or schedules;
// the sweep turns classes into findings and review work items only.
import {
  INTEREST_INTENTS, OFFER_REQUEST_INTENTS, PRICE_INTENTS, RELATIONSHIP_REVIEW_INTENTS, HOSTILE_INTENTS, NOT_INTERESTED_INTENTS,
  verifyContactPermission, sellerWaiting, closedVerdict, languageSupported, stageRank, ms, latest,
} from './conversation-facts.js'

export const RECOVERY_CLASSES = Object.freeze(['research_worthy', 'eligible_for_approved_followup', 'needs_human_review', 'currently_unworkable', 'suppressed', 'wrong_owner_or_number', 'previously_closed'])
export const RECOVERY_CLASSIFIER_VERSION = 'recovery-classifier.v1'

/** Re-engagement programs a follow-up can belong to. Only those in `approved_programs` ever make a candidate eligible. */
export const RECOVERY_PROGRAMS = Object.freeze({
  enrolled_followup_cadence: 'An active seller_followup_state enrollment (the follow-up engine already owns the cadence).',
  not_interested_30d_nurture: 'Seller policy: "No" to selling → one follow-up after 30 days.',
})

export const RECOVERY_RULES = Object.freeze({
  nurture_days: 30,
  abandoned_negotiation_days: 14,
  old_price_days: 30,
  unanswered_grace_minutes: 60,
  demand_strong: 60,
})

const DAY = 86_400_000
const has = (set, xs) => xs.some((x) => set.has(x))

/** Every signal the sweep looks for. Pure; `economics` is the optional 8.5.19 classifyOpportunityEconomics result. */
export function detectRecoverySignals(f, { now = Date.now(), economics = null, rules = RECOVERY_RULES } = {}) {
  const intents = new Set(f.inbound.intents)
  const out = []
  const lastIn = ms(f.inbound.last?.at)
  const lastTouch = ms(latest(f.inbound.last?.at, f.outbound.last?.at, f.opportunity?.last_activity_at))
  const ask = f.opportunity?.asking_price ?? null

  if (has(intents, INTEREST_INTENTS)) out.push({ code: 'previous_selling_interest', intents: INTEREST_INTENTS.filter((i) => intents.has(i)) })
  if (has(intents, OFFER_REQUEST_INTENTS) && f.offers.sent === 0) out.push({ code: 'unanswered_offer_request' })
  const negotiating = f.opportunity && ['asking_price', 'property_condition', 'offer'].includes(f.opportunity.stage) && ['active', 'nurture'].includes(f.opportunity.status)
  if ((negotiating || has(intents, PRICE_INTENTS)) && lastTouch != null && now - lastTouch > rules.abandoned_negotiation_days * DAY) out.push({ code: 'abandoned_negotiation', idle_days: Math.floor((now - lastTouch) / DAY) })
  if ((ask != null && ask > 0) || has(intents, PRICE_INTENTS)) {
    if (lastIn != null && now - lastIn > rules.old_price_days * DAY) out.push({ code: 'old_price_expectation', asking_price: ask, age_days: Math.floor((now - lastIn) / DAY) })
  }
  const failed = f.outbound.failed_after_inbound + f.queue.failed_internal_after_inbound + f.queue.failed_provider_after_inbound
  if (failed > 0 && f.outbound.delivered_after_inbound === 0) {
    out.push({ code: 'failed_automated_response', provider_accepted: f.queue.failed_provider_after_inbound > 0 || f.outbound.failed_after_inbound > 0, internal_only: f.queue.failed_internal_after_inbound > 0 && f.queue.failed_provider_after_inbound === 0 && f.outbound.failed_after_inbound === 0 })
  } else if (f.queue.held_after_inbound > 0 && f.outbound.after_inbound === 0) {
    out.push({ code: 'failed_automated_response', held: true, provider_accepted: false, internal_only: true })
  }
  const lm = ms(f.inbound.last_meaningful?.at)
  if (sellerWaiting(f) && f.queue.pending === 0 && lm != null && now - lm > rules.unanswered_grace_minutes * 60_000) out.push({ code: 'unresolved_inbound', age_hours: Math.floor((now - lm) / 3_600_000) })
  const dueDates = [f.thread.follow_up_at, f.thread.next_action_at, f.followup_state.next_at].map(ms).filter((t) => t != null)
  const expired = dueDates.filter((t) => t < now)
  const future = dueDates.filter((t) => t >= now)
  if (expired.length && !future.length && f.queue.pending === 0) {
    const due = Math.max(...expired)
    const outAfter = ms(f.outbound.last?.at) != null && ms(f.outbound.last.at) > due
    if (!outAfter) out.push({ code: 'expired_followup_date', due_at: new Date(due).toISOString() })
  }
  // material new evidence (8.5.19 economics / a valuation newer than the conversation)
  const v = f.valuation
  if (v && ms(v.computed_at) != null && lastIn != null && ms(v.computed_at) > lastIn) {
    const ev = { code: 'material_new_evidence', valuation_newer_than_conversation: true }
    if (ask != null && v.investor_ceiling_high != null && ask <= v.investor_ceiling_high) ev.ask_within_buyer_ceiling = true
    if (v.buyer_demand_score != null && v.buyer_demand_score >= rules.demand_strong) ev.buyer_demand = 'strong'
    if (economics?.class) ev.economics_class = economics.class
    if (ev.ask_within_buyer_ceiling || ev.buyer_demand || ['HOT', 'NEGOTIATE'].includes(economics?.class)) out.push(ev)
  } else if (economics && ['HOT', 'NEGOTIATE'].includes(economics.class)) {
    out.push({ code: 'material_new_evidence', economics_class: economics.class })
  }
  return out
}

/** Which approved program (if any) covers a follow-up on this conversation. */
export function followupProgram(f, { now = Date.now(), rules = RECOVERY_RULES } = {}) {
  if (f.followup_state.active > 0) return 'enrolled_followup_cadence'
  const latestIntent = f.inbound.last_meaningful?.intent
  if (NOT_INTERESTED_INTENTS.includes(latestIntent) || f.thread.disposition === 'not_interested') {
    const at = ms(f.inbound.last_meaningful?.at || f.inbound.last?.at)
    if (at != null && now - at >= rules.nurture_days * DAY) return 'not_interested_30d_nurture'
  }
  return null
}

function evidenceRefs(f) {
  const refs = [{ source: 'public.inbox_thread_state', record_id: f.conversation_id }]
  if (f.inbound.last?.message_event_id) refs.push({ source: 'public.message_events', record_id: f.inbound.last.message_event_id, role: 'last_inbound' })
  if (f.inbound.last_meaningful?.message_event_id && f.inbound.last_meaningful.message_event_id !== f.inbound.last?.message_event_id) refs.push({ source: 'public.message_events', record_id: f.inbound.last_meaningful.message_event_id, role: 'last_meaningful_inbound' })
  if (f.outbound.last?.message_event_id) refs.push({ source: 'public.message_events', record_id: f.outbound.last.message_event_id, role: 'last_outbound' })
  if (f.opportunity?.opportunity_id) refs.push({ source: 'public.acquisition_opportunities', record_id: f.opportunity.opportunity_id })
  if (f.valuation?.pas_id) refs.push({ source: 'public.property_acquisition_scores', record_id: f.valuation.pas_id })
  return refs
}

/**
 * @param {object} f   normalizeConversationFacts(row)
 * @param {{ now?: number, approved_programs?: string[], economics?: object|null, rules?: object }} [o]
 */
export function classifyRecoveryCandidate(f, { now = Date.now(), approved_programs = [], economics = null, rules = RECOVERY_RULES } = {}) {
  const permission = verifyContactPermission(f)
  const detections = detectRecoverySignals(f, { now, economics, rules })
  const codes = new Set(detections.map((d) => d.code))
  const base = { version: RECOVERY_CLASSIFIER_VERSION, conversation_id: f.conversation_id, property_ref: f.property_ref, detections, permission, evidence_refs: evidenceRefs(f), program: null, economics_class: economics?.class ?? null }
  const done = (cls, reasons, extra = {}) => ({ ...base, class: cls, reasons, ...extra })

  // 1–2 contact permission first: nothing below may label a blocked conversation workable
  if (permission.suppression) return done('suppressed', permission.blocks.filter((b) => !['wrong_number', 'ownership_denied'].includes(b)))
  if (permission.wrong_owner_or_number) return done('wrong_owner_or_number', permission.blocks)
  // 3 closed deals (a seller message after the close reopens the evaluation)
  const closed = closedVerdict(f)
  if (closed.closed) return done('previously_closed', ['closed_without_newer_seller_message', ...(closed.after_not_interested ? ['closed_after_not_interested_policy_says_30_day_follow_up'] : [])])
  const reopened = closed.reopened ? ['reopened_by_seller_after_close'] : []

  // 4 a person must look, whatever the signals
  const intents = new Set(f.inbound.intents)
  if (has(intents, HOSTILE_INTENTS)) return done('needs_human_review', [...reopened, 'hostile_or_legal_language'])
  if (has(intents, RELATIONSHIP_REVIEW_INTENTS)) return done('needs_human_review', [...reopened, 'third_party_respondent'])
  if (f.inbound.last_meaningful?.intent === 'who_is_this' && sellerWaiting(f)) return done('needs_human_review', [...reopened, 'identity_question_unanswered'])
  if (languageSupported(f) === false) return done('needs_human_review', [...reopened, 'language_without_approved_copy'])

  if (!detections.length) return done('currently_unworkable', [...reopened, 'no_recovery_signal'])
  if (economics?.class === 'PASS') return done('currently_unworkable', [...reopened, 'economics_pass'])

  // 5a "No" to selling: policy is ONE follow-up after 30 days, not a reply — never "unanswered"
  const latestNotInterested = NOT_INTERESTED_INTENTS.includes(f.inbound.last_meaningful?.intent) || (!f.inbound.last_meaningful && f.thread.disposition === 'not_interested')
  const program = followupProgram(f, { now, rules })
  if (latestNotInterested && !program && !codes.has('material_new_evidence')) return done('currently_unworkable', [...reopened, 'inside_not_interested_nurture_window'])

  // 5b the seller is waiting on us, or our reply failed: a human answers (an old reply is not consent for a new text)
  if (codes.has('failed_automated_response')) {
    const d = detections.find((x) => x.code === 'failed_automated_response')
    return done('needs_human_review', [...reopened, d.provider_accepted ? 'reply_failed_after_provider_accepted_never_resend_automatically' : 'reply_failed_before_provider'])
  }
  if (codes.has('unresolved_inbound') && !latestNotInterested) return done('needs_human_review', [...reopened, codes.has('unanswered_offer_request') ? 'offer_request_unanswered' : 'seller_message_unanswered'])

  // 6 follow-ups: only inside an APPROVED program, only with permission verified (incl. ownership)
  if (codes.has('expired_followup_date') || program === 'not_interested_30d_nurture') {
    if (!program) return done('needs_human_review', [...reopened, 'followup_date_expired_without_program'])
    if (!approved_programs.includes(program)) return done('needs_human_review', [...reopened, 'no_approved_reengagement_scope'], { program })
    if (!permission.permitted) return done('needs_human_review', [...reopened, 'permission_not_verified'], { program })
    if (permission.ownership !== 'confirmed') return done('needs_human_review', [...reopened, 'ownership_unverified'], { program })
    return done('eligible_for_approved_followup', [...reopened, `approved_program:${program}`], { program })
  }

  // 7 viable history / new evidence → research before anyone re-contacts
  const viable = ['previous_selling_interest', 'unanswered_offer_request', 'abandoned_negotiation', 'old_price_expectation', 'material_new_evidence'].filter((c) => codes.has(c))
  if (viable.length) return done('research_worthy', [...reopened, ...viable])
  return done('currently_unworkable', [...reopened, 'signals_not_actionable'])
}

/** Priority for ordering review items: deterministic, evidence-based (higher first). */
export function recoveryPriority(c) {
  const codes = new Set(c.detections.map((d) => d.code))
  let p = 0
  if (codes.has('unanswered_offer_request')) p += 40
  if (codes.has('unresolved_inbound')) p += 30
  if (codes.has('failed_automated_response')) p += 30
  if (codes.has('material_new_evidence')) p += 25
  if (codes.has('abandoned_negotiation')) p += 20
  if (codes.has('previous_selling_interest')) p += 15
  if (codes.has('old_price_expectation')) p += 5
  if (c.economics_class === 'HOT') p += 30
  if (c.economics_class === 'NEGOTIATE') p += 15
  return p
}

export { stageRank }
