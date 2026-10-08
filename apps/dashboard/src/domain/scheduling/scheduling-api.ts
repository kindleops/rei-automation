import { callBackend } from '../../lib/api/backendClient'

/**
 * SCHEDULING — client contract for /api/cockpit/scheduling/<action>.
 * The server owns every appointment, every assignment and every calendar
 * connection; this file types them and formats time. Nothing here decides
 * availability or routing.
 */

export type AppointmentView = 'today' | 'upcoming' | 'needs_assignment' | 'completed' | 'cancelled' | 'no_show'
export type SyncStatus = 'pending' | 'synced' | 'not_connected' | 'failed' | 'drift'
export type CalendarHealth = 'healthy' | 'stale' | 'needs_reauth' | 'disconnected' | 'error'
export type WeeklyHours = Record<string, Array<[string, string]>>

export interface Appointment {
  id: string
  brand: string
  status: string
  start_at: string
  end_at: string
  duration_minutes: number
  type: { key: string; name: string }
  assigned: { id: string; name: string } | null
  context: { summary: string | null; lines: string[] }
  customer: { name: string | null; email: string | null; phone: string | null }
  customer_timezone: string | null
  related_refs: string[]
  source: string | null
  sync_status: SyncStatus
  sync_error: string | null
  version: number
  routed_via: string | null
}

export interface AppointmentHistory { event: string; actor: string | null; detail: unknown; created_at: string }

export interface CalendarConnection {
  status: string
  account_email: string | null
  connected_at: string | null
  busy_synced_at: string | null
  health: CalendarHealth
  last_error_code: string | null
  push_notifications: boolean
  watch_expires_at: string | null
}

export interface TeamMember {
  id: string
  name: string
  public_name: string | null
  timezone: string
  weekly_hours: WeeklyHours
  active: boolean
  environment: string | null
  calendar: CalendarConnection | null
}

export interface TeamPool { brand: string; key: string; name: string; members: string[] }

/** /me returns the raw resource row (display_name), unlike /team (name). */
export interface MyResource { id: string; display_name: string; public_name: string | null; timezone: string; weekly_hours: WeeklyHours; active: boolean }
export interface SchedulingMe { user_id: string; resource: MyResource | null; calendar: CalendarConnection | null }

export type AppointmentOutcome = 'confirmed' | 'completed' | 'no_show'
export type TimeOffKind = 'pto' | 'holiday' | 'block'

/** A refused write: the server's error code, verbatim, plus any slots it offered. */
export class SchedulingError extends Error {
  code: string
  status: number
  slots: unknown[] | null
  constructor(code: string, status: number, slots: unknown[] | null = null) {
    super(code)
    this.code = code
    this.status = status
    this.slots = slots
  }
}

/** §30 — an error body must not become "data": the envelope's ok flag is honoured. */
async function call<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const res = await callBackend<T & { ok?: boolean; error?: string }>(path, init)
  if (!res.ok) {
    const up = res.upstream as { error?: string; slots?: unknown[] } | undefined
    throw new SchedulingError(up?.error || res.error || 'scheduling_failed', res.status, Array.isArray(up?.slots) ? up!.slots : null)
  }
  if (res.data && res.data.ok === false) throw new SchedulingError(res.data.error || 'scheduling_failed', res.status)
  return res.data
}

const post = <T>(action: string, body: Record<string, unknown>) =>
  call<T>(`/api/cockpit/scheduling/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export function fetchAppointments(p: { view: AppointmentView; tz: string; brand?: string | null; resourceId?: string | null; type?: string | null }, signal?: AbortSignal) {
  const qs = new URLSearchParams({ view: p.view, tz: p.tz })
  if (p.brand) qs.set('brand', p.brand)
  if (p.resourceId) qs.set('resource_id', p.resourceId)
  if (p.type) qs.set('type', p.type)
  return call<{ ok: true; view: AppointmentView; timezone: string; appointments: Appointment[] }>(`/api/cockpit/scheduling/appointments?${qs.toString()}`, { signal })
}

export const fetchAppointment = (id: string, signal?: AbortSignal) =>
  call<{ ok: true; appointment: Appointment; history: AppointmentHistory[] }>(`/api/cockpit/scheduling/appointment?id=${encodeURIComponent(id)}`, { signal })

export const fetchTeam = (signal?: AbortSignal) =>
  call<{ ok: true; team: TeamMember[]; pools: TeamPool[] }>('/api/cockpit/scheduling/team', { signal })

export const fetchMe = (signal?: AbortSignal) =>
  call<{ ok: true } & SchedulingMe>('/api/cockpit/scheduling/me', { signal })

/* ── writes: each is one canonical server action ── */
export const startCalendarConnect = () => post<{ ok: true; url: string }>('connect', { return_to: '/calendar' })
export const disconnectCalendar = () => post<{ ok: true }>('disconnect', {})
/** Self-service: own hours and time zone only. Becoming bookable, names and routing are a scheduling admin's. */
export const saveMe = (body: { timezone: string; weekly_hours: WeeklyHours }) => post<{ ok: true }>('me', body)
export const addTimeOff = (body: { start_at: string; end_at: string; kind: TimeOffKind; note: string }) => post<{ ok: true }>('time-off', body)
export const setPoolMember = (body: { brand: string; pool_key: string; resource_id: string; active: boolean }) => post<{ ok: true }>('pool-member', body)
export const recordOutcome = (id: string, outcome: AppointmentOutcome) => post<{ ok: true }>('outcome', { id, outcome })
export const assignAppointment = (id: string, resourceId: string) => post<{ ok: true }>('assign', { id, resource_id: resourceId })
export const rescheduleAppointment = (id: string, startAt: string) => post<{ ok: true }>('reschedule', { id, start_at: startAt })
export const cancelAppointment = (id: string, reason: string) => post<{ ok: true }>('cancel', { id, reason })
export const resyncAppointment = (id: string) => post<{ ok: true }>('resync', { id })

/* ── words ── */
export const brandLabel = (brand: string | null | undefined) => {
  if (!brand) return 'No brand'
  if (brand === 'prominent_cash_offer') return 'Prominent'
  const w = brand.replace(/[_-]+/g, ' ').trim()
  return w.replace(/\b\w/g, (c) => c.toUpperCase())
}

/** The zone's own short name at that instant ("CDT", "EST"), not a guessed table. */
export const zoneShort = (at: string | number, tz: string) => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')?.value || tz
  } catch { return tz }
}

export const apptClock = (at: string, tz: string) => {
  try { return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }) } catch { return at }
}
export const apptDay = (at: string, tz: string) => {
  try { return new Date(at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz }) } catch { return at }
}

export const durationLabel = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`)

const ERROR_WORDS: Record<string, string> = {
  slot_unavailable: 'That time is no longer open.',
  not_found: 'That appointment no longer exists.',
  version_conflict: 'Someone else changed this appointment. Reload and try again.',
  calendar_not_connected: 'Connect a Google calendar first.',
  invalid_timezone: 'That time zone is not recognised.',
  forbidden: 'You are not allowed to do that.',
}
/** A server code in plain words; unknown codes are humanised, never hidden. */
export const schedulingErrorText = (err: unknown) => {
  const code = err instanceof SchedulingError ? err.code : err instanceof Error ? err.message : String(err ?? '')
  if (ERROR_WORDS[code]) return ERROR_WORDS[code]
  const w = code.replace(/_/g, ' ').trim()
  return w ? `${w.charAt(0).toUpperCase()}${w.slice(1)}.` : 'That didn’t go through. Nothing was changed.'
}

export const HEALTH_WORD: Record<CalendarHealth, string> = {
  healthy: 'Connected', stale: 'Connected · busy times are stale', needs_reauth: 'Needs reconnecting', disconnected: 'Not connected', error: 'Connection error',
}
export const SYNC_WORD: Record<SyncStatus, string> = {
  pending: 'Syncing', synced: 'Synced', not_connected: 'Calendar not connected', failed: 'Sync failed', drift: 'Changed in Google',
}
export const STATUS_WORD: Record<string, string> = {
  scheduled: 'Scheduled', booked: 'Booked', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show', rescheduled: 'Rescheduled', pending: 'Pending',
}
const LIVE = new Set(['scheduled', 'booked', 'confirmed', 'pending', 'rescheduled'])
/** Still ahead of its outcome: confirm, complete, no-show, assign and cancel apply. */
export const isLive = (a: Appointment) => LIVE.has(a.status)
export const statusWord = (s: string) => STATUS_WORD[s] || brandLabel(s)

/* ── scheduling administration (server enforces scheduling.admin) ── */
export interface EventTypeConfig {
  id: string; brand: string; key: string; name: string
  duration_minutes: number; slot_interval_minutes: number; buffer_before_minutes: number; buffer_after_minutes: number
  min_notice_minutes: number; horizon_days: number
  routing: { strategy?: string; owner?: string; owner_unavailable?: string; pool?: string; fallback_pool?: string }
  reminder_offsets_minutes: number[]; active: boolean; environment: string
}
export const fetchPermissions = (signal?: AbortSignal) =>
  call<{ ok: true; user_id: string | null; scheduling_admin: boolean }>('/api/cockpit/scheduling/permissions', { signal })
export const fetchEventTypes = (signal?: AbortSignal) =>
  call<{ ok: true; event_types: EventTypeConfig[] }>('/api/cockpit/scheduling/event-types', { signal })
export const saveResource = (body: { id?: string; ops_user_id?: string; display_name: string; public_name?: string; email?: string; timezone: string; weekly_hours: WeeklyHours; operator_keys: string[]; active: boolean }) =>
  post<{ ok: true }>('resource', body)
export const saveEventType = (body: Partial<EventTypeConfig> & { id: string }) => post<{ ok: true }>('event-type', body)
