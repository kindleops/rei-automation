import { describe, expect, it } from 'vitest'
import type { AskEvent } from '../../agent/ask/ask-model'
import { applyEvent, EMPTY_RUN, reduceRunEvents, statusLine } from './run-reducer'

const TOOLS = [{ name: 'eg.distress_signals', label: 'Reading distress signals' }, { name: 'eg.contact_map', label: 'Reading the contact map' }]
let seq = 0
const ev = (type: AskEvent['type'], data: Record<string, unknown> = {}): AskEvent => ({ seq: ++seq, type, at: `2026-10-14T12:00:${String(seq).padStart(2, '0')}Z`, ...data })

function sequence(): AskEvent[] {
  seq = 0
  return [
    ev('run_start', { mode: 'research' }),
    ev('model_call_start', { call: 1, route: 'default', model: 'claude-haiku-5-5', web_offered: true }),
    ev('model_call_end', { call: 1, model: 'claude-haiku-5-5', ok: true, stop: 'tool_use', latency_ms: 840, cost_usd: 0.0021, input_tokens: 3120, output_tokens: 184 }),
    ev('tool_start', { tool: 'eg.distress_signals', label: 'Reading distress signals' }),
    ev('tool_end', { tool: 'eg.distress_signals', rows: 6, outcome: 'ok', latency_ms: 212 }),
    ev('model_call_start', { call: 2, route: 'default', model: 'claude-haiku-5-5' }),
    ev('tool_start', { call: 2, tool: 'web_search', provider_executed: true }),
    ev('tool_end', { call: 2, tool: 'web_search', provider_executed: true, rows: 5, outcome: 'ok' }),
    ev('web_search', { call: 2, searches: 2, fetches: 0, results: 9, citations: 2 }),
    ev('model_call_end', { call: 2, model: 'claude-haiku-5-5', ok: true, stop: 'tool_use', latency_ms: 2210, cost_usd: 0.0262 }),
    ev('tool_start', { tool: 'eg.contact_map' }),
    ev('tool_end', { tool: 'eg.contact_map', rows: 0, outcome: 'TOOL_TIMEOUT', latency_ms: 30000 }),
    ev('model_call_start', { call: 3, route: 'escalation', model: 'claude-sonnet-5-5' }),
    ev('text_delta', { call: 3, text: 'Property 9100001 ' }),
    ev('text_delta', { call: 3, text: 'is strongest.' }),
  ]
}

describe('run reducer — SSE event sequence → canvas state', () => {
  it('folds a live sequence into steps, streamed text and counters', () => {
    const st = reduceRunEvents(sequence(), TOOLS)
    expect(st.phase).toBe('writing')
    expect(st.draft).toBe('Property 9100001 is strongest.')
    expect(st.modelCalls).toBe(2)
    expect(st.toolCalls).toBe(1) // the timed-out read is not a successful read
    expect(st.webSearches).toBe(2)
    expect(st.costUsd).toBeCloseTo(0.0283, 6)
    expect(st.models).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5'])
    const titles = st.steps.map((s) => `${s.kind}:${s.state}:${s.title}`)
    expect(titles).toEqual([
      'model:ok:Planned the next reads',
      'tool:ok:Reading distress signals',
      'model:ok:Planned the next reads',
      'web:ok:Search the public web',
      'web:ok:Searched the public web · 2 searches',
      'tool:failed:Reading the contact map',
      'model:running:Escalated reasoning',
    ])
    expect(st.steps.find((s) => s.name === 'eg.contact_map')?.detail).toMatch(/not evidence of absence/)
    expect(st.steps.filter((s) => s.publicWeb)).toHaveLength(2)
  })

  it('a step is running only between its own start and end events', () => {
    seq = 0
    const a = reduceRunEvents([ev('run_start'), ev('tool_start', { tool: 'eg.contact_map' })], TOOLS)
    expect(a.steps).toHaveLength(1)
    expect(a.steps[0].state).toBe('running')
    expect(statusLine(a)).toBe('Reading the contact map')
    const b = applyEvent(a, ev('tool_end', { tool: 'eg.contact_map', rows: 3, outcome: 'ok' }), TOOLS)
    expect(b.steps[0].state).toBe('ok')
    expect(b.steps[0].rows).toBe(3)
  })

  it('the terminal event is authoritative and closes anything still open', () => {
    const events = [...sequence(), ev('completed', { state: 'completed', outcome: 'completed', cost_usd: 0.0695, latency_ms: 14300, model_calls: 3, tool_calls: 2, web_searches: 2, answer_md: 'Final answer.' })]
    const st = reduceRunEvents(events, TOOLS)
    expect(st.phase).toBe('completed')
    expect(st.answer).toBe('Final answer.')
    expect(st.costUsd).toBe(0.0695)
    expect(st.latencyMs).toBe(14300)
    expect(st.modelCalls).toBe(3)
    expect(st.steps.some((s) => s.state === 'running')).toBe(false)
    expect(statusLine(st)).toBe('Completed')
  })

  it('cancel and failure are distinct terminal states with their class', () => {
    const c = reduceRunEvents([...sequence(), ev('cancelled', { state: 'cancelled', outcome: 'CANCELLED', refusal_class: 'cancelled' })], TOOLS)
    expect(c.phase).toBe('cancelled')
    expect(c.steps.at(-1)?.outcome).toBe('CANCELLED')
    seq = 0
    const f = reduceRunEvents([ev('run_start'), ev('failed', { state: 'failed', outcome: 'PROVIDER_READ_TIMEOUT', refusal_class: 'timeout' })], TOOLS)
    expect(f.phase).toBe('failed')
    expect(statusLine(f)).toBe('Failed · timeout')
  })

  it('replayed events (reconnect from ?after=) are de-duplicated by seq', () => {
    const s = sequence()
    const once = reduceRunEvents(s, TOOLS)
    const twice = reduceRunEvents([...s.slice(0, 8), ...s], TOOLS)
    expect(twice.steps).toEqual(once.steps)
    expect(twice.draft).toBe(once.draft)
    expect(twice.costUsd).toBe(once.costUsd)
  })

  it('a durable-status terminal (seq 1_000_000) after a snapshot ends the run once', () => {
    const st = reduceRunEvents([
      { seq: 0, type: 'snapshot', state: 'completed', from: 'durable_status' },
      { seq: 1_000_000, type: 'completed', state: 'completed', outcome: 'completed', cost_usd: 0.01, from: 'durable_status', answer_md: 'From the store.' },
      { seq: 1_000_000, type: 'completed', state: 'completed', outcome: 'completed', cost_usd: 99, from: 'durable_status' },
    ], TOOLS)
    expect(st.phase).toBe('completed')
    expect(st.fromDurable).toBe(true)
    expect(st.costUsd).toBe(0.01)
    expect(st.answer).toBe('From the store.')
  })

  it('a new model call starts a new draft; nothing is shown without an event', () => {
    expect(EMPTY_RUN.steps).toEqual([])
    expect(statusLine(EMPTY_RUN)).toBe('Queued')
    seq = 0
    const st = reduceRunEvents([ev('model_call_start', { call: 1 }), ev('text_delta', { call: 1, text: 'draft one' }), ev('model_call_end', { call: 1, ok: true, stop: 'tool_use' }), ev('model_call_start', { call: 2 })], TOOLS)
    expect(st.draft).toBe('')
  })
})
