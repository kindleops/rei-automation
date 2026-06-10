import type { CalendarEvent } from '../../lib/data/calendarData'
import { TimelineExecutionFeed } from './TimelineExecutionFeed'

type CalendarRightRailProps = {
  todayAgenda: CalendarEvent[]
  overdueItems: CalendarEvent[]
  automationSchedule: CalendarEvent[]
  scheduledItems: CalendarEvent[]
  selectedEventId: string | null
  onSelect: (event: CalendarEvent) => void
}

export function CalendarRightRail({
  todayAgenda,
  overdueItems,
  automationSchedule,
  scheduledItems,
  selectedEventId,
  onSelect,
}: CalendarRightRailProps) {
  return (
    <aside className="calendar-command__rail nx-cal__right-rail">
      <section className="calendar-command__rail-card nx-cal__surface">
        <div className="calendar-command__rail-head nx-cal__section-head">
          <strong>Today Agenda</strong>
          <span>{todayAgenda.length}</span>
        </div>
        <TimelineExecutionFeed events={todayAgenda} selectedId={selectedEventId} onSelect={onSelect} compact />
      </section>

      <section className="calendar-command__rail-card nx-cal__surface">
        <div className="calendar-command__rail-head nx-cal__section-head">
          <strong>Overdue / Risk</strong>
          <span>{overdueItems.length}</span>
        </div>
        <TimelineExecutionFeed events={overdueItems} selectedId={selectedEventId} onSelect={onSelect} compact />
      </section>

      <section className="calendar-command__rail-card nx-cal__surface">
        <div className="calendar-command__rail-head nx-cal__section-head">
          <strong>Automation Schedule</strong>
          <span>{automationSchedule.length}</span>
        </div>
        <TimelineExecutionFeed events={automationSchedule} selectedId={selectedEventId} onSelect={onSelect} compact />
      </section>

      <section className="calendar-command__rail-card nx-cal__surface">
        <div className="calendar-command__rail-head nx-cal__section-head">
          <strong>Next 5 Scheduled Sends</strong>
          <span>{scheduledItems.length}</span>
        </div>
        <TimelineExecutionFeed events={scheduledItems.slice(0, 5)} selectedId={selectedEventId} onSelect={onSelect} compact />
      </section>
    </aside>
  )
}
