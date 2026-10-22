// acq.next_action (read) — the next action for the opportunity at one rank position
// (acquisitions/next-action.js) from the upstream outputs: rank, conversation state, decision,
// research, CFO. The acting acquisition agent OWNS the thread / property while it works it
// (workforce.resource_claim, acquired by the dispatcher before this runs).
import { deriveNextAction } from '../acquisitions/next-action.js'
import { arr, decodePropertyRef, depOutput, done, obj, ref, usable } from './shared.js'

export const KEY = 'acq.next_action'

export const capability = Object.freeze({
  key: KEY,
  class: 'read',
  roles: Object.freeze(['acquisition_agent', 'head_acquisitions']),
  // decision-bearing: a price at/above the executive threshold, valuation uncertainty or title
  // ambiguity goes to the CEO instead
  escalates_on: Object.freeze(['price', 'valuation_uncertain', 'title_ambiguous']),
  claims: true,
  resourceOf: (_ctx, input) => (input.property_ref ? { property_id: decodePropertyRef(input.property_ref), opportunity_id: input.opportunity_id ?? null, conversation_id: input.conversation_id ?? null, market: input.market ?? null } : null),
  async run(ctx, input = {}) {
    const rank = depOutput(ctx, input.rank_step)
    const entry = arr(rank?.output?.ranked).find((x) => x.rank === Number(input.position)) || null
    if (!entry) return done({ position: Number(input.position) || null, action: null, noop: true, reason: 'no_candidate_at_position' })
    const conv = depOutput(ctx, input.conv_step)
    const dec = depOutput(ctx, input.dec_step)
    const fin = depOutput(ctx, input.fin_step)
    const res = input.res_step ? depOutput(ctx, input.res_step) : null
    const escalated = entry.escalated === true || (fin?.outcome_class === 'refused' && obj(fin.output).authority === 'escalate')
    const na = deriveNextAction({
      conv: usable(conv) || conv?.outcome_class === 'refused' ? conv.output : null,
      decision: usable(dec) ? dec.output : null,
      cfo: usable(fin) ? fin.output : null,
      research: res ? { ...obj(res.output), state: res.outcome_class === 'verified' ? 'completed' : null, result_received: Boolean(res.output && res.output.needed === undefined) } : null,
      escalated,
    })
    return done({
      position: entry.rank,
      property_ref: entry.property_ref,
      opportunity_id: entry.opportunity_id ?? null,
      conversation_id: entry.conversation_id ?? null,
      market: entry.market ?? null,
      action: na.action,
      reasons: na.reasons,
      cfo_verdict: entry.cfo_verdict ?? null,
      rank_assignment_id: rank.assignment_id,
    }, { outcome_class: rank.outcome_class === 'verified' ? 'verified' : 'partial', evidence: [ref('assignment', rank.assignment_id), conv ? ref('assignment', conv.assignment_id) : null, fin ? ref('assignment', fin.assignment_id) : null] })
  },
})
