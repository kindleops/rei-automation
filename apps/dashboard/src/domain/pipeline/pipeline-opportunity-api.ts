import { callBackend } from '../../lib/api/backendClient'
import type {
  PipelineListResult,
  PipelineMetrics,
  PipelineOpportunity,
  PipelineSavedView,
} from './pipeline-opportunity.types'

const BASE = '/api/cockpit/pipeline'

function unwrap<T>(result: Awaited<ReturnType<typeof callBackend>>): T {
  if (!result.ok) throw new Error(result.message || result.error || 'backend_request_failed')
  return result.data as T
}

export async function fetchPipelineOpportunities(
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<PipelineListResult> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  const res = unwrap<{ ok: boolean; data: PipelineOpportunity[]; total: number; pagination: PipelineListResult['pagination'] }>(
    await callBackend(`${BASE}/opportunities${qs ? `?${qs}` : ''}`),
  )
  return {
    rows: res.data ?? [],
    total: res.total ?? 0,
    pagination: res.pagination ?? { limit: 100, offset: 0, has_more: false },
  }
}

export async function fetchPipelineMetrics(
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<PipelineMetrics> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  const res = unwrap<{ ok: boolean; data: PipelineMetrics }>(
    await callBackend(`${BASE}/counts${qs ? `?${qs}` : ''}`),
  )
  return res.data
}

export async function fetchPipelineOpportunity(id: string): Promise<PipelineOpportunity> {
  const res = unwrap<{ ok: boolean; data: PipelineOpportunity }>(
    await callBackend(`${BASE}/opportunities/${encodeURIComponent(id)}`),
  )
  return res.data
}

export async function transitionPipelineStage(
  id: string,
  input: { to_stage: string; reason?: string; idempotency_key?: string },
): Promise<{ ok: boolean; opportunity?: PipelineOpportunity; error?: string; message?: string }> {
  return unwrap(await callBackend(`${BASE}/opportunities/${encodeURIComponent(id)}/stage`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }))
}

export async function transitionPipelineStatus(
  id: string,
  input: { to_status: string; reason?: string; idempotency_key?: string },
): Promise<{ ok: boolean; opportunity?: PipelineOpportunity; error?: string; message?: string }> {
  return unwrap(await callBackend(`${BASE}/opportunities/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({
      to_status: input.to_status,
      reason: input.reason,
      idempotency_key: input.idempotency_key,
      source: 'operator',
    }),
  }))
}

export async function transitionPipelineTemperature(
  id: string,
  input: { temperature: string; reason?: string; idempotency_key?: string },
): Promise<{ ok: boolean; opportunity?: PipelineOpportunity; error?: string; message?: string }> {
  return unwrap(await callBackend(`${BASE}/opportunities/${encodeURIComponent(id)}/temperature`, {
    method: 'PATCH',
    body: JSON.stringify({
      temperature: input.temperature,
      reason: input.reason,
      idempotency_key: input.idempotency_key,
      source: 'operator',
    }),
  }))
}

export async function updatePipelineOpportunity(
  id: string,
  patch: Record<string, unknown>,
): Promise<{ ok: boolean; opportunity?: PipelineOpportunity; error?: string }> {
  return unwrap(await callBackend(`${BASE}/opportunities/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }))
}

export async function fetchPipelineSavedViews(): Promise<PipelineSavedView[]> {
  const res = unwrap<{ ok: boolean; data: PipelineSavedView[] }>(await callBackend(`${BASE}/views`))
  return res.data ?? []
}

export async function savePipelineView(view: Partial<PipelineSavedView>): Promise<PipelineSavedView> {
  const res = unwrap<{ ok: boolean; data: PipelineSavedView }>(await callBackend(`${BASE}/views`, {
    method: 'POST',
    body: JSON.stringify(view),
  }))
  return res.data
}