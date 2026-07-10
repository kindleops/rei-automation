import { callBackend } from '../../lib/api/backendClient'
import {
  classifyBackendFailure,
  opsError,
  opsSuccess,
  type OpsSurfaceResult,
} from '../ops/ops-surface-result'
import type {
  PipelineListResult,
  PipelineMetrics,
  PipelineOpportunity,
  PipelineSavedView,
} from './pipeline-opportunity.types'

const BASE = '/api/cockpit/pipeline'

function classifyPipelineEnvelope(body: Record<string, unknown> | null, status: number): {
  errorType: ReturnType<typeof classifyBackendFailure> extends infer T ? T : never
  message: string
} {
  if (body?.errorType && typeof body.errorType === 'string') {
    return {
      errorType: body.errorType as ReturnType<typeof classifyBackendFailure>,
      message: String(body.message ?? body.error ?? 'pipeline_request_failed'),
    }
  }
  return {
    errorType: classifyBackendFailure({ ok: false, status, error: String(body?.error ?? ''), message: String(body?.message ?? '') }),
    message: String(body?.message ?? body?.error ?? 'pipeline_request_failed'),
  }
}

export async function loadPipelineOpportunitiesSurface(
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<OpsSurfaceResult<PipelineListResult>> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  const result = await callBackend<{ ok: boolean; data: PipelineOpportunity[]; total: number; pagination: PipelineListResult['pagination'] }>(
    `${BASE}/opportunities${qs ? `?${qs}` : ''}`,
  )

  if (result.ok) {
    const payload = result.data
    if (payload?.ok !== false) {
      const rows = payload.data ?? []
      const list: PipelineListResult = {
        rows,
        total: payload.total ?? rows.length,
        pagination: payload.pagination ?? { limit: 100, offset: 0, has_more: false },
      }
      return opsSuccess(list, 'backend_api')
    }
  }

  const failure = result.ok ? null : result
  const upstream = (failure?.upstream ?? (result.ok ? result.data : null)) as Record<string, unknown> | null
  const classified = classifyPipelineEnvelope(upstream, failure?.status ?? 500)
  return opsError(
    { rows: [], total: 0, pagination: { limit: 100, offset: 0, has_more: false } },
    classified.errorType,
    classified.message,
    { retryable: true, source: 'backend_api' },
  )
}

export async function loadPipelineMetricsSurface(
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<OpsSurfaceResult<PipelineMetrics>> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  const result = await callBackend<{ ok: boolean; data: PipelineMetrics }>(`${BASE}/counts${qs ? `?${qs}` : ''}`)

  if (result.ok && result.data?.data) {
    return opsSuccess(result.data.data, 'backend_api')
  }

  const failure = result.ok ? null : result
  const upstream = (failure?.upstream ?? (result.ok ? result.data : null)) as Record<string, unknown> | null
  const classified = classifyPipelineEnvelope(upstream, failure?.status ?? 500)
  return opsError(
    {
      active_opportunities: 0,
      new_replies: 0,
      qualified: 0,
      offer_ready: 0,
      negotiating: 0,
      contract_sent: 0,
      under_contract: 0,
      closing: 0,
      follow_ups_due: 0,
      blocked: 0,
      nurture: 0,
      won: 0,
      lost: 0,
      intent_positive_pct: 0,
      average_stage_age_days: 0,
      total: 0,
    } satisfies PipelineMetrics,
    classified.errorType,
    classified.message,
    { retryable: true, source: 'backend_api' },
  )
}

export async function loadPipelineSavedViewsSurface(): Promise<OpsSurfaceResult<PipelineSavedView[]>> {
  const result = await callBackend<{ ok: boolean; data: PipelineSavedView[] }>(`${BASE}/views`)
  if (result.ok && result.data?.data) {
    return opsSuccess(result.data.data ?? [], 'backend_api')
  }
  const failure = result.ok ? null : result
  const upstream = (failure?.upstream ?? (result.ok ? result.data : null)) as Record<string, unknown> | null
  const classified = classifyPipelineEnvelope(upstream, failure?.status ?? 500)
  return opsError([], classified.errorType, classified.message, {
    retryable: true,
    source: 'backend_api',
  })
}

export async function loadPipelineBoardSurface(
  params: Record<string, string | number | boolean | undefined>,
): Promise<OpsSurfaceResult<{
  list: PipelineListResult
  metrics: PipelineMetrics
  globalMetrics: PipelineMetrics
  views: PipelineSavedView[]
}>> {
  const [listRes, metricsRes, globalRes, viewsRes] = await Promise.all([
    loadPipelineOpportunitiesSurface(params),
    loadPipelineMetricsSurface({ scope: params.scope }),
    loadPipelineMetricsSurface({ scope: 'all' }),
    loadPipelineSavedViewsSurface(),
  ])

  const firstFailure = [listRes, metricsRes, globalRes, viewsRes].find((res) => !res.ok)
  if (firstFailure && !listRes.ok) {
    return opsError(
      {
        list: listRes.data,
        metrics: metricsRes.data,
        globalMetrics: globalRes.data,
        views: viewsRes.data,
      },
      firstFailure.errorType ?? 'query_failed',
      firstFailure.errorMessage ?? 'pipeline_load_failed',
      { retryable: firstFailure.retryable ?? true, source: firstFailure.source },
    )
  }

  return {
    ok: true,
    data: {
      list: listRes.data,
      metrics: metricsRes.data,
      globalMetrics: globalRes.data,
      views: viewsRes.data,
    },
    degraded: [listRes, metricsRes, globalRes, viewsRes].some((res) => res.degraded),
    source: 'backend_api',
  }
}