/**
 * live-dashboard.fetcher.ts
 *
 * Fetches the live dashboard model from the real-estate-automation API.
 * All authentication headers are handled by backendClient.fetchNexusDashboard
 * — credentials are never read or set in this file directly.
 *
 * Environment variables consumed (VITE_ prefix exposes them to the browser):
 *   VITE_BACKEND_API_URL  — Base URL of the real-estate-automation deployment
 *                           e.g. "https://your-rea-app.vercel.app"
 *
 * Throws NexusApiFetchError if the request times out, the server returns
 * non-ok, or the response body is not a valid LiveDashboardModel envelope.
 */

import type { LiveDashboardModel } from './live-dashboard.adapter'
import { fetchNexusDashboard } from '../../../lib/api/backendClient'

const FETCH_TIMEOUT_MS = 14_000

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
  const controller = new AbortController()
  const timeout_id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let result: Awaited<ReturnType<typeof fetchNexusDashboard>>
  try {
    result = await fetchNexusDashboard(controller.signal)
  } catch (err) {
    clearTimeout(timeout_id)
    const is_abort = err instanceof Error && err.name === 'AbortError'
    throw new NexusApiFetchError(
      is_abort
        ? `NEXUS API request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : `NEXUS API error: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  clearTimeout(timeout_id)

  if (!result.ok) {
    const status = result.status ?? null
    const msg = result.message ?? result.error ?? 'NEXUS API returned non-ok'
    throw new NexusApiFetchError(
      `NEXUS API returned ${status ?? 'error'}: ${msg}`,
      status
    )
  }

  const envelope = result.data as { ok?: boolean; data?: unknown; message?: string } | null

  if (envelope && typeof envelope === 'object' && 'ok' in envelope && !envelope.ok) {
    throw new NexusApiFetchError(envelope.message ?? 'NEXUS API returned ok: false')
  }

  const dashboardData = envelope && typeof envelope === 'object' && 'data' in envelope
    ? envelope.data
    : envelope

  if (!isValidDashboardModel(dashboardData)) {
    throw new NexusApiFetchError(
      'NEXUS API response is missing required dashboard fields',
      null,
      true // degraded — partial data situation
    )
  }

  return dashboardData as LiveDashboardModel
}
