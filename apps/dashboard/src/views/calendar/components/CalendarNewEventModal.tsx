import { useState } from 'react'
import { createManualCalendarEvent } from '../../../lib/calendar/calendar-api'

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
  { value: 'manual_task', label: 'Task' },
  { value: 'manual_call', label: 'Call' },
  { value: 'manual_meeting', label: 'Meeting' },
  { value: 'manual_visit', label: 'Property Visit' },
  { value: 'manual_reminder', label: 'Reminder' },
  { value: 'seller_follow_up', label: 'Follow-Up' },
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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) return null

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

  return (
    <div className="nx-cal__modal-backdrop" role="presentation" onClick={onClose}>
      <div className="nx-cal__modal" role="dialog" aria-label="New event" onClick={(e) => e.stopPropagation()}>
        <div className="nx-cal__modal-head">
          <strong>New Event</strong>
          <button type="button" className="nx-cal__icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="nx-cal__modal-body">
          <label>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            Type
            <select value={eventType} onChange={(e) => setEventType(e.target.value)}>
              {EVENT_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
            </select>
          </label>
          <label>
            Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
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
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </label>
          {error ? <p className="nx-cal__modal-error">{error}</p> : null}
        </div>
        <div className="nx-cal__modal-actions">
          <button type="button" className="nx-cal__nav-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="nx-cal__nav-btn is-active" disabled={saving || !date} onClick={handleSubmit}>
            {saving ? 'Saving…' : 'Create Event'}
          </button>
        </div>
      </div>
    </div>
  )
}