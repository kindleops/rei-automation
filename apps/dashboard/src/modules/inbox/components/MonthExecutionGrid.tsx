import type { CalendarEvent } from '../../../lib/data/calendarData'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type MonthExecutionGridProps = {
  anchorDate: Date
  events: CalendarEvent[]
  selectedEventId: string | null
  onSelect: (event: CalendarEvent) => void
}

const toStartOfDay = (value: Date) => {
  const next = new Date(value)
  next.setHours(0, 0, 0, 0)
  return next
}

const toIsoDate = (value: Date) => {
  const year = value.getFullYear()
  const month = `${value.getMonth() + 1}`.padStart(2, '0')
  const day = `${value.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

const toDateKey = (value: string) => toIsoDate(toStartOfDay(new Date(value)))

const addDays = (value: Date, amount: number) => {
  const next = new Date(value)
  next.setDate(next.getDate() + amount)
  return next
}

export function MonthExecutionGrid({
  anchorDate,
  events,
  selectedEventId,
  onSelect,
}: MonthExecutionGridProps) {
  const days = Array.from({ length: 30 }, (_, index) => addDays(anchorDate, index))

  return (
    <section className="nx-cal__surface">
      <div className="nx-cal__section-head">
        <div>
          <span className="nx-cal__eyebrow">30-Day View</span>
          <strong>Upcoming execution window</strong>
        </div>
        <div className="nx-cal__month-legend">
          <span className="is-blue">SMS</span>
          <span className="is-cyan">Reply</span>
          <span className="is-purple">Offer</span>
          <span className="is-gold">Closing</span>
          <span className="is-red">Risk</span>
        </div>
      </div>

      <div className="nx-cal__month-grid">
        {days.map((day) => {
          const dayKey = toIsoDate(day)
          const dayEvents = events.filter((event) => toDateKey(event.timestamp) === dayKey)
          return (
            <div key={dayKey} className="nx-cal__month-cell">
              <div className="nx-cal__month-head">
                <strong>{day.getDate()}</strong>
                <span>{day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
              </div>
              <div className="nx-cal__month-body">
                {dayEvents.length === 0 ? (
                  <span className="nx-cal__month-empty">No scheduled events</span>
                ) : (
                  <>
                    <div className="nx-cal__month-dots">
                      {dayEvents.slice(0, 8).map((event) => (
                        <button
                          key={event.id}
                          type="button"
                          className={cls('nx-cal__month-dot', `is-${event.tone}`, selectedEventId === event.id && 'is-selected')}
                          onClick={() => onSelect(event)}
                          aria-label={`${event.title} for ${event.sellerName}`}
                        />
                      ))}
                    </div>
                    <div className="nx-cal__month-summary">
                      <strong>{dayEvents.length}</strong>
                      <span>{dayEvents[0]?.title ?? 'Events'}</span>
                    </div>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
