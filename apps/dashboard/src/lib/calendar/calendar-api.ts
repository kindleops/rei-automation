import { callBackend } from '../api/backendClient'
import type { CalendarEvent, ExecutionSummaryCard } from '../data/calendarData'

export type CalendarNexusResponse = {
  ok: boolean
  events: CalendarEvent[]
  kpis: ExecutionSummaryCard[]
  reconciliation: Record<string, number>
  source_counts: Record<string, number>
  performance: {
    total_ms: number
    query_timings: Record<string, number>
    event_count: number
    backend_queries: number
  }
  synchronized_at: string
  source_inventory?: Record<string, string[]>
}

export type CalendarFetchParams = {
  startDate: string
  endDate: string
  sellerId?: string | null
  propertyId?: string | null
  threadId?: string | null
  market?: string | null
  layers?: string[]
  overdueOnly?: boolean
}

function unwrap<T>(result: Awaited<ReturnType<typeof callBackend>>): T {
  if (!result.ok) throw new Error(result.message || result.error || 'calendar_request_failed')
  return result.data as T
}

export async function fetchCalendarNexus(params: CalendarFetchParams): Promise<CalendarNexusResponse> {
  const search = new URLSearchParams()
  search.set('start_date', params.startDate)
  search.set('end_date', params.endDate)
  if (params.sellerId) search.set('master_owner_id', params.sellerId)
  if (params.propertyId) search.set('property_id', params.propertyId)
  if (params.threadId) search.set('thread_key', params.threadId)
  if (params.market) search.set('market', params.market)
  if (params.layers?.length) search.set('layers', params.layers.join(','))
  if (params.overdueOnly) search.set('overdue_only', 'true')

  const res = unwrap<CalendarNexusResponse>(
    await callBackend(`/api/cockpit/calendar/events?${search.toString()}`),
  )
  return res
}

export async function createManualCalendarEvent(payload: Record<string, unknown>) {
  return unwrap<{ ok: boolean; event: Record<string, unknown>; no_send_proof?: boolean }>(
    await callBackend('/api/cockpit/calendar/manual-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

export async function rescheduleCalendarEvent(payload: Record<string, unknown>) {
  return unwrap<{ ok: boolean; no_send_proof?: boolean; error?: string }>(
    await callBackend('/api/cockpit/calendar/reschedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}