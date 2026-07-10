import type { BackendResult } from '../../lib/api/backendClient'

export type OpsSurfaceErrorType =
  | 'auth_error'
  | 'backend_unavailable'
  | 'missing_view'
  | 'query_failed'
  | 'no_campaigns'
  | 'no_opportunities'
  | 'no_automation_activity'

export interface OpsSurfaceResult<T> {
  ok: boolean
  data: T
  errorType?: OpsSurfaceErrorType
  errorMessage?: string
  degraded?: boolean
  retryable?: boolean
  source?: string
}

export function opsSuccess<T>(data: T, source: string): OpsSurfaceResult<T> {
  return { ok: true, data, source }
}

export function opsError<T>(
  data: T,
  errorType: OpsSurfaceErrorType,
  errorMessage: string,
  options: { degraded?: boolean; retryable?: boolean; source?: string } = {},
): OpsSurfaceResult<T> {
  return {
    ok: false,
    data,
    errorType,
    errorMessage,
    degraded: options.degraded ?? false,
    retryable: options.retryable ?? errorType !== 'missing_view',
    source: options.source,
  }
}

type BackendFailureLike = {
  ok: boolean
  status?: number
  error?: string
  message?: string
}

export function classifyBackendFailure(result: BackendFailureLike): OpsSurfaceErrorType {
  const status = result.status ?? 0
  const err = String(result.error ?? '').toLowerCase()
  const msg = String(result.message ?? '').toLowerCase()

  if (status === 401 || status === 403 || err.includes('unauthorized') || err.includes('forbidden')) {
    return 'auth_error'
  }
  if (
    status === 503
    || status === 502
    || err.includes('backend_not_configured')
    || err.includes('backend_unavailable')
    || err.includes('backend_proxy_failed')
    || err.includes('network')
    || msg.includes('failed to fetch')
  ) {
    return 'backend_unavailable'
  }
  if (err.includes('missing_view') || msg.includes('does not exist') || msg.includes('relation')) {
    return 'missing_view'
  }
  return 'query_failed'
}

export function mapBackendToOpsResult<T>(
  result: BackendResult<T>,
  emptyValue: T,
  source: string,
): OpsSurfaceResult<T> {
  if (result.ok && result.data != null) {
    return opsSuccess(result.data, source)
  }
  const failure = result.ok ? { ok: false as const } : result
  const errorType = classifyBackendFailure(failure)
  const message = !result.ok ? (result.message || result.error || 'backend_request_failed') : 'backend_request_failed'
  return opsError(emptyValue, errorType, message, {
    retryable: errorType !== 'auth_error',
    source,
  })
}

export function isTrueEmptyState<T extends unknown[]>(
  result: OpsSurfaceResult<T>,
  emptyErrorType: OpsSurfaceErrorType,
): boolean {
  return result.ok && result.data.length === 0 && !result.errorType
    ? true
    : result.ok && result.data.length === 0 && result.errorType === emptyErrorType
}