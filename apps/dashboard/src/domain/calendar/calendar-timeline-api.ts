import { callBackend } from '../../lib/api/backendClient'

/**
 * CALENDAR TIMELINE — client contract for /api/cockpit/calendar/timeline.
 * The server owns every event and every count; this file types them and
 * formats time. Nothing here derives an event.
 */

export type CalActor = 'system' | 'operator' | 'external' | 'blocked' | 'completed'
export type CalTimeKind = 'scheduled' | 'due' | 'expected' | 'window' | 'occurred'
export type CalType =
  | 'campaign_sends' | 'campaign_start' | 'campaign_window'
  | 'scheduled_message' | 'scheduled_message_group' | 'seller_follow_up'
  | 'pipeline_action' | 'offer' | 'closing' | 'closing_milestone'
export type CalApp = 'inbox' | 'campaigns' | 'pipeline' | 'closing'

export interface CalMember { id: string; start: string; subtitle: string | null; place: string | null; reason: string | null; thread_key: string | null; status: string }

export interface CalEvent {
  id: string
  type: CalType
  source: string
  app: CalApp
  title: string
  subtitle: string | null
  place: string | null
  start: string
  end: string | null
  date?: string
  all_day: boolean
  time_kind: CalTimeKind
  tz: string | null
  actor: CalActor
  status: string
  priority: 'high' | 'normal' | 'info'
  overdue: boolean
  attention: boolean
  reason: string | null
  count: number
  links: { thread_key?: string | null; opportunity_id?: string | null; campaign_id?: string | null; property_id?: string | null; closing_case_id?: string | null }
  detail: Record<string, unknown> & { members?: CalMember[]; reasons?: Record<string, number>; counts?: Record<string, number> }
}

export interface CalSummary {
  total: number; operator: number; system: number; external: number; blocked: number; completed: number
  attention: number; overdue: number; scheduled_messages: number; closings: number; campaigns: number
}

export interface CalendarTimeline {
  range: { from: string; to: string; tz: string; today: string; now: string; lookback_from: string }
  events: CalEvent[]
  attention: CalEvent[]
  today: CalSummary
  next_event: { id: string; title: string; subtitle: string | null; start: string; tz: string | null } | null
  source_status: Record<string, 'ok' | 'failed'>
  property_scope: string | null
}

/* ── desk contract (view=desk, CALENDAR 5.0) — additive; the phone never asks for it ── */
export type DeskOwner = 'you' | 'system' | 'seller' | 'buyer' | 'title' | 'external'
export type DeskState = 'upcoming' | 'live' | 'waiting' | 'needs_you' | 'overdue' | 'completed' | 'cancelled' | 'superseded'
export type DeskLane = 'campaign' | 'closing' | 'automation' | 'workflow' | 'manual'
export type DeskKind = 'window' | 'start' | 'group' | 'message' | 'capsule' | 'deadline' | 'milestone' | 'timer'
export type AttentionCategory = 'overdue' | 'due_today' | 'tomorrow' | 'missing_date' | 'blocking_closing' | 'stale_follow_up' | 'missed_campaign_schedule' | 'waiting_too_long'
export type DeskType = CalType | 'workflow_timer' | 'workflow_approval' | 'workflow_held' | 'workflow_run' | 'email_scheduled' | 'closing_missing_date'

export interface DeskEvent extends Omit<CalEvent, 'type' | 'app' | 'links' | 'start'> {
  type: DeskType
  app: CalApp | 'workflow' | 'email'
  start: string
  source_id?: string
  owner: DeskOwner
  state: DeskState
  history: boolean
  lane: DeskLane
  kind: DeskKind
  manual?: boolean
  undated?: boolean
  attention_state: 'none' | 'attention' | 'overdue' | 'blocking'
  attention_category: AttentionCategory | null
  subject: { type: string; id: string } | null
  editable: { mode: 'read_only' | 'reschedulable' | 'manual'; owner_app: string; how: string; effects: string[] }
  provenance: { scheduled_by: string; basis: string | null; policy?: string | null; timezone: string | null; timezone_basis: string }
  why: string | null
  next: string | null
  deep_link: { app: string; label: string; path: string } | null
  contact_window?: { tz: string; abbr: string; window: string; planned_within: boolean; earliest_at: string; deferred: boolean } | null
  updated_at?: string | null
  links: CalEvent['links'] & { run_id?: string | null; queue_id?: string | null; email_thread_id?: string | null }
  /** canonical market where the source records one (thread, deal, campaign) */
  market?: string | null
  /** the canonical write path this event accepts — null: read-only here */
  actions?: DeskActions | null
}
export interface DeskActions {
  reschedule?: { via: 'queue.reschedule'; queue_id: string; min_lead_minutes: number }
  cancel?: { via: 'queue.cancel'; queue_id: string }
}
export interface DeskDay {
  total: number; campaign: number; windows: number; closing: number; attention: number; automation: number; manual: number; workflow: number; external: number; completed: number; sends: number
  /** v5 volumes — what happened or is ahead on the day, cancellations excluded */
  texts?: number; follow_ups?: number; operator?: number; closings?: number
}
export type CampaignSituation = 'missed' | 'scheduled' | 'sending' | 'window_ahead' | 'window_closed' | 'exhausted' | 'no_timezone'
export interface DeskCampaign {
  id: string
  name: string
  status: string | null
  market: string | null
  tz: string | null
  window: string | null
  window_today: { opens_at: string; closes_at: string } | null
  scheduled_for: string | null
  situation: CampaignSituation
  halted: string | null
  window_event_id: string | null
  counts: { audience: number | null; eligible: number | null; held: number | null; committed: number | null; sent: number | null; remaining: number | null; queued: number | null }
  feeder: { at: string | null; reason: string | null; stalled: boolean } | null
  deep_link: { app: string; label: string; path: string }
}
export interface DeskBrief { id: string; type: DeskType; title: string; subtitle: string | null; start: string; end: string | null; at: string; tz: string | null; owner: DeskOwner }
export interface DeskTimeline extends Omit<CalendarTimeline, 'events' | 'attention'> {
  contract: 'calendar.desk/v5'
  events: DeskEvent[]
  attention: DeskEvent[]
  system: { processor: string; execution_mode: string | null; emergency_stop: boolean; email_sending: boolean; workflow_orchestrator: boolean; workflow_heartbeat_at: string | null; contact_window: { start: string; end: string } }
  days: Record<string, DeskDay>
  board: Record<AttentionCategory, string[]>
  definitions: Record<AttentionCategory, string>
  telemetry: {
    today: { total: number; system: number; you: number; external: number; ids: string[] }
    needs_you: { total: number }
    attention: { total: number; overdue: number }
    live: DeskBrief[]
    next: DeskBrief | null
    next_system: DeskBrief | null
    next_you?: DeskBrief | null
    basis: Record<string, string>
  }
  campaigns?: DeskCampaign[]
  authority?: { write_min_lead_minutes: number; basis: string }
}

export async function fetchDeskTimeline(p: { from: string; to: string; tz: string; propertyId?: string | null }, signal?: AbortSignal): Promise<DeskTimeline> {
  const qs = new URLSearchParams({ from: p.from, to: p.to, tz: p.tz, view: 'desk' })
  if (p.propertyId) qs.set('property_id', p.propertyId)
  const res = await callBackend<{ ok: boolean; data: DeskTimeline }>(`/api/cockpit/calendar/timeline?${qs.toString()}`, { signal, timeoutMs: 45_000 })
  if (!res.ok) {
    const upstream = (res as { upstream?: { error?: string } }).upstream
    throw new Error(upstream?.error || res.error || 'calendar_failed')
  }
  if (!res.data?.data || res.data.data.contract !== 'calendar.desk/v5') throw new Error('calendar_contract_mismatch')
  return res.data.data
}

export const operatorZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago' } catch { return 'America/Chicago' }
}

export async function fetchCalendarTimeline(p: { from: string; to: string; tz: string; propertyId?: string | null }, signal?: AbortSignal): Promise<CalendarTimeline> {
  const qs = new URLSearchParams({ from: p.from, to: p.to, tz: p.tz })
  if (p.propertyId) qs.set('property_id', p.propertyId)
  const res = await callBackend<{ ok: boolean; data: CalendarTimeline }>(`/api/cockpit/calendar/timeline?${qs.toString()}`, { signal, timeoutMs: 30_000 })
  if (!res.ok) {
    const upstream = (res as { upstream?: { error?: string } }).upstream
    throw new Error(upstream?.error || res.error || 'calendar_failed')
  }
  if (!res.data?.data) throw new Error('calendar_empty')
  return res.data.data
}

/* ── dates: YYYY-MM-DD strings in the operator's zone ── */
export const dayKey = (at: number | string, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at))
export const addDays = (d: string, n: number) => {
  const [y, m, dd] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, dd) + n * 86_400_000).toISOString().slice(0, 10)
}
export const dateOf = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd, 12)) }
export const weekdayShort = (d: string) => dateOf(d).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
export const dayNum = (d: string) => Number(d.slice(8, 10))
export const longDate = (d: string) => dateOf(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
export const shortDate = (d: string) => dateOf(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
export const monthLabel = (d: string) => dateOf(d).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

/** Which operator day an event sits on (all-day deadlines carry a date, never a clock). */
export const eventDay = (e: CalEvent, tz: string) => (e.all_day && e.date ? e.date : dayKey(e.start, tz))

const ABBR: Record<string, string> = {
  'America/New_York': 'ET', 'America/Detroit': 'ET', 'America/Chicago': 'CT', 'America/Denver': 'MT',
  'America/Phoenix': 'MST', 'America/Los_Angeles': 'PT', 'America/Anchorage': 'AKT', 'Pacific/Honolulu': 'HT',
}
export const zoneAbbr = (tz: string) => ABBR[tz] || tz.split('/').pop()?.replace(/_/g, ' ') || tz

export const clock = (at: string | number, tz: string) =>
  new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })

/**
 * Time as the operator should read it. Market-defined times (campaign windows,
 * starts) are stated in the MARKET's zone; the operator's own time is added
 * only when the two differ.
 */
export function timeLabel(e: CalEvent, opTz: string): { main: string; alt: string | null } {
  if (e.all_day) return { main: e.time_kind === 'due' ? 'Due today' : 'All day', alt: null }
  const zone = e.tz || opTz
  const start = clock(e.start, zone)
  const end = e.end ? clock(e.end, zone) : null
  const range = end && end !== start ? `${start} – ${end}` : start
  const differs = e.tz && e.tz !== opTz && clock(e.start, opTz) !== start
  return {
    main: e.tz ? `${range} ${zoneAbbr(e.tz)}` : range,
    alt: differs ? `${clock(e.start, opTz)}${end ? ` – ${clock(e.end as string, opTz)}` : ''} your time` : null,
  }
}

export const KIND_LABEL: Record<CalTimeKind, string> = {
  scheduled: 'Scheduled for', due: 'Due', expected: 'Expected', window: 'Window', occurred: 'Happened',
}
export const ACTOR_LABEL: Record<CalActor, string> = {
  system: 'System', operator: 'You', external: 'Third party', blocked: 'Blocked', completed: 'Done',
}
export const APP_LABEL: Record<CalApp, string> = { inbox: 'Inbox', campaigns: 'Campaigns', pipeline: 'Pipeline', closing: 'Closings' }

const REASON_WORDS: Record<string, string> = {
  blocked_sender_number: 'Sender number blocked',
  outbound_number_health_cooling: 'Sender number cooling down',
  delivery_failed: 'Carrier did not deliver',
  blocked_by_health_guard: 'Held by sender health guard',
  failed_transport: 'Provider rejected the send',
}
export const humanReason = (r: string | null | undefined) => {
  const t = String(r ?? '').trim()
  if (!t) return ''
  if (REASON_WORDS[t]) return REASON_WORDS[t]
  if (/^[a-z0-9_]+$/.test(t)) { const w = t.replace(/_/g, ' '); return w.charAt(0).toUpperCase() + w.slice(1) }
  // A provider's SHOUTED code reads as a sentence; real sentences stay exactly as written.
  if (t === t.toUpperCase() && /[A-Z]/.test(t)) return t.charAt(0) + t.slice(1).toLowerCase()
  return t
}
