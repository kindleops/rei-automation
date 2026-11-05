import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * rc-8.5.20 C — the Action Center / daily brief planes against a mocked backend client:
 * the truthful not-enabled state (404), the read model not run / not applied
 * (available:false — never 0), the shapes, and the one mutation (work-item decide).
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

const client = await import('../api/ic-client')
const store = await import('./ic-store')

beforeEach(() => { calls.length = 0 })

describe('operations plane', () => {
  it('an unmounted route is "not enabled" with the switches that turn it on', async () => {
    responder = () => ({ ok: false, status: 502, error: 'BACKEND_HTML_ERROR', message: '[404] <html>' })
    const r = await client.fetchActionCenter()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.state).toBe('not_enabled')
      expect(r.next).toContain('AGENT_OPERATIONS_ENABLED')
    }
    expect(calls[0].path).toBe('/api/cockpit/agent/operations/action-center?limit=100')
  })

  it('a read model that has not run is available:false with its code — no counts, never 0', () => {
    const p = client.normalizeActionCenter({ ok: true, available: false, code: 'ACTION_CENTER_NOT_RUN' })
    expect(p).toEqual({ available: false, code: 'ACTION_CENTER_NOT_RUN', summary: null, items: [], next_cursor: null })
    const b = client.normalizeBrief({ ok: true, available: false, code: 'BRIEF_NOT_GENERATED' })
    expect(b.available).toBe(false)
    expect(b.sections).toEqual([])
  })

  it('action center rows: ids only, state, owner, verified stage, next action, due, priority reason, evidence refs', () => {
    const p = client.normalizeActionCenter({
      ok: true, available: true,
      summary: { counts: { needs_attention: 3, resolved: 2 }, lost: 1, active_queue: 3, total: 5, computed_at: '2026-10-15T12:00:00Z' },
      items: [{ conversation_id: 'c1', state: 'needs_attention', owner: 'none', verified_stage: 'property_condition', stage_verified: false, stage_note: 'offer_stage_without_offer_event', next_action: 'answer the seller', due_at: null, priority_reason: 'seller_waiting', evidence_refs: [{ source: 'public.message_events', record_id: 'm1', role: 'last_inbound' }], pending_approvals: [], reasons: ['meaningful_inbound_without_next_action'], lost: true }],
    })
    expect(p.summary?.counts.needs_attention).toBe(3)
    expect(p.summary?.counts.ai_handling).toBeUndefined()
    expect(p.items[0]).toMatchObject({ conversation_id: 'c1', lost: true, stage_verified: false, evidence_refs: [{ source: 'public.message_events', id: 'm1', role: 'last_inbound' }] })
    expect(client.ACTION_STATE_ORDER).toHaveLength(9)
  })

  it('brief lines keep "unavailable" as null (never 0) and their source links', () => {
    const b = client.normalizeBrief({ ok: true, available: true, job_id: 'job_1', at: '2026-10-15T12:00:00Z', window: { since: 'a', until: 'b' }, brief: { sections: [
      { id: 'offers_prepared', title: 'Offers prepared', available: true, lines: [{ label: 'Offers recorded', value: 0, links: [] }] },
      { id: 'recovered_opportunities', title: 'Recovered opportunities', available: false, code: 'WORK_ITEMS_UNAVAILABLE', lines: [] },
      { id: 'system_incidents', title: 'System incidents', available: true, lines: [{ label: 'Open escalations', value: null, links: [{ source: 'agent.ops_work_item', work_item_id: 'w1' }] }] },
    ] } })
    expect(b.sections[0].lines[0].value).toBe(0)
    expect(b.sections[1]).toMatchObject({ available: false, code: 'WORK_ITEMS_UNAVAILABLE' })
    expect(b.sections[2].lines[0].value).toBeNull()
    expect(b.sections[2].lines[0].links).toEqual([{ source: 'agent.ops_work_item', id: 'w1' }])
  })

  it('decide posts exactly the action for exactly the item, then re-reads the planes', async () => {
    responder = (c) => c.method === 'POST' ? { ok: true, status: 200, data: { ok: true, work_item_id: 'w1', from: 'open', action: 'acknowledge' } } : { ok: true, status: 200, data: { ok: true, available: true, items: [], summary: { counts: {}, lost: 0, active_queue: 0, total: 0 } } }
    await store.decideWork('w1', 'acknowledge')
    expect(calls[0]).toEqual({ path: '/api/cockpit/agent/operations/work-items/w1/decide', method: 'POST', body: { action: 'acknowledge' } })
    expect(calls.slice(1).map((c) => c.path).sort()).toEqual(['/api/cockpit/agent/operations/action-center?limit=100', '/api/cockpit/agent/operations/work-items?state=open&state=acknowledged&limit=100'])
    expect(store.getIc().workNote).toContain('acknowledge')
  })

  it('the two sections are in the navigation', () => {
    expect(store.SECTIONS.map((s) => s.id)).toEqual(expect.arrayContaining(['action_center', 'brief']))
  })
})
