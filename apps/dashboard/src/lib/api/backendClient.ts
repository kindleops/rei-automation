/**
 * Backend API client for nexus-dashboard.
 *
 * All queue/feeder/batch operations must route through real-estate-automation.
 * This client is the single integration point — no direct Supabase mutations
 * for queue, message_events, or inbox_thread_state from the dashboard.
 *
 * Backend base URL is set via VITE_BACKEND_API_URL or falls back to
 * REAL_ESTATE_AUTOMATION_BASE_URL for server-side use.
 */

import type { AnyRecord } from '../data/shared'
import { logDataLayerQueryDone, logDataLayerQueryStart } from '../data/dashboardDataLayer'
import { getSupabaseClient, hasSupabaseEnv } from '../supabaseClient'

export const getBackendBaseUrl = (): string => {
  const isBrowser = typeof window !== 'undefined'

  // In local dev, prefer the local API server over a remote Vercel URL.
  // This keeps the dashboard pointed at the checked-out backend code instead of
  // a stale deployment when we are actively debugging on localhost.
  if (import.meta.env.DEV && isBrowser) {
    const hostname = window.location.hostname
    const runtimeOverride = window.localStorage.getItem('backend_api_url_override')?.trim() || ''
    if (runtimeOverride) {
      return runtimeOverride.replace(/\/$/, '')
    }

    const explicitRemote = ((import.meta.env.VITE_BACKEND_API_FORCE_REMOTE as string | undefined) || '').toLowerCase() === 'true'
    if (!explicitRemote && (hostname === 'localhost' || hostname === '127.0.0.1')) {
      if (!(window as any).__BACKEND_URL_LOGGED) {
        console.log(`[BACKEND_API] Local dev detected. Will use relative paths via proxy.`)
        ;(window as any).__BACKEND_URL_LOGGED = true
      }
      return ''
    }
  }

  // Primary: VITE_BACKEND_API_URL
  let url = (import.meta.env.VITE_BACKEND_API_URL as string | undefined) || ''

  // Fallback 1: Legacy VITE_NEXUS_API_URL
  if (!url) {
    url = (import.meta.env.VITE_NEXUS_API_URL as string | undefined) || ''
  }

  if (url) {
    const cleanUrl = url.replace(/\/$/, '')
    // Only log once at boot via a global check
    if (import.meta.env.DEV && isBrowser && !(window as any).__BACKEND_URL_LOGGED) {
      console.log(`[BACKEND_API] Using VITE_BACKEND_API_URL: ${cleanUrl}`)
      ;(window as any).__BACKEND_URL_LOGGED = true
    }
    return cleanUrl
  }

  // In production, never fall back to localhost — fail clearly if the env var is missing.
  if (import.meta.env.PROD) {
    console.error('[BACKEND_API_URL_MISSING] VITE_BACKEND_API_URL must be set in production. Set it to https://real-estate-automation-three.vercel.app in your Vercel project env vars.')
    return ''
  }

  // Dev-only localhost fallback
  if (isBrowser) {
    const hostname = window.location.hostname
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      if (!(window as any).__BACKEND_URL_LOGGED) {
        console.log(`[BACKEND_API] VITE_BACKEND_API_URL is missing. Will use relative paths via proxy.`)
        ;(window as any).__BACKEND_URL_LOGGED = true
      }
      return ''
    }
    
    // Vercel autodiscovery
    if (hostname.includes('vercel.app')) {
      let discovery = ''
      if (hostname.includes('dashboard')) {
        discovery = `https://${hostname.replace('-dashboard', '')}`
      } else {
        discovery = window.location.origin
      }
      if (!(window as any).__BACKEND_URL_LOGGED) {
        console.log(`[BACKEND_API] Vercel autodiscovery: ${discovery}`)
        ;(window as any).__BACKEND_URL_LOGGED = true
      }
      return discovery
    }
  }

  return ''
}

export interface BackendApiSecretDebug {
  secretLength: number
  first6: string
  last4: string
}

export interface BackendApiSecretResult {
  secret: string
  debug: BackendApiSecretDebug
}

export function getBackendApiSecretDebugSafe(): BackendApiSecretResult {
  const secret = (
    (import.meta.env.VITE_BACKEND_API_SECRET as string | undefined)
    || (import.meta.env.VITE_OPS_DASHBOARD_SECRET as string | undefined)
    || ''
  )
  if (!secret && import.meta.env.PROD) throw new Error('Missing VITE_BACKEND_API_SECRET')
  return {
    secret,
    debug: {
      secretLength: secret.length,
      first6: secret.slice(0, 6),
      last4: secret.slice(-4),
    },
  }
}

export interface BackendApiConfig {
  baseUrl: string
  hasSecret: boolean
  secretDebug?: BackendApiSecretDebug
}

export function getBackendApiConfig(): BackendApiConfig {
  const baseUrl = getBackendBaseUrl()
  const { secret, debug } = getBackendApiSecretDebugSafe()
  return {
    baseUrl,
    hasSecret: secret.length > 0,
    secretDebug: debug,
  }
}

// Compat alias — callers that only need the raw secret string.
export const getBackendSecret = (): string => getBackendApiSecretDebugSafe().secret

export interface BackendClientError {
  ok: false
  status: number
  error: string
  message: string
  upstream?: unknown
}

export interface BackendResultSuccess<T = unknown> {
  ok: true
  status: number
  data: T
}

export type BackendResult<T = unknown> = BackendResultSuccess<T> | BackendClientError

function notReady<T = unknown>(message: string): BackendResult<T> {
  return {
    ok: false,
    status: 503,
    error: 'BACKEND_ENDPOINT_NOT_READY',
    message,
  }
}

const getBodyCount = (body: unknown): { bodyCount: number | null; bodyCountPath: string | null } => {
  if (!body || typeof body !== 'object') return { bodyCount: null, bodyCountPath: null }
  const record = body as Record<string, unknown>
  const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : null
  const candidates: Array<[string, unknown]> = [
    ['threads', record.threads],
    ['data.threads', data?.threads],
    ['messages', record.messages],
    ['data.messages', data?.messages],
    ['rows', record.rows],
    ['data.rows', data?.rows],
    ['items', record.items],
    ['data.items', data?.items],
  ]

  for (const [path, value] of candidates) {
    if (Array.isArray(value)) return { bodyCount: value.length, bodyCountPath: path }
  }

  const total = record.total ?? record.count ?? record.backend_count ?? data?.total ?? data?.count
  const numericTotal = Number(total)
  if (Number.isFinite(numericTotal)) return { bodyCount: numericTotal, bodyCountPath: 'total' }
  return { bodyCount: null, bodyCountPath: null }
}

export async function callBackend<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<BackendResult<T>> {
  const base = getBackendBaseUrl()
  const isBrowser = typeof window !== 'undefined'
  
  // If NO base URL is set AND we are not in a browser (or dev proxy not likely), block.
  // In dev browser mode, empty base is OK because it uses the Vite proxy.
  if (!base && !import.meta.env.DEV && !isBrowser) {
    console.error('[BACKEND_API_URL_MISSING] VITE_BACKEND_API_URL is not set. Manual sends and other backend actions will fail.')
    return {
      ok: false,
      status: 503,
      error: 'BACKEND_NOT_CONFIGURED',
      message: 'VITE_BACKEND_API_URL is not set. Configure it to point to real-estate-automation.',
    }
  }

  const { secret } = getBackendApiSecretDebugSafe()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
    'x-ops-dashboard-secret': secret,
  }

  // Attach Supabase session JWT for future API-side JWT validation.
  try {
    if (hasSupabaseEnv) {
      const { data } = await getSupabaseClient().auth.getSession()
      if (data.session?.access_token) {
        headers['Authorization'] = `Bearer ${data.session.access_token}`
      }
    }
  } catch {
    // Auth client not available — ops secret alone is used.
  }

  const url = `${base}${path}`
  const startedAt = performance.now()
  const dataLayerStartedAt = logDataLayerQueryStart(path, {
    transport: 'backend',
    url,
    method: options.method ?? 'GET',
  })
  console.log('[BACKEND_API_CALL]', {
    url,
    path,
    method: options.method ?? 'GET',
  })
  let response: Response
  try {
    response = await fetch(url, {
      headers,
      ...options,
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const isCors = errMsg === 'Failed to fetch' || errMsg.includes('NetworkError') || errMsg.includes('CORS')
    console.warn('[BACKEND_API_RESPONSE]', {
      status: null,
      ok: false,
      bodyCount: null,
      bodyCountPath: null,
      durationMs: Math.round(performance.now() - startedAt),
      url,
      path,
      error: errMsg,
    })
    logDataLayerQueryDone(path, dataLayerStartedAt, {
      transport: 'backend',
      status: null,
      ok: false,
      bodyCount: null,
      bodyCountPath: null,
      error: errMsg,
    })
    return {
      ok: false,
      status: 502,
      error: 'BACKEND_NETWORK_ERROR',
      message: isCors
        ? `CORS or network error calling ${url} — check that the API allows origin ${typeof window !== 'undefined' ? window.location.origin : 'unknown'} and that VITE_BACKEND_API_URL is correct. Raw: ${errMsg}`
        : `Network error calling ${url}: ${errMsg}`,
    }
  }

  let body: unknown
  let bodyText = ''
  let parseError = false
  try {
    bodyText = await response.text()
    body = JSON.parse(bodyText)
  } catch {
    body = null
    parseError = true
  }
  const { bodyCount, bodyCountPath } = getBodyCount(body)
  console.log('[BACKEND_API_RESPONSE]', {
    status: response.status,
    ok: response.ok,
    bodyCount,
    bodyCountPath,
    durationMs: Math.round(performance.now() - startedAt),
    url,
    path,
    parseError,
  })
  logDataLayerQueryDone(path, dataLayerStartedAt, {
    transport: 'backend',
    status: response.status,
    ok: response.ok && !parseError,
    bodyCount,
    bodyCountPath,
    parseError,
  })

  if (!response.ok) {
    const b = (body as Record<string, unknown>) ?? {}
    const reason = b['reason']
    const error = b['error']
    const message = b['message']
    const canonical = [reason, error, message].find((value) => typeof value === 'string' && value.trim().length > 0)
    return {
      ok: false,
      status: response.status,
      error: String(canonical ?? response.statusText ?? 'BACKEND_ERROR'),
      message: `[${response.status}] ${String(canonical ?? response.statusText ?? 'BACKEND_ERROR')} — ${url}${bodyText ? ` (body: ${bodyText.slice(0, 200)})` : ''}`,
      upstream: body,
    }
  }

  // HTTP 200 but non-JSON body (e.g. HTML error page from CDN/proxy) — treat as error
  // rather than returning { ok: true, data: null } which silently poisons state.
  if (parseError || body === null) {
    return {
      ok: false,
      status: response.status,
      error: 'INVALID_JSON_RESPONSE',
      message: `[${response.status}] ${url} returned non-JSON body: ${bodyText.slice(0, 200)}`,
    }
  }

  return { ok: true, status: response.status, data: body as T }
}

// ---------------------------------------------------------------------------
// Health & readiness
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: 'ok' | 'degraded' | string
  version?: string
  [key: string]: unknown
}

export function getBackendHealth(): Promise<BackendResult<HealthResponse>> {
  return callBackend<HealthResponse>('/api/cockpit/health')
}

export function getBackendReadiness(): Promise<BackendResult<HealthResponse>> {
  return callBackend<HealthResponse>('/api/cockpit/health')
}

// ---------------------------------------------------------------------------
// Queue status (read)
// ---------------------------------------------------------------------------

export interface QueueStatusResponse {
  total?: number
  by_status?: Record<string, number>
  [key: string]: unknown
}

export function getQueueStatus(params?: { market?: string; limit?: number }): Promise<BackendResult<QueueStatusResponse>> {
  const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : ''
  return callBackend<QueueStatusResponse>(`/api/cockpit/queue/status${qs}`)
}

export interface CockpitOpsSenderPerformance {
  sender: string
  sent_count: number
  delivered_count: number
  failed_count: number
  inbound_reply_count: number
  opt_out_count: number
  delivery_rate: number
  failure_rate: number
  reply_rate: number
  opt_out_rate: number
}

export interface OpsMessageTypeSection {
  queued: number
  scheduled: number
  processing: number
  sent: number
  delivered: number
  failed: number
  failed_queue: number
  cancelled: number
  expired: number
  content_blocked: number
  duplicate_blocked: number
  invalid_number: number
  opted_out: number
  replies: number
  opt_outs: number
  positive_replies: number
  negative_replies: number
  unclear_replies: number
  // null means no data (denominator was 0)
  delivery_rate: number | null
  failure_rate: number | null
  reply_rate: number | null
  opt_out_rate: number | null
  positive_rate: number | null
  negative_rate: number | null
}

export interface OpsQueueHealthSection {
  queued_active: number
  scheduled_future: number
  processing: number
  stale_active: number
  content_blocked_today: number
  duplicate_blocked: number
  expired: number
  cancelled: number
  failed_total: number
  failed_by_reason: Record<string, number>
}

export interface OpsFailureReasonSection {
  total: number
  by_reason: Record<string, number>
}

export interface OpsTemplateOutlier {
  template_id: string
  sent: number
  failed: number
  blocked: number
  failure_rate: number | null
}

export interface OpsNumberOutlier {
  number: string
  sent: number
  delivered: number
  failed: number
  replies: number
  opt_outs: number
  delivery_rate: number | null
  failure_rate: number | null
  reply_rate: number | null
  opt_out_rate: number | null
}

export interface CockpitOpsSections {
  first_touch: OpsMessageTypeSection
  auto_replies: {
    stage_1: OpsMessageTypeSection
    stage_2: OpsMessageTypeSection
    stage_3: OpsMessageTypeSection
  }
  manual_replies: OpsMessageTypeSection
  follow_up: OpsMessageTypeSection
  unknown: OpsMessageTypeSection
  queue_health: OpsQueueHealthSection
  failure_reasons: OpsFailureReasonSection
  template_outliers: { top: OpsTemplateOutlier[] }
  number_outliers: { top: OpsNumberOutlier[] }
}

export interface CockpitOpsMetrics {
  window: string
  generated_at?: string
  sent_count: number
  delivered_count: number
  failed_count: number
  pending_count: number
  queued_count: number
  received_count: number
  reply_rate: number
  positive_rate: number
  negative_rate: number
  delivery_rate: number
  failure_rate: number
  opt_out_rate: number
  queue_processor_status: string
  queue_last_run_at: string | null
  queue_waiting_count: number
  queue_failed_today_count: number
  automation_hard_failure_count: number
  sender_performance: CockpitOpsSenderPerformance[]
  sections?: CockpitOpsSections
  metric_source_debug: Record<string, unknown>
}

export function getCockpitOpsMetrics(window: 'today' | '24h' | '7d' | '30d' = 'today'): Promise<BackendResult<{ ok: boolean; action: string; diagnostics: CockpitOpsMetrics }>> {
  const qs = new URLSearchParams({ window }).toString()
  return callBackend(`/api/cockpit/ops/metrics?${qs}`)
}

// ---------------------------------------------------------------------------
// Feeder dry-run (read-only preview)
// ---------------------------------------------------------------------------

export interface FeederDryRunResponse {
  ok: boolean
  dry_run: true
  processed?: number
  results?: unknown[]
  [key: string]: unknown
}

export function runFeederDryRun(params?: {
  limit?: number
  market?: string
}): Promise<BackendResult<FeederDryRunResponse>> {
  void params
  return Promise.resolve(notReady<FeederDryRunResponse>('BACKEND_ENDPOINT_NOT_READY'))
}

// ---------------------------------------------------------------------------
// Queue run dry-run (read-only preview)
// ---------------------------------------------------------------------------

export interface QueueRunResponse {
  ok: boolean
  dry_run: boolean
  selected_count?: number
  would_send_count?: number
  sent_count?: number
  results?: unknown[]
  [key: string]: unknown
}

export function runQueueDryRun(params?: {
  limit?: number
}): Promise<BackendResult<QueueRunResponse>> {
  void params
  return Promise.resolve(notReady<QueueRunResponse>('BACKEND_ENDPOINT_NOT_READY'))
}

// ---------------------------------------------------------------------------
// Queue run LIVE — only if backend explicitly allows it
// Dashboard should NOT call this directly; it goes through backend authorization.
// ---------------------------------------------------------------------------

export function runQueueLive(params?: {
  limit?: number
}): Promise<BackendResult<QueueRunResponse>> {
  void params
  return Promise.resolve(notReady<QueueRunResponse>('BACKEND_ENDPOINT_NOT_READY'))
}

// ---------------------------------------------------------------------------
// Pause batch (incident response)
// ---------------------------------------------------------------------------

export interface PauseBatchResponse {
  ok: boolean
  paused?: number
  [key: string]: unknown
}

export function pauseBatch(params: {
  scheduled_for?: string
  reason?: string
}): Promise<BackendResult<PauseBatchResponse>> {
  void params
  return Promise.resolve(notReady<PauseBatchResponse>('BACKEND_ENDPOINT_NOT_READY'))
}

// ---------------------------------------------------------------------------
// Inbox / pipeline / cockpit endpoints (read display)
// ---------------------------------------------------------------------------

export interface InboxCockpitResponse {
  threads?: unknown[]
  total?: number
  [key: string]: unknown
}

export function getInboxCockpit(params?: {
  limit?: number
  bucket?: string
}): Promise<BackendResult<InboxCockpitResponse>> {
  const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : ''
  return callBackend<InboxCockpitResponse>(`/api/cockpit/inbox/live${qs}`)
}

// ---------------------------------------------------------------------------
// Inbox actions — queue, send, schedule, auto-reply
// All mutations must route through real-estate-automation, not direct Supabase.
// Endpoint paths below are placeholders until real-estate-automation exposes them.
// ---------------------------------------------------------------------------

export interface QueueReplyResult {
  ok: boolean
  queueId: string | null
  status: string | null
  errorMessage: string | null
  [key: string]: unknown
}

export interface SendNowResult {
  ok: boolean
  queueId: string | null
  messageEventId: string | null
  deliveryStatus: string | null
  errorMessage: string | null
  queueProcessorEligible?: boolean
  [key: string]: unknown
}

// POST /api/cockpit/inbox/queue-reply
// Queues a reply from the Inbox for operator approval before send.
export function queueInboxReply(payload: Record<string, unknown>): Promise<BackendResult<QueueReplyResult>> {
  return callBackend<QueueReplyResult>('/api/cockpit/inbox/queue-reply', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

// POST /api/cockpit/inbox/send-now
// Queues a message with status=ready for immediate processor pickup.
// Backend is responsible for message_events row — no optimistic insert from dashboard.
export function sendInboxMessageNow(payload: Record<string, unknown>): Promise<BackendResult<SendNowResult>> {
  const { debug } = getBackendApiSecretDebugSafe()
  console.log('[backendClient.sendInboxMessageNow] dispatching', { secretDebug: debug })
  return callBackend<SendNowResult>('/api/cockpit/inbox/send-now', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

// GET /api/cockpit/inbox/live — used by inboxData.getLiveInbox so all secret
// management stays inside callBackend and never leaks into data layer files.
export function fetchLiveInbox(
  queryString: string,
  signal?: AbortSignal,
): Promise<BackendResult<unknown>> {
  return callBackend(`/api/cockpit/inbox/live?${queryString}`, { signal })
}

export function fetchInboxCounts(
  signal?: AbortSignal,
): Promise<BackendResult<unknown>> {
  return callBackend(`/api/cockpit/inbox/counts`, { signal })
}

export function fetchInboxThreads(
  queryString: string,
  signal?: AbortSignal,
): Promise<BackendResult<unknown>> {
  return callBackend(`/api/cockpit/threads?${queryString}`, { signal })
}

export function fetchInboxThreadMessages(
  threadKey: string,
  queryString: string,
  signal?: AbortSignal,
): Promise<BackendResult<unknown>> {
  return callBackend(`/api/cockpit/inbox/thread-messages?thread_key=${encodeURIComponent(threadKey)}&${queryString}`, { signal })
}

export function fetchInboxThreadDossier(
  queryString: string,
  signal?: AbortSignal,
): Promise<BackendResult<unknown>> {
  return callBackend(`/api/cockpit/inbox/thread-dossier?${queryString}`, { signal })
}

export function fetchInboxThreadHydration(
  queryString: string,
  signal?: AbortSignal,
): Promise<BackendResult<unknown>> {
  return callBackend(`/api/cockpit/inbox/thread-hydration?${queryString}`, { signal })
}

export function fetchDealContextList(
  queryString: string,
  signal?: AbortSignal,
): Promise<BackendResult<unknown>> {
  return callBackend(`/api/cockpit/deal-context${queryString ? `?${queryString}` : ''}`, { signal })
}

export function fetchDealContextByProperty(
  propertyId: string,
  signal?: AbortSignal,
): Promise<BackendResult<unknown>> {
  return callBackend(`/api/cockpit/deal-context/property/${encodeURIComponent(propertyId)}`, { signal })
}

export function fetchDealContextByThread(
  threadKey: string,
  signal?: AbortSignal,
): Promise<BackendResult<unknown>> {
  return callBackend(`/api/cockpit/deal-context/thread/${encodeURIComponent(threadKey)}`, { signal })
}

export function fetchDealContextCounts(
  queryString = '',
  signal?: AbortSignal,
): Promise<BackendResult<unknown>> {
  return callBackend(`/api/cockpit/deal-context/counts${queryString ? `?${queryString}` : ''}`, { signal })
}

// GET /api/internal/dashboard/nexus — live dashboard model.
// Routes through callBackend so the secret header is never set outside this file.
export function fetchNexusDashboard(signal?: AbortSignal): Promise<BackendResult<unknown>> {
  return callBackend('/api/internal/dashboard/nexus', { signal })
}

// POST /api/cockpit/inbox/schedule-reply
// Inserts a send_queue row with status=scheduled at the given time.
export function scheduleInboxReply(payload: Record<string, unknown>): Promise<BackendResult<QueueReplyResult>> {
  return callBackend<QueueReplyResult>('/api/cockpit/inbox/schedule-reply', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

// POST /api/cockpit/inbox/auto-reply
// Auto-reply engine queues a reply based on detected intent.
export function autoQueueReply(payload: Record<string, unknown>): Promise<BackendResult<QueueReplyResult>> {
  return callBackend<QueueReplyResult>('/api/cockpit/inbox/auto-reply', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

// ---------------------------------------------------------------------------
// Queue item actions — approve, cancel, retry
// ---------------------------------------------------------------------------

export interface QueueActionResult {
  ok: boolean
  queueId: string
  errorMessage: string | null
  [key: string]: unknown
}

// POST /api/cockpit/queue/approve
// Moves a queue item from approval → queued for processor pickup.
export function approveQueueItem(queueId: string): Promise<BackendResult<QueueActionResult>> {
  return callBackend<QueueActionResult>('/api/cockpit/queue/approve', {
    method: 'POST',
    body: JSON.stringify({ queue_id: queueId }),
  })
}

// POST /api/cockpit/queue/cancel
// Cancels a pending/approval queue item.
export function cancelQueueItem(queueId: string): Promise<BackendResult<QueueActionResult>> {
  return callBackend<QueueActionResult>('/api/cockpit/queue/cancel', {
    method: 'POST',
    body: JSON.stringify({ queue_id: queueId }),
  })
}

// POST /api/cockpit/queue/retry
// Resets a failed queue item back to queued for retry.
export function retryQueueItem(queueId: string): Promise<BackendResult<QueueActionResult>> {
  return callBackend<QueueActionResult>('/api/cockpit/queue/retry', {
    method: 'POST',
    body: JSON.stringify({ queue_id: queueId }),
  })
}

// POST /api/cockpit/queue/hold
// Puts a queue item into held status.
export function holdQueueItem(queueId: string): Promise<BackendResult<QueueActionResult>> {
  return callBackend<QueueActionResult>('/api/cockpit/queue/hold', {
    method: 'POST',
    body: JSON.stringify({ queue_id: queueId }),
  })
}

// POST /api/cockpit/queue/reschedule
// Reschedules a queue item to a new time.
export function rescheduleQueueItem(queueId: string, newTime: string): Promise<BackendResult<QueueActionResult>> {
  return callBackend<QueueActionResult>('/api/cockpit/queue/reschedule', {
    method: 'POST',
    body: JSON.stringify({ queue_id: queueId, scheduled_for: newTime }),
  })
}

// POST /api/cockpit/queue/retry-routing
// Re-resolves sender routing for a paused/invalid queue item and reschedules.
export function retryRoutingForQueueItem(queueId: string): Promise<BackendResult<QueueActionResult>> {
  return callBackend<QueueActionResult>('/api/cockpit/queue/retry-routing', {
    method: 'POST',
    body: JSON.stringify({ queue_id: queueId }),
  })
}

// POST /api/cockpit/queue/run-safe-batch
export function runSafeBatch(body: Record<string, unknown> = {}): Promise<BackendResult<AnyRecord>> {
  return callBackend<AnyRecord>('/api/cockpit/queue/run-safe-batch', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// POST /api/cockpit/queue/run
export function runQueueNow(body: Record<string, unknown> = {}): Promise<BackendResult<AnyRecord>> {
  return callBackend<AnyRecord>('/api/cockpit/queue/run', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// POST /api/cockpit/queue/auto-enqueue
export function autoEnqueueNow(body: Record<string, unknown> = {}): Promise<BackendResult<AnyRecord>> {
  return callBackend<AnyRecord>('/api/cockpit/queue/auto-enqueue', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// POST /api/cockpit/queue/reprocess-paused
export function reprocessPaused(body: Record<string, unknown> = {}): Promise<BackendResult<AnyRecord>> {
  return callBackend<AnyRecord>('/api/cockpit/queue/reprocess-paused', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// POST /api/cockpit/queue/retry-failed
export function retryFailed(body: Record<string, unknown> = {}): Promise<BackendResult<AnyRecord>> {
  return callBackend<AnyRecord>('/api/cockpit/queue/retry-failed', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// POST /api/cockpit/queue/reconcile
export function reconcileDelivery(body: Record<string, unknown> = {}): Promise<BackendResult<AnyRecord>> {
  return callBackend<AnyRecord>('/api/cockpit/queue/reconcile', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// POST /api/cockpit/queue/cancel-stale-followups
export function cancelStaleFollowups(body: Record<string, unknown> = {}): Promise<BackendResult<AnyRecord>> {
  return callBackend<AnyRecord>('/api/cockpit/queue/cancel-stale-followups', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export interface QueueControlSettings {
  queue_processor_mode?: string
  auto_reply_mode?: string
  campaign_mode?: string
  candidate_source?: string
  queue_daily_send_cap?: string
  queue_hard_cap?: string
  queue_max_batch_size?: string
  queue_run_limit?: string
  queue_scan_limit?: string
  queue_spacing_seconds?: string
  queue_contact_window_start?: string
  queue_contact_window_end?: string
  queue_auto_pause_failure_rate?: string
  queue_auto_pause_optout_rate?: string
  queue_market_throttle?: string
  queue_sender_throttle?: string
  queue_market_cap?: string
  queue_per_number_cap?: string
  queue_market_filter?: string
  queue_state_filter?: string
  queue_all_market_ack?: string
  queue_auto_enqueue_enabled?: string
  queue_auto_send_enabled?: string
  stats?: Record<string, number>
  last_run?: Record<string, unknown>
  [key: string]: unknown
}

export function getQueueControlSettings(): Promise<BackendResult<{ ok: boolean; action: string; diagnostics: QueueControlSettings }>> {
  return callBackend('/api/cockpit/queue/control')
}

export function updateQueueControlSettings(payload: Partial<QueueControlSettings>): Promise<BackendResult<{ ok: boolean; action: string; diagnostics: QueueControlSettings }>> {
  return callBackend('/api/cockpit/queue/control', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

// ---------------------------------------------------------------------------
// Thread state — UI state writes (read/pin/star/archive/suppress)
// Must route through backend so state is authoritative.
// ---------------------------------------------------------------------------

export interface ThreadStateResult {
  ok: boolean
  threadKey: string
  errorMessage: string | null
  [key: string]: unknown
}

// PATCH /api/cockpit/inbox/thread-state
// Updates inbox_thread_state for a given thread (read, pin, star, archive, suppress, stage, etc.)
export function updateThreadState(
  threadKey: string,
  patch: Record<string, unknown>,
): Promise<BackendResult<ThreadStateResult>> {
  return callBackend<ThreadStateResult>(`/api/cockpit/inbox/threads/${threadKey}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

// ---------------------------------------------------------------------------
// Campaign Targeting Studio endpoints
// ---------------------------------------------------------------------------

export interface CampaignFilterOptionsResponse {
  states: Array<{ value: string; label: string; count: number }>
  markets: Array<{ value: string; label: string; count: number }>
  counties: Array<{ value: string; label: string; count: number }>
  cities: Array<{ value: string; label: string; count: number }>
  zip_codes: Array<{ value: string; label: string; count: number }>
  property_tags: Array<{ value: string; label: string; count: number }>
  property_types: Array<{ value: string; label: string; count: number }>
  property_classes: Array<{ value: string; label: string; count: number }>
  owner_types: Array<{ value: string; label: string; count: number }>
  owner_type_guesses: Array<{ value: string; label: string; count: number }>
  person_flags: Array<{ value: string; label: string; count: number }>
  languages: Array<{ value: string; label: string; count: number }>
  agent_families: Array<{ value: string; label: string; count: number }>
  agent_personas: Array<{ value: string; label: string; count: number }>
  contact_windows: Array<{ value: string; label: string; count: number }>
  sender_markets: Array<{ value: string; label: string; count: number; healthy_count: number }>
  template_use_cases: Array<{ value: string; label: string; count: number }>
  stage_codes: Array<{ value: string; label: string; count: number }>
}

export function getCampaignFilterOptions(): Promise<BackendResult<CampaignFilterOptionsResponse>> {
  return callBackend<CampaignFilterOptionsResponse>('/api/cockpit/campaigns/filter-options')
}

export interface PreviewTargetsResponse {
  ok?: boolean
  dry_run?: boolean
  total_matched_properties?: number
  total_matched?: number
  total_scanned: number
  clean_targets: number
  ready_to_queue: number
  queueable_today?: number
  linked_prospects?: number | null
  linked_master_owners?: number | null
  linked_phones?: number | null
  matched_properties?: number | null
  sms_eligible_phones?: number | null
  sender_covered?: number | null
  property_best_phone_count?: number | null
  property_sms_eligible_count?: number | null
  queue_eligibility_scope?: string
  queue_eligibility_note?: string
  current_contact_window_blocks_preview?: boolean
  blocked_waterfall?: Array<{ key?: string; reason?: string; label?: string; count: number; source?: string; reason_codes?: string[] }>
  blocked_reason_waterfall?: Array<{ key?: string; reason?: string; label?: string; count: number; source?: string; reason_codes?: string[] }>
  eligibility_waterfall?: Array<{ key: string; label?: string; count: number; kind?: string; source?: string; description?: string; reason_codes?: string[] }>
  blocked_counts_by_reason: Record<string, number>
  candidate_window?: {
    scanned?: number
    matched?: number
    clean_targets?: number
    ready_to_queue?: number
    queueable_today?: number
    blocked_counts_by_reason?: Record<string, number>
  }
  full_source_reach?: {
    matched_properties?: number
    linked_master_owners?: number | null
    linked_prospects?: number | null
    linked_phones?: number | null
    sms_eligible_phones?: number | null
    clean_targets?: number | null
    sender_covered?: number | null
    ready_to_queue?: number | null
    queueable_today?: number | null
    count_source?: string | null
    graph_source?: string | null
    join_strategy?: string | null
  }
  sender_coverage_counts: Record<string, number>
  identity_counts: Record<string, number>
  language_counts: Record<string, number>
  template_readiness_counts: Record<string, number>
  sample_targets?: any[]
  sample_blocks?: any[]
  total_matching_properties: number
  owners_matched: number
  phones_matched: number
  suppressed_count: number
  opt_out_count: number
  wrong_number_count: number
  blacklist_pair_count: number
  not_interested_count: number
  duplicate_phone_count: number
  duplicate_owner_count: number
  active_queue_duplicate_count: number
  missing_property_count: number
  missing_phone_count: number
  missing_sender_route_count: number
  missing_template_count: number
  clean_ready_targets: number
  readiness_score: number
  warnings: string[]
  blockers: string[]
  by_market: any[]
  by_state: any[]
  by_tag: any[]
  by_owner_type: any[]
  by_language: any[]
}

export function previewCampaignTargets(payload: Record<string, unknown>): Promise<BackendResult<PreviewTargetsResponse>> {
  return callBackend<PreviewTargetsResponse>('/api/cockpit/campaigns/preview-targets', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export interface CampaignApiSummary {
  id: string
  campaign_name: string
  name?: string
  status: string
  total_targets: number
  ready_targets: number
  scheduled_targets: number
  queued_targets: number
  sent_count: number
  delivered_count: number
  failed_count: number
  reply_count: number
  positive_reply_count: number
  negative_reply_count: number
  opt_out_count: number
  delivery_rate: number
  reply_rate: number
  positive_rate: number
  opt_out_rate: number
  failure_rate: number
  next_send_at: string | null
  last_send_at: string | null
  send_interval_seconds: number
  send_window_start: string | null
  send_window_end: string | null
  auto_queue_enabled?: boolean
  auto_send_enabled: boolean
  health_score: number
  health_status: 'healthy' | 'caution' | 'dangerous'
  blocked_reason_counts?: Record<string, number>
}

export interface CampaignListResponse {
  ok: boolean
  campaigns: CampaignApiSummary[]
  kpis?: Record<string, number>
}

export interface CampaignCreateResponse {
  ok: boolean
  campaign_id: string
  campaign: Record<string, unknown>
}

export interface CampaignDetailResponse {
  ok: boolean
  campaign: Record<string, unknown>
  summary: CampaignApiSummary
  filters: any[]
  targets: any[]
  send_windows: any[]
  events: any[]
}

export function listCampaignsBackend(): Promise<BackendResult<CampaignListResponse>> {
  return callBackend<CampaignListResponse>('/api/cockpit/campaigns')
}

export function createCampaignBackend(payload: Record<string, unknown>): Promise<BackendResult<CampaignCreateResponse>> {
  return callBackend<CampaignCreateResponse>('/api/cockpit/campaigns', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getCampaignBackend(campaignId: string): Promise<BackendResult<CampaignDetailResponse>> {
  return callBackend<CampaignDetailResponse>(`/api/cockpit/campaigns/${campaignId}`)
}

export function patchCampaignBackend(campaignId: string, payload: Record<string, unknown>): Promise<BackendResult<CampaignCreateResponse>> {
  return callBackend<CampaignCreateResponse>(`/api/cockpit/campaigns/${campaignId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

type WorkflowBackendResponse = Record<string, unknown>

export function listWorkflowsBackend(): Promise<BackendResult<WorkflowBackendResponse>> {
  return callBackend<WorkflowBackendResponse>('/api/cockpit/workflows')
}

export function createWorkflowBackend(payload: Record<string, unknown>): Promise<BackendResult<WorkflowBackendResponse>> {
  return callBackend<WorkflowBackendResponse>('/api/cockpit/workflows', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getWorkflowBackend(workflowId: string): Promise<BackendResult<WorkflowBackendResponse>> {
  return callBackend<WorkflowBackendResponse>(`/api/cockpit/workflows/${encodeURIComponent(workflowId)}`)
}

export function patchWorkflowBackend(workflowId: string, payload: Record<string, unknown>): Promise<BackendResult<WorkflowBackendResponse>> {
  return callBackend<WorkflowBackendResponse>(`/api/cockpit/workflows/${encodeURIComponent(workflowId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function cloneWorkflowBackend(workflowId: string, payload: Record<string, unknown> = {}): Promise<BackendResult<WorkflowBackendResponse>> {
  return callBackend<WorkflowBackendResponse>(`/api/cockpit/workflows/${encodeURIComponent(workflowId)}/clone`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function pauseWorkflowBackend(workflowId: string): Promise<BackendResult<WorkflowBackendResponse>> {
  return callBackend<WorkflowBackendResponse>(`/api/cockpit/workflows/${encodeURIComponent(workflowId)}/pause`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function resumeWorkflowBackend(workflowId: string): Promise<BackendResult<WorkflowBackendResponse>> {
  return callBackend<WorkflowBackendResponse>(`/api/cockpit/workflows/${encodeURIComponent(workflowId)}/resume`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function dryRunWorkflowBackend(workflowId: string, payload: Record<string, unknown> = {}): Promise<BackendResult<WorkflowBackendResponse>> {
  return callBackend<WorkflowBackendResponse>(`/api/cockpit/workflows/${encodeURIComponent(workflowId)}/dry-run`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function createWorkflowStepBackend(workflowId: string, payload: Record<string, unknown>): Promise<BackendResult<WorkflowBackendResponse>> {
  return callBackend<WorkflowBackendResponse>(`/api/cockpit/workflows/${encodeURIComponent(workflowId)}/steps`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function patchWorkflowStepBackend(stepId: string, payload: Record<string, unknown>): Promise<BackendResult<WorkflowBackendResponse>> {
  return callBackend<WorkflowBackendResponse>(`/api/cockpit/workflow-steps/${encodeURIComponent(stepId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function createWorkflowTemplateSetBackend(workflowId: string, payload: Record<string, unknown>): Promise<BackendResult<WorkflowBackendResponse>> {
  return callBackend<WorkflowBackendResponse>(`/api/cockpit/workflows/${encodeURIComponent(workflowId)}/template-sets`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function createWorkflowTemplateVariantBackend(templateSetId: string, payload: Record<string, unknown>): Promise<BackendResult<WorkflowBackendResponse>> {
  return callBackend<WorkflowBackendResponse>(`/api/cockpit/workflow-template-sets/${encodeURIComponent(templateSetId)}/variants`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function renderWorkflowTemplateVariantBackend(variantId: string, payload: Record<string, unknown>): Promise<BackendResult<WorkflowBackendResponse>> {
  return callBackend<WorkflowBackendResponse>(`/api/cockpit/workflow-template-variants/${encodeURIComponent(variantId)}/render-test`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function upsertWorkflowTemplateTranslationBackend(variantId: string, payload: Record<string, unknown>): Promise<BackendResult<WorkflowBackendResponse>> {
  return callBackend<WorkflowBackendResponse>(`/api/cockpit/workflow-template-variants/${encodeURIComponent(variantId)}/translations`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function createWorkflowSenderPoolBackend(workflowId: string, payload: Record<string, unknown>): Promise<BackendResult<WorkflowBackendResponse>> {
  return callBackend<WorkflowBackendResponse>(`/api/cockpit/workflows/${encodeURIComponent(workflowId)}/sender-pools`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function createWorkflowSenderPoolMemberBackend(senderPoolId: string, payload: Record<string, unknown>): Promise<BackendResult<WorkflowBackendResponse>> {
  return callBackend<WorkflowBackendResponse>(`/api/cockpit/workflow-sender-pools/${encodeURIComponent(senderPoolId)}/members`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export interface BuildTargetsResponse {
  ok?: boolean
  success: boolean
  campaign_id?: string
  built_count: number
  no_send_queue_rows_created?: boolean
  preview?: Record<string, unknown>
  message?: string
}

export function buildCampaignTargets(campaignId: string, payload: Record<string, unknown> = {}): Promise<BackendResult<BuildTargetsResponse>> {
  return callBackend<BuildTargetsResponse>(`/api/cockpit/campaigns/${campaignId}/build-targets`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export interface QueueBatchResponse {
  ok?: boolean
  success?: boolean
  dry_run?: boolean
  no_send?: boolean
  campaign_id?: string
  status?: string
  queued_count?: number
  planned_target_count?: number
  total_ready_targets?: number
  send_windows_created?: number
  send_queue_rows_created?: number
  queue_rows_created?: number
  targets_created?: number
  skipped_count?: number
  skipped_counts_by_reason?: Record<string, number>
  blocked_count?: number
  sender_distribution?: Array<{ value: string; label: string; count: number }>
  template_distribution?: Array<{ value: string; label: string; count: number }>
  first_scheduled_at?: string | null
  last_scheduled_at?: string | null
  launch_summary?: Record<string, unknown>
  planned_windows?: any[]
  blockers?: string[]
  exact_blockers?: string[]
  sample_skips?: Array<Record<string, unknown>>
  message?: string
}

// Live commit. Writes real send_queue rows (staged as `scheduled`) and walks the
// campaign BUILT -> QUEUED -> SCHEDULED. Nothing is sent until Activate (the
// runner is campaign-gated). The /queue-batch route enforces the live flags
// server-side; the client only supplies operator intent + pacing.
export function queueCampaignBatch(
  campaignId: string,
  payload: { limit?: number; interval_seconds?: number; respect_send_window?: boolean } = {},
): Promise<BackendResult<QueueBatchResponse>> {
  return callBackend<QueueBatchResponse>(`/api/cockpit/campaigns/${campaignId}/queue-batch`, {
    method: 'POST',
    body: JSON.stringify({ explicit_operator_action: true, ...payload }),
  })
}

// ---------------------------------------------------------------------------
// Map properties — viewport-aware geographic intelligence layer
// ---------------------------------------------------------------------------

export interface MapPropertiesData {
  generated_at: string
  zoom: number
  mode: 'clusters' | 'markers'
  bounds: { lat_min: number | null; lat_max: number | null; lng_min: number | null; lng_max: number | null }
  features: Array<{
    type: 'Feature'
    geometry: { type: 'Point'; coordinates: [number, number] }
    properties: Record<string, unknown>
  }>
  counts: {
    returned: number
    clipped: boolean
    by_asset_type: Record<string, number>
    by_marker_state: Record<string, number>
    by_state: Record<string, number>
  }
}

export interface MapPropertiesResponse {
  ok: boolean
  route: string
  data: MapPropertiesData
}

export function fetchMapProperties(params: {
  lat_min: number
  lat_max: number
  lng_min: number
  lng_max: number
  zoom: number
  limit?: number
  markets?: string
  states?: string
}, signal?: AbortSignal): Promise<BackendResult<MapPropertiesResponse>> {
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
    )
  ).toString()
  return callBackend<MapPropertiesResponse>(`/api/internal/dashboard/ops/map?${qs}`, { signal })
}

export function queueCampaignPlan(campaignId: string, payload: Record<string, unknown> = {}): Promise<BackendResult<QueueBatchResponse>> {
  return callBackend<QueueBatchResponse>(`/api/cockpit/campaigns/${campaignId}/queue-plan`, {
    method: 'POST',
    body: JSON.stringify({
      dry_run: true,
      create_send_queue_rows: false,
      ...payload,
    }),
  })
}

// ── Phase 2C/2D — campaign execution progress + lifecycle ────────────────────
export interface CampaignRuntimeSummary {
  campaign_id: string
  name?: string | null
  status: string
  scheduled_for: string | null
  activated_at: string | null
  paused_at: string | null
  completed_at: string | null
  failed_at: string | null
  failure_reason: string | null
  last_transition_at: string | null
  activation_attempt_count: number
  hydration_active: boolean
  execution_heartbeat_at: string | null
  hydration_cursor: Record<string, unknown> | null
  progress_synced_at: string | null
  queued_count: number
  sent_count: number
  delivered_count: number
  failed_count: number
  replied_count: number
  positive_count: number
  opt_out_count: number
  total_planned: number
  delivery_rate_pct: number
  reply_rate_pct: number
  positive_rate_pct: number
  opt_out_rate_pct: number
  hydration_progress_pct: number
}

export interface CampaignProgressResponse {
  ok: boolean
  summary?: CampaignRuntimeSummary
  degraded?: boolean
  error?: string
}

export function getCampaignProgress(
  campaignId: string,
  opts: { recompute?: boolean } = {},
): Promise<BackendResult<CampaignProgressResponse>> {
  const query = opts.recompute ? '?recompute=1' : ''
  return callBackend<CampaignProgressResponse>(`/api/cockpit/campaigns/${campaignId}/progress${query}`)
}

export interface CampaignLifecycleResponse {
  ok: boolean
  action?: string | null
  from?: string | null
  to?: string
  degraded?: boolean
  error?: string
}

export function setCampaignLifecycle(
  campaignId: string,
  action: 'preview' | 'queue' | 'schedule' | 'unschedule' | 'begin_activation' | 'activate' | 'pause' | 'resume' | 'complete' | 'fail' | 'archive',
  payload: Record<string, unknown> = {},
): Promise<BackendResult<CampaignLifecycleResponse>> {
  return callBackend<CampaignLifecycleResponse>(`/api/cockpit/campaigns/${campaignId}/lifecycle`, {
    method: 'POST',
    body: JSON.stringify({ action, ...payload }),
  })
}

export interface CampaignCloneResponse {
  ok: boolean
  campaign_id?: string
  campaign?: Record<string, unknown>
  error?: string
  message?: string
}

export function cloneCampaignBackend(
  campaignId: string,
  payload: Record<string, unknown> = {},
): Promise<BackendResult<CampaignCloneResponse>> {
  return callBackend<CampaignCloneResponse>(`/api/cockpit/campaigns/${campaignId}/clone`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export interface CampaignDeleteResponse {
  ok: boolean
  campaign_id?: string
  deleted?: boolean
  archived?: boolean
  targets_removed?: number
  windows_removed?: number
  queue_rows_cancelled?: number
  error?: string
  message?: string
}

export function deleteCampaignBackend(
  campaignId: string,
): Promise<BackendResult<CampaignDeleteResponse>> {
  return callBackend<CampaignDeleteResponse>(`/api/cockpit/campaigns/${campaignId}`, {
    method: 'DELETE',
  })
}
