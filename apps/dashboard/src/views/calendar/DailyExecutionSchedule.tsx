import { useMemo } from 'react'
import type { CalendarEvent } from '../../lib/data/calendarData'
import { eventDayKey } from '../../lib/calendar/calendar-date-engine'
import { CalendarEmptyState } from './CalendarEmptyState'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type DailyExecutionScheduleProps = {
  anchorDate: Date
  events: CalendarEvent[]
  selectedEventId: string | null
  onSelect: (event: CalendarEvent) => void
  onCreateSlot?: (hour: number) => void
  onReschedule?: (event: CalendarEvent, hour: number) => void
  workStart?: number
  workEnd?: number
}

export function DailyExecutionSchedule({
  anchorDate,
  events,
  selectedEventId,
  onSelect,
  onCreateSlot,
  onReschedule,
  workStart = 6,
  workEnd = 21,
}: DailyExecutionScheduleProps) {
  const dayKey = eventDayKey(anchorDate.toISOString())
  const dayEvents = useMemo(() => events.filter((e) => eventDayKey(e.timestamp) === dayKey), [events, dayKey])
  const hours = useMemo(() => Array.from({ length: workEnd - workStart }, (_, i) => workStart + i), [workStart, workEnd])
  const now = new Date()
  const isToday = eventDayKey(now.toISOString()) === dayKey
  const nowTop = ((now.getHours() * 60 + now.getMinutes() - workStart * 60) / ((workEnd - workStart) * 60)) * 100

  const upcoming = dayEvents.filter((e) => new Date(e.timestamp).getTime() >= now.getTime()).slice(0, 5)
  const completed = dayEvents.filter((e) => e.riskState === 'completed' || ['sent', 'delivered', 'completed'].includes(e.status))
  const overdue = dayEvents.filter((e) => e.overdue)
  const blocked = dayEvents.filter((e) => e.automationBlocked || e.type.includes('blocked'))

  return (
    <section className="nx-cal__surface nx-cal__day-timeline">
      <div className="nx-cal__day-panels">
        <div className="nx-cal__day-compact-agenda">
          <div><strong>Upcoming</strong> {upcoming.length}</div>
          <div><strong>Completed</strong> {completed.length}</div>
          <div><strong>Overdue</strong> {overdue.length}</div>
          <div><strong>Blocked</strong> {blocked.length}</div>
        </div>

        <div className="nx-cal__day-schedule is-hourly">
          {hours.map((hour) => {
            const hourEvents = dayEvents.filter((event) => new Date(event.timestamp).getHours() === hour)
            return (
              <div key={hour} className="nx-cal__day-row">
                <div className="nx-cal__day-hour">{hour % 12 || 12}{hour >= 12 ? 'PM' : 'AM'}</div>
                <div
                  className="nx-cal__day-lane"
                  onClick={() => onCreateSlot?.(hour)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    const draggedId = (window as unknown as { __nxCalDragId?: string }).__nxCalDragId
                    const event = dayEvents.find((e) => e.id === draggedId)
                    if (event?.reschedulable) onReschedule?.(event, hour)
                  }}
                >
                  {hourEvents.length === 0 ? (
                    <span className="nx-cal__day-slot-hint" aria-hidden="true" />
                  ) : hourEvents.map((event) => (
                    <button
                      key={event.id}
                      type="button"
                      draggable={Boolean(event.reschedulable)}
                      onDragStart={() => { (window as unknown as { __nxCalDragId?: string }).__nxCalDragId = event.id }}
                      className={cls('nx-cal__day-bar', `is-${event.tone}`, selectedEventId === event.id && 'is-selected', event.overdue && 'is-overdue', !event.reschedulable && 'is-locked')}
                      title={!event.reschedulable ? `Read-only: ${event.readOnlyReason?.replace(/_/g, ' ') || 'automation owned'}` : event.title}
                      onClick={(e) => { e.stopPropagation(); onSelect(event) }}
                    >
                      <strong>{event.title}</strong>
                      <span>{event.sellerName}</span>
                      {!event.reschedulable ? <small className="nx-cal__locked-hint">Read-only automation</small> : null}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
          {isToday && nowTop >= 0 && nowTop <= 100 ? (
            <div className="nx-cal__day-now" style={{ top: `${nowTop}%` }} />
          ) : null}
        </div>
      </div>

      {dayEvents.length === 0 ? (
        <CalendarEmptyState
          title="No events for this day."
          description="No events match the selected day and active filters."
          compact
        />
      ) : null}
    </section>
  )
}