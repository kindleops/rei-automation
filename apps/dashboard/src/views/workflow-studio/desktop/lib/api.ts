import { callBackend } from '../../../../lib/api/backendClient'
import type {
  ActivityResponse, AnalyticsResponse, ExceptionsResponse, LiveResponse, Period, RegistryResponse, RunDetailResponse, RunsDrill,
  RunsResponse, RunStatus, SystemMapResponse, WorkflowDetailResponse,
} from './types'

/**
 * Bounded reads over /api/cockpit/workflow-studio/observatory. A failed read
 * is an error the surface names — never "nothing is happening".
 */
const BASE = '/api/cockpit/workflow-studio'
const OBS = `${BASE}/observatory`

export class ReadError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null = null) { super(message); this.status = status }
}

async function read<T>(path: string, signal?: AbortSignal, timeoutMs = 45_000): Promise<T> {
  const res = await callBackend<T & { ok: boolean; error?: string }>(path, { signal, timeoutMs })
  if (!res.ok) throw new ReadError(res.message || res.error || 'unavailable', res.status)
  const body = res.data as (T & { ok: boolean; error?: string }) | undefined
  if (!body || body.ok === false) throw new ReadError(body?.error || 'unavailable')
  return body
}

const qs = (p: Record<string, string | number | boolean | null | undefined>) => {
  const s = new URLSearchParams(Object.entries(p).filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false).map(([k, v]) => [k, v === true ? '1' : String(v)])).toString()
  return s ? `?${s}` : ''
}

/** Local midnight, so "today" is the operator's day, not UTC's. */
export const localDayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString() }

export const fetchRegistry = (signal?: AbortSignal) => read<RegistryResponse>(`${OBS}/registry${qs({ day_start: localDayStart() })}`, signal)
export const fetchSystemMap = (window: '24h' | '7d', signal?: AbortSignal) => read<SystemMapResponse>(`${OBS}/system${qs({ window })}`, signal)
export const fetchExceptions = (signal?: AbortSignal) => read<ExceptionsResponse>(`${OBS}/exceptions`, signal)
export const fetchWorkflow = (key: string, period: Period, signal?: AbortSignal) => read<WorkflowDetailResponse>(`${OBS}/workflows/${encodeURIComponent(key)}${qs({ period })}`, signal)
export const fetchRun = (key: string, runId: string, signal?: AbortSignal) => read<RunDetailResponse>(`${OBS}/workflows/${encodeURIComponent(key)}/runs/${encodeURIComponent(runId)}`, signal)
export const fetchAnalytics = (key: string, period: Period, signal?: AbortSignal) => read<AnalyticsResponse>(`${OBS}/analytics${qs({ key, period })}`, signal, 60_000)
export const fetchActivity = (p: { hours?: number; family?: string | null; human?: boolean; q?: string; limit?: number } = {}, signal?: AbortSignal) =>
  read<ActivityResponse>(`${OBS}/activity${qs({ hours: p.hours ?? 24, family: p.family, human: p.human, q: p.q, limit: p.limit })}`, signal)
export const fetchLive = (since: string | null, key: string | null, signal?: AbortSignal) => read<LiveResponse>(`${OBS}/live${qs({ since, key })}`, signal, 25_000)

export interface RunsQuery extends RunsDrill { q?: string; cursor?: string | null; limit?: number; status?: RunStatus | 'all' }
export const fetchRuns = (key: string, p: RunsQuery, signal?: AbortSignal) =>
  read<RunsResponse>(`${OBS}/workflows/${encodeURIComponent(key)}/runs${qs({
    period: p.period || '7d', status: p.status && p.status !== 'all' ? p.status : null, q: p.q, cursor: p.cursor, limit: p.limit,
    node: p.node, edge: p.edge, reason: p.reason, version: p.version, from: p.from, to: p.to, human: p.human,
  })}`, signal)

/* ── Studio authoring (studio workflows only) ─────────────────────────── */

export interface CatalogCapability { key: string; domain: string; label: string; description: string; policy: 'AUTO' | 'APPROVAL' | 'MANUAL_ONLY' | string; skippable?: boolean; inputs: Record<string, { type: string; required?: boolean; values?: string[]; kind?: string }>; outputs?: Record<string, { type: string }>; availability: { state: 'AVAILABLE' | 'CONFIG_REQUIRED' | 'UNAVAILABLE' | string; reason?: string } }
export interface CatalogCondition { key: string; label: string; reads: string; inputs: string[]; exits: string[] }
export interface CatalogTrigger { key: string; label: string; when: string; source: string; domain: string; scope: string[]; event_types: string[]; volume30d: number | null; awaits?: string }
export interface CatalogBlueprint { key: string; name: string; domain: string; reach: string; icon: string; summary: string; params: Record<string, { label: string; unit?: string; min?: number; max?: number; step?: number; default?: number }> }
export interface StudioCatalog { ok: true; node_kinds: string[]; capabilities: CatalogCapability[]; conditions: CatalogCondition[]; triggers: CatalogTrigger[]; blueprints?: CatalogBlueprint[] }

export interface StudioVersion { version: number; published_by: string | null; published_at: string | null; note: string | null; description: string | null }
export interface StudioWorkflowResponse {
  ok: true
  workflow: { key: string; name: string; domain: string | null; status: string; reentry: string | null; version: number | null; description: string | null; trigger: string | null; graph: GraphDoc | null; capabilities: Array<{ key: string; label: string; policy: string | null }> }
  versions: StudioVersion[]
  runs: Array<{ id: string; version: number; state: string; outcome: string | null; started_at: string; finished_at: string | null }>
}

export type GraphNodeKind = 'action' | 'condition' | 'wait' | 'approval' | 'follow_up_loop' | 'transform' | 'terminate' | 'annotation'
export interface GraphNode { id: string; kind: GraphNodeKind; label?: string; config: Record<string, unknown> }
export interface GraphEdge { from: string; to: string; exit?: string }
export interface GraphDoc { schema?: 'lc.workflow/v1'; key?: string; name?: string; domain?: string | null; trigger: { type: string }; nodes: GraphNode[]; edges: GraphEdge[]; limits?: Record<string, number>; blueprint?: string }

export interface GraphIssue { code: string; node: string | null; message: string }
export interface SimulationResult {
  ok: boolean
  validation: { ok: boolean; errors: GraphIssue[]; warnings: GraphIssue[] }
  description: string
  outline: Array<{ n: number; id: string; text: string; exits?: Array<{ exit: string; to: string }> }>
  diff: Array<{ kind: 'trigger' | 'added' | 'removed' | 'changed' | 'routing'; node?: string; text: string }>
  simulation: {
    ok: boolean
    path: Array<{ node: string; kind: string; label: string; exit?: string; at_hours: number; why?: string }>
    actions: Array<{ node: string; capability: string; label?: string; preview: string | null; status: string; at_hours: number; attempt?: number }>
    waits: Array<{ node: string; kind: string; from_hours: number; timeout_hours?: number; duration_hours?: number; resolved?: string; title?: string }>
    outcome: string
    duration_hours: number
    writes: number
  }
}

export interface Scenario {
  facts?: Record<string, Record<string, unknown>>
  events?: Array<{ type: string; at_hours: number }>
  approvals?: Record<string, 'Approved' | 'Rejected'>
  loop_stop_after?: Record<string, number>
  pick?: 'first'
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await callBackend<T & { ok: boolean; error?: string }>(path, { signal, timeoutMs: 30_000 })
  if (!r.ok) throw new ReadError(r.message || r.error, r.status)
  if (!r.data || (r.data as { ok?: boolean }).ok === false) throw new ReadError((r.data as { error?: string } | undefined)?.error || 'unavailable')
  return r.data as T
}

export const fetchCatalog = (signal?: AbortSignal) => get<StudioCatalog>(`${BASE}/catalog`, signal)
export const fetchStudioWorkflow = (key: string, signal?: AbortSignal) => get<StudioWorkflowResponse>(`${BASE}/studio/${encodeURIComponent(key)}`, signal)

/** Validate + describe + diff + simulate — PURE on the server (capability.simulate only, zero writes). */
export async function simulate(graph: GraphDoc, previous: GraphDoc | null, scenario: Scenario, signal?: AbortSignal): Promise<SimulationResult> {
  const r = await callBackend<SimulationResult & { ok: boolean; error?: string }>(`${BASE}/simulate`, { method: 'POST', body: JSON.stringify({ graph, previous, scenario }), signal, timeoutMs: 30_000 })
  if (!r.ok) throw new ReadError(r.message || r.error, r.status)
  return r.data as SimulationResult
}

/** A blueprint's graph, validated, described and simulated — PURE on the server (zero writes). */
export async function previewBlueprint(blueprint: string, params: Record<string, number>, signal?: AbortSignal): Promise<SimulationResult> {
  const r = await callBackend<SimulationResult & { ok: boolean; error?: string }>(`${BASE}/simulate`, { method: 'POST', body: JSON.stringify({ blueprint, params, scenario: { pick: 'first' } }), signal, timeoutMs: 30_000 })
  if (!r.ok) throw new ReadError(r.message || r.error, r.status)
  return r.data as SimulationResult
}

export type OrchestratorAction = 'create' | 'publish' | 'arm' | 'pause' | 'approve' | 'reject' | 'resume' | 'cancel'
/** The ONE write path: the existing orchestrator action API (the server verifies the operator). */
export async function orchestratorAction(action: OrchestratorAction, fields: Record<string, unknown>): Promise<{ ok: boolean; error?: string; code?: string; version?: number; unchanged?: boolean; errors?: GraphIssue[]; workflow_key?: string }> {
  const r = await callBackend<{ ok: boolean; error?: string; code?: string; version?: number; unchanged?: boolean; errors?: GraphIssue[]; workflow_key?: string }>(`${BASE}/orchestrator/actions`, { method: 'POST', body: JSON.stringify({ action, ...fields }), timeoutMs: 30_000 })
  if (!r.ok) {
    const up = r.upstream as { ok?: boolean; error?: string; code?: string; errors?: GraphIssue[] } | undefined
    return up && typeof up === 'object' && 'ok' in up ? { ok: false, error: up.error, code: up.code, errors: up.errors } : { ok: false, error: r.message || r.error }
  }
  return r.data
}
