import { afterEach, describe, expect, it } from 'vitest'
import type { BackendResult } from '../../../lib/api/backendClient'
import {
  classifyWf, getEmployee, getMission, getOverview, getKpis, listEvents, listMissions, postCommand, qs, revokePolicy, setWfTransport, submitDirective,
  cancelMission, getAuthority, type WfRequest,
} from './wf-client'
import { decodePid, normalizeKpi, normalizeRef, normalizeReport } from './wf-normalize'
import { wfFixturesGate } from '../wf-flags'

const okBody = (data: unknown, extra: Record<string, unknown> = {}): BackendResult<unknown> => ({ ok: true, status: 200, data: { ok: true, data, ...extra } })
const fail = (status: number, upstream: unknown, error = 'BACKEND_ERROR', message = `[${status}]`): BackendResult<unknown> => ({ ok: false, status, error, message, upstream })

function record(answer: (r: WfRequest) => BackendResult<unknown>) {
  const calls: WfRequest[] = []
  setWfTransport(async (r) => { calls.push(r); return answer(r) })
  return calls
}
afterEach(() => setWfTransport(null))

describe('wf-client · envelope and failures', () => {
  it('unwraps { ok, data } and normalizes the overview without inventing numbers', async () => {
    record(() => okBody({ employees: [{ employee_id: 'emp_coo_atlas', display_name: 'Atlas', kind: 'ai', role_key: 'coo', department_key: 'executive' }], missions_by_status: { active: 2 }, runtime: {}, flags: { WORKFORCE_ENABLED: true } }))
    const r = await getOverview()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.fixture).toBe(false)
    expect(r.data.employees[0].open_assignments).toBeNull()
    expect(r.data.runtime.emergency_stop).toBeNull()
    expect(r.data.missions_by_status.active).toBe(2)
    expect(r.data.flags.WORKFORCE_ENABLED).toBe(true)
  })

  it('an unmounted route (empty 404 or the HTML 404 page) is "not enabled" with the switches', async () => {
    record(() => fail(404, null, 'Not Found'))
    const a = await listMissions()
    expect(a.ok).toBe(false)
    if (!a.ok) { expect(a.state).toBe('not_enabled'); expect(a.next).toMatch(/WORKFORCE_ENABLED=1/) }
    record(() => fail(502, { html_preview: '<html>' }, 'BACKEND_HTML_ERROR', '[404] Not Found'))
    const b = await listMissions()
    expect(!b.ok && b.state).toBe('not_enabled')
  })

  it('names session, allowlist, CEO-only, conflict, payload refusal and the emergency stop', () => {
    expect(classifyWf(401, 'UNAUTHENTICATED').state).toBe('session')
    expect(classifyWf(403, 'NOT_ALLOWED').state).toBe('denied')
    expect(classifyWf(403, 'CEO_ONLY').message).toMatch(/Only the CEO/)
    expect(classifyWf(409, 'ILLEGAL_TRANSITION').state).toBe('conflict')
    expect(classifyWf(422, 'PAYLOAD_REFUSED').message).toMatch(/phone numbers and email/)
    expect(classifyWf(423, 'EMERGENCY_STOP').next).toMatch(/emergency stop/)
    expect(classifyWf(499, 'BACKEND_REQUEST_CANCELLED').state).toBe('cancelled')
    expect(classifyWf(404, 'NOT_FOUND').state).toBe('error') // a real "no such mission" is not "not enabled"
  })

  it('reads the server error code from the upstream body', async () => {
    record(() => fail(403, { ok: false, error: 'CEO_ONLY', message: 'owner only' }))
    const r = await revokePolicy('wfp_1')
    expect(!r.ok && r.state).toBe('denied')
    expect(!r.ok && r.code).toBe('CEO_ONLY')
  })

  it('a 200 whose body says ok:false is a failure, not data', async () => {
    record(() => ({ ok: true, status: 200, data: { ok: false, error: 'WORKFORCE_DISABLED', message: 'off' } }))
    const r = await getKpis()
    expect(r.ok).toBe(false)
  })

  it('refuses a fixture body on the live channel', async () => {
    record(() => okBody({ missions: [] }, { fixture: true }))
    const r = await listMissions()
    expect(!r.ok && r.code).toBe('FIXTURE_ON_LIVE_CHANNEL')
  })
})

describe('wf-client · §7 requests', () => {
  it('POST /missions sends exactly { directive, client_request_id }', async () => {
    const calls = record(() => okBody({ mission: { mission_id: 'wfm_1', title: 'T', status: 'planning' } }))
    const r = await submitDirective('Find the 10 most promising', 'crid-1')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].path).toBe('/api/cockpit/workforce/missions')
    expect(calls[0].body).toEqual({ directive: 'Find the 10 most promising', client_request_id: 'crid-1' })
    expect(r.ok && r.data?.mission_id).toBe('wfm_1')
  })

  it('POST /command sends exactly { content, client_request_id } and returns messages + mission', async () => {
    const calls = record(() => okBody({ messages: [{ message_id: 'm1', author: 'ceo', content: 'hi', created_at: '2026-10-21T00:00:00Z' }, { message_id: 'm2', author: 'coo', content: 'ok', created_at: '2026-10-21T00:00:01Z' }], mission: { mission_id: 'wfm_2', status: 'planning' } }))
    const r = await postCommand('hi', 'crid-2')
    expect(calls[0].body).toEqual({ content: 'hi', client_request_id: 'crid-2' })
    expect(r.ok && r.data.messages.map((m) => m.author)).toEqual(['ceo', 'coo'])
    expect(r.ok && r.data.mission?.mission_id).toBe('wfm_2')
  })

  it('a status answer has no mission', async () => {
    record(() => okBody({ messages: [] }))
    const r = await postCommand('what is blocked?', 'crid-3')
    expect(r.ok && r.data.mission).toBeNull()
  })

  it('events page by cursor and scope by mission; ids are encoded', async () => {
    const calls = record(() => okBody({ events: [{ event_id: 7, at: '2026-10-21T00:00:00Z', type: 'wf.mission.planned' }, { event_id: 9, at: '2026-10-21T00:00:01Z', type: 'wf.assignment.completed' }] }))
    const r = await listEvents({ after: 5, mission: 'wfm_a b' })
    expect(calls[0].path).toBe('/api/cockpit/workforce/events?after=5&mission=wfm_a%20b')
    expect(r.ok && r.data.next_after).toBe(9)
    await getEmployee('emp_x/y')
    expect(calls[1].path).toBe('/api/cockpit/workforce/employees/emp_x%2Fy')
    await cancelMission('wfm_1')
    expect(calls[2]).toMatchObject({ method: 'POST', path: '/api/cockpit/workforce/missions/wfm_1/cancel' })
  })

  it('qs drops empty values', () => {
    expect(qs({ a: 1, b: null, c: undefined, d: '' })).toBe('?a=1')
    expect(qs({})).toBe('')
  })

  it('mission detail accepts plan / report beside the mission, events ascending', async () => {
    record(() => okBody({ mission: { mission_id: 'wfm_1', status: 'active' }, plan: { steps: [{ step_key: 'a', capability_key: 'intel.active_opportunities' }] }, report: null, assignments: [{ assignment_id: 'wfa_1', step_key: 'a', status: 'running' }], events: [{ event_id: 3, at: 'x', type: 'wf.b' }, { event_id: 1, at: 'x', type: 'wf.a' }] }))
    const r = await getMission('wfm_1')
    expect(r.ok && r.data?.mission.plan?.steps[0].step_key).toBe('a')
    expect(r.ok && r.data?.events.map((e) => e.event_id)).toEqual([1, 3])
  })

  it('authority normalizes settings, grants (display only), restrictions and the emergency state', async () => {
    record(() => okBody({ policies: [{ policy_id: 'p', action_key: 'research.property', status: 'active' }], settings: { exec_review_price_usd: '5000000' }, proposed_grants: [{ action: 'followup.prepare_draft' }], restrictions: [{ kind: 'hold', label: '1 Main St' }], emergency: { stop: true } }))
    const r = await getAuthority()
    expect(r.ok && r.data.settings?.exec_review_price_usd).toBe(5_000_000)
    expect(r.ok && r.data.proposed_grants[0].action).toBe('followup.prepare_draft')
    expect(r.ok && r.data.restrictions[0].kind).toBe('hold')
    expect(r.ok && r.data.emergency?.stop).toBe(true)
  })
})

describe('wf-normalize · honesty', () => {
  it('a KPI is known only with status known AND a number', () => {
    expect(normalizeKpi({ kpi_key: 'x', status: 'known', value: null })?.status).toBe('unknown')
    expect(normalizeKpi({ kpi_key: 'x', status: 'unknown', value: 4 })?.value).toBeNull()
    expect(normalizeKpi({ kpi_key: 'x', status: 'known', value: '0.5' })).toMatchObject({ status: 'known', value: 0.5 })
    expect(normalizeKpi({ kpi_key: 'x', status: 'unknown', source: { reason: 'not computed' } })?.reason).toBe('not computed')
  })

  it('decodes mission-codec property ids (pid_<g–p>) and leaves real ids alone', () => {
    expect(decodePid('pid_jhgggg')).toBe('310000')
    expect(decodePid('9100037')).toBe('9100037')
    expect(normalizeRef({ type: 'property', id: 'pid_jhgggg', label: 'A' })).toMatchObject({ type: 'property', id: '310000' })
    expect(normalizeRef({ property_id: 'pid_hh' })).toMatchObject({ type: 'property', id: '11' })
    expect(normalizeRef({ type: 'deal', id: 'o1' })?.type).toBe('opportunity')
    expect(normalizeRef({ type: 'nonsense', id: 'x' })).toBeNull()
  })

  it('a report keeps unknown EV and unknown costs as null, ranked by rank', () => {
    const r = normalizeReport({
      ranked: [{ rank: 2, components: { ev_usd: null, ev_reason: 'no MAO' }, cfo_verdict: 'challenge' }, { rank: 1, components: { ev_usd: 100 }, cfo_verdict: { verdict: 'bogus' } }],
      costs: { total_usd: 3, status: 'unknown', reason: 'ledger not linked' },
      refused: [{ label: 'held', reason: 'hold' }],
    })!
    expect(r.ranked.map((x) => x.rank)).toEqual([1, 2])
    expect(r.ranked[1].components.ev_usd).toBeNull()
    expect(r.ranked[1].cfo_verdict?.verdict).toBe('challenge')
    expect(r.ranked[0].cfo_verdict?.verdict).toBeNull()
    expect(r.costs).toMatchObject({ status: 'unknown', total_usd: null })
    expect(r.refused[0].reasons).toEqual(['hold'])
  })
})

describe('wf-flags', () => {
  it('fixtures exist only in DEV with VITE_LC_WF_FIXTURES=1', () => {
    expect(wfFixturesGate({ DEV: true, VITE_LC_WF_FIXTURES: '1' })).toBe(true)
    expect(wfFixturesGate({ DEV: false, VITE_LC_WF_FIXTURES: '1' })).toBe(false)
    expect(wfFixturesGate({ DEV: true })).toBe(false)
  })
})
