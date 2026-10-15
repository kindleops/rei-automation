/**
 * INTELLIGENCE COMMAND — THE ONE TYPED CLIENT FILE.
 *
 * Every backend expectation of Intelligence Command lives here, so the
 * parallel backend work (rc-8.5.15 conversation-ai, rc-8.5.16 R3 executor,
 * the research.mission runtime handler) can be checked against one place.
 *
 * EXISTING at 6ecbae6b (verified in apps/api):
 *   ASK (research/research-routes.js) — used through agent/ask/ask-store + ask-transport:
 *     GET  /api/cockpit/agent/live/ask                 status: models, caps, spend, tools
 *     POST /api/cockpit/agent/live/ask                 { question, context: { campaign_id?, property_ids? }, wait_ms: 0 } → 202 { run_id }
 *     GET  /api/cockpit/agent/live/ask/:run_id         durable run (answer, audit, calls, typed result)
 *     GET  /api/cockpit/agent/live/ask/:run_id/events  text/event-stream (run-events.js types)
 *     POST /api/cockpit/agent/live/ask/:run_id/cancel
 *     Gate: 404 (empty body) unless AGENT_ENABLED + AGENT_LIVE_ROUTES (+ production pilot) + AGENT_RESEARCH_ENABLED.
 *     There is NO list endpoint for ask runs: run bodies are durable by id; the
 *     conversation index lives in this browser tab (ask-store, sessionStorage).
 *   QUICK SCAN history (live/live-routes.js): GET /api/cockpit/agent/live/runs (agent/runtime/live-transport).
 *   ACTIONS + APPROVALS (actions/routes.js):
 *     GET  /api/cockpit/agent/actions                  { ok, capabilities: CapabilityDescriptor[] }
 *     POST /api/cockpit/agent/actions/invoke           { capability_id, input } → InvokeOutcome
 *     GET  /api/cockpit/agent/actions/approvals        ?state=pending|all&limit=
 *     GET  /api/cockpit/agent/actions/approvals/:id    one approval + display-only preview
 *     POST /api/cockpit/agent/actions/approvals/:id/decide  { decision: approve|deny, payload_hash }
 *     Gate: 404 (empty body) unless AGENT_ENABLED + AGENT_CAPABILITIES_ENABLED; 503
 *     CAPABILITIES_UNCONFIGURED without AGENT_CAPABILITY_SECRET; schema PROPOSED_20261013120000_agent_capabilities.
 *   CONVERSATION AI SHADOW (app/api/cockpit/agent/conversation-ai/shadow/route.js):
 *     GET  /api/cockpit/agent/conversation-ai/shadow?limit=&outcome=  { ok, available, records[], code? }
 *     available:false + SHADOW_TABLE_NOT_APPLIED until PROPOSED_20261013160000_conversation_ai_shadow is applied.
 *   SHELL TELEMETRY: GET /api/cockpit/shell/telemetry — read through desktop/rail/rail-store (one shared poller).
 *
 * PROPOSED (not mounted at 6ecbae6b — every call answers 404 today and the UI
 * says "Missions runtime read route not deployed"). The R2 runtime rows are
 * agent.research_job (runtime_managed), agent.job_event and agent.runtime_status()
 * (PROPOSED_20261012140000_intel_runtime). Missions are CREATED today through
 * the existing capability `missions.create` (POST /actions/invoke); kinds with a
 * registered handler at 6ecbae6b: ops.health_check only.
 *     GET  /api/cockpit/agent/runtime/status                  → { ok, status: RuntimeStatus }      (agent.runtime_status())
 *     GET  /api/cockpit/agent/runtime/missions?kind=&limit=   → { ok, missions: RuntimeMission[] } (runtime_managed rows, newest first)
 *     GET  /api/cockpit/agent/runtime/missions/:job_id/events?after=  → { ok, events: RuntimeJobEvent[], cursor }
 *     POST /api/cockpit/agent/runtime/missions/:job_id/cancel → { ok, state }                       (agent.runtime_cancel)
 */
import { callBackend, type BackendResult } from '../../../lib/api/backendClient'
import { decideApproval as decideApprovalRaw, getApproval as getApprovalRaw, listApprovals as listApprovalsRaw, type CapabilityApproval, type DecideOutcome } from '../../agent/approvals/approvals-transport'

export type { CapabilityApproval, DecideOutcome }

/* ── plane availability: every failure is a named, truthful state ─────── */

export type PlaneId = 'ask' | 'actions' | 'shadow' | 'runtime' | 'telemetry'
export type PlaneFailureState = 'not_enabled' | 'session' | 'denied' | 'locked' | 'unavailable' | 'error'
export interface PlaneFailure { ok: false; state: PlaneFailureState; status: number; code: string; message: string; next: string | null }
export type PlaneResult<T> = { ok: true; data: T } | PlaneFailure

/** What has to be true on the server for each plane (from the route gates in apps/api). */
export const PLANE_NEXT_STEP: Record<PlaneId, string> = {
  ask: 'Research agent route is off: AGENT_ENABLED=1, AGENT_LIVE_ROUTES=1 (production: AGENT_LIVE_PRODUCTION_PILOT=1 + AGENT_STORE=postgres) and AGENT_RESEARCH_ENABLED=1; schema PROPOSED_20261010130000_agent_research_ro.',
  actions: 'Actions plane not enabled: AGENT_ENABLED=1 + AGENT_CAPABILITIES_ENABLED=1 and AGENT_CAPABILITY_SECRET (≥16 chars); schema PROPOSED_20261013120000_agent_capabilities. Writes also need AGENT_CAPABILITIES_WRITES_ENABLED=1 with the read-only switch lifted.',
  shadow: 'Conversation AI shadow table not applied: PROPOSED_20261013160000_conversation_ai_shadow.',
  runtime: 'Missions runtime read route not deployed: needs GET /api/cockpit/agent/runtime/* (not in this build), schema PROPOSED_20261012140000_intel_runtime, AGENT_RUNTIME_ENABLED=1 + CRON_AGENT_RUNTIME_ENABLED=true, and agent.runtime_limits.runtime_enabled armed by a named operator.',
  telemetry: 'Shell telemetry is unreachable from this browser.',
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null)
const numOrNull = (v: unknown): number | null => { const n = typeof v === 'string' && v !== '' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null }

export function classifyPlane(plane: PlaneId, status: number, code: string | null | undefined, message?: string | null): PlaneFailure {
  const c = code || (status === 404 ? 'NOT_MOUNTED' : status ? `HTTP_${status}` : 'UNREACHABLE')
  const msg = message || c
  if (status === 404 && (!code || code === 'NOT_MOUNTED' || code === 'APPROVALS_NOT_MOUNTED')) return { ok: false, state: 'not_enabled', status, code: c, message: PLANE_NEXT_STEP[plane], next: PLANE_NEXT_STEP[plane] }
  if (status === 401) return { ok: false, state: 'session', status, code: c, message: 'Sign in again: a verified operator session is required.', next: null }
  if (status === 403) return { ok: false, state: 'denied', status, code: c, message: c === 'NOT_A_MEMBER' ? 'Your account is not a member of this organization.' : 'This account is not on the agent allowlist.', next: 'An owner adds the user to AGENT_ALLOWED_USER_IDS ∩ OPS_ALLOWED_USER_IDS.' }
  if (status === 423) return { ok: false, state: 'locked', status, code: c, message: msg, next: c === 'CAPABILITY_WRITES_DISABLED' || c === 'AGENT_READ_ONLY' ? 'Writes are switched off on the server (AGENT_CAPABILITIES_WRITES_ENABLED / AGENT_READ_ONLY).' : null }
  if (status === 503) return { ok: false, state: 'unavailable', status, code: c, message: c === 'CAPABILITIES_UNCONFIGURED' ? 'The actions plane is on but unconfigured (AGENT_CAPABILITY_SECRET missing).' : msg, next: null }
  return { ok: false, state: 'error', status, code: c, message: msg, next: null }
}

export const isHtml404 = (res: { ok: boolean; error?: string; message?: string }) => !res.ok && res.error === 'BACKEND_HTML_ERROR' && /^\[404\]/.test(res.message ?? '')

function fromBackend<T>(plane: PlaneId, res: BackendResult<unknown>, map: (body: Record<string, unknown>) => T): PlaneResult<T> {
  if (!res.ok) {
    // an unmounted Next route answers an HTML 404 page, which the backend client reports as 502 BACKEND_HTML_ERROR "[404] …"
    if (isHtml404(res)) return classifyPlane(plane, 404, null)
    const up = obj(res.upstream)
    return classifyPlane(plane, res.status, str(up.error) ?? str(up.code) ?? (res.status === 404 ? null : res.error), str(up.message) ?? null)
  }
  const b = obj(res.data)
  if (b.fixture === true) return { ok: false, state: 'error', status: res.status, code: 'FIXTURE_ON_LIVE_CHANNEL', message: 'A fixture arrived on the live channel and was refused.', next: null }
  return { ok: true, data: map(b) }
}

/* ── actions plane ─────────────────────────────────────────────────────── */

export interface CapabilityDescriptor {
  id: string
  version: number
  domain: string
  title: string
  side_effect: 'read' | 'internal_write' | 'outbound_prepare' | string
  tier: 'autonomous_internal' | 'requires_explicit_approval' | string
  service: string | null
  approval_class: string | null
  limits: { per_min?: number; per_day?: number } | null
}

export const ACTIONS_ENDPOINTS = {
  catalog: '/api/cockpit/agent/actions',
  invoke: '/api/cockpit/agent/actions/invoke',
} as const

export function normalizeCapabilities(body: Record<string, unknown>): CapabilityDescriptor[] {
  return arr<Record<string, unknown>>(body.capabilities).map((c) => ({
    id: String(c.id ?? ''), version: Number(c.version) || 1, domain: String(c.domain ?? ''), title: String(c.title ?? c.id ?? ''),
    side_effect: String(c.side_effect ?? ''), tier: String(c.tier ?? ''), service: str(c.service), approval_class: str(c.approval_class),
    limits: c.limits && typeof c.limits === 'object' ? (c.limits as CapabilityDescriptor['limits']) : null,
  })).filter((c) => c.id)
}

export async function fetchCapabilities(signal?: AbortSignal): Promise<PlaneResult<CapabilityDescriptor[]>> {
  const res = await callBackend<unknown>(ACTIONS_ENDPOINTS.catalog, { signal, timeoutMs: 12_000 })
  return fromBackend('actions', res, normalizeCapabilities)
}

export interface InvokeOutcome {
  ok: boolean
  status: 'read' | 'executed' | 'replayed' | 'approval_pending' | 'refused' | 'failed' | string
  capability_id: string | null
  approval_id: string | null
  expires_at: string | null
  deduped: boolean
  code: string | null
  result: unknown
}

export function normalizeInvoke(b: Record<string, unknown>): InvokeOutcome {
  return { ok: b.ok === true, status: String(b.status ?? (b.ok ? 'executed' : 'refused')), capability_id: str(b.capability_id), approval_id: str(b.approval_id), expires_at: str(b.expires_at), deduped: b.deduped === true, code: str(b.code), result: b.result ?? null }
}

/** Operator-initiated capability call (the server applies the same enforcement as a model call). */
export async function invokeCapability(capability_id: string, input: Record<string, unknown>): Promise<PlaneResult<InvokeOutcome>> {
  const res = await callBackend<unknown>(ACTIONS_ENDPOINTS.invoke, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability_id, input }), timeoutMs: 60_000 })
  // a refusal (422 / 423 / 409) still carries the server's outcome body — show it, never a guess
  if (!res.ok) {
    if (isHtml404(res)) return classifyPlane('actions', 404, null)
    const up = obj(res.upstream)
    if ('status' in up || 'code' in up) {
      if (res.status === 404 && !('status' in up)) return classifyPlane('actions', 404, null)
      return { ok: true, data: normalizeInvoke(up) }
    }
  }
  return fromBackend('actions', res, normalizeInvoke)
}

function approvalsFailure(r: { status: number; code: string; message: string }): PlaneFailure {
  if (r.code === 'APPROVALS_NOT_MOUNTED' || (r.code === 'BACKEND_HTML_ERROR' && /^\[404\]/.test(r.message))) return classifyPlane('actions', 404, null)
  return classifyPlane('actions', r.status, r.code, r.message)
}

export async function listApprovals(state: 'pending' | 'all' = 'pending', signal?: AbortSignal): Promise<PlaneResult<CapabilityApproval[]>> {
  const r = await listApprovalsRaw(state, signal)
  return r.ok ? { ok: true, data: r.data } : approvalsFailure(r)
}

export async function getApproval(id: string, signal?: AbortSignal): Promise<PlaneResult<CapabilityApproval>> {
  const r = await getApprovalRaw(id, signal)
  return r.ok ? { ok: true, data: r.data } : approvalsFailure(r)
}

/** Approve / deny EXACTLY the approval that was shown: its id and the payload hash the server issued. */
export async function decideApproval(a: Pick<CapabilityApproval, 'approval_id' | 'payload_hash'>, decision: 'approve' | 'deny'): Promise<PlaneResult<DecideOutcome>> {
  const r = await decideApprovalRaw({ approval_id: a.approval_id, payload_hash: a.payload_hash }, decision)
  return r.ok ? { ok: true, data: r.data } : approvalsFailure(r)
}

/* ── conversation-ai shadow (read only) ───────────────────────────────── */

export interface ShadowRecord {
  inbound_message_id: string
  created_at: string | null
  thread_ref: string | null
  property_ids: string[]
  seller_message_masked: string | null
  intent: string | null
  seller_interest: string | null
  confidence: number | null
  stage: string | null
  outcome: string | null
  next_objective: string | null
  draft: string | null
  validation: string | null
  path: string | null
  models: string[]
  cost_usd: number | null
  latency_ms: number | null
}
export interface ShadowPage { available: boolean; code: string | null; records: ShadowRecord[] }

export function normalizeShadow(b: Record<string, unknown>): ShadowPage {
  const records = arr<Record<string, unknown>>(b.records).map((r): ShadowRecord => {
    const u = obj(r.understood); const d = obj(r.decision); const s = obj(r.stage_evidence); const m = obj(r.model); const dr = obj(r.draft); const v = obj(r.validation); const c = obj(r.cost)
    return {
      inbound_message_id: String(r.inbound_message_id ?? ''), created_at: str(r.created_at), thread_ref: str(r.thread_ref), property_ids: arr(r.property_ids).map(String),
      seller_message_masked: str(r.seller_message_masked), intent: str(u.intent), seller_interest: str(u.seller_interest), confidence: numOrNull(u.confidence),
      stage: str(s.stage), outcome: str(d.outcome), next_objective: str(d.next_objective), draft: str(dr.text), validation: str(v.status), path: str(m.path),
      models: arr(m.models).map(String), cost_usd: numOrNull(c.total_usd), latency_ms: numOrNull(r.latency_ms),
    }
  }).filter((r) => r.inbound_message_id)
  return { available: b.available === true, code: str(b.code), records }
}

export async function fetchShadow(limit = 50, signal?: AbortSignal): Promise<PlaneResult<ShadowPage>> {
  const res = await callBackend<unknown>(`/api/cockpit/agent/conversation-ai/shadow?limit=${limit}`, { signal, timeoutMs: 12_000 })
  return fromBackend('shadow', res, normalizeShadow)
}

/* ── R2 runtime missions (PROPOSED read routes) ───────────────────────── */

export type RuntimeJobState = 'queued' | 'claimed' | 'running' | 'completed' | 'waiting_for_approval' | 'paused' | 'retrying' | 'failed' | 'cancelled' | 'budget_blocked' | 'dead_letter'
export interface RuntimeMission {
  job_id: string
  kind: string
  state: RuntimeJobState | string
  requested_by: string | null
  trigger_kind: string | null
  attempt: number
  max_attempts: number
  priority: number
  budget_cap_usd: number
  progress: Record<string, unknown>
  result: Record<string, unknown> | null
  last_error: Record<string, unknown> | null
  created_at: string | null
  updated_at: string | null
  ended_at: string | null
  heartbeat_at: string | null
}
export interface RuntimeJobEvent { id: number; job_id: string; at: string | null; type: string; state: string; attempt: number; actor: string; payload: Record<string, unknown> }
export interface RuntimeStatus {
  at: string | null
  limits: { runtime_enabled: boolean; emergency_stop: boolean; max_concurrency_global: number | null; kind_limits: Record<string, unknown> } | null
  open: Record<string, number>
  ended_24h: Record<string, number>
  heartbeats: Array<{ worker_id: string; last_tick_at: string | null; ticks: number; age_s: number | null }>
  schedules: Array<{ schedule_id: number; name: string; kind: string; enabled: boolean; interval_seconds: number; next_run_at: string | null; last_outcome: string | null }>
}

export const RUNTIME_ENDPOINTS = {
  status: '/api/cockpit/agent/runtime/status',
  missions: (kind?: string) => `/api/cockpit/agent/runtime/missions?limit=50${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`,
  events: (jobId: string, after = 0) => `/api/cockpit/agent/runtime/missions/${encodeURIComponent(jobId)}/events${after ? `?after=${after}` : ''}`,
  cancel: (jobId: string) => `/api/cockpit/agent/runtime/missions/${encodeURIComponent(jobId)}/cancel`,
} as const

/** Kinds with a registered runtime handler at 6ecbae6b (capabilities/defs/platform.js MISSION_KINDS). */
export const KNOWN_MISSION_KINDS = ['ops.health_check'] as const
/** The research mission kind the backend agent is adding (agent.runtime_enqueue 'research.mission'). */
export const RESEARCH_MISSION_KIND = 'research.mission'

const numMap = (v: unknown): Record<string, number> => Object.fromEntries(Object.entries(obj(v)).map(([k, n]) => [k, Number(n) || 0]))

export function normalizeRuntimeStatus(b: Record<string, unknown>): RuntimeStatus {
  const s = obj(b.status ?? b)
  const lim = s.limits && typeof s.limits === 'object' ? obj(s.limits) : null
  return {
    at: str(s.at),
    limits: lim ? { runtime_enabled: lim.runtime_enabled === true, emergency_stop: lim.emergency_stop === true, max_concurrency_global: numOrNull(lim.max_concurrency_global), kind_limits: obj(lim.kind_limits) } : null,
    open: numMap(s.open), ended_24h: numMap(s.ended_24h),
    heartbeats: arr<Record<string, unknown>>(s.heartbeats).map((h) => ({ worker_id: String(h.worker_id ?? ''), last_tick_at: str(h.last_tick_at), ticks: Number(h.ticks) || 0, age_s: numOrNull(h.age_s) })),
    schedules: arr<Record<string, unknown>>(s.schedules).map((x) => ({ schedule_id: Number(x.schedule_id) || 0, name: String(x.name ?? ''), kind: String(x.kind ?? ''), enabled: x.enabled === true, interval_seconds: Number(x.interval_seconds) || 0, next_run_at: str(x.next_run_at), last_outcome: str(x.last_outcome) })),
  }
}

export function normalizeMissions(b: Record<string, unknown>): RuntimeMission[] {
  return arr<Record<string, unknown>>(b.missions).map((m) => ({
    job_id: String(m.job_id ?? ''), kind: String(m.kind ?? ''), state: String(m.state ?? ''), requested_by: str(m.requested_by), trigger_kind: str(m.trigger_kind),
    attempt: Number(m.attempt) || 0, max_attempts: Number(m.max_attempts) || 0, priority: Number(m.priority) || 0, budget_cap_usd: Number(m.budget_cap_usd) || 0,
    progress: obj(m.progress), result: m.result && typeof m.result === 'object' ? obj(m.result) : null, last_error: m.last_error && typeof m.last_error === 'object' ? obj(m.last_error) : null,
    created_at: str(m.created_at), updated_at: str(m.updated_at), ended_at: str(m.ended_at), heartbeat_at: str(m.heartbeat_at),
  })).filter((m) => m.job_id)
}

export function normalizeJobEvents(b: Record<string, unknown>): RuntimeJobEvent[] {
  return arr<Record<string, unknown>>(b.events).map((e) => ({ id: Number(e.id) || 0, job_id: String(e.job_id ?? ''), at: str(e.at), type: String(e.type ?? ''), state: String(e.state ?? ''), attempt: Number(e.attempt) || 0, actor: String(e.actor ?? ''), payload: obj(e.payload) }))
}

export async function fetchRuntimeStatus(signal?: AbortSignal): Promise<PlaneResult<RuntimeStatus>> {
  return fromBackend('runtime', await callBackend<unknown>(RUNTIME_ENDPOINTS.status, { signal, timeoutMs: 10_000 }), normalizeRuntimeStatus)
}
export async function fetchMissions(kind?: string, signal?: AbortSignal): Promise<PlaneResult<RuntimeMission[]>> {
  return fromBackend('runtime', await callBackend<unknown>(RUNTIME_ENDPOINTS.missions(kind), { signal, timeoutMs: 12_000 }), normalizeMissions)
}
export async function fetchMissionEvents(jobId: string, after = 0, signal?: AbortSignal): Promise<PlaneResult<RuntimeJobEvent[]>> {
  return fromBackend('runtime', await callBackend<unknown>(RUNTIME_ENDPOINTS.events(jobId, after), { signal, timeoutMs: 12_000 }), normalizeJobEvents)
}
export async function cancelMission(jobId: string): Promise<PlaneResult<{ state: string | null }>> {
  return fromBackend('runtime', await callBackend<unknown>(RUNTIME_ENDPOINTS.cancel(jobId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', timeoutMs: 10_000 }), (b) => ({ state: str(b.state) }))
}

/** Create a persistent mission through the EXISTING capability (agent.runtime_enqueue). */
export async function createMission(kind: string, input: Record<string, unknown> = {}): Promise<PlaneResult<InvokeOutcome>> {
  return invokeCapability('missions.create', { kind, ...input })
}

/** Platform health through the existing read capability (operator-initiated). */
export async function fetchPlatformHealth(): Promise<PlaneResult<InvokeOutcome>> {
  return invokeCapability('platform.health', {})
}
