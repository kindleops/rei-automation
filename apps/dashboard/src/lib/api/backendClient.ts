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

export const getBackendBaseUrl = (): string => {
  // Primary: VITE_BACKEND_API_URL
  let url = (import.meta.env.VITE_BACKEND_API_URL as string | undefined) || ''

  // Fallback 1: Legacy VITE_NEXUS_API_URL
  if (!url) {
    url = (import.meta.env.VITE_NEXUS_API_URL as string | undefined) || ''
  }

  if (url) return url.replace(/\/$/, '')

  // In production, never fall back to localhost — fail clearly if the env var is missing.
  if (import.meta.env.PROD) {
    console.error('[BACKEND_API_URL_MISSING] VITE_BACKEND_API_URL must be set in production. Set it to https://real-estate-automation-three.vercel.app in your Vercel project env vars.')
    return ''
  }

  // Dev-only localhost fallback
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      url = 'http://localhost:3000'
      return url
    }
    
    // Vercel autodiscovery
    if (hostname.includes('vercel.app')) {
      if (hostname.includes('dashboard')) {
        return `https://${hostname.replace('-dashboard', '')}`
      }
      return window.location.origin
    }
  }

  return ''
}

export const getBackendSecret = (): string => {
  return (import.meta.env.VITE_BACKEND_API_SECRET as string | undefined) || 
         (import.meta.env.VITE_NEXUS_API_SECRET as string | undefined) || ''
}

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

async function callBackend<T = unknown>(
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

  const secret = getBackendSecret()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  }

  if (secret) {
    headers['x-ops-dashboard-secret'] = secret
  }

  // Attach Supabase session JWT for future API-side JWT validation.
  try {
    const { getAuthClient } = await import('../auth/supabaseAuth')
    const { data } = await getAuthClient().auth.getSession()
    if (data.session?.access_token) {
      headers['Authorization'] = `Bearer ${data.session.access_token}`
    }
  } catch {
    // Auth client not available — ops secret alone is used.
  }

  const url = `${base}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      headers,
      ...options,
    })
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: 'BACKEND_NETWORK_ERROR',
      message: `Failed to connect to real-estate-automation at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = null
  }

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
      message: String(canonical ?? `Upstream ${response.status} from ${url}`),
      upstream: body,
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
  return callBackend<SendNowResult>('/api/cockpit/inbox/send-now', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
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
  return callBackend<ThreadStateResult>('/api/cockpit/inbox/thread-state', {
    method: 'PATCH',
    body: JSON.stringify({ thread_key: threadKey, ...patch }),
  })
}
