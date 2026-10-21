// Inbound Action Center (8.5.20 part C, Phase 9) — one durable operational state
// per conversation, derived from REAL events only.
//
// Exactly one of:
//   needs_attention             nobody owns the next step (the ACTIVE queue)
//   ai_handling                 the seller spoke last and a reply is already queued
//   researching                 an open research work item covers it
//   negotiating                 a live opportunity in asking_price … offer with a next action
//   awaiting_operator_decision  a pending approval or an open review item
//   scheduled_follow_up         a future follow-up / queued send after our last word
//   waiting_on_seller           we spoke last, inside the reply window
//   resolved                    the deal closed (no seller message since)
//   suppressed_ineligible       opt-out / suppression / wrong number / ownership denied
//
// A conversation LEAVES the active queue only when its next action is assigned
// (owner), scheduled (due date) or completed (resolved / suppressed). The unread
// flag, the inbox bucket and the archive flag are NOT inputs: an archived
// conversation with an unanswered seller message is still needs_attention.
import { verifyContactPermission, sellerWaiting, closedVerdict, stageRank, ms, latest, INTEREST_INTENTS, NOT_INTERESTED_INTENTS } from './conversation-facts.js'

export const ACTION_STATES = Object.freeze(['needs_attention', 'ai_handling', 'researching', 'negotiating', 'awaiting_operator_decision', 'scheduled_follow_up', 'waiting_on_seller', 'resolved', 'suppressed_ineligible'])
export const ACTION_STATE_LABELS = Object.freeze({
  needs_attention: 'Needs Attention', ai_handling: 'AI Handling', researching: 'Researching', negotiating: 'Negotiating',
  awaiting_operator_decision: 'Awaiting Operator Decision', scheduled_follow_up: 'Scheduled Follow-Up', waiting_on_seller: 'Waiting on Seller',
  resolved: 'Resolved', suppressed_ineligible: 'Suppressed / Ineligible',
})
/** The active queue: no owner, no schedule, not completed. */
export const ACTIVE_QUEUE_STATES = Object.freeze(['needs_attention'])
export const ACTION_CENTER_VERSION = 'action-center.v1'

export const ACTION_RULES = Object.freeze({
  /** we spoke last: how long the seller has before silence needs a person (engaged sellers only) */
  wait_hours: 72,
  /** an unanswered meaningful inbound older than this is "lost" (nobody picked it up) */
  lost_after_minutes: 60,
  negotiation_idle_days: 14,
  /** a queued reply scheduled further in the past than this is stuck, not "AI handling" */
  queued_reply_stale_minutes: 60,
})

const HOUR = 3_600_000
const NEGOTIATION_STAGES = ['asking_price', 'property_condition', 'offer']

/**
 * The stage the pipeline can stand behind. Offer needs a recorded offer event;
 * formal_contract and later need a live closing case; anything else is evidence
 * only (a parsed reply never verifies a stage).
 */
export function verifiedStage(f) {
  const o = f.opportunity
  if (!o?.stage) return { stage: f.thread.seller_stage || null, verified: false, source: f.thread.seller_stage ? 'thread_evidence' : null, reason: o ? 'opportunity_stage_missing' : 'no_opportunity' }
  const r = stageRank(o.stage)
  if (o.stage === 'closed') return { stage: 'closed', verified: true, source: 'opportunity', reason: null }
  if (r >= stageRank('formal_contract') && !f.live_closing_case) return { stage: 'property_condition', verified: false, source: 'projection', reason: 'contract_stage_without_live_closing_case', recorded_stage: o.stage }
  if (r === stageRank('offer') && f.offers.sent === 0) return { stage: 'property_condition', verified: false, source: 'projection', reason: 'offer_stage_without_offer_event', recorded_stage: o.stage }
  return { stage: o.stage, verified: true, source: 'opportunity', reason: null }
}

function priorityReason(f, state, extra = []) {
  const parts = [...extra]
  const intents = new Set(f.inbound.intents)
  if (f.opportunity?.temperature === 'hot' || f.thread.is_hot) parts.push('hot')
  if (INTEREST_INTENTS.some((i) => intents.has(i))) parts.push('selling_interest_on_record')
  if (f.opportunity?.promotion_reason) parts.push(`promotion:${String(f.opportunity.promotion_reason).slice(0, 60)}`)
  if (f.opportunity?.priority) parts.push(`priority:${String(f.opportunity.priority).slice(0, 20)}`)
  if (!parts.length) parts.push(state === 'needs_attention' ? 'unowned_conversation' : 'routine')
  return [...new Set(parts)].join(', ')
}

function evidenceRefs(f, approvals = []) {
  const refs = []
  if (f.inbound.last?.message_event_id) refs.push({ source: 'public.message_events', record_id: f.inbound.last.message_event_id, role: 'last_inbound' })
  if (f.outbound.last?.message_event_id) refs.push({ source: 'public.message_events', record_id: f.outbound.last.message_event_id, role: 'last_outbound' })
  if (f.opportunity?.opportunity_id) refs.push({ source: 'public.acquisition_opportunities', record_id: f.opportunity.opportunity_id })
  if (f.valuation?.pas_id) refs.push({ source: 'public.property_acquisition_scores', record_id: f.valuation.pas_id, role: 'underwriting' })
  for (const a of approvals.slice(0, 5)) refs.push({ source: 'agent.approval_request', approval_id: a.approval_id })
  return refs
}

/**
 * @param {object} f  normalizeConversationFacts(row)
 * @param {{ now?: number, approvals?: Array<{ approval_id, capability_id, expires_at }>, work?: Array<{ work_item_id, kind, state }>, rules?: object }} [o]
 *   approvals: PENDING approvals whose target is this conversation's opportunity
 *   work:      work items for this conversation; only state 'acknowledged' assigns an owner
 */
export function deriveActionState(f, { now = Date.now(), approvals = [], work = [], rules = ACTION_RULES } = {}) {
  const permission = verifyContactPermission(f)
  const stage = verifiedStage(f)
  const lastIn = ms(f.inbound.last?.at)
  const lastOut = ms(f.outbound.last?.at)
  const lm = ms(f.inbound.last_meaningful?.at)
  const waiting = sellerWaiting(f)
  const futureDates = [f.thread.follow_up_at, f.thread.next_action_at, f.followup_state.next_at, f.queue.next_pending_at].map(ms).filter((t) => t != null && t >= now)
  const nextScheduled = futureDates.length ? new Date(Math.min(...futureDates)).toISOString() : null
  // Only an ACKNOWLEDGED work item is an assignment (an operator / research mission took it).
  // An item the reconcilers opened themselves assigns nothing: it would otherwise hide the
  // very conversation it reports.
  const reviewWork = work.filter((w) => w.kind !== 'recovery_research' && w.state === 'acknowledged')
  const researchWork = work.filter((w) => w.kind === 'recovery_research' && w.state === 'acknowledged')
  const out = (state, o) => ({
    version: ACTION_CENTER_VERSION,
    conversation_id: f.conversation_id,
    property_ref: f.property_ref,
    opportunity_id: f.opportunity?.opportunity_id || null,
    state,
    owner: o.owner,
    verified_stage: stage.stage,
    stage_verified: stage.verified,
    stage_note: stage.reason,
    next_action: o.next_action,
    due_at: o.due_at ?? null,
    priority_reason: priorityReason(f, state, o.priority || []),
    evidence_refs: evidenceRefs(f, approvals),
    pending_approvals: approvals.map((a) => a.approval_id).slice(0, 10),
    lost: o.lost === true,
    reasons: o.reasons,
    last_inbound_at: f.inbound.last?.at || null,
    last_outbound_at: f.outbound.last?.at || null,
    derived_from: { last_inbound_id: f.inbound.last?.message_event_id || null, last_outbound_id: f.outbound.last?.message_event_id || null, cursor_at: f.cursor_at },
  })

  // completed: contact not permitted
  if (!permission.permitted) return out('suppressed_ineligible', { owner: 'none', next_action: 'none: contact not permitted', reasons: permission.blocks })
  // completed: closed deal, nothing newer from the seller
  const closed = closedVerdict(f)
  if (closed.closed) return out('resolved', { owner: 'none', next_action: 'none: deal closed', reasons: ['closed_without_newer_seller_message'] })

  // assigned: a person must decide (pending approval / open review item)
  if (approvals.length) return out('awaiting_operator_decision', { owner: 'operator', next_action: `decide approval ${approvals[0].capability_id}`, due_at: approvals.map((a) => a.expires_at).filter(Boolean).sort()[0] || null, reasons: ['pending_approval'], priority: ['approval_pending'] })
  if (reviewWork.length) return out('awaiting_operator_decision', { owner: 'operator', next_action: `review ${reviewWork[0].kind}`, due_at: reviewWork[0].due_at || null, reasons: reviewWork.map((w) => `open_work_item:${w.kind}`).slice(0, 5) })

  // the seller spoke last
  const lmNotInterested = NOT_INTERESTED_INTENTS.includes(f.inbound.last_meaningful?.intent)
  if (waiting && lmNotInterested) {
    // seller policy: "No" to selling is answered by ONE follow-up after 30 days, not by a reply
    if (nextScheduled) return out('scheduled_follow_up', { owner: f.queue.pending > 0 ? 'send_queue' : 'followup_engine', next_action: '30-day follow-up', due_at: nextScheduled, reasons: ['not_interested_follow_up_scheduled'] })
    const lost = lm != null && now - lm > rules.lost_after_minutes * 60_000
    return out('needs_attention', { owner: 'none', next_action: 'schedule the 30-day follow-up', due_at: new Date((lm ?? now) + 30 * 86_400_000).toISOString(), reasons: ['not_interested_without_scheduled_follow_up'], lost })
  }
  if (waiting) {
    const pendingAt = ms(f.queue.next_pending_at)
    // a queued reply counts only while it is live: one stuck in the past is nobody's next action
    if (f.queue.pending > 0 && pendingAt != null && pendingAt >= now - rules.queued_reply_stale_minutes * 60_000) return out('ai_handling', { owner: 'send_queue', next_action: 'queued reply', due_at: f.queue.next_pending_at, reasons: ['reply_queued_after_seller_message'] })
    if (researchWork.length) return out('researching', { owner: 'agent_research', next_action: 'research before reply', due_at: researchWork[0].due_at || null, reasons: ['open_research_item'] })
    const failed = f.outbound.failed_after_inbound + f.queue.failed_internal_after_inbound + f.queue.failed_provider_after_inbound
    const reasons = ['meaningful_inbound_without_next_action']
    if (failed > 0) reasons.push(f.queue.failed_provider_after_inbound > 0 || f.outbound.failed_after_inbound > 0 ? 'reply_failed_after_provider_accepted' : 'reply_failed_before_provider')
    if (f.queue.held_after_inbound > 0) reasons.push('reply_held_by_guard')
    if (f.queue.pending > 0) reasons.push('queued_reply_overdue')
    if (futureDates.length) reasons.push('only_a_later_follow_up_is_scheduled')
    const lost = lm != null && now - lm > rules.lost_after_minutes * 60_000
    return out('needs_attention', { owner: 'none', next_action: 'answer the seller', due_at: f.inbound.last_meaningful.at, reasons, lost, priority: ['seller_waiting'] })
  }

  if (researchWork.length) return out('researching', { owner: 'agent_research', next_action: 'research', due_at: researchWork[0].due_at || null, reasons: ['open_research_item'] })

  // a live negotiation with a next action that someone owns
  const o = f.opportunity
  if (o && NEGOTIATION_STAGES.includes(o.stage) && ['active', 'nurture'].includes(o.status)) {
    if (o.next_action && o.next_action_due) return out('negotiating', { owner: 'operator', next_action: o.next_action, due_at: o.next_action_due, reasons: ['live_negotiation'] })
    if (!nextScheduled) return out('needs_attention', { owner: 'none', next_action: 'set the negotiation next action', due_at: null, reasons: ['negotiation_without_next_action'] })
  }

  if (nextScheduled) return out('scheduled_follow_up', { owner: f.queue.pending > 0 ? 'send_queue' : 'followup_engine', next_action: 'scheduled follow-up', due_at: nextScheduled, reasons: ['future_follow_up'] })

  // we spoke last
  const engaged = INTEREST_INTENTS.some((i) => f.inbound.intents.includes(i)) || (o && ['active', 'nurture'].includes(o.status) && stageRank(o.stage) >= stageRank('asking_price'))
  const notInterested = NOT_INTERESTED_INTENTS.includes(f.inbound.last_meaningful?.intent) || f.thread.disposition === 'not_interested'
  if (lastOut != null && (lastIn == null || lastOut >= lastIn)) {
    const windowEnd = lastOut + rules.wait_hours * HOUR
    if (notInterested) return out('needs_attention', { owner: 'none', next_action: 'schedule the 30-day follow-up', due_at: null, reasons: ['not_interested_without_scheduled_follow_up'] })
    if (now <= windowEnd || !engaged) return out('waiting_on_seller', { owner: 'seller', next_action: 'await seller reply', due_at: new Date(windowEnd).toISOString(), reasons: [now <= windowEnd ? 'inside_reply_window' : 'no_engagement_on_record'] })
    return out('needs_attention', { owner: 'none', next_action: 'follow up the silence', due_at: new Date(windowEnd).toISOString(), reasons: ['engaged_seller_silent_without_follow_up'] })
  }
  // the last inbound was not meaningful (reaction / acknowledgement) and nothing followed
  return out('waiting_on_seller', { owner: 'seller', next_action: 'await seller reply', due_at: null, reasons: ['last_inbound_not_actionable'] })
}

/** Lost-conversation detector: a meaningful inbound older than the grace with no next action of any kind. */
export function isLostConversation(state) {
  return state.state === 'needs_attention' && state.lost === true
}

export function summarizeActionStates(states) {
  const counts = Object.fromEntries(ACTION_STATES.map((s) => [s, 0]))
  let lost = 0
  for (const s of states) { counts[s.state] += 1; if (isLostConversation(s)) lost += 1 }
  return { counts, active_queue: ACTIVE_QUEUE_STATES.reduce((n, s) => n + counts[s], 0), lost, total: states.length }
}

export { latest }
