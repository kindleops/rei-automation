import { useState } from 'react'
import { LCButton, LCDialog, LCSelect } from '../../../shared/lc'
import {
  assignAppointment, cancelAppointment, isLive, recordOutcome, resyncAppointment, schedulingErrorText,
  type Appointment, type AppointmentOutcome, type TeamMember,
} from '../../../domain/scheduling/scheduling-api'

/**
 * The row and the drawer share one set of appointment actions. Each button is
 * one canonical server write; on success the caller re-reads, so nothing here
 * patches an appointment locally. Cancel asks for a reason and Assign for a
 * person — both in a dialog; the outcomes are one click.
 */

export function AppointmentActions({ a, team, size = 'sm', onDone }: { a: Appointment; team: TeamMember[]; size?: 'sm' | 'md'; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'cancel' | 'assign' | null>(null)
  const [reason, setReason] = useState('')
  const [person, setPerson] = useState<string>(a.assigned?.id ?? '')
  const live = isLive(a)
  const resync = a.sync_status === 'drift' || a.sync_status === 'failed'
  const people = team.filter((m) => m.active)

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try { await fn(); setDialog(null); onDone() } catch (e) { setError(schedulingErrorText(e)) } finally { setBusy(null) }
  }
  const outcome = (o: AppointmentOutcome) => run(o, () => recordOutcome(a.id, o))

  if (!live && !resync) return null
  return (
    <div className="sch-actions" role="group" aria-label="Appointment actions">
      {live && a.status !== 'confirmed' ? <LCButton variant="quiet" size={size} icon="check" loading={busy === 'confirmed'} disabled={Boolean(busy)} onClick={() => void outcome('confirmed')}>Confirm</LCButton> : null}
      {live ? <LCButton variant="quiet" size={size} icon="check-double" loading={busy === 'completed'} disabled={Boolean(busy)} onClick={() => void outcome('completed')}>Completed</LCButton> : null}
      {live ? <LCButton variant="quiet" size={size} icon="slash" loading={busy === 'no_show'} disabled={Boolean(busy)} onClick={() => void outcome('no_show')}>No-show</LCButton> : null}
      {live ? <LCButton variant={a.assigned ? 'quiet' : 'secondary'} size={size} icon="user" disabled={Boolean(busy)} onClick={() => { setPerson(a.assigned?.id ?? ''); setDialog('assign') }}>{a.assigned ? 'Reassign' : 'Assign'}</LCButton> : null}
      {resync ? <LCButton variant="secondary" size={size} icon="refresh-cw" loading={busy === 'resync'} disabled={Boolean(busy)} onClick={() => void run('resync', () => resyncAppointment(a.id))}>Re-sync</LCButton> : null}
      {live ? <LCButton variant="quiet" size={size} icon="close" disabled={Boolean(busy)} onClick={() => { setReason(''); setDialog('cancel') }}>Cancel</LCButton> : null}
      {error && !dialog ? <p className="sch-error" role="alert">{error}</p> : null}

      <LCDialog open={dialog === 'cancel'} onOpenChange={(o) => { if (!o && !busy) { setDialog(null); setError(null) } }} sticky={Boolean(reason)}
        title="Cancel this appointment?"
        description={`${a.type.name} with ${a.customer.name || 'the customer'}. The time is released and the calendar event is removed. The customer is told it was cancelled.`}
        footer={(
          <>
            <LCButton variant="quiet" disabled={Boolean(busy)} onClick={() => setDialog(null)}>Keep it</LCButton>
            <LCButton variant="danger" loading={busy === 'cancel'} disabled={!reason.trim()} onClick={() => void run('cancel', () => cancelAppointment(a.id, reason.trim()))}>Cancel appointment</LCButton>
          </>
        )}>
        <label className="sch-field">
          <span>Reason (kept in the appointment's history)</span>
          <textarea className="sch-input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required />
        </label>
        {error ? <p className="sch-error" role="alert">{error}</p> : null}
      </LCDialog>

      <LCDialog open={dialog === 'assign'} onOpenChange={(o) => { if (!o && !busy) { setDialog(null); setError(null) } }}
        title={a.assigned ? 'Reassign this appointment' : 'Assign this appointment'}
        description="The person's calendar gets the event; the time does not change."
        footer={(
          <>
            <LCButton variant="quiet" disabled={Boolean(busy)} onClick={() => setDialog(null)}>Back</LCButton>
            <LCButton variant="primary" loading={busy === 'assign'} disabled={!person || person === a.assigned?.id} onClick={() => void run('assign', () => assignAppointment(a.id, person))}>Assign</LCButton>
          </>
        )}>
        {people.length ? (
          <LCSelect label="Person" variant="field" value={person || null} placeholder="Choose a person" onChange={setPerson}
            options={people.map((m) => ({ value: m.id, label: m.name, hint: m.calendar ? undefined : 'No calendar connected' }))} />
        ) : <p className="sch-muted">No active team member is set up for scheduling yet.</p>}
        {error ? <p className="sch-error" role="alert">{error}</p> : null}
      </LCDialog>
    </div>
  )
}
