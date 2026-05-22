/**
 * live-dashboard.fetcher.ts
 *
 * Fetches the live dashboard model from the real-estate-automation API.
 * Validates the response shape before returning.
 *
 * Environment variables consumed (VITE_ prefix exposes them to the browser):
 *   VITE_BACKEND_API_URL  — Base URL of the real-estate-automation deployment
 *                           e.g. "https://your-rea-app.vercel.app"
 *
 * Throws if the network request fails, the server returns non-ok, or the
 * response body is not a valid LiveDashboardModel envelope.
 */

import type { LiveDashboardModel } from './live-dashboard.adapter'

const FETCH_TIMEOUT_MS = 14_000
// Legacy read endpoint retained temporarily for live dashboard model parity.
const NEXUS_API_ENDPOINT = '/api/internal/dashboard/nexus'

function getApiBase(): string {
  return (import.meta.env.VITE_BACKEND_API_URL ?? '').replace(/\/$/, '')
}

function isValidDashboardModel(value: unknown): value is LiveDashboardModel {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return (
    typeof m.generatedAtIso === 'string' &&
    Array.isArray(m.markets) &&
    Array.isArray(m.leads) &&
    Array.isArray(m.alerts) &&
    Array.isArray(m.systemHealth) &&
    Array.isArray(m.summaryMetrics)
  )
}

export class NexusApiFetchError extends Error {
  readonly status: number | null
  readonly degraded: boolean

  constructor(message: string, status: number | null = null, degraded = false) {
    super(message)
    this.name = 'NexusApiFetchError'
    this.status = status
    this.degraded = degraded
  }
}

export async function fetchLiveDashboard(): Promise<LiveDashboardModel> {
  const api_base = getApiBase()
  if (!api_base) {
    throw new NexusApiFetchError(
      'VITE_BACKEND_API_URL is not configured — set it to use live data'
    )
  }

  const url = `${api_base}${NEXUS_API_ENDPOINT}`
  const secret = (import.meta.env.VITE_BACKEND_API_SECRET ?? '')
  const controller = new AbortController()
  const timeout_id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (secret) {
    headers['x-ops-dashboard-secret'] = secret
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers,
      cache: 'no-store',
    })
  } catch (err) {
    clearTimeout(timeout_id)
    const is_abort = err instanceof Error && err.name === 'AbortError'
    throw new NexusApiFetchError(
      is_abort
        ? `NEXUS API request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : `NEXUS API network error: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  clearTimeout(timeout_id)

  if (!response.ok) {
    let api_message = ''
    try {
      const body = await response.json()
      api_message = body?.message ?? body?.error ?? ''
    } catch { /* ignore parse errors */ }
    throw new NexusApiFetchError(
      `NEXUS API returned ${response.status}${api_message ? `: ${api_message}` : ''}`,
      response.status
    )
  }

  let envelope: unknown
  try {
    envelope = await response.json()
  } catch {
    throw new NexusApiFetchError('NEXUS API response is not valid JSON')
  }

  const body = envelope as { ok?: boolean; data?: unknown; message?: string }

  if (!body.ok) {
    throw new NexusApiFetchError(
      body.message ?? 'NEXUS API returned ok: false'
    )
  }

  if (!isValidDashboardModel(body.data)) {
    throw new NexusApiFetchError(
      'NEXUS API response is missing required dashboard fields',
      null,
      true // degraded — partial data situation
    )
  }

  return body.data as LiveDashboardModel
}
