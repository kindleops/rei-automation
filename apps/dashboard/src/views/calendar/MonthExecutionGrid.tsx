import { useMemo, useState } from 'react'
import type { CalendarEvent } from '../../lib/data/calendarData'
import { buildMonthGrid, eventDayKey, weekdayHeaders, type WeekStart } from '../../lib/calendar/calendar-date-engine'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type MonthExecutionGridProps = {
  anchorDate: Date
  events: CalendarEvent[]
  selectedEventId: string | null
  onSelect: (event: CalendarEvent) => void
  onReschedule?: (event: CalendarEvent, dayIso: string) => void
  weekStart?: WeekStart
}

export function MonthExecutionGrid({
  anchorDate,
  events,
  selectedEventId,
  onSelect,
  onReschedule,
  weekStart = 0,
}: MonthExecutionGridProps) {
  const [expandedDay, setExpandedDay] = useState<string | null>(null)
  const grid = useMemo(() => buildMonthGrid(anchorDate, { weekStart, selected: anchorDate }), [anchorDate, weekStart])
  const headers = weekdayHeaders(weekStart)

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const event of events) {
      const key = eventDayKey(event.timestamp)
      const list = map.get(key) || []
      list.push(event)
      map.set(key, list)
    }
    return map
  }, [events])

  return (
    <section className="nx-cal__surface nx-cal__month">
      <div className="nx-cal__section-head">
        <div>
          <span className="nx-cal__eyebrow">Month View</span>
          <strong>{anchorDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong>
        </div>
        <div className="nx-cal__month-legend">
          <span className="is-blue">SMS</span>
          <span className="is-cyan">Reply</span>
          <span className="is-purple">Offer</span>
          <span className="is-gold">Closing</span>
          <span className="is-red">Risk</span>
        </div>
      </div>

      <div className="nx-cal__month-weekdays">
        {headers.map((label) => <span key={label}>{label}</span>)}
      </div>

      <div className="nx-cal__month-grid is-true-month">
        {grid.map((cell) => {
          const dayEvents = eventsByDay.get(cell.iso) || []
          const overflow = Math.max(0, dayEvents.length - 3)
          return (
            <div
              key={cell.iso}
              className={cls(
                'nx-cal__month-cell',
                !cell.inMonth && 'is-outside',
                cell.isToday && 'is-today',
                cell.isSelected && 'is-selected',
              )}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                const draggedId = (window as unknown as { __nxCalDragId?: string }).__nxCalDragId
                const event = dayEvents.find((e) => e.id === draggedId) || events.find((e) => e.id === draggedId)
                if (event?.reschedulable) onReschedule?.(event, cell.iso)
              }}
            >
              <div className="nx-cal__month-head">
                <strong>{cell.date.getDate()}</strong>
              </div>
              <div className="nx-cal__month-body">
                {dayEvents.length === 0 ? (
                  <span className="nx-cal__month-empty">—</span>
                ) : (
                  <>
                    {dayEvents.slice(0, 3).map((event) => (
                      <button
                        key={event.id}
                        type="button"
                        draggable={Boolean(event.reschedulable)}
                        onDragStart={() => { (window as unknown as { __nxCalDragId?: string }).__nxCalDragId = event.id }}
                        className={cls('nx-cal__month-event', `is-${event.tone}`, selectedEventId === event.id && 'is-selected', !event.reschedulable && 'is-locked')}
                        onClick={() => onSelect(event)}
                      >
                        <span>{new Date(event.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                        <strong>{event.title}</strong>
                      </button>
                    ))}
                    {overflow > 0 ? (
                      <button type="button" className="nx-cal__month-more" onClick={() => setExpandedDay(cell.iso)}>
                        +{overflow} more
                      </button>
                    ) : null}
                  </>
                )}
              </div>
              {expandedDay === cell.iso ? (
                <div className="nx-cal__month-agenda-pop">
                  {dayEvents.map((event) => (
                    <button key={event.id} type="button" className="nx-cal__month-event" onClick={() => onSelect(event)}>
                      {event.title}
                    </button>
                  ))}
                  <button type="button" onClick={() => setExpandedDay(null)}>Close</button>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}