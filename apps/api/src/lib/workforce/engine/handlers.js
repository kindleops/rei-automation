// The three Workforce R2 runtime handlers (docs/WORKFORCE.md §3), run by agent/runtime/runtime-tick.js
// through the job ctx (step / heartbeat / reserve / settle / yield / lease):
//   workforce.coo_plan        interpret → plan → assignments (idempotent) → active → event + COO message
//   workforce.dispatch        reap → resume waiting_job → claim/authorize/run → expand → enqueue reviews
//   workforce.mission_review  the COO report from ASSIGNMENT OUTPUTS ONLY (§6) → mission terminal/waiting
// Born unarmed: absent from kind_limits the DB never claims them; registered only with WORKFORCE_ENABLED=1.
// Every runtime job a handler enqueues carries requested_by = the named operator (the R2 rule).
import { RuntimePermanentError } from '../../agent/runtime/runtime-tick.js'
import { COO_PLAN_KIND, DISPATCH_KIND, MISSION_REVIEW_KIND, WORKFORCE_ORG_ID, modelInterpretEnabled } from '../config.js'
import { interpretDirective, modelChooseIntent } from '../coo/interpret.js'
import { buildPlan } from '../coo/playbooks.js'
import { createStaffer } from '../coo/staffing.js'
import { planMessage, reportMessage, statusAnswer } from '../coo/respond.js'
import { COO_EMPLOYEE_ID } from '../org/seed.js'
import { roleHasCapability } from '../org/charters.js'
import { externalMayTake } from '../coo/staffing.js'
import { buildMissionReport, verifyReportHonesty } from './report.js'
import { enqueueWorkforceJob, missionSettlement, runDispatchPass } from './dispatch.js'

const MISSION_DONE = new Set(['completed', 'failed', 'cancelled'])
const compactInterpretation = (i) => ({ version: i.version, source: i.source, intent: i.intent, markets: i.markets, count: i.count, horizon: i.horizon, focus: i.focus, refusal: i.refusal ? { codes: i.refusal.codes } : null })

/** @param {{ store, runtimeStore, reads?, services?, env?, now?, org_id?, modelCallFor?: (ctx) => Function|null, parseJson?: Function, knownMarkets?: string[], log?: Function }} deps */
export function createCooPlanHandler(deps) {
  const { store, runtimeStore, env = process.env, now = () => Date.now(), org_id = WORKFORCE_ORG_ID, modelCallFor = null, parseJson = null, knownMarkets } = deps
  return Object.freeze({
    kind: COO_PLAN_KIND,
    async run(ctx) {
      const mission_id = String(ctx.job.input?.mission_id || '')
      await ctx.step('load', { progress: { step: 'load', steps_done: 0, steps_total: 4 } })
      let mission = await store.getMission({ org_id, mission_id })
      if (!mission) throw new RuntimePermanentError('MISSION_NOT_FOUND')
      const requested_by = mission.requested_by
      const enqueueDispatch = () => enqueueWorkforceJob(runtimeStore, { kind: DISPATCH_KIND, key: [mission_id, 'planned', mission.plan_version], input: { mission_id, reason: 'planned' }, requested_by })
      // a replayed coo_plan event: the mission already left planning — re-assert the (idempotent) dispatch, nothing else
      if (mission.status !== 'planning') {
        if (mission.status === 'active') await enqueueDispatch()
        return { result: { mission_id, deduped: true, status: mission.status } }
      }
      let plan = mission.plan_version > 0 ? mission.plan : null
      if (!plan) {
        let interp = interpretDirective(mission.directive, knownMarkets ? { markets: knownMarkets } : {})
        if (interp.intent === 'unknown' && !interp.refusal && modelInterpretEnabled(env) && typeof modelCallFor === 'function') {
          await ctx.step('interpret_model', { progress: { step: 'interpret_model', steps_done: 1 } })
          try {
            const chosen = await modelChooseIntent({ text: mission.directive, deterministic: interp, modelCall: modelCallFor(ctx), parseJson })
            if (chosen) interp = chosen
          } catch { /* the deterministic answer (unknown → one clarifying question) stands */ }
        }
        if (!interp.actionable) {
          const content = interp.refusal ? interp.refusal.message
            : interp.intent === 'status_review' ? statusAnswer({ missions: await store.listMissions({ org_id, limit: 50 }), assignments: await store.listAssignments({ org_id, limit: 1000 }), employees: await store.listEmployees({ org_id }) }).content
              : interp.clarifying_question
          await store.appendExecMessage({ org_id, author: 'coo', author_employee_id: COO_EMPLOYEE_ID, mission_id, content, refs: [{ type: 'mission', id: mission_id }] })
          await store.transitionMission({ org_id, mission_id, to: 'cancelled', report: { version: 'wf.report.v1', state: interp.refusal ? 'refused' : interp.intent === 'status_review' ? 'answered_inline' : 'needs_clarification', interpretation: compactInterpretation(interp) } })
          await store.appendEvent({ org_id, type: interp.refusal ? 'wf.mission.refused' : 'wf.mission.not_actionable', mission_id, employee_id: COO_EMPLOYEE_ID, payload: { intent: interp.intent, codes: interp.refusal?.codes || [] } })
          return { result: { mission_id, actionable: false, intent: interp.intent, refused: Boolean(interp.refusal) } }
        }
        await ctx.step('plan', { progress: { step: 'plan', steps_done: 1 } })
        const draft = buildPlan({ intent: interp.intent, interpretation: interp })
        const roster = await store.listEmployees({ org_id })
        const staff = createStaffer({ employees: roster, assignments: await store.listAssignments({ org_id, limit: 1000 }) })
        // a directive relayed through the Action Gateway with assign_to_self (docs/WORKFORCE-AGNTEI.md §2): the FIRST step goes to the
        // relaying employee when its charter covers that capability; otherwise the normal staffing applies (and the skip is recorded)
        const selfId = typeof ctx.job.input?.assign_first_to === 'string' ? ctx.job.input.assign_first_to : null
        const self = selfId ? roster.find((e) => e.employee_id === selfId && e.status === 'active') || null : null
        const selfFits = Boolean(self && draft.steps[0] && roleHasCapability(self.role_key, draft.steps[0].capability) && externalMayTake(self, draft.steps[0].capability))
        draft.steps = draft.steps.map((s, i) => ({ ...s, assignee_employee_id: i === 0 && selfFits ? self.employee_id : staff(s.role, { market: s.market ?? null, capability: s.capability })?.employee_id ?? null }))
        if (selfId && !selfFits) await store.appendEvent({ org_id, type: 'wf.mission.assign_to_self_skipped', mission_id, employee_id: self ? selfId : null, payload: { reason: !self ? 'employee_not_active' : !roleHasCapability(self.role_key, draft.steps[0]?.capability) ? 'capability_not_in_charter' : 'not_externally_executable' } })
        try {
          mission = await store.setMissionPlan({ org_id, mission_id, objective: compactInterpretation(interp), playbook_key: draft.playbook, plan: draft, expected_version: mission.plan_version })
        } catch (e) {
          if (e?.code !== 'VERSION_MISMATCH') throw e
          mission = await store.getMission({ org_id, mission_id }) // a concurrent replay planned it: use its plan
        }
        plan = mission.plan
      }
      await ctx.step('assign', { progress: { step: 'assign', steps_done: 2 } })
      for (const s of plan.steps) {
        if (!s.assignee_employee_id) continue
        await store.createAssignment({
          org_id, mission_id, step_key: s.step, capability_key: s.capability, assignee_employee_id: s.assignee_employee_id, delegated_by_employee_id: COO_EMPLOYEE_ID,
          depends_on: s.depends_on || [], input: { ...(s.input || {}), ...(s.critical ? { critical: true } : {}) }, resource_type: s.resource_type ?? null, resource_key: s.resource ?? null, max_attempts: 3,
        })
      }
      await ctx.step('activate', { progress: { step: 'activate', steps_done: 3 } })
      mission = await store.transitionMission({ org_id, mission_id, to: 'active' })
      await store.appendEvent({ org_id, type: 'wf.mission.planned', mission_id, employee_id: COO_EMPLOYEE_ID, payload: { intent: plan.intent, steps: plan.steps.length, plan_version: mission.plan_version, unstaffed: plan.steps.filter((s) => !s.assignee_employee_id).map((s) => s.step).slice(0, 10) } })
      const msg = planMessage({ mission, plan })
      await store.appendExecMessage({ org_id, author: 'coo', author_employee_id: COO_EMPLOYEE_ID, mission_id, content: msg.content, refs: msg.refs })
      const d = await enqueueDispatch()
      return { result: { mission_id, planned: true, intent: plan.intent, steps: plan.steps.length, dispatch_job_id: d?.job_id ?? null } }
    },
  })
}

export function createDispatchHandler(deps) {
  const { store, runtimeStore, reads = null, services = {}, env = process.env, now = () => Date.now(), org_id = WORKFORCE_ORG_ID } = deps
  return Object.freeze({
    kind: DISPATCH_KIND,
    async run(ctx) {
      const summary = await runDispatchPass({ store, runtimeStore, reads, services, env, now, org_id, ctx, maxPerPass: Number(ctx.job.input?.max) || null })
      return { result: { dispatch: summary } }
    },
  })
}

export function createMissionReviewHandler(deps) {
  const { store, reads = null, now = () => Date.now(), org_id = WORKFORCE_ORG_ID } = deps
  return Object.freeze({
    kind: MISSION_REVIEW_KIND,
    async run(ctx) {
      const mission_id = String(ctx.job.input?.mission_id || '')
      await ctx.step('load', { progress: { step: 'load', steps_done: 0, steps_total: 3 } })
      const mission = await store.getMission({ org_id, mission_id })
      if (!mission) throw new RuntimePermanentError('MISSION_NOT_FOUND')
      if (MISSION_DONE.has(mission.status)) return { result: { mission_id, deduped: true, status: mission.status } }
      const assignments = await store.listAssignments({ org_id, mission_id, limit: 1000 })
      const employees = await store.listEmployees({ org_id })
      const st = missionSettlement(mission, assignments, { employees })
      if (!st.settled) return { result: { mission_id, settled: false, runnable: st.runnable, owed: st.owed } }
      await ctx.step('report', { progress: { step: 'report', steps_done: 1 } })
      const spend = new Map()
      for (const id of [...new Set(assignments.map((a) => a.runtime_job_id).filter(Boolean))]) {
        try { if (reads?.jobSpend) spend.set(id, await reads.jobSpend(id)) } catch { /* unreadable ⇒ unknown */ }
      }
      const report = buildMissionReport({ mission, assignments, spend, now: now(), employees })
      for (const [name, state] of Object.entries(mission.plan?.expansions || {})) if (state === 'pending') report.unknowns.push({ what: 'plan_expansion', reason: `not_run:${name}` })
      report.counts.unknowns = report.unknowns.length
      const problems = verifyReportHonesty(report, assignments)
      if (problems.length) throw new RuntimePermanentError('REPORT_HONESTY_VIOLATION') // never publish a report that claims what did not happen
      await ctx.step('finalize', { progress: { step: 'finalize', steps_done: 2 } })
      const to = st.all_terminal ? (st.critical_failed ? 'failed' : 'completed') : 'waiting'
      if (to === 'completed' || to === 'failed') {
        for (const a of assignments) {
          if (a.resource_type && a.resource_key) await store.releaseResourceClaim({ org_id, resource_type: a.resource_type, resource_key: a.resource_key, assignment_id: a.assignment_id }).catch(() => {})
        }
      }
      if (mission.status === to) return { result: { mission_id, unchanged: true, status: to } }
      const done = await store.transitionMission({ org_id, mission_id, to, report })
      const msg = reportMessage({ mission: done, report })
      await store.appendExecMessage({ org_id, author: 'coo', author_employee_id: COO_EMPLOYEE_ID, mission_id, content: msg.content, refs: msg.refs })
      await store.appendEvent({ org_id, type: 'wf.mission.reported', mission_id, employee_id: COO_EMPLOYEE_ID, payload: { status: to, counts: report.counts } })
      return { result: { mission_id, status: to, counts: report.counts } }
    },
  })
}

/** All three handlers, keyed by kind (the tick registers them only when Workforce is enabled). */
export function buildWorkforceHandlers(deps) {
  return Object.freeze({
    [COO_PLAN_KIND]: createCooPlanHandler(deps),
    [DISPATCH_KIND]: createDispatchHandler(deps),
    [MISSION_REVIEW_KIND]: createMissionReviewHandler(deps),
  })
}
