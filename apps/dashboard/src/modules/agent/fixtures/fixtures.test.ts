import { describe, expect, it } from 'vitest'
import { EVENT_TYPES, LABELLED_EVENT_TYPES, OPERATION_LABEL_TEMPLATES, SANITIZE_FORBIDDEN_KEYS, findingViolations, type Finding } from '../contracts/contracts'
import { applyControls, materialize, type FixtureControl } from './fixture-kit'
import { getScenario, SCENARIO_IDS } from './index'
import { ALL_SOURCES } from './sources'

const templateRegex = (op: string) => {
  const t = (OPERATION_LABEL_TEMPLATES as Record<string, string>)[op]
  return new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\w+\\\}/g, '.+')}$`)
}
const deepKeys = (v: unknown, out: string[] = []): string[] => {
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); deepKeys(x, out) }
  return out
}

const CONTROL_SETS: Record<string, FixtureControl[]> = {
  none: [],
  confirmed: [{ kind: 'confirm', t: 400 }],
  paused: [{ kind: 'confirm', t: 400 }, { kind: 'pause', t: 5200 }, { kind: 'resume', t: 9000 }],
  cancelled: [{ kind: 'confirm', t: 400 }, { kind: 'cancel', t: 5600 }],
  answered: [{ kind: 'confirm', t: 300 }, { kind: 'answer', t: 7000, task_id: 'fx-t-d-parcel', option: '043512-0000 · main house · 1,410 sqft' }],
  plan: [{ kind: 'approve_plan', t: 4200, artifact_id: 'fx-plan-1' }],
}

describe('fixture scenarios honour the S1 event contract', () => {
  for (const id of SCENARIO_IDS) {
    for (const [name, controls] of Object.entries(CONTROL_SETS)) {
      it(`${id} · ${name}`, () => {
        const events = materialize(applyControls(getScenario(id), controls), 'run-x', Date.parse('2026-10-08T12:00:00Z'), 1000)
        expect(events.length).toBeGreaterThan(0)
        events.forEach((e, i) => {
          // gapless seq, monotonic event ids, every event labelled as fixture
          expect(e.seq).toBe(i + 1)
          expect(e.event_id).toBe(1000 + i + 1)
          expect(e.fixture).toBe(true)
          expect((EVENT_TYPES as readonly string[]).includes(e.type)).toBe(true)
          // labels map 1:1 to registered operation templates
          if ((LABELLED_EVENT_TYPES as readonly string[]).includes(e.type)) {
            const op = String(e.payload.operation)
            expect(Object.keys(OPERATION_LABEL_TEMPLATES)).toContain(op)
            expect(String(e.payload.label)).toMatch(templateRegex(op))
          }
          // sanitizer: no forbidden keys anywhere in a payload
          for (const k of deepKeys(e.payload)) expect((SANITIZE_FORBIDDEN_KEYS as readonly string[]).includes(k)).toBe(false)
          if (e.type === 'decision') expect(String(e.payload.summary).length).toBeLessThanOrEqual(240)
          // evidence invariants — blocked/unavailable carry no value and are never absence
          if (e.type === 'finding.upserted') {
            const f = e.payload.finding as Finding
            const src = ALL_SOURCES.find((s) => s.source_id === f.source_id)
            expect(findingViolations(f, { supports_negative: src?.supports_negative, query_succeeded: true })).toEqual([])
            if (f.evidence_status === 'blocked' || f.evidence_status === 'unavailable') expect(f.value).toBeNull()
          }
        })
        // offsets never decrease
        for (let i = 1; i < events.length; i += 1) expect(events[i].fixture_t_ms!).toBeGreaterThanOrEqual(events[i - 1].fixture_t_ms!)
      })
    }
  }

  it('fixture sources are all test data on non-resolvable hosts', () => {
    for (const s of ALL_SOURCES) { expect(s.test_data).toBe(true); expect(s.host.endsWith('.sim')).toBe(true) }
  })

  it('a research job holds at the scope gate until the operator confirms', () => {
    const s = getScenario('single-deep')
    const held = applyControls(s, [])
    expect(held.every((e) => e.t <= (s.confirm_gate ?? 0))).toBe(true)
    expect(held.some((e) => e.type === 'job.confirmed')).toBe(false)
    const go = applyControls(s, [{ kind: 'confirm', t: 2000 }])
    expect(go.find((e) => e.type === 'job.confirmed')!.t).toBe(150 + 1900)
  })

  it('cancel: no event after job.cancelled, queued tasks cancelled, nothing invented after the cut', () => {
    const s = getScenario('single-deep')
    const log = applyControls(s, [{ kind: 'confirm', t: 100 }, { kind: 'cancel', t: 4000 }])
    const types = log.map((e) => e.type)
    expect(types[types.length - 1]).toBe('job.cancelled')
    expect(types).toContain('job.cancel_requested')
    expect(types.indexOf('job.cancel_requested')).toBeLessThan(types.indexOf('job.cancelled'))
    expect(types.filter((t) => t === 'brief.section')).toHaveLength(0)
    expect(types.filter((t) => t === 'task.cancelled').length).toBeGreaterThan(0)
  })

  it('pause: running tasks finish, nothing new starts until resume', () => {
    const s = getScenario('single-deep')
    const log = applyControls(s, [{ kind: 'confirm', t: 100 }, { kind: 'pause', t: 3200 }])
    const pausedAt = log.find((e) => e.type === 'job.paused')!.t
    const startsAfter = log.filter((e) => e.type === 'task.started' && e.t > pausedAt)
    expect(startsAfter).toHaveLength(0)
    // the tax + code tasks were running at 3200 and still complete
    expect(log.some((e) => e.type === 'task.completed' && e.task_id === 'fx-t-tax')).toBe(true)
  })

  it('answering needs_input swaps the authored variants', () => {
    const s = getScenario('blocked-conflict')
    const un = applyControls(s, [{ kind: 'confirm', t: 100 }])
    const an = applyControls(s, CONTROL_SETS.answered)
    const done = (log: typeof un) => log.find((e) => e.type === 'job.completed')!.payload.summary as string
    expect(done(un)).toMatch(/awaiting your input/)
    expect(done(an)).not.toMatch(/awaiting/)
    expect(an.some((e) => e.type === 'finding.upserted' && (e.payload.finding as Finding).finding_id === 'fx-f-d-own')).toBe(true)
  })

  it('batch is 25 synthetic properties with concurrency ≤ 2', () => {
    const log = applyControls(getScenario('batch-25'), [{ kind: 'confirm', t: 100 }])
    const props = new Set(log.filter((e) => e.type === 'job.property_state').map((e) => e.property_id))
    expect(props.size).toBe(25)
    let running = 0; let max = 0
    for (const e of log) {
      if (e.type !== 'job.property_state') continue
      if (e.payload.state === 'running' && e.payload.phase === 'researching') { running += 1; max = Math.max(max, running) }
      if (['completed', 'completed_partial'].includes(String(e.payload.state))) running -= 1
    }
    expect(max).toBeLessThanOrEqual(2)
  })
})
