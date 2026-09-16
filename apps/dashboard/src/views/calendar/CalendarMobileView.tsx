import { useMemo, useState } from 'react'
import type { CalendarEvent } from '../../lib/data/calendarData'
import { toIsoDate, weekdayHeaders } from '../../lib/calendar/calendar-date-engine'
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
  /**
   * §30 — set when the calendar load FAILED. Without this the mobile surface
   * rendered "0 events in range · No events" over an outage, which is
   * indistinguishable from a genuinely clear day.
   */
  loadError?: string | null
  onRetry?: () => void
  /**
   * True when the canonical read failed but a fallback produced real events.
   * The events are genuine; the live schedule is not available. Saying
   * "unavailable" over visible data would be its own kind of lie.
   */
  degraded?: boolean
  /**
   * §29 — while a load is in flight the surface knows NOTHING about how many
   * items exist. It previously rendered "0 events in range" during loading,
   * which is a claim it cannot back and which read as a genuinely clear day.
   */
  loading?: boolean
  /** §5 — names the subject on screen so a scoped view is distinguishable. */
  subjectLabel?: string | null
  /** §6 — subject-aware empty copy: a fact about THIS subject. */
  emptyLabel?: string
}

export function CalendarMobileView({
  anchorDate,
  events,
  selectedEventId,
  onSelect,
  onNewEvent,
  onDateChange,
  loadError = null,
  onRetry,
  subjectLabel = null,
  emptyLabel,
  degraded = false,
  loading = false,
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
          {/* A failed load must not report "0 events in range" as if it knew. */}
          <span>
            {loading
              ? 'Loading schedule…'
              : loadError
                ? (degraded ? `${events.length} in range · fallback view` : 'Schedule unavailable')
                : subjectLabel
                  ? `${events.length} in range · ${subjectLabel}`
                  : `${events.length} events in range`}
          </span>
        </div>
        <button type="button" className="nx-cal__cmd-btn" onClick={() => setMonthSheetOpen(true)}>Month</button>
      </header>

      {loadError ? (
        <div className="nx-cal__mobile-error" role="status">
          <div className="nx-cal__mobile-error-title">
            {degraded ? 'Live schedule unavailable' : 'Couldn\u2019t load the schedule'}
          </div>
          <div className="nx-cal__mobile-error-detail">{loadError}</div>
          <div className="nx-cal__mobile-error-detail">
            {degraded
              ? 'These items come from a local fallback read, so they may be incomplete or stale.'
              : 'Nothing is shown because nothing could be read — this is not an empty day.'}
          </div>
          {onRetry ? (
            <button type="button" className="nx-cal__cmd-btn" onClick={onRetry}>Try again</button>
          ) : null}
        </div>
      ) : null}

      <div className="nx-cal__mobile-day-strip">
        {weekDays.map((day) => {
          const key = toIsoDate(day)
          // §29 — no per-day count is claimed when the read failed.
          // §29 — no per-day count is claimed when nothing could be read.
          // A degraded fallback DID read real events, so it still counts them.
          const count = loading || (loadError && !degraded)
            ? 0
            : events.filter((e) => toIsoDate(new Date(e.timestamp)) === key).length
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
        {loading && events.length === 0 ? (
          <div className="nx-cal__mobile-empty">Loading schedule…</div>
        ) : !loadError && events.length === 0 && emptyLabel ? (
          /* §6/§30 — a scoped empty view says so about THIS subject, and never
             falls back to the global schedule. */
          <div className="nx-cal__mobile-empty">{emptyLabel}</div>
        ) : (
          <CalendarAgendaView
            events={events}
            selectedEventId={selectedEventId}
            onSelect={onSelect}
          />
        )}
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
            selectedDayIso={toIsoDate(anchorDate)}
            selectedEventId={selectedEventId}
            onSelectDay={(iso) => onDateChange(new Date(`${iso}T12:00:00`))}
            onSelect={(event) => { onSelect(event); setMonthSheetOpen(false) }}
            onCreateTask={() => { onNewEvent(); setMonthSheetOpen(false) }}
          />
        </div>
      ) : null}
    </div>
  )
}