// Workforce Phase A — the CEO queue resolution route: POST /api/cockpit/workforce/assignments/[id]/resolve.
// CEO only (owner membership) as the SESSION user; the decision is RECORDED inside Workforce (the memory twin's
// decideHeldAssignment: the same semantics as workforce.assignment_decide, pinned by the store conformance
// suite) with one semantic event and one COO acknowledgement; a replay writes nothing; "approve" starts
// nothing: no runtime job, no new assignment, no domain service call, and the copy says exactly that.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as R from '../../src/lib/workforce/routes.js'
import { createWorkforceMemoryStore } from '../../src/lib/workforce/store/index.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { DECISION_EFFECTS, decisionAck, decisionOutcome } from '../../src/lib/workforce/coo/decisions.js'
import { SEED_EMPLOYEES } from '../../src/lib/workforce/org/seed.js'
import { seedFakeOrg } from '../helpers/workforce-fake-store.mjs'
import { ARMED_KINDS, OPERATOR, ORG, OWNER, T0 } from '../helpers/workforce-fixtures.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const ON = { AGENT_ENABLED: '1', WORKFORCE_ENABLED: '1' }
const MALLORY = '33333333-3333-4333-8333-333333333333'
const limiter = { check: () => ({ ok: true }) }
const identityFor = (user_id) => ({ authenticate: async () => ({ ok: true, identity: { user_id, verified: true, named: true } }) })
const post = (id, body) => new Request(`http://x/api/cockpit/workforce/assignments/${id}/resolve`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const PREF = 'pid_nggggggghh' // property 7000000011

async function setup() {
  const store = createWorkforceMemoryStore({ now: () => T0, members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }, { org_id: ORG, user_id: OPERATOR, role: 'operator' }] })
  await seedFakeOrg(store, { org_id: ORG, seed: SEED_EMPLOYEES, owner_user_id: OWNER })
  const runtime = createRuntimeMemoryStore({ now: () => T0, limits: { runtime_enabled: true, kind_limits: structuredClone(ARMED_KINDS) } })
  const roles = { [OWNER]: 'owner', [OPERATOR]: 'operator', [MALLORY]: 'operator' }
  // every domain read service is a trap: a decision must never call one
  const touched = []
  const services = new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? (...a) => { touched.push(k); throw new Error(`domain service ${k} called with ${a.length} args`) } : undefined) })
  const svc = { store, runtimeStore: runtime, reads: null, services, membership: async (_org, user) => (roles[user] ? { role: roles[user] } : null) }
  const opts = (user) => ({ env: ON, auth: () => ({ ok: true }), identity: identityFor(user), limiter, getServices: async () => svc })
  const { mission } = await store.openMission({ org_id: ORG, title: 'Opportunity triage (top 10)', directive: 'Find the ten most promising active acquisition opportunities and get them moving.', requested_by: OWNER, owner_employee_id: 'emp_coo', idempotency_key: 'k-ceo-resolve' })
  await store.transitionMission({ org_id: ORG, mission_id: mission.mission_id, to: 'active' })
  const mk = async (step_key, assignee, input) => (await store.createAssignment({ org_id: ORG, mission_id: mission.mission_id, step_key, capability_key: 'work.assign', assignee_employee_id: assignee, delegated_by_employee_id: 'emp_cfo', input, resource_type: 'property', resource_key: input.property_ref ?? null, max_attempts: 1 })).assignment
  const esc = await mk('fin.c6.esc', 'emp_ceo', { follow_on: true, task: 'escalation', reasons: ['EXEC_REVIEW_PRICE'], property_ref: PREF, threshold_usd: 5_000_000, price_usd: 6_000_000 })
  const review = await mk('assign.1.fo', 'emp_ceo', { follow_on: true, task: 'review_offer_recommendation', property_ref: 'pid_nggggggghi' })
  const aiHeld = await mk('assign.2.fo', 'emp_coo', { follow_on: true, task: 'operator_review', property_ref: 'pid_nggggggghj' })
  // park them the way the dispatcher does (a person's work is never executed by an AI)
  for (const a of await store.claimAssignments({ org_id: ORG, owner: 'wf-dispatch:test', limit: 10, lease_seconds: 60 })) {
    await store.finishAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: a.lease_token, status: 'waiting_approval', outcome_class: 'unknown', output: { parked: 'human_queue', task: a.input.task } })
  }
  return { store, runtime, svc, opts, mission, esc, review, aiHeld, touched }
}
const counts = async (store) => ({ events: (await store.listEvents({ org_id: ORG, limit: 500 })).length, messages: (await store.listExecMessages({ org_id: ORG, limit: 200 })).length, assignments: (await store.listAssignments({ org_id: ORG, limit: 1000 })).length })

test('resolve 404s with an EMPTY body unless AGENT_ENABLED and WORKFORCE_ENABLED=1 — before auth or any service', async () => {
  let touched = 0
  const spy = { auth: () => { touched += 1; return { ok: true } }, identity: { authenticate: async () => { touched += 1; return { ok: true, identity: { user_id: OWNER } } } }, limiter, getServices: async () => { touched += 1; return {} } }
  for (const env of [{}, { AGENT_ENABLED: '1' }, { AGENT_ENABLED: '1', WORKFORCE_ENABLED: 'true' }, { AGENT_ENABLED: '0', WORKFORCE_ENABLED: '1' }]) {
    const r = await R.handleAssignmentResolve(post('wfa_x', { decision: 'approve' }), 'wfa_x', { ...spy, env })
    assert.equal(r.status, 404)
    assert.equal(await r.text(), '')
  }
  assert.equal(touched, 0)
})

test('CEO only: an operator (or an outsider) is refused and nothing changes', async () => {
  const { store, opts, esc } = await setup()
  const before = await counts(store)
  const r = await R.handleAssignmentResolve(post(esc.assignment_id, { decision: 'approve', actor_user_id: OWNER }), esc.assignment_id, opts(OPERATOR))
  assert.equal(r.status, 403)
  assert.equal((await r.json()).error, 'CEO_ONLY')
  const out = await R.handleAssignmentResolve(post(esc.assignment_id, { decision: 'approve' }), esc.assignment_id, opts('44444444-4444-4444-8444-444444444444'))
  assert.equal(out.status, 403)
  assert.equal((await out.json()).error, 'NOT_A_MEMBER')
  assert.deepEqual(await counts(store), before)
  assert.equal((await store.getAssignment({ org_id: ORG, assignment_id: esc.assignment_id })).status, 'waiting_approval')
})

test('approve on an escalation: recorded inside Workforce, one event, one COO line; the copy says nothing else happened; nothing was started', async () => {
  const { store, runtime, opts, esc, mission, touched } = await setup()
  const jobs0 = runtime._state.jobs.size
  const before = await counts(store)
  const r = await R.handleAssignmentResolve(post(esc.assignment_id, { decision: 'approve', note: 'Cleared: the ask is real.', actor_user_id: MALLORY, user_id: MALLORY }), esc.assignment_id, opts(OWNER))
  assert.equal(r.status, 200)
  const { ok, data } = await r.json()
  assert.equal(ok, true)
  assert.equal(data.replayed, false)
  assert.equal(data.decision, 'approve')
  // the decision is recorded on the assignment, by the SESSION user
  assert.equal(data.assignment.status, 'completed')
  assert.equal(data.assignment.outcome_class, 'verified')
  assert.equal(data.assignment.output.decision, 'approve')
  assert.equal(data.assignment.output.actor_id, OWNER, 'never the body')
  assert.equal(data.assignment.output.note, 'Cleared: the ask is real.')
  assert.equal(data.assignment.lease_token, undefined, 'the presenter never returns a lease token')
  // the copy: exactly what happened
  assert.deepEqual(data.outcome.effects, DECISION_EFFECTS)
  assert.deepEqual(Object.entries(data.outcome.effects).filter(([, v]) => v === true).map(([k]) => k), ['recorded_in_workforce'])
  assert.match(data.outcome.message, /^Recorded: you approved the executive review of property 7000000011\./)
  assert.match(data.outcome.message, /Nothing was sent, no offer was made and no stage changed\.$/)
  assert.doesNotMatch(data.outcome.message, /will (send|contact|offer)|offer (is|was) (sent|made)(?! )|queued an offer|launched/i)
  // one semantic event, one COO message (pid_ refs decoded for display)
  assert.equal(data.messages.length, 1)
  assert.equal(data.messages[0].author, 'coo')
  assert.equal(data.messages[0].mission_id, mission.mission_id)
  assert.match(data.messages[0].content, /^Noted: you approved the executive review of property 7000000011\. I recorded it in Workforce\. Your note is on the item\./)
  assert.ok(data.messages[0].refs.some((x) => x.type === 'assignment' && x.id === esc.assignment_id))
  assert.ok(data.messages[0].refs.some((x) => x.type === 'property' && x.property_id === '7000000011'))
  const after = await counts(store)
  assert.equal(after.messages, before.messages + 1)
  assert.equal(after.assignments, before.assignments, 'no new work is created')
  const ev = (await store.listEvents({ org_id: ORG, limit: 500 })).slice(before.events)
  assert.deepEqual(ev.map((e) => e.type).filter((t) => t !== 'wf.resource.released'), ['wf.assignment.transitioned', 'wf.ceo.decision_recorded'])
  const rec = ev.find((e) => e.type === 'wf.ceo.decision_recorded')
  assert.equal(rec.payload.by_user, OWNER)
  assert.equal(rec.payload.task, 'escalation')
  assert.deepEqual(rec.payload.effects, DECISION_EFFECTS)
  // nothing was started: no runtime job, no domain read
  assert.equal(runtime._state.jobs.size, jobs0, 'no runtime job (no offer, no send, no research)')
  assert.deepEqual(touched, [])
  // the mission and its other items are untouched
  assert.equal((await store.getMission({ org_id: ORG, mission_id: mission.mission_id })).status, 'active')
})

test('a replay of the same decision is idempotent: 200, replayed, no new event or message; another decision is a 409', async () => {
  const { store, opts, review } = await setup()
  const first = await (await R.handleAssignmentResolve(post(review.assignment_id, { decision: 'approve' }), review.assignment_id, opts(OWNER))).json()
  assert.equal(first.data.replayed, false)
  assert.match(first.data.outcome.message, /review the offer recommendation in Deal Intelligence\. Workforce prepares nothing new from this\. Nothing was sent, no offer was made and no stage changed\.$/)
  const mid = await counts(store)
  const again = await R.handleAssignmentResolve(post(review.assignment_id, { decision: 'approve' }), review.assignment_id, opts(OWNER))
  assert.equal(again.status, 200)
  const b = await again.json()
  assert.equal(b.data.replayed, true)
  assert.deepEqual(b.data.messages, [])
  assert.equal(b.data.outcome.message, first.data.outcome.message, 'the same answer')
  assert.equal(b.data.assignment.output.decided_at, first.data.assignment.output.decided_at)
  assert.deepEqual(await counts(store), mid, 'a replay writes nothing')
  const other = await R.handleAssignmentResolve(post(review.assignment_id, { decision: 'decline' }), review.assignment_id, opts(OWNER))
  assert.equal(other.status, 409)
  assert.equal((await other.json()).error, 'CONFLICT')
  assert.deepEqual(await counts(store), mid)
})

test('validation: decision, id, note (length, contact values), unknown id, an AI-held item, a non-queued item', async () => {
  const { store, opts, esc, aiHeld, mission } = await setup()
  const call = (id, b) => R.handleAssignmentResolve(post(id, b), id, opts(OWNER))
  const { assignment: fresh } = await store.createAssignment({ org_id: ORG, mission_id: mission.mission_id, step_key: 'late.esc', capability_key: 'work.assign', assignee_employee_id: 'emp_ceo', delegated_by_employee_id: 'emp_coo', input: { follow_on: true, task: 'escalation' } })
  const before = await counts(store)
  const bad = await call(esc.assignment_id, { decision: 'send_offer' })
  assert.equal(bad.status, 422)
  assert.equal((await bad.json()).error, 'DECISION_INVALID')
  assert.equal((await call(esc.assignment_id, {})).status, 422)
  assert.equal((await call('nope', { decision: 'done' })).status, 422)
  assert.equal((await call('wfa_00000000-0000-4000-8000-000000000000', { decision: 'done' })).status, 404)
  assert.equal((await (await call(esc.assignment_id, { decision: 'done', note: 'x'.repeat(501) })).json()).error, 'NOTE_TOO_LONG')
  const phone = await call(esc.assignment_id, { decision: 'done', note: 'call him at 612-555-0147' })
  assert.equal(phone.status, 422)
  assert.equal((await phone.json()).error, 'PAYLOAD_REFUSED')
  const ai = await call(aiHeld.assignment_id, { decision: 'approve' })
  assert.equal(ai.status, 409)
  assert.equal((await ai.json()).error, 'ILLEGAL_TRANSITION', 'only a person\'s queue is decided by a person')
  assert.equal((await call(fresh.assignment_id, { decision: 'approve' })).status, 409, 'a pending item is not in the queue yet')
  assert.deepEqual(await counts(store), before, 'refusals write nothing')
})

test('decline and done: the copy plans no further work; nothing else changed', () => {
  for (const task of ['escalation', 'review_offer_recommendation', 'underwrite_review', 'operator_review', null]) {
    for (const decision of ['approve', 'decline', 'done']) {
      const o = decisionOutcome({ decision, task, property_ref: PREF })
      assert.match(o.message, /^Recorded: you /)
      assert.match(o.message, /Nothing was sent, no offer was made and no stage changed\.$/)
      assert.doesNotMatch(o.message, /\b(will|we'll|I'll) (send|text|call|email|contact|offer|launch|move)\b/i)
      if (decision !== 'approve') assert.match(o.next_step, /no further work/)
      assert.deepEqual(o.effects, DECISION_EFFECTS)
      assert.match(decisionAck({ decision, task, property_ref: PREF }), /I recorded it in Workforce\./)
    }
  }
})

test('static: the resolve handler and the decision copy start nothing (no enqueue, no runtime, no domain service)', () => {
  const src = fs.readFileSync(path.join(here, '../../src/lib/workforce/routes.js'), 'utf8')
  const start = src.indexOf('export async function handleAssignmentResolve(')
  const body = src.slice(start, src.indexOf('\nexport ', start + 10))
  assert.ok(start > 0 && body.length > 200)
  assert.doesNotMatch(body, /enqueue|runtimeStore|svc\.services|services\.|createAssignment|transitionMission|openDirective/)
  const dec = fs.readFileSync(path.join(here, '../../src/lib/workforce/coo/decisions.js'), 'utf8')
  assert.doesNotMatch(dec.replace(/\/\/.*$/gm, ''), /\bimport\b/, 'the decision copy is pure: it imports nothing')
  const route = fs.readFileSync(path.join(here, '../../src/app/api/cockpit/workforce/assignments/[id]/resolve/route.js'), 'utf8')
  assert.match(route, /handleAssignmentResolve\(request, id, opts\(request\)\)/)
  assert.doesNotMatch(route, /export async function GET/)
})
