import { callBackend } from '../../../lib/api/backendClient'

/**
 * WORKFLOW STUDIO — client contract for leads, live activity, studio
 * (orchestrator) workflows, blueprints and operator actions. Every number is
 * read from a runtime's own records server-side; a failed read is an error,
 * never "nothing is happening".
 */

export type LeadState = 'needs_you' | 'failed' | 'waiting' | 'held' | 'running' | 'done'
export interface Lead {
  id: string; run_id: string; workflow: string; workflow_name: string; studio?: boolean
  subject: { name: string | null; address: string | null; thread_key?: string | null; property_id?: string | null }
  state: LeadState; label: string; reason: string | null; stage?: string | null; at: string; wake_at?: string | null
  step: string | null; link: string | null; runs_7d?: number
}
export interface LeadsResponse { leads: Lead[]; counts: Record<'all' | LeadState, number>; by_workflow: Array<{ workflow: string; name: string; total: number; active: number; needs_you: number }>; degraded: string[]; generated_at: string; window_days: number }

export type ActivityTone = 'cobalt' | 'good' | 'violet' | 'gold' | 'muted' | 'teal' | 'bad'
export interface ActivityItem {
  id: string; at: string; workflow: string; workflow_name: string; studio?: boolean
  kind: string; tone: ActivityTone; title: string; detail: string | null
  subject: { name: string | null; address: string | null; thread_key?: string | null }
  link: string | null; run_id?: string
}
export interface ActivityResponse { items: ActivityItem[]; pulse: { last_hour: number; last_24h: number }; degraded: string[]; generated_at: string; window_hours: number }

export type Reach = 'operator' | 'internal' | 'seller'
export interface StudioNode { id: string; kind: string; label: string }
export interface StudioWorkflow {
  key: string; name: string; domain: string | null; status: 'draft' | 'armed' | 'paused' | 'archived'
  version: number | null; description: string | null; reach: Reach; trigger: string | null
  nodes: StudioNode[]; published_by: string | null; published_at: string | null
  runs: { live: number; needs_you: number; completed_30d: number; outcomes: Record<string, number> }
}
export interface StudioWorkflowsResponse { available: boolean; workflows: StudioWorkflow[] }

export interface StudioRunRow {
  id: string; version: number; state: string; outcome: string | null; reason: string | null; wake_at: string | null
  started_at: string; finished_at: string | null; step: string | null
  subject: { kind: string; id: string; name: string | null; address: string | null; thread_key: string | null }
}
export interface StudioWorkflowDetail {
  workflow: { key: string; name: string; domain: string | null; status: StudioWorkflow['status']; reentry: string; version: number | null; description: string | null; reach: Reach; trigger: string | null; outline: Array<{ n: number; id: string; text: string; exits?: Array<{ exit: string; to: string }> }>; graph: { nodes: Array<StudioNode & { config?: Record<string, unknown> }>; edges: Array<{ from: string; to: string; exit?: string }> } | null; capabilities: Array<{ key: string; label: string; policy: string | null }> }
  versions: Array<{ version: number; published_by: string; published_at: string; note: string | null; description: string }>
  runs: StudioRunRow[]
}
export interface StudioRunDetail {
  run: { id: string; workflow_key: string; version: number; state: string; outcome: string | null; reason: string | null; wake_at: string | null; started_at: string; finished_at: string | null; cursor: string | null; trigger_event_type: string | null }
  subject: { name: string | null; address: string | null; thread_key: string | null; property_id: string | null }
  path: Array<{ id: string; kind: string; label: string; status: string; exit: string | null; at: string | null; reason: string | null }>
  timeline: Array<{ at: string; node: string; label: string; status: string; exit: string | null; reason: string | null; capability: string | null }>
  description: string | null
  links: { conversation: string | null }
}

export interface BlueprintParam { label: string; unit: string; min: number; max: number; step: number; default: number }
export interface Blueprint { key: string; name: string; domain: string; reach: Reach; icon: string; summary: string; params: Record<string, BlueprintParam> }
export interface Preview {
  graph: { trigger: { type: string } }
  validation: { ok: boolean; errors: Array<{ code: string; node: string | null; message: string }>; warnings: Array<{ code: string; message: string }> }
  description: string
  outline: Array<{ n: number; id: string; text: string }>
  nodes: StudioNode[]
  edges: Array<{ from: string; to: string; exit?: string }>
  simulation: { outcome: string; path: Array<{ node: string; kind: string; label: string; exit?: string; why?: string; at_hours: number }>; actions: Array<{ label: string; preview: string | null }>; duration_hours: number; writes: number }
}

const BASE = '/api/cockpit/workflow-studio'

async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await callBackend<T & { ok: boolean; error?: string }>(path, { signal, timeoutMs: 30_000 })
  if (!res.ok) throw new Error((res as { error?: string }).error || 'workflow_studio_unavailable')
  const body = res.data as (T & { ok: boolean; error?: string }) | undefined
  if (!body || body.ok === false) throw new Error(body?.error || 'workflow_studio_unavailable')
  return body
}

async function write<T>(path: string, payload: unknown): Promise<T & { ok: boolean; error?: string; code?: string }> {
  const res = await callBackend<T & { ok: boolean }>(path, { method: 'POST', body: JSON.stringify(payload) })
  if (!res.ok) {
    const body = res.upstream as (T & { ok: boolean; error?: string; code?: string }) | undefined
    return body && typeof body === 'object' && 'ok' in body ? body : ({ ok: false, error: res.error || 'request_failed' } as T & { ok: boolean; error?: string })
  }
  return (res.data as T & { ok: boolean }) ?? ({ ok: false, error: 'empty_response' } as T & { ok: boolean; error?: string })
}

export const fetchLeads = (signal?: AbortSignal) => read<LeadsResponse>(`${BASE}/leads`, signal)
export const fetchActivity = (signal?: AbortSignal) => read<ActivityResponse>(`${BASE}/activity?hours=48&limit=120`, signal)
export const fetchStudioWorkflows = (signal?: AbortSignal) => read<StudioWorkflowsResponse>(`${BASE}/studio`, signal)
export const fetchStudioWorkflow = (key: string, signal?: AbortSignal) => read<StudioWorkflowDetail>(`${BASE}/studio/${encodeURIComponent(key)}`, signal)
export const fetchStudioRun = (key: string, id: string, signal?: AbortSignal) => read<StudioRunDetail>(`${BASE}/studio/${encodeURIComponent(key)}/runs/${encodeURIComponent(id)}`, signal)
export const fetchBlueprints = (signal?: AbortSignal) => read<{ blueprints: Blueprint[] }>(`${BASE}/catalog`, signal)
export const previewBlueprint = (blueprint: string, params: Record<string, number>) => write<Preview>(`${BASE}/simulate`, { blueprint, params, scenario: {} })
export const createWorkflow = (input: { blueprint: string; params: Record<string, number>; name: string; arm: boolean }) => write<{ workflow_key: string; version: number; status: string; errors?: Array<{ message: string }> }>(`${BASE}/orchestrator/actions`, { action: 'create', ...input })
export const setStudioStatus = (workflow_key: string, action: 'arm' | 'pause') => write<{ status: string }>(`${BASE}/orchestrator/actions`, { action, workflow_key })
