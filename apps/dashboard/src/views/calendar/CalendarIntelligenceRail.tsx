import { useEffect, useMemo, useState } from 'react'
import type { CalendarEvent } from '../../lib/data/calendarData'
import { formatEntitySubtitle } from '../../lib/calendar/calendar-entity-display'
import { classifyEventTiming, isActionableEvent } from '../../lib/calendar/calendar-event-classification'
import { toIsoDate } from '../../lib/calendar/calendar-date-engine'
import { Icon } from '../../shared/icons'
import { TimelineExecutionFeed } from './TimelineExecutionFeed'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type CalendarIntelligenceRailProps = {
  selectedDate: Date | null
  selectedEvent: CalendarEvent | null
  events: CalendarEvent[]
  allEvents: CalendarEvent[]
  selectedEventId: string | null
  collapsed: boolean
  onToggleCollapse: () => void
  onSelect: (event: CalendarEvent) => void
  onAddTask: () => void
  onClearEvent: () => void
}

export function CalendarIntelligenceRail({
  selectedDate,
  selectedEvent,
  events,
  allEvents,
  selectedEventId,
  collapsed,
  onToggleCollapse,
  onSelect,
  onAddTask,
  onClearEvent,
}: CalendarIntelligenceRailProps) {
  const [mode, setMode] = useState<'day' | 'event'>('day')

  useEffect(() => {
    if (selectedEvent) setMode('event')
    else setMode('day')
  }, [selectedEvent])

  const dayKey = selectedDate ? toIsoDate(selectedDate) : null
  const dayEvents = useMemo(() => {
    if (!dayKey) return []
    return events.filter((e) => toIsoDate(new Date(e.timestamp)) === dayKey)
  }, [dayKey, events])

  const stats = useMemo(() => ({
    total: dayEvents.length,
    overdue: dayEvents.filter((e) => e.overdue).length,
    blocked: dayEvents.filter((e) => e.automationBlocked || classifyEventTiming(e) === 'blocked').length,
    completed: allEvents.filter((e) => dayKey && toIsoDate(new Date(e.timestamp)) === dayKey && classifyEventTiming(e) === 'completed').length,
    actionable: dayEvents.filter(isActionableEvent).length,
  }), [dayEvents, allEvents, dayKey])

  if (collapsed) {
    return (
      <aside className="nx-cal__intel-rail is-collapsed" data-testid="calendar-intel-rail-collapsed">
        <button type="button" className="nx-cal__intel-rail-expand" onClick={onToggleCollapse} aria-label="Expand intelligence rail">
          <Icon name="chevron-left" />
        </button>
      </aside>
    )
  }

  if (mode === 'event' && selectedEvent) {
    return (
      <aside className="nx-cal__intel-rail" data-testid="calendar-intel-rail-event">
        <header className="nx-cal__intel-rail-head">
          <div>
            <span className="nx-cal__eyebrow">Selected Event</span>
            <strong>{selectedEvent.title}</strong>
          </div>
          <div className="nx-cal__intel-rail-head-actions">
            <button type="button" className="nx-cal__icon-btn" onClick={onClearEvent} aria-label="Clear selection"><Icon name="close" /></button>
            <button type="button" className="nx-cal__icon-btn" onClick={onToggleCollapse} aria-label="Collapse rail"><Icon name="chevron-right" /></button>
          </div>
        </header>
        <div className="nx-cal__intel-rail-body">
          <p className="nx-cal__intel-meta">{new Date(selectedEvent.timestamp).toLocaleString()}</p>
          <p className="nx-cal__intel-meta">{formatEntitySubtitle(selectedEvent)}</p>
          <p className="nx-cal__intel-meta">{selectedEvent.sourceDomain || selectedEvent.sourceTable} · {selectedEvent.status}</p>
          {selectedEvent.description ? <p className="nx-cal__drawer-copy">{selectedEvent.description}</p> : null}
          {selectedEvent.readOnlyReason ? (
            <p className="nx-cal__intel-readonly">Read-only: {selectedEvent.readOnlyReason.replace(/_/g, ' ')}</p>
          ) : null}
        </div>
      </aside>
    )
  }

  return (
    <aside className="nx-cal__intel-rail" data-testid="calendar-intel-rail-day">
      <header className="nx-cal__intel-rail-head">
        <div>
          <span className="nx-cal__eyebrow">Selected Day</span>
          <strong>{selectedDate ? selectedDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : 'No date selected'}</strong>
        </div>
        <div className="nx-cal__intel-rail-head-actions">
          <button type="button" className="nx-cal__cmd-btn nx-cal__cmd-btn--sm" onClick={onAddTask}>Add Task</button>
          <button type="button" className="nx-cal__icon-btn" onClick={onToggleCollapse} aria-label="Collapse rail"><Icon name="chevron-right" /></button>
        </div>
      </header>

      <div className="nx-cal__intel-stats">
        <div><em>{stats.total}</em><span>Total</span></div>
        <div><em>{stats.actionable}</em><span>Due</span></div>
        <div className={stats.overdue > 0 ? 'is-risk' : ''}><em>{stats.overdue}</em><span>Overdue</span></div>
        <div><em>{stats.blocked}</em><span>Blocked</span></div>
      </div>

      <div className="nx-cal__intel-rail-body">
        {dayEvents.length ? (
          <TimelineExecutionFeed events={dayEvents} selectedId={selectedEventId} onSelect={onSelect} compact />
        ) : (
          <div className="nx-cal__rail-empty-state">
            <div className="nx-cal__rail-empty-glyph" aria-hidden="true">◎</div>
            <strong>No events this day</strong>
            <p>Adjust layers or select another date. Add a Task or Reminder to schedule operator work.</p>
          </div>
        )}
      </div>
    </aside>
  )
}