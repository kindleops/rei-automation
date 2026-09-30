import { callBackend } from '../../../lib/api/backendClient'
import type { ActivityResponse, AnalyticsResponse, LiveResponse, NeedsYouResponse, Period, RegistryResponse, RunDetailResponse, RunsResponse, RunStatus, WorkflowDetailResponse } from './observatory-types'

/**
 * Bounded reads over /api/cockpit/workflow-studio/observatory. A failed read is
 * an error the surface names — never "nothing is happening".
 */
const BASE = '/api/cockpit/workflow-studio/observatory'

async function read<T>(path: string, signal?: AbortSignal, timeoutMs = 45_000): Promise<T> {
  const res = await callBackend<T & { ok: boolean; error?: string }>(path, { signal, timeoutMs })
  if (!res.ok) throw new Error((res as { error?: string }).error || 'observatory_unavailable')
  const body = res.data as (T & { ok: boolean; error?: string }) | undefined
  if (!body || body.ok === false) throw new Error(body?.error || 'observatory_unavailable')
  return body
}

const qs = (p: Record<string, string | number | boolean | null | undefined>) => {
  const s = new URLSearchParams(Object.entries(p).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString()
  return s ? `?${s}` : ''
}

export const fetchRegistry = (signal?: AbortSignal) => read<RegistryResponse>(`${BASE}/registry`, signal)
export const fetchWorkflow = (key: string, period: Period, signal?: AbortSignal) => read<WorkflowDetailResponse>(`${BASE}/workflows/${encodeURIComponent(key)}${qs({ period })}`, signal)
export interface RunsFilter { period: Period; status?: RunStatus | 'all'; q?: string; cursor?: string | null; limit?: number; node?: string | null; reason?: string | null; version?: string | null; from?: string | null; to?: string | null; human?: boolean }
export const fetchRuns = (key: string, p: RunsFilter, signal?: AbortSignal) =>
  read<RunsResponse>(`${BASE}/workflows/${encodeURIComponent(key)}/runs${qs({ period: p.period, status: p.status && p.status !== 'all' ? p.status : null, q: p.q, cursor: p.cursor, limit: p.limit, node: p.node, reason: p.reason, version: p.version, from: p.from, to: p.to, human: p.human ? 1 : null })}`, signal)
export const fetchAnalytics = (key: string, period: Period, signal?: AbortSignal) => read<AnalyticsResponse>(`${BASE}/analytics${qs({ key, period })}`, signal, 60_000)
export const fetchRun = (key: string, runId: string, signal?: AbortSignal) => read<RunDetailResponse>(`${BASE}/workflows/${encodeURIComponent(key)}/runs/${encodeURIComponent(runId)}`, signal)
export const fetchActivity = (p: { hours?: number; family?: string | null; human?: boolean; q?: string; limit?: number } = {}, signal?: AbortSignal) =>
  read<ActivityResponse>(`${BASE}/activity${qs({ hours: p.hours ?? 24, family: p.family, human: p.human ? 1 : null, q: p.q, limit: p.limit })}`, signal)
export const fetchNeedsYou = (signal?: AbortSignal) => read<NeedsYouResponse>(`${BASE}/needs-you`, signal)
export const fetchLive = (since: string | null, signal?: AbortSignal) => read<LiveResponse>(`${BASE}/live${qs({ since })}`, signal, 25_000)
