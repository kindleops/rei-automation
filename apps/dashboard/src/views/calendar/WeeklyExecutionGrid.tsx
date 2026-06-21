import { useEffect, useMemo, useRef } from 'react'
import type { CalendarEvent } from '../../lib/data/calendarData'
import { buildWeekDays, eventDayKey, toIsoDate, type WeekStart } from '../../lib/calendar/calendar-date-engine'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type WeeklyExecutionGridProps = {
  anchorDate: Date
  events: CalendarEvent[]
  selectedEventId: string | null
  onSelect: (event: CalendarEvent) => void
  onReschedule?: (event: CalendarEvent, dayIso: string, hour: number) => void
  weekStart?: WeekStart
  slotMinutes?: 30 | 60
  workStart?: number
  workEnd?: number
}

function layoutOverlaps(dayEvents: CalendarEvent[], workStart: number, workEnd: number) {
  const rangeMinutes = (workEnd - workStart) * 60
  return dayEvents.map((event) => {
    const date = new Date(event.timestamp)
    const startMinutes = Math.max(0, (date.getHours() - workStart) * 60 + date.getMinutes())
    const endDate = event.endTimestamp ? new Date(event.endTimestamp) : new Date(date.getTime() + 30 * 60000)
    const endMinutes = Math.min(rangeMinutes, Math.max(startMinutes + 15, (endDate.getHours() - workStart) * 60 + endDate.getMinutes()))
    const top = (startMinutes / rangeMinutes) * 100
    const height = Math.max(4, ((endMinutes - startMinutes) / rangeMinutes) * 100)
    return { event, top, height }
  })
}

export function WeeklyExecutionGrid({
  anchorDate,
  events,
  selectedEventId,
  onSelect,
  onReschedule,
  weekStart = 0,
  slotMinutes = 30,
  workStart = 6,
  workEnd = 20,
}: WeeklyExecutionGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const days = useMemo(() => buildWeekDays(anchorDate, weekStart), [anchorDate, weekStart])
  const hours = useMemo(() => Array.from({ length: workEnd - workStart }, (_, i) => workStart + i), [workStart, workEnd])
  const now = new Date()
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const nowTop = ((nowMinutes - workStart * 60) / ((workEnd - workStart) * 60)) * 100

  useEffect(() => {
    if (!scrollRef.current) return
    const target = Math.max(0, nowTop - 20)
    scrollRef.current.scrollTop = (target / 100) * scrollRef.current.scrollHeight
  }, [nowTop])

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
    <section className="nx-cal__surface nx-cal__week-hourly">
      <div className="nx-cal__section-head nx-cal__week-sticky-head">
        <div>
          <span className="nx-cal__eyebrow">Week View</span>
          <strong>Seven-day execution grid</strong>
        </div>
        <span>{slotMinutes}m grid · {events.length} items</span>
      </div>

      <div className="nx-cal__week-hourly-scroll" ref={scrollRef}>
        <div className="nx-cal__week-hourly-grid">
          <div className="nx-cal__week-hour-labels">
            <div className="nx-cal__week-all-day">All day</div>
            {hours.map((hour) => (
              <div key={hour} className="nx-cal__week-hour-label">
                {hour % 12 || 12}{hour >= 12 ? 'PM' : 'AM'}
              </div>
            ))}
          </div>

          {days.map((day) => {
            const dayKey = toIsoDate(day)
            const dayEvents = eventsByDay.get(dayKey) || []
            const allDay = dayEvents.filter((e) => e.allDay)
            const timed = dayEvents.filter((e) => !e.allDay)
            const positioned = layoutOverlaps(timed, workStart, workEnd)
            const isToday = toIsoDate(day) === toIsoDate(new Date())

            return (
              <article key={dayKey} className={cls('nx-cal__week-day-col', isToday && 'is-today')}>
                <div className="nx-cal__week-col-head">
                  <strong>{day.toLocaleDateString(undefined, { weekday: 'short' })}</strong>
                  <span>{day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                  <small>{dayEvents.length} events</small>
                </div>
                <div className="nx-cal__week-all-day-lane">
                  {allDay.map((event) => (
                    <button key={event.id} type="button" className={cls('nx-cal__week-chip', `is-${event.tone}`)} onClick={() => onSelect(event)}>
                      {event.title}
                    </button>
                  ))}
                </div>
                <div
                  className="nx-cal__week-time-lane"
                  style={{ ['--slot-count' as string]: hours.length }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
                    const ratio = (e.clientY - rect.top) / rect.height
                    const hour = workStart + Math.floor(ratio * (workEnd - workStart))
                    const draggedId = (window as unknown as { __nxCalDragId?: string }).__nxCalDragId
                    const event = dayEvents.find((ev) => ev.id === draggedId) || events.find((ev) => ev.id === draggedId)
                    if (event?.reschedulable) onReschedule?.(event, dayKey, hour)
                  }}
                >
                  {hours.map((hour) => (
                    <div key={hour} className={cls('nx-cal__week-slot', hour >= 9 && hour < 17 ? 'is-business' : 'is-off-hours')} />
                  ))}
                  {isToday && nowTop >= 0 && nowTop <= 100 ? (
                    <div className="nx-cal__week-now" style={{ top: `${nowTop}%` }} aria-hidden="true" />
                  ) : null}
                  {positioned.map(({ event, top, height }) => (
                    <button
                      key={event.id}
                      type="button"
                      draggable={Boolean(event.reschedulable)}
                      onDragStart={() => { (window as unknown as { __nxCalDragId?: string }).__nxCalDragId = event.id }}
                      className={cls('nx-cal__week-event', `is-${event.tone}`, selectedEventId === event.id && 'is-selected', !event.reschedulable && 'is-locked')}
                      style={{ top: `${top}%`, height: `${height}%` }}
                      onClick={() => onSelect(event)}
                    >
                      <strong>{event.title}</strong>
                      <span>{event.sellerName}</span>
                    </button>
                  ))}
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </section>
  )
}