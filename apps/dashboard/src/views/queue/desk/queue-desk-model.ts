import type { QueueItem, QueueRangeCounts, TextgridFleetNumber } from '../../../domain/queue/queue.types'

/**
 * QUEUE DESK (desktop, R8.3) — pure read models for the desktop command
 * surface. Nothing here decides eligibility, routing or send state: every
 * figure is a count or a placement of rows the queue read already returned,
 * and every label names the canonical status / guard reason it came from.
 *
 * Scope is always explicit: the flow reads the range counts when the server
 * aggregated them (else the page), the lanes / capacity / holds read the rows
 * on the page — the surface says so next to each number.
 */

/* ── row buckets ───────────────────────────────────────────────────────── */

export type DeskBucket = 'upcoming' | 'inflight' | 'done' | 'failed' | 'held' | 'other'

const FAILED = new Set(['failed', 'retry'])
const HELD = new Set(['held', 'blocked', 'blocked_sender_ineligible', 'paused_sender_eligibility_unavailable'])

export function bucketOf(status: string): DeskBucket {
  if (status === 'scheduled' || status === 'ready' || status === 'approval') return 'upcoming'
  if (status === 'queued' || status === 'sending') return 'inflight'
  if (status === 'sent' || status === 'delivered') return 'done'
  if (FAILED.has(status)) return 'failed'
  if (HELD.has(status) || status.startsWith('paused_')) return 'held'
  return 'other'
}

export const BUCKET_LABEL: Record<DeskBucket, string> = {
  upcoming: 'Scheduled',
  inflight: 'Dispatching',
  done: 'Sent',
  failed: 'Failed',
  held: 'Held',
  other: 'Closed',
}

/* ── the flow: scheduled → queued → sending → sent → delivered ─────────── */

export type FlowKey = 'scheduled' | 'queued' | 'sending' | 'sent' | 'delivered' | 'failed' | 'blocked' | 'approval'

export interface FlowNode {
  key: FlowKey
  label: string
  count: number
  tone: 'exec' | 'ok' | 'attn' | 'crit' | 'neutral'
  /** what the count means, for the tooltip */
  hint: string
}

export function flowOf(kpi: Pick<QueueRangeCounts, 'scheduled' | 'queued' | 'sending' | 'sent' | 'delivered' | 'failed' | 'blocked' | 'approval'>): { main: FlowNode[]; branches: FlowNode[] } {
  const main: FlowNode[] = [
    { key: 'scheduled', label: 'Scheduled', count: kpi.scheduled, tone: 'exec', hint: 'Waiting for their send time' },
    { key: 'queued', label: 'Queued', count: kpi.queued, tone: 'exec', hint: 'Due and waiting for the runner' },
    { key: 'sending', label: 'Sending', count: kpi.sending, tone: 'exec', hint: 'Handed to the runner, not yet accepted' },
    { key: 'sent', label: 'Sent', count: kpi.sent, tone: 'ok', hint: 'Accepted by the carrier (includes delivered and later failures)' },
    { key: 'delivered', label: 'Delivered', count: kpi.delivered, tone: 'ok', hint: 'Carrier confirmed delivery' },
  ]
  const branches: FlowNode[] = [
    { key: 'approval', label: 'Approval', count: kpi.approval, tone: 'attn', hint: 'Waiting for an operator' },
    { key: 'blocked', label: 'Held', count: kpi.blocked, tone: 'attn', hint: 'Held before any provider call — nothing was sent' },
    { key: 'failed', label: 'Failed', count: kpi.failed, tone: 'crit', hint: 'Rejected or undeliverable' },
  ]
  return { main, branches }
}

/* ── lanes: one per recipient time zone ────────────────────────────────── */

const ZONE_NAMES: Record<string, string> = {
  'America/New_York': 'Eastern', 'America/Detroit': 'Eastern', 'America/Indiana/Indianapolis': 'Eastern', 'America/Kentucky/Louisville': 'Eastern',
  'America/Chicago': 'Central', 'America/Indiana/Knox': 'Central', 'America/Menominee': 'Central',
  'America/Denver': 'Mountain', 'America/Boise': 'Mountain', 'America/Phoenix': 'Arizona',
  'America/Los_Angeles': 'Pacific', 'America/Anchorage': 'Alaska', 'Pacific/Honolulu': 'Hawaii',
}

export function zoneName(tz: string): string {
  return ZONE_NAMES[tz] ?? (tz.split('/').pop() ?? tz).replace(/_/g, ' ')
}

export interface LaneTick { id: string; pos: number; bucket: DeskBucket }

export interface ZoneLane {
  tz: string
  label: string
  /** the recipient's wall clock right now ("2:41 PM") */
  localTime: string
  localHour: number
  total: number
  counts: Record<DeskBucket, number>
  ticks: LaneTick[]
  /** rows whose time falls outside the drawn window */
  outside: number
}

export interface LaneWindow { fromMs: number; toMs: number; hours: number }

export function laneWindow(nowMs: number, before = 6, after = 18): LaneWindow {
  return { fromMs: nowMs - before * 3_600_000, toMs: nowMs + after * 3_600_000, hours: before + after }
}

const H = 3_600_000

/**
 * The drawn window fits the page: from its earliest to its latest placed row,
 * always including now with 6 h either side, never wider than 7 days back /
 * 7 days ahead. Rows outside it are counted as off-window, never dropped.
 */
export function laneWindowFor(items: ReadonlyArray<Pick<QueueItem, 'sentAt' | 'scheduledForUtc'>>, nowMs: number): LaneWindow {
  let lo = nowMs - 6 * H
  let hi = nowMs + 6 * H
  for (const i of items) {
    const t = placedAt(i)
    if (!Number.isFinite(t)) continue
    if (t < lo) lo = t
    if (t > hi) hi = t
  }
  lo = Math.max(lo, nowMs - 168 * H)
  hi = Math.min(hi, nowMs + 168 * H)
  const step = (hi - lo) <= 36 * H ? H : 6 * H
  lo = Math.floor(lo / step) * step
  hi = Math.ceil(hi / step) * step
  return { fromMs: lo, toMs: hi, hours: (hi - lo) / H }
}

/** Axis marks relative to now ("−2d", "−12h", "now", "+6h"), 5–9 of them. */
export function laneMarks(win: LaneWindow, nowMs: number): Array<{ at: number; label: string; now: boolean }> {
  const span = win.hours
  const step = span <= 30 ? 3 : span <= 60 ? 6 : span <= 120 ? 12 : span <= 240 ? 24 : 48
  const out: Array<{ at: number; label: string; now: boolean }> = []
  const fmt = (h: number) => {
    const a = Math.abs(h)
    const txt = a >= 24 && a % 24 === 0 ? `${a / 24}d` : `${a}h`
    return `${h > 0 ? '+' : '−'}${txt}`
  }
  for (let h = -Math.floor((nowMs - win.fromMs) / H / step) * step; nowMs + h * H <= win.toMs; h += step) {
    if (h === 0) continue
    out.push({ at: nowMs + h * H, label: fmt(h), now: false })
  }
  out.push({ at: nowMs, label: 'now', now: true })
  return out.sort((a, b) => a.at - b.at)
}

export function spanWords(win: LaneWindow, nowMs: number): string {
  const back = Math.round((nowMs - win.fromMs) / H)
  const ahead = Math.round((win.toMs - nowMs) / H)
  const w = (h: number) => (h >= 48 ? `${Math.round(h / 24)} d` : `${h} h`)
  return `${w(back)} back to ${w(ahead)} ahead`
}

/** The instant a row is placed at: the time it went out if it went out, else its scheduled time. */
export function placedAt(item: Pick<QueueItem, 'sentAt' | 'scheduledForUtc'>): number {
  const t = Date.parse(item.sentAt || item.scheduledForUtc)
  return Number.isFinite(t) ? t : NaN
}

function localClock(tz: string, nowMs: number): { text: string; hour: number } {
  try {
    const d = new Date(nowMs)
    const text = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d)
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(d))
    return { text, hour: Number.isFinite(hour) ? hour : 0 }
  } catch {
    return { text: '—', hour: 0 }
  }
}

const emptyCounts = (): Record<DeskBucket, number> => ({ upcoming: 0, inflight: 0, done: 0, failed: 0, held: 0, other: 0 })

export function zoneLanes(items: ReadonlyArray<Pick<QueueItem, 'id' | 'timezone' | 'status' | 'sentAt' | 'scheduledForUtc'>>, nowMs: number, win: LaneWindow = laneWindow(nowMs)): ZoneLane[] {
  const by = new Map<string, ZoneLane>()
  for (const item of items) {
    const tz = item.timezone || 'Unknown'
    let lane = by.get(tz)
    if (!lane) {
      const clock = tz === 'Unknown' ? { text: '—', hour: 0 } : localClock(tz, nowMs)
      lane = { tz, label: tz === 'Unknown' ? 'Zone not recorded' : zoneName(tz), localTime: clock.text, localHour: clock.hour, total: 0, counts: emptyCounts(), ticks: [], outside: 0 }
      by.set(tz, lane)
    }
    const bucket = bucketOf(item.status)
    lane.total += 1
    lane.counts[bucket] += 1
    const t = placedAt(item)
    if (Number.isFinite(t) && t >= win.fromMs && t <= win.toMs) lane.ticks.push({ id: item.id, pos: (t - win.fromMs) / (win.toMs - win.fromMs), bucket })
    else lane.outside += 1
  }
  // east → west reads like the day moving across the country; unknown last
  const order = ['Eastern', 'Central', 'Mountain', 'Arizona', 'Pacific', 'Alaska', 'Hawaii']
  return [...by.values()].sort((a, b) => {
    const ai = order.indexOf(a.label); const bi = order.indexOf(b.label)
    if (a.tz === 'Unknown' || b.tz === 'Unknown') return a.tz === 'Unknown' ? 1 : -1
    if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
    return b.total - a.total
  })
}

/* ── sender capacity: the fleet's own caps and today's sends ───────────── */

export interface SenderLine {
  phone: string
  name: string
  market: string
  active: boolean
  status: string
  cap: number | null
  sentToday: number
  /** share of the daily cap used, when a cap is recorded */
  used: number | null
  /** page rows still to go out from this number */
  pending: number
}

export interface SenderCapacity {
  lines: SenderLine[]
  active: number
  inactive: number
  /** sum of recorded caps over active numbers (null when none is recorded) */
  cap: number | null
  sentToday: number
  /** active numbers with no cap recorded — their headroom is unknown */
  uncapped: number
}

export function senderCapacity(fleet: ReadonlyArray<TextgridFleetNumber>, items: ReadonlyArray<Pick<QueueItem, 'fromPhoneNumber' | 'status'>>): SenderCapacity {
  const pending = new Map<string, number>()
  for (const i of items) {
    const b = bucketOf(i.status)
    if (i.fromPhoneNumber && (b === 'upcoming' || b === 'inflight')) pending.set(i.fromPhoneNumber, (pending.get(i.fromPhoneNumber) ?? 0) + 1)
  }
  const lines: SenderLine[] = fleet.map((n) => ({
    phone: n.phone,
    name: n.friendlyName || n.market,
    market: n.market,
    active: n.isActive,
    status: n.status,
    cap: n.dailyCap,
    sentToday: n.messagesSentToday,
    used: n.dailyCap && n.dailyCap > 0 ? Math.min(1, n.messagesSentToday / n.dailyCap) : null,
    pending: pending.get(n.phone) ?? 0,
  }))
  lines.sort((a, b) => Number(b.active) - Number(a.active) || (b.used ?? -1) - (a.used ?? -1) || b.pending - a.pending || a.name.localeCompare(b.name))
  const active = lines.filter((l) => l.active)
  const capped = active.filter((l) => l.cap !== null && l.cap > 0)
  return {
    lines,
    active: active.length,
    inactive: lines.length - active.length,
    cap: capped.length ? capped.reduce((n, l) => n + (l.cap ?? 0), 0) : null,
    sentToday: active.reduce((n, l) => n + l.sentToday, 0),
    uncapped: active.length - capped.length,
  }
}

/* ── holds and failures, by their canonical reason ─────────────────────── */

const HOLD_LABEL: Record<string, string> = {
  no_eligible_sender_for_route: 'No eligible sender for the route',
  no_eligible_sender: 'No eligible sender',
  blocked_sender_ineligible: 'Assigned sender no longer eligible',
  outbound_number_health_cooling: 'Sender cooling (health)',
  outbound_number_cooling_until: 'Sender cooling',
  outbound_number_status_paused: 'Sender paused',
  outbound_number_daily_limit_reached: 'Sender at its daily cap',
  outbound_number_not_in_fleet: 'Sender not in the fleet',
  paused_sender_eligibility_unavailable: 'Fleet unreadable — deferred',
  paused_global_lock: 'Global send lock',
  paused_duplicate: 'Duplicate held',
  paused_name_missing: 'Seller name missing',
  paused_max_retries: 'Retries exhausted',
  paused_invalid_queue_row: 'Invalid queue row',
  held: 'Held by operator',
  blocked: 'Blocked',
}

export function holdLabel(code: string): string {
  return HOLD_LABEL[code] ?? code.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/** sender-side holds are the ones Sender Routing parks (no provider call, no retry burned) */
export function isSenderHold(code: string): boolean {
  return code.includes('sender') || code.startsWith('outbound_number_')
}

export interface ReasonLine {
  code: string
  label: string
  kind: 'hold' | 'failure'
  count: number
  sender: boolean
}

export function holdCode(item: Pick<QueueItem, 'status' | 'guardReason' | 'blockedReason' | 'pausedReason'>): string {
  return (item.guardReason || item.blockedReason || item.pausedReason || item.status || 'unknown').trim()
}

export function reasonBook(
  items: ReadonlyArray<Pick<QueueItem, 'status' | 'guardReason' | 'blockedReason' | 'pausedReason'>>,
  failureCause: (item: never) => string,
  failureLabel: Record<string, string>,
): ReasonLine[] {
  const by = new Map<string, ReasonLine>()
  for (const item of items) {
    const b = bucketOf(item.status)
    if (b !== 'held' && b !== 'failed') continue
    const kind = b === 'held' ? 'hold' : 'failure'
    const code = kind === 'hold' ? holdCode(item) : failureCause(item as never)
    const key = `${kind}:${code}`
    const line = by.get(key) ?? { code, label: kind === 'hold' ? holdLabel(code) : (failureLabel[code] ?? holdLabel(code)), kind, count: 0, sender: kind === 'hold' && isSenderHold(code) }
    line.count += 1
    by.set(key, line)
  }
  return [...by.values()].sort((a, b) => (a.kind === b.kind ? b.count - a.count : a.kind === 'hold' ? -1 : 1))
}
