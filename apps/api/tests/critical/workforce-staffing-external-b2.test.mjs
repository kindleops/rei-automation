// B2 (2026-10-25) — an EXTERNAL (Agntei) employee is staffed ONLY for capabilities it can execute through the Action
// Gateway (research.property ← workforce_request_research). The engine-computed intelligence / judgment steps (opps,
// conv, dec, rank, next …) go to internal staff: completed by an external agent they could only carry free text, and
// 'opps' then expanded to ZERO candidates (a silently empty triage; found by the Sterling certification, run 5).
import test from 'node:test'
import assert from 'node:assert/strict'
import { pickAssignee, createStaffer, EXTERNALLY_EXECUTABLE, externalMayTake } from '../../src/lib/workforce/coo/staffing.js'

const emp = (employee_id, role_key, o = {}) => ({ employee_id, role_key, status: 'active', markets: [], origin: 'workforce', employment_type: 'autonomous_ai', ...o })
const roster = [
  emp('emp_head_acquisitions', 'head_acquisitions'),
  emp('emp_sterling', 'acquisition_agent', { markets: ['Dallas'], origin: 'agntei', employment_type: 'operator_ai' }),
  emp('emp_acq_internal', 'acquisition_agent', { markets: ['Dallas'] }),
  emp('emp_head_data', 'head_data_intelligence'),
  emp('emp_scout_ext', 'research_analyst', { origin: 'agntei', employment_type: 'operator_ai' }),
]

test('B2: the externally executable set is exactly research.property', () => {
  assert.deepEqual([...EXTERNALLY_EXECUTABLE], ['research.property'])
  assert.equal(externalMayTake(roster[1], 'intel.active_opportunities'), false)
  assert.equal(externalMayTake(roster[1], 'research.property'), true)
  assert.equal(externalMayTake(roster[2], 'intel.active_opportunities'), true, 'internal employees are unaffected')
})

test('B2: an external acquisition agent is never staffed an engine-computed step, even in its own market; an internal one is', () => {
  for (const capability of ['intel.conversation_state', 'intel.acquisition_decision', 'acq.next_action']) {
    const e = pickAssignee({ role: 'acquisition_agent', market: 'Dallas', employees: roster, capability })
    assert.equal(e?.employee_id, 'emp_acq_internal', capability)
  }
  // with NO internal acquisition agent the step falls back to the department head, never to the external agent
  const noInternal = roster.filter((e) => e.employee_id !== 'emp_acq_internal')
  assert.equal(pickAssignee({ role: 'acquisition_agent', market: 'Dallas', employees: noInternal, capability: 'intel.conversation_state' })?.employee_id, 'emp_head_acquisitions')
})

test('B2: an external research analyst IS staffed research.property (the one externally executable capability)', () => {
  const staff = createStaffer({ employees: roster.filter((e) => e.role_key !== 'acquisition_agent'), assignments: [] })
  assert.equal(staff('research_analyst', { capability: 'research.property' })?.employee_id, 'emp_scout_ext')
})

test('B2: without a capability (legacy callers) staffing is unchanged', () => {
  assert.ok(['emp_sterling', 'emp_acq_internal'].includes(pickAssignee({ role: 'acquisition_agent', market: 'Dallas', employees: roster })?.employee_id))
})
