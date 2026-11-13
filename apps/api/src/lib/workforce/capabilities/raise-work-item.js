// ops.raise_work_item (internal) — an operator work item. The existing writer (agent.ops_work_item,
// lease-bound to the OPERATIONS job kinds) is used only when the wiring supplies it; otherwise —
// Phase A default — the item becomes a Workforce assignment in the human CEO queue. It never
// contacts anyone and never writes a stage.
import { code, done, ref, safeText } from './shared.js'

export const KEY = 'ops.raise_work_item'

export const capability = Object.freeze({
  key: KEY,
  class: 'internal',
  roles: Object.freeze(['ops_supervisor']),
  escalates_on: Object.freeze([]),
  resourceOf: () => null,
  async run(ctx, input = {}) {
    const kind = code(input.kind) || 'workforce_review'
    const reason = safeText(input.reason, 200) || 'review requested'
    if (typeof ctx.services?.raiseOpsWorkItem === 'function') {
      const r = await ctx.services.raiseOpsWorkItem({ kind, reason, subject: input.subject ?? null })
      if (r?.ok) return done({ raised: true, via: 'agent.ops_work_item', work_item_id: r.work_item_id ?? null, kind }, { evidence: [ref('ops_work_item', r.work_item_id)] })
    }
    const ceo = typeof ctx.staff === 'function' ? ctx.staff('ceo') : null
    if (!ceo) return done({ raised: false, reason: 'no_ceo_queue' }, { outcome_class: 'unknown' })
    const { assignment } = await ctx.store.createAssignment({
      org_id: ctx.org_id, mission_id: ctx.mission.mission_id, step_key: `${ctx.assignment.step_key}.fo`, capability_key: 'work.assign',
      assignee_employee_id: ceo.employee_id, delegated_by_employee_id: ctx.employee.employee_id, depends_on: [], parent_assignment_id: ctx.assignment.assignment_id,
      input: { follow_on: true, task: 'operator_work_item', kind, reason, subject: input.subject ?? null }, max_attempts: 1,
    })
    return done({ raised: true, via: 'workforce.ceo_queue', follow_on_assignment_id: assignment.assignment_id, kind }, { evidence: [ref('assignment', assignment.assignment_id)] })
  },
})
