// Pipeline reconciliation (8.5.20 part C). Every LIVE opportunity (status active |
// nurture) must have: a verified stage (projection-consistent), a next action, a
// due date and a priority reason. Mismatches become findings; a stage that is not
// what the events support becomes a PROPOSED stage change through the approvals
// plane (pipeline.propose_stage_change → on approval transitionOpportunityStage,
// whose money / contract guard runs again). Nothing here writes a stage.
//
// Projection rules are the pipeline's own (opportunity/stage-advance-guard.js):
//   offer            needs a recorded, valid offer event (seller_offers → offerEventFromSellerOffer + validateOfferEvent)
//   formal_contract+ needs a live closing case (or the closing authority)
//   closed           closing authority only — never proposed
// Thread stages (parsed replies) are evidence: an advance BELOW offer may be
// proposed when evaluateStageAdvance agrees; never at or above offer.
import { evaluateStageAdvance, offerEventFromSellerOffer, validateOfferEvent } from '../../domain/opportunity/stage-advance-guard.js'
import { encodePropertyRef } from '../missions/mission-codec.js'
import { STAGES, stageRank, ms } from './conversation-facts.js'

export const PIPELINE_RECONCILER_VERSION = 'pipeline-reconciler.v1'
export const PIPELINE_RULES = Object.freeze({
  /** days in a stage before it counts as stagnant */
  stagnation_days: Object.freeze({ ownership_confirmation: 14, offer_interest: 21, asking_price: 10, property_condition: 10, offer: 7, formal_contract: 14, disposition: 21, under_contract: 30, prepared_to_close: 14 }),
  overdue_grace_hours: 24,
})
export const PIPELINE_ISSUES = Object.freeze(['stage_not_projection_consistent', 'missing_next_action', 'missing_due_date', 'overdue_next_action', 'missing_priority_reason', 'stagnant_stage', 'missing_valuation', 'contact_blocked_on_live_opportunity', 'evidence_ahead_of_stage'])

const DAY = 86_400_000
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const lower = (v) => String(v ?? '').trim().toLowerCase()

export function normalizeOpportunityFacts(r = {}) {
  const offers = Array.isArray(r.offer_rows) ? r.offer_rows : typeof r.offer_rows === 'string' ? JSON.parse(r.offer_rows || '[]') : []
  return {
    opportunity_id: String(r.opportunity_id),
    stage: lower(r.acquisition_stage) || null,
    status: lower(r.opportunity_status) || null,
    priority: r.priority ?? null,
    temperature: lower(r.temperature) || null,
    next_action: r.next_action ? String(r.next_action) : null,
    next_action_due: r.next_action_due ? new Date(r.next_action_due).toISOString() : null,
    promotion_reason: r.promotion_reason ? String(r.promotion_reason) : null,
    blocker: r.blocker ? String(r.blocker) : null,
    asking_price: num(r.asking_price), current_offer: num(r.current_offer), estimated_value: num(r.estimated_value), arv: num(r.arv),
    stage_entered_at: r.stage_entered_at ? new Date(r.stage_entered_at).toISOString() : null,
    last_activity_at: r.last_activity_at ? new Date(r.last_activity_at).toISOString() : null,
    property_ref: r.property_id ? encodePropertyRef(String(r.property_id)) : null,
    has_property: Boolean(r.property_id),
    market: r.market || null,
    conversation_id: r.conversation_id ? String(r.conversation_id) : null,
    thread_stage: lower(r.thread_stage) || null,
    thread_suppressed: r.thread_suppressed === true || r.thread_suppressed === 't',
    thread_contactability: lower(r.thread_contactability) || null,
    offer_rows: offers,
    live_closing_case: r.live_closing_case === true || r.live_closing_case === 't',
    pas_id: r.pas_id ? String(r.pas_id) : null,
  }
}

/** The stage the events support (null = the recorded stage is consistent). */
export function projectedStage(o) {
  const r = stageRank(o.stage)
  if (r < 0 || o.stage === 'closed') return { consistent: true, to_stage: null, rule: null, offer_events: [] }
  if (r >= stageRank('formal_contract')) {
    if (o.live_closing_case) return { consistent: true, to_stage: null, rule: null, offer_events: [] }
    return { consistent: false, to_stage: validOfferEvents(o).length ? 'offer' : 'property_condition', rule: 'CONTRACT_EVENT_REQUIRED', offer_events: [] }
  }
  if (r === stageRank('offer')) {
    const valid = validOfferEvents(o)
    if (valid.length) return { consistent: true, to_stage: null, rule: null, offer_events: valid.map((e) => e.id).filter(Boolean) }
    return { consistent: false, to_stage: 'property_condition', rule: 'OFFER_EVENT_REQUIRED', offer_events: [] }
  }
  return { consistent: true, to_stage: null, rule: null, offer_events: [] }
}

function validOfferEvents(o) {
  const out = []
  for (const row of o.offer_rows || []) {
    const ev = offerEventFromSellerOffer({ offer_id: row.offer_id, status: row.status, sent_at: row.sent_at, purchase_price: row.purchase_price, policy_version: row.policy_version, ade_snapshot_id: row.ade_snapshot_id, valuation_mid: row.valuation_mid, authorized_ceiling: row.authorized_ceiling, metadata: { offer_event: row.offer_event || {} }, opportunity_id: o.opportunity_id })
    if (ev && validateOfferEvent(ev, { estimated_value: o.estimated_value, arv: o.arv }).valid) out.push(ev)
  }
  return out
}

/**
 * @returns {{ opportunity_id, issues: Array<{ code, severity, detail? }>, proposal: { to_stage, reason } | null, ok: boolean }}
 */
export function reconcileOpportunity(o, { now = Date.now(), rules = PIPELINE_RULES } = {}) {
  const issues = []
  const proj = projectedStage(o)
  let proposal = null
  if (!proj.consistent) {
    issues.push({ code: 'stage_not_projection_consistent', severity: 'critical', detail: { recorded_stage: o.stage, projected_stage: proj.to_stage, rule: proj.rule } })
    proposal = { to_stage: proj.to_stage, reason: `Projection: ${o.stage} has no ${proj.rule === 'OFFER_EVENT_REQUIRED' ? 'recorded offer event' : 'live closing case'}; the events support ${proj.to_stage}.` }
  }
  if (!o.next_action) issues.push({ code: 'missing_next_action', severity: 'warning' })
  if (!o.next_action_due) issues.push({ code: 'missing_due_date', severity: 'warning' })
  else if (ms(o.next_action_due) < now - rules.overdue_grace_hours * 3_600_000) issues.push({ code: 'overdue_next_action', severity: 'warning', detail: { due_at: o.next_action_due, overdue_days: Math.floor((now - ms(o.next_action_due)) / DAY) } })
  if (!o.promotion_reason && !o.priority && !o.temperature) issues.push({ code: 'missing_priority_reason', severity: 'info' })
  const limit = rules.stagnation_days[o.stage]
  const entered = ms(o.stage_entered_at)
  if (limit && (entered == null || now - entered > limit * DAY)) issues.push({ code: 'stagnant_stage', severity: 'info', detail: { stage: o.stage, days_in_stage: entered == null ? null : Math.floor((now - entered) / DAY), threshold_days: limit } })
  if (o.has_property && !o.pas_id) issues.push({ code: 'missing_valuation', severity: 'info' })
  if (o.thread_suppressed || ['opted_out', 'do_not_text', 'do_not_contact', 'invalid_number'].includes(o.thread_contactability)) issues.push({ code: 'contact_blocked_on_live_opportunity', severity: 'warning', detail: { contactability: o.thread_contactability, suppressed: o.thread_suppressed } })
  // evidence ahead of the recorded stage (below offer only, and only when the pipeline guard agrees)
  if (!proposal && o.thread_stage && stageRank(o.thread_stage) > stageRank(o.stage) && stageRank(o.thread_stage) < stageRank('offer') && stageRank(o.thread_stage) >= 0) {
    const g = evaluateStageAdvance({ current: { acquisition_stage: o.stage, asking_price: o.asking_price, estimated_value: o.estimated_value, arv: o.arv, current_offer: o.current_offer }, to_stage: o.thread_stage, source: 'agent_approval' })
    if (g.ok) {
      issues.push({ code: 'evidence_ahead_of_stage', severity: 'info', detail: { recorded_stage: o.stage, evidence_stage: o.thread_stage } })
      proposal = { to_stage: o.thread_stage, reason: `Conversation evidence is at ${o.thread_stage}; recorded stage is ${o.stage}. Parsed text is evidence only: a person decides.` }
    }
  }
  if (proposal && (proposal.to_stage === 'closed' || !STAGES.includes(proposal.to_stage))) proposal = null
  return { version: PIPELINE_RECONCILER_VERSION, opportunity_id: o.opportunity_id, conversation_id: o.conversation_id, property_ref: o.property_ref, stage: o.stage, status: o.status, issues, proposal, ok: issues.length === 0 }
}
