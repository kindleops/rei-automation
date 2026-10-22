// Workforce store CONFORMANCE (docs/WORKFORCE.md §11): the SAME cases run against the memory twin
// (createWorkforceMemoryStore) and Postgres (createWorkforcePgStore over agent_api on a disposable
// PostgreSQL 17 carrying S3 → R2 → PROPOSED_20261022100000_workforce_foundation.sql). The memory twin is
// the engine's unit-test store, so the two must not diverge: every case asserts behaviour, error codes
// and the emitted operations feed, never an implementation detail of one side.
// PG cases are skipped — reported, never vacuous — without AGENT_PG_TEST_DB_URL.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { pgAvailable, skipReason, workforceDbFactory, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import {
  createWorkforcePgStore, createWorkforceMemoryStore, WorkforceStoreError, ASSIGNMENT_TRANSITIONS, MISSION_TRANSITIONS, ASSIGNMENT_STATES, MISSION_STATES,
  ROLE_DEPARTMENTS,
} from '../../src/lib/workforce/store/index.js'
import { payloadViolation, stringViolation } from '../../src/lib/workforce/store/payload-guard.js'

const PG_SKIP = pgAvailable() ? false : skipReason
const ORG = '00000000-0000-4000-8000-00000000a001'
const OWNER = '11111111-1111-4111-8111-111111111111'
const OPERATOR = '33333333-3333-4333-8333-333333333333'
const STRANGER = '44444444-4444-4444-8444-444444444444'
const JOB1 = 'mjob_aaaaaaaa-1111-4111-8111-111111111111'
const JOB2 = 'mjob_bbbbbbbb-2222-4222-8222-222222222222'
const JOB3 = 'mjob_cccccccc-3333-4333-8333-333333333333'
const MIGRATION = fs.readFileSync(path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261022100000_workforce_foundation.sql'), 'utf8')

const later = (s) => new Date(Date.now() + s * 1000).toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rejectsCode = (p, code) => assert.rejects(p, (e) => {
  assert.ok(e instanceof WorkforceStoreError, `expected a WorkforceStoreError, got ${e?.name}: ${e?.message}`)
  assert.equal(e.code, code, e.message)
  return true
})

// ── backends ────────────────────────────────────────────────────────────────
let factory = null
before(async () => { if (!PG_SKIP) factory = await workforceDbFactory() })
after(async () => { if (factory) await factory.dropAll() })

const BACKENDS = [
  {
    name: 'memory',
    skip: false,
    async setup() {
      const store = createWorkforceMemoryStore({ now: () => Date.now() })
      return {
        store,
        backend: 'memory',
        addMember: async (user_id, role = 'owner') => store._addMember({ org_id: ORG, user_id, role }),
        teardown: async () => {},
      }
    },
  },
  {
    name: 'pg',
    skip: PG_SKIP,
    async setup() {
      const db = await factory.fresh()
      return {
        store: createWorkforcePgStore({ pool: db.api }),
        backend: 'pg',
        db,
        addMember: async (user_id, role = 'owner') => db.pool.query("insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, $3, 'test')", [ORG, user_id, role]),
        teardown: () => db.drop(),
      }
    },
  },
]

/** the staff every case starts from: owner + operator members, CEO, COO, CFO, one acquisitions head + agent */
async function staff(ctx) {
  const { store } = ctx
  await ctx.addMember(OWNER, 'owner')
  await ctx.addMember(OPERATOR, 'operator')
  const up = (employee) => store.upsertEmployee({ org_id: ORG, employee, actor_user_id: OWNER })
  await up({ employee_id: 'emp_ceo', kind: 'human', role_key: 'ceo', department_key: 'executive', display_name: 'CEO', user_id: OWNER })
  await up({ employee_id: 'emp_coo', kind: 'ai', role_key: 'coo', department_key: 'executive', display_name: 'Atlas', manager_employee_id: 'emp_ceo' })
  await up({ employee_id: 'emp_cfo', kind: 'ai', role_key: 'cfo', department_key: 'finance', display_name: 'Ledger', manager_employee_id: 'emp_ceo' })
  await up({ employee_id: 'emp_head_acquisitions', kind: 'ai', role_key: 'head_acquisitions', department_key: 'acquisitions', display_name: 'Head of Acquisitions', manager_employee_id: 'emp_coo' })
  await up({ employee_id: 'emp_acq_01', kind: 'ai', role_key: 'acquisition_agent', department_key: 'acquisitions', display_name: 'Dallas Agent', employee_code: 'ACQ-01', manager_employee_id: 'emp_head_acquisitions', markets: ['dallas'] })
}
async function mission(ctx, { key = 'req-1', active = true, priority = 50 } = {}) {
  const { mission: m } = await ctx.store.openMission({ org_id: ORG, title: 'Triage', directive: 'find the 10 most promising sellers and get them moving', requested_by: OWNER, owner_employee_id: 'emp_coo', priority, idempotency_key: key })
  if (active) await ctx.store.transitionMission({ org_id: ORG, mission_id: m.mission_id, to: 'active' })
  return m
}
const step = (ctx, m, step_key, o = {}) => ctx.store.createAssignment({ org_id: ORG, mission_id: m.mission_id, step_key, capability_key: o.capability_key || 'intel.active_opportunities',
  assignee_employee_id: o.assignee || 'emp_head_acquisitions', delegated_by_employee_id: 'emp_coo', depends_on: o.depends_on || [], input: o.input || {},
  resource_type: o.resource_type ?? null, resource_key: o.resource_key ?? null, max_attempts: o.max_attempts ?? null, parent_assignment_id: o.parent ?? null })
  .then((r) => r.assignment)
const claim = (ctx, o = {}) => ctx.store.claimAssignments({ org_id: ORG, owner: o.owner || 'worker-1', limit: o.limit ?? 10, lease_seconds: o.lease_seconds ?? 60, now: o.now ?? null })

// ── the cases ───────────────────────────────────────────────────────────────
const CASES = [
  ['idempotent mission open: one submission = one mission', async (ctx) => {
    await staff(ctx)
    const a = await ctx.store.openMission({ org_id: ORG, title: 'Triage', directive: 'find sellers', requested_by: OWNER, owner_employee_id: 'emp_coo', idempotency_key: 'client-req-7' })
    const b = await ctx.store.openMission({ org_id: ORG, title: 'Different', directive: 'other text', requested_by: OWNER, owner_employee_id: 'emp_coo', idempotency_key: 'client-req-7' })
    const c = await ctx.store.openMission({ org_id: ORG, title: 'Other', directive: 'other text', requested_by: OWNER, owner_employee_id: 'emp_coo', idempotency_key: 'client-req-8' })
    assert.equal(a.created, true)
    assert.equal(b.created, false)
    assert.equal(b.mission.mission_id, a.mission.mission_id)
    assert.equal(b.mission.title, 'Triage', 'the replay returns the original mission')
    assert.notEqual(c.mission.mission_id, a.mission.mission_id)
    assert.match(a.mission.mission_id, /^wfm_[0-9a-f-]{36}$/)
    assert.match(a.mission.idempotency_key, /^[0-9a-f]{64}$/, 'no raw caller key is stored')
    assert.equal(a.mission.status, 'planning')
    assert.equal(a.mission.plan_version, 0)
    assert.equal(a.mission.priority, 50)
    assert.equal((await ctx.store.listMissions({ org_id: ORG })).length, 2)
    assert.deepEqual((await ctx.store.getMission({ org_id: ORG, mission_id: a.mission.mission_id })).mission_id, a.mission.mission_id)
    await rejectsCode(ctx.store.openMission({ org_id: ORG, title: 'x', directive: 'x', requested_by: OWNER, owner_employee_id: 'emp_nobody', idempotency_key: 'k9' }), 'NOT_FOUND')
    await rejectsCode(ctx.store.openMission({ org_id: ORG, title: 'x', directive: 'x', requested_by: null, owner_employee_id: 'emp_coo', idempotency_key: 'k10' }), 'FORBIDDEN')
  }],

  ['plan version mismatch: optimistic plan_version', async (ctx) => {
    await staff(ctx)
    const m = await mission(ctx, { active: false })
    const v1 = await ctx.store.setMissionPlan({ org_id: ORG, mission_id: m.mission_id, objective: { intent: 'opportunity_triage', count: 10 }, playbook_key: 'opportunity_triage', plan: { steps: [{ step: 'find' }] }, expected_version: 0 })
    assert.equal(v1.plan_version, 1)
    assert.equal(v1.playbook_key, 'opportunity_triage')
    assert.deepEqual(v1.objective, { intent: 'opportunity_triage', count: 10 })
    await rejectsCode(ctx.store.setMissionPlan({ org_id: ORG, mission_id: m.mission_id, plan: {}, expected_version: 0 }), 'VERSION_MISMATCH')
    const v2 = await ctx.store.setMissionPlan({ org_id: ORG, mission_id: m.mission_id, plan: { steps: [] }, expected_version: 1 })
    assert.equal(v2.plan_version, 2)
    assert.deepEqual(v2.objective, { intent: 'opportunity_triage', count: 10 }, 'a null objective keeps the current one')
    await rejectsCode(ctx.store.setMissionPlan({ org_id: ORG, mission_id: 'wfm_00000000-0000-4000-8000-000000000000', plan: {}, expected_version: 0 }), 'NOT_FOUND')
  }],

  ['dependency-gated claim: pending → ready only when every depends_on step completed', async (ctx) => {
    await staff(ctx)
    const m = await mission(ctx, { active: false })
    const a = await step(ctx, m, 'find')
    const b = await step(ctx, m, 'decide', { depends_on: ['find'], capability_key: 'intel.acquisition_decision' })
    const c = await step(ctx, m, 'rank', { depends_on: ['find', 'decide'], capability_key: 'acq.rank_opportunities' })
    assert.equal(a.status, 'pending', 'born pending')
    assert.deepEqual(await claim(ctx), [], 'a planning mission is never claimed')
    await ctx.store.transitionMission({ org_id: ORG, mission_id: m.mission_id, to: 'active' })
    const first = await claim(ctx)
    assert.deepEqual(first.map((x) => x.assignment_id), [a.assignment_id])
    assert.equal(first[0].status, 'leased')
    assert.equal(first[0].lease_owner, 'worker-1')
    assert.ok(first[0].lease_token)
    assert.equal((await ctx.store.getAssignment({ org_id: ORG, assignment_id: b.assignment_id })).status, 'pending')
    assert.deepEqual(await claim(ctx), [], 'nothing else is due')
    await ctx.store.finishAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: first[0].lease_token, status: 'completed', outcome_class: 'verified', output: { candidates: 3 } })
    const second = await claim(ctx)
    assert.deepEqual(second.map((x) => x.assignment_id), [b.assignment_id])
    assert.equal((await ctx.store.getAssignment({ org_id: ORG, assignment_id: c.assignment_id })).status, 'pending', 'one dependency is still open')
    await ctx.store.finishAssignment({ org_id: ORG, assignment_id: b.assignment_id, lease_token: second[0].lease_token, status: 'completed', outcome_class: 'partial' })
    assert.deepEqual((await claim(ctx)).map((x) => x.assignment_id), [c.assignment_id])
    // idempotent create on (mission, step_key)
    const again = await ctx.store.createAssignment({ org_id: ORG, mission_id: m.mission_id, step_key: 'find', capability_key: 'intel.active_opportunities', assignee_employee_id: 'emp_coo' })
    assert.equal(again.created, false)
    assert.equal(again.assignment.assignment_id, a.assignment_id)
  }],

  ['a failed dependency cancels its dependents (they can never run)', async (ctx) => {
    await staff(ctx)
    const m = await mission(ctx)
    const a = await step(ctx, m, 'find')
    const b = await step(ctx, m, 'rank', { depends_on: ['find'] })
    const [x] = await claim(ctx)
    await ctx.store.finishAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: x.lease_token, status: 'failed', outcome_class: 'unknown', error: { code: 'SOURCE_UNAVAILABLE' } })
    assert.deepEqual(await claim(ctx), [])
    const bb = await ctx.store.getAssignment({ org_id: ORG, assignment_id: b.assignment_id })
    assert.equal(bb.status, 'cancelled')
    assert.deepEqual(bb.last_error, { code: 'DEPENDENCY_FAILED', step: 'find' })
    assert.ok(bb.finished_at)
  }],

  ['SKIP LOCKED: two concurrent claimers take disjoint rows', async (ctx) => {
    await staff(ctx)
    const m = await mission(ctx)
    for (let i = 0; i < 10; i += 1) await step(ctx, m, `s${i}`)
    const one = await claim(ctx, { limit: 1 })
    assert.equal(one.length, 1)
    const [p, q] = await Promise.all([claim(ctx, { owner: 'worker-a', limit: 5 }), claim(ctx, { owner: 'worker-b', limit: 5 })])
    const ids = [...one, ...p, ...q].map((x) => x.assignment_id)
    assert.equal(new Set(ids).size, ids.length, 'no assignment is leased twice')
    assert.equal(ids.length, 10, 'together they take every due row')
    assert.ok(p.every((x) => x.lease_owner === 'worker-a') && q.every((x) => x.lease_owner === 'worker-b'))
    assert.deepEqual(await claim(ctx), [])
  }],

  ['lease lost: a wrong or reaped token writes nothing', async (ctx) => {
    await staff(ctx)
    const m = await mission(ctx)
    const a = await step(ctx, m, 'find')
    const [x] = await claim(ctx, { lease_seconds: 60 })
    await rejectsCode(ctx.store.progressAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: '99999999-9999-4999-8999-999999999999', patch: { status: 'running' } }), 'LEASE_LOST')
    const run = await ctx.store.progressAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: x.lease_token, patch: { status: 'running', output: { a: 1 }, evidence: [{ source: 'deal_context' }] } })
    assert.equal(run.status, 'running')
    const more = await ctx.store.progressAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: x.lease_token, patch: { output: { b: 2 }, evidence: [{ source: 'thread_context' }] } })
    assert.deepEqual(more.output, { a: 1, b: 2 }, 'output merges')
    assert.equal(more.evidence.length, 2, 'evidence appends')
    const r = await ctx.store.reapAssignments({ org_id: ORG, now: later(3600) })
    assert.deepEqual(r, { requeued: 1, failed: 0 })
    await rejectsCode(ctx.store.progressAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: x.lease_token, patch: {} }), 'LEASE_LOST')
    await rejectsCode(ctx.store.finishAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: x.lease_token, status: 'completed', outcome_class: 'verified' }), 'LEASE_LOST')
    await rejectsCode(ctx.store.waitAssignmentOnJob({ org_id: ORG, assignment_id: a.assignment_id, lease_token: x.lease_token, runtime_job_id: JOB1 }), 'LEASE_LOST')
    await rejectsCode(ctx.store.progressAssignment({ org_id: ORG, assignment_id: 'wfa_00000000-0000-4000-8000-000000000000', lease_token: x.lease_token, patch: {} }), 'NOT_FOUND')
  }],

  ['reap → retry → failed past max_attempts', async (ctx) => {
    await staff(ctx)
    const m = await mission(ctx)
    const a = await step(ctx, m, 'find', { max_attempts: 2 })
    await claim(ctx)
    const r1 = await ctx.store.reapAssignments({ org_id: ORG, now: later(120) })
    assert.deepEqual(r1, { requeued: 1, failed: 0 })
    const after1 = await ctx.store.getAssignment({ org_id: ORG, assignment_id: a.assignment_id })
    assert.equal(after1.status, 'ready')
    assert.equal(after1.attempt, 1)
    assert.equal(after1.lease_token, null)
    assert.equal(after1.last_error.code, 'LEASE_EXPIRED')
    assert.ok(after1.next_attempt_at > later(120), 'backoff from the reap time')
    assert.deepEqual(await claim(ctx, { now: later(130) }), [], 'not due before the backoff')
    const [again] = await claim(ctx, { now: later(400) })
    assert.equal(again.assignment_id, a.assignment_id)
    const r2 = await ctx.store.reapAssignments({ org_id: ORG, now: later(4000) })
    assert.deepEqual(r2, { requeued: 0, failed: 1 })
    const dead = await ctx.store.getAssignment({ org_id: ORG, assignment_id: a.assignment_id })
    assert.equal(dead.status, 'failed')
    assert.equal(dead.attempt, 2)
    assert.ok(dead.finished_at)
    assert.deepEqual(await claim(ctx, { now: later(9000) }), [])
  }],

  ['finish retry burns an attempt and fails when exhausted; a finish replay is idempotent', async (ctx) => {
    await staff(ctx)
    const m = await mission(ctx)
    const a = await step(ctx, m, 'find', { max_attempts: 2 })
    const [x] = await claim(ctx)
    const r = await ctx.store.finishAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: x.lease_token, status: 'retry', error: { code: 'TRANSIENT' }, retry_after_seconds: 300 })
    assert.equal(r.status, 'ready')
    assert.equal(r.attempt, 1)
    assert.deepEqual(r.last_error, { code: 'TRANSIENT' })
    const replay = await ctx.store.finishAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: x.lease_token, status: 'retry' })
    assert.equal(replay.attempt, 1, 'the same finish with the same token returns the recorded row')
    assert.deepEqual(await claim(ctx), [], 'not before retry_after')
    const [y] = await claim(ctx, { now: later(301) })
    await rejectsCode(ctx.store.finishAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: y.lease_token, status: 'bogus' }), 'PAYLOAD_REFUSED')
    const f = await ctx.store.finishAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: y.lease_token, status: 'retry' })
    assert.equal(f.status, 'failed', 'attempt reached max_attempts')
    assert.equal(f.attempt, 2)
    assert.equal((await ctx.store.finishAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: y.lease_token, status: 'completed', outcome_class: 'verified' })).status, 'failed', 'a replayed token returns the recorded terminal row')
  }],

  ['waiting_job resume: completed → completed (verified); failed → retry, then failed', async (ctx) => {
    await staff(ctx)
    const m = await mission(ctx)
    const a = await step(ctx, m, 'research_a', { capability_key: 'research.property', max_attempts: 2 })
    const b = await step(ctx, m, 'research_b', { capability_key: 'research.property', max_attempts: 2 })
    const c = await step(ctx, m, 'research_c', { capability_key: 'research.property' })
    const leases = Object.fromEntries((await claim(ctx)).map((x) => [x.assignment_id, x.lease_token]))
    await rejectsCode(ctx.store.waitAssignmentOnJob({ org_id: ORG, assignment_id: a.assignment_id, lease_token: leases[a.assignment_id], runtime_job_id: 'job-123' }), 'PAYLOAD_REFUSED')
    const w = await ctx.store.waitAssignmentOnJob({ org_id: ORG, assignment_id: a.assignment_id, lease_token: leases[a.assignment_id], runtime_job_id: JOB1 })
    assert.equal(w.status, 'waiting_job')
    assert.equal(w.lease_token, null, 'the lease is released while waiting')
    const wr = await ctx.store.waitAssignmentOnJob({ org_id: ORG, assignment_id: a.assignment_id, lease_token: leases[a.assignment_id], runtime_job_id: JOB1 })
    assert.equal(wr.status, 'waiting_job', 'replay-safe')
    await ctx.store.waitAssignmentOnJob({ org_id: ORG, assignment_id: b.assignment_id, lease_token: leases[b.assignment_id], runtime_job_id: JOB2 })
    await ctx.store.waitAssignmentOnJob({ org_id: ORG, assignment_id: c.assignment_id, lease_token: leases[c.assignment_id], runtime_job_id: JOB3 })
    const jobs = { [JOB1]: { state: 'completed', result: { findings: 4 } }, [JOB2]: { state: 'failed', error: { reason: 'provider' } }, [JOB3]: { state: 'running' } }
    const n = await ctx.store.resumeWaitingAssignments({ org_id: ORG, resolver: async (id) => jobs[id] || null })
    assert.equal(n, 2, 'a running job changes nothing')
    const aa = await ctx.store.getAssignment({ org_id: ORG, assignment_id: a.assignment_id })
    assert.equal(aa.status, 'completed')
    assert.equal(aa.outcome_class, 'verified')
    assert.deepEqual(aa.output, { findings: 4 })
    assert.deepEqual(aa.evidence.at(-1), { source: 'agent.research_job', job_id: JOB1 })
    const bb = await ctx.store.getAssignment({ org_id: ORG, assignment_id: b.assignment_id })
    assert.equal(bb.status, 'ready')
    assert.equal(bb.attempt, 1)
    assert.equal(bb.runtime_job_id, null)
    assert.equal(bb.last_error.code, 'RUNTIME_JOB_FAILED')
    assert.equal(bb.last_error.reason, 'provider')
    assert.equal((await ctx.store.getAssignment({ org_id: ORG, assignment_id: c.assignment_id })).status, 'waiting_job')
    const [again] = await claim(ctx, { now: later(3600) })
    await ctx.store.waitAssignmentOnJob({ org_id: ORG, assignment_id: b.assignment_id, lease_token: again.lease_token, runtime_job_id: JOB1 })
    assert.equal(await ctx.store.resumeWaitingAssignments({ org_id: ORG, resolver: async (id) => (id === JOB1 ? { state: 'dead_letter' } : null) }), 1)
    const dead = await ctx.store.getAssignment({ org_id: ORG, assignment_id: b.assignment_id })
    assert.equal(dead.status, 'failed')
    assert.equal(dead.attempt, 2)
  }],

  ['resource claim: exclusive, renewable, released on finish, expiry takeover, reap', async (ctx) => {
    await staff(ctx)
    const m = await mission(ctx)
    const a = await step(ctx, m, 'work_a', { resource_type: 'property', resource_key: 'pid_ghijklmnop' })
    const b = await step(ctx, m, 'work_b', { assignee: 'emp_acq_01' })
    const c1 = await ctx.store.acquireResourceClaim({ org_id: ORG, resource_type: 'property', resource_key: 'pid_ghijklmnop', employee_id: 'emp_head_acquisitions', assignment_id: a.assignment_id, ttl_seconds: 600 })
    assert.equal(c1.released_at, null)
    await rejectsCode(ctx.store.acquireResourceClaim({ org_id: ORG, resource_type: 'property', resource_key: 'pid_ghijklmnop', employee_id: 'emp_acq_01', assignment_id: b.assignment_id, ttl_seconds: 600 }), 'CLAIM_HELD')
    const renewed = await ctx.store.acquireResourceClaim({ org_id: ORG, resource_type: 'property', resource_key: 'pid_ghijklmnop', employee_id: 'emp_head_acquisitions', assignment_id: a.assignment_id, ttl_seconds: 1200 })
    assert.equal(renewed.claim_id, c1.claim_id, 'the same holder renews')
    assert.ok(renewed.expires_at > c1.expires_at)
    await ctx.store.releaseResourceClaim({ org_id: ORG, resource_type: 'property', resource_key: 'pid_ghijklmnop', assignment_id: b.assignment_id })
    assert.equal((await ctx.store.listResourceClaims({ org_id: ORG })).length, 1, 'only the holder releases')
    // a terminal assignment releases what it holds
    const leases = Object.fromEntries((await claim(ctx)).map((x) => [x.assignment_id, x.lease_token]))
    await ctx.store.finishAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: leases[a.assignment_id], status: 'completed', outcome_class: 'verified' })
    assert.equal((await ctx.store.listResourceClaims({ org_id: ORG })).length, 0)
    const all = await ctx.store.listResourceClaims({ org_id: ORG, active: false })
    assert.equal(all[0].release_reason, 'finished')
    // expiry: reap
    await ctx.store.acquireResourceClaim({ org_id: ORG, resource_type: 'thread', resource_key: '7f6c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f', employee_id: 'emp_acq_01', assignment_id: b.assignment_id, ttl_seconds: 60 })
    assert.equal(await ctx.store.reapResourceClaims({ org_id: ORG }), 0, 'not expired yet')
    assert.equal(await ctx.store.reapResourceClaims({ org_id: ORG, now: later(120) }), 1)
    await ctx.store.acquireResourceClaim({ org_id: ORG, resource_type: 'thread', resource_key: '7f6c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f', employee_id: 'emp_coo', ttl_seconds: 60 })
    // expiry: an expired claim is taken over on acquire
    await ctx.store.acquireResourceClaim({ org_id: ORG, resource_type: 'opportunity', resource_key: 'c0ffee00-1111-4111-8111-111111111111', employee_id: 'emp_coo', ttl_seconds: 1 })
    await sleep(1100)
    const taken = await ctx.store.acquireResourceClaim({ org_id: ORG, resource_type: 'opportunity', resource_key: 'c0ffee00-1111-4111-8111-111111111111', employee_id: 'emp_acq_01', assignment_id: b.assignment_id, ttl_seconds: 60 })
    assert.equal(taken.employee_id, 'emp_acq_01')
    const reasons = (await ctx.store.listResourceClaims({ org_id: ORG, active: false })).map((x) => x.release_reason).filter(Boolean).sort()
    assert.deepEqual(reasons, ['expired', 'expired', 'finished'])
    await rejectsCode(ctx.store.acquireResourceClaim({ org_id: ORG, resource_type: 'property', resource_key: '2124415662', employee_id: 'emp_coo', ttl_seconds: 60 }), 'PAYLOAD_REFUSED')
    await rejectsCode(ctx.store.acquireResourceClaim({ org_id: ORG, resource_type: 'property', resource_key: 'pid_hhh', employee_id: 'emp_nobody', ttl_seconds: 60 }), 'NOT_FOUND')
  }],

  ['memory supersede: one live fact per identity; identical assertion is a no-op', async (ctx) => {
    await staff(ctx)
    const base = { org_id: ORG, scope: 'market', scope_key: 'dallas', fact_key: 'acq.best_segment', epistemic: 'interpretation', author_employee_id: 'emp_head_acquisitions' }
    const f1 = await ctx.store.assertMemoryFact({ ...base, value: { segment: 'sfr_llc' }, confidence: 0.6, source_refs: [] })
    const f2 = await ctx.store.assertMemoryFact({ ...base, value: { segment: 'mf_2_4' }, confidence: 0.7, source_refs: ['assignment:wfa_00000000-0000-4000-8000-000000000001'] })
    const same = await ctx.store.assertMemoryFact({ ...base, value: { segment: 'mf_2_4' }, confidence: 0.7, source_refs: ['assignment:wfa_00000000-0000-4000-8000-000000000001'] })
    assert.equal(same.fact_id, f2.fact_id, 'an identical assertion returns the live fact')
    const live = await ctx.store.listMemoryFacts({ org_id: ORG, scope: 'market', scope_key: 'dallas' })
    assert.deepEqual(live.map((f) => f.fact_id), [f2.fact_id])
    const all = await ctx.store.listMemoryFacts({ org_id: ORG, scope: 'market', include_superseded: true })
    assert.equal(all.length, 2)
    const old = all.find((f) => f.fact_id === f1.fact_id)
    assert.equal(old.superseded_by, f2.fact_id)
    assert.ok(old.superseded_at)
    assert.deepEqual(old.value, { segment: 'sfr_llc' }, 'the old value is never updated')
    assert.equal(f2.confidence, 0.7)
    // a different epistemic class is a different identity
    const v = await ctx.store.assertMemoryFact({ ...base, epistemic: 'verified', value: 3, source_refs: [{ source: 'agent.research_job', job_id: JOB1 }] })
    assert.equal((await ctx.store.listMemoryFacts({ org_id: ORG, scope: 'market' })).length, 2)
    assert.equal(v.epistemic, 'verified')
    await rejectsCode(ctx.store.assertMemoryFact({ ...base, scope: 'property', scope_key: '2124415662', value: 1 }), 'PAYLOAD_REFUSED')
  }],

  ['verified without a source ref is refused (an interpretation never becomes verified)', async (ctx) => {
    await staff(ctx)
    const base = { org_id: ORG, scope: 'company', scope_key: 'company', fact_key: 'ops.cadence', value: { minutes: 60 }, author_employee_id: 'emp_coo' }
    await rejectsCode(ctx.store.assertMemoryFact({ ...base, epistemic: 'verified', source_refs: [] }), 'PAYLOAD_REFUSED')
    await rejectsCode(ctx.store.assertMemoryFact({ ...base, epistemic: 'verified' }), 'PAYLOAD_REFUSED')
    await ctx.store.assertMemoryFact({ ...base, epistemic: 'interpretation', source_refs: [] })
    const ok = await ctx.store.assertMemoryFact({ ...base, epistemic: 'verified', source_refs: ['mission:wfm_00000000-0000-4000-8000-000000000001'] })
    assert.equal(ok.epistemic, 'verified')
    await rejectsCode(ctx.store.assertMemoryFact({ ...base, epistemic: 'interpretation', author_employee_id: null }), 'PAYLOAD_REFUSED')
  }],

  ['ceo_policy is authored only by an owner', async (ctx) => {
    await staff(ctx)
    const base = { org_id: ORG, scope: 'company', scope_key: 'company', fact_key: 'policy.offers', value: 'never above MAO', epistemic: 'ceo_policy' }
    await rejectsCode(ctx.store.assertMemoryFact({ ...base, author_user_id: OPERATOR }), 'FORBIDDEN')
    await rejectsCode(ctx.store.assertMemoryFact({ ...base, author_user_id: STRANGER }), 'FORBIDDEN')
    await rejectsCode(ctx.store.assertMemoryFact({ ...base, author_employee_id: 'emp_coo' }), 'FORBIDDEN')
    const f = await ctx.store.assertMemoryFact({ ...base, author_user_id: OWNER })
    assert.equal(f.author_user_id, OWNER)
    assert.equal(f.value, 'never above MAO')
  }],

  ['payload refusals: phones / emails in human text, message-body and *_key keys in jsonb, raw property ids', async (ctx) => {
    await staff(ctx)
    const open = (directive, title = 'Triage', key = directive) => ctx.store.openMission({ org_id: ORG, title, directive, requested_by: OWNER, owner_employee_id: 'emp_coo', idempotency_key: key.slice(0, 200) })
    await rejectsCode(open('text the seller at 612-555-0147 now'), 'PAYLOAD_REFUSED')
    await rejectsCode(open('call +1 (612) 555 0147'), 'PAYLOAD_REFUSED')
    await rejectsCode(open('email rosa@example.com'), 'PAYLOAD_REFUSED')
    await rejectsCode(open('fine directive', 'Call 6125550147'), 'PAYLOAD_REFUSED')
    await rejectsCode(open('NjEyNTU1MDE0Nw=='), 'PAYLOAD_REFUSED')
    const ok = await open('find the 10 most promising Dallas sellers under $5,000,000 by 2026-11-01')
    assert.equal(ok.created, true)
    const m = await mission(ctx, { key: 'req-payload' })
    await rejectsCode(ctx.store.appendExecMessage({ org_id: ORG, author: 'ceo', author_user_id: OWNER, content: 'my cell is 612.555.0147', mission_id: m.mission_id }), 'PAYLOAD_REFUSED')
    await rejectsCode(ctx.store.appendExecMessage({ org_id: ORG, author: 'coo', author_employee_id: 'emp_coo', content: 'reach me at atlas@leadcommand.ai' }), 'PAYLOAD_REFUSED')
    await rejectsCode(ctx.store.appendExecMessage({ org_id: ORG, author: 'coo', author_employee_id: 'emp_coo', content: 'see refs', refs: ['property:2124415662'] }), 'PAYLOAD_REFUSED')
    const msg = await ctx.store.appendExecMessage({ org_id: ORG, author: 'coo', author_employee_id: 'emp_coo', content: 'Plan ready: 8 steps.', refs: ['property:pid_ghijklmnop', { mission_id: m.mission_id }], mission_id: m.mission_id })
    assert.equal(msg.refs.length, 2)
    await rejectsCode(step(ctx, m, 'body', { input: { message_body: 'hi there' } }), 'PAYLOAD_REFUSED')
    await rejectsCode(step(ctx, m, 'sms', { input: { nested: [{ sms_text: 'x' }] } }), 'PAYLOAD_REFUSED')
    await rejectsCode(step(ctx, m, 'phone', { input: { note: 'owner 612 555 0147' } }), 'PAYLOAD_REFUSED')
    await rejectsCode(step(ctx, m, 'contact', { input: { phone: '6125550147' } }), 'PAYLOAD_REFUSED')
    await rejectsCode(step(ctx, m, 'pid', { input: { property_id: '2124415662' } }), 'PAYLOAD_REFUSED')
    await rejectsCode(step(ctx, m, 'rawkey', { resource_type: 'property', resource_key: '2124415662' }), 'PAYLOAD_REFUSED')
    await rejectsCode(step(ctx, m, 'credkey', { input: { step_key: 'x' } }), 'PAYLOAD_REFUSED')
    await rejectsCode(ctx.store.setMissionPlan({ org_id: ORG, mission_id: m.mission_id, plan: { steps: [{ capability_key: 'intel.x' }] }, expected_version: 0 }), 'PAYLOAD_REFUSED')
    const good = await step(ctx, m, 'good', { input: { property_id: 'pid_ghijklmnop', count: 10, market: 'dallas', thread_id: '7f6c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f' }, resource_type: 'property', resource_key: 'pid_ghijklmnop' })
    assert.equal(good.input.property_id, 'pid_ghijklmnop')
    await rejectsCode(ctx.store.appendEvent({ org_id: ORG, type: 'wf.test', payload: { content: 'x' } }), 'PAYLOAD_REFUSED')
    await rejectsCode(ctx.store.appendEvent({ org_id: ORG, type: 'job.test', payload: {} }), 'PAYLOAD_REFUSED')
    await rejectsCode(ctx.store.putKpi({ org_id: ORG, subject_type: 'org', subject_key: 'org', kpi_key: 'offers.count', window: '7d', value: 4, status: 'known', source: { note: 'owner 612-555-0147' } }), 'PAYLOAD_REFUSED')
  }],

  ['illegal transitions are refused (assignment + mission state graphs)', async (ctx) => {
    await staff(ctx)
    const m = await mission(ctx, { active: false })
    await rejectsCode(ctx.store.transitionMission({ org_id: ORG, mission_id: m.mission_id, to: 'completed' }), 'ILLEGAL_TRANSITION')
    await rejectsCode(ctx.store.transitionMission({ org_id: ORG, mission_id: m.mission_id, to: 'bogus' }), 'ILLEGAL_TRANSITION')
    assert.equal((await ctx.store.transitionMission({ org_id: ORG, mission_id: m.mission_id, to: 'planning' })).status, 'planning', 'a repeat is a no-op')
    await ctx.store.transitionMission({ org_id: ORG, mission_id: m.mission_id, to: 'active' })
    const a = await step(ctx, m, 'find')
    const b = await step(ctx, m, 'hold')
    const leases = Object.fromEntries((await claim(ctx)).map((x) => [x.assignment_id, x.lease_token]))
    await rejectsCode(ctx.store.progressAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: leases[a.assignment_id], patch: { status: 'completed' } }), 'ILLEGAL_TRANSITION')
    await rejectsCode(ctx.store.progressAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: leases[a.assignment_id], patch: { foo: 1 } }), 'PAYLOAD_REFUSED')
    await rejectsCode(ctx.store.finishAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: leases[a.assignment_id], status: 'completed' }), 'PAYLOAD_REFUSED')
    await rejectsCode(ctx.store.transferAssignment({ org_id: ORG, assignment_id: a.assignment_id, to_employee_id: 'emp_acq_01', actor: 'emp_coo' }), 'CONFLICT')
    await rejectsCode(ctx.store.resolveHeldAssignment({ org_id: ORG, assignment_id: a.assignment_id, to: 'ready', actor: 'emp_coo' }), 'ILLEGAL_TRANSITION')
    const held = await ctx.store.finishAssignment({ org_id: ORG, assignment_id: b.assignment_id, lease_token: leases[b.assignment_id], status: 'blocked', error: { code: 'HELD_PROPERTY' } })
    assert.equal(held.status, 'blocked')
    await rejectsCode(ctx.store.resolveHeldAssignment({ org_id: ORG, assignment_id: b.assignment_id, to: 'failed', actor: 'emp_coo' }), 'ILLEGAL_TRANSITION')
    await rejectsCode(ctx.store.resolveHeldAssignment({ org_id: ORG, assignment_id: b.assignment_id, to: 'ready', actor: 'nobody' }), 'FORBIDDEN')
    assert.equal((await ctx.store.resolveHeldAssignment({ org_id: ORG, assignment_id: b.assignment_id, to: 'ready', actor: OWNER })).status, 'ready')
    await ctx.store.finishAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: leases[a.assignment_id], status: 'cancelled' })
    await rejectsCode(ctx.store.transferAssignment({ org_id: ORG, assignment_id: a.assignment_id, to_employee_id: 'emp_acq_01', actor: 'emp_coo' }), 'ILLEGAL_TRANSITION')
    await ctx.store.transitionMission({ org_id: ORG, mission_id: m.mission_id, to: 'cancelled' })
    await rejectsCode(ctx.store.transitionMission({ org_id: ORG, mission_id: m.mission_id, to: 'active' }), 'ILLEGAL_TRANSITION')
    await rejectsCode(step(ctx, m, 'late'), 'ILLEGAL_TRANSITION')
    await rejectsCode(ctx.store.setMissionPlan({ org_id: ORG, mission_id: m.mission_id, plan: {}, expected_version: 0 }), 'ILLEGAL_TRANSITION')
    assert.ok((await ctx.store.getMission({ org_id: ORG, mission_id: m.mission_id })).completed_at, 'a terminal mission is stamped')
  }],

  ['transfer, hold resolution and mission cancellation', async (ctx) => {
    await staff(ctx)
    const m = await mission(ctx)
    const a = await step(ctx, m, 'review', { assignee: 'emp_coo', resource_type: 'opportunity', resource_key: 'c0ffee00-1111-4111-8111-111111111111' })
    const b = await step(ctx, m, 'later', { depends_on: ['review'] })
    const t = await ctx.store.transferAssignment({ org_id: ORG, assignment_id: a.assignment_id, to_employee_id: 'emp_ceo', actor: 'emp_coo' })
    assert.equal(t.assignee_employee_id, 'emp_ceo')
    assert.equal(t.status, 'pending', 'transfer never changes the status')
    await rejectsCode(ctx.store.transferAssignment({ org_id: ORG, assignment_id: a.assignment_id, to_employee_id: 'emp_nobody', actor: 'emp_coo' }), 'NOT_FOUND')
    const [x] = await claim(ctx)
    await ctx.store.acquireResourceClaim({ org_id: ORG, resource_type: 'opportunity', resource_key: 'c0ffee00-1111-4111-8111-111111111111', employee_id: 'emp_ceo', assignment_id: a.assignment_id, ttl_seconds: 600 })
    const w = await ctx.store.finishAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: x.lease_token, status: 'waiting_approval', output: { reason: 'price_above_exec_review' } })
    assert.equal(w.status, 'waiting_approval')
    assert.equal(w.lease_token, null)
    const n = await ctx.store.cancelMissionAssignments({ org_id: ORG, mission_id: m.mission_id })
    assert.equal(n, 2)
    assert.deepEqual((await ctx.store.listAssignments({ org_id: ORG, mission_id: m.mission_id })).map((y) => y.status), ['cancelled', 'cancelled'])
    assert.equal((await ctx.store.listResourceClaims({ org_id: ORG })).length, 0, 'claims are released')
    assert.equal(await ctx.store.cancelMissionAssignments({ org_id: ORG, mission_id: m.mission_id }), 0)
    const ev = (await ctx.store.listEvents({ org_id: ORG, mission_id: m.mission_id, limit: 500 })).map((e) => e.type)
    assert.ok(ev.includes('wf.assignment.transferred'))
    assert.ok(b.assignment_id)
  }],

  ['employees: CEO-authored, one CEO, role ↔ department, no manager cycle, kind immutable, heartbeat', async (ctx) => {
    await staff(ctx)
    const up = (employee, actor = OWNER) => ctx.store.upsertEmployee({ org_id: ORG, employee, actor_user_id: actor })
    await rejectsCode(up({ employee_id: 'emp_x01', kind: 'ai', role_key: 'cfo', department_key: 'finance', display_name: 'X' }, OPERATOR), 'FORBIDDEN')
    await rejectsCode(up({ employee_id: 'emp_ceo2', kind: 'human', role_key: 'ceo', department_key: 'executive', display_name: 'Two', user_id: OPERATOR }), 'CONFLICT')
    await rejectsCode(up({ employee_id: 'emp_x02', kind: 'ai', role_key: 'cfo', department_key: 'marketing', display_name: 'X' }), 'PAYLOAD_REFUSED')
    await rejectsCode(up({ employee_id: 'emp_x03', kind: 'ai', role_key: 'coo', department_key: 'executive', display_name: 'X', tier_ceiling: 'T3' }), 'PAYLOAD_REFUSED')
    await rejectsCode(up({ employee_id: 'emp_x04', kind: 'ai', role_key: 'coo', department_key: 'executive', display_name: 'X', spend_day_cap_usd: 6 }), 'PAYLOAD_REFUSED')
    await rejectsCode(up({ employee_id: 'emp_x05', kind: 'ai', role_key: 'coo', department_key: 'executive', display_name: 'Call 612-555-0147' }), 'PAYLOAD_REFUSED')
    await rejectsCode(up({ employee_id: 'BAD', kind: 'ai', role_key: 'coo', department_key: 'executive', display_name: 'X' }), 'PAYLOAD_REFUSED')
    await rejectsCode(up({ employee_id: 'emp_ceo', manager_employee_id: 'emp_acq_01' }), 'CONFLICT')
    await rejectsCode(up({ employee_id: 'emp_coo', kind: 'human' }), 'CONFLICT')
    await rejectsCode(up({ employee_id: 'emp_x06', kind: 'ai', role_key: 'research_analyst', department_key: 'data_intelligence', display_name: 'X', manager_employee_id: 'emp_nobody' }), 'NOT_FOUND')
    const paused = await up({ employee_id: 'emp_acq_01', status: 'paused', markets: ['dallas', 'fort_worth'] })
    assert.equal(paused.status, 'paused')
    assert.deepEqual(paused.markets, ['dallas', 'fort_worth'])
    assert.equal(paused.display_name, 'Dallas Agent', 'unspecified fields are kept')
    assert.equal(paused.employee_code, 'ACQ-01')
    await ctx.store.heartbeatEmployee({ org_id: ORG, employee_id: 'emp_coo' })
    assert.ok((await ctx.store.getEmployee({ org_id: ORG, employee_id: 'emp_coo' })).heartbeat_at)
    await rejectsCode(ctx.store.heartbeatEmployee({ org_id: ORG, employee_id: 'emp_nobody' }), 'NOT_FOUND')
    const all = await ctx.store.listEmployees({ org_id: ORG })
    assert.equal(all.length, 5)
    assert.deepEqual((await ctx.store.listEmployees({ org_id: ORG, status: 'paused' })).map((e) => e.employee_id), ['emp_acq_01'])
    const ceo = all.find((e) => e.role_key === 'ceo')
    assert.equal(ceo.kind, 'human')
    assert.equal(ceo.user_id, OWNER)
    // a paused assignee is never claimed (DB-level kill switch per employee)
    const m = await mission(ctx)
    await step(ctx, m, 'work', { assignee: 'emp_acq_01' })
    assert.deepEqual(await claim(ctx), [])
    await up({ employee_id: 'emp_acq_01', status: 'active' })
    assert.equal((await claim(ctx)).length, 1)
  }],

  ['executive conversation: CEO = an owner, COO = the COO employee', async (ctx) => {
    await staff(ctx)
    const m = await mission(ctx)
    const c1 = await ctx.store.appendExecMessage({ org_id: ORG, author: 'ceo', author_user_id: OWNER, content: 'Find the 10 most promising sellers.' })
    await sleep(5)
    const c2 = await ctx.store.appendExecMessage({ org_id: ORG, author: 'coo', author_employee_id: 'emp_coo', content: 'Planned 8 steps.', mission_id: m.mission_id })
    await rejectsCode(ctx.store.appendExecMessage({ org_id: ORG, author: 'ceo', author_user_id: OPERATOR, content: 'x' }), 'FORBIDDEN')
    await rejectsCode(ctx.store.appendExecMessage({ org_id: ORG, author: 'coo', author_employee_id: 'emp_cfo', content: 'x' }), 'FORBIDDEN')
    await rejectsCode(ctx.store.appendExecMessage({ org_id: ORG, author: 'cfo', author_employee_id: 'emp_cfo', content: 'x' }), 'PAYLOAD_REFUSED')
    const all = await ctx.store.listExecMessages({ org_id: ORG })
    assert.deepEqual(all.map((x) => x.message_id), [c2.message_id, c1.message_id], 'newest first')
    assert.deepEqual((await ctx.store.listExecMessages({ org_id: ORG, mission_id: m.mission_id })).map((x) => x.message_id), [c2.message_id])
    assert.deepEqual((await ctx.store.listExecMessages({ org_id: ORG, before: c2.created_at })).map((x) => x.message_id), [c1.message_id])
  }],

  ['authority policies (CEO only, versioned), settings and KPIs (unknown is never 0)', async (ctx) => {
    await staff(ctx)
    const p1 = await ctx.store.putPolicy({ org_id: ORG, actor_user_id: OWNER, policy: { role_key: 'acquisition_agent', action_key: 'research.property', scope: { markets: ['dallas'] }, limits: { per_day: 20 }, risk: 'low', review: 'none' } })
    assert.equal(p1.version, 1)
    assert.equal(p1.status, 'active')
    const p2 = await ctx.store.putPolicy({ org_id: ORG, actor_user_id: OWNER, policy: { policy_id: p1.policy_id, role_key: 'acquisition_agent', action_key: 'research.property', limits: { per_day: 40 } } })
    assert.equal(p2.version, 2)
    assert.equal(p2.supersedes, p1.policy_id)
    assert.deepEqual((await ctx.store.listPolicies({ org_id: ORG, status: 'active' })).map((p) => p.policy_id), [p2.policy_id])
    await rejectsCode(ctx.store.putPolicy({ org_id: ORG, actor_user_id: OWNER, policy: { policy_id: p1.policy_id, role_key: 'cfo', action_key: 'finance.review_opportunity' } }), 'CONFLICT')
    await rejectsCode(ctx.store.putPolicy({ org_id: ORG, actor_user_id: OPERATOR, policy: { role_key: 'cfo', action_key: 'finance.review_opportunity' } }), 'FORBIDDEN')
    await rejectsCode(ctx.store.putPolicy({ org_id: ORG, actor_user_id: OWNER, policy: { role_key: 'cfo', employee_id: 'emp_cfo', action_key: 'finance.review_opportunity' } }), 'PAYLOAD_REFUSED')
    const rv = await ctx.store.revokePolicy({ org_id: ORG, policy_id: p2.policy_id, actor_user_id: OWNER })
    assert.equal(rv.status, 'revoked')
    assert.equal((await ctx.store.revokePolicy({ org_id: ORG, policy_id: p2.policy_id, actor_user_id: OWNER })).status, 'revoked', 'idempotent')
    const s0 = await ctx.store.getSettings({ org_id: ORG })
    assert.equal(s0.exec_review_price_usd, 5000000)
    const s1 = await ctx.store.putSettings({ org_id: ORG, actor_user_id: OWNER, patch: { exec_review_price_usd: 750000, escalation: { valuation_uncertainty: true } } })
    assert.equal(s1.exec_review_price_usd, 750000)
    assert.deepEqual(s1.escalation, { valuation_uncertainty: true })
    assert.equal(s1.updated_by, OWNER)
    await rejectsCode(ctx.store.putSettings({ org_id: ORG, actor_user_id: OPERATOR, patch: { exec_review_price_usd: 1 } }), 'FORBIDDEN')
    await rejectsCode(ctx.store.putSettings({ org_id: ORG, actor_user_id: OWNER, patch: { bogus: 1 } }), 'PAYLOAD_REFUSED')
    await ctx.store.putKpi({ org_id: ORG, subject_type: 'employee', subject_key: 'emp_acq_01', kpi_key: 'offers.prepared', window: '7d', value: null, status: 'unknown', source: { reason: 'no_calibrated_inputs' } })
    await ctx.store.putKpi({ org_id: ORG, subject_type: 'employee', subject_key: 'emp_acq_01', kpi_key: 'replies.handled', window: '7d', value: 12, status: 'known', source: { view: 'analytics_performance' } })
    await ctx.store.putKpi({ org_id: ORG, subject_type: 'employee', subject_key: 'emp_acq_01', kpi_key: 'replies.handled', window: '7d', value: 13, status: 'known', source: {} })
    await rejectsCode(ctx.store.putKpi({ org_id: ORG, subject_type: 'org', subject_key: 'org', kpi_key: 'x.y', window: '7d', value: 0, status: 'unknown', source: {} }), 'PAYLOAD_REFUSED')
    const k = await ctx.store.listKpis({ org_id: ORG, subject_type: 'employee', subject_key: 'emp_acq_01' })
    assert.deepEqual(k.map((x) => [x.kpi_key, x.value, x.status]), [['offers.prepared', null, 'unknown'], ['replies.handled', 13, 'known']])
  }],

  ['the operations feed: both stores emit the same event sequence for the same script', async (ctx) => {
    await staff(ctx)
    const m = await mission(ctx)
    await ctx.store.setMissionPlan({ org_id: ORG, mission_id: m.mission_id, plan: { steps: 2 }, playbook_key: 'opportunity_triage', expected_version: 0 })
    const a = await step(ctx, m, 'find')
    await step(ctx, m, 'rank', { depends_on: ['find'] })
    const [x] = await claim(ctx)
    await ctx.store.progressAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: x.lease_token, patch: { status: 'running' } })
    await ctx.store.finishAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: x.lease_token, status: 'completed', outcome_class: 'verified' })
    await claim(ctx)
    const custom = await ctx.store.appendEvent({ org_id: ORG, type: 'wf.mission.planned', mission_id: m.mission_id, employee_id: 'emp_coo', payload: { steps: 2 } })
    const feed = await ctx.store.listEvents({ org_id: ORG, mission_id: m.mission_id, limit: 500 })
    const sig = feed.map((e) => `${e.type}${e.payload.from ? `:${e.payload.from}>${e.payload.to}` : ''}`)
    assert.deepEqual(sig, [
      'wf.mission.opened', 'wf.mission.transitioned:planning>active', 'wf.mission.plan_set', 'wf.assignment.created', 'wf.assignment.created',
      'wf.assignment.transitioned:pending>ready', 'wf.assignment.transitioned:ready>leased', 'wf.assignment.transitioned:leased>running',
      'wf.assignment.transitioned:running>completed', 'wf.assignment.transitioned:pending>ready', 'wf.assignment.transitioned:ready>leased', 'wf.mission.planned',
    ])
    assert.ok(feed.every((e, i) => i === 0 || e.event_id > feed[i - 1].event_id), 'monotonic cursor')
    const afterCursor = await ctx.store.listEvents({ org_id: ORG, after_event_id: feed.at(-2).event_id })
    assert.deepEqual(afterCursor.map((e) => e.event_id), [custom.event_id])
    await rejectsCode(ctx.store.appendEvent({ org_id: ORG, type: 'wf.x', mission_id: 'wfm_00000000-0000-4000-8000-000000000000' }), 'NOT_FOUND')
  }],
]

for (const b of BACKENDS) {
  for (const [name, fn] of CASES) {
    test(`${b.name}: ${name}`, { skip: b.skip }, async () => {
      const ctx = await b.setup()
      try { await fn(ctx) } finally { await ctx.teardown() }
    })
  }
}

// ── PG-only: what only the database can prove ───────────────────────────────
async function pgCase(fn) {
  const db = await factory.fresh()
  const ctx = { db, store: createWorkforcePgStore({ pool: db.api }), backend: 'pg',
    addMember: (user_id, role = 'owner') => db.pool.query("insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, $3, 'test')", [ORG, user_id, role]) }
  try { await fn(ctx) } finally { await db.drop() }
}
const pgErr = (re) => (e) => re.test(`${e.code} ${e.message}`)

test('pg: SKIP LOCKED — a claimer never waits on rows another transaction holds', { skip: PG_SKIP }, () => pgCase(async (ctx) => {
  await staff(ctx)
  const m = await mission(ctx)
  for (let i = 0; i < 4; i += 1) await step(ctx, m, `s${i}`)
  await claim(ctx, { limit: 1 })   // promotes all four; leases one
  const holder = await ctx.db.pool.connect()   // agent_api has no UPDATE grant, so it cannot even SELECT … FOR UPDATE
  try {
    await holder.query('begin')
    const { rows } = await holder.query("select assignment_id from workforce.assignment where status = 'ready' order by created_at limit 2 for update")
    const t0 = Date.now()
    const got = await claim(ctx, { owner: 'worker-c', limit: 10 })
    assert.ok(Date.now() - t0 < 1500, 'did not block on the locked rows')
    assert.equal(got.length, 1)
    assert.ok(!rows.some((r) => r.assignment_id === got[0].assignment_id), 'the locked rows were skipped')
  } finally {
    await holder.query('rollback')
    holder.release()
  }
  assert.equal((await claim(ctx, { limit: 10 })).length, 2, 'they are claimable once released')
}))

test('pg: the event feed is append-only (UPDATE / DELETE / TRUNCATE refused, owner included)', { skip: PG_SKIP }, () => pgCase(async (ctx) => {
  await staff(ctx)
  await mission(ctx)
  await assert.rejects(ctx.db.api.query("update workforce.event set type = 'wf.x'"), pgErr(/42501|permission denied/))
  await assert.rejects(ctx.db.api.query('delete from workforce.event'), pgErr(/42501|permission denied/))
  await assert.rejects(ctx.db.pool.query("update workforce.event set type = 'wf.x'"), pgErr(/WF_APPEND_ONLY/))
  await assert.rejects(ctx.db.pool.query('delete from workforce.event'), pgErr(/WF_APPEND_ONLY/))
  await assert.rejects(ctx.db.pool.query('truncate workforce.event'), pgErr(/WF_APPEND_ONLY/))
  await ctx.store.appendExecMessage({ org_id: ORG, author: 'coo', author_employee_id: 'emp_coo', content: 'Planned.' })
  await assert.rejects(ctx.db.pool.query("update workforce.exec_message set content = 'x'"), pgErr(/WF_APPEND_ONLY/))
  await assert.rejects(ctx.db.pool.query('delete from workforce.exec_message'), pgErr(/WF_APPEND_ONLY/))
  const n = Number((await ctx.db.pool.query('select count(*) n from workforce.event')).rows[0].n)
  assert.ok(n > 0)
}))

test('pg: writes only through the functions — direct DML is refused for agent_api, service_role and the guards', { skip: PG_SKIP }, () => pgCase(async (ctx) => {
  await staff(ctx)
  const m = await mission(ctx)
  await assert.rejects(ctx.db.api.query("insert into workforce.mission (mission_id, org_id, title, directive, owner_employee_id, requested_by, idempotency_key) values ('wfm_00000000-0000-4000-8000-000000000009', $1, 'x', 'x', 'emp_coo', $2, repeat('a', 64))", [ORG, OWNER]), pgErr(/42501|permission denied/))
  await assert.rejects(ctx.db.api.query("update workforce.mission set status = 'completed'"), pgErr(/42501|permission denied/))
  const c = await ctx.db.pool.connect()
  try {
    await c.query('begin')
    await c.query('set local role service_role')
    await assert.rejects(c.query("update workforce.assignment set status = 'completed'"), pgErr(/42501|permission denied/))
  } finally { await c.query('rollback').catch(() => {}); c.release() }
  // the owner (break-glass) still meets the state graph
  await assert.rejects(ctx.db.pool.query("update workforce.mission set status = 'planning' where mission_id = $1", [m.mission_id]), pgErr(/WF_ILLEGAL_TRANSITION/))
  const a = await step(ctx, m, 'find')
  await assert.rejects(ctx.db.pool.query("update workforce.assignment set status = 'leased' where assignment_id = $1", [a.assignment_id]), pgErr(/WF_ILLEGAL_TRANSITION|check/))
  await assert.rejects(ctx.db.pool.query("update workforce.assignment set input = '{\"x\": 1}' where assignment_id = $1", [a.assignment_id]), pgErr(/WF_IMMUTABLE/))
}))

test('pg: RLS — authenticated reads only through agent.can_read_org; anon reads nothing', { skip: PG_SKIP }, () => pgCase(async (ctx) => {
  await staff(ctx)
  await mission(ctx)
  await ctx.store.appendExecMessage({ org_id: ORG, author: 'ceo', author_user_id: OWNER, content: 'hello' })
  const as = async (role, sub, sql) => {
    const c = await ctx.db.pool.connect()
    try {
      await c.query('begin')
      if (sub) await c.query("select set_config('request.jwt.claim.sub', $1, true)", [sub])
      await c.query(`set local role ${role}`)
      return (await c.query(sql)).rows
    } finally { await c.query('rollback').catch(() => {}); c.release() }
  }
  for (const t of ['mission', 'employee', 'event', 'exec_message', 'settings']) {
    assert.ok((await as('authenticated', OPERATOR, `select * from workforce.${t}`)).length > 0, `a member reads workforce.${t}`)
    assert.equal((await as('authenticated', STRANGER, `select * from workforce.${t}`)).length, 0, `a non-member reads nothing in workforce.${t}`)
    assert.equal((await as('authenticated', null, `select * from workforce.${t}`)).length, 0, `no session reads nothing in workforce.${t}`)
    await assert.rejects(as('anon', null, `select * from workforce.${t}`), pgErr(/42501|permission denied/))
  }
  await assert.rejects(as('authenticated', OWNER, "update workforce.settings set exec_review_price_usd = 1"), pgErr(/42501|permission denied/))
  await assert.rejects(as('authenticated', OWNER, `select workforce.mission_open('${ORG}', 'x', 'x', '${OWNER}', 'emp_coo', 1, null, 'k')`), pgErr(/42501|permission denied/))
}))

test('pg: the store connects as a least-privilege role and its reads are READ ONLY', { skip: PG_SKIP }, () => pgCase(async (ctx) => {
  const r = (await ctx.db.api.query('select rolsuper, rolbypassrls from pg_roles where rolname = current_user')).rows[0]
  assert.deepEqual(r, { rolsuper: false, rolbypassrls: false })
  const seen = []
  const spy = { connect: async () => { const c = await ctx.db.api.connect(); const q = c.query.bind(c); c.query = (sql, p) => { seen.push(String(sql)); return q(sql, p) }; return c } }
  const s = createWorkforcePgStore({ pool: spy })
  await s.listMissions({ org_id: ORG })
  assert.equal(seen[0], 'begin read only')
  await rejectsCode(s.heartbeatEmployee({ org_id: ORG, employee_id: 'emp_nobody' }), 'NOT_FOUND')
  assert.ok(seen.includes('begin isolation level read committed'))
}))

// ── the JS mirror of the SQL state graphs (no PG needed for the text comparison) ──
function sqlGraph(fnName) {
  const start = MIGRATION.indexOf(`create or replace function workforce.${fnName}(`)
  assert.ok(start >= 0, `${fnName} not in the migration`)
  const body = MIGRATION.slice(start, MIGRATION.indexOf('$$;', start))
  const out = {}
  for (const m of body.matchAll(/when '([a-z_]+)'\s+then p_to in \(([^)]*)\)/g)) out[m[1]] = [...m[2].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
  return out
}
const nonEmpty = (g) => Object.fromEntries(Object.entries(g).filter(([, v]) => v.length))

test('ASSIGNMENT_TRANSITIONS / MISSION_TRANSITIONS equal the SQL CASE tables (parsed from the migration)', () => {
  assert.deepEqual(sqlGraph('assignment_transition_ok'), nonEmpty(ASSIGNMENT_TRANSITIONS))
  assert.deepEqual(sqlGraph('mission_transition_ok'), nonEmpty(MISSION_TRANSITIONS))
  assert.deepEqual(Object.keys(ASSIGNMENT_TRANSITIONS).sort(), [...ASSIGNMENT_STATES].sort())
  assert.deepEqual(Object.keys(MISSION_TRANSITIONS).sort(), [...MISSION_STATES].sort())
  const check = MIGRATION.match(/status text not null default 'pending' check \(status in \(([^)]*)\)\)/)[1]
  assert.deepEqual([...check.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]), [...ASSIGNMENT_STATES])
})

test('pg: workforce.assignment_transition_ok / mission_transition_ok agree with the JS mirror on EVERY pair', { skip: PG_SKIP }, () => pgCase(async (ctx) => {
  const { rows: a } = await ctx.db.api.query(`select f, t, workforce.assignment_transition_ok(f, t) ok from unnest($1::text[]) f, unnest($1::text[]) t`, [[...ASSIGNMENT_STATES, 'bogus']])
  for (const r of a) assert.equal(r.ok, (ASSIGNMENT_TRANSITIONS[r.f] || []).includes(r.t), `assignment ${r.f} → ${r.t}`)
  const { rows: m } = await ctx.db.api.query(`select f, t, workforce.mission_transition_ok(f, t) ok from unnest($1::text[]) f, unnest($1::text[]) t`, [[...MISSION_STATES, 'bogus']])
  for (const r of m) assert.equal(r.ok, (MISSION_TRANSITIONS[r.f] || []).includes(r.t), `mission ${r.f} → ${r.t}`)
  const { rows: d } = await ctx.db.api.query(`select r, d, workforce.role_department_ok(r, d) ok from unnest($1::text[]) r, unnest($2::text[]) d`,
    [Object.keys(ROLE_DEPARTMENTS), ['executive', 'finance', 'acquisitions', 'marketing', 'dispositions', 'data_intelligence', 'operations']])
  for (const r of d) assert.equal(r.ok, ROLE_DEPARTMENTS[r.r].includes(r.d), `role ${r.r} in ${r.d}`)
}))

test('pg: the JS payload guard agrees with agent.payload_is_clean / payload_string_violation on a corpus', { skip: PG_SKIP }, () => pgCase(async (ctx) => {
  const jsonCorpus = [
    { a: 'fine' }, { note: '612-555-0147' }, { note: '+1 (612) 555 0147' }, { n: 6125550147 }, { n: 5000000 }, { e: 'rosa@example.com' }, { message_body: 'x' },
    { nested: [{ sms_text: 'y' }] }, { phone: '612' }, { phone: 1 }, { step_key: 'x' }, { scope_key: 'x' }, { property_id: '2124415662' }, { property_id: 'pid_ghijklmnop' },
    { evidence_refs: ['property:123'] }, { evidence_refs: ['property:pid_hhh'] }, { job_id: JOB1 }, { key: 'conv.84512937-4021-4abc-8123-456789012345' },
    { at: '2026-10-21T10:00:00.123Z' }, { t: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk' }, { t: 'sk_live_abcdefgh12345678' }, { b: 'NjEyNTU1MDE0Nw==' },
    { 'k612-555-0147': 1 }, { thinking: 'x' }, { cell: '1' }, { d: '٦١٢٥٥٥٠١٤٧' }, { d: '６１２５５５０１４７' }, { count: 10, market: 'dallas' }, { canonical_e164: '+1' },
    { claims: [{ text: 'ok' }] }, { text: 'ok' }, { hash: 'a'.repeat(64) }, { x: 'a'.repeat(64) },
  ]
  const { rows } = await ctx.db.api.query('select i, agent.payload_violation(j, null) v from unnest($1::jsonb[]) with ordinality u(j, i)', [jsonCorpus.map((x) => JSON.stringify(x))])
  for (const r of rows) assert.equal(payloadViolation(jsonCorpus[Number(r.i) - 1]) ?? null, r.v ?? null, `payload ${JSON.stringify(jsonCorpus[Number(r.i) - 1])}`)
  const textCorpus = ['find the 10 most promising sellers', 'call 612-555-0147', 'rosa@example.com', 'Dallas under $5,000,000 by 2026-11-01', 'NjEyNTU1MDE0Nw==', 'wfa_84512937-4021-4abc-8123-456789012345 done', '612 555 0147', 'a1b2c3']
  const { rows: t } = await ctx.db.api.query("select i, agent.payload_string_violation(s, 'text', 0) v from unnest($1::text[]) with ordinality u(s, i)", [textCorpus])
  for (const r of t) assert.equal(stringViolation(textCorpus[Number(r.i) - 1], 'text', 0) ?? null, r.v ?? null, `text ${textCorpus[Number(r.i) - 1]}`)
}))
