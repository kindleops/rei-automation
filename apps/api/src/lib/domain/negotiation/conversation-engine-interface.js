// ═══════════════════════════════════════════════════════════════════════════
// LeadCommand 8.5.19 → 8.5.16 CONVERSATION ENGINE INTERFACE (the ONE file the
// native AI conversation engine imports for money, authority and feedback).
// Contract version: lc.negotiation-interface.v1
//
// DECISION OUTCOMES HANDLED: PREPARE_OFFER, NEGOTIATE_WITHIN_AUTHORITY.
// Any other outcome is not ours (handleDecisionOutcome returns escalate).
//
// ── handleDecisionOutcome(outcome, context, deps) / preparePosition(context, deps)
//   context  { thread_key, property_id, opportunity_id?,            (one scope; never mixed)
//              seller_request?: { kind?: 'asks_offer'|'counter'|'terms'|'creative_terms'|'financing',
//                                 amount?: number|null,              (seller's number THIS turn)
//                                 terms?: { closing_days?, earnest_money?, as_is?,
//                                           repairs_by_buyer_before_close?, closing_costs_paid_by?,
//                                           structure?, contingencies? } },
//              fact_ledger?: the thread ledger (conversation-ai/ledger.js: canonical, or its factLedgerOf() view),
//              economics?: a precomputed classifyOpportunity() result,
//              now? }
//   deps     createNegotiationRuntime({ supabase, refs }) in production; tests inject
//            { store: createMemoryNegotiationStore(), assessEconomics }.
//   returns  { contract_version: 'negotiation.position.v1',
//              status: 'needs_envelope' | 'within_authority' | 'escalate',
//              move: null | { kind: 'open'|'counter'|'final'|'agree_at_seller_price'|'hold',
//                             amount: number|null (≤ envelope max, ALWAYS), quote_type,
//                             ledger_event_type, moves_left_after,
//                             justification: string[] (INTERNAL ONLY — never to the seller) },
//              allowed_terms?: { closing_window_days:[min,max], earnest_money:[min,max], as_is, closing_costs_paid_by },
//              forbidden_claims: string[]   (cash availability, proof of funds, guaranteed close …),
//              envelope_ref: { envelope_id, version, expires_at } | null,
//              proposed_envelope: null | { operator_only: true, recommendation, proposal, underwriting },
//              escalation: null | { reasons: string[], operator_action },
//              economics: { class, reasons, uncertainty } | null, ledger: {...}, notes: string[] }
//
//   ENGINE RULES (binding on the 8.5.16 caller):
//     • status !== 'within_authority' ⇒ the draft carries NO amount. needs_envelope ⇒ route the
//       proposed_envelope to an operator; escalate ⇒ NEEDS_REVIEW with escalation.reasons.
//     • within_authority ⇒ the draft may state exactly move.amount (or none, for 'hold') and only
//       allowed_terms; never comps, never forbidden_claims; the send path persists the formal offer
//       via seller-offer-authority.persistActiveOffer(toSellerOfferArgs(...)) BEFORE the send and then
//       recordNegotiationEvent({ event: { event_type: move.ledger_event_type, actor:'engine',
//       authority:'within_envelope', envelope_id, amount, seller_offer_id } }).
//     • seller numbers are recorded as seller_ask / seller_counter events (actor 'seller').
//
// ── classifyOpportunity({ supabase, property_id, ledger, … })  → HOT|NEGOTIATE|NURTURE|PASS|INVESTIGATE
//    with metrics, evidence, uncertainty (read-only; opportunity-economics/economics-service.js).
//    classifyOpportunityEconomics(input) is the pure form.
//
// ── recordOperatorFeedback(input, { store })  append-only (ai_operator_feedback), linked by
//    ai_message_id (= ai_generated_messages.id from 8.5.16) and/or decision_id.
//    Kinds: draft_generated | draft_approved | draft_rejected | draft_edited | operator_note |
//           seller_response | negotiation_outcome | acquisition_outcome.
//    Feedback NEVER changes production behaviour; prompts / playbooks change only by versioned PR.
// ═══════════════════════════════════════════════════════════════════════════
import { preparePosition, recordNegotiationEvent, loadThreadFactLedger } from './negotiation-service.js'
import { createSupabaseNegotiationStore } from './store.js'
import { toSellerOfferArgs } from './ledger.js'
import { assessOpportunityEconomics } from '../opportunity-economics/economics-service.js'
import { classifyOpportunityEconomics, ECONOMICS_CLASSES } from '../opportunity-economics/classify-opportunity.js'
import { recordOperatorFeedback, createSupabaseFeedbackStore, FEEDBACK_KINDS } from '../operator-feedback/feedback.js'
import { POSITION_STATUSES, FORBIDDEN_CLAIMS } from './position.js'

export const NEGOTIATION_INTERFACE_VERSION = 'lc.negotiation-interface.v1'
export const DECISION_OUTCOMES_HANDLED = Object.freeze(['PREPARE_OFFER', 'NEGOTIATE_WITHIN_AUTHORITY'])

/**
 * The 8.5.16 engine calls this for PREPARE_OFFER and NEGOTIATE_WITHIN_AUTHORITY.
 * @returns {Promise<{ outcome: string, position: object, next: 'compose_with_authorized_move'|'route_envelope_request_to_operator'|'escalate_to_operator' }>}
 */
export async function handleDecisionOutcome(outcome, context, deps) {
  if (!DECISION_OUTCOMES_HANDLED.includes(outcome)) {
    return { outcome, position: { contract_version: 'negotiation.position.v1', status: 'escalate', move: null, escalation: { reasons: [`outcome_not_handled:${String(outcome).slice(0, 40)}`], operator_action: 'review_and_decide' }, forbidden_claims: [...FORBIDDEN_CLAIMS] }, next: 'escalate_to_operator' }
  }
  const request = outcome === 'PREPARE_OFFER' ? { kind: 'asks_offer', ...(context?.seller_request || {}) } : context?.seller_request || {}
  const position = await preparePosition({ ...context, seller_request: request }, deps)
  const next = position.status === 'within_authority' ? 'compose_with_authorized_move' : position.status === 'needs_envelope' ? 'route_envelope_request_to_operator' : 'escalate_to_operator'
  return { outcome, position, next }
}

/** Production deps: the Supabase negotiation store + read-only economics. */
export function createNegotiationRuntime({ supabase, getMarketDemand = null }) {
  const store = createSupabaseNegotiationStore({ supabase })
  return Object.freeze({
    store,
    assessEconomics: ({ property_id, thread_key, ledger, now }) => assessOpportunityEconomics({ supabase, property_id, thread_key, ledger, getMarketDemand, now }),
    feedbackStore: createSupabaseFeedbackStore({ supabase }),
  })
}

export const classifyOpportunity = assessOpportunityEconomics

export {
  preparePosition,
  recordNegotiationEvent,
  loadThreadFactLedger,
  toSellerOfferArgs,
  classifyOpportunityEconomics,
  recordOperatorFeedback,
  ECONOMICS_CLASSES,
  FEEDBACK_KINDS,
  POSITION_STATUSES,
  FORBIDDEN_CLAIMS,
}
