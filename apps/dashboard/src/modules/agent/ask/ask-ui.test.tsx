import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { budgetMeter, buildTimeline, classifyFailure, type AskStatus } from './ask-model'
import { normalizeRun, normalizeStatus } from './ask-transport'
import type { AskTurn } from './ask-store'
import { AskTurnView, Timeline } from './ui/AskTurnView'
import { BudgetMeterView } from './ui/AskComposer'
import { LockedState } from './ui/AskStates'

const text = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const noop = () => {}
const handlers = { onOpen: noop, onFollowUp: noop, onStop: noop, onResume: noop, onRevealed: noop }

const STATUS: AskStatus = normalizeStatus({ enabled: true, models: { ok: true, default: { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' } }, caps: { day_usd: 10, cycle_usd: 150 }, spend: { day_usd: 1.25, cycle_usd: 4 }, runs_today: 2, daily_run_cap: 40, tools: [{ name: 'eg.distress_signals', label: 'Reading distress signals' }] })

const run = (state: string, extra: Record<string, unknown> = {}) => normalizeRun({
  run_id: 'ask_abcdefgh1234', state, latency_ms: state === 'running' ? null : 8200, cost_usd: 0.0123,
  models: { default: 'claude-haiku-5-5' }, counters: { model_calls: 2, tool_calls: 1 },
  calls: [{ model: 'claude-haiku-5-5', route: 'default' }],
  audit: [{ kind: 'model_call', name: 'claude-haiku-5-5', latency_ms: 700, outcome: 'tool_use' }, { kind: 'tool_call', name: 'eg.distress_signals', rows_returned: 3, latency_ms: 140, outcome: 'ok' }],
  ...extra,
})!

const turn = (patch: Partial<AskTurn>): AskTurn => ({ id: 't1', runId: 'ask_abcdefgh1234', text: 'What distress evidence?', command: 'research', chips: [{ key: 'property:1000001', kind: 'property', id: '1000001', label: '12 Synthetic Ln', detail: null, property_ids: ['1000001'] }], question: 'q', notes: [], sentAt: Date.now() - 4000, phase: 'running', failure: null, run: run('running'), ...patch })

describe('run view', () => {
  it('a running turn shows the live step log (tool name, rows, timing) and Stop', () => {
    const t = text(<AskTurnView turn={turn({})} tools={STATUS.tools} labels={{}} reduced now={Date.now()} handlers={handlers} />)
    expect(t).toContain('Working · 1 read')
    expect(t).toContain('Reading distress signals')
    expect(t).toContain('eg.distress_signals')
    expect(t).toContain('3 rows · 140ms')
    expect(t).toContain('Stop')
    expect(t).toContain('12 Synthetic Ln')
  })
  it('a finished turn collapses the log to a summary and shows answer, evidence, cost, latency, copy, follow-ups', () => {
    const done = run('completed', { outcome: 'completed', answer: { answer_md: 'Summary.\n\n- 1000001 has a recorded tax lien', property_ids: ['1000001'] } })
    const html = renderToStaticMarkup(<AskTurnView turn={turn({ phase: 'done', run: done })} tools={STATUS.tools} labels={{ 1000001: '12 Synthetic Ln' }} reduced now={Date.now()} handlers={handlers} />)
    const t = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    expect(t).toContain('Worked for 8.2s · 1 read · 3 rows')
    expect(t).not.toContain('Reading distress signals') // collapsed
    expect(t).toContain('has a recorded tax lien')
    expect(html).toContain('class="agx-cite"')
    expect(t).toContain('Evidence')
    expect(t).toContain('$0.012')
    expect(t).toContain('Copy')
    expect(t).toContain('Check this property for inconsistencies')
    expect(t).not.toMatch(/Send|Make offer/)
  })
  it('the timeline renders an escalation step', () => {
    const steps = buildTimeline(normalizeRun({ run_id: 'ask_x1234567', state: 'running', audit: [{ kind: 'escalation', name: 'claude-sonnet-5-5', outcome: 'contradiction_analysis' }] }), [])
    expect(text(<Timeline steps={steps} running elapsed={1000} reduced />)).toContain('Escalated to Sonnet 5.5')
  })
  it('a failed send shows the failure class, not a generic error', () => {
    const t = text(<AskTurnView turn={turn({ phase: 'failed', run: null, failure: classifyFailure(429, 'DAILY_RUN_CAP', 'Daily agent run limit (40) reached for this operator.') })} tools={[]} labels={{}} reduced now={Date.now()} handlers={handlers} />)
    expect(t).toContain('Slow down')
    expect(t).toContain('Daily agent run limit (40)')
  })
})

describe('budget meter', () => {
  it('renders spend against the day cap with an accessible meter', () => {
    const html = renderToStaticMarkup(<BudgetMeterView meter={budgetMeter(STATUS)!} />)
    expect(html).toContain('role="meter"')
    expect(html).toContain('$1.25 / $10')
    expect(html).toContain('width:13%')
    expect(html).toContain('is-calm')
  })
})

describe('unauthorized state', () => {
  it('a non-allowlisted user gets a clean "not enabled for your account" state', () => {
    const f = classifyFailure(403, 'NOT_ALLOWLISTED')
    const t = text(<LockedState kind={f.kind} message={f.message} />)
    expect(t).toContain('Not enabled for your account')
    expect(t).toContain('The research agent is not enabled for your account.')
    expect(t).toContain('Check again')
    expect(t).not.toMatch(/fixture|simulated/i)
  })
})
