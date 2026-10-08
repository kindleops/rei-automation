import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { useBreakpoint } from '../../../modules/mobile/useBreakpoint'
import { pushRoutePath } from '../../../app/router'
import { openInboxThread } from '../../../modules/mobile/mobile-inbox-bridge'
import { useOperatorName } from '../../../shared/useOperatorName'
import {
  APP_LABEL, addDays, clock, dayKey, eventDay, fetchCalendarTimeline, longDate, operatorZone, shortDate,
  type CalApp, type CalEvent, type CalendarTimeline,
} from '../../../domain/calendar/calendar-timeline-api'
import { AttentionList, DayStrip, DayTimeline, EventSheet, MonthGrid, WeekList, cls } from './CalendarParts'
import { AppointmentsDesk } from '../scheduling/AppointmentsDesk'
import { AppointmentDrawer } from '../scheduling/AppointmentDrawer'
import { MyCalendarCard } from '../scheduling/MyCalendarCard'
import { TeamAdminCard } from '../scheduling/TeamAdminCard'
import './calendar-surface.css'
import './calendar-desktop.css'

/**
 * CALENDAR — the acquisition operation organised through time (mobile).
 *
 * Agenda first: the selected day as a timeline with NOW, the campaign send
 * windows as spans, deadlines as all-day facts. Week is a vertical list, Month
 * is navigation with dots, Attention is the time-based work queue.
 *
 * Every event comes from /api/cockpit/calendar/timeline, which projects the
 * canonical records read-only; this surface never derives an event, a count or
 * a deadline. Times read in the operator's zone, except market-defined times
 * (campaign windows / starts), which are stated in the market's zone.
 * Appointments (booked calls, My calendar) come from the scheduling service;
 * ?appointment=<id> opens one in its drawer from any view.
 */

type View = 'agenda' | 'week' | 'month' | 'attention' | 'appointments'
const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'agenda', label: 'Agenda' }, { key: 'week', label: 'Week' }, { key: 'month', label: 'Month' }, { key: 'attention', label: 'Attention' }, { key: 'appointments', label: 'Appointments' },
]
type Source = 'all' | CalApp
const readTheme = () => (typeof document === 'undefined' ? 'dark' : document.documentElement.getAttribute('data-nexus-theme') || 'dark')
const DATE = /^\d{4}-\d{2}-\d{2}$/

function readUrl() {
  const q = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
  const date = q.get('date')
  const view = q.get('view') as View | null
  return {
    date: date && DATE.test(date) ? date : null,
    view: view && VIEWS.some((v) => v.key === view) ? view : null,
    event: q.get('event'),
    property: q.get('property_id'),
    appointment: q.get('appointment'),
    connection: q.get('calendar_connection'),
  }
}

function writeUrl(patch: Record<string, string | null>) {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  for (const [k, v] of Object.entries(patch)) (v ? url.searchParams.set(k, v) : url.searchParams.delete(k))
  // replaceState: moving through days/views must not bury Back under history.
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`)
}

function greetingFor(now: Date) {
  const h = now.getHours()
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

// The desktop Temporal Command Center (CALENDAR 3.0). Lazy: a phone never loads it.
const CalendarDesk = lazy(() => import('../desktop/CalendarDesk').then((m) => ({ default: m.CalendarDesk })))

/**
 * One route, two instruments: a phone keeps the time command surface below
 * exactly as it was; the modern desktop gets the Temporal Command Center.
 */
export function CalendarSurface() {
  const { isPhone } = useBreakpoint()
  if (!isPhone) {
    return (
      <Suspense fallback={<div className="cal3" aria-busy="true" />}>
        <CalendarDesk />
      </Suspense>
    )
  }
  return <CalendarPhoneSurface />
}

function CalendarPhoneSurface() {
  const tz = useMemo(operatorZone, [])
  const name = useOperatorName()
  const initial = useMemo(readUrl, [])
  const [now, setNow] = useState(() => Date.now())
  const today = dayKey(now, tz)
  const [selected, setSelected] = useState(initial.date || today)
  // returning from Google sign-in lands on Appointments, where My calendar says how it went
  const [view, setView] = useState<View>(initial.view || (initial.connection ? 'appointments' : 'agenda'))
  const [appointmentId, setAppointmentId] = useState<string | null>(initial.appointment)
  const [connection, setConnection] = useState<string | null>(initial.connection)
  const [apptTick, setApptTick] = useState(0)
  const [source, setSource] = useState<Source>('all')
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [property, setProperty] = useState<string | null>(initial.property)
  const [openId, setOpenId] = useState<string | null>(initial.event)
  const [data, setData] = useState<CalendarTimeline | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [theme, setTheme] = useState(readTheme)
  const reqRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(readTheme()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-nexus-theme'] })
    const tick = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => { mo.disconnect(); window.clearInterval(tick) }
  }, [])

  // One bounded range per view: a strip-and-week window, or the whole month.
  const range = useMemo(() => {
    if (view === 'month') {
      const first = `${selected.slice(0, 7)}-01`
      const last = addDays(`${addDays(first, 32).slice(0, 7)}-01`, -1)
      return { from: first, to: last }
    }
    const from = addDays(selected < today ? selected : today, -3)
    return { from, to: addDays(from, 20) }
  }, [view, selected, today])

  const load = useCallback(async (quiet = false) => {
    reqRef.current?.abort()
    const ctl = new AbortController()
    reqRef.current = ctl
    if (!quiet) setLoading(true)
    try {
      const next = await fetchCalendarTimeline({ from: range.from, to: range.to, tz, propertyId: property }, ctl.signal)
      if (ctl.signal.aborted) return
      setData(next)
      setError(null)
    } catch (e) {
      if (ctl.signal.aborted) return
      setError(e instanceof Error ? e.message : 'calendar_failed')
    } finally {
      if (!ctl.signal.aborted) setLoading(false)
    }
  }, [range.from, range.to, tz, property])

  useEffect(() => { void load() }, [load])
  // Real state changes (a send going out, a campaign going live) arrive on the
  // next read; there is no push channel for calendar events.
  useEffect(() => {
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') void load(true) }, 60_000)
    return () => window.clearInterval(id)
  }, [load])

  useEffect(() => { writeUrl({ date: selected === today ? null : selected, view: view === 'agenda' ? null : view }) }, [selected, view, today])
  useEffect(() => { writeUrl({ event: openId }) }, [openId])
  useEffect(() => { writeUrl({ appointment: appointmentId, calendar_connection: null }) }, [appointmentId])

  const all = useMemo(() => data?.events ?? [], [data])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all.filter((e) => (source === 'all' || e.app === source) &&
      (!q || [e.title, e.subtitle, e.place, (e.detail as { market?: string })?.market].some((v) => String(v ?? '').toLowerCase().includes(q))))
  }, [all, source, query])

  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>()
    for (const e of filtered) {
      const d = eventDay(e, e.type === 'campaign_window' && e.tz ? e.tz : tz)
      if (!m.has(d)) m.set(d, [])
      m.get(d)!.push(e)
    }
    return m
  }, [filtered, tz])

  const marks = useMemo(() => {
    const m = new Map<string, { operator: boolean; system: boolean; closing: boolean; attention: boolean }>()
    for (const [d, list] of byDay) {
      m.set(d, {
        operator: list.some((e) => e.actor === 'operator'),
        system: list.some((e) => e.actor === 'system' && e.type !== 'campaign_window'),
        closing: list.some((e) => e.type === 'closing' || e.type === 'closing_milestone'),
        attention: list.some((e) => e.attention),
      })
    }
    return m
  }, [byDay])

  const dayEvents = byDay.get(selected) || []
  const tomorrow = addDays(today, 1)
  const tomorrowEvents = byDay.get(tomorrow) || []
  const attention = useMemo(() => (data?.attention ?? []).filter((e) => source === 'all' || e.app === source), [data, source])
  const stripDays = useMemo(() => Array.from({ length: 14 }, (_, i) => addDays(addDays(today, -2), i)), [today])
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(selected, i)), [selected])
  const sources = useMemo(() => (['inbox', 'campaigns', 'pipeline', 'closing'] as CalApp[]).filter((a) => all.some((e) => e.app === a)), [all])
  const failed = Object.entries(data?.source_status ?? {}).filter(([, s]) => s === 'failed').map(([k]) => k)
  const openEvent = openId ? [...all, ...(data?.attention ?? [])].find((e) => e.id === openId) || null : null

  const s = data?.today
  const nowDate = new Date(now)
  const pick = (d: string) => { setSelected(d); setView('agenda') }

  const actions = {
    conversation: (threadKey: string, propertyId?: string | null) => { setOpenId(null); openInboxThread({ threadKey, propertyId }) },
    pipeline: (opp: string) => { setOpenId(null); pushRoutePath(`/pipeline?opp=${encodeURIComponent(opp)}`) },
    campaign: (id: string) => { setOpenId(null); pushRoutePath(`/campaign-command?campaign=${encodeURIComponent(id)}`) },
    closing: () => { setOpenId(null); pushRoutePath('/closing-desk') },
    graph: (pid: string) => { setOpenId(null); pushRoutePath(`/entity-graph/property/${encodeURIComponent(pid)}`) },
    appointment: (id: string) => { setOpenId(null); setAppointmentId(id) },
  }

  const automationLine = s && s.system > 0 && s.operator === 0 && s.attention === 0
    ? `Automation is handling ${s.system} scheduled action${s.system === 1 ? '' : 's'} today`
    : null

  return (
    <div className={cls('cal2', loading && data && 'is-refreshing')} data-theme={theme}>
      <header className="cal2-hero">
        <span className="cal2-eyebrow"><i />{longDate(today)}</span>
        <h1>{greetingFor(nowDate)}{name ? `, ${name}` : ''}</h1>
        {s ? (
          <div className="cal2-summary" role="list">
            <div role="listitem"><b>{s.total}</b><span>today</span></div>
            <div role="listitem" className={cls(s.operator > 0 && 'is-you')}><b>{s.operator}</b><span>need you</span></div>
            <div role="listitem"><b>{s.system}</b><span>system</span></div>
            <button type="button" className={cls('cal2-summary__attn', attention.length > 0 && 'is-bad')} onClick={() => setView('attention')}><b>{attention.length}</b><span>attention</span></button>
          </div>
        ) : <div className="cal2-summary is-skel" aria-hidden="true"><i /><i /><i /><i /></div>}
        {automationLine ? <p className="cal2-hero__line"><Icon name="check" />{automationLine}</p> : null}
      </header>

      {property ? (
        <div className="cal2-scope">
          <span><Icon name="pin" />Showing one property</span>
          <button type="button" onClick={() => { setProperty(null); writeUrl({ property_id: null }) }} aria-label="Show all properties">Show all<Icon name="close" /></button>
        </div>
      ) : null}

      <nav className="cal2-views" aria-label="Calendar view">
        {VIEWS.map((v) => (
          <button key={v.key} type="button" className={cls('cal2-views__tab', view === v.key && 'is-on')} aria-pressed={view === v.key} onClick={() => setView(v.key)}>
            {v.label}{v.key === 'attention' && attention.length ? <em>{attention.length}</em> : null}
          </button>
        ))}
      </nav>

      {view !== 'attention' && view !== 'appointments' ? (
        <div className="cal2-tools">
          <div className="cal2-chips" role="group" aria-label="Source">
            <button type="button" className={cls('cal2-chip', source === 'all' && 'is-on')} onClick={() => setSource('all')}>All</button>
            {sources.map((a) => <button key={a} type="button" className={cls('cal2-chip', source === a && 'is-on')} onClick={() => setSource(a)}>{APP_LABEL[a]}</button>)}
          </div>
          <button type="button" className={cls('cal2-icon-btn', (searchOpen || query) && 'is-on')} onClick={() => setSearchOpen((o) => !o)} aria-label="Search"><Icon name="search" /></button>
        </div>
      ) : null}
      {searchOpen && view !== 'attention' && view !== 'appointments' ? (
        <label className="cal2-search">
          <Icon name="search" />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Seller, property, campaign…" aria-label="Search events" />
          {query ? <button type="button" onClick={() => setQuery('')} aria-label="Clear"><Icon name="close" /></button> : null}
        </label>
      ) : null}

      {failed.length ? <p className="cal2-degraded"><Icon name="alert" />Some events couldn’t load ({failed.join(', ').replace(/_/g, ' ')}). Everything else is current.</p> : null}
      {error && !data && view !== 'appointments' ? (
        <div className="cal2-error">
          <b>Calendar couldn’t load</b>
          <p>{error.replace(/_/g, ' ')}</p>
          <button type="button" className="cal2-act is-primary" onClick={() => void load()}>Try again</button>
        </div>
      ) : null}

      {!data && !error && view !== 'appointments' ? <Skeleton /> : null}

      {data && view === 'agenda' ? (
        <>
          <DayStrip days={stripDays} selected={selected} today={today} marks={marks} onPick={setSelected} />
          <div className="cal2-dayhead">
            <h2>{selected === today ? 'Today' : selected === tomorrow ? 'Tomorrow' : shortDate(selected)}</h2>
            <span>{dayEvents.length ? `${dayEvents.length} item${dayEvents.length === 1 ? '' : 's'}` : ''}</span>
            {selected !== today ? <button type="button" className="cal2-link" onClick={() => setSelected(today)}>Today</button> : null}
          </div>
          {query && !dayEvents.length && filtered.length ? (
            <SearchResults events={filtered} tz={tz} onPick={(e) => { setSelected(eventDay(e, tz)); setOpenId(e.id) }} />
          ) : dayEvents.length ? (
            <DayTimeline events={dayEvents} tz={tz} isToday={selected === today} now={now} onOpen={(e) => setOpenId(e.id)} />
          ) : (
            <Clear next={data.next_event} tz={tz} onNext={() => { const n = data.next_event; if (n) { setSelected(dayKey(n.start, tz)); setOpenId(n.id) } }} />
          )}
          {selected === today && tomorrowEvents.length ? (
            <button type="button" className="cal2-tomorrow" onClick={() => setSelected(tomorrow)}>
              <span className="cal2-eyebrow"><i />Tomorrow</span>
              <b>{tomorrowEvents.length} item{tomorrowEvents.length === 1 ? '' : 's'}</b>
              <span>{summarizeKinds(tomorrowEvents)}</span>
              <Icon name="chevron-right" />
            </button>
          ) : null}
        </>
      ) : null}

      {data && view === 'week' ? (
        <>
          <div className="cal2-dayhead">
            <h2>{shortDate(weekDays[0])} – {shortDate(weekDays[6])}</h2>
            <span />
            <span className="cal2-pager">
              <button type="button" className="cal2-icon-btn" onClick={() => setSelected(addDays(selected, -7))} aria-label="Previous week"><Icon name="chevron-left" /></button>
              <button type="button" className="cal2-icon-btn" onClick={() => setSelected(addDays(selected, 7))} aria-label="Next week"><Icon name="chevron-right" /></button>
            </span>
          </div>
          <WeekList days={weekDays} byDay={byDay} today={today} onPick={pick} />
        </>
      ) : null}

      {data && view === 'month' ? (
        <MonthGrid month={selected} selected={selected} today={today} marks={marks} onPick={pick}
          onShift={(n) => setSelected(`${addDays(`${selected.slice(0, 7)}-15`, n * 30).slice(0, 7)}-01`)} />
      ) : null}

      {data && view === 'attention' ? <AttentionList events={attention} tz={tz} onOpen={(e) => setOpenId(e.id)} /> : null}

      {view === 'appointments' ? (
        <div className="cal2-appts">
          <AppointmentsDesk tz={tz} compact refreshKey={apptTick} onOpen={setAppointmentId} />
          <MyCalendarCard notice={connection} onDismissNotice={() => setConnection(null)} />
          <TeamAdminCard />
        </div>
      ) : null}
      {appointmentId ? <AppointmentDrawer id={appointmentId} tz={tz} onClose={() => setAppointmentId(null)} onChanged={() => setApptTick((t) => t + 1)} /> : null}

      {openEvent ? <EventSheet e={openEvent} tz={tz} theme={theme} actions={actions} onClose={() => setOpenId(null)} /> : null}
    </div>
  )
}

function summarizeKinds(list: CalEvent[]) {
  const n = (f: (e: CalEvent) => boolean) => list.filter(f).length
  const parts: string[] = []
  const closings = n((e) => e.type === 'closing')
  const you = n((e) => e.actor === 'operator')
  const follow = n((e) => e.type === 'seller_follow_up')
  const sends = list.filter((e) => e.type === 'campaign_sends' || e.type === 'scheduled_message').reduce((a, e) => a + e.count, 0)
  const campaigns = n((e) => e.type === 'campaign_start')
  if (closings) parts.push(`${closings} closing${closings === 1 ? '' : 's'}`)
  if (you) parts.push(`${you} for you`)
  if (campaigns) parts.push(`${campaigns} campaign start${campaigns === 1 ? '' : 's'}`)
  if (follow) parts.push(`${follow} follow-up${follow === 1 ? '' : 's'}`)
  if (sends) parts.push(`${sends} scheduled message${sends === 1 ? '' : 's'}`)
  return parts.slice(0, 3).join(' · ')
}

function Clear({ next, tz, onNext }: { next: CalendarTimeline['next_event']; tz: string; onNext: () => void }) {
  return (
    <div className="cal2-clear">
      <span className="cal2-clear__orb" aria-hidden="true"><Icon name="check" /></span>
      <b>You’re clear</b>
      <p>Nothing is scheduled or due on this day.</p>
      {next ? (
        <button type="button" className="cal2-clear__next" onClick={onNext}>
          <small>Next</small>
          <span>{next.title}{next.subtitle ? ` · ${next.subtitle}` : ''}</span>
          <em>{shortDate(dayKey(next.start, next.tz || tz))} · {clock(next.start, next.tz || tz)}</em>
        </button>
      ) : null}
    </div>
  )
}

function SearchResults({ events, tz, onPick }: { events: CalEvent[]; tz: string; onPick: (e: CalEvent) => void }) {
  return (
    <div className="cal2-results">
      {events.slice(0, 40).map((e) => (
        <button key={e.id} type="button" className="cal2-result" onClick={() => onPick(e)}>
          <time>{shortDate(eventDay(e, tz))}</time>
          <span><b>{e.title}</b>{e.subtitle ? <em>{e.subtitle}</em> : null}</span>
          <Icon name="chevron-right" />
        </button>
      ))}
    </div>
  )
}

function Skeleton() {
  return (
    <div className="cal2-skel" aria-hidden="true">
      <div className="cal2-skel__strip">{Array.from({ length: 6 }, (_, i) => <i key={i} />)}</div>
      {Array.from({ length: 4 }, (_, i) => <div key={i} className="cal2-skel__row"><i /><span /></div>)}
    </div>
  )
}
