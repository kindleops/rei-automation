/**
 * CALENDAR 5.0 · TEMPORAL MODEL — pure arrangement of the server's canonical
 * events (/api/cockpit/calendar/timeline, view=desk, contract v5).
 *
 * Nothing here creates, dates, estimates or scores an event. It places what
 * the read model returned on a time axis, groups it into lanes, clusters what
 * would collide, and counts only what is on screen — each count with a basis
 * the UI states. Pure functions, so every rule is a test.
 */
import type { AttentionCategory, DeskCampaign, DeskDay, DeskEvent, DeskOwner, DeskTimeline } from '../../../domain/calendar/calendar-timeline-api'
import type { IconName } from '../../../shared/icons'
import {
  DAY_MS, HOUR, MIN, addDays, clock, clockShort, dayBounds, dayKey, daysBetween, hourTicks, localMinutes, monthDay, monthStart, span, weekStart, weekday, zoneAbbr, zonedInstant,
} from './temporal-time'

/* ══ VOCABULARY ═══════════════════════════════════════════════════════════ */

export type LaneKey = 'campaigns' | 'sellers' | 'workflows' | 'deals' | 'closings' | 'email'
export type SourceKey = 'campaigns' | 'inbox' | 'workflow' | 'pipeline' | 'closing' | 'email'
export type OwnerKey = 'all' | 'system' | 'you' | 'external'
export type Shape = 'window' | 'point' | 'deadline' | 'milestone' | 'wait' | 'group'
export type StatusKey = 'scheduled' | 'running' | 'waiting' | 'needs_you' | 'attention' | 'overdue' | 'missed' | 'failed' | 'completed' | 'cancelled'
export type Tone = 'exec' | 'ok' | 'attn' | 'crit' | 'flow' | 'neutral'

/** Domain lanes, top to bottom. Ownership is a mark on the event, not a lane. */
export const LANES: ReadonlyArray<{ key: LaneKey; label: string; source: SourceKey }> = [
  { key: 'campaigns', label: 'Campaigns', source: 'campaigns' },
  { key: 'sellers', label: 'Sellers', source: 'inbox' },
  { key: 'workflows', label: 'Workflows', source: 'workflow' },
  { key: 'deals', label: 'Deals', source: 'pipeline' },
  { key: 'closings', label: 'Closings', source: 'closing' },
  { key: 'email', label: 'Email', source: 'email' },
]
export const LANE_ICON: Record<LaneKey, IconName> = { campaigns: 'send', sellers: 'message', workflows: 'layers', deals: 'briefcase', closings: 'key', email: 'mail' }
export const SOURCE_LABEL: Record<SourceKey, string> = {
  campaigns: 'Campaign Command', inbox: 'Inbox', workflow: 'Workflow Studio', pipeline: 'Pipeline', closing: 'Closing Desk', email: 'Email Command',
}
export const SOURCES: SourceKey[] = ['campaigns', 'inbox', 'workflow', 'pipeline', 'closing', 'email']

export function laneOf(e: Pick<DeskEvent, 'type'>): LaneKey {
  const t = e.type
  if (t === 'campaign_window' || t === 'campaign_start' || t === 'campaign_sends') return 'campaigns'
  if (t === 'workflow_timer' || t === 'workflow_approval' || t === 'workflow_held' || t === 'workflow_run') return 'workflows'
  if (t === 'pipeline_action' || t === 'offer') return 'deals'
  if (t === 'closing' || t === 'closing_milestone' || t === 'closing_missing_date') return 'closings'
  if (t === 'email_scheduled') return 'email'
  return 'sellers'
}
export const sourceOf = (e: Pick<DeskEvent, 'app'>): SourceKey => (e.app === 'campaigns' || e.app === 'inbox' || e.app === 'workflow' || e.app === 'pipeline' || e.app === 'closing' || e.app === 'email' ? e.app : 'inbox')

/** System · You · External (seller, buyer, title and third parties). */
export const ownerClass = (o: DeskOwner): Exclude<OwnerKey, 'all'> => (o === 'you' ? 'you' : o === 'system' ? 'system' : 'external')
export const OWNER_WORD: Record<DeskOwner, string> = { you: 'You', system: 'System', seller: 'Seller', buyer: 'Buyer', title: 'Title', external: 'External party' }
/** What the event waits on (§22, §78): a time-based wait, an external party, you — or the system handling it. */
export function waitingOn(e: DeskEvent, tz: string): string | null {
  if (e.history) return null
  if (e.type === 'workflow_timer') return e.state === 'overdue' ? 'Timer ran out — the run has not resumed' : `Waiting until ${clock(e.start, tz)}`
  if (e.owner === 'seller' || e.owner === 'buyer' || e.owner === 'title') return `Waiting on ${e.owner}`
  if (e.owner === 'external') return 'Waiting on a third party'
  if (e.type === 'email_scheduled' && e.state === 'waiting') return 'Waiting for email sending to be switched on'
  if (e.owner === 'you') return 'Waiting on you'
  if (e.manual) return 'You scheduled it — the queue sends it'
  return 'System handling'
}

export function shapeOf(e: DeskEvent): Shape {
  switch (e.type) {
    case 'campaign_window': return 'window'
    case 'workflow_timer': return 'wait'
    case 'campaign_sends': case 'scheduled_message_group': return 'group'
    case 'closing': case 'offer': case 'campaign_start': return 'milestone'
    case 'closing_milestone': case 'closing_missing_date': case 'workflow_approval': return 'deadline'
    case 'pipeline_action': return e.time_kind === 'due' ? 'deadline' : 'point'
    default: return 'point'
  }
}

const FAILED_STATUS = new Set(['blocked', 'failed', 'held'])
/** The one status an operator reads, in the platform vocabulary (§56). */
export function statusOf(e: DeskEvent): StatusKey {
  const st = String(e.status || '')
  if (e.state === 'cancelled' || e.state === 'superseded') return 'cancelled'
  if (e.state === 'completed') return st === 'failed' ? 'failed' : 'completed'
  if (st === 'missed') return 'missed'
  if (FAILED_STATUS.has(st) || e.actor === 'blocked') return 'failed'
  if (e.state === 'live') return 'running'
  if (e.state === 'overdue') return 'overdue'
  if (e.state === 'needs_you') return 'needs_you'
  if (e.state === 'waiting') return 'waiting'
  if (e.attention) return 'attention'
  return 'scheduled'
}
export const STATUS_LABEL: Record<StatusKey, string> = {
  scheduled: 'Scheduled', running: 'Running', waiting: 'Waiting', needs_you: 'Needs you', attention: 'Needs attention',
  overdue: 'Overdue', missed: 'Missed', failed: 'Failed', completed: 'Completed', cancelled: 'Cancelled',
}
export const STATUSES: StatusKey[] = ['scheduled', 'running', 'waiting', 'needs_you', 'attention', 'overdue', 'missed', 'failed', 'completed', 'cancelled']

/** Semantic tone: cyan = system working, gold = attention, red = true failure only. */
export function toneOf(e: DeskEvent): Tone {
  const s = statusOf(e)
  if (s === 'failed') return 'crit'
  if (e.attention_state === 'blocking' && s !== 'missed') return 'crit'
  if (s === 'overdue' || s === 'missed' || s === 'needs_you' || s === 'attention') return 'attn'
  if (s === 'completed') return 'ok'
  if (s === 'cancelled' || s === 'waiting') return 'neutral'
  if (laneOf(e) === 'workflows') return 'flow'
  return 'exec'
}

/** "8:00 AM–9:00 PM ET" in the zone the time is DEFINED in, plus the operator's clock when they differ (§81–82). */
export function timeText(e: DeskEvent, opTz: string): { main: string; alt: string | null } {
  if (e.undated) return { main: 'No date on record', alt: null }
  if (e.all_day) return { main: e.time_kind === 'due' ? 'Due · date only' : 'All day', alt: null }
  const own = e.tz && e.tz !== opTz ? e.tz : null
  const z = own || opTz
  const s = clock(e.start, z)
  const end = e.end && e.type === 'campaign_window' ? clock(e.end, z) : null
  const main = `${end ? `${s}–${end}` : s} ${zoneAbbr(z)}`
  if (!own) return { main, alt: null }
  const os = clock(e.start, opTz)
  const oe = end ? clock(e.end as string, opTz) : null
  if (os === s && (!oe || oe === end)) return { main, alt: null }
  return { main, alt: `${oe ? `${os}–${oe}` : os} ${zoneAbbr(opTz)}` }
}

/** What a screen reader hears (§161): title, time, status, owner, source, attention. */
export function eventLabel(e: DeskEvent, tz: string) {
  const t = timeText(e, tz)
  return [
    e.title, e.subtitle, `${t.main}${t.alt ? ` (${t.alt})` : ''}`, STATUS_LABEL[statusOf(e)], `owner ${OWNER_WORD[e.owner]}`, `from ${SOURCE_LABEL[sourceOf(e)]}`,
    e.attention ? 'needs attention' : null,
  ].filter(Boolean).join(', ')
}

/* ══ FILTERS ══════════════════════════════════════════════════════════════ */

export interface Filters { owner: OwnerKey; sources: SourceKey[]; statuses: StatusKey[]; markets: string[]; history: boolean }
export const NO_FILTERS: Filters = { owner: 'all', sources: [], statuses: [], markets: [], history: true }

export function applyFilters(events: DeskEvent[], f: Filters): DeskEvent[] {
  return events.filter((e) => {
    if (!f.history && e.history) return false
    if (f.owner !== 'all' && ownerClass(e.owner) !== f.owner) return false
    if (f.sources.length && !f.sources.includes(sourceOf(e))) return false
    if (f.statuses.length && !f.statuses.includes(statusOf(e)) && !(f.statuses.includes('attention') && e.attention)) return false
    if (f.markets.length && !(e.market && f.markets.includes(e.market))) return false
    return true
  })
}
export const filterCount = (f: Filters) => (f.owner !== 'all' ? 1 : 0) + f.sources.length + f.statuses.length + f.markets.length + (f.history ? 0 : 1)
export const marketsOf = (events: DeskEvent[]) => [...new Set(events.map((e) => e.market).filter((m): m is string => Boolean(m)))].sort()

/* ══ THE TIME AXIS ════════════════════════════════════════════════════════ */

export interface Domain { from: number; to: number }
export type Zoom = 'fit' | '6h' | '12h' | '24h'
export const pct = (t: number, d: Domain) => ((t - d.from) / (d.to - d.from)) * 100

const floorHour = (t: number, tz: string) => t - (localMinutes(t, tz) % 60) * MIN - (t % MIN)
const ceilHour = (t: number, tz: string) => { const f = floorHour(t, tz); return f === t ? t : f + HOUR }

/**
 * TODAY's span (§122–123): the working day the events actually occupy — never
 * 1 AM–6 AM when everything is 8 AM–6 PM — always including NOW on today,
 * padded an hour each side, at least `minHours`, whole local hours, inside
 * the day. No events: the contact window the queue enforces (08:00–21:00).
 */
export function fitDomain(events: DeskEvent[], { day, tz, now, minHours = 8, fallback = ['08:00', '21:00'] as [string, string] }: { day: string; tz: string; now: number; minHours?: number; fallback?: [string, string] }): Domain {
  const b = dayBounds(day, tz)
  const times: number[] = []
  for (const e of events) {
    if (e.undated || e.all_day) continue
    const s = Date.parse(e.start)
    const end = e.end ? Date.parse(e.end) : s
    if (end < b.start || s >= b.end) continue
    times.push(Math.max(b.start, s), Math.min(b.end, end))
  }
  if (now >= b.start && now < b.end) times.push(now)
  let from: number
  let to: number
  if (times.length) {
    from = Math.min(...times) - HOUR
    to = Math.max(...times) + HOUR
  } else {
    from = zonedInstant(day, fallback[0], tz)
    to = zonedInstant(day, fallback[1], tz)
  }
  const need = minHours * HOUR - (to - from)
  if (need > 0) { from -= need / 2; to += need / 2 }
  from = Math.max(b.start, floorHour(from, tz))
  to = Math.min(b.end, ceilHour(to, tz))
  if (to - from < minHours * HOUR) {
    if (from === b.start) to = Math.min(b.end, from + minHours * HOUR)
    else from = Math.max(b.start, to - minHours * HOUR)
  }
  return { from, to }
}

/** A fixed-width zoom (§122) centred on NOW (today) or on the fitted span, kept inside the day. */
export function zoomDomain(zoom: Zoom, { fit, day, tz, now }: { fit: Domain; day: string; tz: string; now: number }): Domain {
  const b = dayBounds(day, tz)
  if (zoom === 'fit') return fit
  if (zoom === '24h') return { from: b.start, to: b.end }
  const w = (zoom === '6h' ? 6 : 12) * HOUR
  const centre = now >= b.start && now < b.end ? now : (fit.from + fit.to) / 2
  let from = floorHour(centre - w / 2, tz)
  from = Math.min(Math.max(b.start, from), b.end - w)
  return { from: Math.max(b.start, from), to: Math.min(b.end, Math.max(b.start, from) + w) }
}

/** Axis ticks with labels thinned to fit the width (one label per ≥ 64 px). */
export function axisTicks(d: Domain, tz: string, widthPx: number) {
  const hours = (d.to - d.from) / HOUR
  const room = Math.max(1, widthPx / 64)
  const every = [1, 2, 3, 4, 6, 12].find((n) => hours / n <= room) ?? 24
  return hourTicks(d.from, d.to, tz, 1).map((t) => ({ t, pct: pct(t, d), label: Math.floor(localMinutes(t, tz) / 60) % every === 0 }))
}

/* ══ LANE LAYOUT ══════════════════════════════════════════════════════════ */

export interface Band { e: DeskEvent; left: number; width: number; row: number; sends: DeskEvent | null; clipped: { start: boolean; end: boolean } }
export interface Mark { e: DeskEvent; at: number; left: number; shape: Shape; label: boolean; room: number }
export interface Cluster { id: string; at: number; left: number; members: DeskEvent[]; label: string; room: number }
export interface Span { e: DeskEvent; left: number; width: number; row: number }
export interface LaneModel {
  key: LaneKey
  label: string
  bands: Band[]
  rows: number
  spans: Span[]
  marks: Mark[]
  clusters: Cluster[]
  allDay: DeskEvent[]
  count: number
}

const timed = (e: DeskEvent) => !e.undated && !e.all_day
/** Where a mark sits: a live campaign day at its next queued row, else its start. */
export const markAt = (e: DeskEvent) => Date.parse(e.start)

/**
 * Lanes for one domain. Windows are duration bands (stacked when they
 * overlap); a campaign's queued day rides inside its window band; marks
 * within `clusterPx` of each other become ONE cluster ("2:20 PM · 4
 * actions" — never overlapping text); a mark keeps its label only when the
 * next mark is at least `labelPx` away. Only lanes with activity appear.
 */
export function laneLayout(events: DeskEvent[], { domain, widthPx, clusterPx = 26, labelPx = 150, days }: { domain: Domain; widthPx: number; clusterPx?: number; labelPx?: number; days?: string[]; tz?: string }): LaneModel[] {
  const w = Math.max(240, widthPx)
  const inside = (e: DeskEvent) => {
    if (!timed(e)) return false
    const s = Date.parse(e.start)
    const end = e.end ? Date.parse(e.end) : s
    return end >= domain.from && s <= domain.to
  }
  const out: LaneModel[] = []
  for (const lane of LANES) {
    const mine = events.filter((e) => laneOf(e) === lane.key)
    const allDay = mine.filter((e) => e.all_day && !e.undated && (!days || days.includes(e.date || '')))
    const vis = mine.filter(inside)
    if (!vis.length && !allDay.length) continue
    // bands: campaign windows; the day's queued sends ride inside their window
    const windows = vis.filter((e) => e.type === 'campaign_window').sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    const sends = vis.filter((e) => e.type === 'campaign_sends')
    const used = new Set<string>()
    const rowEnds: number[] = []
    const bands: Band[] = windows.map((e) => {
      const s = Date.parse(e.start)
      const end = Date.parse(e.end || e.start)
      let row = rowEnds.findIndex((r) => r <= s)
      if (row < 0) { row = rowEnds.length; rowEnds.push(end) } else rowEnds[row] = end
      const day = (e.source_id || '').split(':').pop() || ''
      const ride = sends.find((g) => g.links.campaign_id === e.links.campaign_id && (g.source_id || '').endsWith(`:${day}`)) || null
      if (ride) used.add(ride.id)
      const left = Math.max(0, pct(s, domain))
      const right = Math.min(100, pct(end, domain))
      return { e, left, width: Math.max(0.6, right - left), row, sends: ride, clipped: { start: s < domain.from, end: end > domain.to } }
    })
    // spans: a workflow timer waits from its anchor (or the run's start) to wake
    const spans: Span[] = []
    const spanEnds: number[] = []
    for (const e of vis.filter((x) => x.type === 'workflow_timer')) {
      const wake = Date.parse(e.start)
      const anchor = Date.parse(String((e.detail as { anchor_at?: string | null })?.anchor_at || (e.detail as { started_at?: string | null })?.started_at || ''))
      if (!Number.isFinite(anchor) || anchor >= wake) continue
      let row = spanEnds.findIndex((r) => r <= anchor)
      if (row < 0) { row = spanEnds.length; spanEnds.push(wake) } else spanEnds[row] = wake
      const left = Math.max(0, pct(anchor, domain))
      spans.push({ e, left, width: Math.max(0.4, Math.min(100, pct(wake, domain)) - left), row })
    }
    // marks + clusters (a timer drawn as a wait span is not drawn twice)
    const spanned = new Set(spans.map((x) => x.e.id))
    const pts = vis.filter((e) => e.type !== 'campaign_window' && !used.has(e.id) && !spanned.has(e.id)).sort((a, b) => markAt(a) - markAt(b))
    const marks: Mark[] = []
    const clusters: Cluster[] = []
    let i = 0
    while (i < pts.length) {
      const first = pts[i]
      const x0 = (pct(markAt(first), domain) / 100) * w
      let j = i + 1
      while (j < pts.length && (pct(markAt(pts[j]), domain) / 100) * w - x0 < clusterPx) j += 1
      const group = pts.slice(i, j)
      const at = markAt(first)
      if (group.length === 1) marks.push({ e: first, at, left: pct(at, domain), shape: shapeOf(first), label: false, room: 0 })
      else clusters.push({ id: `cluster:${lane.key}:${first.id}`, at, left: pct(at, domain), members: group, label: `${group.length} ${lane.key === 'sellers' ? 'seller actions' : 'actions'}`, room: 0 })
      i = j
    }
    // labels: only where the next object leaves room for them
    const objects = [...marks.map((m) => ({ left: m.left, m, c: null as Cluster | null })), ...clusters.map((c) => ({ left: c.left, m: null as Mark | null, c }))].sort((a, b) => a.left - b.left)
    objects.forEach((o, k) => {
      const next = objects[k + 1]
      const room = (next ? ((next.left - o.left) / 100) * w : ((100 - o.left) / 100) * w) - 22
      if (o.c) { o.c.room = Math.max(0, Math.round(room)); return }
      if (!o.m) return
      o.m.room = Math.max(0, Math.round(room))
      // a tight mark still says WHEN (time only); the title needs more room
      o.m.label = room >= Math.min(labelPx, 40)
    })
    // what the lane shows: distinct objects (a campaign day riding in its window is part of the band)
    out.push({ key: lane.key, label: lane.label, bands, rows: rowEnds.length, spans, marks, clusters, allDay, count: vis.length - used.size + allDay.length })
  }
  return out
}

/** Send density inside a window band: the queue's own per-slot counts (sent · waiting · failed). */
export function bandDensity(sends: DeskEvent | null, { domain, tz, day }: { domain: Domain; tz: string; day: string }) {
  const d = sends?.detail as { slots?: Array<[number, number, number, number]>; slot_minutes?: number } | undefined
  if (!d?.slots?.length) return { bars: [] as Array<{ left: number; width: number; done: number; waiting: number; failed: number }>, max: 0 }
  const size = d.slot_minutes || 30
  const bars = d.slots.map(([slot, done, waiting, failed]) => {
    const from = zonedInstant(day, `${String(Math.floor((slot * size) / 60)).padStart(2, '0')}:${String((slot * size) % 60).padStart(2, '0')}`, tz)
    const left = pct(from, domain)
    return { left, width: (size * MIN * 100) / (domain.to - domain.from), done, waiting, failed }
  })
  return { bars, max: Math.max(1, ...bars.map((b) => b.done + b.waiting + b.failed)) }
}

/* ══ OPERATIONS LOAD (§66–68) ════════════════════════════════════════════ */

export type LoadKey = 'campaigns' | 'sellers' | 'workflows' | 'deals' | 'closings' | 'email'
export interface LoadBin { from: number; to: number; values: Record<LoadKey, number>; total: number }
export const LOAD_KEYS: LoadKey[] = ['campaigns', 'sellers', 'workflows', 'deals', 'closings', 'email']

/**
 * Timed actions per bin by lane. Campaign texts come from the queue's own
 * per-slot schedule (a campaign day's rows), never spread evenly; every
 * other event counts once at its time; a group counts its members. Windows
 * are not load — they are coverage, drawn separately.
 */
export function loadSeries(events: DeskEvent[], { domain, tz, binMinutes = 30 }: { domain: Domain; tz: string; binMinutes?: number }) {
  const n = Math.max(1, Math.ceil((domain.to - domain.from) / (binMinutes * MIN)))
  const size = (domain.to - domain.from) / n
  const bins: LoadBin[] = Array.from({ length: n }, (_, i) => ({ from: domain.from + i * size, to: domain.from + (i + 1) * size, values: { campaigns: 0, sellers: 0, workflows: 0, deals: 0, closings: 0, email: 0 }, total: 0 }))
  const put = (at: number, key: LoadKey, v: number) => {
    if (at < domain.from || at >= domain.to || v <= 0) return
    const b = bins[Math.min(n - 1, Math.floor((at - domain.from) / size))]
    b.values[key] += v
    b.total += v
  }
  for (const e of events) {
    if (!timed(e) || e.state === 'cancelled' || e.state === 'superseded' || e.type === 'campaign_window') continue
    const key = laneOf(e) as LoadKey
    if (e.type === 'campaign_sends') {
      const d = e.detail as { slots?: Array<[number, number, number, number]>; slot_minutes?: number }
      const day = dayKey(e.start, tz)
      const sz = d?.slot_minutes || 30
      for (const [slot, done, waiting, failed] of d?.slots ?? []) {
        put(zonedInstant(day, `${String(Math.floor((slot * sz) / 60)).padStart(2, '0')}:${String((slot * sz) % 60).padStart(2, '0')}`, tz) + 1, 'campaigns', done + waiting + failed)
      }
      continue
    }
    if (e.type === 'scheduled_message_group') {
      const members = (e.detail as { members?: Array<{ start: string }> })?.members ?? []
      if (members.length) { for (const m of members) put(Date.parse(m.start), key, 1); continue }
    }
    put(Date.parse(e.start), key, e.count && e.type !== 'campaign_start' ? e.count : 1)
  }
  const coverage = events.filter((e) => e.type === 'campaign_window' && !e.history && timed(e)).map((e) => ({ from: Math.max(domain.from, Date.parse(e.start)), to: Math.min(domain.to, Date.parse(e.end || e.start)) })).filter((c) => c.to > c.from)
  const max = Math.max(0, ...bins.map((b) => b.total))
  const peak = max > 0 ? bins.find((b) => b.total === max) ?? null : null
  return { bins, max, peak, coverage, binMinutes }
}

/* ══ THE TEMPORAL BRIEF (§60–65) ═════════════════════════════════════════ */

export interface BriefLine { key: string; text: string; tone?: Tone; ids?: string[]; basis: string }
export interface BriefModel {
  posture: 'clear' | 'system' | 'you' | 'attention'
  headline: string
  rightNow: BriefLine[]
  next: DeskEvent[]
  forecast: BriefLine[]
  endOfDay: BriefLine[]
  tomorrow: BriefLine[]
}
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
const sum = (xs: Array<number | null | undefined>) => xs.reduce<number>((a, b) => a + (Number(b) || 0), 0)

const onDay = (e: DeskEvent, day: string, tz: string) => !e.undated && (e.all_day ? e.date === day : dayKey(e.start, tz) === day || Boolean(e.end && dayKey(e.start, tz) < day && dayKey(e.end, tz) >= day))

/** Deterministic lines only; each says what it counts. */
export function briefModel(data: DeskTimeline, events: DeskEvent[], { now, tz, day }: { now: number; tz: string; day: string }): BriefModel {
  const today = data.range.today
  const isToday = day === today
  const roster: DeskCampaign[] = data.campaigns ?? []
  const open = events.filter((e) => !e.history)
  const dayOpen = open.filter((e) => onDay(e, day, tz))
  const sending = roster.filter((c) => c.situation === 'sending')
  const ahead = roster.filter((c) => c.situation === 'window_ahead')
  const queued = sum(roster.map((c) => c.counts.queued))
  const hour = open.filter((e) => e.type === 'seller_follow_up' && timed(e) && Date.parse(e.start) >= now && Date.parse(e.start) < now + HOUR)
  // overdue attention, without the missed campaign starts (they get their own line)
  const overdue = data.attention.filter((e) => e.state === 'overdue' && !e.history && statusOf(e) !== 'missed')
  // yours: open on this day, plus anything of yours overdue — including what sits before the loaded range
  const yoursIds = new Set<string>()
  const yoursOpen = [...open.filter((e) => e.owner === 'you' && (onDay(e, day, tz) || e.state === 'overdue')), ...data.attention.filter((e) => e.owner === 'you' && e.state === 'overdue' && !e.history)]
    .filter((e) => (yoursIds.has(e.id) ? false : (yoursIds.add(e.id), true)))
  const rightNow: BriefLine[] = []
  if (isToday) {
    if (sending.length) rightNow.push({ key: 'sending', text: `${plural(sending.length, 'campaign window')} sending`, tone: 'exec', ids: sending.map((c) => c.window_event_id).filter((x): x is string => Boolean(x)), basis: 'Live campaigns whose send window is open now, in each campaign\'s market zone.' })
    else if (ahead.length) {
      const opens = Math.min(...ahead.map((c) => Date.parse(c.window_today?.opens_at || '')).filter(Number.isFinite))
      rightNow.push({ key: 'ahead', text: `${plural(ahead.length, 'campaign window')} open${ahead.length === 1 ? 's' : ''} at ${clock(opens, tz)}`, tone: 'exec', ids: ahead.map((c) => c.window_event_id).filter((x): x is string => Boolean(x)), basis: 'Live campaigns whose window has not opened yet today.' })
    }
    rightNow.push({ key: 'queued', text: queued ? `${plural(queued, 'campaign text')} queued` : 'No campaign texts queued', tone: queued ? 'exec' : 'neutral', basis: 'Send-queue rows of live campaigns still waiting to go out (Campaign Command\'s queued count).' })
    if (hour.length) rightNow.push({ key: 'hour', text: `${plural(hour.length, 'follow-up')} due in the next hour`, tone: 'exec', ids: hour.map((e) => e.id), basis: 'Open seller follow-ups timed within the next 60 minutes.' })
    rightNow.push(yoursOpen.length
      ? { key: 'you', text: `${plural(yoursOpen.length, 'item')} waiting on you`, tone: 'attn', ids: yoursOpen.map((e) => e.id), basis: 'Open items you own today, plus anything of yours overdue.' }
      : { key: 'you', text: 'No operator action required', tone: 'ok', basis: 'Nothing open today, or overdue, is owned by you.' })
  }
  const next = open.filter((e) => timed(e) && e.type !== 'campaign_window' && Date.parse(e.start) > now && dayKey(e.start, tz) === day)
    .concat(open.filter((e) => e.type === 'campaign_window' && Date.parse(e.start) > now && dayKey(e.start, tz) === day))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(0, 4)

  // the forecast: what becomes a problem if nothing changes (§24)
  const forecast: BriefLine[] = []
  if (overdue.length) forecast.push({ key: 'overdue', text: `${plural(overdue.length, 'item')} overdue`, tone: 'attn', ids: overdue.map((e) => e.id), basis: 'Attention items whose time passed with nothing recording them done.' })
  const missed = roster.filter((c) => c.situation === 'missed')
  if (missed.length) forecast.push({ key: 'missed', text: `${plural(missed.length, 'campaign start')} missed — not running`, tone: 'attn', basis: 'A scheduled start more than two hours past without activating. It is never auto-launched.' })
  const closing = sending.filter((c) => { const t = Date.parse(c.window_today?.closes_at || ''); return t > now && t - now <= HOUR })
  if (closing.length) forecast.push({ key: 'closing-window', text: `${plural(closing.length, 'send window')} close${closing.length === 1 ? 's' : ''} within the hour`, tone: 'attn', basis: 'Open campaign windows ending in the next 60 minutes.' })
  const exhausted = roster.filter((c) => c.situation === 'exhausted')
  if (exhausted.length) forecast.push({ key: 'exhausted', text: `${plural(exhausted.length, 'active campaign')} with no one left to text`, tone: 'neutral', basis: 'Active in Campaign Command, but no ready targets and no queued rows: no window is projected.' })
  const tmr = addDays(today, 1)
  const deadlinesTomorrow = open.filter((e) => laneOf(e) === 'closings' && onDay(e, tmr, tz))
  if (deadlinesTomorrow.length) forecast.push({ key: 'deadlines', text: `${plural(deadlinesTomorrow.length, 'closing deadline')} tomorrow`, tone: 'attn', ids: deadlinesTomorrow.map((e) => e.id), basis: 'Closing Desk dates and milestones on tomorrow\'s date.' })
  const halted = roster.find((c) => c.halted)
  if (halted) forecast.push({ key: 'halted', text: halted.halted === 'emergency_stop' ? 'Emergency stop is on — windows will not send' : 'Queue processor is not live — windows will not send', tone: 'crit', basis: 'system_control: queue processor mode / emergency stop.' })

  const endOfDay: BriefLine[] = []
  const ready = sum(roster.filter((c) => c.situation !== 'missed' && c.situation !== 'scheduled').map((c) => c.counts.remaining))
  if (roster.length) endOfDay.push({ key: 'ready', text: `${plural(ready, 'campaign target')} ready to send`, tone: ready ? 'exec' : 'neutral', basis: 'Ready targets on live campaigns (Campaign Command\'s ready count) — not a forecast of what sends today.' })
  const fuLeft = dayOpen.filter((e) => e.type === 'seller_follow_up' && Date.parse(e.start) > now)
  endOfDay.push({ key: 'followups', text: fuLeft.length ? `${plural(fuLeft.length, 'follow-up')} still to go` : 'No follow-ups left today', tone: fuLeft.length ? 'exec' : 'neutral', ids: fuLeft.map((e) => e.id), basis: 'Open seller follow-ups later on this day.' })
  endOfDay.push({ key: 'yours', text: yoursOpen.length ? `${plural(yoursOpen.length, 'operator item')} unresolved` : 'Nothing of yours unresolved', tone: yoursOpen.length ? 'attn' : 'ok', ids: yoursOpen.map((e) => e.id), basis: 'Open items you own on this day, plus anything of yours overdue.' })

  const tDay = addDays(day, 1)
  const tEvents = open.filter((e) => onDay(e, tDay, tz))
  const tomorrow: BriefLine[] = []
  const tw = tEvents.filter((e) => e.type === 'campaign_window').length
  const tf = tEvents.filter((e) => e.type === 'seller_follow_up').length
  const td = tEvents.filter((e) => laneOf(e) === 'closings' && e.type !== 'closing').length
  const tc = tEvents.filter((e) => e.type === 'closing').length
  const tt = tEvents.filter((e) => laneOf(e) === 'workflows').length
  if (tw) tomorrow.push({ key: 'tw', text: plural(tw, 'campaign window'), tone: 'exec', basis: 'Projected send windows (the campaign\'s real pace, in its market zone).' })
  if (tf) tomorrow.push({ key: 'tf', text: plural(tf, 'follow-up'), tone: 'exec', basis: 'Seller follow-ups timed tomorrow.' })
  if (td) tomorrow.push({ key: 'td', text: plural(td, 'closing deadline'), tone: 'attn', basis: 'Closing Desk milestones dated tomorrow.' })
  if (tc) tomorrow.push({ key: 'tc', text: plural(tc, 'closing'), tone: 'attn', basis: 'Closing dates tomorrow.' })
  if (tt) tomorrow.push({ key: 'tt', text: plural(tt, 'workflow timer'), tone: 'flow', basis: 'Workflow runs resuming tomorrow.' })

  const attn = Math.max(overdue.length + missed.length, data.telemetry?.attention?.total ?? 0)
  const posture = attn ? 'attention' : yoursOpen.length ? 'you' : dayOpen.length || sending.length || ahead.length ? 'system' : 'clear'
  const headline = posture === 'clear' ? 'Clear day'
    : posture === 'system' ? 'LeadCommand is handling today'
      : posture === 'you' ? `${plural(yoursOpen.length, 'item')} need${yoursOpen.length === 1 ? 's' : ''} you`
        : `${plural(attn, 'item')} need${attn === 1 ? 's' : ''} attention`
  return { posture, headline, rightNow, next, forecast, endOfDay, tomorrow }
}

/* ══ ATTENTION (§35, §113) ════════════════════════════════════════════════ */

export const CATEGORY_LABEL: Record<AttentionCategory, string> = {
  overdue: 'Overdue', due_today: 'Due today', tomorrow: 'Due tomorrow', missing_date: 'Missing date', blocking_closing: 'Blocking a closing',
  stale_follow_up: 'Follow-up not acted on', missed_campaign_schedule: 'Missed campaign schedule', waiting_too_long: 'Workflow waiting too long',
}
export type AttnGroupKey = 'overdue' | 'today' | 'next24' | 'week' | 'later' | 'undated'
export const ATTN_GROUP_LABEL: Record<AttnGroupKey, string> = { overdue: 'Overdue', today: 'Later today', next24: 'Next 24 hours', week: 'This week', later: 'Later', undated: 'No date on record' }
export interface AttnItem { e: DeskEvent; when: string; late: number; kind: string; why: string }

/** The temporal risk surface: every item has a reason and a way to act. */
export function attentionGroups(data: DeskTimeline, { now, tz }: { now: number; tz: string }) {
  const byId = new Map<string, DeskEvent>()
  for (const e of [...data.events, ...data.attention]) byId.set(e.id, e)
  const ids = new Set<string>(data.attention.map((e) => e.id))
  for (const k of ['due_today', 'tomorrow'] as const) for (const id of data.board?.[k] ?? []) ids.add(id)
  const groups: Record<AttnGroupKey, AttnItem[]> = { overdue: [], today: [], next24: [], week: [], later: [], undated: [] }
  const endToday = dayBounds(data.range.today, tz).end
  for (const id of ids) {
    const e = byId.get(id)
    if (!e || e.history) continue
    const cat = e.attention_category ? CATEGORY_LABEL[e.attention_category] : e.owner === 'you' ? 'Yours' : 'Attention'
    const why = e.reason || e.why || ''
    if (e.undated) { groups.undated.push({ e, when: 'No date', late: 0, kind: cat, why }); continue }
    const at = e.all_day && e.date ? dayBounds(e.date, tz).end : Date.parse(e.start)
    const late = now - at
    if (late > 0 || e.state === 'overdue') {
      const verb = statusOf(e) === 'missed' ? 'Missed' : 'Overdue'
      groups.overdue.push({ e, when: late > 0 ? `${verb} ${span(late)}` : verb, late: Math.max(0, late), kind: cat, why })
    } else if (at < endToday) groups.today.push({ e, when: e.all_day ? 'Due today' : `Due ${clock(at, tz)}`, late, kind: cat, why })
    else if (at - now <= DAY_MS) groups.next24.push({ e, when: e.all_day ? `Due ${weekday(e.date as string)}` : `${weekday(dayKey(at, tz))} ${clock(at, tz)}`, late, kind: cat, why })
    else if (at - now <= 7 * DAY_MS) groups.week.push({ e, when: e.all_day ? `Due ${monthDay(e.date as string)}` : `${weekday(dayKey(at, tz))} ${monthDay(dayKey(at, tz))} · ${clock(at, tz)}`, late, kind: cat, why })
    else groups.later.push({ e, when: monthDay(e.all_day && e.date ? e.date : dayKey(at, tz)), late, kind: cat, why })
  }
  groups.overdue.sort((a, b) => b.late - a.late)
  // soonest first: late is (now − due), so the nearest future item has the largest late
  for (const k of ['today', 'next24', 'week', 'later'] as const) groups[k].sort((a, b) => b.late - a.late)
  return (Object.keys(ATTN_GROUP_LABEL) as AttnGroupKey[]).map((key) => ({ key, label: ATTN_GROUP_LABEL[key], items: groups[key] })).filter((g) => g.items.length)
}

/* ══ WEEK (§31–32, §126) ═════════════════════════════════════════════════ */

export interface WeekDay {
  day: string
  open: number
  done: number
  byLane: Record<LaneKey, number>
  texts: number
  windows: Array<{ from: number; to: number; live: boolean }>
  closings: Array<{ e: DeskEvent; hour: number | null }>
  attention: number
  hours: number[]
  summary: string
}
const LANE_WORD: Record<LaneKey, string> = { campaigns: 'campaigns', sellers: 'follow-ups', workflows: 'workflows', deals: 'deal actions', closings: 'closings', email: 'email' }

/** A week as workload: per day composition, per hour density, windows as coverage, closings as markers. */
export function weekModel(events: DeskEvent[], { from, tz, hours = [6, 23] }: { from: string; tz: string; hours?: [number, number] }) {
  const days: WeekDay[] = []
  for (let i = 0; i < 7; i += 1) {
    const day = addDays(from, i)
    const list = events.filter((e) => onDay(e, day, tz))
    const byLane = { campaigns: 0, sellers: 0, workflows: 0, deals: 0, closings: 0, email: 0 } as Record<LaneKey, number>
    const hrs = Array.from({ length: 24 }, () => 0)
    let texts = 0
    for (const e of list) {
      if (e.state === 'cancelled' || e.state === 'superseded') continue
      if (e.type === 'campaign_window') continue
      if (e.type === 'campaign_sends') {
        const d = e.detail as { slots?: Array<[number, number, number, number]>; slot_minutes?: number }
        for (const [slot, a, b, c] of d?.slots ?? []) { const h = Math.floor((slot * (d.slot_minutes || 30)) / 60); hrs[h] += a + b + c; texts += a + b + c }
        byLane.campaigns += 1
        continue
      }
      byLane[laneOf(e)] += 1
      if (timed(e)) hrs[Math.floor(localMinutes(e.start, tz) / 60)] += e.type === 'scheduled_message_group' ? e.count || 1 : 1
    }
    const open = list.filter((e) => !e.history).length
    const windows = list.filter((e) => e.type === 'campaign_window').map((e) => ({ from: Date.parse(e.start), to: Date.parse(e.end || e.start), live: e.state === 'live' }))
    const closings = list.filter((e) => laneOf(e) === 'closings' && !e.history).map((e) => ({ e, hour: e.all_day ? null : localMinutes(e.start, tz) / 60 }))
    const top = (Object.entries(byLane) as Array<[LaneKey, number]>).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => LANE_WORD[k])
    const summary = !list.length ? 'Clear' : top.length ? top.join(' + ') : 'Windows only'
    days.push({ day, open, done: list.length - open, byLane, texts, windows, closings, attention: list.filter((e) => e.attention && !e.history).length, hours: hrs, summary })
  }
  // the visible hour band: the default working span, widened to whatever the week actually holds
  let [h0, h1] = hours
  for (const d of days) d.hours.forEach((n, h) => { if (n) { h0 = Math.min(h0, h); h1 = Math.max(h1, h + 1) } })
  // bars never fill on a quiet week: the scale has a floor of 8 events
  const max = Math.max(8, ...days.map((d) => d.open + d.done))
  const hourMax = Math.max(1, ...days.flatMap((d) => d.hours.slice(h0, h1)))
  return { days, max, hourMax, hourRange: [h0, h1] as [number, number] }
}
/** Load words on stated absolute thresholds (events on the day): 0 clear · 1–3 light · 4–11 busy · 12+ heavy. */
export function loadWord(n: number, _max?: number) {
  void _max
  if (!n) return 'Clear'
  return n >= 12 ? 'Heavy' : n >= 4 ? 'Busy' : 'Light'
}

/* ══ MONTH (§33–34, §144) ════════════════════════════════════════════════ */

export type MonthMetric = 'total' | 'operator' | 'campaign' | 'follow_ups' | 'closings' | 'attention'
export const MONTH_METRICS: ReadonlyArray<{ key: MonthMetric; label: string; basis: string }> = [
  { key: 'total', label: 'Total events', basis: 'Every event on the day, done or ahead.' },
  { key: 'operator', label: 'Operator actions', basis: 'Items you own on the day (cancelled excluded).' },
  { key: 'campaign', label: 'Campaign volume', basis: 'Campaign texts queued or sent that day (cancelled excluded).' },
  { key: 'follow_ups', label: 'Follow-ups', basis: 'Seller follow-ups on the day (cancelled or superseded excluded).' },
  { key: 'closings', label: 'Closings', basis: 'Closing dates and milestones on the day.' },
  { key: 'attention', label: 'Needs attention', basis: 'Open attention items on the day.' },
]
export function metricValue(a: DeskDay | null | undefined, m: MonthMetric) {
  if (!a) return 0
  switch (m) {
    case 'total': return a.total
    case 'operator': return a.operator ?? a.manual
    case 'campaign': return a.texts ?? a.sends
    case 'follow_ups': return a.follow_ups ?? 0
    case 'closings': return a.closings ?? a.closing
    case 'attention': return a.attention
  }
}
/** Day aggregates computed from (filtered) events — the same definitions as the server's. */
export function aggregatesFrom(events: DeskEvent[], { from, to, tz }: { from: string; to: string; tz: string }): Record<string, DeskDay> {
  const days: Record<string, DeskDay> = {}
  for (let d = from; d <= to; d = addDays(d, 1)) days[d] = { total: 0, campaign: 0, windows: 0, closing: 0, attention: 0, automation: 0, manual: 0, workflow: 0, external: 0, completed: 0, sends: 0, texts: 0, follow_ups: 0, operator: 0, closings: 0 }
  for (const e of events) {
    if (e.undated) continue
    const a = days[e.all_day && e.date ? e.date : dayKey(e.start, tz)]
    if (!a) continue
    a.total += 1
    const real = e.state !== 'cancelled' && e.state !== 'superseded'
    if (e.type === 'campaign_sends') a.texts = (a.texts ?? 0) + Math.max(0, (e.count || 0) - Number((e.detail as { counts?: { cancelled?: number } })?.counts?.cancelled || 0))
    if (real && e.type === 'seller_follow_up') a.follow_ups = (a.follow_ups ?? 0) + 1
    if (real && e.owner === 'you') a.operator = (a.operator ?? 0) + 1
    if (real && laneOf(e) === 'closings') a.closings = (a.closings ?? 0) + 1
    if (e.history) { a.completed += 1; continue }
    if (e.attention) a.attention += 1
    if (e.type === 'campaign_window') a.windows += 1
    if (laneOf(e) === 'campaigns') a.campaign += 1
    if (laneOf(e) === 'closings') a.closing += 1
  }
  return days
}
export interface MonthCell { day: string; inMonth: boolean; value: number; intensity: number; agg: DeskDay | null; marks: { campaign: boolean; closing: boolean; attention: boolean } }
export function monthModel(anchor: string, days: Record<string, DeskDay>, metric: MonthMetric) {
  const first = monthStart(anchor)
  const start = weekStart(first)
  const cells: MonthCell[] = Array.from({ length: 42 }, (_, i) => {
    const day = addDays(start, i)
    const agg = days[day] ?? null
    return { day, inMonth: day.slice(0, 7) === first.slice(0, 7), value: metricValue(agg, metric), intensity: 0, agg, marks: { campaign: Boolean(agg && ((agg.windows || 0) > 0 || (agg.texts ?? agg.sends) > 0)), closing: Boolean(agg && (agg.closings ?? agg.closing) > 0), attention: Boolean(agg && agg.attention > 0) } }
  })
  const max = Math.max(0, ...cells.filter((c) => c.inMonth).map((c) => c.value))
  // square-root scale: a 2-event day is visible next to a 400-text day
  for (const c of cells) c.intensity = max ? Math.sqrt(c.value / max) : 0
  return { cells, max, loaded: cells.filter((c) => c.agg).length }
}

/* ══ THE SCRUBBER (§37–39) ═══════════════════════════════════════════════ */

export interface ScrubDay { day: string; known: boolean; load: number; open: number; total: number; marks: { system: boolean; campaign: boolean; closing: boolean; attention: boolean } }
/** Density per day: open load normalised to the range, plus at most four quiet marks. */
export function scrubberModel(days: Record<string, DeskDay>, { from, to }: { from: string; to: string }): ScrubDay[] {
  const list: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) list.push(d)
  const activity = (a: DeskDay | undefined) => (a ? a.total : 0)
  const max = Math.max(1, ...list.map((d) => activity(days[d])))
  return list.map((day) => {
    const a = days[day]
    return {
      day,
      known: Boolean(a),
      load: a ? activity(a) / max : 0,
      open: a ? a.total - a.completed : 0,
      total: a ? a.total : 0,
      marks: {
        system: Boolean(a && a.automation > 0),
        campaign: Boolean(a && (a.windows > 0 || (a.texts ?? a.sends) > 0)),
        closing: Boolean(a && (a.closings ?? a.closing) > 0),
        attention: Boolean(a && a.attention > 0),
      },
    }
  })
}

/* ══ SEARCH + DATE COMMANDS (§51–52) ═════════════════════════════════════ */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
export interface DateCommand { day: string; mode: 'today' | 'week' | 'month'; label: string }

/**
 * Deterministic date phrases only — nothing that pretends to understand
 * natural language: today · tomorrow · yesterday · this/next/last week ·
 * this/next/last month · a weekday ("fri" = the next one, today included) ·
 * "Oct 15" / "October 15" / "15 Oct" · "10/15" · "10/15/2026" · "2026-10-15".
 */
export function parseDateCommand(raw: string, { today }: { today: string }): DateCommand | null {
  const q = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!q) return null
  const year = Number(today.slice(0, 4))
  const ok = (y: number, m: number, d: number) => {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    return new Date(`${iso}T12:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null
  }
  const day = (d: string, label: string): DateCommand => ({ day: d, mode: 'today', label })
  if (q === 'today' || q === 'now') return day(today, 'Today')
  if (q === 'tomorrow' || q === 'tmrw') return day(addDays(today, 1), 'Tomorrow')
  if (q === 'yesterday') return day(addDays(today, -1), 'Yesterday')
  const wk = /^(this|next|last) week$/.exec(q)
  if (wk) { const d = addDays(today, wk[1] === 'next' ? 7 : wk[1] === 'last' ? -7 : 0); return { day: d, mode: 'week', label: `${wk[1][0].toUpperCase()}${wk[1].slice(1)} week` } }
  const mo = /^(this|next|last) month$/.exec(q)
  if (mo) { const base = monthStart(today); const d = mo[1] === 'this' ? base : monthStart(addDays(base, mo[1] === 'next' ? 32 : -1)); return { day: d, mode: 'month', label: `${mo[1][0].toUpperCase()}${mo[1].slice(1)} month` } }
  const wdi = q.length >= 3 ? WEEKDAYS.findIndex((w) => w.startsWith(q)) : -1
  if (wdi >= 0) {
    const t = new Date(`${today}T12:00:00Z`).getUTCDay()
    const d = addDays(today, (wdi - t + 7) % 7)
    return day(d, `${weekday(d, 'long')}, ${monthDay(d)}`)
  }
  let m: RegExpExecArray | null
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(q))) { const d = ok(+m[1], +m[2], +m[3]); return d ? day(d, monthDay(d)) : null }
  if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(q))) { const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : year; const d = ok(y, +m[1], +m[2]); return d ? day(d, monthDay(d)) : null }
  const mi = (s: string) => MONTHS.findIndex((x) => s.startsWith(x))
  if ((m = /^([a-z]{3,9})\.? (\d{1,2})(?:,? (\d{4}))?$/.exec(q)) && mi(m[1]) >= 0) { const d = ok(m[3] ? +m[3] : year, mi(m[1]) + 1, +m[2]); return d ? day(d, monthDay(d)) : null }
  if ((m = /^(\d{1,2}) ([a-z]{3,9})\.?(?: (\d{4}))?$/.exec(q)) && mi(m[2]) >= 0) { const d = ok(m[3] ? +m[3] : year, mi(m[2]) + 1, +m[1]); return d ? day(d, monthDay(d)) : null }
  return null
}

const TYPE_WORDS: Partial<Record<DeskEvent['type'], string>> = {
  campaign_window: 'campaign send window', campaign_start: 'campaign start', campaign_sends: 'campaign texts', scheduled_message: 'scheduled message',
  scheduled_message_group: 'messages', seller_follow_up: 'follow-up seller', pipeline_action: 'deal pipeline', offer: 'offer deal', closing: 'closing',
  closing_milestone: 'closing deadline milestone emd title', closing_missing_date: 'closing date missing', workflow_timer: 'workflow timer wait',
  workflow_approval: 'workflow approval', workflow_held: 'workflow held', workflow_run: 'workflow run', email_scheduled: 'email',
}
/** Every word must appear in the event's searchable text (seller, address, campaign, workflow, market, type, source). */
export function searchEvents(events: DeskEvent[], raw: string): DeskEvent[] {
  const words = raw.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return events.filter((e) => {
    const d = e.detail as { workflow_name?: string; campaign_status?: string; buyer?: string | null; title_company?: string | null }
    const hay = [e.title, e.subtitle, e.place, e.market, d?.workflow_name, d?.buyer, d?.title_company, TYPE_WORDS[e.type], SOURCE_LABEL[sourceOf(e)], e.links.thread_key]
      .filter(Boolean).join(' ').toLowerCase()
    return words.every((w) => hay.includes(w))
  }).sort((a, b) => Date.parse(a.start || '') - Date.parse(b.start || ''))
}

/* ══ RANGE ════════════════════════════════════════════════════════════════ */

export type Mode = 'today' | 'timeline' | 'week' | 'month' | 'attention' | 'appointments'
/** One bounded read per anchor (§139–141): five weeks around it, or the six-week month grid. */
export function rangeFor(mode: Mode, anchor: string) {
  if (mode === 'month') { const s = weekStart(monthStart(anchor)); return { from: s, to: addDays(s, 41) } }
  const s = addDays(weekStart(anchor), -7)
  return { from: s, to: addDays(s, 34) }
}
/** The Timeline span (§30): the past 24 hours through the next 7 days. */
export function timelineDomain(now: number): Domain {
  return { from: now - DAY_MS, to: now + 7 * DAY_MS }
}
export const isWithin = (day: string, r: { from: string; to: string }) => day >= r.from && day <= r.to
export { daysBetween, clockShort }

/** Overdue attention items whose time is before the visible span — carried into it per lane (§75). */
export function carryInto(attention: DeskEvent[], { from, now }: { from: number; now: number }) {
  const seen = new Set<string>()
  const out: DeskEvent[] = []
  for (const e of attention) {
    if (seen.has(e.id) || e.history || e.state !== 'overdue') continue
    const at = e.undated ? -Infinity : e.all_day && e.date ? Date.parse(`${e.date}T12:00:00Z`) : Date.parse(e.start)
    if (at >= from || at > now) continue
    seen.add(e.id)
    out.push(e)
  }
  return out
}
