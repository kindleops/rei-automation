// Workforce × Agntei — AUTHORITY PARITY (docs/WORKFORCE-AGNTEI.md §2: "a given action gets the same authorization decision
// from either entry point"). The SAME inputs (employee, assignment, mission evidence, policies, settings, holds, the runtime
// emergency stop, today's usage, budgets) go through BOTH real entry points:
//   the in-process engine: runDispatchPass (engine/dispatch.js) over the Workforce memory store — its recorded verdict;
//   the Action Gateway: the workforce_claim_assignment policy (actions/workforce) over the principal-bound context
//     the database read returns (the same facts, in that read's shape);
// and the decision + reasons must be identical, across allow / deny / escalate. Plus one PG case through the REAL gateway
// and the REAL dispatcher on one database. Both call lib/workforce/authority/assignment-authority.js.
import test from 'node:test'
import assert from 'node:assert/strict'

import { createWorkforceMemoryStore } from '../../src/lib/workforce/store/index.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runDispatchPass } from '../../src/lib/workforce/engine/dispatch.js'
import { WF_LOGIC, gatewayAuthority } from '../../src/lib/domain/action-gateway/actions/workforce/index.js'
import { assignmentResource, authorizeAssignment } from '../../src/lib/workforce/authority/assignment-authority.js'
import { seedEmployeesFor } from '../../src/lib/workforce/org/seed.js'
import { encodePropertyRef } from '../../src/lib/agent/missions/mission-codec.js'
import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'

const ORG = '00000000-0000-4000-8000-00000000a001'
const OWNER = '11111111-1111-4111-8111-111111111111'
const T0 = Date.parse('2026-10-21T15:00:00.000Z')
const ON = { WORKFORCE_ENABLED: '1' }
const PR = encodePropertyRef('700000001')
const HARTFORD = encodePropertyRef('225438557')

/** One scenario on a fresh memory store: the employee (autonomous, internal), a mission, one assignment, the facts. */
async function scenario({ role = 'research_analyst', markets = [], capability = 'research.property', input = { property_ref: PR, force: true }, held = false, stop = false,
  policy = null, budget = null, decision = null, priorToday = 0, extraEmployee = null }) {
  const store = createWorkforceMemoryStore({ now: () => T0, members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }] })
  for (const e of seedEmployeesFor({ org_id: ORG, owner_user_id: OWNER })) { const { org_id, ...x } = e; await store.upsertEmployee({ org_id: ORG, employee: x, actor_user_id: OWNER }) }
  const dept = { research_analyst: 'data_intelligence', acquisition_agent: 'acquisitions', cfo: 'finance' }[role]
  const employee_id = role === 'cfo' ? 'emp_cfo' : 'emp_subject'
  if (role !== 'cfo') await store.upsertEmployee({ org_id: ORG, employee: { employee_id, kind: 'ai', role_key: role, department_key: dept, display_name: 'Subject', markets, ...(extraEmployee || {}) }, actor_user_id: OWNER })
  if (policy) await store.putPolicy({ org_id: ORG, policy: { employee_id, action_key: capability, ...policy }, actor_user_id: OWNER })
  if (budget) await store.putBudget({ org_id: ORG, budget: { scope: 'employee', scope_key: employee_id, period: 'day', cap_usd: budget }, actor_user_id: OWNER })
  const { mission } = await store.openMission({ org_id: ORG, title: 'Parity', directive: 'Find the 3 most promising opportunities', requested_by: OWNER, owner_employee_id: 'emp_coo', idempotency_key: 'parity' })
  await store.transitionMission({ org_id: ORG, mission_id: mission.mission_id, to: 'active' })
  for (let i = 0; i < priorToday; i += 1) {
    const { assignment } = await store.createAssignment({ org_id: ORG, mission_id: mission.mission_id, step_key: `prior.${i}`, capability_key: capability, assignee_employee_id: employee_id, input: { property_ref: encodePropertyRef(String(800000000 + i)) } })
    const [c] = await store.claimAssignments({ org_id: ORG, owner: 'prior', limit: 1, lease_seconds: 60 })
    await store.finishAssignment({ org_id: ORG, assignment_id: c?.assignment_id ?? assignment.assignment_id, lease_token: c?.lease_token, status: 'completed', outcome_class: 'unknown' })
  }
  if (decision) {
    const { assignment: d } = await store.createAssignment({ org_id: ORG, mission_id: mission.mission_id, step_key: 'dec.c01', capability_key: 'intel.acquisition_decision', assignee_employee_id: 'emp_head_acquisitions', input: { property_ref: input.property_ref } })
    const [c] = await store.claimAssignments({ org_id: ORG, owner: 'prep', limit: 1, lease_seconds: 60 })
    await store.finishAssignment({ org_id: ORG, assignment_id: d.assignment_id, lease_token: c.lease_token, status: 'completed', outcome_class: 'verified', output: decision })
  }
  const { assignment } = await store.createAssignment({ org_id: ORG, mission_id: mission.mission_id, step_key: 'subject', capability_key: capability, assignee_employee_id: employee_id, input })
  const hold = held ? { held: true, hold_type: 'operator_hold' } : { held: false }
  return { store, employee_id, mission, assignment, hold, stop }
}

/** Entry point 1: the Workforce engine (one REAL dispatch pass); its verdict as recorded on the assignment / events. */
async function viaDispatch(s) {
  const runtime = createRuntimeMemoryStore({ now: () => T0, limits: { runtime_enabled: true, emergency_stop: s.stop, kind_limits: {} } })
  const services = { checkHold: async () => s.hold, researchEnabled: () => true }
  const ctx = { job: { job_id: 'mjob_parity', requested_by: OWNER }, step: async () => {}, remainingMs: () => 60_000, signal: null }
  await runDispatchPass({ store: s.store, runtimeStore: runtime, reads: null, services, env: ON, now: () => T0, org_id: ORG, ctx, maxPerPass: 5 })
  const events = await s.store.listEvents({ org_id: ORG, limit: 500 })
  const mine = events.filter((e) => e.assignment_id === s.assignment.assignment_id)
  const denied = mine.find((e) => e.type === 'wf.authority.denied')
  const esc = mine.find((e) => e.type === 'wf.authority.escalated')
  if (denied) return { decision: 'deny', reasons: denied.payload.reasons }
  if (esc) return { decision: 'escalate', reasons: esc.payload.reasons }
  return { decision: 'allow', reasons: null }
}

/** Entry point 2: the Action Gateway policy over the principal-bound context the database read returns (its shape). */
async function viaGateway(s) {
  const all = await s.store.listAssignments({ org_id: ORG, limit: 1000 })
  const employee = await s.store.getEmployee({ org_id: ORG, employee_id: s.employee_id })
  const c = {
    registered: true, binding_refusal: null, employee, emergency_stop: s.stop,
    assignment: { ...s.assignment, execution_mode: 'external' }, // the entry point's own difference: who claims it
    mission_assignments: all.filter((a) => a.mission_id === s.mission.mission_id),
    employee_assignments: all.filter((a) => a.assignee_employee_id === s.employee_id && String(a.created_at).slice(0, 10) === new Date(T0).toISOString().slice(0, 10)),
    policies: await s.store.listPolicies({ org_id: ORG, status: 'active' }), settings: await s.store.getSettings({ org_id: ORG }),
    budgets: await s.store.budgetStatus({ org_id: ORG, employee_id: s.employee_id, mission_id: s.mission.mission_id }),
  }
  const services = { env: ON, holdCheck: async () => s.hold }
  const p = await WF_LOGIC.workforce_claim_assignment.policy({ resource: { refs: { wf: c } }, services, now: () => T0 })
  if (p.decision === 'allow') return { decision: 'allow', reasons: null }
  return { decision: p.evidence.authority, reasons: p.evidence.reasons }
}

const CASES = [
  ['allow (charter default, internal)', {}, 'allow'],
  ['market out of scope', { role: 'acquisition_agent', markets: ['dallas'], input: { property_ref: PR, market: 'Chicago', force: true } }, 'deny'],
  ['automation hold on the property', { held: true }, 'deny'],
  ['Hartford: closed lost, never revive', { input: { property_ref: HARTFORD, force: true } }, 'deny'],
  ['the runtime emergency stop', { stop: true }, 'deny'],
  ['not in the role charter (the CFO researching)', { role: 'cfo' }, 'deny'],
  ['a policy daily limit reached', { policy: { limits: { per_day: 1 }, review: 'none' }, priorToday: 1 }, 'deny'],
  ['a budget cap below the research cost', { budget: 0.01 }, 'deny'],
  ['a policy above its risk', { policy: { review: 'none', risk: 'low' } }, 'deny'],
  ['a policy that requires CEO review', { policy: { review: 'ceo', risk: 'medium' } }, 'escalate'],
  ['a price at the executive review threshold', { capability: 'acq.next_action', role: 'acquisition_agent', markets: ['dallas'], input: { property_ref: PR, market: 'Dallas' }, decision: { mao: 6_000_000, ask: 6_500_000 } }, 'escalate'],
]

for (const [name, spec, expected] of CASES) {
  test(`PARITY: ${name} → the SAME ${expected} from the Workforce engine and the Action Gateway`, async () => {
    const g = await viaGateway(await scenario(spec))
    const d = await viaDispatch(await scenario(spec))
    assert.equal(g.decision, expected, JSON.stringify(g))
    assert.deepEqual(d, g, 'same decision, same reasons')
  })
}

test('PARITY (the shared functions): assignmentResource + authorizeAssignment are what both entry points call; the gateway context path equals a direct call', async () => {
  const s = await scenario({ role: 'acquisition_agent', markets: ['dallas'], input: { property_ref: PR, market: 'Chicago', force: true } })
  const employee = await s.store.getEmployee({ org_id: ORG, employee_id: s.employee_id })
  const { resource, decision, cost_usd } = assignmentResource({ assignment: s.assignment, missionAssignments: [] })
  const direct = authorizeAssignment({ employee, assignment: s.assignment, resource, decision, cost_usd, env: ON, now: T0, hold: { held: false } })
  const viaShared = await gatewayAuthority({ c: { employee, assignment: s.assignment, mission_assignments: [], employee_assignments: [], policies: [], settings: null, emergency_stop: false, budgets: [] }, services: { env: ON, holdCheck: async () => ({ held: false }) }, now: () => T0 })
  assert.deepEqual(viaShared, direct)
  assert.equal(direct.decision, 'deny')
  assert.deepEqual([...direct.reasons], ['MARKET_OUT_OF_SCOPE'])
})

// ── one PG case: the REAL gateway (as lc_action_gateway) and the REAL dispatcher on ONE database ──
const skip = pgAvailable() ? false : skipReason
test('PG PARITY: the same market-scoped refusal from the Action Gateway (an Agntei acquisition agent) and the dispatcher (an autonomous one) on the same database', { skip }, async () => {
  const { agnteiWorld, registerAgnteiAgent, wfGateway, agentSession, missionWith, dispatchPass, sel } = await import('../helpers/workforce-agntei-pg.mjs')
  const env = await agnteiWorld()
  try {
    const reg = await registerAgnteiAgent(env, { role_key: 'acquisition_agent', markets: ['dallas'] })
    const s = agentSession(wfGateway(env), reg.token)
    await s.call('workforce_link_self', { client_request_id: 'parity-link-01', external_install_id: 'inst_a1b2c3d4e5f6', external_agent_id: 'agent_parity1' })
    await env.store.upsertEmployee({ org_id: ORG, employee: { employee_id: 'emp_acq_dallas', kind: 'ai', role_key: 'acquisition_agent', department_key: 'acquisitions', display_name: 'Dallas Agent', markets: ['dallas'] }, actor_user_id: OWNER })
    const input = { property_ref: PR, market: 'Chicago', force: true }
    const { a } = await missionWith(env, [{ step: 'res.ext', assignee: 'emp_scout', input }, { step: 'res.int', assignee: 'emp_acq_dallas', input }])
    const g = await s.call('workforce_claim_assignment', { client_request_id: 'parity-claim-01', assignment_id: a['res.ext'].assignment_id })
    await dispatchPass(env)
    const d = (await sel(env.owner, "select payload from workforce.event where assignment_id = $1 and type = 'wf.authority.denied'", [a['res.int'].assignment_id]))[0]
    assert.equal(g.code, 'MARKET_OUT_OF_SCOPE', JSON.stringify(g))
    assert.deepEqual(g.result.reasons, d.payload.reasons)
  } finally { await env.drop() }
})
