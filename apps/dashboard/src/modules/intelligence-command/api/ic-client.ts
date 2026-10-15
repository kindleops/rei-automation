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
 * MISSIONS (rc-8.5.18, docs/agent-missions-api.md — not mounted at 6ecbae6b;
 * until it is deployed and AGENT_MISSIONS_ENABLED=1 every call answers 404 and
 * the UI says "Missions API not enabled" with the switches):
 *     GET  /api/cockpit/agent/missions                 list (scope, kind, state, limit, before)
 *     GET  /api/cockpit/agent/missions/:id             detail (events_after for incremental polling)
 *     POST /api/cockpit/agent/missions                 create mission.research | mission.supervisor
 *     POST /api/cockpit/agent/missions/:id/cancel      cancel (cascades to children)
 * Missions run on the R2 runtime (agent.research_job / agent.job_event) and keep
 * running with the browser closed; the browser only creates, watches and cancels.
 */
import { callBackend, type BackendResult } from '../../../lib/api/backendClient'
import { decideApproval as decideApprovalRaw, getApproval as getApprovalRaw, listApprovals as listApprovalsRaw, type CapabilityApproval, type DecideOutcome } from '../../agent/approvals/approvals-transport'

export type { CapabilityApproval, DecideOutcome }

/* ── plane availability: every failure is a named, truthful state ─────── */

export type PlaneId = 'ask' | 'actions' | 'shadow' | 'missions' | 'telemetry'
export type PlaneFailureState = 'not_enabled' | 'session' | 'denied' | 'locked' | 'unavailable' | 'error'
export interface PlaneFailure { ok: false; state: PlaneFailureState; status: number; code: string; message: string; next: string | null }
export type PlaneResult<T> = { ok: true; data: T } | PlaneFailure

/** What has to be true on the server for each plane (from the route gates in apps/api). */
export const PLANE_NEXT_STEP: Record<PlaneId, string> = {
  ask: 'Research agent route is off: AGENT_ENABLED=1, AGENT_LIVE_ROUTES=1 (production: AGENT_LIVE_PRODUCTION_PILOT=1 + AGENT_STORE=postgres) and AGENT_RESEARCH_ENABLED=1; schema PROPOSED_20261010130000_agent_research_ro.',
  actions: 'Actions plane not enabled: AGENT_ENABLED=1 + AGENT_CAPABILITIES_ENABLED=1 and AGENT_CAPABILITY_SECRET (≥16 chars); schema PROPOSED_20261013120000_agent_capabilities. Writes also need AGENT_CAPABILITIES_WRITES_ENABLED=1 with the read-only switch lifted.',
  shadow: 'Conversation AI shadow table not applied: PROPOSED_20261013160000_conversation_ai_shadow.',
  missions: 'Missions API not enabled: needs the /api/cockpit/agent/missions routes (rc-8.5.18) with AGENT_ENABLED=1 + AGENT_MISSIONS_ENABLED=1, the R2 runtime (schema PROPOSED_20261012140000_intel_runtime, AGENT_RUNTIME_ENABLED=1, CRON_AGENT_RUNTIME_ENABLED=true, agent.runtime_limits armed) and the actions plane (missions.create).',
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

/* ── Missions (8.5.18 contract: docs/agent-missions-api.md) ──────────── */
// GET  /api/cockpit/agent/missions                 ?scope=mine|all&kind=&state=&limit=&before=
// GET  /api/cockpit/agent/missions/:id             ?events_after=<event id>
// POST /api/cockpit/agent/missions                 { kind: mission.research|mission.supervisor, question, context?, sub_questions?, budget_usd?, per_mission_budget_usd?, max_model_calls? }
// POST /api/cockpit/agent/missions/:id/cancel
// Gate: 404 (empty body) unless AGENT_ENABLED + AGENT_MISSIONS_ENABLED=1. Not in 6ecbae6b; built in rc-8.5.18.

export type MissionKind = 'mission.research' | 'mission.supervisor' | 'acquisition.discovery' | 'conversation.review_digest' | 'ops.health_check' | string
export const CREATABLE_KINDS = ['mission.research', 'mission.supervisor'] as const
export type MissionState = 'queued' | 'claimed' | 'running' | 'retrying' | 'waiting_for_approval' | 'paused' | 'budget_blocked' | 'completed' | 'failed' | 'cancelled' | 'dead_letter'
export const TERMINAL_MISSION_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'dead_letter'])
export const isTerminalMission = (m: Pick<MissionSummary, 'state'>) => TERMINAL_MISSION_STATES.has(m.state)

export interface MissionSummary {
  mission_id: string
  kind: MissionKind
  state: MissionState | string
  /** state, except `waiting` (yielded between steps) and `cancelling` */
  display_state: string
  title: string
  requested_by: string | null
  trigger: { kind: string | null; ref: string | null; schedule_id: number | null }
  progress: { step: string | null; pct: number | null; steps_done: number | null; steps_total: number | null; children_done: number | null; children_total: number | null }
  attempt: number
  max_attempts: number
  cancel_requested: boolean
  budget_cap_usd: number | null
  cost_usd: number | null
  parent_mission_id: string | null
  last_error: { code: string } | null
  created_at: string | null
  updated_at: string | null
  ended_at: string | null
  next_attempt_at: string | null
}
export interface MissionEvent { id: number; at: string | null; type: string; state: string; attempt: number; actor: string; payload: Record<string, unknown> }
export interface MissionFinding { finding_id: string; finding_type: string; key: string; value: Record<string, unknown>; source_id: string | null; citation: unknown; confidence: number | null; evidence_status: string | null; retrieved_at: string | null }
export interface MissionCost { committed_usd: number; settled_usd: number; open_reserved_usd: number; unknown_usd: number; model_calls: number; children_committed_usd: number; total_committed_usd: number; budget_cap_usd: number | null }
export interface MissionDetail extends MissionSummary {
  input: { question: string | null; context: Record<string, unknown> | null; sub_questions: string[] | null; parameters: Record<string, unknown> | null } | null
  result: Record<string, unknown> | null
  cost: MissionCost | null
  children: MissionSummary[]
  events: MissionEvent[]
  events_cursor: number
  findings: MissionFinding[]
}
export interface MissionPage { scope: string; missions: MissionSummary[]; next_cursor: string | null }
export interface MissionCreate { kind: 'mission.research' | 'mission.supervisor'; question: string; context?: { campaign_id?: string; property_ids?: string[] }; sub_questions?: string[]; budget_usd?: number; per_mission_budget_usd?: number; max_model_calls?: number }
export interface MissionCreated { status: string; mission_id: string; state: string; deduped: boolean }
export interface MissionCancelled { mission_id: string; state: string; pending: boolean; noop: boolean; children: Array<{ mission_id: string; state: string; pending: boolean }> }

const MBASE = '/api/cockpit/agent/missions'
export const MISSIONS_ENDPOINTS = {
  list: (q: { scope?: 'mine' | 'all'; kind?: string[]; state?: string[]; limit?: number; before?: string | null } = {}) => {
    const u = new URLSearchParams()
    if (q.scope) u.set('scope', q.scope)
    for (const k of q.kind ?? []) u.append('kind', k)
    for (const k of q.state ?? []) u.append('state', k)
    u.set('limit', String(q.limit ?? 50))
    if (q.before) u.set('before', q.before)
    return `${MBASE}?${u.toString()}`
  },
  get: (id: string, eventsAfter = 0) => `${MBASE}/${encodeURIComponent(id)}${eventsAfter ? `?events_after=${eventsAfter}` : ''}`,
  create: MBASE,
  cancel: (id: string) => `${MBASE}/${encodeURIComponent(id)}/cancel`,
} as const

const n0 = (v: unknown) => Number(v) || 0
export function normalizeMissionSummary(m: Record<string, unknown>): MissionSummary {
  const t = obj(m.trigger); const p = obj(m.progress); const e = m.last_error && typeof m.last_error === 'object' ? obj(m.last_error) : null
  return {
    mission_id: String(m.mission_id ?? ''), kind: String(m.kind ?? ''), state: String(m.state ?? ''), display_state: String(m.display_state ?? m.state ?? ''), title: String(m.title ?? ''),
    requested_by: str(m.requested_by), trigger: { kind: str(t.kind), ref: str(t.ref), schedule_id: numOrNull(t.schedule_id) },
    progress: { step: str(p.step), pct: numOrNull(p.pct), steps_done: numOrNull(p.steps_done), steps_total: numOrNull(p.steps_total), children_done: numOrNull(p.children_done), children_total: numOrNull(p.children_total) },
    attempt: n0(m.attempt), max_attempts: n0(m.max_attempts), cancel_requested: m.cancel_requested === true, budget_cap_usd: numOrNull(m.budget_cap_usd), cost_usd: numOrNull(m.cost_usd),
    parent_mission_id: str(m.parent_mission_id), last_error: e ? { code: String(e.code ?? 'ERROR') } : null,
    created_at: str(m.created_at), updated_at: str(m.updated_at), ended_at: str(m.ended_at), next_attempt_at: str(m.next_attempt_at),
  }
}
export function normalizeMissionPage(b: Record<string, unknown>): MissionPage {
  return { scope: String(b.scope ?? 'mine'), missions: arr<Record<string, unknown>>(b.missions).map(normalizeMissionSummary).filter((m) => m.mission_id), next_cursor: str(b.next_cursor) }
}
export function normalizeMissionDetail(b: Record<string, unknown>): MissionDetail | null {
  const m = obj(b.mission)
  const base = normalizeMissionSummary(m)
  if (!base.mission_id) return null
  const inp = m.input && typeof m.input === 'object' ? obj(m.input) : null
  const c = m.cost && typeof m.cost === 'object' ? obj(m.cost) : null
  return {
    ...base,
    input: inp ? { question: str(inp.question), context: inp.context && typeof inp.context === 'object' ? obj(inp.context) : null, sub_questions: Array.isArray(inp.sub_questions) ? inp.sub_questions.map(String) : null, parameters: inp.parameters && typeof inp.parameters === 'object' ? obj(inp.parameters) : null } : null,
    result: m.result && typeof m.result === 'object' ? obj(m.result) : null,
    cost: c ? { committed_usd: n0(c.committed_usd), settled_usd: n0(c.settled_usd), open_reserved_usd: n0(c.open_reserved_usd), unknown_usd: n0(c.unknown_usd), model_calls: n0(c.model_calls), children_committed_usd: n0(c.children_committed_usd), total_committed_usd: n0(c.total_committed_usd), budget_cap_usd: numOrNull(c.budget_cap_usd) } : null,
    children: arr<Record<string, unknown>>(m.children).map(normalizeMissionSummary).filter((x) => x.mission_id),
    events: arr<Record<string, unknown>>(m.events).map((e) => ({ id: n0(e.id), at: str(e.at), type: String(e.type ?? ''), state: String(e.state ?? ''), attempt: n0(e.attempt), actor: String(e.actor ?? ''), payload: obj(e.payload) })),
    events_cursor: n0(m.events_cursor),
    findings: arr<Record<string, unknown>>(m.findings).map((f) => ({ finding_id: String(f.finding_id ?? ''), finding_type: String(f.finding_type ?? ''), key: String(f.key ?? ''), value: obj(f.value), source_id: str(f.source_id), citation: f.citation ?? null, confidence: numOrNull(f.confidence), evidence_status: str(f.evidence_status), retrieved_at: str(f.retrieved_at) })).filter((f) => f.finding_id),
  }
}

/** Incremental detail: merge newly polled events (events_after) onto what is held, de-duplicated by id. */
export function mergeMissionDetail(prev: MissionDetail | null, next: MissionDetail): MissionDetail {
  if (!prev || prev.mission_id !== next.mission_id) return next
  const seen = new Set(prev.events.map((e) => e.id))
  const events = [...prev.events, ...next.events.filter((e) => !seen.has(e.id))].sort((a, b) => a.id - b.id)
  return { ...next, events, events_cursor: Math.max(prev.events_cursor, next.events_cursor) }
}

export async function fetchMissions(q: Parameters<typeof MISSIONS_ENDPOINTS.list>[0] = {}, signal?: AbortSignal): Promise<PlaneResult<MissionPage>> {
  return fromBackend('missions', await callBackend<unknown>(MISSIONS_ENDPOINTS.list(q), { signal, timeoutMs: 12_000 }), normalizeMissionPage)
}
export async function fetchMission(id: string, eventsAfter = 0, signal?: AbortSignal): Promise<PlaneResult<MissionDetail>> {
  const r = fromBackend('missions', await callBackend<unknown>(MISSIONS_ENDPOINTS.get(id, eventsAfter), { signal, timeoutMs: 12_000 }), normalizeMissionDetail)
  if (r.ok && !r.data) return { ok: false, state: 'error', status: 200, code: 'MISSION_SHAPE', message: 'Unexpected mission response.', next: null }
  return r as PlaneResult<MissionDetail>
}
export async function createMission(body: MissionCreate): Promise<PlaneResult<MissionCreated>> {
  const res = await callBackend<unknown>(MISSIONS_ENDPOINTS.create, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 30_000 })
  return fromBackend('missions', res, (b) => ({ status: String(b.status ?? ''), mission_id: String(b.mission_id ?? ''), state: String(b.state ?? ''), deduped: b.deduped === true }))
}
export async function cancelMission(id: string): Promise<PlaneResult<MissionCancelled>> {
  const res = await callBackend<unknown>(MISSIONS_ENDPOINTS.cancel(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', timeoutMs: 15_000 })
  return fromBackend('missions', res, (b) => ({ mission_id: String(b.mission_id ?? id), state: String(b.state ?? ''), pending: b.pending === true, noop: b.noop === true, children: arr<Record<string, unknown>>(b.children).map((c) => ({ mission_id: String(c.mission_id ?? ''), state: String(c.state ?? ''), pending: c.pending === true })) }))
}

/** Platform health through the existing read capability (operator-initiated). */
export async function fetchPlatformHealth(): Promise<PlaneResult<InvokeOutcome>> {
  return invokeCapability('platform.health', {})
}
