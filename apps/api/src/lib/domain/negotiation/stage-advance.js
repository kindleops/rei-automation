// ─── Deal-stage advancement from negotiation evidence (8.5.19) ───────────────
// The pipeline stage is a PROJECTION of offer / contract / closing events
// (feedback_pipeline_is_projection). This module never writes a stage itself:
//   1  it builds the offer events the EXISTING guard understands
//      (stage-advance-guard.offerEventFromSellerOffer — seller_offers is the formal
//      offer authority) and runs evaluateStageAdvance() as a pre-check;
//   2  only when that passes, and only when the caller opts in (apply: true), it calls
//      the EXISTING domain service opportunity-service#transitionOpportunityStage,
//      which re-runs the same guard and the closing authority.
// Default is a dry run. Formal contract and later stages are refused here outright
// (Closing Desk only), whatever the ledger says.
import { evaluateStageAdvance, offerEventFromSellerOffer } from '../opportunity/stage-advance-guard.js'

const ENGINE_REACHABLE = new Set(['offer'])

/**
 * @param {object} a
 * @param {object} a.opportunity     acquisition_opportunities row (id, acquisition_stage, asking_price, …)
 * @param {string} a.to_stage        only 'offer' is reachable from negotiation evidence
 * @param {object[]} a.seller_offers seller_offers rows for the opportunity
 * @param {object} [a.valuation]     { valuation_mid, mao, units } for the guard's plausibility check
 * @param {boolean} [a.apply]        false (default) = evaluate only
 * @param {{ transitionOpportunityStage?: Function }} [deps]
 */
export async function advanceStageIfEvidenceSupports({ opportunity, to_stage, seller_offers = [], valuation = {}, apply = false, reason = 'negotiation_ledger_offer_event' }, deps = {}) {
  if (!opportunity?.id) return { ok: false, applied: false, code: 'OPPORTUNITY_REQUIRED' }
  if (!ENGINE_REACHABLE.has(String(to_stage || '').toLowerCase())) return { ok: false, applied: false, code: 'STAGE_NOT_REACHABLE_FROM_NEGOTIATION', detail: 'formal_contract and later are Closing Desk only' }
  const offer_events = (seller_offers || []).map(offerEventFromSellerOffer).filter(Boolean)
  const verdict = evaluateStageAdvance({ current: opportunity, to_stage, source: 'engine', offer_events, valuation })
  if (!verdict.ok) return { ok: false, applied: false, code: verdict.code, guard: verdict.guard }
  if (!apply) return { ok: true, applied: false, code: 'EVIDENCE_SUPPORTS_ADVANCE_DRY_RUN', offer_events: offer_events.length }
  const transition = deps.transitionOpportunityStage || (await import('@/lib/domain/opportunity/opportunity-service.js')).transitionOpportunityStage
  const r = await transition(opportunity.id, { to_stage, reason, source: 'engine', actor: 'negotiation_ledger' })
  return { ok: r?.ok !== false, applied: r?.ok !== false, code: r?.ok === false ? r.code || 'TRANSITION_REFUSED' : 'ADVANCED', result: r?.ok === false ? { code: r.code, error: r.error } : null }
}
