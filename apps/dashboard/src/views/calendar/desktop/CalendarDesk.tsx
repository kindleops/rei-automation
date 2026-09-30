import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { setPropertyLocator } from '../../../domain/locator/property-locator'
import { getSupabaseClient } from '../../../lib/supabaseClient'
import { shouldUseSupabase } from '../../../lib/data/shared'
import { uniqueChannelName } from '../../../lib/data/realtime-channel'
import { useBackdropSettings } from '../../../modules/desktop/backdrop-settings'
import { fetchDeskTimeline, operatorZone, type DeskEvent, type DeskTimeline } from '../../../domain/calendar/calendar-timeline-api'
import {
  addDays, clock, daypart, dayKey, dayNum, densityRail, localMinutes, longDay, monthDay, monthTitle, weekStart, weekday, zoneAbbr, type TzMode,
} from './desk-model'
import { DayBrief, Inspector, cx, type InspectorActions } from './DeskParts'
import { AttentionView, MonthView, NowView, SearchResults, TimelineView, TodayView, WeekView, type ViewProps } from './DeskViews'
import './calendar-desk.css'

/**
 * CALENDAR 3.0 — THE TEMPORAL COMMAND CENTER (desktop).
 *
 * "I can see what the entire company is doing through time." Every event is a
 * projection of a canonical record served by /api/cockpit/calendar/timeline
 * (view=desk); this surface arranges, never invents: the header counts are the
 * server's telemetry, the month cells its day aggregates, the attention board
 * its canonical categories. Reschedule and create hand off to the owning app —
 * the calendar holds no state of its own.
 */

type View = 'today' | 'timeline' | 'week' | 'month' | 'attention' | 'now'
const VIEWS: Array<{ key: View; label: string; kbd: string }> = [
  { key: 'today', label: 'Today', kbd: '1' }, { key: 'timeline', label: 'Timeline', kbd: '2' }, { key: 'week', label: 'Week', kbd: '3' },
  { key: 'month', label: 'Month', kbd: '4' }, { key: 'attention', label: 'Attention', kbd: '5' }, { key: 'now', label: 'Now', kbd: '6' },
]
type LaneFilter = 'all' | 'campaign' | 'closing' | 'automation' | 'workflow' | 'manual'
const LANES: Array<{ key: LaneFilter; label: string }> = [
  { key: 'all', label: 'All' }, { key: 'campaign', label: 'Campaigns' }, { key: 'closing', label: 'Closings' },
  { key: 'automation', label: 'Automation' }, { key: 'workflow', label: 'Workflows' }, { key: 'manual', label: 'Yours' },
]
const DATE = /^\d{4}-\d{2}-\d{2}$/
const INSPECTOR_KEY = 'nexus.calendar.inspector'
/** Cached ranges may be SHOWN (marked "Refreshing") for this long while the fresh read runs. */
const CACHE_TTL = 10 * 60_000

const readParam = (k: string) => { try { return new URLSearchParams(window.location.search).get(k) } catch { return null } }
function writeParams(patch: Record<string, string | null>) {
  try {
    const url = new URL(window.location.href)
    for (const [k, v] of Object.entries(patch)) (v ? url.searchParams.set(k, v) : url.searchParams.delete(k))
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`)
  } catch { /* ignore */ }
}
const isDemo = () => readParam('demo') === '1'

/** One bounded range per anchor: five weeks around it (Today/Timeline/Week/Now/Attention) or the six-week month grid. */
function rangeFor(view: View, anchor: string) {
  if (view === 'month') { const s = weekStart(`${anchor.slice(0, 7)}-01`); return { from: s, to: addDays(s, 41) } }
  const s = addDays(weekStart(anchor), -7)
  return { from: s, to: addDays(s, 34) }
}

let demoCache: Promise<DeskTimeline> | null = null
const loadDemo = () => (demoCache ??= import('./calendar-demo.generated.json').then((m) => (m.default ?? m) as unknown as DeskTimeline))

export function CalendarDesk() {
  const tz = useMemo(operatorZone, [])
  const demo = useMemo(isDemo, [])
  const [backdrop] = useBackdropSettings()
  const [clockNow, setClockNow] = useState(() => Date.now())
  const [demoNow, setDemoNow] = useState<number | null>(null)
  const now = demoNow ?? clockNow
  const today = dayKey(now, tz)
  const [day, setDay] = useState(() => (DATE.test(readParam('date') || '') ? readParam('date')! : dayKey(Date.now(), tz)))
  const [view, setView] = useState<View>(() => (VIEWS.some((v) => v.key === readParam('view')) ? readParam('view') as View : 'today'))
  const [mode, setMode] = useState<TzMode>(() => (readParam('tz') === 'event' ? 'event' : 'operator'))
  const [lane, setLane] = useState<LaneFilter>('all')
  const [showHistory, setShowHistory] = useState(true)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(() => readParam('event'))
  const [data, setData] = useState<DeskTimeline | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const [arrived, setArrived] = useState<Set<string>>(() => new Set())
  const [live, setLive] = useState(false)
  const [pop, setPop] = useState<null | 'date' | 'create'>(null)
  const [confirm, setConfirm] = useState<DeskEvent | null>(null)
  const [width, setWidth] = useState(1200)
  const [inspectorPref, setInspectorPref] = useState<'open' | 'closed' | null>(() => { try { const v = localStorage.getItem(INSPECTOR_KEY); return v === 'open' || v === 'closed' ? v : null } catch { return null } })
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const cache = useRef(new Map<string, { data: DeskTimeline; at: number }>())
  const reqRef = useRef<AbortController | null>(null)
  const prevStatus = useRef(new Map<string, string>())
  const prefetched = useRef(new Set<string>())

  // NOW and ATTENTION are always about today, whatever day is selected.
  const range = useMemo(() => rangeFor(view, view === 'now' || view === 'attention' ? today : day), [view, day, today])
  const rangeKey = `${range.from}:${range.to}`

  // The clock: NOW progresses; the playhead only needs a quiet cadence.
  useEffect(() => {
    const id = window.setInterval(() => setClockNow(Date.now()), view === 'now' ? 15_000 : 30_000)
    return () => window.clearInterval(id)
  }, [view])

  // Pane width drives the inspector default (collapsed at a 1280 screen).
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const wide = width >= 1100
  const inspectorOpen = inspectorPref ? inspectorPref === 'open' : wide
  const setInspector = (open: boolean) => { const v = open ? 'open' : 'closed'; setInspectorPref(v); try { localStorage.setItem(INSPECTOR_KEY, v) } catch { /* ignore */ } }

  const fetchRange = useCallback(async (from: string, to: string, signal?: AbortSignal) => {
    if (demo) { const d = await loadDemo(); return d }
    return fetchDeskTimeline({ from, to, tz }, signal)
  }, [demo, tz])

  /** Mark what changed status since the last read — one subtle arrival signal. */
  const absorb = useCallback((next: DeskTimeline, quiet: boolean) => {
    const changed = new Set<string>()
    for (const e of next.events) {
      const prev = prevStatus.current.get(e.id)
      if (quiet && prev !== undefined && prev !== e.state) changed.add(e.id)
      if (quiet && prev === undefined && prevStatus.current.size) changed.add(e.id)
    }
    prevStatus.current = new Map(next.events.map((e) => [e.id, e.state]))
    if (changed.size) { setArrived(changed); window.setTimeout(() => setArrived(new Set()), 2600) }
  }, [])

  const load = useCallback(async (quiet = false) => {
    reqRef.current?.abort()
    const ctl = new AbortController()
    reqRef.current = ctl
    const hit = cache.current.get(rangeKey)
    if (hit && Date.now() - hit.at < CACHE_TTL && !quiet) { setData(hit.data); setLoading(false) }
    if (quiet || hit) setRefreshing(true); else setLoading(true)
    try {
      const next = await fetchRange(range.from, range.to, ctl.signal)
      if (ctl.signal.aborted) return
      cache.current.set(rangeKey, { data: next, at: Date.now() })
      if (demo) setDemoNow(Date.parse(next.range.now))
      absorb(next, quiet)
      setData(next)
      setLoadedAt(Date.now())
      setError(null)
    } catch (e) {
      if (ctl.signal.aborted) return
      setError(e instanceof Error ? e.message : 'calendar_failed')
    } finally {
      if (!ctl.signal.aborted) { setLoading(false); setRefreshing(false) }
    }
  }, [rangeKey, range.from, range.to, fetchRange, absorb, demo])

  useEffect(() => { void load() }, [load])

  // Preload the NEXT period once the operator has settled (forward is where
  // time goes; one bounded read, never a burst), so → lands on real data.
  const hasData = Boolean(data)
  useEffect(() => {
    if (!hasData || demo) return
    const id = window.setTimeout(() => {
      const r = rangeFor(view, view === 'month' ? addDays(`${day.slice(0, 7)}-15`, 31) : addDays(day, 28))
      const k = `${r.from}:${r.to}`
      // Once per range: a quiet refresh never re-triggers it.
      if (prefetched.current.has(k) || cache.current.has(k)) return
      prefetched.current.add(k)
      fetchDeskTimeline({ from: r.from, to: r.to, tz }).then((d) => cache.current.set(k, { data: d, at: Date.now() })).catch(() => { /* a prefetch failure is silent — the real load states its own */ })
    }, 6000)
    return () => window.clearTimeout(id)
  }, [hasData, view, day, tz, demo])

  // Live: existing Supabase realtime on the conversation tables; a reply that
  // cancels a follow-up updates in place with one subtle arrival signal.
  // Re-reads are debounced AND spaced (at most one per 30 s) — every re-read is
  // a round of queries against the production database.
  useEffect(() => {
    if (demo || !shouldUseSupabase()) return
    let timer = 0
    let cancelled = false
    let lastKick = 0
    const supabase = getSupabaseClient()
    const kick = () => {
      window.clearTimeout(timer)
      const wait = Math.max(3000, 30_000 - (Date.now() - lastKick))
      timer = window.setTimeout(() => { if (document.visibilityState === 'visible') { lastKick = Date.now(); void load(true) } }, wait)
    }
    const channels: RealtimeChannel[] = []
    try {
      channels.push(supabase.channel(uniqueChannelName('nx-cal3:inbox_thread_state')).on('postgres_changes', { event: '*', schema: 'public', table: 'inbox_thread_state' }, kick).subscribe((s) => { if (!cancelled) setLive(s === 'SUBSCRIBED') }))
      channels.push(supabase.channel(uniqueChannelName('nx-cal3:message_events')).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_events' }, kick).subscribe())
    } catch { setLive(false) }
    const poll = window.setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - lastKick > 90_000) { lastKick = Date.now(); void load(true) } }, 120_000)
    return () => { cancelled = true; window.clearTimeout(timer); window.clearInterval(poll); for (const c of channels) void supabase.removeChannel(c) }
  }, [load, demo])

  useEffect(() => { writeParams({ date: day === today ? null : day, view: view === 'today' ? null : view, tz: mode === 'event' ? 'event' : null, event: selectedId }) }, [day, view, mode, selectedId, today])

  const events = useMemo(() => {
    const all = data?.events ?? []
    return all.filter((e) => lane === 'all' || (lane === 'manual' ? e.owner === 'you' || e.lane === 'manual' : e.lane === lane))
  }, [data, lane])
  const byId = useMemo(() => new Map([...(data?.events ?? []), ...(data?.attention ?? [])].map((e) => [e.id, e])), [data])
  const selected = selectedId ? byId.get(selectedId) ?? null : null

  const open = useCallback((e: DeskEvent) => { setSelectedId(e.id); setInspector(true) }, [])
  const openId = useCallback((id: string) => { if (byId.get(id)) { setSelectedId(id); setInspector(true) } }, [byId])
  const pickDay = useCallback((d: string, v?: 'today' | 'week') => { setDay(d); setView(v ?? (view === 'month' || view === 'attention' ? 'today' : view)) }, [view])

  const step = useCallback((dir: 1 | -1) => {
    setDay((d) => (view === 'week' ? addDays(d, 7 * dir) : view === 'month' ? `${addDays(`${d.slice(0, 7)}-15`, 31 * dir).slice(0, 7)}-01` : addDays(d, dir)))
  }, [view])

  const actions: InspectorActions = useMemo(() => ({
    go: (path) => pushRoutePath(path),
    openMap: (e) => { setPropertyLocator({ propertyId: e.links.property_id ?? undefined, threadKey: e.links.thread_key ?? undefined, opportunityId: e.links.opportunity_id ?? undefined, address: e.place ?? undefined }); pushRoutePath('/map') },
    reschedule: (e) => setConfirm(e),
  }), [])

  // Keyboard — only when the calendar is the pane in use and no field has focus.
  // Capture phase: the Inbox host binds "/" to its own layout; a key the calendar
  // consumes stops there, every other key passes through untouched.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return
      const t = ev.target as HTMLElement | null
      const consume = () => { ev.preventDefault(); ev.stopImmediatePropagation() }
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]'))) { if (ev.key === 'Escape' && t === searchRef.current) { setQuery(''); searchRef.current?.blur(); consume() } return }
      const root = rootRef.current
      if (!root || !root.isConnected) return
      const pane = root.closest('.dsk-pane')
      if (t && t !== document.body && !root.contains(t) && pane && !pane.contains(t) && t.closest('.dsk-pane')) return
      if (ev.key === 'Escape') { if (confirm) setConfirm(null); else if (pop) setPop(null); else if (selectedId) setSelectedId(null); else if (inspectorOpen) setInspector(false); else return; consume(); return }
      if (ev.key === 't' || ev.key === 'T') { setDay(today); consume(); return }
      if (ev.key === 'ArrowRight') { step(1); consume(); return }
      if (ev.key === 'ArrowLeft') { step(-1); consume(); return }
      if (ev.key === '/') { searchRef.current?.focus(); consume(); return }
      // Enter on a focused control is that control's own click; on the page it opens the selection.
      if (ev.key === 'Enter' && t && t.closest('button, a, [role="tab"]')) return
      if (ev.key === 'Enter' && selected?.deep_link) { pushRoutePath(selected.deep_link.path); consume(); return }
      const v = VIEWS.find((x) => x.kbd === ev.key)
      if (v) { setView(v.key); consume() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [confirm, pop, selectedId, inspectorOpen, today, step, selected])

  const tel = data?.telemetry
  const failed = Object.entries(data?.source_status ?? {}).filter(([, s]) => s === 'failed').map(([k]) => k.replace(/_/g, ' '))
  const rail = useMemo(() => (data ? densityRail(data.days, data.range.from, data.range.to) : []), [data])
  const part = daypart(now, tz)
  const tint = backdrop.intensity >= 10 ? part : null
  const vp: ViewProps | null = data ? { data, events, day, mode, tz, now, selectedId, arrivedIds: arrived, showHistory, onOpen: open, onPickDay: pickDay } : null
  const nextBrief = tel?.next_system || tel?.next

  return (
    <div ref={rootRef} className={cx('cal3', inspectorOpen && 'has-inspector', !wide && 'is-narrow', refreshing && 'is-refreshing')} data-daypart={tint || undefined}>
      {/* L1 · architectural header */}
      <header className="c3-head">
        <div className="c3-head__title">
          <h1>Calendar</h1>
          <p className="c3-head__spec">
            <span>{longDay(today)}</span>
            {tel ? <><span>{tel.today.total} today</span><span>{tel.today.system} system</span><span className={cx(tel.attention.total && 'is-attn')}>{tel.attention.total} attention</span></> : <span className="c3-skel-inline" />}
          </p>
        </div>
        <div className="c3-head__tools">
          {demo ? <span className="c3-demo" title="Fixture rows run through the real read model — never production data">Demo data</span> : null}
          <div className="c3-popwrap">
            <button type="button" className="c3-btn is-primary" onClick={() => setPop((p) => (p === 'create' ? null : 'create'))} aria-expanded={pop === 'create'}><span className="c3-plus" aria-hidden>+</span>Create</button>
            {pop === 'create' ? (
              <div className="c3-pop c3-create" role="menu">
                <p className="c3-pop__note">The calendar creates nothing itself — each opens the app that owns it.</p>
                {[
                  ['Campaign schedule', 'Campaign Command', '/campaign-command'],
                  ['Seller message', 'Inbox · schedule in the conversation', '/inbox'],
                  ['Closing date', 'Closing Desk · closing authority', '/closing-desk'],
                  ['Workflow timer', 'Workflow Studio', '/workflow-studio?create=1'],
                  ['Email', 'Email Command', '/email-command'],
                ].map(([label, where, path]) => (
                  <button key={label} type="button" role="menuitem" className="c3-pop__row" onClick={() => { setPop(null); pushRoutePath(path) }}>
                    <span><b>{label}</b><em>{where}</em></span><Icon name="arrow-up-right" />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {/* L1 · temporal telemetry strip (the server's counts, each with its basis) */}
      <div className="c3-tele" role="list" aria-label="Calendar telemetry">
        <button type="button" role="listitem" className="c3-tele__cell" onClick={() => { setDay(today); setView('today') }} title={tel?.basis.today}><small>Today</small><b>{tel?.today.total ?? '—'}</b></button>
        <div role="listitem" className="c3-tele__cell" title={tel?.basis.system}><small>System</small><b>{tel?.today.system ?? '—'}</b></div>
        <div role="listitem" className={cx('c3-tele__cell', (tel?.needs_you.total ?? 0) > 0 && 'is-you')} title={tel?.basis.needs_you}><small>Needs you</small><b>{tel?.needs_you.total ?? '—'}</b></div>
        <button type="button" role="listitem" className={cx('c3-tele__cell', (tel?.attention.total ?? 0) > 0 && 'is-attn')} onClick={() => setView('attention')} title={tel?.basis.attention}><small>Attention</small><b>{tel?.attention.total ?? '—'}</b></button>
        <button type="button" role="listitem" className="c3-tele__cell is-next" onClick={() => nextBrief && openId(nextBrief.id)} disabled={!nextBrief} title={tel?.basis.next}>
          <small>Next{tel?.next_system ? ' system action' : ''}</small>
          <b>{nextBrief ? `${clock(nextBrief.at, tz)} ${zoneAbbr(tz)}` : tel?.live.length ? 'Live now' : '—'}</b>
          <em>{nextBrief ? `${nextBrief.title}${nextBrief.subtitle ? ` · ${nextBrief.subtitle.split(' · ').slice(0, 2).join(' · ')}` : ''}` : tel?.live.length ? `${tel.live.length} window${tel.live.length === 1 ? '' : 's'} sending` : 'Nothing else scheduled'}</em>
        </button>
        <div role="listitem" className={cx('c3-tele__cell is-status', failed.length && 'is-attn')}>
          <small>{demo ? 'Demo' : live ? 'Live' : 'Polling'}</small>
          <b className="c3-tele__dot"><i className={cx(live && 'is-live', failed.length && 'is-warn')} aria-hidden />{refreshing ? 'Refreshing' : loadedAt ? clock(loadedAt, tz) : '—'}</b>
          <em>{failed.length ? `Some calendar data unavailable: ${failed.join(', ')}` : data ? `${Object.keys(data.source_status).length} sources read` : 'Reading sources'}</em>
        </div>
      </div>

      {/* L1 · context bar */}
      <div className="c3-ctx">
        <div className="c3-ctx__nav">
          <button type="button" className={cx('c3-btn', day === today && 'is-on')} onClick={() => setDay(today)} title="Today (T)">Today</button>
          <button type="button" className="c3-icon" onClick={() => step(-1)} aria-label="Previous (←)"><Icon name="chevron-left" /></button>
          <button type="button" className="c3-icon" onClick={() => step(1)} aria-label="Next (→)"><Icon name="chevron-right" /></button>
          <div className="c3-popwrap">
            <button type="button" className="c3-datebtn" onClick={() => setPop((p) => (p === 'date' ? null : 'date'))} aria-expanded={pop === 'date'}>
              <b>{view === 'month' ? monthTitle(day) : view === 'week' ? `${monthDay(weekStart(day))} – ${monthDay(addDays(weekStart(day), 6))}` : longDay(day)}</b><Icon name="chevron-down" />
            </button>
            {pop === 'date' ? <DatePop day={day} today={today} onPick={(d) => { setPop(null); setDay(d) }} /> : null}
          </div>
          <div className="c3-seg c3-tzseg" role="group" aria-label="Time zone">
            <button type="button" className={cx(mode === 'operator' && 'is-on')} aria-pressed={mode === 'operator'} onClick={() => setMode('operator')} title="Every clock in your zone">Operator · {zoneAbbr(tz)}</button>
            <button type="button" className={cx(mode === 'event' && 'is-on')} aria-pressed={mode === 'event'} onClick={() => setMode('event')} title="Each clock in the zone it is defined in (campaign market, property, seller)">Event-local</button>
          </div>
        </div>
        <div className="c3-seg c3-views" role="tablist" aria-label="Calendar mode">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" role="tab" aria-selected={view === v.key} className={cx(view === v.key && 'is-on')} onClick={() => setView(v.key)} title={`${v.label} (${v.kbd})`}>
              {v.label}{v.key === 'attention' && tel?.attention.total ? <em>{tel.attention.total}</em> : null}
            </button>
          ))}
        </div>
        <div className="c3-ctx__tools">
          <label className={cx('c3-lanesel', lane !== 'all' && 'is-on')}>
            <span>Show</span>
            <select value={lane} onChange={(e) => setLane(e.target.value as LaneFilter)} aria-label="Show lanes">
              {LANES.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
            </select>
            <Icon name="chevron-down" />
          </label>
          <button type="button" className={cx('c3-toggle', showHistory && 'is-on')} aria-pressed={showHistory} onClick={() => setShowHistory((h) => !h)} title="Completed, cancelled and superseded items stay as history">History</button>
          <label className={cx('c3-search', query && 'is-on')}>
            <Icon name="search" />
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search seller, property, campaign" aria-label="Search the calendar" />
            {query ? <button type="button" onClick={() => setQuery('')} aria-label="Clear search"><Icon name="close" /></button> : <kbd>/</kbd>}
          </label>
          <button type="button" className={cx('c3-icon', inspectorOpen && 'is-on')} onClick={() => setInspector(!inspectorOpen)} aria-pressed={inspectorOpen} aria-label="Inspector"><Icon name="layout-split" /></button>
        </div>
      </div>

      {/* L2 · the day rail: quiet density, one continuous line of days */}
      <div className="c3-rail" role="tablist" aria-label="Days">
        {rail.map((r) => {
          const a = r.raw
          const isT = r.day === today
          return (
            <button key={r.day} type="button" role="tab" aria-selected={r.day === day}
              className={cx('c3-rail__day', isT && 'is-today', r.day === day && 'is-selected', r.day < today && 'is-past', dayNum(r.day) === 1 && 'is-month', !r.open && 'is-quiet')}
              onClick={() => pickDay(r.day)}
              aria-label={`${longDay(r.day)}: ${a ? `${r.open} open${a.attention ? `, ${a.attention} attention` : ''}` : 'not loaded'}`}>
              {dayNum(r.day) === 1 ? <span className="c3-rail__month">{monthTitle(r.day).split(' ')[0]}</span> : null}
              <small>{weekday(r.day, 'narrow')}</small>
              <b>{dayNum(r.day)}</b>
              <span className="c3-rail__bars" aria-hidden>
                <i className="c-campaign" style={{ height: `${r.ch.campaign * 100}%` }} />
                <i className="c-closing" style={{ height: `${r.ch.closing * 100}%` }} />
                <i className="c-automation" style={{ height: `${r.ch.automation * 100}%` }} />
                <i className="c-manual" style={{ height: `${r.ch.manual * 100}%` }} />
                <i className="c-attention" style={{ height: `${r.ch.attention * 100}%` }} />
              </span>
              {isT ? <span className="c3-rail__now" style={{ left: `${(localMinutes(now, tz) / 1440) * 100}%` }} aria-hidden /> : null}
            </button>
          )
        })}
        {!rail.length ? Array.from({ length: 35 }, (_, i) => <span key={i} className="c3-rail__day is-skel" aria-hidden />) : null}
      </div>

      {/* L2/L3 · the stage */}
      <div className="c3-stage">
        <main className="c3-main" aria-busy={loading}>
          {error && !data ? (
            <div className="c3-error"><b>Calendar couldn’t load</b><p>{error.replace(/_/g, ' ')}. Nothing on this screen is stale — it has not loaded.</p><button type="button" className="c3-btn is-primary" onClick={() => void load()}>Try again</button></div>
          ) : !vp ? <Skeleton /> : query.trim() ? <SearchResults {...vp} query={query} />
            : view === 'today' ? <TodayView {...vp} />
              : view === 'timeline' ? <TimelineView {...vp} />
                : view === 'week' ? <WeekView {...vp} weekFrom={weekStart(day)} />
                  : view === 'month' ? <MonthView {...vp} month={day} />
                    : view === 'attention' ? <AttentionView {...vp} />
                      : <NowView {...vp} motion={backdrop.motion} />}
          {error && data ? <p className="c3-stale">The last refresh failed ({error.replace(/_/g, ' ')}). Showing the read from {loadedAt ? clock(loadedAt, tz) : 'earlier'} — marked, not current.</p> : null}
        </main>
        {inspectorOpen ? (
          <aside className="c3-insp" aria-label="Inspector">
            {selected && data ? <Inspector e={selected} mode={mode} tz={tz} now={now} today={today} actions={actions} onClose={() => setSelectedId(null)} />
              : data ? <DayBrief data={data} day={day} tz={tz} now={now} onOpen={openId} /> : <div className="c3-insp__card is-skel" />}
          </aside>
        ) : null}
      </div>

      {/* L5 · confirmation: reschedule hands off to the owning app */}
      {confirm ? <RescheduleConfirm e={confirm} tz={tz} onCancel={() => setConfirm(null)} onGo={(path) => { setConfirm(null); pushRoutePath(path) }} /> : null}
      {pop ? <button type="button" className="c3-scrim is-clear" aria-label="Close" onClick={() => setPop(null)} /> : null}
    </div>
  )
}

function DatePop({ day, today, onPick }: { day: string; today: string; onPick: (d: string) => void }) {
  const [month, setMonth] = useState(`${day.slice(0, 7)}-01`)
  const start = weekStart(month)
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i))
  return (
    <div className="c3-pop c3-datepop" role="dialog" aria-label="Pick a date">
      <div className="c3-datepop__head">
        <button type="button" className="c3-icon" onClick={() => setMonth(`${addDays(month, -1).slice(0, 7)}-01`)} aria-label="Previous month"><Icon name="chevron-left" /></button>
        <b>{monthTitle(month)}</b>
        <button type="button" className="c3-icon" onClick={() => setMonth(`${addDays(month, 32).slice(0, 7)}-01`)} aria-label="Next month"><Icon name="chevron-right" /></button>
      </div>
      <div className="c3-datepop__grid">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => <small key={i}>{w}</small>)}
        {cells.map((d) => (
          <button key={d} type="button" className={cx(d.slice(0, 7) !== month.slice(0, 7) && 'is-out', d === today && 'is-today', d === day && 'is-on')} onClick={() => onPick(d)}>{dayNum(d)}</button>
        ))}
      </div>
      <button type="button" className="c3-btn" onClick={() => onPick(today)}>Jump to today</button>
    </div>
  )
}

const APP_NAME: Record<string, string> = { campaigns: 'Campaign Command', inbox: 'Inbox', closing: 'Closing Desk', pipeline: 'Pipeline', workflow: 'Workflow Studio', email: 'Email Command' }
function RescheduleConfirm({ e, tz, onCancel, onGo }: { e: DeskEvent; tz: string; onCancel: () => void; onGo: (path: string) => void }) {
  const app = APP_NAME[e.editable.owner_app] || e.editable.owner_app
  const path = e.deep_link?.path || '/'
  return (
    <div className="c3-confirm" role="dialog" aria-modal="true" aria-label={`Reschedule ${e.title}`}>
      <button type="button" className="c3-scrim" aria-label="Cancel" onClick={onCancel} />
      <div className="c3-confirm__card">
        <span className="c3-eyebrow">Reschedule · handled by {app}</span>
        <h3>{e.type === 'campaign_window' ? String(e.subtitle || '').split(' · ').slice(0, 2).join(' · ') : e.title}</h3>
        <p className="c3-confirm__when">Now on record: {e.all_day && e.date ? longDay(e.date) : `${longDay(dayKey(e.start, e.tz || tz))} · ${clock(e.start, e.tz || tz)} ${zoneAbbr(e.tz || tz)}`}</p>
        <p>{e.editable.how}</p>
        {e.editable.effects.length ? (
          <div className="c3-confirm__fx"><small>What changes downstream</small><ul>{e.editable.effects.map((f) => <li key={f}>{f}</li>)}</ul></div>
        ) : null}
        <p className="c3-confirm__note">The calendar never writes. {app} makes the change through its own canonical route, keeps the audit trail, and this calendar re-projects it.</p>
        <div className="c3-confirm__acts">
          <button type="button" className="c3-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="c3-btn is-primary" onClick={() => onGo(path)}><Icon name="arrow-up-right" />Open {app} to reschedule</button>
        </div>
      </div>
    </div>
  )
}

function Skeleton() {
  return (
    <div className="c3-skel" aria-hidden>
      <i className="is-head" /><i /><i /><i className="is-short" /><i /><i className="is-short" />
    </div>
  )
}
