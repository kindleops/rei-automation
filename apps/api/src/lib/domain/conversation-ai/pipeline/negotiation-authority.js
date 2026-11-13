// NEGOTIATION AUTHORITY HOOK (8.5.16). PREPARE_OFFER and NEGOTIATE_WITHIN_AUTHORITY are
// delegated to an implementation of this interface; rc-8.5.19 (negotiation authority,
// opportunity economics, feedback capture) will provide the real one. Until then the STUB
// escalates every request to an operator: no offer, no amount, no counter is ever produced
// by the conversation engine.
//
// interface NegotiationAuthority {
//   version: string
//   prepareOffer(ctx): Promise<NegotiationResult>
//   negotiateWithinAuthority(ctx): Promise<NegotiationResult>
// }
// ctx: { thread_ref, inbound_message_id, ledger_summary, existing_offers, asking_price, request: 'offer_request'|'counter'|'price_and_condition_known' }
// NegotiationResult: { action: 'ESCALATE_TO_OPERATOR'|'DETERMINISTIC_REPLY'|'HOLD', reason: string,
//                      template_use_case?: string, authority_ref?: string }
// The result can NEVER be AI_GENERATED_REPLY: money language goes through an approved,
// authority-checked template (DETERMINISTIC_REPLY) or a human.
export const NEGOTIATION_AUTHORITY_INTERFACE_VERSION = 'negotiation-authority.v1'
const ALLOWED = new Set(['ESCALATE_TO_OPERATOR', 'DETERMINISTIC_REPLY', 'HOLD'])

export function createEscalatingNegotiationAuthority() {
  const escalate = (kind) => async () => ({ action: 'ESCALATE_TO_OPERATOR', reason: `${kind}_requires_negotiation_authority`, authority_ref: null })
  return Object.freeze({ version: 'stub-escalate.v1', prepareOffer: escalate('prepare_offer'), negotiateWithinAuthority: escalate('negotiate') })
}

export function assertNegotiationAuthority(impl) {
  if (!impl || typeof impl.prepareOffer !== 'function' || typeof impl.negotiateWithinAuthority !== 'function') throw new Error('NEGOTIATION_AUTHORITY_INVALID')
  return impl
}

/** Normalise an implementation's answer; anything outside the contract escalates. */
export function normalizeNegotiationResult(r) {
  if (!r || !ALLOWED.has(r.action)) return { action: 'ESCALATE_TO_OPERATOR', reason: 'negotiation_result_outside_contract' }
  return { action: r.action, reason: String(r.reason || r.action), template_use_case: r.template_use_case || null, authority_ref: r.authority_ref || null }
}
