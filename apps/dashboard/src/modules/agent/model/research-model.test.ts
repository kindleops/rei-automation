import { describe, expect, it } from 'vitest'
import { applyControls, materialize } from '../fixtures/fixture-kit'
import { getScenario } from '../fixtures'
import { batchCounters, progressOf, reduceResearch, timelineState } from './research-model'
import { reduceRun } from './run-model'

const START = Date.parse('2026-10-08T12:00:00Z')
const events = (id: Parameters<typeof getScenario>[0], controls: Parameters<typeof applyControls>[1] = [{ kind: 'confirm', t: 100 }]) =>
  materialize(applyControls(getScenario(id), controls), 'r1', START, 0)
const until = (id: Parameters<typeof getScenario>[0], t: number, controls?: Parameters<typeof applyControls>[1]) => events(id, controls).filter((e) => (e.fixture_t_ms ?? 0) <= t)

describe('research reducer', () => {
  it('waits in draft at the scope gate', () => {
    const v = reduceResearch('r1', events('single-deep', []))
    expect(v.state).toBe('draft')
    expect(v.scope_sentence).toBeNull()
    expect(v.estimate?.basis).toBe('worst_case')
    expect(v.cap_usd).toBe(0.75)
  })

  it('status line = the latest task.started without a terminal event; progress is done/planned', () => {
    const v = reduceResearch('r1', until('single-deep', 3400))
    expect(v.phase).toBe('researching')
    expect(v.current?.label).toMatch(/Checking Cuyahoga County code violations|Checking Cuyahoga County tax delinquency/)
    const p = progressOf(v)
    expect(p.planned).toBeGreaterThan(5)
    expect(p.running).toBe(2)
    expect(p.fraction).toBeGreaterThan(0)
    expect(p.fraction).toBeLessThan(1)
    expect(v.skipped_fresh).toHaveLength(1)
  })

  it('nothing is running → no status label (no invented activity)', () => {
    const v = reduceResearch('r1', until('single-deep', 99999))
    expect(v.current).toBeNull()
    expect(v.state).toBe('completed')
    expect(progressOf(v).fraction).toBe(1)
  })

  it('discoveries, unavailable sources and contradicted assumptions are reduced from events', () => {
    const v = reduceResearch('r1', until('single-deep', 99999))
    expect(v.findings['fx-f-tax'].is_discovery).toBe(true)
    expect(v.findings['fx-f-list'].evidence_status).toBe('unavailable')
    expect(v.findings['fx-f-list'].value).toBeNull()
    expect(v.findings['fx-f-occ'].contradicted_by).toBe('fx-f-own')
    expect(v.findings['fx-f-occ'].history.length).toBe(2)
    expect(v.conflicts['fx-cg-occ'].resolution_state).toBe('resolved_by_rule')
    const pv = v.properties['fx-prop-1418']
    expect(Object.keys(pv.sections)).toHaveLength(9)
    expect(pv.brief_completed?.opportunity_class).toBe('strong')
    // cost comes from settle rows, never the estimate
    expect(v.accrued_usd).toBeCloseTo(0.031)
  })

  it('blocked source: blocked status, alternatives kept, conflict opens then resolves', () => {
    const mid = reduceResearch('r1', until('blocked-conflict', 6000))
    const src = mid.sources.find((s) => s.source_id === 'fx-duval-tax')!
    expect(src.status).toBe('blocked')
    expect(src.reason).toBe('http_403')
    expect(src.alternatives.length).toBeGreaterThan(1)
    expect(mid.conflicts['fx-cg-d-tax'].resolution_state).toBe('open')
    expect(mid.tasks.find((t) => t.task_id === 'fx-t-d-parcel')!.state).toBe('needs_input')
    expect(timelineState('needs_input')).toBe('needs_input')
    const end = reduceResearch('r1', until('blocked-conflict', 99999))
    expect(end.conflicts['fx-cg-d-tax'].resolution_state).toBe('resolved_by_rule')
    expect(end.findings['fx-f-d-vtax'].contradicted_by).toBe('fx-f-d-paid')
    expect(end.state).toBe('completed_partial')
  })

  it('cancel is not assumed until job.cancelled arrives', () => {
    const controls = [{ kind: 'confirm' as const, t: 100 }, { kind: 'cancel' as const, t: 4000 }]
    const requested = reduceResearch('r1', until('single-deep', 4002, controls))
    expect(requested.cancel_requested).toBe(true)
    expect(requested.state).not.toBe('cancelled')
    const done = reduceResearch('r1', until('single-deep', 99999, controls))
    expect(done.state).toBe('cancelled')
    expect(done.tasks.some((t) => t.state === 'cancelled')).toBe(true)
  })

  it('batch counters', () => {
    const mid = reduceResearch('r1', until('batch-25', 9000))
    const c = batchCounters(mid)
    expect(c.total).toBe(25)
    expect(c.running).toBeLessThanOrEqual(2)
    expect(c.completed).toBeGreaterThan(0)
    expect(c.queued).toBeGreaterThan(0)
    const end = reduceResearch('r1', until('batch-25', 999999))
    const e = batchCounters(end)
    expect(e.completed).toBe(25)
    expect(e.discoveries).toBe(8) // tax + condemnation on 4 properties
    expect(e.ops_blocked).toBe(3)
    expect(e.ops_failed).toBe(3)
  })

  it('detects a seq gap', () => {
    const ev = until('single-deep', 3000)
    const v = reduceResearch('r1', [...ev.slice(0, 5), ...ev.slice(7)])
    expect(v.gap).toBe(true)
  })
})

describe('run reducer', () => {
  it('streams deltas into one assistant message; tool rows settle; plan + approval cards', () => {
    const mid = reduceRun('c1', until('conversation', 900))
    expect(mid.current).toBe('Reading the property record')
    const v = reduceRun('c1', until('conversation', 99999))
    expect(v.current).toBeNull()
    const assistant = v.items.filter((i) => i.kind === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0].kind === 'assistant' && assistant[0].done).toBe(true)
    expect(v.items.filter((i) => i.kind === 'tool').every((i) => i.kind === 'tool' && i.state === 'completed')).toBe(true)
    const plan = v.items.find((i) => i.kind === 'plan')
    expect(plan && plan.kind === 'plan' && plan.state).toBe('proposed')
    const appr = v.items.find((i) => i.kind === 'approval')
    expect(appr && appr.kind === 'approval' && appr.approval.brake).toMatch(/paused/)
    expect(appr && appr.kind === 'approval' && appr.approval.identity_available).toBe(false)
    expect(v.state).toBe('awaiting_plan_approval')
  })

  it('approving the plan emits ui.intent for the child research run', () => {
    const v = reduceRun('c1', until('conversation', 99999, [{ kind: 'approve_plan', t: 6000, artifact_id: 'fx-plan-1' }]))
    const plan = v.items.find((i) => i.kind === 'plan')
    expect(plan && plan.kind === 'plan' && plan.state).toBe('approved')
    expect(v.items.some((i) => i.kind === 'intent')).toBe(true)
    expect(v.state).toBe('waiting_tool')
  })
})
