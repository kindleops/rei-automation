import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Icon } from '../../../shared/icons'
import { LCButton, LCConfirm, LCError, LCSkeleton, LCStatus, cx } from '../../../shared/lc'
import {
  HEALTH_WORD, addTimeOff, apptClock, apptDay, disconnectCalendar, fetchMe, saveMe, schedulingErrorText, startCalendarConnect,
  type SchedulingMe, type TimeOffKind, type WeeklyHours,
} from '../../../domain/scheduling/scheduling-api'
import './scheduling.css'

/**
 * MY CALENDAR — the operator's own scheduling record: the Google connection
 * (its health is the server's), working hours and zone, and time off. Plain
 * and compact; every save is one POST and the card re-reads after it.
 */

const DAYS = [['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['7', 'Sunday']] as const
const RANGE = /^([01]\d|2[0-3]):[0-5]\d\s*[-–]\s*([01]\d|2[0-3]):[0-5]\d$/

/** "09:00-12:00, 13:00-17:00" ⇄ [["09:00","12:00"],["13:00","17:00"]] — every range kept, none dropped */
const hoursText = (ranges: Array<[string, string]> | undefined) => (ranges ?? []).map(([s, e]) => `${s}-${e}`).join(', ')
function parseHours(text: string): Array<[string, string]> | null {
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.some((p) => !RANGE.test(p))) return null
  const ranges = parts.map((p) => p.split(/[-–]/).map((x) => x.trim()) as [string, string])
  return ranges.every(([s, e]) => s < e) ? ranges : null
}

const NOTICE: Record<string, { tone: 'ok' | 'attn'; text: string }> = {
  connected: { tone: 'ok', text: 'Google calendar connected. Your busy times now block bookings.' },
  declined: { tone: 'attn', text: 'Google access was declined, so nothing was connected.' },
  expired: { tone: 'attn', text: 'The Google sign-in took too long. Connect again to finish.' },
  failed: { tone: 'attn', text: 'Google did not connect. Try again; if it repeats, the error is in the server log.' },
}

const zones = (() => {
  try { return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [] } catch { return [] }
})()

export function MyCalendarCard({ notice, onDismissNotice }: { notice?: string | null; onDismissNotice?: () => void }) {
  const [me, setMe] = useState<SchedulingMe | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmOff, setConfirmOff] = useState(false)

  useEffect(() => {
    const ctl = new AbortController()
    fetchMe(ctl.signal).then((d) => { setMe({ user_id: d.user_id, resource: d.resource, calendar: d.calendar }); setError(null) })
      .catch((e: unknown) => { if (!ctl.signal.aborted) setError(schedulingErrorText(e)) })
    return () => ctl.abort()
  }, [tick])

  const connect = async () => {
    setBusy('connect')
    setActionError(null)
    try { const { url } = await startCalendarConnect(); window.location.assign(url) } catch (e) { setActionError(schedulingErrorText(e)); setBusy(null) }
  }

  const cal = me?.calendar ?? null
  const health = cal?.health ?? 'disconnected'
  const connected = Boolean(cal) && health !== 'disconnected'
  const reconnect = health === 'needs_reauth' || health === 'error'
  const n = notice ? NOTICE[notice] ?? NOTICE.failed : null

  return (
    <section className="sch sch-card" aria-label="My calendar">
      <header className="sch-card__head">
        <h2 className="sch-title"><Icon name="calendar" size={13} /> My calendar</h2>
        {me ? <LCStatus label={HEALTH_WORD[health]} tone={health === 'healthy' ? 'ok' : health === 'stale' || health === 'needs_reauth' ? 'attn' : health === 'error' ? 'crit' : 'neutral'} /> : null}
      </header>
      {n ? (
        <p className={cx('sch-notice', `is-${n.tone}`)} role="status">
          {n.text}
          {onDismissNotice ? <button type="button" className="lc-link" onClick={onDismissNotice}>Dismiss</button> : null}
        </p>
      ) : null}
      {error && !me ? <LCError compact what="Your calendar settings didn't load" detail={error} onRetry={() => setTick((t) => t + 1)} />
        : !me ? <LCSkeleton shape="lines" count={4} label="Loading your calendar" />
          : (
            <>
              <div className="sch-card__conn">
                <p className="sch-muted">
                  {connected && cal?.account_email ? <>Google · <b>{cal.account_email}</b></> : 'No Google calendar is connected. Bookings cannot see when you are busy.'}
                  {connected && cal?.busy_synced_at ? <> · busy times read {apptDay(cal.busy_synced_at, Intl.DateTimeFormat().resolvedOptions().timeZone)} {apptClock(cal.busy_synced_at, Intl.DateTimeFormat().resolvedOptions().timeZone)}</> : null}
                  {cal?.last_error_code && health !== 'healthy' ? <> · last error <code>{cal.last_error_code}</code></> : null}
                </p>
                <div className="sch-actions">
                  {!connected ? <LCButton variant="primary" size="sm" icon="link" loading={busy === 'connect'} onClick={() => void connect()}>Connect Google calendar</LCButton> : null}
                  {connected && reconnect ? <LCButton variant="primary" size="sm" icon="refresh-cw" loading={busy === 'connect'} onClick={() => void connect()}>Reconnect</LCButton> : null}
                  {connected ? <LCButton variant="quiet" size="sm" icon="close" disabled={Boolean(busy)} onClick={() => setConfirmOff(true)}>Disconnect</LCButton> : null}
                </div>
                {actionError ? <p className="sch-error" role="alert">{actionError}</p> : null}
              </div>
              {me.resource
                ? <HoursForm key={me.resource.id} me={me} onSaved={() => setTick((t) => t + 1)} />
                : <p className="sch-muted">You are not bookable yet. A scheduling admin adds you to the team; your hours and calendar then appear here.</p>}
              <TimeOffForm />
            </>
          )}
      <LCConfirm open={confirmOff} onOpenChange={setConfirmOff} tone="danger" title="Disconnect your Google calendar?"
        confirmLabel="Disconnect" cancelLabel="Keep it connected"
        effects={[
          { text: 'New bookings stop seeing your Google busy times', kind: 'stops' },
          { text: 'Appointments already booked stay booked', kind: 'keeps' },
          { text: 'You can connect again at any time', kind: 'note' },
        ]}
        onConfirm={async () => { try { await disconnectCalendar() } catch (e) { throw new Error(schedulingErrorText(e)) } setTick((t) => t + 1) }} />
    </section>
  )
}

function HoursForm({ me, onSaved }: { me: SchedulingMe; onSaved: () => void }) {
  const r = me.resource
  const initial = useMemo(() => ({
    tz: r?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    days: Object.fromEntries(DAYS.map(([k]) => [k, hoursText(r?.weekly_hours?.[k])])) as Record<string, string>,
  }), [r])
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const bad = DAYS.filter(([k]) => form.days[k].trim() && !parseHours(form.days[k])).map(([, d]) => d)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (bad.length) return
    const weekly: WeeklyHours = {}
    for (const [k] of DAYS) { const v = parseHours(form.days[k]); if (v?.length) weekly[k] = v }
    setSaving(true)
    setMsg(null)
    try {
      await saveMe({ timezone: form.tz.trim(), weekly_hours: weekly })
      setMsg({ ok: true, text: 'Saved. New bookings use these hours.' })
      onSaved()
    } catch (err) { setMsg({ ok: false, text: schedulingErrorText(err) }) } finally { setSaving(false) }
  }

  return (
    <form className="sch-form" onSubmit={(e) => void submit(e)} aria-label="Working hours">
      <span className="sch-eyebrow">Working hours</span>
      {r ? (
        <dl className="sch-grid2" aria-label="Set by a scheduling admin">
          <div className="sch-field"><dt>Name (team)</dt><dd>{r.display_name}</dd></div>
          <div className="sch-field"><dt>Name customers see</dt><dd>{r.public_name || 'Not shown to customers'}</dd></div>
        </dl>
      ) : null}
      <label className="sch-field">
        <span>Time zone</span>
        <input className="sch-input" list="sch-zones" value={form.tz} onChange={(e) => setForm({ ...form, tz: e.target.value })} required spellCheck={false} />
        {zones.length ? <datalist id="sch-zones">{zones.map((z) => <option key={z} value={z} />)}</datalist> : null}
      </label>
      <fieldset className="sch-days">
        <legend className="sch-muted">24-hour ranges, comma-separated (09:00-12:00, 13:00-17:00). Empty means off.</legend>
        {DAYS.map(([k, d]) => (
          <label key={k} className={cx('sch-day', form.days[k].trim() && !parseHours(form.days[k]) && 'is-bad')}>
            <span>{d}</span>
            <input className="sch-input" value={form.days[k]} placeholder="Off" onChange={(e) => setForm({ ...form, days: { ...form.days, [k]: e.target.value } })} aria-invalid={Boolean(form.days[k].trim() && !parseHours(form.days[k]))} />
          </label>
        ))}
      </fieldset>
      {bad.length ? <p className="sch-error" role="alert">Check the hours for {bad.join(', ')}.</p> : null}
      {msg ? <p className={msg.ok ? 'sch-ok' : 'sch-error'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p> : null}
      <div className="sch-actions">
        <LCButton type="submit" variant="secondary" size="sm" loading={saving} disabled={Boolean(bad.length) || !form.tz.trim()}>Save hours</LCButton>
        <LCButton type="button" variant="quiet" size="sm" disabled={saving} onClick={() => { setForm(initial); setMsg(null) }}>Reset</LCButton>
      </div>
    </form>
  )
}

function TimeOffForm() {
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [kind, setKind] = useState<TimeOffKind>('pto')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const invalid = !start || !end || new Date(end) <= new Date(start)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (invalid) return
    setSaving(true)
    setMsg(null)
    try {
      await addTimeOff({ start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString(), kind, note: note.trim() })
      setMsg({ ok: true, text: 'Time off added. No one can book you in it.' })
      setStart(''); setEnd(''); setNote('')
    } catch (err) { setMsg({ ok: false, text: schedulingErrorText(err) }) } finally { setSaving(false) }
  }

  return (
    <form className="sch-form" onSubmit={(e) => void submit(e)} aria-label="Add time off">
      <span className="sch-eyebrow">Add time off</span>
      <div className="sch-grid2">
        <label className="sch-field"><span>From</span><input className="sch-input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required /></label>
        <label className="sch-field"><span>Until</span><input className="sch-input" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required /></label>
      </div>
      <div className="sch-grid2">
        <label className="sch-field">
          <span>Kind</span>
          <select className="sch-input" value={kind} onChange={(e) => setKind(e.target.value as TimeOffKind)}>
            <option value="pto">Time off</option>
            <option value="holiday">Holiday</option>
            <option value="block">Blocked time</option>
          </select>
        </label>
        <label className="sch-field"><span>Note</span><input className="sch-input" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      {start && end && invalid ? <p className="sch-error" role="alert">The end must be after the start.</p> : null}
      {msg ? <p className={msg.ok ? 'sch-ok' : 'sch-error'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p> : null}
      <div className="sch-actions"><LCButton type="submit" variant="secondary" size="sm" loading={saving} disabled={invalid}>Add time off</LCButton></div>
    </form>
  )
}
