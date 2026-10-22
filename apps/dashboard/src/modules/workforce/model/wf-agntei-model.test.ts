import { afterEach, describe, expect, it } from 'vitest'
import type { BackendResult } from '../../../lib/api/backendClient'
import { getEmployee, registerAgnteiAgent, setWfTransport, type WfRequest } from '../api/wf-client'
import { normalizeAssignment, normalizeEmployee } from '../api/wf-normalize'
import { activityLine, activityText, employeeIdFrom, executionLabel, lastSeenText, mergeHistory, originBadge, registerProblems } from './wf-agntei-model'

const NOW = Date.parse('2026-10-22T15:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const okBody = (data: unknown): BackendResult<unknown> => ({ ok: true, status: 200, data: { ok: true, data } })
afterEach(() => setWfTransport(null))

describe('Workforce × Agntei · the truthful activity', () => {
  it('renders the server label with a LIVE "last seen" for an external agent', () => {
    const a = { state: 'waiting', reason: 'external_agent', label: 'Waiting for Ridge (Agntei), last seen 9 min ago', last_seen_at: iso(NOW - 3 * 60_000), open: 1 }
    expect(activityLine(a, NOW)).toBe('Waiting for Ridge (Agntei), last seen 3 min ago')
    const t = activityText(a, NOW)!
    expect(t.tone).toBe('attn')
    expect(activityLine({ ...a, last_seen_at: null }, NOW)).toBe('Waiting for Ridge (Agntei), never seen')
  })
  it('working / idle / pending link / binding ended keep their own words and tones; unknown is unknown', () => {
    expect(activityText({ state: 'working', reason: 'lease_held', label: 'Ridge (Agntei) is working on it', last_seen_at: iso(NOW), open: 1 }, NOW)!.tone).toBe('ok')
    expect(activityLine({ state: 'idle', reason: 'nothing_open', label: null, last_seen_at: null, open: 0 }, NOW)).toBe('Idle')
    expect(activityText({ state: 'pending_link', reason: 'not_linked', label: null, last_seen_at: null, open: 0 }, NOW)!.label).toBe('Not linked yet')
    expect(activityText({ state: 'binding_revoked', reason: 'binding_revoked', label: null, last_seen_at: null, open: 0 }, NOW)!.tone).toBe('crit')
    expect(activityText(null, NOW)).toBeNull()
    expect(lastSeenText(null, NOW)).toBe('never seen')
  })
})

describe('Workforce × Agntei · badges, form, history', () => {
  it('origin badges: Agntei / Workforce / Human; execution modes', () => {
    expect(originBadge({ origin: 'agntei', employment_type: 'operator_ai', kind: 'ai' }).label).toBe('Agntei')
    expect(originBadge({ origin: 'workforce', employment_type: 'autonomous_ai', kind: 'ai' }).label).toBe('Workforce')
    expect(originBadge({ origin: null, employment_type: null, kind: 'human' }).label).toBe('Human')
    expect(executionLabel({ execution_mode: 'external' })).toBe('External · Agntei')
    expect(executionLabel({ execution_mode: null })).toBeNull()
  })
  it('the register form: an emp_ id from the name; market-scoped roles need a market; no phone / email in a name', () => {
    expect(employeeIdFrom('Ridge Two')).toBe('emp_ridge_two')
    expect(employeeIdFrom('Ab')).toBeNull()
    expect(registerProblems({ employee_id: 'emp_ridge', display_name: 'Ridge', role_key: 'research_analyst', markets: [] })).toEqual([])
    expect(registerProblems({ employee_id: 'emp_quarry', display_name: 'Quarry', role_key: 'acquisition_agent', markets: [] }).join()).toMatch(/market-scoped/)
    expect(registerProblems({ employee_id: 'emp_x_y', display_name: 'call 3125550101', role_key: 'research_analyst', markets: [] }).join()).toMatch(/phone/)
    expect(registerProblems({ employee_id: 'emp_coo2', display_name: 'COO', role_key: 'coo', markets: [] }).join()).toMatch(/role/)
  })
  it('history merges Workforce events and the gateway audit, newest first', () => {
    const rows = mergeHistory([{ event_id: 1, at: iso(NOW - 60_000), type: 'wf.employee.linked' }], [{ event_id: 9, at: iso(NOW - 1000), event_type: 'intent_succeeded', action: 'workforce_claim_assignment', code: 'CLAIMED', intent_id: null }])
    expect(rows.map((r) => r.source)).toEqual(['gateway', 'workforce'])
    expect(rows[0].what).toBe('claim assignment · intent succeeded')
    expect(rows[1].what).toBe('employee linked')
  })
})

describe('Workforce × Agntei · wire', () => {
  it('normalizes the identity / mode / activity fields; a missing one is null, never invented', () => {
    const e = normalizeEmployee({ employee_id: 'emp_ridge', display_name: 'Ridge', kind: 'ai', origin: 'agntei', employment_type: 'operator_ai', skills: ['probate'], activity: { state: 'idle' } })!
    expect([e.origin, e.employment_type, e.skills, e.activity?.state]).toEqual(['agntei', 'operator_ai', ['probate'], 'idle'])
    const bare = normalizeEmployee({ employee_id: 'emp_old', display_name: 'Old', kind: 'ai' })!
    expect([bare.origin, bare.employment_type, bare.activity, bare.external_agent_id]).toEqual([null, null, null, null])
    expect(normalizeAssignment({ assignment_id: 'wfa_x', execution_mode: 'external' })!.execution_mode).toBe('external')
    expect(normalizeAssignment({ assignment_id: 'wfa_x', execution_mode: 'sideways' })!.execution_mode).toBeNull()
  })
  it('registerAgnteiAgent posts the register op (no actor) and returns the employee + the link steps; nothing executed', async () => {
    const calls: WfRequest[] = []
    setWfTransport(async (r) => { calls.push(r); return okBody({ employee: { employee_id: 'emp_ridge', display_name: 'Ridge', kind: 'ai', status: 'pending_link', origin: 'agntei', employment_type: 'operator_ai' }, link: { agent_id: 'agt_ridge', employee_id: 'emp_ridge', tools: ['leadcommand_workforce_link_self'], steps: [{ id: 'mint', title: 'Mint', who: 'owner', kind: 'shell', command: 'npm run mint:agent-credential' }] }, executed: false }) })
    const r = await registerAgnteiAgent({ employee_id: 'emp_ridge', role_key: 'research_analyst', display_name: 'Ridge' })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].path).toBe('/api/cockpit/workforce/employees')
    expect(calls[0].body).toEqual({ op: 'register_agntei', employee: { employee_id: 'emp_ridge', role_key: 'research_analyst', display_name: 'Ridge' } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.employee?.status).toBe('pending_link')
    expect(r.data.link?.steps[0].id).toBe('mint')
    expect(r.data.executed).toBe(false)
  })
  it('a non-CEO register is the CEO-only failure state', async () => {
    setWfTransport(async () => ({ ok: false, status: 403, error: 'BACKEND_ERROR', message: '[403]', upstream: { ok: false, error: 'CEO_ONLY', message: 'Only the CEO can create or change employees.' } }))
    const r = await registerAgnteiAgent({ employee_id: 'emp_ridge', role_key: 'research_analyst', display_name: 'Ridge' })
    expect(!r.ok && r.state).toBe('denied')
    expect(!r.ok && r.message).toMatch(/CEO/)
  })
  it('the profile carries activity, link, link steps and the merged history', async () => {
    setWfTransport(async () => okBody({ employee: { employee_id: 'emp_ridge', display_name: 'Ridge', kind: 'ai', origin: 'agntei' }, activity: { state: 'waiting', reason: 'external_agent', label: 'Waiting for Ridge (Agntei)', last_seen_at: null },
      link: { system: 'agntei', principal_id: 'agt_ridge', linked: true, external_agent_id: 'agent_ridge01' }, link_steps: null,
      history: { events: [{ event_id: 3, at: iso(NOW), type: 'wf.employee.linked', payload: {} }], events_available: true, gateway: [{ event_id: 7, at: iso(NOW), event_type: 'intent_succeeded', action: 'workforce_link_self', code: 'LINKED' }], gateway_available: true } }))
    const r = await getEmployee('emp_ridge')
    expect(r.ok).toBe(true)
    if (!r.ok || !r.data) return
    expect(r.data.activity?.reason).toBe('external_agent')
    expect(r.data.link?.linked).toBe(true)
    expect(r.data.link_steps).toBeNull()
    expect(r.data.history?.gateway[0].code).toBe('LINKED')
    expect(r.data.history?.events[0].type).toBe('wf.employee.linked')
  })
})
