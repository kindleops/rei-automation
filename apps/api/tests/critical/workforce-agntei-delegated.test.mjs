// Workforce × Agntei — the DELEGATED triage (the live Claude Code milestone, 2026-10-22): an acquisition-type Agntei
// employee (operator_ai) relays "research the most promising opportunities in your market and report to the COO" for
// itself. The COO's plan must land ONE real research + recommendation assignment on that employee (external), never the
// candidate read that drives the plan, and never the inline per-candidate reads (they would stall while its agent is
// offline). Memory twin; no database.
import test from 'node:test'
import assert from 'node:assert/strict'

import { createWorkforceMemoryStore } from '../../src/lib/workforce/store/index.js'
import { seedEmployeesFor } from '../../src/lib/workforce/org/seed.js'
import { createCooPlanHandler } from '../../src/lib/workforce/engine/handlers.js'
import { ensureExpansions, missionSettlement } from '../../src/lib/workforce/engine/dispatch.js'
import { buildPlan, expandDelegate, expandCandidates } from '../../src/lib/workforce/coo/playbooks.js'
import { pickAssignee, createStaffer, autoStaffable } from '../../src/lib/workforce/coo/staffing.js'
import { buildMissionReport } from '../../src/lib/workforce/engine/report.js'
import { reportMessage, planMessage } from '../../src/lib/workforce/coo/respond.js'
import { capability as researchProperty } from '../../src/lib/workforce/capabilities/research-property.js'
import { summaryOf } from '../../src/lib/workforce/capabilities/memory-assert.js'

const ORG = '00000000-0000-4000-8000-00000000a001'
const OWNER = '11111111-1111-4111-8111-111111111111'
const T0 = Date.parse('2026-10-22T15:00:00.000Z')
const DIRECTIVE = 'Research the ten most promising acquisition opportunities available in your assigned test market. Review their property information, conversation context, and available underwriting evidence. Identify the strongest opportunities, record your findings, and report your recommendations to the COO.'
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

async function org({ role = 'acquisition_agent', markets = ['dallas_test'] } = {}) {
  const store = createWorkforceMemoryStore({ now: () => T0, members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }] })
  for (const e of seedEmployeesFor({ org_id: ORG, owner_user_id: OWNER })) { const { org_id, ...x } = e; await store.upsertEmployee({ org_id: ORG, employee: x, actor_user_id: OWNER }) }
  await store.upsertEmployee({ org_id: ORG, employee: { employee_id: 'emp_scout', kind: 'ai', role_key: role, department_key: role === 'acquisition_agent' ? 'acquisitions' : 'data_intelligence', display_name: 'Scout', origin: 'agntei', markets }, actor_user_id: OWNER })
  store._linkAgntei({ employee_id: 'emp_scout', agent_id: 'agt_scout' })
  return store
}
async function relay(store, { directive = DIRECTIVE, self = 'emp_scout' } = {}) {
  const { mission } = await store.openMission({ org_id: ORG, title: 'Live milestone', directive, requested_by: OWNER, owner_employee_id: 'emp_coo', idempotency_key: `k:${directive.length}:${directive.slice(0, 40)}:${self}` })
  const enq = []
  const h = createCooPlanHandler({ store, runtimeStore: { enqueue: async (j) => { enq.push(j); return { ok: true, job_id: `mjob_${uuid(enq.length).slice(9)}` } } }, env: { WORKFORCE_ENABLED: '1' }, now: () => T0, org_id: ORG })
  await h.run({ job: { job_id: 'mjob_plan', input: { mission_id: mission.mission_id, ...(self ? { assign_first_to: self } : {}) }, requested_by: OWNER }, step: async () => ({ ok: true }), remainingMs: () => 20_000 })
  return { mission: await store.getMission({ org_id: ORG, mission_id: mission.mission_id }), enq }
}
const candidate = (i) => ({ property_ref: `SYNDAL-${String(i).padStart(3, '0')}`, opportunity_id: uuid(200 + i), conversation_id: uuid(100 + i), market: 'Dallas TEST', stage: 'asking_price', status: 'active', has_thread: true, seller_spoke_last: true, last_inbound_at: new Date(T0 - i * 3_600_000).toISOString(), last_outbound_at: null, intent: 'asks_offer', temperature: 'warm', has_decision: true, decision_computed_at: null })

test('staffing: an operator_ai (Agntei) employee is never auto-staffed for an inline READ capability; it stays staffable for internal work (research)', () => {
  const emps = [
    { employee_id: 'emp_head_acquisitions', role_key: 'head_acquisitions', status: 'active', markets: [], employment_type: 'autonomous_ai' },
    { employee_id: 'emp_scout', role_key: 'acquisition_agent', status: 'active', markets: ['dallas_test'], employment_type: 'operator_ai' },
  ]
  for (const cap of ['intel.conversation_state', 'intel.acquisition_decision', 'acq.next_action']) {
    assert.equal(pickAssignee({ role: 'acquisition_agent', market: 'Dallas (TEST)', employees: emps, capability: cap }).employee_id, 'emp_head_acquisitions', `${cap}: the head covers the market, not the external agent`)
  }
  assert.equal(pickAssignee({ role: 'acquisition_agent', market: 'Dallas (TEST)', employees: emps, capability: 'research.property' }).employee_id, 'emp_scout', 'internal work may go to it')
  assert.equal(pickAssignee({ role: 'acquisition_agent', market: 'Dallas (TEST)', employees: emps }).employee_id, 'emp_scout', 'no capability named: unchanged behaviour')
  assert.equal(autoStaffable(emps[1], 'intel.conversation_state'), false)
  assert.equal(autoStaffable({ ...emps[1], employment_type: 'autonomous_ai' }, 'intel.conversation_state'), true)
  const staff = createStaffer({ employees: emps })
  assert.equal(staff('acquisition_agent', { market: 'Dallas (TEST)', capability: 'intel.conversation_state' }).employee_id, 'emp_head_acquisitions')
  // the full triage expansion of a market whose only acquisition agent is external: every per-candidate read goes to the head
  const plan = buildPlan({ intent: 'opportunity_triage', interpretation: { count: 3, markets: ['Dallas (TEST)'] } })
  const { steps } = expandCandidates(plan, { candidates: [candidate(1), candidate(2)] })
  const s2 = createStaffer({ employees: [...emps, { employee_id: 'emp_research_01', role_key: 'research_analyst', status: 'active', markets: [], employment_type: 'autonomous_ai' }, { employee_id: 'emp_cfo', role_key: 'cfo', status: 'active', markets: [], employment_type: 'autonomous_ai' }] })
  const who = steps.map((s) => [s.step, s2(s.role, { market: s.market ?? null, capability: s.capability })?.employee_id])
  assert.ok(who.filter(([k]) => /^(conv|dec)\./.test(k)).every(([, e]) => e === 'emp_head_acquisitions'), JSON.stringify(who))
})

test('coo_plan: an external ACQUISITION employee relaying the owner\'s directive for itself → the DELEGATED plan (candidates read internally, then one research + recommendation step for the agent), scoped to its market', async () => {
  const store = await org()
  const { mission, enq } = await relay(store)
  assert.equal(mission.status, 'active')
  assert.equal(mission.plan.intent, 'opportunity_triage')
  assert.equal(mission.plan.params.n, 10, 'ten')
  assert.deepEqual(mission.plan.variant, { delegated: true, decision: false, research: true, finance: false })
  assert.deepEqual(mission.plan.delegate, { employee_id: 'emp_scout', role: 'acquisition_agent', display_name: 'Scout', execution_mode: 'external' })
  assert.deepEqual(mission.plan.params.markets, ['dallas test'], 'the directive names no market: the relaying employee\'s')
  assert.equal(mission.objective.markets_source, 'relaying_employee')
  const as = await store.listAssignments({ org_id: ORG, mission_id: mission.mission_id })
  assert.deepEqual(as.map((a) => [a.step_key, a.capability_key, a.assignee_employee_id, a.execution_mode]), [['opps', 'intel.active_opportunities', 'emp_head_acquisitions', 'internal']], 'the candidate read is NEVER the external agent\'s')
  const ev = await store.listEvents({ org_id: ORG, mission_id: mission.mission_id, limit: 50 })
  assert.ok(ev.some((e) => e.type === 'wf.mission.delegated' && e.employee_id === 'emp_scout'))
  assert.equal(ev.some((e) => e.type === 'wf.mission.assign_to_self_skipped'), false)
  assert.ok(enq.some((j) => j.kind === 'workforce.dispatch'), 'dispatch enqueued')
  assert.match(planMessage({ mission, plan: mission.plan }).content, /Scout \(Agntei\) researches them .* recommends the strongest 10/)

  // the candidate read completes (internal) → the expansion lands ONE external research step on Scout + the COO's memory step
  const [opps] = await store.claimAssignments({ org_id: ORG, owner: 'dispatch', limit: 1, lease_seconds: 60 })
  await store.finishAssignment({ org_id: ORG, assignment_id: opps.assignment_id, lease_token: opps.lease_token, status: 'completed', outcome_class: 'verified', output: { mode: 'deal_contexts', scanned: 24, eligible: 21, candidates: Array.from({ length: 21 }, (_, i) => candidate(i + 1)) } })
  const employees = await store.listEmployees({ org_id: ORG })
  assert.equal(await ensureExpansions({ store, org_id: ORG, mission: await store.getMission({ org_id: ORG, mission_id: mission.mission_id }), employees }), true)
  assert.equal(await ensureExpansions({ store, org_id: ORG, mission: await store.getMission({ org_id: ORG, mission_id: mission.mission_id }), employees }), false, 'a replay grows nothing')
  const after = await store.listAssignments({ org_id: ORG, mission_id: mission.mission_id })
  const research = after.find((a) => a.step_key === 'research')
  // pending with its one dependency completed: claimable on the agent's next claim (the external claim makes it ready)
  assert.deepEqual([research.capability_key, research.assignee_employee_id, research.execution_mode, research.status, research.depends_on], ['research.property', 'emp_scout', 'external', 'pending', ['opps']])
  assert.equal(research.input.mode, 'delegated_review')
  assert.equal(research.input.n, 10)
  assert.equal(research.input.candidates.length, 20, 'the pool (2N) of candidates')
  assert.equal(research.input.candidates_total, 21)
  assert.deepEqual(Object.keys(research.input.candidates[0]).sort(), ['conversation_id', 'has_decision', 'intent', 'last_inbound_at', 'market', 'opportunity_id', 'property_ref', 'seller_spoke_last', 'stage', 'status', 'temperature'])
  const memory = after.find((a) => a.step_key === 'memory')
  assert.deepEqual([memory.assignee_employee_id, memory.depends_on], ['emp_coo', ['research']])
  assert.equal(after.length, 3, 'no per-candidate read, rank or next action is staffed to anyone')
  const m2 = await store.getMission({ org_id: ORG, mission_id: mission.mission_id })
  assert.equal(m2.plan.expansions.after_opps, 'expanded')
  assert.equal(missionSettlement(m2, after, { employees }).settled, false, 'the agent\'s step can still complete')
})

test('coo_plan: every other relay keeps the first-step rule (a research analyst is not delegated; a non-triage directive is not delegated)', async () => {
  const s1 = await org({ role: 'research_analyst', markets: [] })
  const { mission: m1 } = await relay(s1, { directive: 'Research the three strongest Dallas seller opportunities and report the acquisition economics to the COO.' })
  assert.equal(m1.plan.variant?.delegated, undefined)
  assert.ok((await s1.listEvents({ org_id: ORG, mission_id: m1.mission_id, limit: 50 })).some((e) => e.type === 'wf.mission.assign_to_self_skipped'), 'the scripted milestone\'s path, unchanged')
  const s2 = await org()
  const { mission: m2 } = await relay(s2, { directive: 'Diagnose why Dallas is not converting' })
  assert.equal(m2.plan.intent, 'market_diagnosis')
  assert.equal(m2.plan.variant?.delegated, undefined)
  const s3 = await org()
  const { mission: m3 } = await relay(s3, { self: null })
  assert.equal(m3.plan.variant?.delegated, undefined, 'no assign_to_self: the normal triage')
})

test('the delegated step: its outputs reach the report and the COO message honestly (the agent\'s recommendation, labelled as the agent\'s); run internally it is an honest unknown', async () => {
  const plan = buildPlan({ intent: 'opportunity_triage', interpretation: { count: 10, markets: ['Dallas (TEST)'] }, delegate: { employee_id: 'emp_scout', role: 'acquisition_agent', display_name: 'Scout' } })
  const { steps } = expandDelegate(plan, { candidates: [candidate(1), candidate(2), candidate(3)] })
  assert.deepEqual(steps.map((s) => [s.step, s.assignee_employee_id ?? null, s.depends_on]), [['research', 'emp_scout', ['opps']], ['memory', null, ['research']]])
  const mission = { mission_id: 'wfm_x', plan: { ...plan, steps: [...plan.steps, ...steps] } }
  const a = (o) => ({ assignment_id: `wfa_${o.step_key}`, mission_id: 'wfm_x', depends_on: [], input: {}, output: {}, evidence: [], ...o })
  const assignments = [
    a({ step_key: 'opps', capability_key: 'intel.active_opportunities', assignee_employee_id: 'emp_head_acquisitions', status: 'completed', outcome_class: 'verified', output: { scanned: 24, eligible: 21, candidates: [candidate(1)] } }),
    a({ step_key: 'research', capability_key: 'research.property', assignee_employee_id: 'emp_scout', execution_mode: 'external', status: 'completed', outcome_class: 'verified', input: steps[0].input,
      output: { summary: 'Researched 3 candidates.', findings: ['SYNDAL-001: ask under the investor ceiling', 'SYNDAL-002: thin comps'], recommendation: 'Prioritise SYNDAL-001, then SYNDAL-003.' },
      evidence: [{ type: 'job', id: 'mjob_1', resolved: true }, { type: 'thread', id: uuid(101), resolved: true }, { type: 'property', id: 'SYNDAL-001', resolved: false }] }),
    a({ step_key: 'memory', capability_key: 'memory.assert', assignee_employee_id: 'emp_coo', status: 'completed', outcome_class: 'verified', output: { asserted: true, fact_id: 'f1' } }),
  ]
  const report = buildMissionReport({ mission, assignments, now: T0, employees: [{ employee_id: 'emp_scout', display_name: 'Scout', status: 'active' }] })
  assert.equal(report.delegated.status, 'completed')
  assert.equal(report.delegated.recommendation, 'Prioritise SYNDAL-001, then SYNDAL-003.')
  assert.deepEqual([report.delegated.findings, report.delegated.evidence_resolved, report.delegated.evidence_total, report.delegated.candidates], [2, 2, 3, 3])
  const msg = reportMessage({ mission, report }).content
  assert.match(msg, /Scout \(Agntei\) researched 3 candidates and reported 2 findings \(outcome verified; 2 of 3 evidence refs resolved by LeadCommand\)/)
  assert.match(msg, /Recommendation \(the agent's, not verified by me\): Prioritise SYNDAL-001/)
  assert.doesNotMatch(msg, /No opportunity was ranked/)
  const open = buildMissionReport({ mission, assignments: assignments.map((x) => (x.step_key === 'research' ? { ...x, status: 'ready', outcome_class: null } : x)), now: T0, employees: [] })
  assert.match(reportMessage({ mission, report: open }).content, /emp_scout \(Agntei\) has not finished the research \(ready\)/)
  assert.deepEqual(summaryOf(assignments[1].output), { recommendation: 'Prioritise SYNDAL-001, then SYNDAL-003.', findings: 2 })
  const internal = await researchProperty.run({ missionAssignments: [] }, steps[0].input)
  assert.deepEqual([internal.outcome_class, internal.output.skipped], ['unknown', 'delegated_review_is_agent_work'])
})

test('authority: an employee whose market is a multi-word slug (dallas_test, dallas_tx) acts in its own market (the live milestone\'s MARKET_OUT_OF_SCOPE)', async () => {
  const { authorize } = await import('../../src/lib/workforce/authority/engine.js')
  const { marketLabel, sameMarket } = await import('../../src/lib/workforce/capabilities/shared.js')
  assert.equal(marketLabel('dallas_test'), 'dallas test')
  assert.ok(sameMarket(marketLabel('dallas_test'), 'Dallas (TEST)'))
  const env = { WORKFORCE_ENABLED: '1' }
  for (const [mine, theirs] of [['dallas_test', 'dallas test'], ['dallas_test', 'Dallas (TEST)'], ['dallas_tx', 'Dallas, TX'], ['saint_paul', 'Saint Paul']]) {
    const v = authorize({ employee: { employee_id: 'emp_x', role_key: 'acquisition_agent', kind: 'ai', status: 'active', markets: [mine], tier_ceiling: 'T1' }, capability: 'intel.conversation_state', resource: { market: theirs }, context: { env } })
    assert.equal(v.decision, 'allow', `${mine} ↔ ${theirs}: ${v.reasons}`)
  }
  const out = authorize({ employee: { employee_id: 'emp_x', role_key: 'acquisition_agent', kind: 'ai', status: 'active', markets: ['dallas_test'], tier_ceiling: 'T1' }, capability: 'intel.conversation_state', resource: { market: 'Minneapolis (TEST)' }, context: { env } })
  assert.deepEqual([out.decision, out.reasons[0]], ['deny', 'MARKET_OUT_OF_SCOPE'], 'another market is still refused')
})
