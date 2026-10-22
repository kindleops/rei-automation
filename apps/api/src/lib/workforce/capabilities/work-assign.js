// work.assign (internal) — delegate the follow-on work a next action calls for, as a Workforce
// assignment (the human CEO queue included). Writes ONLY workforce.assignment rows. Nothing it creates
// can contact a seller: AI follow-ons are catalog capabilities (research.property), and everything a
// person must decide (operator review, an offer recommendation to review, underwriting) is a CEO queue
// item that the dispatcher parks for the human — it is never executed by an AI.
import { CapabilityError, decodePropertyRef, depOutput, done, ref } from './shared.js'

export const KEY = 'work.assign'

/** next action → the follow-on (null = nothing to delegate) */
export const FOLLOW_ON = Object.freeze({
  research: Object.freeze({ role: 'research_analyst', capability_key: 'research.property', task: 'research' }),
  underwrite: Object.freeze({ role: 'ceo', capability_key: KEY, task: 'underwrite_review' }),
  prepare_offer_recommendation: Object.freeze({ role: 'ceo', capability_key: KEY, task: 'review_offer_recommendation' }),
  operator_review: Object.freeze({ role: 'ceo', capability_key: KEY, task: 'operator_review' }),
  await_seller: null,
  hold: null,
  none: null,
})

export const capability = Object.freeze({
  key: KEY,
  class: 'internal',
  roles: Object.freeze(['coo', 'head_acquisitions', 'head_marketing', 'head_dispositions', 'head_data_intelligence']),
  // the next action it delegates has already passed authority (acq.next_action is the decision-bearing step)
  escalates_on: Object.freeze([]),
  resourceOf: (_ctx, input) => (input.property_ref ? { property_id: decodePropertyRef(input.property_ref), opportunity_id: input.opportunity_id ?? null, conversation_id: input.conversation_id ?? null, market: input.market ?? null } : null),
  async run(ctx, input = {}) {
    // a delegated task item (a follow-on) is a person's work: an AI never executes it
    if (input.follow_on === true) return done({ refused: 'delegated_task_requires_a_person', task: input.task ?? null }, { outcome_class: 'refused' })
    const next = depOutput(ctx, input.next_step)
    if (!next) throw new CapabilityError('NEXT_ACTION_MISSING', { retryable: false })
    const action = next.output.action
    if (next.outcome_class === 'refused' || !action || next.output.noop) {
      return done({ assigned: false, reason: next.outcome_class === 'refused' ? 'next_action_refused_or_escalated' : 'no_next_action', position: input.position ?? null, property_ref: next.output.property_ref ?? input.property_ref ?? null, noop: true })
    }
    const fo = FOLLOW_ON[action]
    if (!fo) return done({ assigned: false, reason: `no_follow_on_for:${action}`, action, position: input.position ?? null, property_ref: next.output.property_ref ?? null })
    const assignee = typeof ctx.staff === 'function' ? ctx.staff(fo.role, { market: next.output.market ?? null }) : null
    if (!assignee) return done({ assigned: false, reason: `no_active_${fo.role}`, action, property_ref: next.output.property_ref ?? null }, { outcome_class: 'unknown' })
    const step_key = `${ctx.assignment.step_key}.fo`
    const { assignment: fa, created } = await ctx.store.createAssignment({
      org_id: ctx.org_id,
      mission_id: ctx.mission.mission_id,
      step_key,
      capability_key: fo.capability_key,
      assignee_employee_id: assignee.employee_id,
      delegated_by_employee_id: ctx.employee.employee_id,
      depends_on: [],
      parent_assignment_id: ctx.assignment.assignment_id,
      input: {
        follow_on: true,
        task: fo.task,
        action,
        reasons: (next.output.reasons || []).slice(0, 5),
        property_ref: next.output.property_ref ?? null,
        opportunity_id: next.output.opportunity_id ?? null,
        conversation_id: next.output.conversation_id ?? null,
        market: next.output.market ?? null,
        ...(fo.capability_key === 'research.property' ? { force: true } : {}),
        source_assignment_id: next.assignment_id,
      },
      resource_type: 'property',
      resource_key: next.output.property_ref ?? null,
      max_attempts: 3,
    })
    return done({
      assigned: true,
      created,
      action,
      task: fo.task,
      follow_on_assignment_id: fa.assignment_id,
      assignee_employee_id: assignee.employee_id,
      assignee_kind: assignee.kind,
      property_ref: next.output.property_ref ?? null,
      position: input.position ?? null,
    }, { evidence: [ref('assignment', next.assignment_id), ref('assignment', fa.assignment_id)] })
  },
})
