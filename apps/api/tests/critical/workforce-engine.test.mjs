// Workforce Phase A — the engine end to end on the fake store + stubbed read services + the REAL R2
// runtime memory store and the REAL runtime tick: directive → coo_plan → dispatch passes (inline reads,
// a property.research job parked as waiting_job and resumed) → mission_review. Then crash recovery
// (a lease expires mid-dispatch → reap → finish), a replayed coo_plan event (idempotent) and the
// one-owner-per-thread resource rule.
import test from 'node:test'
import assert from 'node:assert/strict'

import { createRuntimeMemoryStore, runtimeIdempotencyKey } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createMissionMemoryReads } from '../../src/lib/agent/missions/mission-reads.js'
import { buildWorkforceHandlers } from '../../src/lib/workforce/engine/handlers.js'
import { runDispatchPass } from '../../src/lib/workforce/engine/dispatch.js'
import { verifyReportHonesty, isTerminalSuccess } from '../../src/lib/workforce/engine/report.js'
import { handleMissionCreate } from '../../src/lib/workforce/routes.js'
import { SEED_EMPLOYEES } from '../../src/lib/workforce/org/seed.js'
import { createWorkforceFakeStore, seedFakeOrg, contactViolation } from '../helpers/workforce-fake-store.mjs'
import { ARMED_KINDS, DAY, HARTFORD, MAXWELL, OPERATOR, ORG, OWNER, T0, makeScore, makeServices, opp } from '../helpers/workforce-fixtures.mjs'

const ENV = { AGENT_ENABLED: '1', WORKFORCE_ENABLED: '1' }
const okAuth = () => ({ ok: true })
const limiter = { check: () => ({ ok: true }) }
const identityFor = (user_id) => ({ authenticate: async () => ({ ok: true, identity: { user_id, verified: true, named: true } }) })

function dallasBook() {
  return [
    opp(1, { seller_spoke_last: true, intent: 'asks_offer' }),
    opp(2, { seller_spoke_last: false, action_state: 'waiting_on_seller' }),
    opp(3, { score: null }), // no Decision Engine row ⇒ research
    opp(4, { score: makeScore({ property_id: '700000004', computedDaysAgo: 45 }) }), // stale ⇒ research
    opp(5, { ask: 320_000 }), // ask far above MAO ⇒ CFO challenge
    opp(6, { property_id: '700000006', score: makeScore({ property_id: '700000006', value: 6_500_000, offer: 4_200_000, mao: 4_500_000, repairs: 200_000, fee: 150_000 }), ask: 6_000_000 }), // ≥ $5M ⇒ escalation
    opp(7, { held: true }),
    opp(8, { suppressed: true, suppression_status: 'suppressed' }),
    opp(9, { market: 'Houston' }),
    opp(10, { ...HARTFORD, thread_key: '+18605550110' }),
    opp(11, { ...MAXWELL, thread_key: '+12155550111' }),
  ]
}

function world({ opps = dallasBook(), env = ENV, services: svcOverride = null, extraEmployees = [] } = {}) {
  let clock = T0
  const now = () => clock
  const runtime = createRuntimeMemoryStore({ now, limits: { runtime_enabled: true, kind_limits: structuredClone(ARMED_KINDS), tick_max_jobs: 3, max_concurrency_global: 4, lease_seconds: 120 } })
  const reads = createMissionMemoryReads(runtime)
  const store = createWorkforceFakeStore({ now, members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }] })
  const services = svcOverride || makeServices(opps)
  const researched = []
  const research = {
    kind: 'property.research',
    async run(ctx) {
      await ctx.step('research')
      researched.push({ job_id: ctx.job.job_id, requested_by: ctx.job.requested_by, property_ref: ctx.job.input.property_ref, web: ctx.job.input.web })
      return { result: { mission: 'property_research', property_ref: ctx.job.input.property_ref, coverage_share: 0.7, gaps: [], sends: 0 } }
    },
  }
  const handlers = { ...buildWorkforceHandlers({ store, runtimeStore: runtime, reads, services, env, now }), 'property.research': research }
  return {
    store, runtime, reads, services, researched, handlers, env,
    now, advance: (ms) => { clock += ms },
    seed: () => seedFakeOrg(store, { org_id: ORG, seed: SEED_EMPLOYEES, owner_user_id: OWNER, extra: extraEmployees }),
    tick: () => runRuntimeTick({ store: runtime, handlers, workerId: 'wf-test', now, budgetMs: 25_000 }),
    schedule: () => runtime.upsertSchedule({ name: 'workforce-dispatch', kind: 'workforce.dispatch', interval_seconds: 60, created_by: OWNER, enabled: true }),
    submit: (directive, user = OPERATOR, client_request_id = 'req-0000001') => handleMissionCreate(new Request('http://x/api/cockpit/workforce/missions', { method: 'POST', body: JSON.stringify({ directive, client_request_id, requested_by: OWNER, actor: OWNER }) }), {
      env, auth: okAuth, identity: identityFor(user), limiter, getServices: async () => ({ store, runtimeStore: runtime, reads, membership: async () => ({ role: 'operator' }) }),
    }),
  }
}

async function runUntilSettled(w, mission_id, maxTicks = 60) {
  for (let i = 0; i < maxTicks; i += 1) {
    await w.tick()
    w.advance(61_000)
    const m = await w.store.getMission({ org_id: ORG, mission_id })
    if (['completed', 'failed', 'cancelled', 'waiting'].includes(m.status)) return { mission: m, ticks: i + 1 }
  }
  return { mission: await w.store.getMission({ org_id: ORG, mission_id }), ticks: maxTicks }
}

test('full simulated mission: directive → plan → dispatch passes → research waiting_job resumed → review (honest report)', async () => {
  const w = world()
  await w.seed()
  await w.schedule()
  const res = await w.submit('Find the 3 most promising opportunities in Dallas and get them moving.')
  assert.equal(res.status, 201)
  const { data } = await res.json()
  const mission_id = data.mission.mission_id
  assert.equal(data.mission.requested_by, OPERATOR, 'the requester is the session operator, never the body')
  assert.equal(data.enqueue.ok, true)

  const { mission, ticks } = await runUntilSettled(w, mission_id)
  assert.equal(mission.status, 'completed', `mission settled as ${mission.status} after ${ticks} ticks`)
  const all = await w.store.listAssignments({ org_id: ORG, mission_id })
  const core = all.filter((a) => a.input?.follow_on !== true)
  assert.ok(core.every((a) => ['completed', 'failed', 'cancelled'].includes(a.status)), 'every core assignment is terminal')

  // the plan grew in two recorded expansions
  assert.equal(mission.plan_version, 3)
  assert.equal(mission.plan.expansions.after_opps, 'expanded')
  assert.equal(mission.plan.expansions.after_rank, 'expanded')
  const opps = all.find((a) => a.step_key === 'opps')
  assert.equal(opps.output.eligible, 6, 'held, suppressed, Hartford, Maxwell and out-of-market are excluded')
  assert.deepEqual(opps.output.excluded, { closed: 0, suppressed: 1, held: 1, never_revive: 2, out_of_scope: 0, no_property: 0 })

  // Hartford / Maxwell never appear in any assignment, anywhere
  const blob = JSON.stringify(all)
  for (const x of [HARTFORD, MAXWELL]) {
    assert.equal(blob.includes(x.opportunity_id), false)
    assert.equal(blob.includes(x.conversation_id), false)
  }
  // no contact value was ever stored (the fake store refuses them; belt and braces)
  assert.equal(contactViolation(all.map((a) => ({ input: a.input, output: a.output, evidence: a.evidence }))), null)
  assert.equal(contactViolation((await w.store.listEvents({ org_id: ORG, limit: 500 })).map((e) => e.payload)), null)
  assert.equal(contactViolation((await w.store.listExecMessages({ org_id: ORG, limit: 200 })).map((m) => [m.content, m.refs])), null)
  assert.equal(contactViolation([mission.plan, mission.report, mission.objective]), null)

  // research: the existing property.research kind, parked as waiting_job and resumed; requested_by = the named operator
  const research = all.filter((a) => a.capability_key === 'research.property' && a.runtime_job_id)
  assert.ok(research.length >= 2, `${research.length} research jobs`)
  for (const a of research) {
    assert.equal(a.status, 'completed')
    assert.equal(a.outcome_class, 'verified')
    assert.equal(a.output.mission, 'property_research', 'the output is the job result')
  }
  assert.ok(w.researched.length >= 2)
  for (const r of w.researched) assert.equal(r.requested_by, OPERATOR, 'research is accountable to the operator who issued the directive')
  const jobs = [...w.runtime._state.jobs.values()]
  for (const j of jobs.filter((x) => x.kind.startsWith('workforce.') || x.kind === 'property.research')) assert.ok([OPERATOR, OWNER].includes(j.requested_by))
  assert.ok(jobs.filter((j) => j.kind === 'workforce.coo_plan').every((j) => j.requested_by === OPERATOR))
  assert.ok(jobs.filter((j) => j.kind === 'workforce.mission_review').every((j) => j.requested_by === OPERATOR))

  // the $5M+ opportunity escalated to the CEO (an assignment, not a silent block)
  const fin6 = all.find((a) => a.capability_key === 'finance.review_opportunity' && a.input.property_ref === opp(6).property_ref)
  assert.equal(fin6.status, 'completed')
  assert.equal(fin6.outcome_class, 'refused')
  assert.equal(fin6.output.authority, 'escalate')
  assert.ok(fin6.output.reasons.includes('EXEC_REVIEW_PRICE'))
  const esc = all.find((a) => a.assignment_id === fin6.output.escalation_assignment_id)
  assert.equal(esc.assignee_employee_id, 'emp_ceo')
  assert.equal(esc.status, 'waiting_approval', 'parked in the human CEO queue; never executed by an AI')

  // the CFO challenged the ask far above MAO
  const fin5 = all.find((a) => a.capability_key === 'finance.review_opportunity' && a.input.property_ref === opp(5).property_ref)
  assert.equal(fin5.output.verdict, 'challenge')
  assert.ok(fin5.output.reasons.includes('ASK_FAR_ABOVE_MAO'))

  // the report: from assignment outputs only, and honest
  const r = mission.report
  for (const k of ['completed', 'pending', 'escalations', 'refused', 'unknowns', 'ranked', 'costs']) assert.ok(k in r, k)
  assert.deepEqual(verifyReportHonesty(r, all), [])
  const byId = new Map(all.map((a) => [a.assignment_id, a]))
  for (const c of r.completed) assert.ok(isTerminalSuccess(byId.get(c.assignment_id)), `completed item ${c.step} maps to a terminal-success assignment`)
  for (const p of r.pending) assert.equal(isTerminalSuccess(byId.get(p.assignment_id)), false)
  assert.ok(r.escalations.some((e) => e.refs.property_ref === opp(6).property_ref))
  assert.ok(r.ranked.length >= 1 && r.ranked.length <= 3)
  for (const x of r.ranked) {
    assert.equal(x.ev.status, 'unknown', 'no calibrated close rate ⇒ EV unknown')
    assert.equal(x.ev.value, null)
    if (x.next_action) assert.ok(isTerminalSuccess(byId.get(x.next_assignment_id)))
  }
  assert.ok(r.unknowns.some((u) => u.what === 'expected_value'))
  // every number traces to a step output: each numeric leaf of a completed summary is in its assignment's output,
  // and every ranked entry's components are the rank step's own output
  const nums = (v, out = []) => { if (typeof v === 'number') out.push(v); else if (v && typeof v === 'object') for (const x of Object.values(v)) nums(x, out); return out }
  for (const c of r.completed) {
    const src = nums(byId.get(c.assignment_id).output)
    for (const n of nums(c.summary)) assert.ok(src.includes(n) || n === (byId.get(c.assignment_id).output?.candidates || []).length, `${c.step}: ${n} is not in its output`)
  }
  const rankA = all.find((a) => a.step_key === 'rank')
  for (const x of r.ranked) {
    const src = rankA.output.ranked.find((y) => y.rank === x.rank)
    assert.deepEqual(x.components, src.components)
    assert.equal(x.refs.rank_assignment_id, rankA.assignment_id)
  }
  assert.equal(r.costs.status, 'known')
  // the COO said what it planned and what it verified — never more
  const msgs = (await w.store.listExecMessages({ org_id: ORG, mission_id })).reverse() // the store lists newest first
  assert.equal(msgs.filter((m) => m.author === 'coo').length, 2)
  assert.match(msgs[0].content, /Nothing in this plan contacts a seller/)
  assert.match(msgs[1].content, /verified complete/)
  // the ranking was remembered as an interpretation, with its source
  const facts = await w.store.listMemoryFacts({ org_id: ORG, scope: 'mission', scope_key: mission_id })
  assert.equal(facts.length, 1)
  assert.equal(facts[0].epistemic, 'interpretation')
  assert.ok(facts[0].source_refs.length >= 1)
  // resource claims were released when the mission completed
  assert.equal((await w.store.listResourceClaims({ org_id: ORG, active: true })).length, 0)
})

function fakeCtx(w, { job_id = 'mjob_00000000-0000-4000-8000-000000000001', input = {}, requested_by = OPERATOR, remainingMs = 20_000 } = {}) {
  return { job: { job_id, kind: 'workforce.dispatch', attempt: 1, max_attempts: 3, input, requested_by }, signal: new AbortController().signal, remainingMs: () => remainingMs, step: async () => ({ ok: true }), heartbeat: async () => ({ ok: true }), reserve: async () => 'r', settle: async () => ({ ok: true }), lease: { job_id, token: 't' } }
}

test('crash recovery: a dispatcher dies mid-assignment (its lease expires) → the next pass reaps and finishes it', async () => {
  const w = world()
  await w.seed()
  const res = await w.submit('Find the 2 most promising opportunities in Dallas.')
  const mission_id = (await res.json()).data.mission.mission_id
  await w.tick() // coo_plan
  const [opps] = await w.store.listAssignments({ org_id: ORG, mission_id })
  assert.equal(opps.step_key, 'opps')
  // a dispatcher claims it, starts it, and the process dies
  const [claimed] = await w.store.claimAssignments({ org_id: ORG, owner: 'wf-dispatch:dead', limit: 1, lease_seconds: 120 })
  assert.equal(claimed.assignment_id, opps.assignment_id)
  await w.store.progressAssignment({ org_id: ORG, assignment_id: claimed.assignment_id, lease_token: claimed.lease_token, patch: { status: 'running' } })
  // inside its lease, a new pass cannot touch it
  const early = await runDispatchPass({ store: w.store, runtimeStore: w.runtime, reads: w.reads, services: w.services, env: ENV, now: w.now, org_id: ORG, ctx: fakeCtx(w) })
  assert.equal(early.processed, 0)
  assert.equal((await w.store.getAssignment({ org_id: ORG, assignment_id: opps.assignment_id })).status, 'running')
  // the lease expires → reaped → claimed again → finished
  w.advance(121_000)
  const pass = await runDispatchPass({ store: w.store, runtimeStore: w.runtime, reads: w.reads, services: w.services, env: ENV, now: w.now, org_id: ORG, ctx: fakeCtx(w, { job_id: 'mjob_00000000-0000-4000-8000-000000000002' }) })
  assert.equal(pass.reaped.requeued, 1)
  // the store may hold a reaped row back for a backoff before it is due again
  for (let i = 3; i < 6 && (await w.store.getAssignment({ org_id: ORG, assignment_id: opps.assignment_id })).status !== 'completed'; i += 1) {
    w.advance(61_000)
    await runDispatchPass({ store: w.store, runtimeStore: w.runtime, reads: w.reads, services: w.services, env: ENV, now: w.now, org_id: ORG, ctx: fakeCtx(w, { job_id: `mjob_00000000-0000-4000-8000-00000000000${i}` }) })
  }
  const after = await w.store.getAssignment({ org_id: ORG, assignment_id: opps.assignment_id })
  assert.equal(after.status, 'completed')
  assert.equal(after.attempt, 1, 'the dead attempt is counted')
  // the late writer (the dead process waking up) loses its lease: never a silent double finish
  await assert.rejects(() => w.store.finishAssignment({ org_id: ORG, assignment_id: claimed.assignment_id, lease_token: claimed.lease_token, status: 'completed', outcome_class: 'verified', output: {} }), (e) => e.code === 'LEASE_LOST')
  // and the mission still finishes end to end
  await w.schedule()
  const { mission } = await runUntilSettled(w, mission_id)
  assert.equal(mission.status, 'completed')
  const keys = (await w.store.listAssignments({ org_id: ORG, mission_id })).map((a) => a.step_key)
  assert.equal(new Set(keys).size, keys.length, 'no duplicated step')
})

test('a replayed coo_plan event is idempotent (same mission, same assignments, one plan message)', async () => {
  const w = world()
  await w.seed()
  const res = await w.submit('Find the 2 most promising opportunities in Dallas.')
  const mission_id = (await res.json()).data.mission.mission_id
  await w.tick()
  const before = await w.store.listAssignments({ org_id: ORG, mission_id })
  const m1 = await w.store.getMission({ org_id: ORG, mission_id })
  // the same submission again → the same mission, no new coo_plan job
  const again = await w.submit('Find the 2 most promising opportunities in Dallas.')
  assert.equal(again.status, 200)
  assert.equal((await again.json()).data.mission.mission_id, mission_id)
  // a replayed event (a second coo_plan job for the same mission) → deduped by the handler
  const r = await w.runtime.enqueue({ kind: 'workforce.coo_plan', idempotency_key: runtimeIdempotencyKey('replay', mission_id), input: { mission_id }, requested_by: OPERATOR })
  assert.equal(r.ok, true)
  const t = await w.tick()
  const job = t.jobs.find((j) => j.job_id === r.job_id)
  assert.equal(job.outcome, 'completed')
  assert.equal(w.runtime._state.jobs.get(r.job_id).result.deduped, true)
  const after = await w.store.listAssignments({ org_id: ORG, mission_id })
  assert.equal(after.length >= before.length, true)
  assert.deepEqual(after.filter((a) => a.step_key === 'opps').length, 1)
  const m2 = await w.store.getMission({ org_id: ORG, mission_id })
  assert.equal(m2.plan_version >= m1.plan_version, true)
  const planMsgs = (await w.store.listExecMessages({ org_id: ORG, mission_id })).filter((m) => /^Plan:/.test(m.content))
  assert.equal(planMsgs.length, 1)
})

test('a coo_plan that crashes after writing the plan resumes without re-planning or duplicating', async () => {
  const w = world()
  await w.seed()
  const res = await w.submit('Find the 2 most promising opportunities in Dallas.')
  const mission_id = (await res.json()).data.mission.mission_id
  const real = w.store.transitionMission
  let crashed = false
  w.store.transitionMission = async (o) => { if (!crashed && o.to === 'active') { crashed = true; throw Object.assign(new Error('connection reset'), { code: 'WORKFORCE_DB_UNAVAILABLE' }) } return real(o) }
  const t1 = await w.tick()
  assert.equal(t1.jobs[0].outcome, 'retry')
  const mid = await w.store.getMission({ org_id: ORG, mission_id })
  assert.equal(mid.status, 'planning')
  assert.equal(mid.plan_version, 1)
  w.advance(60_000)
  await w.tick()
  const m = await w.store.getMission({ org_id: ORG, mission_id })
  assert.equal(m.status, 'active')
  assert.equal(m.plan_version, 1, 'the stored plan was reused, not rewritten')
  assert.equal((await w.store.listAssignments({ org_id: ORG, mission_id })).length, 1)
  assert.equal((await w.store.listExecMessages({ org_id: ORG, mission_id })).length, 1)
})

test('resource conflict: two acquisition agents can never both own one thread', async () => {
  const agents = [
    { employee_id: 'emp_acq_dallas_1', role_key: 'acquisition_agent', kind: 'ai', department_key: 'acquisitions', display_name: 'Acquisitions Dallas One', markets: ['dallas'], manager_employee_id: 'emp_head_acquisitions', status: 'active', tier_ceiling: 'T1' },
    { employee_id: 'emp_acq_dallas_2', role_key: 'acquisition_agent', kind: 'ai', department_key: 'acquisitions', display_name: 'Acquisitions Dallas Two', markets: ['dallas'], manager_employee_id: 'emp_head_acquisitions', status: 'active', tier_ceiling: 'T1' },
  ]
  const w = world({ extraEmployees: agents })
  await w.seed()
  const x = opp(1)
  const mk = async (n, agent) => {
    const { mission } = await w.store.openMission({ org_id: ORG, title: `m${n}`, directive: 'find the best deals', requested_by: OPERATOR, owner_employee_id: 'emp_coo', idempotency_key: runtimeIdempotencyKey('m', n) })
    await w.store.transitionMission({ org_id: ORG, mission_id: mission.mission_id, to: 'active' })
    await w.store.createAssignment({ org_id: ORG, mission_id: mission.mission_id, step_key: 'rank', capability_key: 'acq.rank_opportunities', assignee_employee_id: 'emp_head_acquisitions', delegated_by_employee_id: 'emp_coo', input: { slots: [], n: 1 } })
    await w.store.createAssignment({ org_id: ORG, mission_id: mission.mission_id, step_key: 'next.01', capability_key: 'acq.next_action', assignee_employee_id: agent, delegated_by_employee_id: 'emp_coo', depends_on: ['rank'], input: { property_ref: x.property_ref, conversation_id: x.conversation_id, market: 'Dallas', rank_step: 'rank', position: 1 }, resource_type: 'thread', resource_key: x.conversation_id })
    return mission.mission_id
  }
  const m1 = await mk(1, 'emp_acq_dallas_1')
  const m2 = await mk(2, 'emp_acq_dallas_2')
  // both ranks complete (no candidates needed for this rule)
  for (const r of await w.store.claimAssignments({ org_id: ORG, owner: 'test', limit: 2, lease_seconds: 120 })) {
    assert.equal(r.step_key, 'rank')
    await w.store.finishAssignment({ org_id: ORG, assignment_id: r.assignment_id, lease_token: r.lease_token, status: 'completed', outcome_class: 'verified', output: { ranked: [] } })
  }
  // agent 1 is working the thread right now (its next.01 is leased and it holds the claim)
  const [n1] = await w.store.claimAssignments({ org_id: ORG, owner: 'wf-dispatch:other', limit: 1, lease_seconds: 120 })
  assert.equal(n1.mission_id, m1)
  await w.store.acquireResourceClaim({ org_id: ORG, resource_type: 'thread', resource_key: x.conversation_id, employee_id: 'emp_acq_dallas_1', assignment_id: n1.assignment_id, ttl_seconds: 3600 })
  // the dispatcher hands agent 2 the same thread: refused, never co-owned
  await runDispatchPass({ store: w.store, runtimeStore: w.runtime, reads: w.reads, services: w.services, env: ENV, now: w.now, org_id: ORG, ctx: fakeCtx(w) })
  const n2 = (await w.store.listAssignments({ org_id: ORG, mission_id: m2 })).find((a) => a.step_key === 'next.01')
  assert.equal(n2.status, 'completed')
  assert.equal(n2.outcome_class, 'refused')
  assert.deepEqual(n2.output.reasons, ['RESOURCE_HELD_BY_ANOTHER_EMPLOYEE'])
  assert.equal(w.services.calls.getDealContextByProperty || 0, 0, 'agent 2 read nothing about the thread')
  const live = (await w.store.listResourceClaims({ org_id: ORG, active: true })).filter((c) => c.resource_key === x.conversation_id)
  assert.equal(live.length, 1)
  assert.equal(live[0].employee_id, 'emp_acq_dallas_1')
  await assert.rejects(() => w.store.acquireResourceClaim({ org_id: ORG, resource_type: 'thread', resource_key: x.conversation_id, employee_id: 'emp_acq_dallas_2', assignment_id: n2.assignment_id, ttl_seconds: 60 }), (e) => e.code === 'CLAIM_HELD')
  assert.ok((await w.store.listEvents({ org_id: ORG, limit: 500 })).some((e) => e.type === 'wf.resource.conflict'))
  // when agent 1's work is done its claim is released; an expired claim is reapable
  await w.store.finishAssignment({ org_id: ORG, assignment_id: n1.assignment_id, lease_token: n1.lease_token, status: 'completed', outcome_class: 'verified', output: { noop: true } })
  assert.equal((await w.store.listResourceClaims({ org_id: ORG, active: true })).filter((c) => c.resource_key === x.conversation_id).length, 0)
  const c = await w.store.acquireResourceClaim({ org_id: ORG, resource_type: 'thread', resource_key: x.conversation_id, employee_id: 'emp_acq_dallas_2', assignment_id: n2.assignment_id, ttl_seconds: 60 })
  assert.equal(c.employee_id, 'emp_acq_dallas_2')
  w.advance(61_000)
  assert.equal(await w.store.reapResourceClaims({ org_id: ORG }), 1)
})

test('emergency stop and a paused employee: nothing runs; the assignment is handed back or blocked, never refused as done', async () => {
  const w = world()
  await w.seed()
  const res = await w.submit('Find the 2 most promising opportunities in Dallas.')
  const mission_id = (await res.json()).data.mission.mission_id
  await w.tick()
  // the head of acquisitions is paused by the CEO
  const head = await w.store.getEmployee({ org_id: ORG, employee_id: 'emp_head_acquisitions' })
  assert.equal(head.status, 'active')
  await w.store.upsertEmployee({ org_id: ORG, employee: { employee_id: 'emp_head_acquisitions', status: 'paused' }, actor_user_id: OWNER })
  const pass = await runDispatchPass({ store: w.store, runtimeStore: w.runtime, reads: w.reads, services: w.services, env: ENV, now: w.now, org_id: ORG, ctx: fakeCtx(w) })
  const [a] = await w.store.listAssignments({ org_id: ORG, mission_id })
  assert.equal(pass.processed, 0, 'a paused employee is never handed work')
  assert.ok(['pending', 'ready'].includes(a.status), a.status)
  assert.ok(pass.reviews.includes(mission_id), 'nothing can run: the mission goes to review (it will report the pause)')
  assert.equal(w.services.calls.listDealContexts || 0, 0, 'no service was called for a paused employee')
  // the runtime emergency stop: the tick claims nothing at all
  await w.runtime.emergencyStop({ by: OWNER, reason: 'test' })
  const t = await w.tick()
  assert.equal(t.blocked, 'emergency_stop')
})

test('a paused CFO: finance reviews block, nothing pretends; the mission settles WAITING with an honest interim report', async () => {
  const w = world()
  await w.seed()
  await w.schedule()
  const res = await w.submit('Find the 2 most promising opportunities in Dallas.')
  const mission_id = (await res.json()).data.mission.mission_id
  // run until the per-candidate steps exist (staffed with the CFO), then the CEO pauses the CFO
  for (let i = 0; i < 10; i += 1) {
    await w.tick(); w.advance(61_000)
    if ((await w.store.getMission({ org_id: ORG, mission_id })).plan.expansions.after_opps === 'expanded') break
  }
  await w.store.upsertEmployee({ org_id: ORG, employee: { employee_id: 'emp_cfo', status: 'paused' }, actor_user_id: OWNER })
  const { mission } = await runUntilSettled(w, mission_id)
  assert.equal(mission.status, 'waiting')
  const all = await w.store.listAssignments({ org_id: ORG, mission_id })
  const fins = all.filter((a) => a.capability_key === 'finance.review_opportunity')
  assert.ok(fins.length >= 1 && fins.every((a) => ['pending', 'ready'].includes(a.status)), 'never claimed for a paused CFO')
  const rank = all.find((a) => a.step_key === 'rank')
  assert.equal(rank.status, 'pending', 'rank never ran on missing CFO reviews')
  const r = mission.report
  assert.equal(r.state, 'partial')
  assert.deepEqual(r.ranked, [], 'nothing ranked is claimed')
  assert.ok(r.pending.some((p) => p.step === 'rank' && p.reason.startsWith('dependency_assignee_inactive:')))
  assert.ok(r.pending.some((p) => p.capability === 'finance.review_opportunity' && p.reason === 'assignee_paused'))
  assert.deepEqual(verifyReportHonesty(r, all), [])
  const [latest] = await w.store.listExecMessages({ org_id: ORG, mission_id }) // newest first
  assert.match(latest.content, /^Interim report/)
  assert.doesNotMatch(latest.content, /Ranked/)
})

test('an unstaffed role (no active CFO when the plan grows): the steps are recorded unstaffed, never faked', async () => {
  const w = world()
  await w.seed()
  await w.store.upsertEmployee({ org_id: ORG, employee: { employee_id: 'emp_cfo', status: 'retired' }, actor_user_id: OWNER })
  await w.schedule()
  const mission_id = (await (await w.submit('Find the 2 most promising opportunities in Dallas.')).json()).data.mission.mission_id
  const { mission } = await runUntilSettled(w, mission_id)
  assert.equal(mission.status, 'waiting')
  const all = await w.store.listAssignments({ org_id: ORG, mission_id })
  assert.equal(all.filter((a) => a.capability_key === 'finance.review_opportunity').length, 0)
  assert.ok(mission.plan.steps.filter((s) => s.capability === 'finance.review_opportunity').every((s) => s.unstaffed === true))
  assert.ok(mission.report.pending.some((p) => p.step === 'rank' && p.reason.startsWith('dependency_not_staffed:')))
  assert.deepEqual(mission.report.ranked, [])
  assert.deepEqual(verifyReportHonesty(mission.report, all), [])
})

test('a deterministic store refusal fails THAT assignment (no poison pill); a failed critical step fails the mission honestly', async () => {
  const w = world()
  await w.seed()
  await w.schedule()
  const mission_id = (await (await w.submit('Find the 2 most promising opportunities in Dallas.')).json()).data.mission.mission_id
  const real = w.store.progressAssignment
  w.store.progressAssignment = async (o) => { throw Object.assign(new Error('refused'), { code: 'PAYLOAD_REFUSED' }) }
  const { mission } = await runUntilSettled(w, mission_id)
  w.store.progressAssignment = real
  assert.equal(mission.status, 'failed')
  const [opps] = await w.store.listAssignments({ org_id: ORG, mission_id })
  assert.equal(opps.status, 'failed')
  assert.equal(opps.last_error.code, 'STORE_PAYLOAD_REFUSED')
  assert.deepEqual(mission.report.completed, [])
  assert.ok(mission.report.unknowns.some((u) => u.reason === 'failed:store_payload_refused'))
  assert.ok(mission.report.unknowns.some((u) => u.what === 'plan_expansion' && u.reason === 'not_run:after_opps'))
  assert.equal(w.services.calls.listDealContexts || 0, 0)
})

test('a full-size triage report fits the 64 KB mission_report CHECK without dropping an item (found by the first demonstration)', async () => {
  const { buildMissionReport, fitReport, REPORT_BUDGET_BYTES } = await import('../../src/lib/workforce/engine/report.js')
  const { payloadViolation } = await import('../../src/lib/workforce/store/payload-guard.js')
  let n = 0
  const a = (step_key, capability_key, input, output, o = {}) => ({ assignment_id: `wfa_${String(++n).padStart(8, '0')}-0000-4000-8000-000000000000`, step_key, capability_key, assignee_employee_id: 'emp_acq_dallas_1', status: 'completed', outcome_class: 'verified', input, output, ...o })
  const all = [a('opps', 'intel.active_opportunities', {}, { scanned: 60, eligible: 30, candidates: Array.from({ length: 30 }, () => ({})), excluded: { held: 1 } })]
  const ranked = []
  for (let i = 1; i <= 30; i += 1) {
    const k = `c${String(i).padStart(2, '0')}`
    const ids = { property_ref: `pid_${'n'.repeat(3)}${'ghijklmnop'[i % 10]}${'ghijklmnop'[(i / 10) | 0]}gggggg`, opportunity_id: `0000000${i % 10}-bbbb-4000-8000-0000000000${String(i).padStart(2, '0')}`, conversation_id: `0000000${i % 10}-cccc-4000-8000-0000000000${String(i).padStart(2, '0')}` }
    all.push(a(`conv.${k}`, 'intel.conversation_state', ids, { ...ids, action_state: 'waiting_on_seller', contact_permitted: true, seller_spoke_last: false }))
    all.push(a(`dec.${k}`, 'intel.acquisition_decision', ids, { ...ids, status: 'available', tier: 'auto_hard_offer', mao: 175000, offer_ready: { ready: true }, spendability: { spendable: true } }))
    all.push(a(`res.${k}`, 'research.property', ids, { ...ids, needed: true, enqueued: true, job_id: `mjob_0000${String(i).padStart(4, '0')}-0000-4000-8000-000000000000` }, { runtime_job_id: `mjob_0000${String(i).padStart(4, '0')}-0000-4000-8000-000000000000` }))
    all.push(a(`fin.${k}`, 'finance.review_opportunity', ids, { ...ids, verdict: 'supported', reasons: ['AUTHORITATIVE_MAO', 'VALUATION_SPENDABLE', 'OFFER_READY', 'DECISION_FRESH', 'COMP_COUNT_OK', 'COMPS_RECENT'] }))
    ranked.push({ rank: i, ...ids, market: 'Dallas', components: { contact_identity: { value: 3, status: 'known', basis: ['contact_permitted', 'verified_stage:asking_price', 'seller_engaged'] }, pressure: { value: 5, status: 'known', basis: ['seller_waiting', 'offer_requested', 'stage:asking_price', 'inbound_within_7d'] }, deal_quality: { value: 20.78, status: 'known', basis: ['cfo:supported', 'confidence:0.78'] } }, ev: { value: null, status: 'unknown', missing: ['calibrated_p_close'] }, cfo_verdict: 'supported' })
  }
  all.push(a('rank', 'acq.rank_opportunities', {}, { ranked, considered: 30 }))
  for (let i = 1; i <= 25; i += 1) {
    const r = ranked[i - 1]
    all.push(a(`next.${String(i).padStart(2, '0')}`, 'acq.next_action', { position: i, property_ref: r.property_ref }, { position: i, action: 'prepare_offer_recommendation', reasons: ['cfo_supported', 'stage:asking_price'], property_ref: r.property_ref, opportunity_id: r.opportunity_id, conversation_id: r.conversation_id }))
    all.push(a(`assign.${String(i).padStart(2, '0')}`, 'work.assign', { position: i, property_ref: r.property_ref }, { assigned: true, task: 'review_offer_recommendation', follow_on_assignment_id: `wfa_f${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`, property_ref: r.property_ref }))
  }
  all.push(a('memory', 'memory.assert', {}, { asserted: true, fact: 'triage_ranking' }))
  const mission = { mission_id: 'wfm_00000000-0000-4000-8000-000000000001', plan: { intent: 'opportunity_triage', params: { n: 25 } } }
  const report = buildMissionReport({ mission, assignments: all, now: T0 })
  const size = Buffer.byteLength(JSON.stringify(report))
  assert.ok(size <= REPORT_BUDGET_BYTES, `${size} bytes`)
  assert.equal(payloadViolation(JSON.parse(JSON.stringify(report))), null)
  assert.equal(report.completed.length, all.length, 'every completed step is still listed')
  assert.deepEqual(verifyReportHonesty(report, all), [])
  assert.equal(report.ranked.length, 25)
  assert.ok(report.ranked.every((x) => x.refs.opportunity_id && x.refs.conversation_id), 'ranked refs keep every id')
  assert.ok(Array.isArray(report.compaction) && report.compaction.length >= 1, 'any compaction is named')
  // a small report is untouched
  const small = fitReport({ completed: [{ assignment_id: 'x', summary: { a: 1 } }], ranked: [] })
  assert.equal(small.compaction, undefined)
  assert.deepEqual(small.completed[0].summary, { a: 1 })
})
