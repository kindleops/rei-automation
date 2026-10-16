import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The approvals flow and the truthful 404 state, against a mocked backend
 * client (the only network seam): every request is recorded so the exact
 * method, path and body can be asserted.
 */
type Call = { path: string; method: string; body: unknown }
const calls: Call[] = []
let responder: (c: Call) => { ok: boolean; status: number; data?: unknown; error?: string; message?: string; upstream?: unknown } = () => ({ ok: false, status: 404, error: 'Not Found', message: '[404] Not Found', upstream: null })

vi.mock('../../../lib/api/backendClient', () => ({
  callBackend: async (path: string, opts: { method?: string; body?: string } = {}) => {
    const c = { path, method: (opts.method || 'GET').toUpperCase(), body: opts.body ? JSON.parse(opts.body) : null }
    calls.push(c)
    return responder(c)
  },
  getBackendBaseUrl: () => '',
  getBackendAuthHeaders: async () => ({}),
}))

const APPROVAL = {
  approval_id: 'apr_0123456789abcdef', capability_id: 'pipeline.propose_stage_change', capability_version: 1, tier: 'requires_explicit_approval', state: 'pending', provenance: 'operator',
  target: { opportunity_id: 'o1' }, intended_change: { action: 'stage_change', opportunity_id: 'o1', from_stage: 'asking_price', to_stage: 'offer', reason: 'Seller asked for a number' },
  summary: ['Move opportunity from asking_price → offer'], payload_hash: 'f'.repeat(64), snapshot_hash_prefix: 'abcdef012345', expires_at: '2099-01-01T00:00:00Z', created_at: '2026-10-14T12:00:00Z', decided_at: null, execution_result: null,
}

beforeEach(async () => {
  calls.length = 0
  const s = await import('./ic-store')
  s.__resetIc()
})

describe('actions plane not enabled (404 with an empty body)', () => {
  it('capabilities, approvals and invoke all report the truthful not-enabled state with the switches to set', async () => {
    responder = () => ({ ok: false, status: 404, error: 'Not Found', message: '[404] Not Found', upstream: null })
    const c = await import('../api/ic-client')
    const caps = await c.fetchCapabilities()
    const list = await c.listApprovals()
    const inv = await c.invokeCapability('platform.health', {})
    for (const r of [caps, list, inv]) {
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.state).toBe('not_enabled')
      expect(r.next).toMatch(/AGENT_CAPABILITIES_ENABLED=1/)
    }
  })

  it('an unmounted Next route (HTML 404 → 502 BACKEND_HTML_ERROR) is also "not enabled", e.g. the missions API', async () => {
    responder = () => ({ ok: false, status: 502, error: 'BACKEND_HTML_ERROR', message: '[404] Backend returned an HTML error page instead of JSON.', upstream: { html_preview: '<html>' } })
    const c = await import('../api/ic-client')
    const r = await c.fetchMissions()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.state).toBe('not_enabled')
      expect(r.message).toMatch(/Missions API not enabled/)
    }
  })

  it('a real per-record 404 (APPROVAL_NOT_FOUND) is NOT shown as "plane not enabled"', async () => {
    responder = () => ({ ok: false, status: 404, error: 'APPROVAL_NOT_FOUND', message: 'x', upstream: { ok: false, code: 'APPROVAL_NOT_FOUND' } })
    const c = await import('../api/ic-client')
    const r = await c.getApproval('apr_missing')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.state).toBe('error')
  })

  it('the store keeps the failure and the pending count stays unknown (null), never 0', async () => {
    responder = () => ({ ok: false, status: 404, error: 'Not Found', message: '[404]', upstream: null })
    const s = await import('./ic-store')
    await s.refreshApprovals()
    expect(s.getIc().approvals.phase).toBe('failed')
    expect(s.getIc().approvals.failure?.state).toBe('not_enabled')
    expect(s.pendingCount()).toBeNull()
  })
})

describe('Act → approval → decide', () => {
  it('invoke creates a pending approval, the card reads it back, and decide is called with EXACTLY that id and payload hash', async () => {
    responder = (c) => {
      if (c.path === '/api/cockpit/agent/actions/invoke') return { ok: true, status: 200, data: { ok: true, status: 'approval_pending', capability_id: 'pipeline.propose_stage_change', approval_id: APPROVAL.approval_id, expires_at: APPROVAL.expires_at, deduped: false } }
      if (c.path === `/api/cockpit/agent/actions/approvals/${APPROVAL.approval_id}`) return { ok: true, status: 200, data: { ok: true, approval: APPROVAL } }
      if (c.path.startsWith('/api/cockpit/agent/actions/approvals?')) return { ok: true, status: 200, data: { ok: true, approvals: [APPROVAL] } }
      if (c.path === `/api/cockpit/agent/actions/approvals/${APPROVAL.approval_id}/decide`) return { ok: true, status: 200, data: { ok: true, state: 'executed', code: null, replayed: false, execution_result: { ok: true, from_stage: 'asking_price', to_stage: 'offer', readback: { stage: 'offer' } } } }
      return { ok: false, status: 404, error: 'x', message: 'x' }
    }
    const s = await import('./ic-store')
    const id = await s.proposeAct({ capability_id: 'pipeline.propose_stage_change', title: 'Propose a stage change', input: { opportunity_id: 'o1', to_stage: 'offer', reason: 'Seller asked for a number' }, reason: 'Seller asked for a number' })
    const invoke = calls.find((c) => c.path === '/api/cockpit/agent/actions/invoke')!
    expect(invoke.method).toBe('POST')
    expect(invoke.body).toEqual({ capability_id: 'pipeline.propose_stage_change', input: { opportunity_id: 'o1', to_stage: 'offer', reason: 'Seller asked for a number' } })
    const entry = s.getIc().acts.find((a) => a.id === id)!
    expect(entry.phase).toBe('pending')
    expect(entry.approval?.approval_id).toBe(APPROVAL.approval_id)

    const note = await s.decide(entry.approval!, 'approve', id)
    const decides = calls.filter((c) => c.path.endsWith('/decide'))
    expect(decides).toHaveLength(1)
    expect(decides[0].path).toBe(`/api/cockpit/agent/actions/approvals/${APPROVAL.approval_id}/decide`)
    expect(decides[0].method).toBe('POST')
    expect(decides[0].body).toEqual({ decision: 'approve', payload_hash: APPROVAL.payload_hash })
    expect(note).toMatch(/Approved and executed/)
  })

  it('a refusal code from decide (drift) is shown as the server said, and nothing is marked executed', async () => {
    responder = (c) => {
      if (c.path.endsWith('/decide')) return { ok: false, status: 409, error: 'STATE_DRIFTED', message: '[409] STATE_DRIFTED', upstream: { ok: false, state: 'refused_drift', code: 'STATE_DRIFTED' } }
      if (c.path === `/api/cockpit/agent/actions/approvals/${APPROVAL.approval_id}`) return { ok: true, status: 200, data: { ok: true, approval: { ...APPROVAL, state: 'refused_drift' } } }
      return { ok: true, status: 200, data: { ok: true, approvals: [] } }
    }
    const s = await import('./ic-store')
    const note = await s.decide(APPROVAL as never, 'approve')
    expect(note).toMatch(/records changed since this was prepared/)
  })

  it('a deny sends decision deny with the same exact hash', async () => {
    responder = (c) => (c.path.endsWith('/decide') ? { ok: true, status: 200, data: { ok: true, state: 'denied', code: null, replayed: false, execution_result: null } } : { ok: true, status: 200, data: { ok: true, approvals: [] } })
    const s = await import('./ic-store')
    const note = await s.decide(APPROVAL as never, 'deny')
    expect(calls.find((c) => c.path.endsWith('/decide'))?.body).toEqual({ decision: 'deny', payload_hash: APPROVAL.payload_hash })
    expect(note).toBe('Rejected. Nothing changed.')
  })
})

describe('missions (docs/agent-missions-api.md)', () => {
  // the store's poll timers use window.setTimeout (node test env has no window)
  ;(globalThis as unknown as { window?: unknown }).window ??= globalThis
  const SUMMARY = { mission_id: 'mjob_x', kind: 'mission.research', state: 'running', display_state: 'running', title: 'Q', progress: { step: 'ask', pct: 60 }, attempt: 1, max_attempts: 3, budget_cap_usd: 0.5, cost_usd: null }
  it('create → POST /api/cockpit/agent/missions with the contract body, then follows the detail', async () => {
    responder = (c) => {
      if (c.path === '/api/cockpit/agent/missions' && c.method === 'POST') return { ok: true, status: 201, data: { ok: true, status: 'executed', mission_id: 'mjob_x', state: 'queued', deduped: false } }
      if (c.path.startsWith('/api/cockpit/agent/missions?')) return { ok: true, status: 200, data: { ok: true, scope: 'mine', missions: [SUMMARY], next_cursor: null } }
      return { ok: true, status: 200, data: { ok: true, mission: { ...SUMMARY, events: [{ id: 1, type: 'job.enqueued', state: 'queued' }], events_cursor: 1, findings: [], children: [] } } }
    }
    const s = await import('./ic-store')
    const id = await s.createMission({ kind: 'mission.research', question: 'Research 9100001', context: { property_ids: ['9100001'] } })
    expect(id).toBe('mjob_x')
    const create = calls.find((c) => c.method === 'POST')!
    expect(create).toEqual({ path: '/api/cockpit/agent/missions', method: 'POST', body: { kind: 'mission.research', question: 'Research 9100001', context: { property_ids: ['9100001'] } } })
    expect(s.getIc().missionNote).toMatch(/Queued · mjob_x · queued/)
    expect(s.getIc().inspector).toEqual({ kind: 'mission', id: 'mjob_x' })
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.some((c) => c.path === '/api/cockpit/agent/missions/mjob_x')).toBe(true)
    expect(s.getIc().mission.data?.events).toHaveLength(1)
  })
  it('incremental events are merged by id (events_after never duplicates)', async () => {
    const c = await import('../api/ic-client')
    const a = c.normalizeMissionDetail({ mission: { ...SUMMARY, events: [{ id: 1, type: 'job.enqueued' }, { id: 2, type: 'job.claimed' }], events_cursor: 2 } })!
    const b = c.normalizeMissionDetail({ mission: { ...SUMMARY, state: 'completed', events: [{ id: 2, type: 'job.claimed' }, { id: 3, type: 'job.completed' }], events_cursor: 3 } })!
    const m = c.mergeMissionDetail(a, b)
    expect(m.events.map((e) => e.id)).toEqual([1, 2, 3])
    expect(m.events_cursor).toBe(3)
    expect(m.state).toBe('completed')
    expect(c.MISSIONS_ENDPOINTS.get('mjob_x', 2)).toBe('/api/cockpit/agent/missions/mjob_x?events_after=2')
  })
  it('a 404 missions API is "not enabled" with AGENT_MISSIONS_ENABLED, and cancel hits the exact path', async () => {
    responder = () => ({ ok: false, status: 404, error: 'Not Found', message: '[404]', upstream: null })
    const c = await import('../api/ic-client')
    const r = await c.fetchMissions()
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.state).toBe('not_enabled'); expect(r.next).toMatch(/AGENT_MISSIONS_ENABLED=1/) }
    responder = () => ({ ok: true, status: 202, data: { ok: true, mission_id: 'mjob_x', state: 'running', pending: true, noop: false, children: [] } })
    const s = await import('./ic-store')
    const note = await s.cancelMission('mjob_x')
    expect(calls.at(-2)?.path === '/api/cockpit/agent/missions/mjob_x/cancel' || calls.some((x) => x.path === '/api/cockpit/agent/missions/mjob_x/cancel' && x.method === 'POST')).toBe(true)
    expect(note).toMatch(/next step boundary/)
  })
})
