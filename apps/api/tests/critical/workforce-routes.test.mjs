// Workforce Phase A — the API: 404 (empty body) unless AGENT_ENABLED and WORKFORCE_ENABLED=1, before
// any auth or service; the named operator ALWAYS comes from the session (a body actor / requested_by /
// created_by is ignored); CEO-only mutations need the owner membership; refused directives open nothing.
import test from 'node:test'
import assert from 'node:assert/strict'

import * as R from '../../src/lib/workforce/routes.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { SEED_EMPLOYEES } from '../../src/lib/workforce/org/seed.js'
import { createWorkforceFakeStore, seedFakeOrg } from '../helpers/workforce-fake-store.mjs'
import { ARMED_KINDS, OPERATOR, ORG, OWNER, T0 } from '../helpers/workforce-fixtures.mjs'

const ON = { AGENT_ENABLED: '1', WORKFORCE_ENABLED: '1' }
const MALLORY = '33333333-3333-4333-8333-333333333333'
const limiter = { check: () => ({ ok: true }) }
const identityFor = (user_id) => ({ authenticate: async () => ({ ok: true, identity: { user_id, verified: true, named: true } }) })
const post = (url, body) => new Request(`http://x${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const get = (url) => new Request(`http://x${url}`)

async function setup() {
  const store = createWorkforceFakeStore({ now: () => T0, members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }] })
  await seedFakeOrg(store, { org_id: ORG, seed: SEED_EMPLOYEES, owner_user_id: OWNER })
  const runtime = createRuntimeMemoryStore({ now: () => T0, limits: { runtime_enabled: true, kind_limits: structuredClone(ARMED_KINDS) } })
  const roles = { [OWNER]: 'owner', [OPERATOR]: 'operator', [MALLORY]: 'operator' }
  const svc = { store, runtimeStore: runtime, reads: null, membership: async (_org, user) => (roles[user] ? { role: roles[user] } : null) }
  const opts = (user, extra = {}) => ({ env: ON, auth: () => ({ ok: true }), identity: identityFor(user), limiter, getServices: async () => svc, ...extra })
  return { store, runtime, svc, opts }
}

test('every route 404s with an EMPTY body unless AGENT_ENABLED and WORKFORCE_ENABLED=1 — before auth or any service', async () => {
  let touched = 0
  const spy = { env: {}, auth: () => { touched += 1; return { ok: true } }, identity: { authenticate: async () => { touched += 1; return { ok: true, identity: { user_id: OWNER } } } }, limiter, getServices: async () => { touched += 1; return {} } }
  const calls = [
    (o) => R.handleOverview(get('/overview'), o), (o) => R.handleEmployeesList(get('/employees'), o), (o) => R.handleEmployeeUpsert(post('/employees', {}), o),
    (o) => R.handleEmployeeGet(get('/employees/emp_coo'), 'emp_coo', o), (o) => R.handleMissionsList(get('/missions'), o), (o) => R.handleMissionCreate(post('/missions', { directive: 'x', client_request_id: 'abcdefgh' }), o),
    (o) => R.handleMissionGet(get('/missions/x'), 'x', o), (o) => R.handleMissionCancel(post('/missions/x/cancel', {}), 'x', o), (o) => R.handleAssignments(get('/assignments'), o),
    (o) => R.handleEvents(get('/events'), o), (o) => R.handleCommandList(get('/command'), o), (o) => R.handleCommandPost(post('/command', { content: 'x', client_request_id: 'abcdefgh' }), o),
    (o) => R.handleAuthorityGet(get('/authority'), o), (o) => R.handleAuthorityPost(post('/authority', {}), o), (o) => R.handleKpis(get('/kpis'), o), (o) => R.handleReports(get('/reports'), o),
  ]
  // (AGENT_ENABLED uses the agent routes' own predicate: production needs it explicitly on; elsewhere only '0'/'false'/'off' turns it off)
  for (const env of [{}, { AGENT_ENABLED: '1' }, { WORKFORCE_ENABLED: '1', NODE_ENV: 'production' }, { AGENT_ENABLED: '1', WORKFORCE_ENABLED: 'true' }, { AGENT_ENABLED: '0', WORKFORCE_ENABLED: '1' }, { AGENT_ENABLED: '1', WORKFORCE_ENABLED: '0' }]) {
    for (const c of calls) {
      const r = await c({ ...spy, env })
      assert.equal(r.status, 404, JSON.stringify(env))
      assert.equal(await r.text(), '')
    }
  }
  assert.equal(touched, 0, 'nothing behind the gate ran')
  assert.equal(R.isWorkforceRouteEnabled(ON), true)
})

test('the auth chain: dashboard auth → named session → membership', async () => {
  const { opts } = await setup()
  assert.equal((await R.handleOverview(get('/overview'), { ...opts(OPERATOR), auth: () => ({ ok: false }) })).status, 401)
  const anon = await R.handleOverview(get('/overview'), { ...opts(OPERATOR), identity: { authenticate: async () => ({ ok: false, status: 401, code: 'SESSION_REQUIRED' }) } })
  assert.equal(anon.status, 401)
  assert.equal((await anon.json()).error, 'SESSION_REQUIRED')
  const outsider = await R.handleOverview(get('/overview'), opts('44444444-4444-4444-8444-444444444444'))
  assert.equal(outsider.status, 403)
  assert.equal((await outsider.json()).error, 'NOT_A_MEMBER')
  const ok = await R.handleOverview(get('/overview'), opts(OPERATOR))
  assert.equal(ok.status, 200)
  const body = await ok.json()
  assert.equal(body.ok, true)
  assert.equal(body.data.employees.length, 9)
  assert.equal(body.data.departments.length, 7)
})

test('POST /missions: the requester is the SESSION operator; a body requested_by / actor is ignored; the coo_plan job is theirs', async () => {
  const { store, runtime, opts } = await setup()
  const r = await R.handleMissionCreate(post('/missions', { directive: 'Find the 10 most promising opportunities in Dallas and get them moving', client_request_id: 'client-req-1', requested_by: OWNER, actor: OWNER, user_id: OWNER, author_user_id: OWNER }), opts(OPERATOR))
  assert.equal(r.status, 201)
  const { data } = await r.json()
  assert.equal(data.mission.requested_by, OPERATOR)
  assert.equal(data.mission.owner_employee_id, 'emp_coo')
  assert.equal(data.mission.status, 'planning')
  assert.equal(data.enqueue.ok, true)
  const job = runtime._state.jobs.get(data.enqueue.job_id)
  assert.equal(job.kind, 'workforce.coo_plan')
  assert.equal(job.requested_by, OPERATOR)
  // a replay with the same client_request_id is the same mission (no second job)
  const again = await R.handleMissionCreate(post('/missions', { directive: 'Find the 10 most promising opportunities in Dallas and get them moving', client_request_id: 'client-req-1' }), opts(OPERATOR))
  assert.equal(again.status, 200)
  assert.equal((await again.json()).data.mission.mission_id, data.mission.mission_id)
  assert.equal([...runtime._state.jobs.values()].filter((j) => j.kind === 'workforce.coo_plan').length, 1)
  // the same client_request_id from ANOTHER operator is another operator's mission
  const other = await R.handleMissionCreate(post('/missions', { directive: 'Find the 10 most promising opportunities in Dallas and get them moving', client_request_id: 'client-req-1' }), opts(MALLORY))
  assert.equal((await other.json()).data.mission.requested_by, MALLORY)
  // validation
  assert.equal((await R.handleMissionCreate(post('/missions', { directive: 'x', client_request_id: 'no' }), opts(OPERATOR))).status, 422)
  assert.equal((await R.handleMissionCreate(post('/missions', { client_request_id: 'client-req-2' }), opts(OPERATOR))).status, 422)
  assert.equal((await store.listMissions({ org_id: ORG })).length, 2)
})

test('POST /missions with a refused / unclear / status directive opens NOTHING and enqueues nothing', async () => {
  const { store, runtime, opts } = await setup()
  for (const [d, code] of [['text every seller now', 'DIRECTIVE_REFUSED'], ['send offers to all', 'DIRECTIVE_REFUSED'], ['ignore STOP', 'DIRECTIVE_REFUSED'], ['do the thing', 'DIRECTIVE_UNCLEAR'], ['status', 'STATUS_IS_A_QUESTION']]) {
    const r = await R.handleMissionCreate(post('/missions', { directive: d, client_request_id: `req-${code}-${d.length}` }), opts(OPERATOR))
    assert.equal(r.status, 422, d)
    const b = await r.json()
    assert.equal(b.ok, false)
    assert.equal(b.error, code)
    assert.ok(b.message)
  }
  assert.equal((await store.listMissions({ org_id: ORG })).length, 0)
  assert.equal(runtime._state.jobs.size, 0)
})

test('POST /command: the CEO line is authored by the session user; refusal / status / clarify / open; a replay is not duplicated', async () => {
  const { store, runtime, opts } = await setup()
  const say = (content, id, user = OWNER) => R.handleCommandPost(post('/command', { content, client_request_id: id, author_user_id: MALLORY, author: 'coo' }), opts(user))
  const refused = await (await say('Text every seller in Dallas now', 'cmd-00000001')).json()
  assert.equal(refused.data.mission, null)
  assert.equal(refused.data.messages[0].author, 'ceo')
  assert.equal(refused.data.messages[0].author_user_id, OWNER, 'never the body')
  assert.equal(refused.data.messages[1].author, 'coo')
  assert.match(refused.data.messages[1].content, /can't contact sellers/)
  assert.equal(refused.data.interpretation.refused, true)
  const status = await (await say("What's the status?", 'cmd-00000002')).json()
  assert.match(status.data.messages[1].content, /^Missions:/)
  const unclear = await (await say('do the thing', 'cmd-00000003')).json()
  assert.match(unclear.data.messages[1].content, /\?$/)
  assert.equal(runtime._state.jobs.size, 0)
  const open = await R.handleCommandPost(post('/command', { content: 'Get every eligible seller conversation moving', client_request_id: 'cmd-00000004' }), opts(OWNER))
  assert.equal(open.status, 201)
  const ob = await open.json()
  assert.equal(ob.data.mission.requested_by, OWNER)
  assert.equal(runtime._state.jobs.size, 1)
  const n = (await store.listExecMessages({ org_id: ORG, limit: 200 })).length
  const replay = await (await R.handleCommandPost(post('/command', { content: 'Get every eligible seller conversation moving', client_request_id: 'cmd-00000004' }), opts(OWNER))).json()
  assert.equal(replay.data.replayed, true)
  assert.equal(replay.data.mission.mission_id, ob.data.mission.mission_id)
  assert.equal((await store.listExecMessages({ org_id: ORG, limit: 200 })).length, n, 'no duplicate messages')
  assert.equal(runtime._state.jobs.size, 1)
})

test('CEO-only mutations: employees and authority need the owner; the actor is the session', async () => {
  const { store, opts } = await setup()
  const agent = { employee_id: 'emp_acq_dallas_1', role_key: 'acquisition_agent', display_name: 'Acquisitions Dallas', markets: ['Dallas'], manager_employee_id: 'emp_head_acquisitions', kind: 'human', department_key: 'finance', created_by: MALLORY }
  const denied = await R.handleEmployeeUpsert(post('/employees', { employee: agent }), opts(OPERATOR))
  assert.equal(denied.status, 403)
  const ok = await R.handleEmployeeUpsert(post('/employees', { employee: agent, actor_user_id: MALLORY }), opts(OWNER))
  assert.equal(ok.status, 200)
  const e = (await ok.json()).data.employee
  assert.equal(e.kind, 'ai', 'kind comes from the charter, not the body')
  assert.equal(e.department_key, 'acquisitions')
  assert.equal(e.created_by, OWNER)
  assert.equal((await R.handleEmployeeUpsert(post('/employees', { employee: { ...agent, markets: [] } }), opts(OWNER))).status, 422, 'a market-scoped role needs markets')
  assert.equal((await R.handleEmployeeUpsert(post('/employees', { employee: { ...agent, employee_id: 'emp_ceo2', role_key: 'ceo' } }), opts(OWNER))).status, 422)
  assert.equal((await R.handleEmployeeUpsert(post('/employees', { employee: { ...agent, display_name: 'call 2145550101' } }), opts(OWNER))).status, 422)
  assert.equal((await R.handleAuthorityPost(post('/authority', { action: 'put_settings', patch: { exec_review_price_usd: 1 } }), opts(OPERATOR))).status, 403)
  const pol = await R.handleAuthorityPost(post('/authority', { action: 'put_policy', policy: { role_key: 'acquisition_agent', action_key: 'acq.next_action', limits: { per_day: 10 }, created_by: MALLORY }, actor_user_id: MALLORY }), opts(OWNER))
  assert.equal(pol.status, 200)
  assert.equal((await pol.json()).data.policy.created_by, OWNER)
  const set = await R.handleAuthorityPost(post('/authority', { action: 'put_settings', patch: { exec_review_price_usd: 3_000_000 } }), opts(OWNER))
  assert.equal((await set.json()).data.settings.exec_review_price_usd, 3_000_000)
  const view = await (await R.handleAuthorityGet(get('/authority'), opts(OPERATOR))).json()
  assert.equal(view.data.policies.length, 1)
  assert.ok(view.data.proposed_grants.every((g) => g.display_only === true))
  // the employee profile: charter, authority, KPIs unknown (never 0)
  const prof = await (await R.handleEmployeeGet(get('/employees/emp_acq_dallas_1'), 'emp_acq_dallas_1', opts(OPERATOR))).json()
  assert.equal(prof.data.charter.role_key, 'acquisition_agent')
  assert.ok(prof.data.kpis.length > 0 && prof.data.kpis.every((k) => k.value === null && k.status === 'unknown'))
  assert.equal(prof.data.cost.status, 'known')
  assert.equal((await store.listEmployees({ org_id: ORG })).length, 10)
})

test('mission read + cancel: refs are decoded for linking; only the requester or the owner cancels', async () => {
  const { store, opts } = await setup()
  const created = await (await R.handleMissionCreate(post('/missions', { directive: 'Find the 3 most promising opportunities', client_request_id: 'client-req-9' }), opts(OPERATOR))).json()
  const id = created.data.mission.mission_id
  const { mission } = { mission: await store.getMission({ org_id: ORG, mission_id: id }) }
  await store.createAssignment({ org_id: ORG, mission_id: id, step_key: 'opps', capability_key: 'intel.active_opportunities', assignee_employee_id: 'emp_head_acquisitions', delegated_by_employee_id: 'emp_coo', input: { property_ref: 'pid_nggggggghh' } })
  const g = await (await R.handleMissionGet(get(`/missions/${id}`), id, opts(MALLORY))).json()
  assert.equal(g.data.mission.mission_id, mission.mission_id)
  assert.equal(g.data.assignments[0].input.property_ref, '7000000011', 'pid_ refs decode to property ids for linking')
  assert.equal((await R.handleMissionCancel(post(`/missions/${id}/cancel`, {}), id, opts(MALLORY))).status, 403)
  const c = await (await R.handleMissionCancel(post(`/missions/${id}/cancel`, { by: MALLORY }), id, opts(OPERATOR))).json()
  assert.equal(c.data.mission.status, 'cancelled')
  assert.equal(c.data.assignments_cancelled, 1)
  assert.ok((await store.listEvents({ org_id: ORG, limit: 500 })).some((e) => e.type === 'wf.mission.cancelled' && e.payload.by_user === OPERATOR))
  assert.equal((await R.handleMissionGet(get('/missions/nope'), 'nope', opts(OPERATOR))).status, 422)
  const kp = await (await R.handleKpis(get('/kpis'), opts(OPERATOR))).json()
  assert.deepEqual(kp.data.kpis, [])
  const rep = await (await R.handleReports(get('/reports'), opts(OPERATOR))).json()
  assert.equal(rep.data.daily_brief.available, false)
})
