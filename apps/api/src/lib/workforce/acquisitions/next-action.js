// The next action for one opportunity (acq.next_action). Pure.
//
// Derived from the verified stage, the Inbound Action Center state, holds / exclusions and the CFO
// verdict. The result is ONE of a closed set, and none of them is seller-facing in Phase A:
//   research | underwrite | await_seller | prepare_offer_recommendation (internal only) |
//   operator_review | hold | none
// A seller who is waiting on us needs a PERSON (operator_review): Workforce cannot answer a seller.

export const NEXT_ACTIONS = Object.freeze(['research', 'underwrite', 'await_seller', 'prepare_offer_recommendation', 'operator_review', 'hold', 'none'])
const PRICE_STAGES = new Set(['asking_price', 'property_condition', 'offer'])

/**
 * @param {{ conv?: object|null, decision?: object|null, cfo?: object|null, research?: object|null, escalated?: boolean }} o
 * @returns {{ action: string, reasons: string[] }}
 */
export function deriveNextAction({ conv = null, decision = null, cfo = null, research = null, escalated = false } = {}) {
  const r = (action, ...reasons) => Object.freeze({ action, reasons })
  if (conv?.excluded) return r('none', `excluded:${String(conv.excluded).toLowerCase()}`)
  if (conv?.held) return r('hold', 'automation_hold')
  if (conv?.suppressed === true || conv?.contact_permitted === false || conv?.action_state === 'suppressed_ineligible') return r('none', 'contact_not_permitted')
  if (conv?.action_state === 'resolved') return r('none', 'deal_closed')
  if (escalated) return r('operator_review', 'escalated_to_ceo')
  if (conv?.action_state === 'awaiting_operator_decision') return r('operator_review', 'pending_operator_decision')
  if (conv?.action_state === 'needs_attention') return r('operator_review', conv?.seller_spoke_last ? 'seller_waiting_on_us' : 'unowned_next_step')

  const verdict = cfo?.verdict || null
  const researchDone = research ? research.needed === false || research.result_received === true || research.state === 'completed' : false
  if (!decision || decision.status === 'not_run' || verdict === 'insufficient_evidence') {
    return researchDone ? r('underwrite', 'evidence_insufficient_after_research') : r('research', decision ? 'evidence_insufficient' : 'no_decision')
  }
  if (verdict === 'challenge') {
    if ((cfo.reasons || []).includes('ASK_FAR_ABOVE_MAO')) return r('operator_review', 'ask_far_above_mao')
    return r('underwrite', ...((cfo.reasons || []).slice(0, 3).map((x) => `cfo:${String(x).toLowerCase()}`)))
  }
  if (['ai_handling', 'waiting_on_seller', 'scheduled_follow_up', 'negotiating', 'researching'].includes(conv?.action_state)) return r('await_seller', `action_state:${conv.action_state}`)
  const stage = conv?.action?.verified_stage || null
  if (verdict === 'supported' && PRICE_STAGES.has(stage)) return r('prepare_offer_recommendation', 'cfo_supported', `stage:${stage}`)
  if (verdict === 'supported') return r('await_seller', 'cfo_supported_stage_before_price')
  return r('operator_review', 'no_clear_next_action')
}
