// Workforce × Agntei — ONE employee identity (docs/WORKFORCE-AGNTEI.md §1) on a DISPOSABLE PostgreSQL 17 through the REAL
// Action Gateway (as lc_action_gateway): registration → owner bind (link window, expiring binding) → workforce_link_self;
// idempotent re-link; IDENTITY_MISMATCH and a duplicate external ref refused AND the grants suspended; link outside the
// window / after a revoke refused; calls after the binding expired refused; a re-bind is a new owner authorization;
// impersonation by an argument (FORGED_CONTEXT); revoked / expired grants; the gateway stop, the runtime emergency stop,
// the Workforce switch; and TENANT ISOLATION (a principal of org B reaches nothing of org A).
// Skipped (reported, never vacuous) without AGENT_PG_TEST_DB_URL.
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { agnteiWorld, registerAgnteiAgent, wfGateway, agentSession, missionWith, setControls, grant, sel, auditOf, ORG, ORG_B, OWNER, OWNER_B } from '../helpers/workforce-agntei-pg.mjs'
import { trapTransport } from '../helpers/action-gateway-pg.mjs'

const skip = pgAvailable() ? false : skipReason
const REF = { external_install_id: 'inst_a1b2c3d4e5f6', external_agent_id: 'agent_scout01' }
const P = 'pid_ghijk' // property 01234 (encoded)

async function withWorld(fn) {
  const trap = trapTransport()
  const env = await agnteiWorld()
  try { await fn(env) } finally { await env.drop(); trap.restore(); assert.deepEqual(trap.hits, [], 'no network') }
}
const empRow = async (env, id = 'emp_scout') => (await sel(env.owner, 'select * from workforce.employee where employee_id = $1', [id]))[0]

test('PG link: first bind activates; the same identity again is a no-op; a different identity is IDENTITY_MISMATCH — refused, recorded, and the grants SUSPENDED', { skip }, () => withWorld(async (env) => {
  const { token, agent_id } = await registerAgnteiAgent(env)
  const s = agentSession(wfGateway(env), token)
  let r = await s.call('workforce_whoami')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.result.employee.status, 'pending_link')
  assert.equal(r.result.linked, false)
  assert.equal(r.result.employee.employment_type, 'operator_ai')
  assert.equal(r.result.grants.length, 11, 'its live Workforce grants')

  r = await s.call('workforce_link_self', { client_request_id: s.id('link'), ...REF })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.code, 'LINKED')
  const e = await empRow(env)
  assert.equal(e.status, 'active')
  assert.equal(e.external_agent_id, REF.external_agent_id)
  assert.equal(e.external_install_id, REF.external_install_id)

  r = await s.call('workforce_link_self', { client_request_id: s.id('link'), ...REF })
  assert.equal(r.ok, true)
  assert.equal(r.code, 'ALREADY_LINKED', 'idempotent re-link')

  r = await s.call('workforce_link_self', { client_request_id: s.id('link'), external_install_id: REF.external_install_id, external_agent_id: 'agent_impostor9' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'IDENTITY_MISMATCH')
  assert.equal((await empRow(env)).external_agent_id, REF.external_agent_id, 'the linked identity never changes')
  const g = await sel(env.owner, "select count(*)::int n from action_gateway.capability_grants where agent_id = $1 and suspended_reason = 'ANOMALY_IDENTITY_MISMATCH'", [agent_id])
  assert.equal(g[0].n, 11, 'every live Workforce grant of the principal is suspended')
  assert.ok((await sel(env.owner, "select 1 from action_gateway.grant_events where event_type = 'failure' and code = 'IDENTITY_MISMATCH'")).length, 'recorded through grant_note_failure')
  assert.ok((await sel(env.owner, "select 1 from workforce.event where type = 'wf.employee.identity_refused' and employee_id = 'emp_scout'")).length)
  r = await s.call('workforce_whoami')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'GRANT_SUSPENDED', 'only an owner reinstates')
  assert.ok((await auditOf(env, agent_id)).some((a) => a.code === 'IDENTITY_MISMATCH'), 'audited')
}))

test('PG link: a second Agntei agent presenting an identity already linked to another employee is refused (EXTERNAL_REF_ALREADY_LINKED) and its grants suspended', { skip }, () => withWorld(async (env) => {
  const a = await registerAgnteiAgent(env)
  const b = await registerAgnteiAgent(env, { employee_id: 'emp_scout_two', agent_id: 'agt_scout_two', display_name: 'Scout Two' })
  assert.equal((await agentSession(wfGateway(env), a.token).call('workforce_link_self', { client_request_id: 'link-a-0001', ...REF })).code, 'LINKED')
  const r = await agentSession(wfGateway(env), b.token).call('workforce_link_self', { client_request_id: 'link-b-0001', ...REF })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'EXTERNAL_REF_ALREADY_LINKED')
  assert.equal((await empRow(env, 'emp_scout_two')).status, 'pending_link')
  assert.equal((await sel(env.owner, "select count(*)::int n from action_gateway.capability_grants where agent_id = 'agt_scout_two' and suspended_at is not null"))[0].n, 11)
  assert.equal((await sel(env.owner, "select count(*)::int n from action_gateway.capability_grants where agent_id = $1 and suspended_at is not null", [a.agent_id]))[0].n, 0, 'the legitimate agent is untouched')
}))

test('PG binding: link only inside the owner\'s window; after a revoke every call is BINDING_REVOKED (audited) and the open leases are released; after expiry BINDING_EXPIRED; a re-bind is a new owner authorization', { skip }, () => withWorld(async (env) => {
  const { token, agent_id } = await registerAgnteiAgent(env)
  const s = agentSession(wfGateway(env), token)
  // the window closed (the owner bound it 2 days ago with a 1-day window)
  await env.owner.query("update workforce.employee set bound_at = now() - interval '2 days', link_expires_at = now() - interval '1 day' where employee_id = 'emp_scout'")
  let r = await s.call('workforce_link_self', { client_request_id: s.id('link'), ...REF })
  assert.equal(r.code, 'LINK_WINDOW_CLOSED')
  assert.equal((await empRow(env)).status, 'pending_link')
  // a new owner authorization (re-bind) opens a new window
  await env.owner.query("select workforce.employee_bind_principal($1, 'emp_scout', $2, $3, interval '1 hour')", [ORG, agent_id, OWNER])
  r = await s.call('workforce_link_self', { client_request_id: s.id('link'), ...REF })
  assert.equal(r.code, 'LINKED')

  // revoke: every call refused, the open external lease released and reaped back to ready for the SAME assignee
  const { a } = await missionWith(env, [{ step: 'res.c01', assignee: 'emp_scout', input: { property_ref: P }, resource_type: 'property', resource_key: P }])
  r = await s.call('workforce_claim_assignment', { client_request_id: s.id('claim'), assignment_id: a['res.c01'].assignment_id })
  assert.equal(r.code, 'CLAIMED', JSON.stringify(r))
  const unb = (await env.owner.query("select workforce.employee_unbind($1, 'emp_scout', $2, 'owner test') r", [ORG, OWNER])).rows[0].r
  assert.equal(unb.leases_released, 1)
  const row = (await sel(env.owner, 'select status, assignee_employee_id, execution_mode from workforce.assignment where assignment_id = $1', [a['res.c01'].assignment_id]))[0]
  assert.deepEqual(row, { status: 'ready', assignee_employee_id: 'emp_scout', execution_mode: 'external' }, 'reaped to ready for the same external assignee, never a mode flip')
  for (const [tool, args] of [['workforce_whoami', {}], ['workforce_link_self', { client_request_id: s.id('l'), ...REF }], ['workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: a['res.c01'].assignment_id }]]) {
    r = await s.call(tool, args)
    assert.equal(r.ok, false, tool)
    assert.equal(r.error?.code ?? r.code, 'BINDING_REVOKED', tool)
  }
  assert.ok((await auditOf(env, agent_id)).filter((x) => x.code === 'BINDING_REVOKED').length >= 3, 'every refusal is audited')

  // re-bind (new owner authorization) → calls work again
  await env.owner.query("select workforce.employee_bind_principal($1, 'emp_scout', $2, $3)", [ORG, agent_id, OWNER])
  assert.equal((await s.call('workforce_whoami')).ok, true)

  // expiry: the binding validity passed → BINDING_EXPIRED everywhere (the database writer refuses too)
  await env.owner.query("update workforce.employee set binding_valid_until = now() - interval '1 second' where employee_id = 'emp_scout'")
  r = await s.call('workforce_list_assignments', {})
  assert.equal(r.error.code, 'BINDING_EXPIRED')
  r = await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: a['res.c01'].assignment_id })
  assert.equal(r.error.code, 'BINDING_EXPIRED')
  await env.owner.query("select workforce.employee_bind_principal($1, 'emp_scout', $2, $3)", [ORG, agent_id, OWNER])
  r = await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: a['res.c01'].assignment_id })
  assert.ok(['CLAIMED', 'NOT_DUE'].includes(r.code), JSON.stringify(r))
  // a lease never outlives the binding
  await env.owner.query("select workforce.employee_bind_principal($1, 'emp_scout', $2, $3, interval '1 hour', now() + interval '5 minutes')", [ORG, agent_id, OWNER])
  await env.owner.query("update workforce.assignment set next_attempt_at = null where assignment_id = $1", [a['res.c01'].assignment_id])
  r = await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: a['res.c01'].assignment_id, lease_seconds: 3600 })
  assert.ok(['CLAIMED', 'ALREADY_HELD'].includes(r.code), JSON.stringify(r))
  const lease = (await sel(env.owner, 'select a.lease_until <= e.binding_valid_until ok from workforce.assignment a join workforce.employee e on e.employee_id = a.assignee_employee_id where a.assignment_id = $1', [a['res.c01'].assignment_id]))[0]
  assert.equal(lease.ok, true)
}))

test('PG impersonation + authority: an employee / actor argument is FORGED_CONTEXT; a revoked or expired grant refuses; the gateway stop, the runtime emergency stop and the Workforce switch refuse', { skip }, () => withWorld(async (env) => {
  const { token, agent_id } = await registerAgnteiAgent(env, { grants: ['workforce.whoami', 'workforce.link_self', 'workforce.claim_assignment', 'workforce.list_assignments'] })
  const s = agentSession(wfGateway(env), token)
  assert.equal((await s.call('workforce_link_self', { client_request_id: s.id('link'), ...REF })).code, 'LINKED')
  const { a } = await missionWith(env, [{ step: 'res.c01', assignee: 'emp_scout', input: { property_ref: P }, resource_type: 'property', resource_key: P }])
  const id = a['res.c01'].assignment_id
  for (const forged of [{ employee_id: 'emp_coo' }, { actor: 'emp_coo' }, { assignee_employee_id: 'emp_coo' }, { acting_employee: 'emp_ceo' }, { requested_by: OWNER }, { agent_id: 'agt_other' }]) {
    const r = await s.call('workforce_claim_assignment', { client_request_id: s.id('f'), assignment_id: id, ...forged })
    assert.equal(r.error?.code, 'FORGED_CONTEXT', JSON.stringify(forged))
  }
  // an expired grant (owner-minted in the past) does not exist for the agent
  await env.owner.query(`insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, granted_by, valid_from, expires_at) values ($1, $2, 'workforce.escalate', 1, $3, now() - interval '3 days', now() - interval '1 day')`, [ORG, agent_id, OWNER])
  let r = await s.call('workforce_escalate', { client_request_id: s.id('e'), assignment_id: id, reasons: ['NEEDS_REVIEW'] })
  assert.equal(r.error?.code, 'CAPABILITY_NOT_GRANTED')
  // a revoked grant
  await env.owner.query("update action_gateway.capability_grants set revoked_at = now(), revoked_by = $2 where agent_id = $1 and capability = 'workforce.claim_assignment'", [agent_id, OWNER])
  r = await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: id })
  assert.equal(r.error?.code, 'CAPABILITY_NOT_GRANTED')
  await grant(env, { agent_id, capability: 'workforce.claim_assignment' })
  // the runtime emergency stop: Workforce writes refused (reads stay truthful)
  await env.owner.query("update agent.runtime_limits set emergency_stop = true, emergency_stop_at = now(), emergency_stop_by = 'test', emergency_stop_reason = 'test' where id = 1")
  r = await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: id })
  assert.equal(r.code, 'EMERGENCY_STOP', JSON.stringify(r))
  assert.equal((await s.call('workforce_whoami')).ok, true)
  await env.owner.query("update agent.runtime_limits set emergency_stop = false, emergency_stop_at = null, emergency_stop_by = null, emergency_stop_reason = null where id = 1")
  // the GATEWAY stop (action_gateway_enabled absent) refuses EVERYTHING, reads included
  await setControls(env.owner, { action_gateway_enabled: null })
  for (const [tool, args] of [['workforce_whoami', {}], ['workforce_list_assignments', {}], ['workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: id }], ['workforce_link_self', { client_request_id: s.id('l'), ...REF }]]) {
    r = await s.call(tool, args)
    assert.equal(r.error?.code, 'ACTION_GATEWAY_STOPPED', tool)
  }
  await setControls(env.owner, { action_gateway_enabled: 'true' })
  // the Workforce switch on the Action MCP host (born OFF)
  const off = agentSession(wfGateway(env, { serviceEnv: {} }), token)
  assert.equal((await off.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: id })).error?.details?.reason, 'WORKFORCE_DISABLED')
  assert.equal((await off.call('workforce_whoami')).error?.details?.reason, 'WORKFORCE_DISABLED')
  assert.deepEqual((await sel(env.owner, 'select lease_owner, attempt from workforce.assignment where assignment_id = $1', [id]))[0], { lease_owner: null, attempt: 0 }, 'nothing was claimed by any refused call')
}))

test('PG tenant isolation: a principal of org B reads and acts on NOTHING of org A through any workforce_* tool; cross-tenant credentials are refused', { skip }, () => withWorld(async (env) => {
  const A = await registerAgnteiAgent(env)
  await agentSession(wfGateway(env), A.token).call('workforce_link_self', { client_request_id: 'link-a-0001', ...REF })
  const { mission, a } = await missionWith(env, [{ step: 'res.c01', assignee: 'emp_scout', input: { property_ref: P }, resource_type: 'property', resource_key: P }])
  const id = a['res.c01'].assignment_id
  // org B: its own CEO + an Agntei employee bound to a principal of org B
  await env.store.upsertEmployee({ org_id: ORG_B, employee: { employee_id: 'emp_ceo_b', kind: 'human', role_key: 'ceo', department_key: 'executive', display_name: 'CEO B', user_id: OWNER_B }, actor_user_id: OWNER_B })
  const B = await registerAgnteiAgent(env, { org: ORG_B, owner: OWNER_B, employee_id: 'emp_scout_b', agent_id: 'agt_scout_b', display_name: 'Scout B' })
  const sB = agentSession(wfGateway(env, { org: ORG_B }), B.token)
  assert.equal((await sB.call('workforce_link_self', { client_request_id: 'link-b-0001', external_install_id: 'inst_b1b2c3d4e5f6', external_agent_id: 'agent_scoutb1' })).code, 'LINKED')
  const who = await sB.call('workforce_whoami')
  assert.equal(who.result.employee.employee_id, 'emp_scout_b')
  assert.equal(who.result.employee.org_id, ORG_B)
  assert.deepEqual((await sB.call('workforce_list_assignments', { include_mission_peers: true })).result.assignments, [])
  assert.equal((await sB.call('workforce_get_mission', { mission_id: mission.mission_id })).error?.code, 'MISSION_NOT_FOUND')
  for (const [tool, args] of [
    ['workforce_claim_assignment', { assignment_id: id }], ['workforce_report_progress', { assignment_id: id, claim_attempt: 0 }],
    ['workforce_complete_assignment', { assignment_id: id, claim_attempt: 0, output: { summary: 'x' } }], ['workforce_request_research', { assignment_id: id, claim_attempt: 0 }],
    ['workforce_handoff', { assignment_id: id, to_coo: true }], ['workforce_escalate', { assignment_id: id, reasons: ['X1'] }],
  ]) {
    const r = await sB.call(tool, { client_request_id: sB.id('x'), ...args })
    assert.equal(r.error?.code, 'ASSIGNMENT_NOT_FOUND', tool)
  }
  // B's open_mission lands in org B (no COO there: refused), never in A
  const om = await sB.call('workforce_open_mission', { client_request_id: sB.id('m'), directive: 'Find the 5 most promising opportunities in Dallas' })
  assert.notEqual(om.code, 'MISSION_OPENED')
  assert.equal((await sel(env.owner, "select count(*)::int n from workforce.mission where org_id = $1", [ORG_B]))[0].n, 0)
  // credentials across tenants: the principal lookup is tenant-scoped (the other tenant's credential is unknown here)
  for (const r of [await agentSession(wfGateway(env), B.token).call('workforce_whoami'), await agentSession(wfGateway(env, { org: ORG_B }), A.token).call('workforce_whoami')]) {
    assert.equal(r.ok, false)
    assert.ok(['CREDENTIAL_UNKNOWN', 'CROSS_TENANT'].includes(r.error?.code), r.error?.code)
  }
  // and org A's row is untouched
  assert.deepEqual((await sel(env.owner, 'select status, lease_owner from workforce.assignment where assignment_id = $1', [id]))[0], { status: 'pending', lease_owner: null })
}))

test('PG B1 regression: an Agntei agent id holding a 10-digit run (e.g. agent_c382059173644fa1) LINKS — was PARAMS_NOT_STORABLE', { skip }, () => withWorld(async (env) => {
  const { token } = await registerAgnteiAgent(env)
  const s = agentSession(wfGateway(env), token)
  const ref = { external_install_id: 'agntei_inst_0123456789abcdef0123456789abcdef', external_agent_id: 'agent_c382059173644fa1' }
  const r = await s.call('workforce_link_self', { client_request_id: s.id('link'), ...ref })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.code, 'LINKED')
  const e = await empRow(env)
  assert.equal(e.status, 'active')
  assert.equal(e.external_agent_id, ref.external_agent_id)
  const again = await s.call('workforce_link_self', { client_request_id: s.id('link'), ...ref })
  assert.equal(again.code, 'ALREADY_LINKED')
}))
