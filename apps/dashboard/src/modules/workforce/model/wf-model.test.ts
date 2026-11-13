import { describe, expect, it } from 'vitest'
import { normalizeAssignment, normalizeEmployee, normalizeReport } from '../api/wf-normalize'
import type { WfAssignment, WfEmployee, WfMemoryFact, WfReportEntry } from '../api/wf-types'
import {
  buildOrgTree, composerRefusal, costRollup, evSummary, heartbeatOf, isRecovery, kpiDisplay, latestTriage, linkedDirective, planDag, progressOf,
  reconcileReport, relTime, resourceRef, splitMemory, verdictCounts, waitingReason,
} from './wf-model'
import { dedupeRefs, refText, refToObject } from './wf-refs'

const E = (o: Record<string, unknown>): WfEmployee => normalizeEmployee({ kind: 'ai', status: 'active', ...o })!
const A = (o: Record<string, unknown>): WfAssignment => normalizeAssignment({ mission_id: 'wfm_1', capability_key: 'intel.conversation_state', ...o })!

describe('org tree', () => {
  const emps = [
    E({ employee_id: 'emp_ceo', kind: 'human', role_key: 'ceo', department_key: 'executive', display_name: 'Owner' }),
    E({ employee_id: 'emp_coo', role_key: 'coo', department_key: 'executive', display_name: 'Atlas', manager_employee_id: 'emp_ceo', open_assignments: 1 }),
    E({ employee_id: 'emp_cfo', role_key: 'cfo', department_key: 'finance', display_name: 'Ledger' }),
    E({ employee_id: 'emp_acq1', role_key: 'acquisition_agent', department_key: 'acquisitions', display_name: 'Mesa', employee_code: 'ACQ-01', open_assignments: 4 }),
    E({ employee_id: 'emp_old', role_key: 'acquisition_agent', department_key: 'acquisitions', display_name: 'Old', status: 'retired', open_assignments: 9 }),
    E({ employee_id: 'emp_x', role_key: 'human_staff', department_key: 'legal', display_name: 'Counsel', kind: 'human' }),
  ]
  const tree = buildOrgTree(emps)
  it('every known department is listed in order; an unknown department is kept last', () => {
    expect(tree.map((d) => d.key)).toEqual(['executive', 'finance', 'acquisitions', 'marketing', 'dispositions', 'data_intelligence', 'operations', 'legal'])
  })
  it('heads come from the head role; a department without one has a vacancy (null), never a guess', () => {
    expect(tree[0].head?.employee_id).toBe('emp_ceo')
    expect(tree[0].members.map((e) => e.employee_id)).toEqual(['emp_coo'])
    expect(tree[1].head?.employee_id).toBe('emp_cfo')
    const acq = tree.find((d) => d.key === 'acquisitions')!
    expect(acq.head).toBeNull()
    expect(acq.members.map((e) => e.display_name)).toEqual(['Mesa'])
  })
  it('retired employees leave the chart and their counts; unknown counts stay unknown', () => {
    const acq = tree.find((d) => d.key === 'acquisitions')!
    expect(acq.open).toBe(4)
    expect(tree.find((d) => d.key === 'marketing')!.open).toBeNull()
    expect(tree[0].human).toBe(1)
    expect(tree[0].ai).toBe(1)
  })
  it('a summary head_employee_id wins over the role', () => {
    const t = buildOrgTree(emps, [{ department_key: 'acquisitions', head_employee_id: 'emp_acq1', employee_count: 1, open_assignments: 7 }])
    const acq = t.find((d) => d.key === 'acquisitions')!
    expect(acq.head?.employee_id).toBe('emp_acq1')
    expect(acq.open).toBe(7)
  })
})

describe('heartbeat', () => {
  const now = Date.parse('2026-10-21T12:00:00Z')
  it('live ≤ 3 min, delayed ≤ 30 min, silent beyond, never without one', () => {
    expect(heartbeatOf({ heartbeat_at: '2026-10-21T11:58:00Z' }, now)).toBe('live')
    expect(heartbeatOf({ heartbeat_at: '2026-10-21T11:40:00Z' }, now)).toBe('stale')
    expect(heartbeatOf({ heartbeat_at: '2026-10-21T10:00:00Z' }, now)).toBe('silent')
    expect(heartbeatOf({ heartbeat_at: null }, now)).toBe('never')
  })
})

describe('progress', () => {
  it('only completed counts as done; cancelled leaves the denominator; planning is null, never 0%', () => {
    expect(progressOf([]).pct).toBeNull()
    expect(progressOf(null).total).toBe(0)
    const p = progressOf([A({ assignment_id: 'a', status: 'completed' }), A({ assignment_id: 'b', status: 'running' }), A({ assignment_id: 'c', status: 'waiting_job' }), A({ assignment_id: 'd', status: 'cancelled' }), A({ assignment_id: 'e', status: 'blocked' })])
    expect(p).toMatchObject({ total: 5, done: 1, active: 1, waiting: 1, blocked: 1, cancelled: 1, pct: 25 })
  })
  it('reads list-row counts the same way', () => {
    expect(progressOf({ completed: 3, ready: 1 })).toMatchObject({ done: 3, queued: 1, pct: 75 })
  })
})

describe('why an assignment is not moving', () => {
  it('names the job, the approval, the block, the dependency and the retry', () => {
    expect(waitingReason(A({ assignment_id: 'a', status: 'waiting_job', runtime_job_id: 'mjob_1' }))).toBe('Waiting on runtime job mjob_1')
    expect(waitingReason(A({ assignment_id: 'a', status: 'waiting_approval', blocked_reason: 'Price at threshold' }))).toBe('Price at threshold')
    expect(waitingReason(A({ assignment_id: 'a', status: 'blocked', last_error: { message: 'stale comps' } }))).toBe('stale comps')
    expect(waitingReason(A({ assignment_id: 'a', status: 'blocked' }))).toMatch(/no reason recorded/)
    expect(waitingReason(A({ assignment_id: 'a', status: 'pending', depends_on: ['rank'] }))).toBe('Waiting on rank')
    expect(waitingReason(A({ assignment_id: 'a', status: 'ready', attempt: 2, max_attempts: 3 }))).toBe('Retry 2 of 3')
    expect(waitingReason(A({ assignment_id: 'a', status: 'running' }))).toBeNull()
  })
  it('a recovery is a second attempt that has not run out', () => {
    expect(isRecovery(A({ assignment_id: 'a', status: 'ready', attempt: 2, max_attempts: 3 }))).toBe(true)
    expect(isRecovery(A({ assignment_id: 'a', status: 'failed', attempt: 3, max_attempts: 3 }))).toBe(false)
    expect(isRecovery(A({ assignment_id: 'a', status: 'completed', attempt: 1 }))).toBe(false)
  })
  it('the resource becomes a record ref with its label', () => {
    expect(resourceRef(A({ assignment_id: 'a', resource_type: 'property', resource_key: 'pid_jh', resource_label: '1 Main St' }))).toEqual({ type: 'property', id: '31', label: '1 Main St' })
    expect(resourceRef(A({ assignment_id: 'a', resource_type: 'campaign', resource_key: 'c1' }))).toBeNull()
  })
})

describe('plan DAG', () => {
  const plan = { steps: [
    { step_key: 'a', capability_key: 'intel.active_opportunities', label: null, assignee_role: null, assignee_employee_id: null, depends_on: [], fan_out: false, unavailable_reason: null },
    { step_key: 'b', capability_key: 'intel.conversation_state', label: null, assignee_role: null, assignee_employee_id: null, depends_on: ['a'], fan_out: true, unavailable_reason: null },
    { step_key: 'c', capability_key: 'campaign.analyze', label: null, assignee_role: null, assignee_employee_id: null, depends_on: ['a'], fan_out: false, unavailable_reason: 'Phase B' },
    { step_key: 'd', capability_key: 'acq.rank_opportunities', label: null, assignee_role: null, assignee_employee_id: null, depends_on: ['b', 'c', 'ghost'], fan_out: false, unavailable_reason: null },
  ] }
  it('layers by longest dependency path; fan-out assignments join their step; unavailable steps say so', () => {
    const layers = planDag(plan, [A({ assignment_id: '1', step_key: 'a', status: 'completed' }), A({ assignment_id: '2', step_key: 'b.1', status: 'completed' }), A({ assignment_id: '3', step_key: 'b.2', status: 'running' })])
    expect(layers.map((l) => l.map((n) => n.step.step_key))).toEqual([['a'], ['b', 'c'], ['d']])
    expect(layers[0][0].state).toBe('done')
    expect(layers[1][0].state).toBe('active')
    expect(layers[1][0].progress.total).toBe(2)
    expect(layers[1][1].state).toBe('unavailable')
    expect(layers[2][0].state).toBe('idle')
  })
  it('a cycle never loops', () => {
    const cyc = { steps: [{ ...plan.steps[0], step_key: 'x', depends_on: ['y'] }, { ...plan.steps[0], step_key: 'y', depends_on: ['x'] }] }
    expect(planDag(cyc, []).flat()).toHaveLength(2)
  })
  it('no plan is no layers', () => { expect(planDag(null, [])).toEqual([]) })
})

describe('report honesty', () => {
  const report = normalizeReport({
    completed: [{ label: 'ranked', assignment_id: 'wfa_r' }, { label: 'read', assignment_id: 'wfa_ok' }],
    ranked: [
      { rank: 1, components: { ev_usd: 100 }, cfo_verdict: 'supported' },
      { rank: 2, components: { ev_usd: null }, cfo_verdict: 'challenge' },
      { rank: 3, components: {}, cfo_verdict: null },
    ],
  })!
  it('a "completed" item whose assignment is not completed moves to pending, flagged', () => {
    const { report: r, contradictions } = reconcileReport(report, [A({ assignment_id: 'wfa_r', status: 'running' }), A({ assignment_id: 'wfa_ok', status: 'completed' })])
    expect(r.completed.map((i) => i.label)).toEqual(['read'])
    expect(r.pending.map((i) => i.label)).toEqual(['ranked'])
    expect(contradictions).toHaveLength(1)
  })
  it('without assignments to compare, nothing moves', () => {
    expect(reconcileReport(report, []).contradictions).toEqual([])
  })
  it('verdicts and EV count unknowns as unknown', () => {
    expect(verdictCounts(report.ranked)).toEqual({ supported: 1, challenge: 1, insufficient_evidence: 0, none: 1 })
    expect(evSummary(report.ranked)).toEqual({ known: 1, total: 3, sum: 100 })
    expect(evSummary([]).sum).toBeNull()
  })
})

describe('finance and intelligence', () => {
  const rep = (id: string, costs: unknown, at: string, ranked: unknown[] = []): WfReportEntry => ({ mission_id: id, title: id, status: 'completed', completed_at: at, report: normalizeReport({ costs, ranked }) })
  it('the cost total exists only when every report has a known cost', () => {
    const all = costRollup([rep('a', { total_usd: 1.5, status: 'known' }, '2026-10-20'), rep('b', { total_usd: 0.5 }, '2026-10-21')])
    expect(all.total_usd).toBe(2)
    const some = costRollup([rep('a', { total_usd: 1.5, status: 'known' }, '2026-10-20'), rep('b', { status: 'unknown', reason: 'ledger' }, '2026-10-21'), { mission_id: 'c', title: 'c', status: 'active', completed_at: null, report: null }])
    expect(some.total_usd).toBeNull()
    expect(some).toMatchObject({ known: 1, unknown: 2 })
    expect(some.missions.find((m) => m.mission_id === 'b')?.reason).toBe('ledger')
    expect(some.missions.find((m) => m.mission_id === 'c')?.reason).toBe('No report yet')
    expect(costRollup([]).total_usd).toBeNull()
  })
  it('latest triage = the newest report with a ranked list from the triage playbook', () => {
    const r1 = rep('old', null, '2026-10-19T00:00:00Z', [{ rank: 1 }])
    const r2 = rep('new', null, '2026-10-21T00:00:00Z', [{ rank: 1 }])
    const r3 = rep('status', null, '2026-10-22T00:00:00Z', [])
    expect(latestTriage([r1, r2, r3])?.mission_id).toBe('new')
    const missions = [{ mission_id: 'old', playbook_key: 'opportunity_triage', objective: null }] as never
    expect(latestTriage([r1, r2], missions)?.mission_id).toBe('old')
  })
})

describe('memory, KPIs, linked context, composer', () => {
  const f = (o: Partial<WfMemoryFact>): WfMemoryFact => ({ fact_id: Math.random().toString(36), scope: 'company', scope_key: null, fact_key: 'k', value: 'v', epistemic: 'verified', confidence: null, source_refs: [], author_employee_id: null, author_user_id: null, valid_from: null, superseded_at: null, ...o })
  it('verified needs a source ref; superseded facts are not live', () => {
    const m = splitMemory([f({ source_refs: [{ type: 'job', id: 'mjob_1', label: null }] }), f({}), f({ epistemic: 'interpretation' }), f({ epistemic: 'ceo_policy' }), f({ superseded_at: '2026-10-01' })])
    expect(m.verified).toHaveLength(1)
    expect(m.interpretation).toHaveLength(2)
    expect(m.policy).toHaveLength(1)
  })
  it('an unknown KPI renders Unknown with its reason; known values are formatted by kind', () => {
    expect(kpiDisplay({ subject_type: 'org', subject_key: 'org', kpi_key: 'offers_prepared', window: '7d', value: null, status: 'unknown', reason: 'no ledger', computed_at: null })).toEqual({ value: 'Unknown', unknown: true, reason: 'no ledger' })
    expect(kpiDisplay({ subject_type: 'org', subject_key: 'org', kpi_key: 'assignment_success_rate', window: '7d', value: 0.94, status: 'known', reason: null, computed_at: null }).value).toBe('94%')
    expect(kpiDisplay({ subject_type: 'org', subject_key: 'org', kpi_key: 'spend_usd', window: '7d', value: 1.84, status: 'known', reason: null, computed_at: null }).value).toBe('$1.84')
  })
  it('the linked property becomes a directive about it; nothing linked, nothing to ask', () => {
    expect(linkedDirective({ propertyId: '9', threadKey: null, opportunityId: null, address: '2207 Bluebonnet Trl' })).toMatch(/^Review 2207 Bluebonnet Trl:/)
    expect(linkedDirective({ propertyId: null, threadKey: null, opportunityId: null, address: null })).toBeNull()
  })
  it('the composer refuses phone numbers and emails before they reach the server', () => {
    expect(composerRefusal('call 214-555-0123')).toMatch(/Phone numbers/)
    expect(composerRefusal('mail a@b.co')).toMatch(/Email/)
    expect(composerRefusal('Review 2207 Bluebonnet Trl')).toBeNull()
  })
  it('relative time', () => {
    const now = Date.parse('2026-10-21T12:00:00Z')
    expect(relTime('2026-10-21T11:59:50Z', now)).toBe('just now')
    expect(relTime(null, now)).toBeNull()
    expect(relTime('2026-10-21T11:00:00Z', now)).toMatch(/hr|hour/)
  })
})

describe('record refs → the split-screen objects', () => {
  it('property → Deal Intelligence object, thread → seller (Inbox), opportunity → deal (Pipeline); internal refs are not objects', () => {
    expect(refToObject({ type: 'property', id: '9100037', label: '2207 Bluebonnet Trl', thread_key: 't1' })).toMatchObject({ type: 'property', id: '9100037', label: '2207 Bluebonnet Trl' })
    expect(refToObject({ type: 'thread', id: '+15550101011', label: null, property_id: '9' })?.type).toBe('seller')
    expect(refToObject({ type: 'opportunity', id: 'o1', label: null })?.type).toBe('deal')
    expect(refToObject({ type: 'job', id: 'mjob_1', label: null })).toBeNull()
    expect(refToObject({ type: 'mission', id: 'wfm_1', label: null })).toBeNull()
  })
  it('chips never print a thread key; refs dedupe, property first', () => {
    expect(refText({ type: 'thread', id: '+15550101011', label: null })).toBe('Seller conversation')
    const list = dedupeRefs([{ type: 'thread', id: 't', label: null }, { type: 'property', id: 'p', label: null }, { type: 'property', id: 'p', label: 'dup' }])
    expect(list.map((r) => r.type)).toEqual(['property', 'thread'])
  })
})
