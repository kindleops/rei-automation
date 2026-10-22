/**
 * WORKFORCE — THE ONE TYPED CLIENT FILE (docs/WORKFORCE.md §7).
 *
 *   GET       /api/cockpit/workforce/overview
 *   GET/POST  /api/cockpit/workforce/employees
 *   GET       /api/cockpit/workforce/employees/[id]
 *   GET/POST  /api/cockpit/workforce/missions            POST { directive, client_request_id } → { mission }
 *   GET       /api/cockpit/workforce/missions/[id]
 *   POST      /api/cockpit/workforce/missions/[id]/cancel
 *   GET       /api/cockpit/workforce/assignments?status=&employee=
 *   GET       /api/cockpit/workforce/events?after=&mission=
 *   GET/POST  /api/cockpit/workforce/command             POST { content, client_request_id } → { messages, mission? }
 *   GET/POST  /api/cockpit/workforce/authority
 *   GET       /api/cockpit/workforce/kpis
 *   GET       /api/cockpit/workforce/reports
 *
 * Envelope { ok: true, data } / { ok: false, error, message }. Every route
 * answers 404 unless AGENT_ENABLED and WORKFORCE_ENABLED=1, which the UI
 * shows as "not enabled" with the switches, never as an empty organization.
 * Mutations never carry the operator: the server reads the session.
 *
 * Fixture data answers only in a dev server started with VITE_LC_WF_FIXTURES=1
 * (the guard is inlined so a production build drops the fixture chunk). A
 * body marked `fixture: true` arriving on the live channel is refused.
 */
import { callBackend, type BackendResult } from '../../../lib/api/backendClient'
import {
  normalizeAssignments, normalizeAuthority, normalizeCommand, normalizeEmployee, normalizeEmployees, normalizeEventsPage, normalizeKpis,
  normalizeMessages, normalizeMission, normalizeMissionDetail, normalizeMissions, normalizeOverview, normalizePolicy, normalizeProfile, normalizeReports, obj, str,
} from './wf-normalize'
import type {
  WfAssignment, WfAssignmentStatus, WfAuthority, WfCommandResult, WfEmployee, WfEmployeeProfile, WfEventsPage, WfExecMessage, WfKpi,
  WfMission, WfMissionDetail, WfMissionStatus, WfOverview, WfPolicy, WfReports,
} from './wf-types'

export const WF_BASE = '/api/cockpit/workforce'

/* ── failures: every one is a named, truthful state ───────────────────── */

export type WfFailureState = 'not_enabled' | 'session' | 'denied' | 'conflict' | 'refused' | 'locked' | 'unavailable' | 'cancelled' | 'error'
export interface WfFailure { ok: false; state: WfFailureState; status: number; code: string; message: string; next: string | null }
export type WfResult<T> = { ok: true; data: T; fixture: boolean } | WfFailure

export const WF_NOT_ENABLED_NEXT = 'Workforce routes answer 404 until the API runs with AGENT_ENABLED=1 and WORKFORCE_ENABLED=1 (schema PROPOSED_20261022100000_workforce_foundation applied). Runtime kinds workforce.* stay unclaimed until the owner arms kind_limits.'

export function classifyWf(status: number, code: string | null | undefined, message?: string | null): WfFailure {
  const c = code || (status === 404 ? 'NOT_MOUNTED' : status ? `HTTP_${status}` : 'UNREACHABLE')
  const msg = message || c
  if (status === 499) return { ok: false, state: 'cancelled', status, code: c, message: 'Cancelled', next: null }
  if (status === 404 && (!code || code === 'NOT_MOUNTED' || code === 'NOT_FOUND_ROUTE' || code === 'WORKFORCE_DISABLED')) return { ok: false, state: 'not_enabled', status, code: c, message: 'Workforce is not enabled on this server.', next: WF_NOT_ENABLED_NEXT }
  if (status === 401) return { ok: false, state: 'session', status, code: c, message: 'Sign in again: a verified operator session is required.', next: null }
  if (status === 403) return { ok: false, state: 'denied', status, code: c, message: c === 'CEO_ONLY' || c === 'FORBIDDEN' ? 'Only the CEO (the owner) can make this change.' : 'This account is not on the agent allowlist.', next: c === 'CEO_ONLY' || c === 'FORBIDDEN' ? null : 'An owner adds the user to AGENT_ALLOWED_USER_IDS and OPS_ALLOWED_USER_IDS.' }
  if (status === 409) return { ok: false, state: 'conflict', status, code: c, message: msg, next: null }
  if (status === 422 || status === 400) return { ok: false, state: 'refused', status, code: c, message: c === 'PAYLOAD_REFUSED' ? 'The text was refused: phone numbers and email addresses cannot be stored in Workforce.' : msg, next: null }
  if (status === 423) return { ok: false, state: 'locked', status, code: c, message: msg, next: c === 'EMERGENCY_STOP' ? 'The runtime emergency stop is ON. Only the owner lifts it.' : null }
  if (status === 503 || status === 504) return { ok: false, state: 'unavailable', status, code: c, message: msg, next: null }
  return { ok: false, state: 'error', status, code: c, message: msg, next: null }
}

const isHtml404 = (res: { ok: boolean; error?: string; message?: string }) => !res.ok && res.error === 'BACKEND_HTML_ERROR' && /^\[404\]/.test(res.message ?? '')

/** BackendResult (whole body) → the payload under `data`, or a classified failure. */
export function fromBackend<T>(res: BackendResult<unknown>, map: (data: unknown) => T, fixture = false): WfResult<T> {
  if (!res.ok) {
    // an unmounted Next route answers an HTML 404 page, which the backend client reports as 502 BACKEND_HTML_ERROR "[404] …"
    if (isHtml404(res)) return classifyWf(404, null)
    const up = obj(res.upstream)
    return classifyWf(res.status, str(up.error) ?? str(up.code) ?? (res.status === 404 ? null : res.error), str(up.message))
  }
  const body = obj(res.data)
  if (body.fixture === true && !fixture) return { ok: false, state: 'error', status: res.status, code: 'FIXTURE_ON_LIVE_CHANNEL', message: 'A fixture arrived on the live channel and was refused.', next: null }
  if (body.ok === false) return classifyWf(res.status, str(body.error), str(body.message))
  return { ok: true, data: map('data' in body ? body.data : body), fixture }
}

/* ── transport (live, fixtures, or a test double) ─────────────────────── */

export interface WfRequest { method: 'GET' | 'POST'; path: string; body?: unknown; signal?: AbortSignal }
export type WfTransport = (req: WfRequest) => Promise<BackendResult<unknown>>

let testTransport: WfTransport | null = null
/** Tests only: route every call through a double. */
export function setWfTransport(t: WfTransport | null) { testTransport = t }

let fixtureTransport: Promise<WfTransport> | null = null
function fixtures(): Promise<WfTransport> | null {
  if (!(import.meta.env.DEV && import.meta.env.VITE_LC_WF_FIXTURES === '1')) return null
  if (!fixtureTransport) fixtureTransport = import('../fixtures/wf-fixture-server').then((m) => m.wfFixtureTransport)
  return fixtureTransport
}

const live: WfTransport = (req) => callBackend<unknown>(req.path, {
  method: req.method,
  signal: req.signal,
  ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
})

async function send<T>(req: WfRequest, map: (data: unknown) => T): Promise<WfResult<T>> {
  if (testTransport) return fromBackend(await testTransport(req), map)
  const fx = fixtures()
  if (fx) return fromBackend(await (await fx)(req), map, true)
  return fromBackend(await live(req), map)
}

/** Whether this build answers from fixtures (the FIXTURE label reads this). */
export const wfFixturesOn = (): boolean => import.meta.env.DEV && import.meta.env.VITE_LC_WF_FIXTURES === '1'

export function qs(params: Record<string, string | number | null | undefined>): string {
  const parts = Object.entries(params).flatMap(([k, v]) => (v === null || v === undefined || v === '' ? [] : [`${k}=${encodeURIComponent(String(v))}`]))
  return parts.length ? `?${parts.join('&')}` : ''
}
const enc = encodeURIComponent
// Workforce × Agntei: the register answer's link steps (api/wf-agntei.ts)
import { normalizeLinkSteps } from './wf-agntei'

/** One id per submission; a retry of the SAME submission reuses it (the server replays the same mission). */
export function newClientRequestId(): string {
  try { if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID() } catch { /* fall through */ }
  return `wfc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/* ── endpoints ─────────────────────────────────────────────────────────── */

export const getOverview = (signal?: AbortSignal): Promise<WfResult<WfOverview>> =>
  send({ method: 'GET', path: `${WF_BASE}/overview`, signal }, normalizeOverview)

export const listEmployees = (signal?: AbortSignal): Promise<WfResult<WfEmployee[]>> =>
  send({ method: 'GET', path: `${WF_BASE}/employees`, signal }, normalizeEmployees)

/** CEO only (the server checks the session). Create or update one employee row. */
export const upsertEmployee = (employee: Partial<WfEmployee> & { employee_id: string }, signal?: AbortSignal): Promise<WfResult<WfEmployee | null>> =>
  send({ method: 'POST', path: `${WF_BASE}/employees`, body: { employee }, signal }, (d) => normalizeEmployee(obj(d).employee ?? d))

/**
 * CEO only (the server checks the owner membership of the SESSION). "Register an Agntei agent": POST /employees
 * { op: 'register_agntei', employee } creates a pending_link operator_ai employee with NO principal and NO grant, and
 * answers the owner's exact link steps (mint → principal → grants → bind → connect → link). Nothing is executed.
 */
export const registerAgnteiAgent = (employee: { employee_id: string; role_key: string; display_name: string; markets?: string[]; skills?: string[]; property_specializations?: string[]; manager_employee_id?: string | null; employee_code?: string | null }, signal?: AbortSignal): Promise<WfResult<import('./wf-types').WfRegisterResult>> =>
  send({ method: 'POST', path: `${WF_BASE}/employees`, body: { op: 'register_agntei', employee }, signal }, (d) => {
    const o = obj(d)
    return { employee: normalizeEmployee(o.employee), link: normalizeLinkSteps(o.link), executed: o.executed === true }
  })

export const getEmployee = (id: string, signal?: AbortSignal): Promise<WfResult<WfEmployeeProfile | null>> =>
  send({ method: 'GET', path: `${WF_BASE}/employees/${enc(id)}`, signal }, normalizeProfile)

export const listMissions = (p: { status?: WfMissionStatus | null; limit?: number; before?: string | null } = {}, signal?: AbortSignal): Promise<WfResult<WfMission[]>> =>
  send({ method: 'GET', path: `${WF_BASE}/missions${qs({ status: p.status, limit: p.limit, before: p.before })}`, signal }, normalizeMissions)

export const submitDirective = (directive: string, clientRequestId: string, signal?: AbortSignal): Promise<WfResult<WfMission | null>> =>
  send({ method: 'POST', path: `${WF_BASE}/missions`, body: { directive, client_request_id: clientRequestId }, signal }, (d) => normalizeMission(obj(d).mission ?? d))

export const getMission = (id: string, signal?: AbortSignal): Promise<WfResult<WfMissionDetail | null>> =>
  send({ method: 'GET', path: `${WF_BASE}/missions/${enc(id)}`, signal }, normalizeMissionDetail)

export const cancelMission = (id: string, signal?: AbortSignal): Promise<WfResult<WfMission | null>> =>
  send({ method: 'POST', path: `${WF_BASE}/missions/${enc(id)}/cancel`, body: {}, signal }, (d) => normalizeMission(obj(d).mission ?? d))

export const listAssignments = (p: { status?: WfAssignmentStatus | null; employee?: string | null } = {}, signal?: AbortSignal): Promise<WfResult<WfAssignment[]>> =>
  send({ method: 'GET', path: `${WF_BASE}/assignments${qs({ status: p.status, employee: p.employee })}`, signal }, normalizeAssignments)

/**
 * The operations feed. `after` pages forward (new events); `before` pages
 * back (ASSUMED beyond §7, which names only `after`); `limit` bounds a page.
 */
export const listEvents = (p: { after?: number | null; before?: number | null; mission?: string | null; limit?: number } = {}, signal?: AbortSignal): Promise<WfResult<WfEventsPage>> =>
  send({ method: 'GET', path: `${WF_BASE}/events${qs({ after: p.after, before: p.before, mission: p.mission, limit: p.limit })}`, signal }, normalizeEventsPage)

export const getCommand = (p: { mission?: string | null } = {}, signal?: AbortSignal): Promise<WfResult<WfExecMessage[]>> =>
  send({ method: 'GET', path: `${WF_BASE}/command${qs({ mission: p.mission })}`, signal }, normalizeMessages)

export const postCommand = (content: string, clientRequestId: string, signal?: AbortSignal): Promise<WfResult<WfCommandResult>> =>
  send({ method: 'POST', path: `${WF_BASE}/command`, body: { content, client_request_id: clientRequestId }, signal }, normalizeCommand)

export const getAuthority = (signal?: AbortSignal): Promise<WfResult<WfAuthority>> =>
  send({ method: 'GET', path: `${WF_BASE}/authority`, signal }, normalizeAuthority)

/** CEO only: put or revoke a policy. */
export const putPolicy = (policy: Partial<WfPolicy> & { action_key: string }, signal?: AbortSignal): Promise<WfResult<WfPolicy | null>> =>
  send({ method: 'POST', path: `${WF_BASE}/authority`, body: { op: 'put', policy }, signal }, (d) => normalizePolicy(obj(d).policy ?? d))
export const revokePolicy = (policyId: string, signal?: AbortSignal): Promise<WfResult<WfPolicy | null>> =>
  send({ method: 'POST', path: `${WF_BASE}/authority`, body: { op: 'revoke', policy_id: policyId }, signal }, (d) => normalizePolicy(obj(d).policy ?? d))

export const getKpis = (signal?: AbortSignal): Promise<WfResult<WfKpi[]>> =>
  send({ method: 'GET', path: `${WF_BASE}/kpis`, signal }, normalizeKpis)

export const getReports = (signal?: AbortSignal): Promise<WfResult<WfReports>> =>
  send({ method: 'GET', path: `${WF_BASE}/reports`, signal }, normalizeReports)
