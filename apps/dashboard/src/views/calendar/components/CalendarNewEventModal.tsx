import { useState } from 'react'
import { createPortal } from 'react-dom'
import { createManualCalendarEvent } from '../../../lib/calendar/calendar-api'
import { Icon } from '../../../shared/icons'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type CalendarNewEventModalProps = {
  open: boolean
  defaultDate?: string
  sellerId?: string | null
  propertyId?: string | null
  threadId?: string | null
  onClose: () => void
  onCreated: () => void
}

const EVENT_TYPES = [
  { value: 'seller_follow_up', label: 'Follow-Up', icon: 'send' as const },
  { value: 'manual_call', label: 'Call', icon: 'phone' as const },
  { value: 'manual_meeting', label: 'Meeting', icon: 'users' as const },
  { value: 'manual_visit', label: 'Property Visit', icon: 'home' as const },
  { value: 'manual_task', label: 'Task', icon: 'check' as const },
  { value: 'manual_reminder', label: 'Reminder', icon: 'bell' as const },
]

export function CalendarNewEventModal({
  open,
  defaultDate,
  sellerId,
  propertyId,
  threadId,
  onClose,
  onCreated,
}: CalendarNewEventModalProps) {
  const [title, setTitle] = useState('')
  const [eventType, setEventType] = useState('manual_task')
  const [date, setDate] = useState(defaultDate || '')
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('10:00')
  const [description, setDescription] = useState('')
  const [allDay, setAllDay] = useState(false)
  const [priority, setPriority] = useState('normal')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open || typeof document === 'undefined') return null

  const selectedType = EVENT_TYPES.find((t) => t.value === eventType) || EVENT_TYPES[0]

  const handleSubmit = async () => {
    setSaving(true)
    setError(null)
    try {
      const startAt = allDay ? `${date}T00:00:00.000Z` : `${date}T${startTime}:00.000Z`
      const endAt = allDay ? `${date}T23:59:59.000Z` : `${date}T${endTime}:00.000Z`
      await createManualCalendarEvent({
        title: title || 'Manual Event',
        event_type: eventType,
        start_at: startAt,
        end_at: endAt,
        all_day: allDay,
        description,
        master_owner_id: sellerId,
        property_id: propertyId,
        thread_key: threadId,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      onCreated()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create event')
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className="nx-cal__modal-backdrop" role="presentation" onClick={onClose}>
      <div className="nx-cal__modal nx-cal__modal--premium" role="dialog" aria-label="New event" onClick={(e) => e.stopPropagation()}>
        <div className="nx-cal__modal-head">
          <div className="nx-cal__modal-head-copy">
            <span className="nx-cal__modal-icon" aria-hidden="true"><Icon name="spark" /></span>
            <div>
              <strong>New Event</strong>
              <span>{sellerId ? 'Scoped to selected seller' : 'Global calendar event'}</span>
            </div>
          </div>
          <button type="button" className="nx-cal__icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        <div className="nx-cal__modal-type-grid">
          {EVENT_TYPES.map((type) => (
            <button
              key={type.value}
              type="button"
              className={cls('nx-cal__modal-type-card', eventType === type.value && 'is-active')}
              onClick={() => setEventType(type.value)}
            >
              <Icon name={type.icon} />
              <span>{type.label}</span>
            </button>
          ))}
        </div>

        <div className="nx-cal__modal-body">
          <label>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event title" />
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
          <label>
            Description
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Optional notes" />
          </label>
          {error ? <p className="nx-cal__modal-error">{error}</p> : null}
        </div>

        <div className="nx-cal__modal-preview">
          <span className="nx-cal__eyebrow">Preview</span>
          <div className="nx-cal__modal-preview-card">
            <Icon name={selectedType.icon} />
            <div>
              <strong>{title || selectedType.label}</strong>
              <span>{date || '—'} · {allDay ? 'All day' : `${startTime} – ${endTime}`}</span>
            </div>
          </div>
        </div>

        <div className="nx-cal__modal-actions">
          <button type="button" className="nx-cal__cmd-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="nx-cal__cmd-btn nx-cal__cmd-btn--accent" disabled={saving || !date} onClick={handleSubmit}>
            {saving ? 'Saving…' : 'Create Event'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}