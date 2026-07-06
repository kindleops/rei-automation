/**
 * Pure inbox boot/read classification — testable without React or network I/O.
 */

export type InboxReadDataMode =
  | 'live'
  | 'mock_preview'
  | 'fallback_error'
  | 'auth_error'
  | 'backend_unavailable'
  | 'degraded_timeout'

export type InboxLiveFetchStatus = 'active' | 'error' | 'disabled' | 'fallback_error'

export interface InboxBackendFailureInput {
  status?: number | null
  error?: string | null
  message?: string | null
  isDev?: boolean
}

export interface InboxFailureClassification {
  dataMode: InboxReadDataMode
  liveFetchStatus: InboxLiveFetchStatus
  message: string
  retryable: boolean
  diagnosticCode: string
}

export interface InboxLiveResponseShape {
  threadCount: number
  degraded?: boolean
  fallbackUsed?: boolean
  apiDataMode?: string | null
  errorCode?: string | null
}

export interface InboxThreadFetchCommitInput {
  dataMode: InboxReadDataMode
  incomingThreadCount: number
  currentRowCount: number
}

export type InboxThreadFetchCommitAction = 'commit_live' | 'preserve_cache' | 'error_empty'

export interface InboxCountsFetchResult {
  ok: boolean
  status?: number | null
  counts?: Record<string, number>
  warning?: string | null
}

const DEV_API_HINT = 'Start apps/api with `npm run dev` or run `npm run dev:all` from the repo root.'

export const INBOX_MOUNT_FETCHES_COUNTS_IMMEDIATELY = true

export function planInboxMountFetches(): { fetchCountsImmediately: boolean; fetchThreads: boolean } {
  return {
    fetchCountsImmediately: INBOX_MOUNT_FETCHES_COUNTS_IMMEDIATELY,
    fetchThreads: true,
  }
}

export function classifyInboxBackendFailure(input: InboxBackendFailureInput): InboxFailureClassification {
  const status = Number(input.status ?? 0) || null
  const error = String(input.error ?? '').trim()
  const message = String(input.message ?? '').trim()
  const haystack = `${error} ${message}`.toLowerCase()
  const isDev = input.isDev === true

  if (status === 401 || status === 403 || haystack.includes('missing_ops_dashboard_secret') || haystack.includes('unauthorized')) {
    return {
      dataMode: 'auth_error',
      liveFetchStatus: 'fallback_error',
      message: isDev
        ? 'Inbox API authentication failed. Set VITE_OPS_DASHBOARD_SECRET or VITE_BACKEND_API_SECRET in apps/dashboard/.env.local.'
        : 'Inbox API authentication failed. Configure VITE_OPS_DASHBOARD_SECRET in the dashboard deployment environment.',
      retryable: false,
      diagnosticCode: 'auth_error',
    }
  }

  if (
    error === 'BACKEND_UNAVAILABLE'
    || error === 'BACKEND_NETWORK_ERROR'
    || haystack.includes('backend unreachable')
    || haystack.includes('failed to fetch')
    || haystack.includes('connection was refused')
    || haystack.includes('econnrefused')
  ) {
    return {
      dataMode: 'backend_unavailable',
      liveFetchStatus: 'fallback_error',
      message: isDev
        ? `Inbox API server is not reachable on localhost:3000. ${DEV_API_HINT}`
        : 'Inbox backend is unreachable. Retry in a moment.',
      retryable: true,
      diagnosticCode: 'backend_unavailable',
    }
  }

  if (
    status != null && status >= 500
    || error === 'BACKEND_HTML_ERROR'
    || haystack.includes('internal server error')
  ) {
    return {
      dataMode: 'fallback_error',
      liveFetchStatus: 'fallback_error',
      message: 'Inbox is temporarily unavailable. Category counts may still load — retry in a moment.',
      retryable: true,
      diagnosticCode: 'backend_5xx',
    }
  }

  if (error === 'INVALID_JSON_RESPONSE' || haystack.includes('non-json')) {
    return {
      dataMode: 'fallback_error',
      liveFetchStatus: 'fallback_error',
      message: isDev
        ? `Inbox API returned an invalid response. ${DEV_API_HINT}`
        : 'Inbox API returned an invalid response. Retry in a moment.',
      retryable: true,
      diagnosticCode: 'invalid_json',
    }
  }

  return {
    dataMode: 'fallback_error',
    liveFetchStatus: 'fallback_error',
    message: message || error || 'Inbox could not load. Retry in a moment.',
    retryable: true,
    diagnosticCode: 'fallback_error',
  }
}

export function resolveInboxLiveDataMode(input: InboxLiveResponseShape): InboxReadDataMode {
  if (input.threadCount > 0) return 'live'

  const apiMode = String(input.apiDataMode ?? '').trim().toLowerCase()
  if (apiMode === 'auth_error' || input.errorCode === 'auth_error') return 'auth_error'
  if (apiMode === 'backend_unavailable') return 'backend_unavailable'
  if (apiMode === 'timeout_preserved' || apiMode === 'degraded_timeout' || input.errorCode === 'live_inbox_timeout') {
    return 'degraded_timeout'
  }

  if (
    input.degraded === true
    || input.fallbackUsed === true
    || ['stale_snapshot', 'timeout_preserved', 'fallback_error', 'degraded_timeout'].includes(apiMode)
  ) {
    return input.degraded === true && apiMode.includes('timeout') ? 'degraded_timeout' : 'fallback_error'
  }

  return 'live'
}

export function buildInboxLiveFetchError(
  dataMode: InboxReadDataMode,
  options: { isDev?: boolean } = {},
): string | null {
  if (dataMode === 'live' || dataMode === 'mock_preview') return null
  if (dataMode === 'auth_error') {
    return options.isDev
      ? 'Inbox API authentication failed. Set VITE_OPS_DASHBOARD_SECRET or VITE_BACKEND_API_SECRET in apps/dashboard/.env.local.'
      : 'Inbox API authentication failed. Configure VITE_OPS_DASHBOARD_SECRET in the dashboard deployment environment.'
  }
  if (dataMode === 'backend_unavailable') {
    return options.isDev
      ? `Inbox API server is not reachable on localhost:3000. ${DEV_API_HINT}`
      : 'Inbox backend is unreachable. Retry in a moment.'
  }
  if (dataMode === 'degraded_timeout') {
    return 'Inbox timed out while loading threads. Cached rows were preserved — retry in a moment.'
  }
  return 'Inbox is temporarily unavailable. Category counts may still load — retry in a moment.'
}

export function resolveThreadFetchCommit(input: InboxThreadFetchCommitInput): InboxThreadFetchCommitAction {
  const nonLive = input.dataMode !== 'live' && input.dataMode !== 'mock_preview'
  if (nonLive && input.incomingThreadCount === 0) {
    return input.currentRowCount > 0 ? 'preserve_cache' : 'error_empty'
  }
  return 'commit_live'
}

export function mapAuthoritativeCountsFromPayload(
  payload: Record<string, unknown> | null | undefined,
): Record<string, number> {
  const rawCounts = (
    payload?.counts
    ?? (payload?.data as Record<string, unknown> | undefined)?.counts
  ) as Record<string, unknown> | undefined
  if (!rawCounts || Object.keys(rawCounts).length === 0) return {}

  return {
    priority: Number(rawCounts.priority ?? rawCounts.hot_leads ?? 0),
    new_replies: Number(rawCounts.new_replies ?? rawCounts.new_inbound ?? 0),
    needs_review: Number(rawCounts.needs_review ?? 0),
    waiting: Number(rawCounts.waiting ?? rawCounts.waiting_on_seller ?? 0),
    follow_up: Number(rawCounts.follow_up ?? rawCounts.outbound_active ?? 0),
    cold: Number(rawCounts.cold ?? rawCounts.cold_no_response ?? 0),
    dead: Number(rawCounts.dead ?? 0),
    suppressed: Number(rawCounts.suppressed ?? rawCounts.dnc_opt_out ?? 0),
    all_messages: Number(rawCounts.all_messages ?? rawCounts.all ?? 0),
    all: Number(rawCounts.all ?? rawCounts.all_messages ?? 0),
    active: Number(rawCounts.active ?? 0),
    automated: Number(rawCounts.automated ?? 0),
  }
}

export function applyInboxCountsFetchResult(input: {
  ok: boolean
  status?: number | null
  payload?: Record<string, unknown> | null
  isDev?: boolean
}): InboxCountsFetchResult {
  if (!input.ok) {
    const failure = classifyInboxBackendFailure({
      status: input.status,
      error: (input.payload?.error as string | undefined) ?? null,
      message: (input.payload?.message as string | undefined) ?? null,
      isDev: input.isDev,
    })
    return {
      ok: false,
      status: input.status ?? null,
      warning: failure.dataMode === 'auth_error'
        ? failure.message
        : `Category counts could not refresh (${failure.diagnosticCode}). Badges may show cached values.`,
    }
  }

  const counts = mapAuthoritativeCountsFromPayload(input.payload ?? null)
  if (Object.keys(counts).length === 0) {
    return {
      ok: false,
      status: input.status ?? null,
      warning: 'Category counts response was empty. Badges may show cached values.',
    }
  }

  return { ok: true, status: input.status ?? null, counts, warning: null }
}

export function getBackendAuthSecretPresence(): {
  present: boolean
  secretLength: number
  first6: string
  last4: string
} {
  const env = typeof import.meta !== 'undefined' ? import.meta.env : undefined
  const secret = (
    (env?.VITE_BACKEND_API_SECRET as string | undefined)
    || (env?.VITE_OPS_DASHBOARD_SECRET as string | undefined)
    || ''
  )
  return {
    present: secret.length > 0,
    secretLength: secret.length,
    first6: secret.slice(0, 6),
    last4: secret.slice(-4),
  }
}

export class InboxLiveApiError extends Error {
  readonly classification: InboxFailureClassification

  constructor(classification: InboxFailureClassification) {
    super(classification.message)
    this.name = 'InboxLiveApiError'
    this.classification = classification
  }
}