import { useMemo, useState } from 'react'
import type { CalendarEvent } from '../../lib/data/calendarData'
import { CATEGORY_META, categoryIcon, summarizeDayCategories } from '../../lib/calendar/calendar-event-categories'
import { formatEntitySubtitle } from '../../lib/calendar/calendar-entity-display'
import { buildMonthGrid, eventDayKey, weekdayHeaders, type WeekStart } from '../../lib/calendar/calendar-date-engine'
import { Icon } from '../../shared/icons'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type MonthExecutionGridProps = {
  anchorDate: Date
  events: CalendarEvent[]
  selectedDayIso: string | null
  selectedEventId: string | null
  onSelectDay: (iso: string) => void
  onSelect: (event: CalendarEvent) => void
  onCreateTask?: (dayIso: string) => void
  onReschedule?: (event: CalendarEvent, dayIso: string) => void
  weekStart?: WeekStart
}

export function MonthExecutionGrid({
  anchorDate,
  events,
  selectedDayIso,
  selectedEventId,
  onSelectDay,
  onSelect,
  onCreateTask,
  onReschedule,
  weekStart = 0,
}: MonthExecutionGridProps) {
  const [expandedDay, setExpandedDay] = useState<string | null>(null)
  const selectedDate = selectedDayIso ? new Date(`${selectedDayIso}T12:00:00`) : anchorDate
  const grid = useMemo(() => buildMonthGrid(anchorDate, { weekStart, selected: selectedDate }), [anchorDate, weekStart, selectedDate])
  const headers = weekdayHeaders(weekStart)

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const event of events) {
      const key = eventDayKey(event.timestamp)
      const list = map.get(key) || []
      list.push(event)
      map.set(key, list)
    }
    for (const [, list] of map) {
      list.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    }
    return map
  }, [events])

  const rowCount = Math.ceil(grid.length / 7)

  return (
    <section
      className="nx-cal__surface nx-cal__month nx-cal__month-full"
      style={{ ['--month-rows' as string]: rowCount }}
      aria-label={`${anchorDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`}
    >
      <div className="nx-cal__month-weekdays nx-cal__month-weekdays--sticky">
        {headers.map((label) => <span key={label}>{label}</span>)}
      </div>

      <div className="nx-cal__month-grid is-true-month">
        {grid.map((cell) => {
          const dayEvents = eventsByDay.get(cell.iso) || []
          const overflow = Math.max(0, dayEvents.length - 3)
          const isSelected = selectedDayIso === cell.iso
          const isWeekend = cell.date.getDay() === 0 || cell.date.getDay() === 6
          const categories = summarizeDayCategories(dayEvents)

          return (
            <div
              key={cell.iso}
              role="button"
              tabIndex={0}
              className={cls(
                'nx-cal__month-cell',
                !cell.inMonth && 'is-outside',
                cell.isToday && 'is-today',
                isSelected && 'is-selected',
                isWeekend && 'is-weekend',
                dayEvents.length > 0 && 'has-events',
              )}
              onClick={() => onSelectDay(cell.iso)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectDay(cell.iso) } }}
              onDoubleClick={() => onCreateTask?.(cell.iso)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.stopPropagation()
                const draggedId = (window as unknown as { __nxCalDragId?: string }).__nxCalDragId
                const event = events.find((ev) => ev.id === draggedId)
                if (event?.reschedulable) onReschedule?.(event, cell.iso)
              }}
            >
              <div className="nx-cal__month-head">
                <strong>{cell.date.getDate()}</strong>
                {dayEvents.length > 0 ? (
                  <>
                    <span className="nx-cal__month-count" title={`${dayEvents.length} events`}>{dayEvents.length}</span>
                    <div className="nx-cal__month-cats" aria-hidden="true">
                      {categories.map((cat) => (
                        <span
                          key={cat}
                          className="nx-cal__month-cat"
                          style={{ ['--cat-color' as string]: CATEGORY_META[cat].dot }}
                          title={CATEGORY_META[cat].label}
                        >
                          <Icon name={categoryIcon(cat)} />
                        </span>
                      ))}
                    </div>
                  </>
                ) : null}
                <button
                  type="button"
                  className="nx-cal__month-add"
                  aria-label={`Add task on ${cell.iso}`}
                  onClick={(e) => { e.stopPropagation(); onCreateTask?.(cell.iso) }}
                >
                  <span aria-hidden="true">+</span>
                </button>
              </div>
              <div className="nx-cal__month-body">
                {dayEvents.length === 0 ? null : (
                  <>
                    {dayEvents.slice(0, 3).map((event) => (
                      <button
                        key={event.id}
                        type="button"
                        draggable={Boolean(event.reschedulable)}
                        onDragStart={() => { (window as unknown as { __nxCalDragId?: string }).__nxCalDragId = event.id }}
                        className={cls(
                          'nx-cal__month-event',
                          `is-${event.tone}`,
                          selectedEventId === event.id && 'is-selected',
                          event.overdue && 'is-overdue',
                          !event.reschedulable && 'is-locked',
                        )}
                        title={!event.reschedulable ? `Read-only: ${event.readOnlyReason?.replace(/_/g, ' ') || 'automation owned'}` : event.title}
                        onClick={(e) => { e.stopPropagation(); onSelect(event) }}
                      >
                        <span className="nx-cal__month-event-cat" aria-hidden="true">
                          <Icon name={categoryIcon(summarizeDayCategories([event])[0])} />
                        </span>
                        <span className="nx-cal__month-event-time">
                          {event.allDay ? 'All day' : new Date(event.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                        </span>
                        <strong>{event.title}</strong>
                        <em>{formatEntitySubtitle(event)}</em>
                      </button>
                    ))}
                    {overflow > 0 ? (
                      <button type="button" className="nx-cal__month-more" onClick={(e) => { e.stopPropagation(); setExpandedDay(cell.iso) }}>
                        +{overflow} more
                      </button>
                    ) : null}
                  </>
                )}
              </div>
              {expandedDay === cell.iso ? (
                <div className="nx-cal__month-agenda-pop" onClick={(e) => e.stopPropagation()}>
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