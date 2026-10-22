// Workforce × Agntei — unit proofs (no database): the truthful activity, the owner's link steps (copyable, nothing
// executed), the memory twin's execution modes (dispatch never leases an external row; a finished job hands it back;
// a reassignment re-derives the mode), the recorded external-timeout policy, the budget rule of the authority engine,
// and the "Register an Agntei agent" route (CEO only).
import test from 'node:test'
import assert from 'node:assert/strict'

import { createWorkforceMemoryStore } from '../../src/lib/workforce/store/index.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { seedEmployeesFor } from '../../src/lib/workforce/org/seed.js'
import { employeeActivity, assignmentActivity, ago } from '../../src/lib/workforce/agntei/activity.js'
import { agnteiLinkSteps } from '../../src/lib/workforce/agntei/link-steps.js'
import { WORKFORCE_GATEWAY_TOOLS, mcpToolName } from '../../src/lib/workforce/agntei/tools.js'
import { applyExternalTimeouts } from '../../src/lib/workforce/engine/dispatch.js'
import { authorize } from '../../src/lib/workforce/authority/engine.js'
import * as R from '../../src/lib/workforce/routes.js'

const ORG = '00000000-0000-4000-8000-00000000a001'
const OWNER = '11111111-1111-4111-8111-111111111111'
const OPERATOR = '33333333-3333-4333-8333-333333333333'
const T0 = Date.parse('2026-10-21T15:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

async function org({ now = () => T0 } = {}) {
  const store = createWorkforceMemoryStore({ now, members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }, { org_id: ORG, user_id: OPERATOR, role: 'operator' }] })
  for (const e of seedEmployeesFor({ org_id: ORG, owner_user_id: OWNER })) { const { org_id, ...x } = e; await store.upsertEmployee({ org_id: ORG, employee: x, actor_user_id: OWNER }) }
  await store.upsertEmployee({ org_id: ORG, employee: { employee_id: 'emp_scout', kind: 'ai', role_key: 'research_analyst', department_key: 'data_intelligence', display_name: 'Scout', origin: 'agntei' }, actor_user_id: OWNER })
  const { mission } = await store.openMission({ org_id: ORG, title: 'Unit', directive: 'Find the 3 most promising opportunities', requested_by: OWNER, owner_employee_id: 'emp_coo', idempotency_key: 'unit' })
  await store.transitionMission({ org_id: ORG, mission_id: mission.mission_id, to: 'active' })
  return { store, mission }
}

test('activity: working only with a live lease AND a heartbeat < 2 min; waiting with its reason ("Waiting for Scout (Agntei), last seen 3 min ago"); idle; pending_link; binding ended', () => {
  const scout = { employee_id: 'emp_scout', display_name: 'Scout', origin: 'agntei', status: 'active', heartbeat_at: iso(T0 - 3 * 60_000), binding_valid_until: iso(T0 + 86400_000) }
  const ready = { assignment_id: 'a1', assignee_employee_id: 'emp_scout', status: 'ready', execution_mode: 'external', claimed_at: null }
  const act = assignmentActivity(ready, { employee: scout, now: T0 })
  assert.deepEqual([act.state, act.reason, act.label], ['waiting', 'external_agent', 'Waiting for Scout (Agntei), last seen 3 min ago'])
  const leasedFresh = { ...ready, status: 'running', lease_until: iso(T0 + 60_000), claimed_at: iso(T0 - 30_000) }
  assert.equal(assignmentActivity(leasedFresh, { employee: { ...scout, heartbeat_at: iso(T0 - 30_000) }, now: T0 }).state, 'working')
  const silent = assignmentActivity({ ...leasedFresh, claimed_at: iso(T0 - 10 * 60_000) }, { employee: scout, now: T0 })
  assert.deepEqual([silent.state, silent.reason], ['waiting', 'agent_silent'], 'a held lease without a fresh heartbeat is NOT working')
  assert.equal(assignmentActivity({ ...leasedFresh, lease_until: iso(T0 - 1) }, { employee: scout, now: T0 }).reason, 'lease_expired')
  assert.equal(assignmentActivity({ ...ready, status: 'waiting_job' }, { employee: scout, now: T0 }).reason, 'research_job')
  assert.equal(employeeActivity(scout, [], { now: T0 }).state, 'idle')
  assert.equal(employeeActivity(scout, [ready], { now: T0 }).label, 'Waiting for Scout (Agntei), last seen 3 min ago')
  assert.equal(employeeActivity({ ...scout, status: 'pending_link' }, [], { now: T0 }).state, 'pending_link')
  assert.equal(employeeActivity({ ...scout, binding_revoked_at: iso(T0 - 1) }, [], { now: T0 }).state, 'binding_revoked')
  assert.equal(employeeActivity({ ...scout, binding_valid_until: iso(T0 - 1) }, [], { now: T0 }).state, 'binding_expired')
  assert.equal(assignmentActivity(ready, { employee: { ...scout, heartbeat_at: null }, now: T0 }).label, 'Waiting for Scout (Agntei), never seen')
  assert.equal(ago(iso(T0 - 2 * 3600_000), T0), '2 h ago')
})

test('link steps: the exact owner commands (mint → principal → 11 T1 grants → bind with a window → connect → link), copyable, nothing executed, no secret', () => {
  const steps = agnteiLinkSteps({ employee: { employee_id: 'emp_scout', display_name: 'Scout' }, org_id: ORG, ceo_user_id: OWNER })
  assert.equal(steps.agent_id, 'agt_scout')
  assert.deepEqual(steps.steps.map((s) => s.id), ['mint', 'principal', 'grants', 'bind', 'connect', 'link'])
  const all = steps.steps.map((s) => s.command).join('\n')
  assert.match(all, /npm run mint:agent-credential -- --pepper-file \S+ --agent-id agt_scout --out \S+agt_scout\.credential/)
  assert.match(all, /workforce\.employee_bind_principal\('00000000-0000-4000-8000-00000000a001', 'emp_scout', 'agt_scout', '11111111-1111-4111-8111-111111111111', interval '24 hours'\)/)
  for (const t of WORKFORCE_GATEWAY_TOOLS) assert.ok(all.includes(`'${t.capability}', 1,`), t.capability)
  assert.match(all, /leadcommand_workforce_link_self/)
  assert.doesNotMatch(all, /lcag_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}/, 'no credential, no token')
  assert.deepEqual(steps.tools, WORKFORCE_GATEWAY_TOOLS.map((t) => mcpToolName(t.tool)))
})

test('memory twin: an Agntei employee is born pending_link (operator_ai); its assignments are EXTERNAL; dispatch never leases them; a finished job hands one back as ready; a transfer re-derives the mode (recorded)', async () => {
  const { store, mission } = await org()
  const scout = await store.getEmployee({ org_id: ORG, employee_id: 'emp_scout' })
  assert.deepEqual([scout.status, scout.employment_type, scout.origin], ['pending_link', 'operator_ai', 'agntei'])
  await assert.rejects(store.upsertEmployee({ org_id: ORG, employee: { employee_id: 'emp_scout', status: 'active' }, actor_user_id: OWNER }), (e) => e.code === 'ILLEGAL_TRANSITION')
  await assert.rejects(store.upsertEmployee({ org_id: ORG, employee: { employee_id: 'emp_scout', action_principal_id: 'agt_scout' }, actor_user_id: OWNER }), (e) => e.code === 'FORBIDDEN')
  store._linkAgntei({ employee_id: 'emp_scout', agent_id: 'agt_scout' })
  const { assignment: ext } = await store.createAssignment({ org_id: ORG, mission_id: mission.mission_id, step_key: 'res.c01', capability_key: 'research.property', assignee_employee_id: 'emp_scout', input: { property_ref: 'pid_ghij' } })
  const { assignment: int } = await store.createAssignment({ org_id: ORG, mission_id: mission.mission_id, step_key: 'res.c02', capability_key: 'research.property', assignee_employee_id: 'emp_research_01', input: { property_ref: 'pid_ghik' } })
  assert.equal(ext.execution_mode, 'external')
  assert.equal(int.execution_mode, 'internal')
  const claimed = await store.claimAssignments({ org_id: ORG, owner: 'dispatch', limit: 10, lease_seconds: 60 })
  assert.deepEqual(claimed.map((a) => a.assignment_id), [int.assignment_id])
  // the internal one parks on a job; that job finishing completes it; the same for an external row hands it back
  await store.waitAssignmentOnJob({ org_id: ORG, assignment_id: int.assignment_id, lease_token: claimed[0].lease_token, runtime_job_id: 'mjob_00000000-0000-4000-8000-000000000001' })
  const s = store._state()
  s.assignments.set(ext.assignment_id, { ...s.assignments.get(ext.assignment_id), status: 'waiting_job', runtime_job_id: 'mjob_00000000-0000-4000-8000-000000000002' })
  await store.resumeWaitingAssignments({ org_id: ORG, resolver: async () => ({ state: 'completed', result: { comps: 3 } }) })
  assert.equal((await store.getAssignment({ org_id: ORG, assignment_id: int.assignment_id })).status, 'completed')
  const back = await store.getAssignment({ org_id: ORG, assignment_id: ext.assignment_id })
  assert.equal(back.status, 'ready', 'handed back to its agent')
  assert.equal(back.output.research.job_id, 'mjob_00000000-0000-4000-8000-000000000002')
  await store.transferAssignment({ org_id: ORG, assignment_id: ext.assignment_id, to_employee_id: 'emp_research_01', actor: 'emp_coo' })
  assert.equal((await store.getAssignment({ org_id: ORG, assignment_id: ext.assignment_id })).execution_mode, 'internal')
  assert.ok((await store.listEvents({ org_id: ORG, limit: 500 })).some((e) => e.type === 'wf.assignment.mode_changed' && e.assignment_id === ext.assignment_id))
})

test('on_external_timeout (memory twin): wait escalates to the COO once per idle period; reassign_internal moves it to an internal worker of the capability, recorded', async () => {
  let now = T0
  const { store, mission } = await org({ now: () => now })
  store._linkAgntei({ employee_id: 'emp_scout', agent_id: 'agt_scout' })
  const { assignment: w } = await store.createAssignment({ org_id: ORG, mission_id: mission.mission_id, step_key: 'res.w', capability_key: 'research.property', assignee_employee_id: 'emp_scout', input: { property_ref: 'pid_ghij' } })
  const { assignment: r } = await store.createAssignment({ org_id: ORG, mission_id: mission.mission_id, step_key: 'res.r', capability_key: 'research.property', assignee_employee_id: 'emp_scout', input: { property_ref: 'pid_ghik' } })
  await store.setAssignmentExternalPolicy({ org_id: ORG, assignment_id: r.assignment_id, policy: 'reassign_internal', wait_seconds: 600, actor: 'emp_coo' })
  const employees = await store.listEmployees({ org_id: ORG })
  assert.deepEqual(await applyExternalTimeouts({ store, org_id: ORG, now: now + 30 * 60_000, employees }), { escalated: 0, reassigned: 1 }, 'the 1 h default wait has not passed for the wait row')
  now += 2 * 3600_000
  assert.deepEqual(await applyExternalTimeouts({ store, org_id: ORG, now, employees }), { escalated: 1, reassigned: 0 })
  assert.deepEqual(await applyExternalTimeouts({ store, org_id: ORG, now, employees }), { escalated: 0, reassigned: 0 }, 'once per idle period')
  const rr = await store.getAssignment({ org_id: ORG, assignment_id: r.assignment_id })
  assert.deepEqual([rr.assignee_employee_id, rr.execution_mode], ['emp_research_01', 'internal'])
  const ww = await store.getAssignment({ org_id: ORG, assignment_id: w.assignment_id })
  assert.deepEqual([ww.assignee_employee_id, ww.execution_mode], ['emp_scout', 'external'], 'wait never changes the mode')
  const coo = await store.listExecMessages({ org_id: ORG, mission_id: mission.mission_id })
  assert.equal(coo.filter((m) => m.author === 'coo').length, 2)
})

test('authority: paid work stays inside every applicable budget cap; an unreadable budget with a cost denies; no cost, no budget read', () => {
  const employee = { employee_id: 'emp_research_01', role_key: 'research_analyst', status: 'active', kind: 'ai', tier_ceiling: 'T1', markets: [] }
  const base = { env: { WORKFORCE_ENABLED: '1' }, now: T0, hold: { held: false }, policies: [], settings: null, usage: { today: {} } }
  const res = { property_id: '700000001' }
  assert.equal(authorize({ employee, capability: 'research.property', resource: res, context: { ...base, cost_usd: 0.05, budgets: [{ scope: 'employee', period: 'day', cap_usd: 1, spent_usd: 0.2 }] } }).decision, 'allow')
  const d = authorize({ employee, capability: 'research.property', resource: res, context: { ...base, cost_usd: 0.05, budgets: [{ budget_id: 'b1', scope: 'department', period: 'month', cap_usd: 0.5, spent_usd: 0.48 }] } })
  assert.deepEqual([d.decision, d.reasons[0]], ['deny', 'BUDGET_CAP_DEPARTMENT_MONTH'])
  assert.equal(authorize({ employee, capability: 'research.property', resource: res, context: { ...base, cost_usd: 0.05, budgets: null } }).reasons[0], 'BUDGET_UNREADABLE')
  assert.equal(authorize({ employee, capability: 'research.property', resource: res, context: { ...base, cost_usd: 0, budgets: null } }).decision, 'allow')
})

// ── the API (§7): "Register an Agntei agent" — CEO only; a pending_link employee + the exact owner steps; nothing executed ──
const ON = { AGENT_ENABLED: '1', WORKFORCE_ENABLED: '1' }
const limiter = { check: () => ({ ok: true }) }
const identityFor = (user_id) => ({ authenticate: async () => ({ ok: true, identity: { user_id, verified: true, named: true } }) })
const post = (url, body) => new Request(`http://x${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const get = (url) => new Request(`http://x${url}`)

test('API: register_agntei is CEO-only, creates a pending_link operator_ai employee with NO principal and NO grant, returns the link steps (executed: false); the profile shows activity, link, history and the steps', async () => {
  const { store } = await org()
  const roles = { [OWNER]: 'owner', [OPERATOR]: 'operator' }
  const svc = { store, runtimeStore: createRuntimeMemoryStore({ now: () => T0 }), reads: null, membership: async (_o, u) => (roles[u] ? { role: roles[u] } : null) }
  const opts = (user) => ({ env: ON, auth: () => ({ ok: true }), identity: identityFor(user), limiter, getServices: async () => svc })
  const body = { op: 'register_agntei', employee: { employee_id: 'emp_atlas_scout', role_key: 'acquisition_agent', display_name: 'Atlas Scout', markets: ['Dallas, TX'], skills: ['Probate', 'title research'], action_principal_id: 'agt_forged', status: 'active' } }
  assert.equal((await R.handleEmployeeUpsert(post('/employees', body), opts(OPERATOR))).status, 403)
  const res = await R.handleEmployeeUpsert(post('/employees', body), opts(OWNER))
  assert.equal(res.status, 201)
  const { data } = await res.json()
  assert.equal(data.executed, false)
  assert.deepEqual([data.employee.status, data.employee.origin, data.employee.employment_type, data.employee.action_principal_id], ['pending_link', 'agntei', 'operator_ai', null], 'a body principal / status is ignored')
  assert.deepEqual(data.employee.markets, ['dallas_tx'])
  assert.deepEqual(data.employee.skills, ['probate', 'title_research'])
  assert.equal(data.link.agent_id, 'agt_atlas_scout')
  assert.deepEqual(data.link.steps.map((s) => s.id), ['mint', 'principal', 'grants', 'bind', 'connect', 'link'])
  assert.equal((await R.handleEmployeeUpsert(post('/employees', body), opts(OWNER))).status, 409, 'an existing id is never re-registered')
  assert.equal((await R.handleEmployeeUpsert(post('/employees', { op: 'register_agntei', employee: { ...body.employee, employee_id: 'emp_bad_ceo', role_key: 'ceo' } }), opts(OWNER))).status, 422)
  const prof = await (await R.handleEmployeeGet(get('/employees/emp_atlas_scout'), 'emp_atlas_scout', opts(OWNER))).json()
  assert.equal(prof.data.activity.state, 'pending_link')
  assert.equal(prof.data.link.linked, false)
  assert.ok(prof.data.link_steps, 'the CEO sees the steps until the agent is linked')
  assert.ok(Array.isArray(prof.data.history.events) && prof.data.history.events.some((e) => e.type === 'wf.employee.upserted'))
  assert.equal(prof.data.history.gateway_available, true, 'no principal yet: an empty, truthful gateway history')
  const opProf = await (await R.handleEmployeeGet(get('/employees/emp_atlas_scout'), 'emp_atlas_scout', opts(OPERATOR))).json()
  assert.equal(opProf.data.link_steps, null, 'the owner steps are CEO-only')
  const ov = await (await R.handleOverview(get('/overview'), opts(OWNER))).json()
  assert.equal(ov.data.employees.find((e) => e.employee_id === 'emp_atlas_scout').activity.state, 'pending_link')
})
