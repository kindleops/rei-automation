import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AskThread, AskTurn } from '../../agent/ask/ask-store'
import { classifyPlane } from '../api/ic-client'
import { DiffCard } from './ActCard'
import { PlaneNotice } from './primitives'
import { RunTurn } from './RunTurn'

const text = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('truthful plane states', () => {
  it('a 404 actions plane renders "Actions plane not enabled" with the switches, never an empty list', () => {
    const f = classifyPlane('actions', 404, null)
    const t = text(<PlaneNotice failure={f} title="Actions plane not enabled" />)
    expect(t).toMatch(/Actions plane not enabled/)
    expect(t).toMatch(/AGENT_CAPABILITIES_ENABLED=1/)
    expect(t).toMatch(/404/)
  })
  it('the missions runtime says exactly what is missing', () => {
    const t = text(<PlaneNotice failure={classifyPlane('runtime', 404, null)} />)
    expect(t).toMatch(/Missions runtime read route not deployed/)
    expect(t).toMatch(/PROPOSED_20261012140000_intel_runtime/)
  })
})

describe('the diff card', () => {
  it('renders before → after and Approve / Reject only while pending', () => {
    const a = { approval_id: 'apr_x', capability_id: 'pipeline.propose_stage_change', capability_version: 1, tier: 'requires_explicit_approval', state: 'pending' as const, provenance: 'model' as const, target: {}, intended_change: { action: 'stage_change', from_stage: 'asking_price', to_stage: 'offer', reason: 'r' }, summary: ['Move opportunity from asking_price → offer'], payload_hash: 'a'.repeat(64), snapshot_hash_prefix: 'abc', expires_at: '2099-01-01T00:00:00Z', created_at: '', decided_at: null, execution_result: null }
    const t = text(<DiffCard approval={a} />)
    expect(t).toMatch(/Stage change/)
    expect(t).toMatch(/− asking_price/)
    expect(t).toMatch(/\+ offer/)
    expect(t).toMatch(/Approve/)
    expect(t).toMatch(/Reject/)
    const done = text(<DiffCard approval={{ ...a, state: 'executed', execution_result: { ok: true } }} />)
    expect(done).not.toMatch(/Approve/)
    expect(done).toMatch(/executed/)
  })
})

describe('a live run renders only what the events say', () => {
  it('shows the running step, the streamed text, cancel, and no answer yet', () => {
    const turn: AskTurn = {
      id: 'turn_1', runId: 'ask_live0001xyz', text: 'Which is strongest?', command: null, chips: [], question: 'Which is strongest?', notes: [], sentAt: 0, phase: 'running', failure: null, run: null,
      events: [
        { seq: 1, type: 'run_start' },
        { seq: 2, type: 'model_call_start', call: 1, model: 'claude-haiku-5-5' },
        { seq: 3, type: 'model_call_end', call: 1, ok: true, stop: 'tool_use', latency_ms: 800 },
        { seq: 4, type: 'tool_start', tool: 'eg.distress_signals' },
      ],
    }
    const thread: AskThread = { id: 't', title: 'x', createdAt: 0, updatedAt: 0, turns: [turn] }
    const t = text(<RunTurn thread={thread} turn={turn} tools={[{ name: 'eg.distress_signals', label: 'Reading distress signals' }]} mode="ask" labelOf={() => null} />)
    expect(t).toMatch(/Reading distress signals/)
    expect(t).toMatch(/Planned the next reads/)
    expect(t).toMatch(/Cancel/)
    expect(t).not.toMatch(/Retry/)
    expect(t).not.toMatch(/Completed/)
  })
})
