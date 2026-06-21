import { useMemo, useState } from 'react'
import type { CalendarEvent } from '../../lib/data/calendarData'
import { buildMonthGrid, toIsoDate, weekdayHeaders } from '../../lib/calendar/calendar-date-engine'
import { Icon } from '../../shared/icons'
import { CalendarAgendaView } from './components/CalendarAgendaView'
import { MonthExecutionGrid } from './MonthExecutionGrid'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type CalendarMobileViewProps = {
  anchorDate: Date
  events: CalendarEvent[]
  selectedEventId: string | null
  onSelect: (event: CalendarEvent) => void
  onNewEvent: () => void
  onDateChange: (date: Date) => void
}

export function CalendarMobileView({
  anchorDate,
  events,
  selectedEventId,
  onSelect,
  onNewEvent,
  onDateChange,
}: CalendarMobileViewProps) {
  const [monthSheetOpen, setMonthSheetOpen] = useState(false)
  const weekDays = useMemo(() => {
    const start = new Date(anchorDate)
    start.setDate(start.getDate() - 3)
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      return d
    })
  }, [anchorDate])

  const todayKey = toIsoDate(new Date())
  const headers = weekdayHeaders(0)

  return (
    <div className="nx-cal__mobile">
      <header className="nx-cal__mobile-head">
        <div>
          <strong>{anchorDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</strong>
          <span>{events.length} events in range</span>
        </div>
        <button type="button" className="nx-cal__cmd-btn" onClick={() => setMonthSheetOpen(true)}>Month</button>
      </header>

      <div className="nx-cal__mobile-day-strip">
        {weekDays.map((day) => {
          const key = toIsoDate(day)
          const count = events.filter((e) => toIsoDate(new Date(e.timestamp)) === key).length
          return (
            <button
              key={key}
              type="button"
              className={cls('nx-cal__mobile-day', key === toIsoDate(anchorDate) && 'is-selected', key === todayKey && 'is-today')}
              onClick={() => onDateChange(day)}
            >
              <span>{day.toLocaleDateString(undefined, { weekday: 'narrow' })}</span>
              <strong>{day.getDate()}</strong>
              {count > 0 ? <em>{count}</em> : null}
            </button>
          )
        })}
      </div>

      <div className="nx-cal__mobile-agenda">
        <CalendarAgendaView
          events={events}
          selectedEventId={selectedEventId}
          onSelect={onSelect}
        />
      </div>

      <button type="button" className="nx-cal__mobile-fab" onClick={onNewEvent} aria-label="New event">
        <Icon name="spark" />
      </button>

      {monthSheetOpen ? (
        <div className="nx-cal__month-sheet" role="dialog" aria-label="Month view">
          <div className="nx-cal__month-sheet-head">
            <strong>{anchorDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong>
            <button type="button" className="nx-cal__icon-btn" onClick={() => setMonthSheetOpen(false)} aria-label="Close month sheet">
              <Icon name="close" />
            </button>
          </div>
          <div className="nx-cal__month-sheet-weekdays">
            {headers.map((h) => <span key={h}>{h}</span>)}
          </div>
          <MonthExecutionGrid
            anchorDate={anchorDate}
            events={events}
            selectedEventId={selectedEventId}
            onSelect={(event) => { onSelect(event); setMonthSheetOpen(false) }}
          />
        </div>
      ) : null}
    </div>
  )
}