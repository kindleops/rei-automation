import { useCallback, useEffect, useState } from 'react'
import { LCButton, LCError, LCFacts, LCIconButton, LCSheet, LCSkeleton, LCStatus } from '../../../shared/lc'
import {
  SchedulingError, SYNC_WORD, apptClock, apptDay, brandLabel, durationLabel, fetchAppointment, fetchTeam, isLive, rescheduleAppointment, schedulingErrorText, statusWord, zoneShort,
  type Appointment, type AppointmentHistory, type TeamMember,
} from '../../../domain/scheduling/scheduling-api'
import { AppointmentActions } from './AppointmentActions'
import './scheduling.css'

/**
 * APPOINTMENT DETAIL — opened from a row or from the timeline's deep link
 * (/calendar?appointment=<id>). The one place the customer's phone number is
 * shown: ops needs it to place the call. The history is the server's log,
 * verbatim and in order.
 */

const pad = (n: number) => String(n).padStart(2, '0')
/** an instant as a datetime-local value in the browser's own zone */
const localInput = (at: string) => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` }
const slotStart = (s: unknown) => (typeof s === 'string' ? s : s && typeof s === 'object' && 'start_at' in s ? String((s as { start_at: unknown }).start_at) : null)
const detailText = (d: unknown) => (d === null || d === undefined || d === '' ? null : typeof d === 'string' ? d : Object.entries(d as Record<string, unknown>).filter(([, v]) => v !== null && v !== '' && typeof v !== 'object').map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ') || null)

export function AppointmentDrawer({ id, tz, onClose, onChanged }: { id: string; tz: string; onClose: () => void; onChanged?: () => void }) {
  const [data, setData] = useState<{ id: string; appointment: Appointment; history: AppointmentHistory[] } | null>(null)
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null)
  const [team, setTeam] = useState<TeamMember[]>([])
  const [tick, setTick] = useState(0)
  const [moveTo, setMoveTo] = useState('')
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<{ text: string; slots: string[] } | null>(null)

  useEffect(() => {
    const ctl = new AbortController()
    fetchAppointment(id, ctl.signal).then((d) => { setData({ id, appointment: d.appointment, history: d.history }); setFailure(null) })
      .catch((e: unknown) => { if (!ctl.signal.aborted) setFailure({ id, message: schedulingErrorText(e) }) })
    return () => ctl.abort()
  }, [id, tick])
  useEffect(() => {
    const ctl = new AbortController()
    fetchTeam(ctl.signal).then((d) => setTeam(d.team)).catch(() => { /* assign shows its own empty state */ })
    return () => ctl.abort()
  }, [])

  const changed = useCallback(() => { setTick((t) => t + 1); onChanged?.() }, [onChanged])
  const a = data?.id === id ? data.appointment : null
  const error = failure?.id === id ? failure.message : null
  const customerTz = a?.customer_timezone && a.customer_timezone !== tz ? a.customer_timezone : null

  const move = async (startIso: string) => {
    if (!a) return
    setMoving(true)
    setMoveError(null)
    try {
      await rescheduleAppointment(a.id, startIso)
      setMoveTo('')
      changed()
    } catch (e) {
      const slots = e instanceof SchedulingError && e.slots ? e.slots.map(slotStart).filter((s): s is string => Boolean(s)).slice(0, 4) : []
      setMoveError({ text: schedulingErrorText(e), slots })
    } finally { setMoving(false) }
  }

  return (
    <LCSheet open onOpenChange={(o) => { if (!o) onClose() }} side="right" width={440} title={a ? `${a.type.name} — appointment` : 'Appointment'} className="sch sch-drawer">
      <header className="sch-drawer__head">
        <div>
          <span className="sch-eyebrow">{a ? <>{a.type.name}<em>{brandLabel(a.brand)}</em></> : 'Appointment'}</span>
          <h2 className="sch-title">{a ? a.customer.name || 'Customer not named' : 'Loading…'}</h2>
        </div>
        <LCIconButton icon="close" label="Close appointment" size="sm" onClick={onClose} />
      </header>
      <div className="sch-drawer__body lc-scroll">
        {error && !a ? <LCError compact what="This appointment didn't load" detail={error} onRetry={() => setTick((t) => t + 1)} />
          : !a ? <LCSkeleton shape="lines" count={6} label="Loading appointment" />
            : (
              <>
                <section className="sch-sec">
                  <p className="sch-when"><b>{apptDay(a.start_at, tz)} · {apptClock(a.start_at, tz)} – {apptClock(a.end_at, tz)} {zoneShort(a.start_at, tz)}</b>
                    {customerTz ? <span>{apptClock(a.start_at, customerTz)} {zoneShort(a.start_at, customerTz)} for the customer</span> : null}
                  </p>
                  <div className="sch-badges">
                    <LCStatus label={statusWord(a.status)} tone={a.status === 'completed' || a.status === 'confirmed' ? 'ok' : a.status === 'cancelled' || a.status === 'no_show' ? 'neutral' : 'exec'} />
                    <span className={a.sync_status === 'failed' || a.sync_status === 'drift' ? 'sch-sync is-bad' : 'sch-sync'} title={a.sync_error || undefined}>{SYNC_WORD[a.sync_status]}</span>
                  </div>
                </section>
                <section className="sch-sec">
                  <span className="sch-eyebrow">Customer</span>
                  <LCFacts rows={[
                    { label: 'Name', value: a.customer.name },
                    { label: 'Phone', value: a.customer.phone ? <span className="sch-phone">{a.customer.phone}</span> : null },
                    { label: 'Email', value: a.customer.email },
                    { label: 'Their zone', value: a.customer_timezone ? `${a.customer_timezone.replace(/_/g, ' ')} (${zoneShort(a.start_at, a.customer_timezone)})` : null },
                  ]} />
                </section>
                <section className="sch-sec">
                  <span className="sch-eyebrow">Context</span>
                  {a.context.summary ? <p className="sch-ctx">{a.context.summary}</p> : null}
                  {a.context.lines.length ? <ul className="sch-lines">{a.context.lines.map((l, i) => <li key={`${i}:${l}`}>{l}</li>)}</ul> : null}
                  {!a.context.summary && !a.context.lines.length ? <p className="sch-muted">No context was recorded with this booking.</p> : null}
                  <LCFacts rows={[
                    { label: 'Assigned', value: a.assigned?.name ?? <span className="is-attn">Needs assignment</span> },
                    { label: 'Duration', value: durationLabel(a.duration_minutes) },
                    { label: 'Booked from', value: a.source },
                    { label: 'Routed via', value: a.routed_via },
                    ...(a.sync_error ? [{ label: 'Sync error', value: a.sync_error }] : []),
                  ]} />
                </section>
                <section className="sch-sec">
                  <span className="sch-eyebrow">Actions</span>
                  <AppointmentActions a={a} team={team} onDone={changed} />
                  {isLive(a) ? (
                    <form className="sch-move" onSubmit={(e) => { e.preventDefault(); if (moveTo) void move(new Date(moveTo).toISOString()) }}>
                      <label className="sch-field">
                        <span>Move to (your time, {zoneShort(a.start_at, tz)})</span>
                        <input className="sch-input" type="datetime-local" value={moveTo || localInput(a.start_at)} onChange={(e) => setMoveTo(e.target.value)} />
                      </label>
                      <LCButton type="submit" variant="secondary" size="sm" icon="clock" loading={moving} disabled={!moveTo}>Reschedule</LCButton>
                    </form>
                  ) : null}
                  {moveError ? (
                    <div className="sch-error" role="alert">
                      {moveError.text}
                      {moveError.slots.length ? <span className="sch-slots">Open instead: {moveError.slots.map((s) => <button key={s} type="button" className="lc-link" onClick={() => void move(s)}>{apptDay(s, tz)} {apptClock(s, tz)}</button>)}</span> : null}
                    </div>
                  ) : null}
                </section>
                <section className="sch-sec">
                  <span className="sch-eyebrow">History</span>
                  {data?.history.length ? (
                    <ol className="sch-history">
                      {data.history.map((h, i) => (
                        <li key={`${h.created_at}:${i}`}>
                          <b>{statusWord(h.event)}</b>
                          <span>{apptDay(h.created_at, tz)} {apptClock(h.created_at, tz)}{h.actor ? ` · ${h.actor}` : ''}</span>
                          {detailText(h.detail) ? <em>{detailText(h.detail)}</em> : null}
                        </li>
                      ))}
                    </ol>
                  ) : <p className="sch-muted">Booking, assignment and outcome changes are logged here.</p>}
                </section>
              </>
            )}
      </div>
    </LCSheet>
  )
}
