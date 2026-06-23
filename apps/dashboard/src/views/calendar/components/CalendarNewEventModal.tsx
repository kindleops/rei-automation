import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createManualCalendarEvent, deleteManualCalendarEvent, updateManualCalendarEvent } from '../../../lib/calendar/calendar-api'
import type { CalendarEvent } from '../../../lib/data/calendarData'
import { Icon } from '../../../shared/icons'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type CalendarNewEventModalProps = {
  open: boolean
  defaultDate?: string
  sellerId?: string | null
  propertyId?: string | null
  threadId?: string | null
  editEvent?: CalendarEvent | null
  entityLabel?: string
  onClose: () => void
  onCreated: () => void
}

export function CalendarNewEventModal({
  open,
  defaultDate,
  sellerId,
  propertyId,
  threadId,
  editEvent = null,
  entityLabel,
  onClose,
  onCreated,
}: CalendarNewEventModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [title, setTitle] = useState('')
  const [eventType, setEventType] = useState<'manual_task' | 'manual_reminder'>('manual_task')
  const [date, setDate] = useState(defaultDate || '')
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('10:00')
  const [description, setDescription] = useState('')
  const [allDay, setAllDay] = useState(false)
  const [priority, setPriority] = useState('normal')
  const [reminderMinutes, setReminderMinutes] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const isEdit = Boolean(editEvent?.editable && editEvent.sourceDomain === 'manual')

  useEffect(() => {
    if (!open) return
    setSuccess(false)
    setError(null)
    if (editEvent && isEdit) {
      setTitle(editEvent.title)
      setEventType(editEvent.type === 'manual_reminder' ? 'manual_reminder' : 'manual_task')
      const ts = new Date(editEvent.timestamp)
      setDate(ts.toISOString().slice(0, 10))
      setStartTime(ts.toISOString().slice(11, 16))
      setEndTime(editEvent.endTimestamp ? new Date(editEvent.endTimestamp).toISOString().slice(11, 16) : '10:00')
      setDescription(editEvent.description || '')
      setAllDay(Boolean(editEvent.allDay))
      setPriority(editEvent.priority || 'normal')
    } else {
      setTitle('')
      setEventType('manual_task')
      setDate(defaultDate || '')
      setStartTime('09:00')
      setEndTime('10:00')
      setDescription('')
      setAllDay(false)
      setPriority('normal')
      setReminderMinutes('')
    }
  }, [open, editEvent, isEdit, defaultDate])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    dialogRef.current?.querySelector<HTMLElement>('input, button, select, textarea')?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  const valid = Boolean(date && (allDay || (startTime && endTime)))

  const handleSubmit = async () => {
    if (!valid) return
    setSaving(true)
    setError(null)
    try {
      const startAt = allDay ? `${date}T00:00:00.000Z` : `${date}T${startTime}:00.000Z`
      const endAt = allDay ? `${date}T23:59:59.000Z` : `${date}T${endTime}:00.000Z`
      const payload = {
        title: title || (eventType === 'manual_reminder' ? 'Reminder' : 'Task'),
        event_type: eventType,
        start_at: startAt,
        end_at: endAt,
        all_day: allDay,
        description,
        priority,
        reminder_minutes: reminderMinutes ? Number(reminderMinutes) : null,
        master_owner_id: sellerId,
        property_id: propertyId,
        thread_key: threadId,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }
      if (isEdit && editEvent?.sourceRecordId) {
        await updateManualCalendarEvent({ id: editEvent.sourceRecordId, ...payload })
      } else {
        await createManualCalendarEvent(payload)
      }
      setSuccess(true)
      onCreated()
      window.setTimeout(onClose, 400)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!isEdit || !editEvent?.sourceRecordId) return
    setDeleting(true)
    setError(null)
    try {
      await deleteManualCalendarEvent({ id: editEvent.sourceRecordId })
      onCreated()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    } finally {
      setDeleting(false)
    }
  }

  return createPortal(
    <div className="nx-cal__modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="nx-cal__modal nx-cal__modal--premium"
        role="dialog"
        aria-label={isEdit ? 'Edit task or reminder' : 'Add task or reminder'}
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="nx-cal__modal-head">
          <div className="nx-cal__modal-head-copy">
            <div>
              <strong>{isEdit ? 'Edit Task or Reminder' : 'Add Task or Reminder'}</strong>
              <span>{entityLabel || (sellerId ? 'Linked to selected entity' : 'Global operator item')}</span>
            </div>
          </div>
          <button type="button" className="nx-cal__icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        {!isEdit ? (
          <div className="nx-cal__modal-type-segment">
            <button type="button" className={cls('nx-cal__modal-segment', eventType === 'manual_task' && 'is-active')} onClick={() => setEventType('manual_task')}>Task</button>
            <button type="button" className={cls('nx-cal__modal-segment', eventType === 'manual_reminder' && 'is-active')} onClick={() => setEventType('manual_reminder')}>Reminder</button>
          </div>
        ) : null}

        <div className="nx-cal__modal-body">
          <label>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={eventType === 'manual_reminder' ? 'Reminder title' : 'Task title'} />
          </label>
          <div className="nx-cal__modal-row">
            <label>
              Date
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label>
              Priority
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
          </div>
          <label className="nx-cal__modal-check">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
            All day
          </label>
          {!allDay ? (
            <div className="nx-cal__modal-row">
              <label>Start <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></label>
              <label>End <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></label>
            </div>
          ) : null}
          {eventType === 'manual_reminder' ? (
            <label>
              Remind (minutes before)
              <input type="number" min="0" value={reminderMinutes} onChange={(e) => setReminderMinutes(e.target.value)} placeholder="Optional" />
            </label>
          ) : null}
          <label>
            Description
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Optional notes" />
          </label>
          {error ? <p className="nx-cal__modal-error">{error}</p> : null}
          {success ? <p className="nx-cal__modal-success">Saved</p> : null}
        </div>

        <div className="nx-cal__modal-actions">
          {isEdit ? (
            <button type="button" className="nx-cal__cmd-btn is-danger" disabled={deleting} onClick={handleDelete}>
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          ) : null}
          <button type="button" className="nx-cal__cmd-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="nx-cal__cmd-btn nx-cal__cmd-btn--accent" disabled={saving || !valid} onClick={handleSubmit}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}