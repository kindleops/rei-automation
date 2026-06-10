import type { CalendarEvent } from '../../lib/data/calendarData'
import { CalendarEmptyState } from './CalendarEmptyState'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type DailyExecutionScheduleProps = {
  events: CalendarEvent[]
  selectedEventId: string | null
  onSelect: (event: CalendarEvent) => void
}

export function DailyExecutionSchedule({
  events,
  selectedEventId,
  onSelect,
}: DailyExecutionScheduleProps) {
  const hours = Array.from({ length: 13 }, (_, index) => index + 8)

  return (
    <section className="nx-cal__surface">
      <div className="nx-cal__section-head">
        <div>
          <span className="nx-cal__eyebrow">Daily View</span>
          <strong>Hourly execution schedule</strong>
        </div>
        <span>{events.length} items</span>
      </div>

      <div className="nx-cal__day-schedule">
        {hours.map((hour) => {
          const hourEvents = events.filter((event) => new Date(event.timestamp).getHours() === hour)
          return (
            <div key={hour} className="nx-cal__day-row">
              <div className="nx-cal__day-hour">{hour % 12 || 12}{hour >= 12 ? 'PM' : 'AM'}</div>
              <div className="nx-cal__day-lane">
                {hourEvents.length === 0 ? (
                  <span className="nx-cal__day-empty">No scheduled events</span>
                ) : hourEvents.map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    className={cls('nx-cal__day-bar', `is-${event.tone}`, selectedEventId === event.id && 'is-selected')}
                    onClick={() => onSelect(event)}
                  >
                    <strong>{event.title}</strong>
                    <span>{event.sellerName}</span>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
        {events.length === 0 ? (
          <CalendarEmptyState
            title="No execution events scheduled for today."
            description="Today’s schedule will populate from sends, replies, offers, contracts, and closing milestones."
            compact
          />
        ) : null}
      </div>
    </section>
  )
}
