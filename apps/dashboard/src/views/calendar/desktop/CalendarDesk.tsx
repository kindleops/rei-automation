import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { replaceRoutePath, useRouteLocation } from '../../../app/router'
import { Icon } from '../../../shared/icons'
import { LCButton, LCChip, LCConfirm, LCError, LCFilterInspector, LCPopover, LCSegmented, cx, useLcReducedMotion, type LCMenuEntry } from '../../../shared/lc'
import { useClaimedKeys } from '../../../shared/lc/keys'
import { sound } from '../../../shared/sound'
import { getSupabaseClient } from '../../../lib/supabaseClient'
import { shouldUseSupabase } from '../../../lib/data/shared'
import { uniqueChannelName } from '../../../lib/data/realtime-channel'
import { useAppInstance } from '../../../modules/desktop/workspace/instance-context'
import { useDeckSubject } from '../../../modules/desktop/workspace/deck-subject'
import { fetchDeskTimeline, type DeskCampaign, type DeskEvent, type DeskTimeline } from '../../../domain/calendar/calendar-timeline-api'
import { APP_NAME, cancelMessage, destinations, open, openBeside, rescheduleMessage, select, type Destination } from './desk-actions'
import { EventDetail } from './EventDetail'
import { AttentionView, CanvasSkeleton, ClearDay, MonthView, SearchResults, WeekView } from './ModeViews'
import { TemporalBrief } from './TemporalBrief'
import { TemporalCanvas } from './TemporalCanvas'
import { TemporalStrip, type StripCounts } from './TemporalStrip'
import { TimeScrubber } from './TimeScrubber'
import { AppointmentsDesk } from '../scheduling/AppointmentsDesk'
import { AppointmentDrawer } from '../scheduling/AppointmentDrawer'
import { MyCalendarCard } from '../scheduling/MyCalendarCard'
import { TeamAdminCard } from '../scheduling/TeamAdminCard'
import {
  NO_FILTERS, SOURCES, SOURCE_LABEL, STATUSES, STATUS_LABEL, aggregatesFrom, applyFilters, briefModel, carryInto, filterCount, fitDomain, marketsOf, ownerClass,
  parseDateCommand, rangeFor, scrubberModel, searchEvents, sourceOf, statusOf, timelineDomain, zoomDomain,
  type Domain, type Filters, type Mode, type OwnerKey, type SourceKey, type StatusKey, type Zoom,
} from './temporal-model'
import { DAY_MS, addDays, clock, dayBounds, dayKey, longDay, monthStart, operatorZone, weekStart, zoneAbbr } from './temporal-time'
import './temporal.css'

/**
 * CALENDAR 5.0 — THE TEMPORAL COMMAND CENTER (desktop).
 *
 * Every event is a projection of a canonical record served by
 * /api/cockpit/calendar/timeline (view=desk, contract v5). This surface
 * arranges and never invents: counts carry their basis, the attention board
 * is the server's, and the only writes are the canonical queue actions on
 * messages the operator scheduled — granted per event by the read model.
 * Appointments is the scheduling service's own lens (booked calls, My
 * calendar); ?appointment=<id> opens one from anywhere, e.g. the timeline.
 *
 * Pane-ready: its URL state is read from useRouteLocation() and written with
 * replaceRoutePath(), so in a secondary pane it reads and writes the pane's
 * own path. One scroll root (the stage); container queries for layout.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/
const MODES: Mode[] = ['today', 'timeline', 'week', 'month', 'attention', 'appointments']
const CACHE = new Map<string, { data: DeskTimeline; at: number }>()
const CACHE_TTL = 10 * 60_000
const EMPTY = new Set<string>()
const CLAIMED = ['t', 'w', 'm', 'ArrowLeft', 'ArrowRight']

/** Lanes whose source a failed read takes down — said locally, never as a red calendar (§146). */
const SOURCE_WORD: Record<string, string> = {
  send_queue: 'Queue', inbox_thread_state: 'Seller follow-ups', inbox_thread_state_reviews: 'Overdue reviews', acquisition_opportunities: 'Pipeline', campaigns: 'Campaigns',
  campaign_targets: 'Campaign audience', campaign_queue: 'Campaign queue', closing_cases: 'Closings', seller_offers: 'Offers', wf_runs: 'Workflows', email_queue: 'Email',
  system_control: 'System controls', people: 'Seller names', properties: 'Property zones', wf_versions: 'Workflow versions', wf_waits: 'Workflow waits', wf_run_steps: 'Workflow steps',
}

function readParams(location: string) {
  const q = new URLSearchParams(location.split('?')[1] || '')
  const date = q.get('date')
  const view = q.get('view') as Mode | null
  return { date: date && DATE.test(date) ? date : null, view: view && MODES.includes(view) ? view : null, event: q.get('event'), property: q.get('property_id'), appointment: q.get('appointment'), connection: q.get('calendar_connection') }
}
function writeParams(location: string, patch: Record<string, string | null>) {
  const [path, search = ''] = location.split('?')
  const q = new URLSearchParams(search)
  for (const [k, v] of Object.entries(patch)) { if (v) q.set(k, v); else q.delete(k) }
  const s = q.toString()
  return `${path}${s ? `?${s}` : ''}`
}

export function CalendarDesk() {
  const [tz] = useState(operatorZone)
  const reduced = useLcReducedMotion()
  const { visible, instanceId } = useAppInstance()
  const location = useRouteLocation()
  const [initial] = useState(() => readParams(location))
  const [now, setNow] = useState(() => Date.now())
  const today = dayKey(now, tz)
  const [day, setDay] = useState(() => initial.date ?? dayKey(Date.now(), tz))
  // returning from Google sign-in lands on Appointments, where My calendar says how it went
  const [mode, setMode] = useState<Mode>(() => initial.view ?? (initial.connection ? 'appointments' : 'today'))
  const [selectedId, setSelectedId] = useState<string | null>(initial.event)
  const [propertyId, setPropertyId] = useState<string | null>(initial.property)
  const [appointmentId, setAppointmentId] = useState<string | null>(initial.appointment)
  const [connection, setConnection] = useState<string | null>(initial.connection)
  const [apptTick, setApptTick] = useState(0)
  const [seen, setSeen] = useState(location)
  const [mine, setMine] = useState<string[]>([])
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [query, setQuery] = useState('')
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [focus, setFocus] = useState<Domain | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  // the side plane: shown on a wide pane unless hidden (canvas full width, §125); an overlay on a narrow one
  const [sidePref, setSidePref] = useState<'auto' | 'hidden' | 'shown'>('auto')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [store, setStore] = useState<{ key: string; data: DeskTimeline; at: number } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const [tick, setTick] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [live, setLive] = useState(false)
  const [arrived, setArrived] = useState<ReadonlySet<string>>(EMPTY)
  const [width, setWidth] = useState(1200)
  const [stageW, setStageW] = useState(900)
  const [focusWithin, setFocusWithin] = useState(false)
  const [confirm, setConfirm] = useState<{ kind: 'reschedule'; e: DeskEvent; to: number } | { kind: 'cancel'; e: DeskEvent } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const idsRef = useRef<{ key: string; map: Map<string, string> } | null>(null)

  /* ── the route is the pane's: adopt what another app navigated to, ignore our own writes ── */
  if (location !== seen) {
    setSeen(location)
    const mineAt = mine.indexOf(location)
    // our own write has landed: forget it (and anything older), so a later navigation by
    // another app to the same path is still adopted
    if (mineAt >= 0) setMine(mine.slice(mineAt + 1))
    else {
      const p = readParams(location)
      if (p.date && p.date !== day) setDay(p.date)
      if (p.view && p.view !== mode) setMode(p.view)
      if ((p.event ?? null) !== selectedId) setSelectedId(p.event ?? null)
      if ((p.property ?? null) !== propertyId) setPropertyId(p.property ?? null)
      if ((p.appointment ?? null) !== appointmentId) setAppointmentId(p.appointment ?? null)
    }
  }
  const commit = (patch: { day?: string; mode?: Mode; event?: string | null; appointment?: string | null }) => {
    const nd = patch.day ?? day
    const nm = patch.mode ?? mode
    const ne = patch.event !== undefined ? patch.event : selectedId
    const na = patch.appointment !== undefined ? patch.appointment : appointmentId
    if (patch.day !== undefined && patch.day !== day) setDay(patch.day)
    if (patch.mode !== undefined && patch.mode !== mode) setMode(patch.mode)
    if (patch.event !== undefined && patch.event !== selectedId) setSelectedId(patch.event)
    if (patch.appointment !== undefined && patch.appointment !== appointmentId) setAppointmentId(patch.appointment)
    const path = writeParams(location, { date: nd === today ? null : nd, view: nm === 'today' ? null : nm, event: ne, appointment: na, calendar_connection: null })
    if (path !== location) { setMine((m) => [...m.slice(-8), path]); replaceRoutePath(path) }
  }

  // the OAuth result (?calendar_connection=) is read once, then leaves the URL so a reload doesn't repeat it
  const strippedRef = useRef(false)
  useEffect(() => {
    if (strippedRef.current || !initial.connection) return
    strippedRef.current = true
    replaceRoutePath(writeParams(location, { calendar_connection: null, view: initial.view ?? 'appointments' }))
  }, [initial.connection, initial.view, location])

  /* ── one bounded read per anchor (§139–144) ── */
  const nowModes = mode === 'attention' || mode === 'timeline' || mode === 'appointments'
  const anchor = nowModes ? today : day
  const range = useMemo(() => rangeFor(nowModes ? 'today' : mode, anchor), [nowModes, mode, anchor])
  const key = `${range.from}:${range.to}:${tz}:${propertyId ?? ''}`
  useEffect(() => {
    let alive = true
    const ctl = new AbortController()
    fetchDeskTimeline({ from: range.from, to: range.to, tz, propertyId }, ctl.signal).then((d) => {
      if (!alive) return
      const prev = idsRef.current
      if (prev && prev.key === key) {
        // one restrained arrival trace for what is new or changed state (§42–44) — never a jump
        const changed = new Set(d.events.filter((e) => !prev.map.has(e.id) || prev.map.get(e.id) !== e.state).map((e) => e.id))
        if (changed.size && changed.size < 40) { setArrived(changed); window.setTimeout(() => setArrived(EMPTY), 1800) }
      }
      CACHE.set(key, { data: d, at: Date.now() })
      setStore({ key, data: d, at: Date.now() })
      setFailure(null)
    }).catch((err: unknown) => {
      if (!alive || ctl.signal.aborted) return
      setFailure({ key, message: err instanceof Error ? err.message : 'calendar_failed' })
    }).finally(() => { if (alive) setRefreshing(false) })
    return () => { alive = false; ctl.abort() }
  }, [key, range.from, range.to, tz, propertyId, tick, attempt])
  useEffect(() => { if (store) idsRef.current = { key: store.key, map: new Map(store.data.events.map((e) => [e.id, e.state])) } }, [store])

  /* ── live: realtime kicks a quiet re-read, spaced; a poll keeps campaign progress current (§41) ── */
  useEffect(() => {
    if (!visible) return
    let timer = 0
    let last = Date.now()
    let cancelled = false
    const kick = () => { setRefreshing(true); setTick((t) => t + 1) }
    const spaced = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => { if (document.visibilityState === 'visible') { last = Date.now(); kick() } }, Math.max(3000, 30_000 - (Date.now() - last)))
    }
    const channels: RealtimeChannel[] = []
    const supabase = shouldUseSupabase() ? getSupabaseClient() : null
    try {
      if (supabase) {
        channels.push(supabase.channel(uniqueChannelName('nx-cal5:inbox_thread_state')).on('postgres_changes', { event: '*', schema: 'public', table: 'inbox_thread_state' }, spaced).subscribe((s) => { if (!cancelled) setLive(s === 'SUBSCRIBED') }))
        channels.push(supabase.channel(uniqueChannelName('nx-cal5:message_events')).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_events' }, spaced).subscribe())
      }
    } catch { /* realtime unavailable: the poll below still keeps the calendar current */ }
    const poll = window.setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - last > 80_000) { last = Date.now(); kick() } }, 90_000)
    const clockId = window.setInterval(() => setNow(Date.now()), 30_000)
    const wake = window.setTimeout(() => setNow(Date.now()), 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer); window.clearTimeout(wake); window.clearInterval(poll); window.clearInterval(clockId)
      if (supabase) for (const c of channels) void supabase.removeChannel(c)
    }
  }, [visible])

  /* ── width: the pane decides the composition (container queries do the rest) ── */
  useEffect(() => {
    const el = rootRef.current
    const st = stageRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      for (const en of entries) {
        if (en.target === el) setWidth(Math.round(en.contentRect.width))
        else setStageW(Math.round(en.contentRect.width))
      }
    })
    ro.observe(el)
    if (st) ro.observe(st)
    return () => ro.disconnect()
  }, [])
  const wide = width >= 1060
  const narrow = !wide

  /* ── derived data ── */
  // the exact read, else a fresh cached one, else the previous read while it still covers the
  // day in view (stale-while-loading, marked) — never an empty day that is really "not loaded"
  const cached = CACHE.get(key)
  const covers = (d: DeskTimeline) => mode !== 'month' && day >= d.range.from && day <= d.range.to
  const data = store?.key === key ? store.data : cached && now - cached.at < CACHE_TTL ? cached.data : store && covers(store.data) ? store.data : null
  const stale = Boolean(data && store?.key !== key)
  const error = failure?.key === key ? failure.message : null
  const all = useMemo(() => data?.events ?? [], [data])
  const events = useMemo(() => applyFilters(all, filters), [all, filters])
  const byId = useMemo(() => new Map([...(data?.events ?? []), ...(data?.attention ?? [])].map((e) => [e.id, e])), [data])
  const selected = selectedId ? byId.get(selectedId) ?? null : null
  // Timeline and Attention are about now: their brief and strip speak for today, not a scrubbed day
  const focusDay = nowModes ? today : day
  const brief = useMemo(() => (data ? briefModel(data, events, { now, tz, day: focusDay }) : null), [data, events, now, tz, focusDay])
  const scrub = useMemo(() => (data ? scrubberModel(data.days, { from: data.range.from, to: data.range.to }) : []), [data])
  const command = useMemo(() => parseDateCommand(query, { today }), [query, today])
  const results = useMemo(() => (query.trim() && !command ? searchEvents([...all, ...(data?.attention ?? []).filter((a) => !all.some((e) => e.id === a.id))], query) : []), [query, command, all, data])
  const filtered = filterCount(filters) > 0
  const markets = useMemo(() => marketsOf(all), [all])

  // Today's domain: fit → zoom → a focused interval from the load graph (§122–124, §132)
  const dayEvents = useMemo(() => events.filter((e) => !e.undated && (e.all_day ? e.date === day : (() => { const b = dayBounds(day, tz); const s = Date.parse(e.start); const en = e.end ? Date.parse(e.end) : s; return en >= b.start && s < b.end })())), [events, day, tz])
  const fit = useMemo(() => fitDomain(dayEvents, { day, tz, now, fallback: [data?.system.contact_window.start || '08:00', data?.system.contact_window.end || '21:00'] }), [dayEvents, day, tz, now, data])
  const domain = mode === 'timeline' ? (focus ?? timelineDomain(now)) : (focus ?? zoomDomain(zoom, { fit, day, tz, now }))
  const isToday = day === today
  const carry = useMemo(() => (data && isToday && mode === 'today' ? applyFilters(carryInto(data.attention, { from: domain.from, now }), filters) : []), [data, isToday, mode, domain.from, now, filters])
  const timelineDays = useMemo(() => { const out: string[] = []; for (let d = dayKey(now - DAY_MS, tz); d <= dayKey(now + 7 * DAY_MS, tz); d = addDays(d, 1)) out.push(d); return out }, [now, tz])
  const monthDays = useMemo(() => (data && filtered ? aggregatesFrom(events, { from: data.range.from, to: data.range.to, tz }) : data?.days ?? {}), [data, filtered, events, tz])

  const counts: StripCounts | null = useMemo(() => {
    if (!data) return null
    const tel = data.telemetry
    // the summary counts the span in view: a week, a month, or the day (Timeline / Attention: today)
    const spanFrom = mode === 'week' ? weekStart(day) : mode === 'month' ? monthStart(day) : focusDay
    const spanTo = mode === 'week' ? addDays(weekStart(day), 6) : mode === 'month' ? addDays(monthStart(addDays(monthStart(day), 32)), -1) : focusDay
    const inSpan = (e: DeskEvent) => !e.undated && !e.history && (e.all_day && e.date ? e.date >= spanFrom && e.date <= spanTo : dayKey(e.start, tz) >= spanFrom && dayKey(e.start, tz) <= spanTo)
    const onDay = mode === 'week' || mode === 'month' ? events.filter(inSpan) : focusDay === day ? dayEvents.filter((e) => !e.history) : events.filter(inSpan)
    const serverToday = focusDay === today && mode !== 'week' && mode !== 'month' && !filtered
    return {
      label: mode === 'week' ? 'Week' : mode === 'month' ? 'Month' : null,
      day: serverToday ? tel.today.total : onDay.length,
      system: serverToday ? tel.today.system : onDay.filter((e) => e.owner === 'system').length,
      you: serverToday ? tel.today.you : onDay.filter((e) => e.owner === 'you').length,
      external: serverToday ? tel.today.external : onDay.filter((e) => ownerClass(e.owner) === 'external').length,
      attention: tel.attention.total,
      basis: {
        day: serverToday ? tel.basis.today : `Open events ${mode === 'week' ? 'this week' : mode === 'month' ? 'this month' : 'on this day'} (your zone), after the filters shown.`,
        system: tel.basis.system, you: 'Open items you own on this day.', attention: tel.basis.attention, next: tel.basis.next,
      },
    }
  }, [data, dayEvents, events, filtered, mode, day, focusDay, today, tz])

  /* ── the Command Deck says what the calendar is looking at ── */
  useDeckSubject(selected ? { title: selected.title, subtitle: `${selected.subtitle ? `${selected.subtitle} · ` : ''}${selected.undated ? 'No date' : clock(selected.start, tz)}` } : { title: mode === 'month' ? 'Calendar · month' : isToday ? 'Today' : longDay(day), subtitle: brief ? brief.headline : null })

  /* ── keys: only while the operator is in the calendar (§160) ── */
  useClaimedKeys(CLAIMED, focusWithin)
  const step = (dir: 1 | -1) => {
    if (mode === 'appointments') return
    setFocus(null)
    const next = mode === 'week' ? addDays(day, 7 * dir) : mode === 'month' ? monthStart(addDays(`${day.slice(0, 7)}-15`, 31 * dir)) : addDays(day, dir)
    commit({ day: next, mode: mode === 'attention' || mode === 'timeline' ? 'today' : mode })
  }
  const goToday = () => { setFocus(null); setZoom('fit'); commit({ day: today }) }
  const onKey = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.defaultPrevented) return
    const t = ev.target as HTMLElement
    if (t.closest('input, textarea, select, [contenteditable="true"], [role="slider"], [role="tablist"], [role="radiogroup"], [role="menu"], [role="grid"], [role="dialog"]')) return
    const k = ev.key
    const consume = () => { ev.preventDefault(); ev.stopPropagation() }
    if (k === 't' || k === 'T') { goToday(); consume() }
    else if (k === 'w' || k === 'W') { commit({ mode: 'week' }); consume() }
    else if (k === 'm' || k === 'M') { commit({ mode: 'month' }); consume() }
    else if (k === 'ArrowLeft') { step(-1); consume() }
    else if (k === 'ArrowRight') { step(1); consume() }
  }
  const onFocusIn = () => { if (!focusWithin) setFocusWithin(true) }
  const onFocusOut = (ev: FocusEvent<HTMLDivElement>) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setFocusWithin(false) }
  const onPointerDown = (ev: ReactPointerEvent<HTMLDivElement>) => {
    // clicking the canvas background puts the keyboard in the calendar (never steals from a field)
    if (!(ev.target as HTMLElement).closest('button, a, input, textarea, select, [tabindex]')) rootRef.current?.focus({ preventScroll: true })
  }

  /* ── actions ── */
  const openEvent = (e: DeskEvent) => { commit({ event: e.id }); select(e) }
  const openId = (id: string) => { const e = byId.get(id); if (e) openEvent(e) }
  const close = () => commit({ event: null })
  const pickDay = (d: string) => { setFocus(null); commit({ day: d, mode: 'today' }) }
  const go = (d: Destination) => { sound.navigation.change('forward'); open(d) }
  const beside = (d: Destination, e?: DeskEvent) => openBeside(d, e)
  const drill = (k: 'day' | 'system' | 'you' | 'attention' | 'next') => {
    if (k === 'day') { setFilters((f) => ({ ...f, owner: 'all' })); commit({ mode: 'today' }) }
    else if (k === 'system' || k === 'you') setFilters((f) => ({ ...f, owner: f.owner === k ? 'all' : k }))
    else if (k === 'attention') commit({ mode: 'attention' })
    else if (k === 'next' && data?.telemetry.next_system) openId(data.telemetry.next_system.id)
  }
  const submitQuery = () => {
    if (!command) return
    setQuery('')
    setFocus(null)
    commit({ day: command.day, mode: command.mode })
  }
  const onCampaign = (c: DeskCampaign) => {
    const e = c.window_event_id ? byId.get(c.window_event_id) : all.find((x) => x.links.campaign_id === c.id && x.type === 'campaign_start') || data?.attention.find((x) => x.links.campaign_id === c.id)
    if (e) openEvent(e)
    else go({ key: 'campaign', label: c.deep_link.label, app: 'campaigns', path: c.deep_link.path })
  }
  const runConfirm = async () => {
    if (!confirm) return
    if (confirm.kind === 'reschedule') await rescheduleMessage(confirm.e, confirm.to)
    else await cancelMessage(confirm.e)
    // a real write went through: one subtle confirmation, then re-read in place (§90–91)
    sound.outcome.success('subtle')
    setRefreshing(true)
    setTick((t) => t + 1)
  }

  const canSplit = Boolean(instanceId)
  const createFrom = selected?.links.thread_key ? selected : null
  const createItems: LCMenuEntry[] = [
    { kind: 'label', id: 'l', label: 'Opens the app that owns it' },
    { id: 'msg', label: createFrom ? `Message ${createFrom.subtitle || 'this seller'}` : 'Seller message', icon: 'message', hint: createFrom ? 'Inbox · schedule it in the conversation' : 'Inbox · schedule it from a conversation',
      onSelect: () => { const d = createFrom ? destinations(createFrom).find((x) => x.app === 'inbox') : null; if (d) go(d); else go({ key: 'inbox', label: 'Inbox', app: 'inbox', path: '/inbox' }) } },
    { id: 'campaign', label: 'Campaign schedule', icon: 'send', hint: 'Campaign Command', onSelect: () => (canSplit ? beside({ key: 'c', label: 'Campaign Command', app: 'campaigns', path: '/campaign-command' }) : go({ key: 'c', label: 'Campaign Command', app: 'campaigns', path: '/campaign-command' })) },
    { id: 'closing', label: 'Closing date', icon: 'key', hint: 'Closing Desk · the closing authority', onSelect: () => (canSplit ? beside({ key: 'cd', label: 'Closing Desk', app: 'closing', path: '/closing-desk' }) : go({ key: 'cd', label: 'Closing Desk', app: 'closing', path: '/closing-desk' })) },
    { id: 'workflow', label: 'Workflow timer', icon: 'layers', hint: 'Workflow Studio', onSelect: () => go({ key: 'w', label: 'Workflow Studio', app: 'workflow', path: '/workflow-studio' }) },
    { id: 'email', label: 'Email', icon: 'mail', hint: 'Email Command · sending is off in production', onSelect: () => go({ key: 'e', label: 'Email Command', app: 'email', path: '/email-command' }) },
  ]

  const degraded = data ? Object.entries(data.source_status).filter(([, s]) => s === 'failed').map(([k]) => SOURCE_WORD[k] || k.replace(/_/g, ' ')) : []
  const toggle = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  const sourceCounts = useMemo(() => Object.fromEntries(SOURCES.map((s) => [s, all.filter((e) => sourceOf(e) === s).length])) as Record<SourceKey, number>, [all])
  const statusCounts = useMemo(() => Object.fromEntries(STATUSES.map((s) => [s, all.filter((e) => statusOf(e) === s || (s === 'attention' && e.attention)).length])) as Record<StatusKey, number>, [all])
  const filterButton = (
    <LCPopover open={filtersOpen} onOpenChange={setFiltersOpen} side="bottom" align="end" material="frosted" width={340} label="Calendar filters"
      trigger={<LCButton variant={filtered ? 'secondary' : 'quiet'} size="sm" icon="filter" aria-label={`Filters, ${filterCount(filters)} active`}>Filters{filtered ? <span className="tcc-fcount">{filterCount(filters)}</span> : null}</LCButton>}>
      <LCFilterInspector activeCount={filterCount(filters)} cohort={events.length} cohortNoun={`events in ${longDay(range.from).split(', ')[1]} – ${longDay(range.to).split(', ')[1]}`}
        onClear={() => setFilters(NO_FILTERS)} onClose={() => setFiltersOpen(false)}
        sections={[
          { id: 'source', label: 'Source', active: filters.sources.length, keywords: ['inbox', 'campaign', 'workflow', 'pipeline', 'closing', 'email', 'app'],
            render: () => <div className="tcc-fopts">{SOURCES.map((s) => <label key={s} className="tcc-fopt"><input type="checkbox" checked={filters.sources.includes(s)} onChange={() => setFilters((f) => ({ ...f, sources: toggle(f.sources, s) }))} /><span>{SOURCE_LABEL[s]}</span><em>{sourceCounts[s]}</em></label>)}</div> },
          { id: 'owner', label: 'Owner', active: filters.owner !== 'all' ? 1 : 0, keywords: ['system', 'you', 'external', 'operator'],
            render: () => <div className="tcc-fopts">{(['all', 'system', 'you', 'external'] as OwnerKey[]).map((o) => <label key={o} className="tcc-fopt"><input type="radio" name="tcc-owner" checked={filters.owner === o} onChange={() => setFilters((f) => ({ ...f, owner: o }))} /><span>{o === 'all' ? 'Everyone' : o === 'you' ? 'You' : o === 'system' ? 'System' : 'External (seller, buyer, title)'}</span></label>)}</div> },
          { id: 'status', label: 'Status', active: filters.statuses.length, keywords: ['scheduled', 'running', 'waiting', 'overdue', 'missed', 'failed', 'completed'],
            render: () => <div className="tcc-fopts is-grid">{STATUSES.map((s) => <label key={s} className="tcc-fopt"><input type="checkbox" checked={filters.statuses.includes(s)} onChange={() => setFilters((f) => ({ ...f, statuses: toggle(f.statuses, s) }))} /><span>{STATUS_LABEL[s]}</span><em>{statusCounts[s]}</em></label>)}</div> },
          { id: 'market', label: 'Market', active: filters.markets.length, keywords: ['market', 'city'],
            render: () => (markets.length ? <div className="tcc-fopts">{markets.map((m) => <label key={m} className="tcc-fopt"><input type="checkbox" checked={filters.markets.includes(m)} onChange={() => setFilters((f) => ({ ...f, markets: toggle(f.markets, m) }))} /><span>{m}</span></label>)}</div>
              : <p className="tcc-basis">No event in this range records a market. Campaign markets are often unset in Campaign Command.</p>) },
          { id: 'history', label: 'History', active: filters.history ? 0 : 1, keywords: ['completed', 'cancelled', 'history'],
            render: () => <label className="tcc-fopt"><input type="checkbox" checked={filters.history} onChange={() => setFilters((f) => ({ ...f, history: !f.history }))} /><span>Show completed, cancelled and superseded items (quiet)</span></label> },
        ]} />
    </LCPopover>
  )
  const chips = [
    ...(filters.owner !== 'all' ? [{ id: 'owner', field: 'Owner', value: filters.owner === 'you' ? 'You' : filters.owner === 'system' ? 'System' : 'External', onRemove: () => setFilters((f) => ({ ...f, owner: 'all' as OwnerKey })) }] : []),
    ...filters.sources.map((s) => ({ id: `s:${s}`, field: 'Source', value: SOURCE_LABEL[s], onRemove: () => setFilters((f) => ({ ...f, sources: f.sources.filter((x) => x !== s) })) })),
    ...filters.statuses.map((s) => ({ id: `st:${s}`, field: 'Status', value: STATUS_LABEL[s], onRemove: () => setFilters((f) => ({ ...f, statuses: f.statuses.filter((x) => x !== s) })) })),
    ...filters.markets.map((m) => ({ id: `m:${m}`, field: 'Market', value: m, onRemove: () => setFilters((f) => ({ ...f, markets: f.markets.filter((x) => x !== m) })) })),
    ...(!filters.history ? [{ id: 'h', field: 'History', value: 'Hidden', onRemove: () => setFilters((f) => ({ ...f, history: true })) }] : []),
  ]

  /* ── the stage ── */
  const searching = Boolean(query.trim()) && !command
  const dayEmpty = data && mode === 'today' && !dayEvents.length && !carry.length
  let stage
  if (error && !data) stage = <LCError what="The calendar didn't load" detail={error.replace(/_/g, ' ')} onRetry={() => setAttempt((a) => a + 1)} />
  else if (!data) stage = mode === 'today' || mode === 'timeline' ? <CanvasSkeleton /> : <div className="tcc-skelblock" aria-busy="true"><i className="lc-skel" /><i className="lc-skel" /><i className="lc-skel" /></div>
  else if (searching) stage = <SearchResults results={results} query={query} range={data.range} tz={tz} onOpen={openEvent} />
  else if (mode === 'week') stage = <WeekView events={events} from={weekStart(day)} today={today} tz={tz} now={now} onPickDay={pickDay} />
  else if (mode === 'month') stage = <MonthView anchor={day} days={monthDays} today={today} filtered={filtered} onPickDay={pickDay} />
  else if (mode === 'appointments') stage = (
    <div className="sch-desk">
      <AppointmentsDesk tz={tz} refreshKey={apptTick} onOpen={(id) => commit({ appointment: id })} />
      <MyCalendarCard notice={connection} onDismissNotice={() => setConnection(null)} />
      <TeamAdminCard />
    </div>
  )
  else if (mode === 'attention') stage = <AttentionView data={data} tz={tz} now={now} filter={(e) => applyFilters([e], filters).length > 0} onOpen={openEvent} />
  else stage = (
    <>
      {dayEmpty ? <ClearDay day={day} today={today} onTomorrow={() => pickDay(addDays(day, 1))} /> : null}
      <TemporalCanvas events={events} carry={carry} domain={domain} tz={tz} now={now} days={mode === 'timeline' ? timelineDays : [day]}
        selectedId={selectedId} arrived={arrived} widthPx={Math.max(240, stageW - 150)} reduced={reduced}
        next={isToday || mode === 'timeline' ? { system: data.telemetry.next_system, you: data.telemetry.next_you ?? null } : undefined}
        onOpen={openEvent} onZoom={(d) => setFocus(d)} zoomed={Boolean(focus)} onDrop={(e, to) => setConfirm({ kind: 'reschedule', e, to })} />
    </>
  )

  const side = selected ? (
    <EventDetail e={selected} tz={tz} now={now} canSplit={canSplit} onClose={close} onOpen={go} onBeside={(d) => beside(d, selected)}
      onRequestReschedule={(e, to) => setConfirm({ kind: 'reschedule', e, to })} onRequestCancel={(e) => setConfirm({ kind: 'cancel', e })} />
  ) : brief && data ? (
    <TemporalBrief model={brief} campaigns={data.campaigns ?? []} day={focusDay} today={today} tz={tz} now={now}
      onOpen={openEvent} onOpenId={openId} onAttention={() => commit({ mode: 'attention' })} onCampaign={onCampaign} onDay={pickDay} />
  ) : <div className="tcc-brief is-skel" aria-busy="true"><i className="lc-skel" /><i className="lc-skel" /><i className="lc-skel" /></div>

  const showSide = Boolean(selected) || (mode !== 'appointments' && (wide ? sidePref !== 'hidden' : sidePref === 'shown'))
  return (
    <div ref={rootRef} className={cx('tcc', narrow && 'is-narrow', stale && 'is-stale', refreshing && 'is-refreshing', reduced && 'is-reduced', preview && 'is-previewing')}
      tabIndex={-1} onKeyDown={onKey} onFocus={onFocusIn} onBlur={onFocusOut} onPointerDown={onPointerDown} data-mode={mode} aria-label="Calendar">
      <TemporalStrip day={focusDay} preview={preview} today={today} now={now} tz={tz} mode={mode}
        posture={{ headline: brief?.headline ?? 'Reading the schedule…', tone: brief?.posture === 'you' ? 'you' : brief?.posture ?? 'system' }}
        counts={counts} next={data?.telemetry.next_system ?? null}
        live={{ live, updatedAt: store?.at ?? null, refreshing, stale: Boolean(error && data) }} degraded={degraded}
        owner={filters.owner} query={query} command={command}
        filterButton={filterButton} createItems={createItems} briefShown={showSide && !selected}
        onMode={(m) => { setFocus(null); commit({ mode: m }) }} onOwner={(o) => setFilters((f) => ({ ...f, owner: o }))}
        onQuery={setQuery} onSubmitQuery={submitQuery} onDrill={drill} onBrief={() => { if (selected) close(); else setSidePref((p) => ((wide ? p !== 'hidden' : p === 'shown') ? (wide ? 'hidden' : 'auto') : 'shown')) }} />
      {chips.length ? (
        <div className="tcc-chips" role="group" aria-label="Active filters">
          {chips.map((c) => <LCChip key={c.id} field={c.field} value={c.value} onRemove={c.onRemove} />)}
          <button type="button" className="lc-link" onClick={() => setFilters(NO_FILTERS)}>Clear all</button>
          <span className="tcc-chips__n">{events.length.toLocaleString('en-US')} of {all.length.toLocaleString('en-US')} events</span>
        </div>
      ) : null}
      {mode === 'appointments' ? null : mode !== 'month' ? (
        <TimeScrubber days={scrub} selected={mode === 'attention' || mode === 'timeline' ? today : day} today={today} stepLabel={mode === 'week' ? 'week' : 'day'}
          onPick={pickDay} onPreview={setPreview} onStep={step} onToday={goToday} loading={!data}
          aside={mode === 'today' ? (
            <div className="tcc-zoom">
              <LCSegmented size="sm" label="Zoom" value={zoom} onChange={(v) => { setFocus(null); setZoom(v as Zoom) }} options={[{ value: 'fit', label: 'Fit' }, { value: '6h', label: '6h' }, { value: '12h', label: '12h' }, { value: '24h', label: '24h' }]} />
              {!isToday || focus || zoom !== 'fit' ? <LCButton variant="quiet" size="sm" icon="clock" onClick={goToday}>Now</LCButton> : null}
            </div>
          ) : undefined} />
      ) : (
        <div className="tcc-monthnav">
          <LCButton variant="quiet" size="sm" icon="chevron-left" onClick={() => step(-1)} aria-label="Previous month" />
          <LCButton variant={day.slice(0, 7) === today.slice(0, 7) ? 'secondary' : 'quiet'} size="sm" onClick={goToday}>This month</LCButton>
          <LCButton variant="quiet" size="sm" icon="chevron-right" onClick={() => step(1)} aria-label="Next month" />
        </div>
      )}
      <div className={cx('tcc-body', showSide && wide && 'has-side')}>
        <main ref={stageRef} className="tcc-stage lc-scroll" aria-busy={!data} aria-label={`${mode} view`}>
          {stage}
          {error && data ? <p className="tcc-stalenote" role="status"><Icon name="alert" size={11} /> The last refresh failed. Showing the read from {store ? clock(store.at, tz) : 'earlier'} {zoneAbbr(tz)} — marked, not current. <button type="button" className="lc-link" onClick={() => setAttempt((a) => a + 1)}>Retry</button></p> : null}
          {mode === 'today' && data && !isToday ? <p className="tcc-basis tcc-stage__foot">Viewing {longDay(day)} — the live line and NEXT stay on today. <button type="button" className="lc-link" onClick={goToday}>Back to today</button></p> : null}
        </main>
        {showSide ? <div className={cx('tcc-side', !wide && 'is-overlay')}>{side}</div> : null}
      </div>
      {confirm ? (
        <LCConfirm open onOpenChange={(o) => { if (!o) setConfirm(null) }}
          title={confirm.kind === 'reschedule' ? 'Reschedule this message?' : 'Cancel this scheduled message?'}
          tone={confirm.kind === 'cancel' ? 'danger' : 'primary'}
          confirmLabel={confirm.kind === 'reschedule' ? `Move to ${clock(confirm.to, tz)} ${zoneAbbr(tz)}` : 'Cancel message'}
          cancelLabel={confirm.kind === 'reschedule' ? 'Keep current time' : 'Keep it'}
          effects={confirm.kind === 'reschedule' ? [
            { text: `${confirm.e.subtitle || 'The seller'}: ${clock(confirm.e.start, tz)} → ${longDay(dayKey(confirm.to, tz))} ${clock(confirm.to, tz)} ${zoneAbbr(tz)}`, kind: 'note' },
            ...(confirm.e.contact_window?.tz && confirm.e.contact_window.tz !== tz ? [{ text: `That is ${clock(confirm.to, confirm.e.contact_window.tz)} ${confirm.e.contact_window.abbr} for the seller — their contact window ${confirm.e.contact_window.window} still applies`, kind: 'note' as const }] : []),
            { text: 'The same queue row moves — no second message is created', kind: 'keeps' },
            { text: `Done through the queue's reschedule action (${APP_NAME.queue}), as the Queue and Inbox do`, kind: 'note' },
          ] : [
            { text: `The message to ${confirm.e.subtitle || 'this seller'} will not send`, kind: 'stops' },
            { text: 'The conversation and the seller\'s record stay as they are', kind: 'keeps' },
            { text: 'Cancelled, not deleted — it stays in history', kind: 'note' },
          ]}
          onConfirm={runConfirm} />
      ) : null}
      {appointmentId ? <AppointmentDrawer id={appointmentId} tz={tz} onClose={() => commit({ appointment: null })} onChanged={() => setApptTick((t) => t + 1)} /> : null}
    </div>
  )
}
