import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { LCEmpty, LCError, LCSelect, LCSkeleton, LCStatus, LCTabs, cx } from '../../../shared/lc'
import {
  apptClock, apptDay, brandLabel, durationLabel, fetchAppointments, fetchTeam, schedulingErrorText, statusWord, zoneShort, SYNC_WORD,
  type Appointment, type AppointmentView, type TeamMember, type TeamPool,
} from '../../../domain/scheduling/scheduling-api'
import { AppointmentActions } from './AppointmentActions'
import './scheduling.css'

/**
 * APPOINTMENTS — the booked calls, as the scheduling service holds them.
 *
 * Every row is one record from /api/cockpit/scheduling/appointments; the
 * tabs are the server's views and the filters its query parameters. Times
 * read in the viewer's zone with its abbreviation. A sync badge appears only
 * when the Google side needs attention (failed, drift, not connected).
 */

const VIEWS: Array<{ id: AppointmentView; label: string; empty: string }> = [
  { id: 'today', label: 'Today', empty: 'Calls booked for today appear here, with who is taking them.' },
  { id: 'upcoming', label: 'Upcoming', empty: 'Calls booked after today appear here as sellers schedule them.' },
  { id: 'needs_assignment', label: 'Needs assignment', empty: 'Calls nobody is assigned to appear here. Every booked call has an owner right now.' },
  { id: 'completed', label: 'Completed', empty: 'Calls marked completed appear here.' },
  { id: 'cancelled', label: 'Cancelled', empty: 'Cancelled calls appear here with their reason in the history.' },
  { id: 'no_show', label: 'No-show', empty: 'Calls the customer missed appear here once marked.' },
]
const ALL = 'all'
const SYNC_ALERT = new Set(['failed', 'drift', 'not_connected'])

export function AppointmentsDesk({ tz, compact, refreshKey = 0, onOpen }: { tz: string; compact?: boolean; refreshKey?: number; onOpen: (id: string) => void }) {
  const [view, setView] = useState<AppointmentView>('today')
  const [brand, setBrand] = useState(ALL)
  const [person, setPerson] = useState(ALL)
  const [type, setType] = useState(ALL)
  const [rows, setRows] = useState<{ key: string; list: Appointment[] } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const [team, setTeam] = useState<TeamMember[]>([])
  const [pools, setPools] = useState<TeamPool[]>([])
  const [types, setTypes] = useState<Record<string, string>>({})
  const [tick, setTick] = useState(0)

  const key = `${view}:${brand}:${person}:${type}:${tz}:${refreshKey}:${tick}`
  useEffect(() => {
    const ctl = new AbortController()
    fetchAppointments({ view, tz, brand: brand === ALL ? null : brand, resourceId: person === ALL ? null : person, type: type === ALL ? null : type }, ctl.signal).then((d) => {
      setRows({ key, list: d.appointments })
      setFailure(null)
      // the type filter offers every type this desk has seen, not only the filtered page's
      setTypes((t) => { const n = { ...t }; for (const a of d.appointments) n[a.type.key] = a.type.name; return n })
    }).catch((e: unknown) => { if (!ctl.signal.aborted) setFailure({ key, message: schedulingErrorText(e) }) })
    return () => ctl.abort()
  }, [key, view, tz, brand, person, type])

  useEffect(() => {
    const ctl = new AbortController()
    fetchTeam(ctl.signal).then((d) => { setTeam(d.team); setPools(d.pools) }).catch(() => { /* filters fall back to what the rows name */ })
    return () => ctl.abort()
  }, [refreshKey])

  // a quiet re-read while visible: new bookings arrive without a reload
  useEffect(() => {
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') setTick((t) => t + 1) }, 60_000)
    return () => window.clearInterval(id)
  }, [])
  const reload = useCallback(() => setTick((t) => t + 1), [])

  const list = rows?.list ?? null
  const loading = rows?.key !== key && failure?.key !== key
  const error = failure?.key === key ? failure.message : null
  const brands = useMemo(() => [...new Set([...pools.map((p) => p.brand), ...(list ?? []).map((a) => a.brand)])].filter(Boolean).sort(), [pools, list])
  const people = useMemo(() => {
    const m = new Map(team.map((t) => [t.id, t.name]))
    for (const a of list ?? []) if (a.assigned) m.set(a.assigned.id, a.assigned.name)
    return [...m.entries()].sort((x, y) => x[1].localeCompare(y[1]))
  }, [team, list])
  const current = VIEWS.find((v) => v.id === view)!
  const filtered = brand !== ALL || person !== ALL || type !== ALL

  return (
    <section className={cx('sch', 'sch-appts', compact && 'is-compact')} aria-label="Appointments">
      <header className="sch-appts__head">
        <h2 className="sch-title">Appointments</h2>
        <LCTabs label="Appointment view" value={view} onChange={(v) => setView(v)} variant="line" className="sch-tabs"
          items={VIEWS.map((v) => ({ id: v.id, label: v.label, controls: 'sch-appts-panel', count: v.id === view && list && !loading ? list.length : null, tone: v.id === 'needs_assignment' && view === v.id && list?.length ? 'attn' as const : undefined }))} />
        <div className="sch-filters" role="group" aria-label="Appointment filters">
          <LCSelect label="Brand" prefix="Brand" variant="chip" size="sm" value={brand} onChange={setBrand}
            options={[{ value: ALL, label: 'All' }, ...brands.map((b) => ({ value: b, label: brandLabel(b) }))]} />
          <LCSelect label="Person" prefix="Person" variant="chip" size="sm" value={person} onChange={setPerson}
            options={[{ value: ALL, label: 'Everyone' }, ...people.map(([id, name]) => ({ value: id, label: name }))]} />
          <LCSelect label="Appointment type" prefix="Type" variant="chip" size="sm" value={type} onChange={setType}
            options={[{ value: ALL, label: 'All' }, ...Object.entries(types).sort((x, y) => x[1].localeCompare(y[1])).map(([k, name]) => ({ value: k, label: name }))]} />
          {filtered ? <button type="button" className="lc-link" onClick={() => { setBrand(ALL); setPerson(ALL); setType(ALL) }}>Clear filters</button> : null}
        </div>
      </header>
      <div id="sch-appts-panel" role="tabpanel" aria-label={`${current.label} appointments`} aria-busy={loading} className="sch-appts__body">
        {error && !list ? <LCError compact what="Appointments didn't load" detail={error} onRetry={reload} />
          : !list ? <LCSkeleton shape="rows" count={4} label="Loading appointments" />
            : !list.length ? <LCEmpty compact tone="calm" icon="calendar" title={filtered ? 'No appointment matches these filters' : `Nothing in ${current.label.toLowerCase()}`} body={current.empty} />
              : (
                <ul className={cx('sch-rows', loading && 'is-refreshing')}>
                  {list.map((a) => <AppointmentRow key={a.id} a={a} tz={tz} team={team} onOpen={onOpen} onDone={reload} />)}
                </ul>
              )}
        {error && list ? <p className="sch-error" role="status"><Icon name="alert" size={11} /> The last refresh failed: {error} <button type="button" className="lc-link" onClick={reload}>Retry</button></p> : null}
      </div>
    </section>
  )
}

function AppointmentRow({ a, tz, team, onOpen, onDone }: { a: Appointment; tz: string; team: TeamMember[]; onOpen: (id: string) => void; onDone: () => void }) {
  const line = a.context.lines[0]
  return (
    <li className="sch-row" data-status={a.status}>
      <button type="button" className="sch-row__main" onClick={() => onOpen(a.id)} aria-label={`${a.type.name}, ${a.customer.name || 'customer'}, ${apptDay(a.start_at, tz)} ${apptClock(a.start_at, tz)} — open details`}>
        <span className="sch-row__when">
          <b>{apptClock(a.start_at, tz)} <small>{zoneShort(a.start_at, tz)}</small></b>
          <span>{apptDay(a.start_at, tz)} · {durationLabel(a.duration_minutes)}</span>
        </span>
        <span className="sch-row__what">
          <span className="sch-eyebrow">{a.type.name}<em>{brandLabel(a.brand)}</em></span>
          <b>{a.customer.name || 'Customer not named'}</b>
          {a.context.summary || line ? <span className="sch-row__ctx">{[a.context.summary, line].filter(Boolean).join(' · ')}</span> : null}
        </span>
        <span className="sch-row__who">
          {a.assigned ? <span><Icon name="user" size={11} />{a.assigned.name}</span> : <span className="is-attn"><Icon name="alert" size={11} />Needs assignment</span>}
          <LCStatus label={statusWord(a.status)} tone={a.status === 'cancelled' || a.status === 'no_show' ? 'neutral' : a.status === 'completed' ? 'ok' : a.status === 'confirmed' ? 'ok' : 'exec'} quiet />
          {SYNC_ALERT.has(a.sync_status) ? <span className={cx('sch-sync', a.sync_status !== 'not_connected' && 'is-bad')} title={a.sync_error || undefined}>{SYNC_WORD[a.sync_status]}</span> : null}
        </span>
      </button>
      <AppointmentActions a={a} team={team} onDone={onDone} />
    </li>
  )
}
