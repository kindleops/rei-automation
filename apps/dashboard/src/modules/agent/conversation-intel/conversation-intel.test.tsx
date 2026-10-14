import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../../lib/api/backendClient', () => ({ callBackend: vi.fn() }))
import { callBackend } from '../../../lib/api/backendClient'
import { CONVERSATION_INTEL_FIXTURE } from './__fixtures__/conversation-intel.fixture'
import { ConversationIntelControls, ConversationIntelPanel } from './ConversationIntelPanel'
import { DRAFT_LABEL, getIntel, jobForRecord, loadControl, loadIntel, noResponseReason, resetIntelForTest, runControl, setIntel, type ControlState } from './conversation-intel-model'

const text = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const mocked = callBackend as unknown as ReturnType<typeof vi.fn>

const control = (over: Partial<ControlState> = {}): ControlState => ({
  mode: 'shadow', send_path: 'none',
  shadow: { on: false, state: 'off', gates: { env_shadow: true, env_runtime: true, db_runtime: true, emergency_stop_clear: true, kind_enabled: true, spend_enabled: false } },
  flags: { ai_conversation_shadow_enabled: true, agent_runtime_enabled: true, agent_enabled: true, cron_agent_runtime_enabled: null },
  runtime: { runtime_enabled: true, emergency_stop: false, emergency_stop_at: null, max_concurrency_global: 2, tick_max_jobs: 2, lease_seconds: 60, open: { queued: 2 }, ended_24h: { completed: 5, dead_letter: 1 }, heartbeat: { worker_id: 'agent-runtime-tick', last_tick_at: '2026-10-14T10:00:00Z', age_s: 41, ticks: 12 } },
  kind: { configured: true, armed: true, enabled: true, max_concurrency: 1, event_budget_cap_usd: 0.01 },
  budget: { spend_enabled: false, day_cap_usd: 10, cycle_cap_usd: 150, run_cap_usd: 2.5, spent_day_usd: 0.12, spent_cycle_usd: 3.4, spent_day_kind_usd: 0.05, per_event_reserve_usd: 0.01 },
  jobs: [{ job_id: 'mjob_1', state: 'dead_letter', attempt: 3, max_attempts: 3, trigger: 'event', created_at: null, claimed_at: null, heartbeat_at: null, next_attempt_at: null, ended_at: null, lease_owner: null, lease_until: null, budget_cap_usd: 0.01, deterministic_intent: null, inbound_message_id: CONVERSATION_INTEL_FIXTURE[0].inbound_message_id, result: null, error_code: 'AGENT_MODEL_UNAVAILABLE', wall_ms: 4200 }],
  errors: [],
  ...over,
})

afterEach(() => { resetIntelForTest(); mocked.mockReset() })

describe('conversation intelligence review panel', () => {
  it('renders every pipeline section from a real-shaped record; the draft is labelled not sent', () => {
    const rec = CONVERSATION_INTEL_FIXTURE.find((r) => r.draft) ?? CONVERSATION_INTEL_FIXTURE[0]
    setIntel({ open: true, status: 'ready', records: [rec], selectedKey: rec.idempotency_key, control: control({ jobs: [{ ...control().jobs[0], inbound_message_id: rec.inbound_message_id }] }), controlStatus: 'ready' })
    const t = text(<ConversationIntelPanel />)
    for (const h of ['Incoming message', 'Context summary', 'Intent', 'Facts', 'Already known', 'Stage evidence', 'Decision', 'Model', 'Proposed reply', 'Validation', 'Worker job', 'Mode: shadow']) expect(t).toContain(h)
    expect(t).toContain('Dead letter')
    expect(t).toContain('AGENT_MODEL_UNAVAILABLE')
    expect(t).toContain('Not sent — shadow')
    if (rec.draft) expect(t).toContain(DRAFT_LABEL)
    // never presented as sent
    expect(t.replace(/not sent/gi, '')).not.toMatch(/\bsent\b/i)
  })

  it('no-response / escalation reason comes from the record', () => {
    const base = CONVERSATION_INTEL_FIXTURE[0]
    expect(noResponseReason({ ...base, decision: { ...base.decision, outcome: 'NO_RESPONSE', response_needed: false, escalation_required: false, fail_closed: null }, context_summary: { eligibility: { blocked: true, reasons: ['outside_window'], outside_window: true, in_session: false } } })).toBe('Not eligible: Outside window')
    expect(noResponseReason({ ...base, decision: { ...base.decision, escalation_required: true, escalation_reason: 'contradiction', fail_closed: null } })).toBe('Escalated: Contradiction')
    expect(jobForRecord(null, base)).toBeNull()
  })

  it('no fixture fallback: an unavailable server shows the note and no records', async () => {
    mocked.mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true, available: false, records: [], code: 'SHADOW_TABLE_NOT_APPLIED' } })
    await loadIntel()
    expect(getIntel().records).toEqual([])
    expect(getIntel().note).toMatch(/not applied/)
    const src = fs.readFileSync(path.join(__dirname, 'conversation-intel-model.ts'), 'utf8') + fs.readFileSync(path.join(__dirname, 'ConversationIntelPanel.tsx'), 'utf8')
    expect(src).not.toMatch(/import[^\n]*fixture/i)
  })

  it('controls show every gate, budget and runtime; stop-only actions', () => {
    setIntel({ open: true, control: control(), controlStatus: 'ready' })
    const t = text(<ConversationIntelControls />)
    for (const h of ['AI_CONVERSATION_SHADOW_ENABLED', 'Model spend enabled', 'Emergency stop clear', 'Today', '$0.12', 'Per event', '41s ago', 'Pause conversation shadow', 'Emergency stop', 'Send path: none']) expect(t).toContain(h)
    expect(t).not.toMatch(/Resume|Enable shadow|Turn on/i)
  })

  it('a control POSTs only {action, confirm} to the control route, then re-reads state; a refusal throws', async () => {
    mocked.mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true, action: 'pause_kind' } })
    mocked.mockResolvedValueOnce({ ok: true, status: 200, data: { ...control(), ok: true } })
    await runControl('pause_kind', 'r')
    const [url, init] = mocked.mock.calls[0]
    expect(url).toBe('/api/cockpit/agent/conversation-ai/control')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ action: 'pause_kind', confirm: true, reason: 'r' })
    expect(mocked.mock.calls[1][0]).toBe('/api/cockpit/agent/conversation-ai/control')
    expect(getIntel().controlStatus).toBe('ready')
    mocked.mockResolvedValueOnce({ ok: false, status: 403, error: 'HTTP_403', upstream: { error: 'OPERATOR_NOT_ALLOWLISTED' } })
    await expect(runControl('emergency_stop')).rejects.toThrow(/OPERATOR_NOT_ALLOWLISTED/)
  })

  it('control state read failure is reported, not invented', async () => {
    mocked.mockResolvedValueOnce({ ok: false, status: 503, error: 'HTTP_503' })
    await loadControl()
    expect(getIntel().control).toBeNull()
    expect(getIntel().controlStatus).toBe('error')
  })
})
