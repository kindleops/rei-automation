/**
 * CALENDAR 3.0 · DESK MODEL — pure arrangement of the server's canonical
 * events (view=desk). Nothing here creates, dates or counts an event on its
 * own: it groups, places and sorts what /api/cockpit/calendar/timeline
 * returned. Header counts come from the server's telemetry, never from here.
 */
import type { DeskDay, DeskEvent, DeskTimeline, AttentionCategory } from '../../../domain/calendar/calendar-timeline-api'

export const HOUR = 3_600_000
export const DAY_MS = 86_400_000

/* ── dates & clocks ─────────────────────────────────────────────────── */
export const dayKey = (at: number | string, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at))
export const addDays = (d: string, n: number) => {
  const [y, m, dd] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, dd) + n * DAY_MS).toISOString().slice(0, 10)
}
const dateOf = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd, 12)) }
export const weekday = (d: string, style: 'short' | 'long' | 'narrow' = 'short') => dateOf(d).toLocaleDateString('en-US', { weekday: style, timeZone: 'UTC' })
export const monthDay = (d: string) => dateOf(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
export const longDay = (d: string) => dateOf(d).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })
export const monthTitle = (d: string) => dateOf(d).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
export const dayNum = (d: string) => Number(d.slice(8, 10))
/** Sunday-first week start (US calendar). */
export const weekStart = (d: string) => addDays(d, -dateOf(d).getUTCDay())
export const clock = (at: string | number, tz: string) => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
export const hourLabel = (h: number) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`)

const ABBR: Record<string, string> = {
  'America/New_York': 'ET', 'America/Detroit': 'ET', 'America/Chicago': 'CT', 'America/Denver': 'MT',
  'America/Phoenix': 'MST', 'America/Los_Angeles': 'PT', 'America/Anchorage': 'AKT', 'Pacific/Honolulu': 'HT',
}
export const zoneAbbr = (tz: string | null | undefined) => (!tz ? '' : ABBR[tz] || tz.split('/').pop()?.replace(/_/g, ' ') || tz)

/** Minutes after local midnight. */
export function localMinutes(at: number | string, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(at))
  return (Number(p.find((x) => x.type === 'hour')?.value) % 24) * 60 + Number(p.find((x) => x.type === 'minute')?.value)
}

export type TzMode = 'operator' | 'event'
/** The zone an event's clock reads in: yours, or the zone the time is DEFINED in. */
export function zoneFor(e: DeskEvent, mode: TzMode, opTz: string) {
  if (mode === 'operator') return opTz
  const d = e.detail as { property_tz?: string | null; seller_zone?: string | null }
  return e.tz || e.contact_window?.tz || d?.seller_zone || d?.property_tz || opTz
}
/** Operator calendar day an event sits on (all-day facts carry their date). */
export const eventDay = (e: DeskEvent, tz: string) => (e.all_day && e.date ? e.date : dayKey(e.start, tz))

/** "8:00 AM–9:00 PM CT" in the chosen zone; the other zone as a whisper when it differs. */
export function timeText(e: DeskEvent, mode: TzMode, opTz: string): { main: string; alt: string | null } {
  if (e.all_day) return { main: e.time_kind === 'due' ? 'Due · all day' : 'All day', alt: null }
  const z = zoneFor(e, mode, opTz)
  const s = clock(e.start, z)
  const end = e.end ? clock(e.end, z) : null
  const main = `${end && end !== s ? `${s}–${end}` : s} ${zoneAbbr(z)}`
  const other = mode === 'operator' ? (e.tz && e.tz !== opTz ? e.tz : null) : (z !== opTz ? opTz : null)
  if (!other) return { main, alt: null }
  const os = clock(e.start, other)
  return os === s ? { main, alt: null } : { main, alt: `${os}${e.end ? `–${clock(e.end, other)}` : ''} ${zoneAbbr(other)}` }
}

/* ── grouping: high volume reads as one line that opens to its members ── */
export interface DeskGroup {
  id: string
  group: true
  type: DeskEvent['type']
  title: string
  start: string
  state: DeskEvent['state']
  owner: DeskEvent['owner']
  lane: DeskEvent['lane']
  count: number
  members: DeskEvent[]
}
export type DeskItem = DeskEvent | DeskGroup
export const isGroup = (x: DeskItem): x is DeskGroup => (x as DeskGroup).group === true

const GROUP_TITLE: Partial<Record<DeskEvent['type'], string>> = {
  seller_follow_up: 'seller follow-ups', scheduled_message: 'scheduled messages', pipeline_action: 'deal actions', email_scheduled: 'emails',
}
/**
 * Same type + same state inside one slot (default 30 min) collapse when there
 * are `min` or more: "37 SELLER FOLLOW-UPS · 8:00 AM". Order is preserved.
 */
export function groupSlots(events: DeskEvent[], tz: string, { min = 3, slotMinutes = 30 } = {}): DeskItem[] {
  const buckets = new Map<string, DeskEvent[]>()
  const keyOf = (e: DeskEvent) => (GROUP_TITLE[e.type] && !e.all_day ? `${e.type}|${e.state}|${dayKey(e.start, tz)}|${Math.floor(localMinutes(e.start, tz) / slotMinutes)}` : null)
  for (const e of events) { const k = keyOf(e); if (!k) continue; if (!buckets.has(k)) buckets.set(k, []); buckets.get(k)!.push(e) }
  const out: DeskItem[] = []
  const done = new Set<string>()
  for (const e of events) {
    const k = keyOf(e)
    const list = k ? buckets.get(k)! : null
    if (!k || !list || list.length < min) { out.push(e); continue }
    if (done.has(k)) continue
    done.add(k)
    out.push({ id: `group:${k}`, group: true, type: e.type, title: `${list.length} ${GROUP_TITLE[e.type]}`, start: list[0].start, state: e.state, owner: e.owner, lane: e.lane, count: list.length, members: list })
  }
  return out
}

/* ── TODAY ─────────────────────────────────────────────────────────── */
export interface TodayModel {
  live: DeskEvent[]
  next: DeskEvent[]
  later: DeskEvent[]
  earlier: DeskEvent[]
  needsYou: DeskEvent[]
  waiting: DeskEvent[]
  automated: DeskEvent[]
  windows: DeskEvent[]
  deadlines: DeskEvent[]
  history: DeskEvent[]
}
const byStart = (a: DeskEvent, b: DeskEvent) => Date.parse(a.start) - Date.parse(b.start)
/** When the next thing happens for this event: a live campaign day's next queued row, else its start. */
export const nextAt = (e: DeskEvent) => {
  const n = (e.detail as { next_send_at?: string | null })?.next_send_at
  return n ? Date.parse(n) : Date.parse(e.start)
}

export function todayModel(events: DeskEvent[], { day, now, tz, horizonDays = 14 }: { day: string; now: number; tz: string; horizonDays?: number }): TodayModel {
  const onDay = events.filter((e) => !e.undated && (eventDay(e, tz) === day || (e.end && dayKey(e.start, tz) < day && dayKey(e.end, tz) >= day)))
  const open = onDay.filter((e) => !e.history)
  const timed = open.filter((e) => !e.all_day && e.type !== 'campaign_window').sort(byStart)
  const live = open.filter((e) => e.state === 'live' || (e.type === 'workflow_timer' && Date.parse(e.start) > now && Date.parse(e.start) - now < 6 * HOUR))
  const future = timed.filter((e) => nextAt(e) >= now)
  const past = timed.filter((e) => nextAt(e) < now)
  const horizon = addDays(day, horizonDays)
  return {
    live,
    next: future.slice(0, 3),
    later: future.slice(3),
    earlier: past,
    needsYou: open.filter((e) => e.owner === 'you').sort(byStart),
    waiting: open.filter((e) => ['seller', 'buyer', 'title', 'external'].includes(e.owner) || e.state === 'waiting').sort(byStart),
    automated: open.filter((e) => e.owner === 'system' && e.type !== 'campaign_window').sort(byStart),
    windows: onDay.filter((e) => e.type === 'campaign_window').sort(byStart),
    deadlines: events.filter((e) => (e.lane === 'closing') && !e.history && !e.undated && eventDay(e, tz) >= day && eventDay(e, tz) <= horizon).sort(byStart),
    history: onDay.filter((e) => e.history).sort(byStart),
  }
}

/* ── TIMELINE: system lane · time spine · you/external lane ───────────── */
export interface TimelineDay { day: string; items: Array<{ e: DeskItem; side: 'system' | 'human' }>; windows: DeskEvent[]; allDay: DeskEvent[] }
export function timelineDays(events: DeskEvent[], { from, to, tz }: { from: string; to: string; tz: string }): TimelineDay[] {
  const out: TimelineDay[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const list = events.filter((e) => !e.undated && eventDay(e, tz) === d)
    const timed = list.filter((e) => !e.all_day && e.type !== 'campaign_window').sort(byStart)
    const items = groupSlots(timed, tz).map((e) => ({ e, side: (isGroup(e) ? e.owner : (e as DeskEvent).owner) === 'system' ? 'system' as const : 'human' as const }))
    out.push({ day: d, items, windows: list.filter((e) => e.type === 'campaign_window'), allDay: list.filter((e) => e.all_day) })
  }
  return out
}

/* ── WEEK: a real time grid ─────────────────────────────────────────── */
export interface WeekCell { day: string; allDay: DeskEvent[]; spans: Array<{ e: DeskEvent; top: number; height: number }>; stacks: Array<{ top: number; items: DeskEvent[]; key: string }> }
/**
 * Timed items sit at their clock (operator zone). Items within `clusterMinutes`
 * of each other become ONE stack ("3 · follow-ups") — never tiny boxes.
 * Windows are soft full-height spans behind them.
 */
export function weekGrid(events: DeskEvent[], days: string[], tz: string, { startHour = 6, endHour = 23, clusterMinutes = 45 } = {}): WeekCell[] {
  const span = (endHour - startHour) * 60
  const pos = (at: string | number, day: string) => {
    const d = dayKey(at, tz)
    const m = d < day ? 0 : d > day ? 24 * 60 : localMinutes(at, tz)
    return Math.min(100, Math.max(0, ((m - startHour * 60) / span) * 100))
  }
  return days.map((day) => {
    const list = events.filter((e) => !e.undated && (eventDay(e, tz) === day || (e.end && dayKey(e.start, tz) <= day && dayKey(e.end, tz) >= day && e.type === 'campaign_window')))
    const windows = list.filter((e) => e.type === 'campaign_window')
    const timed = list.filter((e) => !e.all_day && e.type !== 'campaign_window').sort(byStart)
    const stacks: WeekCell['stacks'] = []
    for (const e of timed) {
      const m = localMinutes(e.start, tz)
      const last = stacks[stacks.length - 1]
      if (last && m - localMinutes(last.items[0].start, tz) < clusterMinutes) last.items.push(e)
      else stacks.push({ top: pos(e.start, day), items: [e], key: `${day}:${e.id}` })
    }
    return {
      day,
      allDay: list.filter((e) => e.all_day),
      spans: windows.map((e) => { const t = pos(e.start, day); return { e, top: t, height: Math.max(2, pos(e.end || e.start, day) - t) } }),
      stacks,
    }
  })
}

/* ── MONTH: macro aggregates per day, straight from the server ─────── */
export interface MonthCell { day: string; inMonth: boolean; agg: DeskDay | null }
export function monthCells(anchor: string, days: Record<string, DeskDay>): MonthCell[] {
  const first = `${anchor.slice(0, 7)}-01`
  const start = weekStart(first)
  return Array.from({ length: 42 }, (_, i) => {
    const d = addDays(start, i)
    return { day: d, inMonth: d.slice(0, 7) === first.slice(0, 7), agg: days[d] ?? null }
  })
}
/** Spec line for a month cell: only what is non-zero, in a fixed order. */
export function aggLine(a: DeskDay | null): string[] {
  if (!a) return []
  const parts: string[] = []
  if (a.windows) parts.push(`${a.windows} window${a.windows === 1 ? '' : 's'}`)
  if (a.closing) parts.push(`${a.closing} closing`)
  if (a.attention) parts.push(`${a.attention} attention`)
  if (a.manual) parts.push(`${a.manual} yours`)
  if (a.automation) parts.push(`${a.automation} automated`)
  if (a.workflow) parts.push(`${a.workflow} workflow`)
  return parts
}

/* ── ATTENTION ─────────────────────────────────────────────────────── */
export const ATTENTION_ORDER: AttentionCategory[] = ['overdue', 'due_today', 'tomorrow', 'missing_date', 'blocking_closing', 'stale_follow_up', 'missed_campaign_schedule', 'waiting_too_long']
export const ATTENTION_LABEL: Record<AttentionCategory, string> = {
  overdue: 'Overdue', due_today: 'Due today', tomorrow: 'Tomorrow', missing_date: 'Missing date', blocking_closing: 'Blocking closing',
  stale_follow_up: 'Stale follow-up', missed_campaign_schedule: 'Missed campaign schedule', waiting_too_long: 'Waiting too long',
}
export function attentionSections(t: Pick<DeskTimeline, 'board' | 'definitions' | 'events' | 'attention'>) {
  const byId = new Map<string, DeskEvent>()
  for (const e of [...t.events, ...t.attention]) byId.set(e.id, e)
  return ATTENTION_ORDER.map((key) => ({
    key,
    label: ATTENTION_LABEL[key],
    definition: t.definitions?.[key] ?? '',
    items: (t.board?.[key] ?? []).map((id) => byId.get(id)).filter((e): e is DeskEvent => Boolean(e)).sort((a, b) => (Date.parse(b.start || '') || 0) - (Date.parse(a.start || '') || 0)),
  }))
}

/* ── NOW: past 2 h → now → next 6 h ─────────────────────────────────── */
export const NOW_LANES = [
  { key: 'campaign', label: 'Campaign windows' },
  { key: 'automation', label: 'Automation' },
  { key: 'workflow', label: 'Workflow' },
  { key: 'manual', label: 'You' },
  { key: 'closing', label: 'Closings' },
] as const
export function nowWindow(events: DeskEvent[], now: number, { pastH = 2, futureH = 6 } = {}) {
  const a = now - pastH * HOUR
  const b = now + futureH * HOUR
  const pct = (t: number) => ((Math.min(b, Math.max(a, t)) - a) / (b - a)) * 100
  const inView = events.filter((e) => !e.undated && !e.all_day && (Date.parse(e.end || e.start) >= a && Date.parse(e.start) <= b))
  const lanes = NOW_LANES.map((l) => ({
    ...l,
    items: inView.filter((e) => (l.key === 'manual' ? e.lane === 'manual' || e.owner === 'you' : e.lane === l.key && e.owner !== 'you'))
      .map((e) => ({ e, left: pct(Date.parse(e.start)), width: e.end ? Math.max(0.8, pct(Date.parse(e.end)) - pct(Date.parse(e.start))) : 0 })),
  }))
  const ticks: number[] = []
  const firstHour = Math.ceil(a / HOUR) * HOUR
  for (let t = firstHour; t <= b; t += HOUR) ticks.push(t)
  return { from: a, to: b, nowPct: pct(now), lanes, ticks: ticks.map((t) => ({ t, pct: pct(t) })) }
}

/* ── the day rail: quiet density per day (max-normalised per channel) ── */
export const DENSITY_CHANNELS = ['campaign', 'closing', 'attention', 'automation', 'manual'] as const
export type DensityChannel = typeof DENSITY_CHANNELS[number]
export function densityRail(days: Record<string, DeskDay>, from: string, to: string) {
  const list: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) list.push(d)
  const max = Object.fromEntries(DENSITY_CHANNELS.map((c) => [c, Math.max(1, ...list.map((d) => Number(days[d]?.[c] ?? 0)))])) as Record<DensityChannel, number>
  const total = Math.max(1, ...list.map((d) => Number(days[d]?.total ?? 0) - Number(days[d]?.completed ?? 0)))
  return list.map((d) => {
    const a = days[d]
    return {
      day: d,
      known: Boolean(a),
      open: a ? a.total - a.completed : 0,
      load: a ? (a.total - a.completed) / total : 0,
      ch: Object.fromEntries(DENSITY_CHANNELS.map((c) => [c, a ? Number(a[c]) / max[c] : 0])) as Record<DensityChannel, number>,
      raw: a,
    }
  })
}

/* ── intelligence: scheduled workload (not a prediction) ───────────── */
export function workloadSplit(events: DeskEvent[]) {
  const open = events.filter((e) => !e.history && !e.undated)
  return {
    system: open.filter((e) => e.owner === 'system').length,
    you: open.filter((e) => e.owner === 'you').length,
    external: open.filter((e) => !['you', 'system'].includes(e.owner)).length,
  }
}
/** Week × hour counts of open, timed items (operator zone). */
export function hourHeat(events: DeskEvent[], tz: string) {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
  for (const e of events) {
    if (e.history || e.all_day || e.undated || e.type === 'campaign_window') continue
    const wd = new Date(`${dayKey(e.start, tz)}T12:00:00Z`).getUTCDay()
    const h = Math.floor(localMinutes(e.start, tz) / 60)
    grid[wd][h] += e.type === 'campaign_sends' ? 1 : e.count || 1
  }
  const max = Math.max(1, ...grid.flat())
  return { grid, max }
}
/** Next weeks' closings and attention on record, per operator week. */
export function weeksAhead(events: DeskEvent[], { today, tz, weeks = 4 }: { today: string; tz: string; weeks?: number }) {
  const w0 = weekStart(today)
  return Array.from({ length: weeks }, (_, i) => {
    const a = addDays(w0, i * 7)
    const b = addDays(a, 6)
    const inWeek = events.filter((e) => !e.history && !e.undated && eventDay(e, tz) >= a && eventDay(e, tz) <= b)
    return { from: a, to: b, closings: inWeek.filter((e) => e.type === 'closing').length, deadlines: inWeek.filter((e) => e.type === 'closing_milestone').length, attention: inWeek.filter((e) => e.attention).length, windows: inWeek.filter((e) => e.type === 'campaign_window').length }
  })
}

/** Which daypart the operator is in (restrained environment tint). */
export function daypart(now: number, tz: string): 'morning' | 'afternoon' | 'evening' | 'night' {
  const h = Math.floor(localMinutes(now, tz) / 60)
  return h >= 5 && h < 11 ? 'morning' : h >= 11 && h < 17 ? 'afternoon' : h >= 17 && h < 21 ? 'evening' : 'night'
}

/** A countdown for a near closing ("in 3 days"), only when the Closing Desk calls it confirmed. */
export function countdown(e: DeskEvent, today: string) {
  if (e.type !== 'closing' || e.history || !e.date) return null
  const n = Math.round((Date.parse(`${e.date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY_MS)
  if (n < 0 || n > 10) return null
  return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`
}
