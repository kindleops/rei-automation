/**
 * LIVE TRANSPORT (S3) — the client half of the real agent event stream,
 * against the S3 backend (c0a16cf5, apps/api/src/lib/agent/live/live-routes.js):
 *
 *   GET  /api/cockpit/agent/live                          capability (gate, mode, AI, tools, sources)
 *   POST /api/cockpit/agent/live/quick-scan/preflight     { property_ids } → draft job, scope_hash, tools, sources, approvals, cancellation, blockers
 *   POST /api/cockpit/agent/live/quick-scan/confirm       { job_id, scope_hash } → 202 { run_id } (the run starts)
 *   GET  /api/cockpit/agent/live/runs                     server history (live runs only)
 *   GET  /api/cockpit/agent/live/runs/:id                 snapshot (reduced from events) + last_event_id
 *   GET  /api/cockpit/agent/live/runs/:id/events          ?after=<event_id>&timeout_ms≤25000 (long-poll) → { events, cursor, done }
 *   POST /api/cockpit/agent/live/runs/:id/cancel
 *
 * The routes exist only on a local, non-production API with AGENT_LIVE_ROUTES=1
 * (404 otherwise, before auth). The client holds a cursor (the last applied
 * event_id) and long-polls; events are applied exactly once in event_id
 * order. Live bodies carry live:true, fixture:false; a page or snapshot that
 * says fixture is refused — a fixture can never be presented as live.
 *
 * S3 scope: Quick Scan only — $0, T0 read-only, AI off. Nothing here can
 * start a billable operation: the server plans only non-billable Supabase
 * reads and refuses anything else.
 */
import { callBackend } from '../../../lib/api/backendClient'
import type { AgentEvent } from '../contracts/contracts'

const BASE = '/api/cockpit/agent/live'
export const LIVE_ENDPOINTS = {
  capability: BASE,
  preflight: `${BASE}/quick-scan/preflight`,
  confirm: `${BASE}/quick-scan/confirm`,
  runs: `${BASE}/runs`,
  run: (id: string) => `${BASE}/runs/${encodeURIComponent(id)}`,
  events: (id: string, after: number, timeoutMs: number) => `${BASE}/runs/${encodeURIComponent(id)}/events?after=${after}&timeout_ms=${timeoutMs}`,
  cancel: (id: string) => `${BASE}/runs/${encodeURIComponent(id)}/cancel`,
} as const

/** A source the server declares (Quick Scan registry descriptor). */
export interface LiveSourceDescriptor {
  source_id: string
  name: string
  authority_class?: string | null
  source_class?: string | null
  access_mode?: string | null
  host?: string | null
  jurisdiction?: string | null
  supports_negative?: boolean
  billable?: boolean
  finding_types?: string[]
  provenance?: string | null
  limitations?: string[]
}

/** A read tool the run may call (the preflight lists exactly these). */
export interface LiveToolDescriptor { name: string; label: string; tier: string; capability?: number | null; cost_class?: string | null; billable?: boolean; sources?: string[] }

export interface LiveCapability {
  live: boolean
  quick_scan: boolean
  /** effective agent mode (off · read · draft · write · full) */
  mode: string | null
  ai: 'off' | 'on' | null
  store: string | null
  tools: LiveToolDescriptor[]
  sources: LiveSourceDescriptor[]
  reason: string | null
}

export interface LivePreflight {
  job_id: string
  run_id: string | null
  scope_hash: string
  property_ids: string[]
  deferred_property_count: number
  scope_sentence: string | null
  estimate_label: string | null
  max_budget_usd: number
  tools: LiveToolDescriptor[]
  sources: LiveSourceDescriptor[]
  approval: { required: boolean; reason: string | null }
  cancellation: string | null
  limits: { max_per_batch: number | null; test_batch_max: number | null; concurrency: number | null }
  ai: { enabled: boolean; reason: string | null }
  mode: string | null
  can_run: boolean
  blockers: Array<{ code: string; message: string }>
  expires_at: string | null
  received_at: number
}

export interface LiveSnapshot {
  run_id: string
  kind: string | null
  state: string | null
  phase: string | null
  last_event_id: number
  fixture: boolean
  property_ids: string[]
  dispatcher_active: boolean
}

export interface LiveHistoryRow { run_id: string; title: string | null; state: string | null; property_count: number; created_at: string | null; ended_at: string | null }

export interface EventPage { events: AgentEvent[]; cursor: number; done: boolean }

export type LiveFailure = { ok: false; status: number; code: string; message: string }
export type LiveResult<T> = { ok: true; data: T } | LiveFailure

const fail = (status: number, code: string, message: string): LiveFailure => ({ ok: false, status, code, message })
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown) => (typeof v === 'string' && v.length ? v : null)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** callBackend wraps non-2xx bodies; recover the server's own { error, message }. */
function failure(res: { status: number; error?: string; message?: string; upstream?: unknown }, fallback: string): LiveFailure {
  const up = obj(res.upstream)
  return fail(res.status, str(up.error) ?? (res.status === 404 ? 'LIVE_ROUTE_NOT_MOUNTED' : res.error || fallback), str(up.message) ?? res.message ?? fallback)
}

export async function probeLive(signal?: AbortSignal): Promise<LiveResult<LiveCapability>> {
  const res = await callBackend<unknown>(LIVE_ENDPOINTS.capability, { signal, timeoutMs: 8000 })
  if (!res.ok) return failure(res, 'LIVE_PROBE_FAILED')
  const b = obj(res.data)
  if (b.fixture === true) return fail(res.status, 'FIXTURE_ON_LIVE_CHANNEL', 'The live probe answered as a fixture')
  const enabled = b.enabled === true || b.live === true
  return {
    ok: true,
    data: {
      live: enabled,
      quick_scan: enabled,
      mode: str(b.mode),
      ai: b.ai_enabled === true ? 'on' : b.ai_enabled === false ? 'off' : null,
      store: str(obj(b.store).kind),
      tools: arr<LiveToolDescriptor>(b.tools),
      sources: arr<LiveSourceDescriptor>(b.sources),
      reason: b.mode && b.mode !== 'read' && b.mode !== 'draft' && b.mode !== 'write' && b.mode !== 'full' ? `Agent mode is “${String(b.mode)}”: read tools are disabled (AGENT_MAX_MODE).` : null,
    },
  }
}

/** Draft the job server-side and get the exact scope to confirm. Nothing executes. */
export async function preflightQuickScan(propertyIds: string[]): Promise<LiveResult<LivePreflight>> {
  const res = await callBackend<unknown>(LIVE_ENDPOINTS.preflight, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ property_ids: propertyIds }), timeoutMs: 30_000 })
  if (!res.ok) return failure(res, 'PREFLIGHT_FAILED')
  const b = obj(res.data)
  if (b.fixture === true) return fail(res.status, 'FIXTURE_ON_LIVE_CHANNEL', 'The preflight answered as a fixture')
  const scope = obj(b.scope)
  const job_id = str(b.job_id); const scope_hash = str(b.scope_hash)
  if (!job_id || !scope_hash) return fail(res.status, 'PREFLIGHT_SHAPE', 'The preflight did not return a job and scope hash')
  const approval = obj(b.approval); const ai = obj(b.ai); const limits = obj(b.limits)
  return {
    ok: true,
    data: {
      job_id, run_id: str(b.run_id), scope_hash,
      property_ids: arr<string>(scope.property_ids).map(String),
      deferred_property_count: num(scope.deferred_property_count),
      scope_sentence: str(b.scope_sentence),
      estimate_label: str(obj(b.estimate).label),
      max_budget_usd: num(b.max_budget_usd),
      tools: arr<LiveToolDescriptor>(b.tools),
      sources: arr<LiveSourceDescriptor>(b.sources),
      approval: { required: approval.required === true, reason: str(approval.reason) },
      cancellation: str(b.cancellation),
      limits: { max_per_batch: numOrNull(limits.max_per_batch), test_batch_max: numOrNull(limits.test_batch_max), concurrency: numOrNull(limits.concurrency) },
      ai: { enabled: ai.enabled === true, reason: str(ai.reason) },
      mode: str(b.mode),
      can_run: b.can_run === true,
      blockers: arr<Record<string, unknown>>(b.blockers).map((x) => ({ code: String(x.code ?? ''), message: String(x.message ?? x.code ?? '') })),
      expires_at: str(b.expires_at),
      received_at: Date.now(),
    },
  }
}

/** Confirm the exact previewed scope (the scope hash must match) — the run starts on the server. */
export async function confirmQuickScan(jobId: string, scopeHash: string): Promise<LiveResult<{ run_id: string; state: string | null }>> {
  const res = await callBackend<unknown>(LIVE_ENDPOINTS.confirm, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job_id: jobId, scope_hash: scopeHash }), timeoutMs: 30_000 })
  if (!res.ok) return failure(res, 'CONFIRM_FAILED')
  const b = obj(res.data)
  const run_id = str(b.run_id)
  if (!run_id) return fail(res.status, 'CONFIRM_NO_RUN', 'The server did not return a run id')
  return { ok: true, data: { run_id, state: str(b.state) } }
}

export async function fetchSnapshot(runId: string, signal?: AbortSignal): Promise<LiveResult<LiveSnapshot>> {
  const res = await callBackend<unknown>(LIVE_ENDPOINTS.run(runId), { signal, timeoutMs: 15_000 })
  if (!res.ok) return failure(res, 'SNAPSHOT_FAILED')
  const b = obj(res.data)
  const run_id = str(b.run_id)
  if (!run_id) return fail(res.status, 'SNAPSHOT_SHAPE', 'Unexpected snapshot response')
  if (b.fixture === true) return fail(res.status, 'FIXTURE_ON_LIVE_CHANNEL', 'The server returned a fixture snapshot on the live channel')
  const job = obj(b.job)
  return { ok: true, data: { run_id, kind: str(b.kind), state: str(b.state), phase: str(b.phase), last_event_id: num(b.last_event_id), fixture: false, property_ids: arr<string>(job.property_ids).map(String), dispatcher_active: b.dispatcher_active === true } }
}

export async function fetchEvents(runId: string, after: number, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<LiveResult<EventPage>> {
  const wait = Math.max(0, Math.min(25_000, opts.timeoutMs ?? 20_000))
  const res = await callBackend<unknown>(LIVE_ENDPOINTS.events(runId, after, wait), { signal: opts.signal, timeoutMs: wait + 15_000 })
  if (!res.ok) return failure(res, 'EVENTS_FAILED')
  const b = obj(res.data)
  const raw = arr<AgentEvent>(b.events)
  // a fixture can never be presented as live — refuse the page outright
  if (b.fixture === true || raw.some((e) => e?.fixture === true)) return fail(res.status, 'FIXTURE_ON_LIVE_CHANNEL', 'Fixture events arrived on the live channel and were refused')
  const events = raw.filter((e) => e && typeof e.event_id === 'number' && e.event_id > after && e.visibility !== 'internal').sort((a, z) => a.event_id - z.event_id)
  return { ok: true, data: { events, cursor: num(b.cursor, events.length ? events[events.length - 1].event_id : after), done: b.done === true } }
}

export async function fetchLiveHistory(signal?: AbortSignal): Promise<LiveResult<LiveHistoryRow[]>> {
  const res = await callBackend<unknown>(`${LIVE_ENDPOINTS.runs}?limit=20`, { signal, timeoutMs: 10_000 })
  if (!res.ok) return failure(res, 'HISTORY_FAILED')
  const b = obj(res.data)
  return { ok: true, data: arr<Record<string, unknown>>(b.runs).filter((r) => r.fixture !== true).map((r) => ({ run_id: String(r.run_id), title: str(r.title), state: str(r.state), property_count: num(r.property_count), created_at: str(r.created_at), ended_at: str(r.ended_at) })) }
}

export async function requestLiveCancel(runId: string): Promise<LiveResult<{ state: string | null; pending: boolean }>> {
  const res = await callBackend<unknown>(LIVE_ENDPOINTS.cancel(runId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', timeoutMs: 15_000 })
  if (!res.ok) return failure(res, 'CANCEL_FAILED')
  const b = obj(res.data)
  return { ok: true, data: { state: str(b.job_state) ?? str(b.state), pending: b.pending === true } }
}

/** Human copy for transport failures (never "something went wrong"). */
export function liveFailureCopy(f: Pick<LiveFailure, 'code' | 'status' | 'message'>): string {
  switch (f.code) {
    case 'LIVE_ROUTE_NOT_MOUNTED': return 'Live Quick Scan is not available on this API (local dev only: AGENT_LIVE_ROUTES=1).'
    case 'RUN_NOT_FOUND': return 'The API no longer has this run (its local agent store was reset).'
    case 'FIXTURE_ON_LIVE_CHANNEL': return 'Fixture data arrived on the live channel and was refused.'
    case 'SESSION_REQUIRED': return 'An operator session is required for live runs.'
    case 'OPERATOR_MISMATCH': return 'This run was prepared by another operator session.'
    case 'JOB_SCOPE_CHANGED': return 'The scope changed since the preflight — preflight again.'
    case 'JOB_DRAFT_EXPIRED': return 'The preflight expired — preflight again.'
    case 'AGENT_MODE_CEILING': return 'Agent mode does not allow read tools (AGENT_MAX_MODE).'
    case 'TEST_BATCH_LIMIT': return 'More properties than the test-batch limit allows.'
    case 'PROPERTY_ID_INVALID': return 'A selected property id is not valid.'
    case 'READ_CLIENT_UNCONFIGURED': return 'The API has no read client configured for Quick Scan.'
    default:
      if (f.status === 401 || f.status === 403) return 'This session is not authorized for live agent runs.'
      if (f.status === 404) return 'The live agent route is not available on this API.'
      if (f.status === 0 || f.status === 503 || f.status === 504) return 'The API did not respond; retrying.'
      return f.message || f.code
  }
}
