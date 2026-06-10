import type { CalendarEvent } from '../../lib/data/calendarData'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type WeeklyExecutionGridProps = {
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

export function WeeklyExecutionGrid({
  anchorDate,
  events,
  selectedEventId,
  onSelect,
}: WeeklyExecutionGridProps) {
  const days = Array.from({ length: 7 }, (_, index) => addDays(anchorDate, index))

  return (
    <section className="nx-cal__surface">
      <div className="nx-cal__section-head">
        <div>
          <span className="nx-cal__eyebrow">Weekly View</span>
          <strong>Weekly execution grid</strong>
        </div>
        <span>{events.length} scheduled items</span>
      </div>

      <div className="nx-cal__week-grid">
        {days.map((day) => {
          const dayKey = toIsoDate(day)
          const dayEvents = events.filter((event) => toDateKey(event.timestamp) === dayKey)
          const replies = dayEvents.filter((event) => event.type.includes('reply')).length
          const offers = dayEvents.filter((event) => event.type.includes('offer')).length
          const risks = dayEvents.filter((event) => event.overdue || event.tone === 'red' || event.tone === 'amber').length

          return (
            <article key={dayKey} className="nx-cal__week-day">
              <div className="nx-cal__week-head">
                <div>
                  <strong>{day.toLocaleDateString(undefined, { weekday: 'short' })}</strong>
                  <span>{day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                </div>
                <div className="nx-cal__week-badges">
                  {replies ? <span>{replies} replies</span> : null}
                  {offers ? <span>{offers} offers</span> : null}
                  {risks ? <span>{risks} risk</span> : null}
                </div>
              </div>

              <div className="nx-cal__week-events">
                {dayEvents.length === 0 ? (
                  <span className="nx-cal__week-empty">No scheduled events</span>
                ) : dayEvents.slice(0, 7).map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    className={cls('nx-cal__week-chip', `is-${event.tone}`, selectedEventId === event.id && 'is-selected')}
                    onClick={() => onSelect(event)}
                  >
                    <strong>{new Date(event.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</strong>
                    <span>{event.title}</span>
                    <small>{event.sellerName}</small>
                  </button>
                ))}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
