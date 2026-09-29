import { callBackend } from '../../../lib/api/backendClient'

/**
 * WORKFLOW OBSERVATORY — client contract for /api/cockpit/workflow-studio.
 * The server derives every state from each runtime's own ledger
 * (apps/api/src/lib/domain/workflow-studio/observatory-service.js). A failed
 * read is an error, never "no automations".
 */

export type Family = 'trigger' | 'resolve' | 'understand' | 'decision' | 'action' | 'wait' | 'approval' | 'state' | 'notify' | 'end'
export type RunState = 'completed' | 'waiting' | 'held' | 'needs_operator' | 'failed' | 'superseded' | 'running' | 'paused' | 'cancelled'

export interface Beat { state: 'current' | 'stale' | 'never' | 'event_driven' | 'idle'; at?: string | null; last_run_at?: string | null; cadence?: string; note?: string; policy?: Record<string, string | null> }
export interface SystemWorkflow {
  key: string; name: string; domain: string; kind: 'system'; lock: string; owner: string; version: string; runtime: string
  trigger: { type: string; label: string; source: string }
  status: 'live' | 'paused' | 'off' | 'not_deployed'
  live: Record<string, number> | null
  health: Beat
  steps?: Array<{ id: string; kind: string; label: string }>
}
export interface StudioWorkflow { id: string; key: string; name: string; kind: 'studio'; lock: string; status: string; runtime_note: string | null; trigger: string | null; version: number | null; runs_30d: number; test: boolean; updated_at: string | null }
export interface Overview {
  counts: { live: number; running: number; waiting: number; needs_you: number }
  system: SystemWorkflow[]
  studio: StudioWorkflow[]
  runtime: { studio_engine: { state: string; note: string; armed?: Array<{ name: string; test: boolean }> }; queue_runner: Beat; seller_reconcile: Beat }
  generated_at: string
}
export interface GraphNode { id: string; family: Family; label: string; summary?: string; optional?: boolean; exits?: string[]; tone?: string; loop?: { max: number; cadenceHours: number; stop: string }; capability?: string }
export interface OutlineItem { id: string; depth: number; label: string; family: Family; branch: string[] | null; via?: string | null; lane?: string | null }
export interface RunSummary { id: string; workflow: string; started_at: string | null; subject: { kind: string; name?: string | null; address?: string | null; thread_key?: string; closing_case_id?: string }; state: RunState | string; label: string; reason?: string | null; stage?: string | null; link?: string }
export interface WorkflowDetail {
  workflow: { key: string; name: string; owner: string; version: string; runtime: string; description: string; trigger: { label: string; source: string }; nodes: GraphNode[]; edges: Array<{ from: string; to: string; label: string | null }>; outline: OutlineItem[]; sections: Array<{ id: string; label: string; nodes: string[] }>; heartbeat: string | null; killSwitch: string | null }
  window_days?: number
  aggregates: Record<string, { passed: number; blocked?: number; failed: number; review?: number; waiting?: number }>
  runs: RunSummary[]
  next_cursor?: string | null
  note?: string | null
}
export interface RunDetail {
  run: RunSummary
  workflow: { key: string; name: string; version: string }
  path: Record<string, { status: string; at: string | null; reason: string | null; label?: string }>
  why: Array<{ k: string; v: string }>
  preview: string | null
  inbound: string | null
  timeline: Array<{ at: string; key: string; status: string; reason?: string | null; label: string }>
  links: { conversation: string | null; deal: string | null }
}

const BASE = '/api/cockpit/workflow-studio'

async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await callBackend<T & { ok: boolean; error?: string }>(path, { signal, timeoutMs: 30_000 })
  if (!res.ok) throw new Error((res as { error?: string }).error || 'workflow_studio_unavailable')
  const body = res.data as (T & { ok: boolean; error?: string }) | undefined
  if (!body || body.ok === false) throw new Error(body?.error || 'workflow_studio_unavailable')
  return body
}

export const fetchOverview = (signal?: AbortSignal) => read<Overview>(`${BASE}/overview`, signal)
export const fetchAttention = (signal?: AbortSignal) => read<{ items: RunSummary[] }>(`${BASE}/attention`, signal)
export const fetchWorkflow = (key: string, params: { status?: string; cursor?: string } = {}, signal?: AbortSignal) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as Array<[string, string]>).toString()
  return read<WorkflowDetail>(`${BASE}/workflows/${encodeURIComponent(key)}${qs ? `?${qs}` : ''}`, signal)
}
export const fetchRun = (key: string, id: string, signal?: AbortSignal) => read<RunDetail>(`${BASE}/workflows/${encodeURIComponent(key)}/runs/${encodeURIComponent(id)}`, signal)

// ── Orchestrator (durable Studio runtime) ──────────────────────────────────
export interface OrchestratorRun { id: string; workflow_key: string; version: number; subject_kind: string; subject_id: string; state: string; cursor: string | null; wake_at: string | null; outcome: string | null; reason: string | null; started_at: string; updated_at: string }
export interface OrchestratorApproval { id: string; run_id: string; node_id: string; title: string | null; subject_kind: string | null; subject_id: string | null; timeout_at: string | null; created_at: string }
export interface OrchestratorWorkflow { workflow_key: string; name: string; status: 'draft' | 'armed' | 'paused' | 'archived'; live_version: number | null }
export type OrchestratorState =
  | { ok: true; available: false; reason: 'migration_pending'; migration: string }
  | { ok: true; available: true; enabled: boolean; heartbeat_at: string | null; workflows: OrchestratorWorkflow[]; counts: Record<string, number>; live_runs: OrchestratorRun[]; recent_finished: OrchestratorRun[]; approvals: OrchestratorApproval[] }

export const fetchOrchestrator = (signal?: AbortSignal) => read<OrchestratorState>(`${BASE}/orchestrator`, signal)

export type OrchestratorAction = 'approve' | 'reject' | 'resume' | 'cancel' | 'arm' | 'pause'
export async function orchestratorAction(action: OrchestratorAction, fields: Record<string, string>): Promise<{ ok: boolean; code?: string; error?: string }> {
  const res = await callBackend<{ ok: boolean; code?: string; error?: string }>(`${BASE}/orchestrator/actions`, { method: 'POST', body: JSON.stringify({ action, ...fields }) })
  if (!res.ok) {
    const body = res.upstream as { ok?: boolean; code?: string; error?: string } | undefined
    return body && typeof body === 'object' && 'ok' in body ? { ok: false, code: body.code, error: body.error } : { ok: false, error: res.error || 'request_failed' }
  }
  return (res.data as { ok: boolean }) ?? { ok: false, error: 'empty_response' }
}
