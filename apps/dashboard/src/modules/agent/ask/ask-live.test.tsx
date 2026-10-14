import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { liveStepsOf, liveViewOf, normalizeResult, type AskEvent, type AskTool } from './ask-model'
import { normalizeRun, parseSseFrames } from './ask-transport'
import type { AskTurn } from './ask-store'
import { AskTurnView } from './ui/AskTurnView'
import { ResultBlocks } from './ui/ResultBlocks'

const text = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const noop = () => {}
const TOOLS: AskTool[] = [{ name: 'eg.property_core', label: 'Property record' }]
let seq = 0
const ev = (type: AskEvent['type'], extra: Record<string, unknown> = {}): AskEvent => ({ seq: ++seq, type, at: '2026-10-13T12:00:00.000Z', ...extra })

describe('live status — from server events only', () => {
  it('maps each real event to its status; no percentages, no invented phases', () => {
    seq = 0
    const evs: AskEvent[] = [ev('run_start')]
    expect(liveViewOf(evs).status).toBe('Started')
    evs.push(ev('model_call_start', { call: 1, model: 'claude-haiku-5-5' }))
    expect(liveViewOf(evs).status).toBe('Model call · Haiku 5.5')
    evs.push(ev('tool_start', { call: 1, tool: 'web_search', provider_executed: true }))
    expect(liveViewOf(evs).status).toBe('Searching web')
    evs.push(ev('web_search', { call: 1, searches: 2 }))
    expect(liveViewOf(evs).status).toBe('Searched web · 2 searches')
    evs.push(ev('model_call_end', { call: 1, ok: true, stop: 'tool_use', model: 'claude-haiku-5-5', latency_ms: 900, cost_usd: 0.021 }))
    evs.push(ev('tool_start', { tool: 'eg.property_core' }))
    expect(liveViewOf(evs, TOOLS).status).toBe('Reading LeadCommand records · Property record')
    evs.push(ev('tool_end', { tool: 'eg.property_core', rows: 1, outcome: 'ok' }))
    evs.push(ev('model_call_start', { call: 2, model: 'claude-haiku-5-5' }))
    evs.push(ev('text_delta', { call: 2, text: 'The home is ' }), ev('text_delta', { call: 2, text: 'listed.' }))
    const v = liveViewOf(evs, TOOLS)
    expect(v.status).toBe('Writing')
    expect(v.draft).toBe('The home is listed.')
    expect(v.reads).toBe(1)
    expect(v.webSearches).toBe(2)
    evs.push(ev('completed', { state: 'completed' }))
    expect(liveViewOf(evs).status).toBe('Completed')
    expect(liveViewOf([ev('failed', { refusal_class: 'budget' })]).status).toBe('Failed: budget')
    expect(liveViewOf([ev('failed', { refusal_class: 'timeout' })]).tone).toBe('bad')
    expect(liveViewOf([ev('cancelled', {})]).status).toBe('Cancelled')
    const steps = liveStepsOf(evs, TOOLS)
    expect(steps.map((s) => s.title)).toEqual(['Planned next reads', 'Property record'])
    expect(JSON.stringify(liveViewOf(evs))).not.toMatch(/%/)
  })

  it('a new model call resets the draft (text before a tool call is not the answer)', () => {
    seq = 0
    const v = liveViewOf([ev('model_call_start', { call: 1 }), ev('text_delta', { call: 1, text: 'Let me check.' }), ev('model_call_start', { call: 2 }), ev('text_delta', { call: 2, text: 'Answer.' })])
    expect(v.draft).toBe('Answer.')
  })

  it('parses SSE frames, skips heartbeats and keeps a partial tail', () => {
    const { events, rest } = parseSseFrames(': hb\n\nid: 1\nevent: run_start\ndata: {"seq":1,"type":"run_start"}\n\nid: 2\nevent: text_delta\ndata: {"seq":2,"type":"text_delta","text":"a"}\n\nid: 3\ndata: {"seq":3,')
    expect(events.map((e) => e.type)).toEqual(['run_start', 'text_delta'])
    expect(rest).toBe('id: 3\ndata: {"seq":3,')
  })
})

const RESULT = {
  schema: 'lc.ask.result', version: 1,
  blocks: [
    { kind: 'property_research', title: 'Listing check', summary: 'Public listing shows Active.', property_id: '1000001', address_label: '12 Synthetic Ln', facts: [{ label: 'Owner type', value: 'Individual', evidence: 'internal', source: 'eg.ownership' }, { label: 'Listed price', value: '$250,000', evidence: 'public_web', source: 'https://listings.example/12-synthetic' }], listing_status: { status: 'Active', source_url: 'https://listings.example/12-synthetic', as_of: '2026-10-12' }, gaps: ['No MLS history'] },
    { kind: 'answer', markdown: 'The listing is **Active**.' },
    { kind: 'web_citations', citations: [{ url: 'https://listings.example/12-synthetic', title: '12 Synthetic Ln — listing', retrieved_at: '2026-10-13T12:00:00.000Z', page_age: '1 day ago' }, { url: 'javascript:alert(1)', title: 'x' }] },
    { kind: 'conversation_summary', title: 'Summary', summary: 'Two points.', points: ['one', 'two'] },
  ],
  evidence: { internal: { tools: ['eg.ownership'], property_ids: ['1000001'] }, public_web: [{ url: 'https://listings.example/12-synthetic', title: 'L', retrieved_at: '2026-10-13T12:00:00.000Z' }] },
}

describe('typed results', () => {
  it('normalizes the v1 envelope and drops non-http citation URLs; an unknown schema is null', () => {
    const r = normalizeResult(RESULT)!
    expect(r.blocks.length).toBe(4)
    const cites = r.blocks.find((b) => b.kind === 'web_citations') as { citations: Array<{ url: string }> }
    expect(cites.citations.map((c) => c.url)).toEqual(['https://listings.example/12-synthetic'])
    expect(normalizeResult({ ...RESULT, version: 2 })).toBeNull()
    expect(normalizeResult(null)).toBeNull()
  })

  it('renders the property card (internal and public web apart), web citations with retrieved date, the plain answer and a markdown fallback', () => {
    const t = text(<ResultBlocks result={normalizeResult(RESULT)} answerMd="" citeIds={[]} onCite={noop} labelOf={() => null} onOpen={noop} />)
    expect(t).toContain('12 Synthetic Ln')
    expect(t).toContain('Listing status · public web')
    expect(t).toContain('Active')
    expect(t).toContain('LeadCommand records')
    expect(t).toContain('Public web')
    expect(t).toContain('Not LeadCommand data')
    expect(t).toContain('retrieved Oct 13, 2026')
    expect(t).toContain('Gaps / not available')
    expect(t).toContain('The listing is')
    expect(t).toContain('Two points.')
    const html = renderToStaticMarkup(<ResultBlocks result={normalizeResult(RESULT)} answerMd="" citeIds={[]} onCite={noop} labelOf={() => null} onOpen={noop} />)
    expect(html).toContain('rel="noopener noreferrer nofollow"')
    expect(html).not.toContain('javascript:')
  })

  it('no result envelope ⇒ the markdown answer', () => {
    const t = text(<ResultBlocks result={null} answerMd="Plain **answer**" citeIds={[]} onCite={noop} labelOf={() => null} onOpen={noop} />)
    expect(t).toContain('Plain')
  })
})

describe('turn view — live', () => {
  const base = (patch: Partial<AskTurn>): AskTurn => ({ id: 't1', runId: 'ask_abcdefgh1234', text: "What's good bro?", command: null, chips: [], question: 'q', notes: [], sentAt: Date.now() - 1000, phase: 'running', failure: null, run: null, ...patch })

  it('a running turn shows the server status and the streamed text — no typing effect, no Planning…', () => {
    seq = 0
    const t = text(<AskTurnView turn={base({ events: [ev('run_start'), ev('model_call_start', { call: 1, model: 'claude-haiku-5-5' }), ev('text_delta', { call: 1, text: 'Not much — ' })] })} tools={[]} labels={{}} reduced now={Date.now()} handlers={{ onOpen: noop, onFollowUp: noop, onStop: noop, onResume: noop, onRevealed: noop }} />)
    expect(t).toContain('Writing')
    expect(t).toContain('Not much')
    expect(t).not.toContain('Planning')
    expect(t).toContain('Stop')
  })

  it('a finished conversational turn is just the reply (no step log, no follow-up chips)', () => {
    const run = normalizeRun({ run_id: 'ask_abcdefgh1234', state: 'completed', mode: 'conversation', latency_ms: 900, cost_usd: 0.0001, models: { default: 'claude-haiku-5-5' }, counters: { model_calls: 1, tool_calls: 0 }, calls: [], audit: [{ kind: 'model_call', name: 'claude-haiku-5-5', outcome: 'end_turn' }], answer: { answer_md: 'Not much, you?' } })!
    const t = text(<AskTurnView turn={base({ phase: 'done', run })} tools={[]} labels={{}} reduced now={Date.now()} handlers={{ onOpen: noop, onFollowUp: noop, onStop: noop, onResume: noop, onRevealed: noop }} />)
    expect(t).toContain('Not much, you?')
    expect(t).not.toContain('Worked for')
    expect(t).not.toContain('Explain the evidence')
  })

  it('cancelling shows Stopping… and disables Stop', () => {
    const html = renderToStaticMarkup(<AskTurnView turn={base({ cancelling: true, events: [] })} tools={[]} labels={{}} reduced now={Date.now()} handlers={{ onOpen: noop, onFollowUp: noop, onStop: noop, onResume: noop, onRevealed: noop }} />)
    expect(html).toContain('Stopping…')
    expect(html).toMatch(/<button[^>]*disabled/)
  })
})
