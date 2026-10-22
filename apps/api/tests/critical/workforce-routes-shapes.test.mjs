// Workforce Phase A — the API RESPONSE shapes the dashboard reads (docs/WORKFORCE.md §8 implementation notes,
// feat/workforce-ui): a real mission is run through the engine on the fake store, then every route is read
// and its fields checked. Stored jsonb says step / capability; the response says step_key / capability_key.
// Property refs are decoded; no thread key, phone or lease token ever appears in a response.
import test from 'node:test'
import assert from 'node:assert/strict'

import * as R from '../../src/lib/workforce/routes.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createMissionMemoryReads } from '../../src/lib/agent/missions/mission-reads.js'
import { buildWorkforceHandlers } from '../../src/lib/workforce/engine/handlers.js'
import { SEED_EMPLOYEES } from '../../src/lib/workforce/org/seed.js'
import { createWorkforceFakeStore, seedFakeOrg } from '../helpers/workforce-fake-store.mjs'
import { ARMED_KINDS, OPERATOR, ORG, OWNER, T0, makeScore, makeServices, opp } from '../helpers/workforce-fixtures.mjs'

const ON = { AGENT_ENABLED: '1', WORKFORCE_ENABLED: '1' }
const limiter = { check: () => ({ ok: true }) }
const PHONE = /\+1[0-9]{10}|\(?\b[2-9][0-9]{2}\)?[\s.-][0-9]{3}[\s.-][0-9]{4}\b/
const keys = (o, ks, what) => { for (const k of ks) assert.ok(o && Object.prototype.hasOwnProperty.call(o, k), `${what}: ${k}`) }

async function world() {
  let clock = T0
  const now = () => clock
  const runtime = createRuntimeMemoryStore({ now, limits: { runtime_enabled: true, kind_limits: structuredClone(ARMED_KINDS), tick_max_jobs: 3, max_concurrency_global: 4, lease_seconds: 120 } })
  await runtime.upsertSchedule({ name: 'workforce-dispatch', kind: 'workforce.dispatch', interval_seconds: 60, created_by: OWNER, enabled: true })
  const reads = createMissionMemoryReads(runtime)
  const store = createWorkforceFakeStore({ now, members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }] })
  await seedFakeOrg(store, { org_id: ORG, seed: SEED_EMPLOYEES, owner_user_id: OWNER })
  const services = makeServices([opp(1), opp(2), opp(3, { score: null }), opp(5, { ask: 320_000 }), opp(6, { property_id: '700000006', score: makeScore({ property_id: '700000006', value: 6_500_000, offer: 4_200_000, mao: 4_500_000, repairs: 200_000 }), ask: 6_000_000 })])
  const research = { kind: 'property.research', async run(ctx) { await ctx.step('r'); return { result: { mission: 'property_research', property_ref: ctx.job.input.property_ref } } } }
  const handlers = { ...buildWorkforceHandlers({ store, runtimeStore: runtime, reads, services, env: ON, now }), 'property.research': research }
  const roles = { [OWNER]: 'owner', [OPERATOR]: 'operator' }
  const svc = { store, runtimeStore: runtime, reads, membership: async (_o, u) => (roles[u] ? { role: roles[u] } : null), listActiveHolds: services.listActiveHolds }
  const opts = (user = OWNER) => ({ env: ON, auth: () => ({ ok: true }), identity: { authenticate: async () => ({ ok: true, identity: { user_id: user } }) }, limiter, getServices: async () => svc })
  const call = async (fn, req, ...args) => { const r = await fn(req, ...args); const text = await r.text(); return { status: r.status, text, body: text ? JSON.parse(text) : null } }
  return { store, runtime, svc, opts, call, tick: () => runRuntimeTick({ store: runtime, handlers, workerId: 'wf-shape', now }), advance: (ms) => { clock += ms } }
}
const get = (u) => new Request(`http://x${u}`)
const post = (u, b) => new Request(`http://x${u}`, { method: 'POST', body: JSON.stringify(b) })

test('response shapes after a real mission: overview, missions, detail (plan, report, assignments), events, employee, authority, reports', async () => {
  const w = await world()
  const created = await w.call(R.handleCommandPost, post('/command', { content: 'Find the 3 most promising opportunities in Dallas and get them moving', client_request_id: 'shape-0001' }), w.opts())
  assert.equal(created.status, 201)
  const mission_id = created.body.data.mission.mission_id
  for (let i = 0; i < 40; i += 1) { await w.tick(); w.advance(61_000); if ((await w.store.getMission({ org_id: ORG, mission_id })).status === 'completed') break }
  assert.equal((await w.store.getMission({ org_id: ORG, mission_id })).status, 'completed')

  const all = []
  // overview
  const ov = await w.call(R.handleOverview, get('/overview'), w.opts())
  all.push(ov.text)
  const o = ov.body.data
  assert.equal(o.departments.length, 7)
  for (const d of o.departments) keys(d, ['department_key', 'head_employee_id', 'employee_count', 'open_assignments'], 'department')
  assert.equal(o.departments.find((d) => d.department_key === 'finance').head_employee_id, 'emp_cfo')
  for (const e of o.employees) assert.equal(typeof e.open_assignments, 'number')
  keys(o.runtime, ['emergency_stop', 'last_tick_at', 'kinds_armed', 'dispatch_enabled', 'detail'], 'runtime')
  assert.equal(o.runtime.emergency_stop, false)
  assert.deepEqual(o.runtime.kinds_armed.sort(), ['workforce.coo_plan', 'workforce.dispatch', 'workforce.mission_review'])
  assert.equal(o.runtime.dispatch_enabled, true)
  assert.ok(o.runtime.last_tick_at)
  assert.equal(typeof o.flags, 'object')
  assert.ok(Array.isArray(o.last_events) && o.last_events.length > 0)

  // missions list: assignment_counts
  const ml = await w.call(R.handleMissionsList, get('/missions'), w.opts())
  all.push(ml.text)
  const row = ml.body.data.missions.find((m) => m.mission_id === mission_id)
  assert.ok(row.assignment_counts.completed > 0)

  // mission detail
  const md = await w.call(R.handleMissionGet, get(`/missions/${mission_id}`), mission_id, w.opts())
  all.push(md.text)
  const d = md.body.data
  keys(d, ['mission', 'assignments', 'events', 'plan', 'report'], 'detail')
  for (const s of d.mission.plan.steps) keys(s, ['step_key', 'capability_key', 'label', 'assignee_role', 'assignee_employee_id', 'depends_on', 'fan_out', 'unavailable_reason'], `plan step ${s.step_key}`)
  assert.ok(d.mission.plan.steps.some((s) => s.fan_out === true && /^conv\.c\d+$/.test(s.step_key)))
  assert.ok(d.mission.plan.steps.some((s) => s.unavailable_reason && s.step_key.startsWith('unavailable:')))
  assert.equal(d.mission.plan.steps.find((s) => s.step_key === 'opps').capability_key, 'intel.active_opportunities')
  for (const a of d.assignments) { keys(a, ['blocked_reason', 'resource_label', 'step_key', 'capability_key', 'evidence'], 'assignment'); assert.equal('lease_token' in a, false) }
  assert.ok(d.assignments.some((a) => a.status === 'waiting_approval' && /CEO queue/.test(a.blocked_reason)))
  const rep = d.report
  keys(rep, ['summary', 'generated_at', 'completed', 'pending', 'escalations', 'refused', 'unknowns', 'ranked', 'costs'], 'report')
  assert.equal(typeof rep.summary, 'string')
  for (const section of ['completed', 'pending', 'escalations', 'refused', 'unknowns']) {
    for (const it of rep[section]) {
      keys(it, ['label', 'assignment_id', 'step_key', 'status', 'refs', 'reasons', 'detail'], `${section} item`)
      assert.ok(Array.isArray(it.refs) && Array.isArray(it.reasons))
      for (const r of it.refs) { keys(r, ['type', 'id', 'label'], 'ref'); assert.ok(['property', 'thread', 'opportunity', 'job', 'assignment', 'mission', 'employee', 'market'].includes(r.type)) }
    }
  }
  assert.ok(rep.completed.length > 0 && rep.escalations.length > 0)
  assert.ok(rep.ranked.length >= 1)
  for (const r of rep.ranked) {
    keys(r, ['rank', 'label', 'market', 'refs', 'components', 'cfo_verdict', 'next_action', 'assignment_id'], 'ranked')
    keys(r.components, ['contact', 'pressure', 'deal_quality', 'ev_usd', 'ev_reason'], 'components')
    assert.equal(r.components.ev_usd, null, 'EV unknown')
    assert.match(r.components.ev_reason, /^unknown/)
    for (const c of ['contact', 'pressure', 'deal_quality']) assert.ok(r.components[c] === null || (r.components[c] >= 0 && r.components[c] <= 1), c)
    keys(r.next_action, ['action', 'reason'], 'next_action')
    if (r.cfo_verdict) keys(r.cfo_verdict, ['verdict', 'reasons'], 'cfo_verdict')
    const p = r.refs.find((x) => x.type === 'property')
    assert.match(p.id, /^[0-9]+$/, 'decoded property id')
    assert.equal(p.property_id, p.id)
  }
  keys(rep.costs, ['total_usd', 'status', 'reason', 'by_job'], 'costs')
  assert.ok(['known', 'unknown'].includes(rep.costs.status))
  for (const j of rep.costs.by_job) keys(j, ['runtime_job_id', 'kind', 'assignment_id', 'usd'], 'cost line')

  // events: after / before / limit → { events, next_after }
  const ev = await w.call(R.handleEvents, get('/events?limit=5'), w.opts())
  all.push(ev.text)
  assert.equal(ev.body.data.events.length, 5)
  const na = ev.body.data.next_after
  assert.equal(na, Math.max(...ev.body.data.events.map((e) => e.event_id)))
  const ev2 = await w.call(R.handleEvents, get(`/events?after=${na}&limit=5`), w.opts())
  assert.ok(ev2.body.data.events.every((e) => e.event_id > na))
  const before = await w.call(R.handleEvents, get(`/events?before=${na}&limit=3`), w.opts())
  assert.ok(before.body.data.events.length <= 3 && before.body.data.events.every((e) => e.event_id < na))

  // employee profile
  const ep = await w.call(R.handleEmployeeGet, get('/employees/emp_cfo'), 'emp_cfo', w.opts())
  all.push(ep.text)
  const prof = ep.body.data
  keys(prof, ['employee', 'charter', 'authority', 'memory', 'assignments', 'kpis', 'cost'], 'profile')
  keys(prof.charter, ['mandate', 'responsibilities', 'kpi_keys', 'capabilities', 'max_tier'], 'charter')
  assert.ok(Array.isArray(prof.authority.policies))
  keys(prof.cost, ['today_usd', 'window_usd', 'window', 'cap_usd', 'status', 'reason'], 'cost')
  assert.ok(prof.kpis.every((k) => k.status === 'unknown' && k.value === null))

  // authority
  const put = await w.call(R.handleAuthorityPost, post('/authority', { op: 'put', policy: { role_key: 'acquisition_agent', action_key: 'acq.next_action', limits: { per_day: 10 } } }), w.opts())
  assert.equal(put.status, 200)
  const au = await w.call(R.handleAuthorityGet, get('/authority'), w.opts())
  all.push(au.text)
  const ad = au.body.data
  keys(ad, ['policies', 'settings', 'proposed_grants', 'restrictions', 'emergency', 'flags'], 'authority')
  keys(ad.settings, ['exec_review_price_usd', 'escalation'], 'settings')
  assert.equal(ad.settings.exec_review_price_usd, 5_000_000)
  for (const g of ad.proposed_grants) keys(g, ['agent_id', 'employee_id', 'action', 'scope', 'limits', 'from_policy_id', 'note'], 'grant')
  for (const r of ad.restrictions) keys(r, ['kind', 'label', 'reason', 'refs', 'since'], 'restriction')
  assert.equal(ad.restrictions.filter((r) => r.kind === 'exclusion').length, 2, 'Hartford and Maxwell')
  keys(ad.emergency, ['stop', 'reason', 'since'], 'emergency')
  assert.equal(ad.emergency.stop, false)
  const rv = await w.call(R.handleAuthorityPost, post('/authority', { op: 'revoke', policy_id: put.body.data.policy.policy_id }), w.opts())
  assert.equal(rv.body.data.policy.status, 'revoked')

  // reports
  const rp = await w.call(R.handleReports, get('/reports'), w.opts())
  all.push(rp.text)
  const entry = rp.body.data.reports.find((x) => x.mission_id === mission_id)
  keys(entry, ['mission_id', 'title', 'status', 'completed_at', 'report'], 'report entry')
  keys(rp.body.data.daily_brief, ['available', 'generated_at', 'summary', 'items', 'code'], 'daily_brief')

  // nothing contact-shaped, no stored pid_ ref, no lease token in any response
  for (const t of all) {
    assert.doesNotMatch(t, PHONE, 'a phone in a response')
    assert.doesNotMatch(t, /"lease_token"/)
    assert.doesNotMatch(t, /pid_[g-p]+/, 'property refs are decoded for linking')
  }
})

test('error codes: CEO_ONLY 403, PAYLOAD_REFUSED 422, EMERGENCY_STOP 423, ILLEGAL_TRANSITION 409, off = 404', async () => {
  const w = await world()
  const op = await w.call(R.handleCommandPost, post('/command', { content: 'status', client_request_id: 'shape-0002' }), w.opts(OPERATOR))
  assert.equal(op.status, 403)
  assert.equal(op.body.error, 'CEO_ONLY')
  assert.equal((await w.call(R.handleAuthorityPost, post('/authority', { op: 'revoke', policy_id: 'x' }), w.opts(OPERATOR))).body.error, 'CEO_ONLY')
  const refused = await w.call(R.handleMissionCreate, post('/missions', { directive: 'Find the 10 most promising opportunities near 214-555-0101', client_request_id: 'shape-0003' }), w.opts())
  assert.equal(refused.status, 422)
  assert.equal(refused.body.error, 'PAYLOAD_REFUSED')
  // a mission that completed cannot be cancelled
  const { mission } = await w.store.openMission({ org_id: ORG, title: 't', directive: 'find the best deals', requested_by: OWNER, owner_employee_id: 'emp_coo', idempotency_key: 'k-done' })
  await w.store.transitionMission({ org_id: ORG, mission_id: mission.mission_id, to: 'active' })
  await w.store.transitionMission({ org_id: ORG, mission_id: mission.mission_id, to: 'completed' })
  const ill = await w.call(R.handleMissionCancel, post(`/missions/${mission.mission_id}/cancel`, {}), mission.mission_id, w.opts())
  assert.equal(ill.status, 409)
  assert.equal(ill.body.error, 'ILLEGAL_TRANSITION')
  await w.runtime.emergencyStop({ by: OWNER, reason: 'test' })
  const stop = await w.call(R.handleCommandPost, post('/command', { content: 'Find the 3 most promising opportunities in Dallas', client_request_id: 'shape-0004' }), w.opts())
  assert.equal(stop.status, 423)
  assert.equal(stop.body.error, 'EMERGENCY_STOP')
  const stop2 = await w.call(R.handleMissionCreate, post('/missions', { directive: 'Find the 3 most promising opportunities in Dallas', client_request_id: 'shape-0005' }), w.opts())
  assert.equal(stop2.status, 423)
  assert.equal((await w.store.listMissions({ org_id: ORG })).length, 1, 'nothing opened under the emergency stop')
  const off = await R.handleOverview(get('/overview'), { ...w.opts(), env: { AGENT_ENABLED: '1' } })
  assert.equal(off.status, 404)
})
