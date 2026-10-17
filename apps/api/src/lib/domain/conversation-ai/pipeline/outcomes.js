// DECISION OUTCOMES (8.5.16 native engine). A decision is a PLAN: zero or more compatible
// internal actions plus AT MOST ONE terminal / outbound action.
export const PIPELINE_VERSION = 'conv-ai.pipeline.v2'

export const ACTIONS = Object.freeze({
  NO_RESPONSE: 'NO_RESPONSE',
  DETERMINISTIC_REPLY: 'DETERMINISTIC_REPLY', // the existing template path, no model cost
  AI_GENERATED_REPLY: 'AI_GENERATED_REPLY',
  UPDATE_SELLER_FACTS: 'UPDATE_SELLER_FACTS',
  SCHEDULE_FOLLOWUP: 'SCHEDULE_FOLLOWUP',
  RESEARCH_PROPERTY: 'RESEARCH_PROPERTY',
  PREPARE_OFFER: 'PREPARE_OFFER', // delegated to the NegotiationAuthority (rc-8.5.19)
  NEGOTIATE_WITHIN_AUTHORITY: 'NEGOTIATE_WITHIN_AUTHORITY', // delegated likewise
  ESCALATE_TO_OPERATOR: 'ESCALATE_TO_OPERATOR',
  HOLD: 'HOLD',
  SUPPRESS: 'SUPPRESS',
})
export const ALL_ACTIONS = Object.freeze(Object.values(ACTIONS))

// internal = may combine with anything except SUPPRESS (which only takes UPDATE_SELLER_FACTS)
export const INTERNAL_ACTIONS = new Set([ACTIONS.UPDATE_SELLER_FACTS, ACTIONS.SCHEDULE_FOLLOWUP, ACTIONS.RESEARCH_PROPERTY])
// terminal = exactly one per plan; the outbound ones put words in front of a seller
export const TERMINAL_ACTIONS = new Set([ACTIONS.NO_RESPONSE, ACTIONS.DETERMINISTIC_REPLY, ACTIONS.AI_GENERATED_REPLY, ACTIONS.PREPARE_OFFER, ACTIONS.NEGOTIATE_WITHIN_AUTHORITY, ACTIONS.ESCALATE_TO_OPERATOR, ACTIONS.HOLD, ACTIONS.SUPPRESS])
export const OUTBOUND_ACTIONS = new Set([ACTIONS.DETERMINISTIC_REPLY, ACTIONS.AI_GENERATED_REPLY, ACTIONS.NEGOTIATE_WITHIN_AUTHORITY])

/**
 * Compatible internal updates are allowed; conflicting outbound actions are not.
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function validatePlan(actions = []) {
  const reasons = []
  const types = actions.map((a) => a?.type)
  for (const t of types) if (!ALL_ACTIONS.includes(t)) reasons.push(`unknown_action:${t}`)
  const terminal = types.filter((t) => TERMINAL_ACTIONS.has(t))
  if (terminal.length !== 1) reasons.push(`terminal_actions:${terminal.length}`)
  if (types.filter((t) => OUTBOUND_ACTIONS.has(t)).length > 1) reasons.push('conflicting_outbound_actions')
  if (types.includes(ACTIONS.SUPPRESS)) {
    const extra = types.filter((t) => t !== ACTIONS.SUPPRESS && t !== ACTIONS.UPDATE_SELLER_FACTS)
    if (extra.length) reasons.push(`suppress_conflicts_with:${extra.join(',')}`)
  }
  if (types.includes(ACTIONS.SCHEDULE_FOLLOWUP) && (types.includes(ACTIONS.SUPPRESS) || actions.some((a) => a?.type === ACTIONS.UPDATE_SELLER_FACTS && a?.facts?.ownership === 'denied'))) reasons.push('followup_after_stop_or_ownership_denial')
  if (new Set(types).size !== types.length) reasons.push('duplicate_action')
  return { ok: reasons.length === 0, reasons }
}
