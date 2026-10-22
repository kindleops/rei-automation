// One dispatch pass (docs/WORKFORCE.md §3 workforce.dispatch). All state is in the store; nothing
// loops in process. Per pass:
//   1. reap expired assignment leases and resource claims
//   2. resume waiting_job assignments against agent.research_job state
//   3. claim ready assignments ONE AT A TIME (so nothing is claimed that this pass cannot run), each
//      inside the tick budget: authority (§4.2) + holds → run inline (read) / enqueue + park (internal
//      research) / park for a person (human assignee) / escalate to the CEO / refuse
//   4. grow the plans whose expansion step completed (idempotent), and enqueue workforce.mission_review
//      for every mission with nothing left that can run
import { runtimeIdempotencyKey } from '../../agent/runtime/job-runtime.js'
import { PROPERTY_RESEARCH_KIND } from '../../agent/missions/mission-kinds.js'
import { WORKFORCE_LIMITS, DISPATCH_KIND, MISSION_REVIEW_KIND } from '../config.js'
import { authorize } from '../authority/engine.js'
import { getCapability } from '../capabilities/catalog.js'
import { CapabilityError, decodePropertyRef, num } from '../capabilities/shared.js'
import { createStaffer } from '../coo/staffing.js'
import { expandCandidates, expandNext } from '../coo/playbooks.js'
import { CEO_EMPLOYEE_ID } from '../org/seed.js'
import { isCoreAssignment } from './report.js'

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const RUNNABLE = new Set(['pending', 'ready', 'leased', 'running', 'waiting_job'])
const MISSION_DONE = new Set(['completed', 'failed', 'cancelled'])
const errCode = (e, d = 'CAPABILITY_ERROR') => String(e?.code || d).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 60) || d
const backoff = (attempt) => Math.min(30 * 2 ** Math.max(0, Number(attempt) || 0), 1800)

/** Enqueue a Workforce runtime job: manual enqueue, requested_by = the named operator (R2 rule). */
export async function enqueueWorkforceJob(runtimeStore, { kind, key, input = {}, requested_by, priority = 100, budget_cap_usd = 0 }) {
  if (!runtimeStore?.enqueue) return { ok: false, reason: 'runtime_unavailable' }
  return runtimeStore.enqueue({ kind, idempotency_key: runtimeIdempotencyKey('workforce', kind, ...key), input, requested_by, priority, max_attempts: 3, budget_cap_usd })
}

/** property.research for a property on behalf of a mission (the existing kind, its own budget). */
export async function enqueueResearchJob(runtimeStore, { property_ref, requested_by, mission_id, trigger = 'valuation_stale_or_missing' }) {
  if (!runtimeStore?.enqueue) return { ok: false, reason: 'runtime_unavailable' }
  const r = await runtimeStore.enqueue({
    kind: PROPERTY_RESEARCH_KIND,
    idempotency_key: runtimeIdempotencyKey('workforce', PROPERTY_RESEARCH_KIND, mission_id || 'none', property_ref),
    input: { property_ref, trigger, web: false },
    requested_by,
    priority: 120,
    max_attempts: 3,
    budget_cap_usd: WORKFORCE_LIMITS.research_budget_cap_usd,
  })
  return r?.ok ? { ok: true, job_id: r.job_id, deduped: Boolean(r.deduped) } : { ok: false, reason: String(r?.reason || 'enqueue_refused') }
}

/** Normalize an agent.research_job row to what resumeWaitingAssignments expects. */
export function researchJobResolver(reads) {
  return async (runtime_job_id) => {
    const j = await reads.getJob(runtime_job_id)
    if (!j) return { state: 'failed', result: null, error: { code: 'JOB_NOT_FOUND' } }
    if (j.state === 'completed') return { state: 'completed', result: j.result ?? null, error: null }
    if (['failed', 'dead_letter', 'cancelled'].includes(j.state)) return { state: 'failed', result: null, error: { code: String(j.last_error?.code || j.state).toUpperCase().slice(0, 60) } }
    return { state: j.state, result: null, error: null } // still running / queued / retrying / budget_blocked
  }
}

/** Is there anything left in this mission that can still run (or a plan expansion still owed)? */
export function missionSettlement(mission, assignments = [], { employees = null } = {}) {
  const byKey = new Map(assignments.map((a) => [a.step_key, a]))
  const core = assignments.filter(isCoreAssignment)
  // a paused / retired assignee is never claimed (the store's kill switch): its open work cannot complete
  const inactive = new Set((employees || []).filter((e) => e.status !== 'active').map((e) => e.employee_id))
  // can this assignment still complete? Runnable itself, and every dependency completed or able to complete
  // (a dependency that failed, was cancelled, was never created — unstaffed — or is parked for a person
  // / blocked means it cannot, transitively)
  const memo = new Map()
  const canComplete = (a, seen = new Set()) => {
    if (!a) return false
    if (a.status === 'completed') return true
    if (memo.has(a.step_key)) return memo.get(a.step_key)
    if (!RUNNABLE.has(a.status) || seen.has(a.step_key) || (['pending', 'ready'].includes(a.status) && inactive.has(a.assignee_employee_id))) { memo.set(a.step_key, false); return false }
    seen.add(a.step_key)
    const ok = (a.depends_on || []).every((k) => canComplete(byKey.get(k), seen))
    memo.set(a.step_key, ok)
    return ok
  }
  const runnable = core.filter((a) => RUNNABLE.has(a.status) && canComplete(a))
  const steps = mission?.plan?.steps || []
  // an expansion is owed while its trigger step can still complete, or completed with usable output
  // (a trigger that failed / was refused / was never created leaves nothing owed: the plan stops there)
  const owed = steps.filter((s) => s.expand && expansionState(mission, s.expand) === 'pending').filter((s) => {
    const a = byKey.get(s.step)
    if (!a) return false
    if (!TERMINAL.has(a.status)) return canComplete(a)
    return a.status === 'completed' && ['verified', 'partial'].includes(a.outcome_class)
  })
  const terminal = core.filter((a) => TERMINAL.has(a.status)).length
  return { settled: runnable.length === 0 && owed.length === 0, runnable: runnable.length, owed: owed.map((s) => s.expand), core: core.length, terminal, all_terminal: core.every((a) => TERMINAL.has(a.status)), critical_failed: core.some((a) => a.status === 'failed' && a.input?.critical === true) }
}
const expansionState = (mission, name) => (name === 'triage_candidates' ? mission?.plan?.expansions?.after_opps : name === 'triage_next' ? mission?.plan?.expansions?.after_rank : null)

/**
 * @param {{ store, runtimeStore, reads, services, env, now: () => number, org_id: string, ctx: object, log?: Function, maxPerPass?: number }} d
 */
export async function runDispatchPass(d) {
  const { store, runtimeStore, reads, services, env, now, org_id, ctx } = d
  const owner = `wf-dispatch:${ctx.job.job_id}`.slice(0, 80)
  const max = Math.min(Math.max(Number(d.maxPerPass) || WORKFORCE_LIMITS.dispatch_default_per_pass, 1), WORKFORCE_LIMITS.dispatch_max_per_pass)
  const summary = { reaped: null, claims_reaped: null, resumed: 0, processed: 0, outcomes: {}, stopped: null, expanded: [], reviews: [], continued: false }
  const bump = (k) => { summary.outcomes[k] = (summary.outcomes[k] || 0) + 1 }

  await ctx.step('reap', { progress: { step: 'reap', steps_done: 0 } })
  summary.reaped = await store.reapAssignments({ org_id, now: new Date(now()).toISOString() })
  summary.claims_reaped = await store.reapResourceClaims({ org_id, now: new Date(now()).toISOString() })

  if (reads?.getJob) {
    await ctx.step('resume', { progress: { step: 'resume', steps_done: 1 } })
    summary.resumed = await store.resumeWaitingAssignments({ org_id, resolver: researchJobResolver(reads) })
  }

  // the pass snapshot: staff, policy, settings, runtime limits
  const [employees, policies, settings, limits] = await Promise.all([
    store.listEmployees({ org_id }),
    store.listPolicies({ org_id, status: 'active' }),
    store.getSettings({ org_id }),
    runtimeStore?.limits ? runtimeStore.limits().catch(() => ({ emergency_stop: true })) : Promise.resolve({ emergency_stop: false }),
  ])
  const emp = new Map(employees.map((e) => [e.employee_id, e]))
  const missions = new Map()
  const getMission = async (id) => { if (!missions.has(id)) missions.set(id, await store.getMission({ org_id, mission_id: id })); return missions.get(id) }
  const missionAssignments = (id) => store.listAssignments({ org_id, mission_id: id, limit: 1000 })
  const usage = new Map()
  const usageFor = async (employee_id) => {
    if (!usage.has(employee_id)) {
      const day = new Date(now()).toISOString().slice(0, 10)
      const rows = await store.listAssignments({ org_id, assignee_employee_id: employee_id, limit: 1000 })
      const today = {}
      for (const a of rows) if (String(a.created_at || '').slice(0, 10) === day && a.status !== 'pending') today[a.capability_key] = (today[a.capability_key] || 0) + 1
      usage.set(employee_id, today)
    }
    return usage.get(employee_id)
  }
  const touched = new Set()
  let staffer = null
  const staff = async () => { if (!staffer) staffer = createStaffer({ employees, assignments: await store.listAssignments({ org_id, limit: 1000 }) }); return staffer }

  const finish = async (a, o) => {
    const r = await store.finishAssignment({ org_id, assignment_id: a.assignment_id, lease_token: a.lease_token, ...o })
    bump(`${o.status}${o.outcome_class ? `:${o.outcome_class}` : ''}`)
    return r
  }
  const event = (type, a, payload = {}) => store.appendEvent({ org_id, type, mission_id: a?.mission_id ?? null, assignment_id: a?.assignment_id ?? null, employee_id: a?.assignee_employee_id ?? null, payload })

  async function processOne(a) {
    touched.add(a.mission_id)
    const mission = await getMission(a.mission_id)
    if (!mission || mission.status === 'cancelled') { await finish(a, { status: 'cancelled', outcome_class: 'unknown', output: { reason: 'mission_not_active' } }); return }
    const employee = emp.get(a.assignee_employee_id)
    if (!employee) { await finish(a, { status: 'failed', outcome_class: 'refused', output: { reason: 'assignee_unknown' }, error: { code: 'ASSIGNEE_UNKNOWN' } }); return }
    // a person's work is parked for the person: an AI never executes it
    if (employee.kind === 'human') {
      await finish(a, { status: 'waiting_approval', outcome_class: 'unknown', output: { parked: 'human_queue', task: a.input?.task ?? null } })
      await event('wf.assignment.queued_for_human', a, { task: a.input?.task ?? null })
      return
    }
    const cap = getCapability(a.capability_key)
    const all = await missionAssignments(a.mission_id)
    const deps = Object.fromEntries(all.map((x) => [x.step_key, x]))
    const s = await staff()
    const capCtx = {
      services, env, org_id, now: now(), mission, assignment: a, employee, deps, missionAssignments: all, requested_by: mission.requested_by, store, settings,
      staff: (role, o = {}) => (role === 'ceo' ? emp.get(CEO_EMPLOYEE_ID) || null : s(role, o)),
      limits: WORKFORCE_LIMITS,
      runtime: { enqueueResearch: (o) => enqueueResearchJob(runtimeStore, { ...o, property_ref: a.input?.property_ref, mission_id: mission.mission_id }) },
      signal: ctx.signal,
      remainingMs: ctx.remainingMs,
    }
    const resource = cap?.resourceOf ? cap.resourceOf(capCtx, a.input || {}) : null
    // the economic context of the resource, from this mission's own decision read (step outputs only)
    let decision = null
    if (resource?.property_id) {
      const pr = a.input?.property_ref
      const dec = all.find((x) => x.capability_key === 'intel.acquisition_decision' && x.input?.property_ref === pr && x.status === 'completed' && ['verified', 'partial'].includes(x.outcome_class))
      decision = dec?.output || null
      const prices = [decision?.ask, decision?.mao, decision?.valuation_mid, decision?.recommended_offer].map(num).filter((v) => v != null && v > 0)
      resource.price_usd = prices.length ? Math.max(...prices) : null
    }
    let hold = null
    if (resource?.property_id && typeof services?.checkHold === 'function') {
      try { hold = await services.checkHold({ propertyId: resource.property_id, opportunityId: resource.opportunity_id || null, threadId: resource.conversation_id || null }) } catch { hold = { held: true, fail_closed: true, hold_type: 'lookup_error' } }
    }
    const verdict = authorize({
      employee, capability: a.capability_key, resource,
      context: { env, now: now(), runtime: { emergency_stop: limits?.emergency_stop === true }, hold, policies, settings, usage: { today: cap?.class === 'internal' ? await usageFor(employee.employee_id) : {} }, valuation_uncertain: decision?.valuation_uncertain === true, title_ambiguous: decision?.title_ambiguous === true, confidence: decision?.confidence ?? null },
    })
    if (verdict.decision === 'deny') {
      await event('wf.authority.denied', a, { reasons: verdict.reasons })
      if (verdict.reasons.includes('EMPLOYEE_PAUSED')) { await finish(a, { status: 'blocked', outcome_class: 'unknown', output: { authority: 'deny', reasons: verdict.reasons }, error: { code: 'EMPLOYEE_PAUSED' } }); return }
      if (verdict.kill_switch) {
        await finish(a, { status: 'ready', outcome_class: 'unknown', error: { code: verdict.reasons[0] }, retry_after_seconds: 300 })
        summary.stopped = verdict.reasons[0]
        return
      }
      await finish(a, { status: 'completed', outcome_class: 'refused', output: { authority: 'deny', reasons: verdict.reasons, property_ref: a.input?.property_ref ?? null } })
      return
    }
    if (verdict.decision === 'escalate') {
      const ceo = emp.get(CEO_EMPLOYEE_ID)
      // one CEO item per property per mission: a later decision step on an already-escalated property points at it
      let esc = a.input?.property_ref ? all.find((x) => x.input?.task === 'escalation' && x.input?.property_ref === a.input.property_ref) || null : null
      if (ceo && !esc) {
        esc = (await store.createAssignment({
          org_id, mission_id: a.mission_id, step_key: `${a.step_key}.esc`, capability_key: 'work.assign', assignee_employee_id: ceo.employee_id, delegated_by_employee_id: employee.employee_id,
          depends_on: [], parent_assignment_id: a.assignment_id, max_attempts: 1,
          input: { follow_on: true, task: 'escalation', reasons: verdict.reasons, escalated_step: a.step_key, capability: a.capability_key, property_ref: a.input?.property_ref ?? null, opportunity_id: a.input?.opportunity_id ?? null, conversation_id: a.input?.conversation_id ?? null, threshold_usd: verdict.threshold_usd ?? null, price_usd: resource?.price_usd ?? null },
        })).assignment
      }
      await finish(a, { status: 'completed', outcome_class: 'refused', output: { authority: 'escalate', review: verdict.review, reasons: verdict.reasons, escalation_assignment_id: esc?.assignment_id ?? null, property_ref: a.input?.property_ref ?? null } })
      await event('wf.authority.escalated', a, { reasons: verdict.reasons, escalation_assignment_id: esc?.assignment_id ?? null })
      return
    }
    // one owner per seller / property: the acting employee claims the resource first
    if (cap.claims && a.resource_type && a.resource_key) {
      try {
        await store.acquireResourceClaim({ org_id, resource_type: a.resource_type, resource_key: a.resource_key, employee_id: employee.employee_id, assignment_id: a.assignment_id, ttl_seconds: WORKFORCE_LIMITS.claim_ttl_seconds })
      } catch (e) {
        if (e?.code !== 'CLAIM_HELD') throw e
        await finish(a, { status: 'completed', outcome_class: 'refused', output: { authority: 'deny', reasons: ['RESOURCE_HELD_BY_ANOTHER_EMPLOYEE'], resource_type: a.resource_type, property_ref: a.input?.property_ref ?? null } })
        await event('wf.resource.conflict', a, { resource_type: a.resource_type })
        return
      }
    }
    await store.progressAssignment({ org_id, assignment_id: a.assignment_id, lease_token: a.lease_token, patch: { status: 'running' } })
    let res
    try {
      const budget = Math.max(500, Math.min(WORKFORCE_LIMITS.inline_read_max_ms, (ctx.remainingMs?.() ?? WORKFORCE_LIMITS.inline_read_max_ms) - 1_500))
      let timer
      res = await Promise.race([
        Promise.resolve().then(() => cap.run(capCtx, a.input || {})),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new CapabilityError('INLINE_TIMEOUT')), budget); if (typeof timer.unref === 'function') timer.unref() }),
      ]).finally(() => clearTimeout(timer))
    } catch (e) {
      const code = errCode(e)
      const retryable = e?.retryable !== false
      const attempt = Number(a.attempt) || 0
      const maxA = Number(a.max_attempts) || 3
      if (retryable && attempt + 1 < maxA) {
        await finish(a, { status: 'ready', outcome_class: 'unknown', error: { code }, retry_after_seconds: backoff(attempt) })
        await event('wf.assignment.retry', a, { code, attempt: attempt + 1 })
      } else if (a.input?.critical === true) {
        await finish(a, { status: 'failed', outcome_class: 'unknown', error: { code } })
        await event('wf.assignment.failed', a, { code })
      } else {
        // a per-candidate read that cannot be done: completed with an UNKNOWN outcome, so the mission goes on honestly
        await finish(a, { status: 'completed', outcome_class: 'unknown', output: { error: code, property_ref: a.input?.property_ref ?? null }, error: { code } })
        await event('wf.assignment.unknown', a, { code })
      }
      return
    }
    if (res?.status === 'waiting_job' && res.runtime_job_id) {
      if (res.output) await store.progressAssignment({ org_id, assignment_id: a.assignment_id, lease_token: a.lease_token, patch: { output: res.output } })
      await store.waitAssignmentOnJob({ org_id, assignment_id: a.assignment_id, lease_token: a.lease_token, runtime_job_id: res.runtime_job_id })
      bump('waiting_job')
      await event('wf.assignment.waiting_job', a, { runtime_job_id: res.runtime_job_id })
      return
    }
    await finish(a, { status: 'completed', outcome_class: res?.outcome_class || 'unknown', output: res?.output ?? {}, evidence: res?.evidence || [] })
    await event('wf.assignment.completed', a, { outcome_class: res?.outcome_class || 'unknown' })
    if (employee.kind === 'ai' && typeof store.heartbeatEmployee === 'function') await store.heartbeatEmployee({ org_id, employee_id: employee.employee_id }).catch(() => {})
  }

  for (let i = 0; i < max; i += 1) {
    if (summary.stopped) break
    if ((ctx.remainingMs?.() ?? Infinity) < WORKFORCE_LIMITS.min_inline_ms) { summary.stopped = 'budget'; break }
    await ctx.step('assignment', { progress: { step: 'dispatch', steps_done: i } })
    const [a] = await store.claimAssignments({ org_id, owner, limit: 1, lease_seconds: WORKFORCE_LIMITS.assignment_lease_seconds })
    if (!a) break
    try {
      await processOne(a)
    } catch (e) {
      if (e?.code === 'LEASE_LOST') bump('lease_lost') // the lease expired under us: the reaper hands it back (never a silent success)
      else if (['PAYLOAD_REFUSED', 'ILLEGAL_TRANSITION', 'NOT_FOUND', 'CONFLICT', 'FORBIDDEN', 'VERSION_MISMATCH'].includes(e?.code)) {
        // a refusal is deterministic: retrying the same step would poison every pass. Fail THIS assignment, keep going.
        bump(`store_refused:${String(e.code).toLowerCase()}`)
        await store.finishAssignment({ org_id, assignment_id: a.assignment_id, lease_token: a.lease_token, status: 'failed', outcome_class: 'unknown', error: { code: `STORE_${e.code}` } }).catch(() => {})
        await event('wf.assignment.failed', a, { code: `STORE_${e.code}` }).catch(() => {})
      } else throw e // infrastructure: the job retries; the lease expires and the reaper hands the assignment back
    }
    summary.processed += 1
  }

  // plans that grew a step, and missions with nothing left to run
  const [active, waiting] = await Promise.all([store.listMissions({ org_id, status: 'active', limit: 50 }), store.listMissions({ org_id, status: 'waiting', limit: 50 })])
  const ids = new Set([...touched, ...active.map((m) => m.mission_id), ...waiting.map((m) => m.mission_id)])
  for (const id of ids) {
    let mission = await store.getMission({ org_id, mission_id: id })
    if (!mission || MISSION_DONE.has(mission.status) || mission.status === 'planning') continue
    const grew = await ensureExpansions({ store, org_id, mission, employees, emp })
    if (grew) { summary.expanded.push(id); mission = await store.getMission({ org_id, mission_id: id }) }
    const all = await missionAssignments(id)
    const st = missionSettlement(mission, all, { employees })
    if (st.settled) {
      const r = await enqueueWorkforceJob(runtimeStore, { kind: MISSION_REVIEW_KIND, key: [id, 'review', st.core, st.terminal, mission.plan_version], input: { mission_id: id }, requested_by: mission.requested_by })
      if (r?.ok && !r.deduped) { summary.reviews.push(id); await store.appendEvent({ org_id, type: 'wf.mission.review_enqueued', mission_id: id, payload: { job_id: r.job_id } }) }
    }
  }
  // more work may be ready right now: hand it to a follow-up dispatch instead of waiting for the schedule
  if (summary.processed >= max || summary.stopped === 'budget' || summary.expanded.length) {
    const r = await enqueueWorkforceJob(runtimeStore, { kind: DISPATCH_KIND, key: ['continue', ctx.job.job_id], input: { reason: 'continue' }, requested_by: ctx.job.requested_by })
    summary.continued = Boolean(r?.ok && !r.deduped)
  }
  return summary
}

/**
 * Grow a plan whose expansion step completed. Idempotent and crash-safe: the steps are a pure
 * function of the completed step's output; assignments are created first (idempotent on step_key),
 * then the plan records the expansion (optimistic version). A replay recreates nothing.
 * @returns {Promise<boolean>} whether the plan was (re)expanded in this call
 */
export async function ensureExpansions({ store, org_id, mission, employees }) {
  const plan = mission?.plan
  if (!plan?.steps?.length) return false
  let grew = false
  let current = mission
  for (const s of plan.steps.filter((x) => x.expand)) {
    if (expansionState(current, s.expand) !== 'pending') continue
    const all = await store.listAssignments({ org_id, mission_id: current.mission_id, limit: 1000 })
    const trigger = all.find((a) => a.step_key === s.step)
    if (!trigger || trigger.status !== 'completed' || !['verified', 'partial'].includes(trigger.outcome_class)) continue
    const staff = createStaffer({ employees, assignments: await store.listAssignments({ org_id, limit: 1000 }) })
    const { steps } = s.expand === 'triage_candidates'
      ? expandCandidates(current.plan, trigger.output)
      : expandNext(current.plan, trigger.output, trigger.input?.slots || [])
    const recorded = []
    for (const st of steps) {
      const assignee = staff(st.role, { market: st.market ?? null })
      if (!assignee) { recorded.push({ ...st, assignee_employee_id: null, unstaffed: true }); continue }
      const { assignment } = await store.createAssignment({
        org_id, mission_id: current.mission_id, step_key: st.step, capability_key: st.capability, assignee_employee_id: assignee.employee_id,
        delegated_by_employee_id: current.owner_employee_id, depends_on: st.depends_on, input: { ...st.input, ...(st.critical ? { critical: true } : {}) },
        resource_type: st.resource_type, resource_key: st.resource, max_attempts: 3,
      })
      recorded.push({ ...st, assignee_employee_id: assignment.assignee_employee_id })
    }
    const expansions = { ...(current.plan.expansions || {}), [s.expand === 'triage_candidates' ? 'after_opps' : 'after_rank']: 'expanded' }
    const next = { ...current.plan, steps: [...current.plan.steps, ...recorded.filter((r) => !current.plan.steps.some((x) => x.step === r.step))], expansions }
    try {
      current = await store.setMissionPlan({ org_id, mission_id: current.mission_id, objective: current.objective, playbook_key: current.playbook_key, plan: next, expected_version: current.plan_version })
      await store.appendEvent({ org_id, type: 'wf.mission.expanded', mission_id: current.mission_id, payload: { expansion: s.expand, steps: recorded.length, plan_version: current.plan_version } })
      grew = true
    } catch (e) {
      if (e?.code !== 'VERSION_MISMATCH') throw e
      current = await store.getMission({ org_id, mission_id: current.mission_id }) // another pass recorded it
    }
  }
  return grew
}

export { decodePropertyRef }
