import { useEffect, useMemo, useRef, useState } from 'react'
import type { CalendarEvent } from '../../lib/data/calendarData'
import { formatEntitySubtitle } from '../../lib/calendar/calendar-entity-display'
import { classifyEventTiming, isActionableEvent } from '../../lib/calendar/calendar-event-classification'
import { toIsoDate } from '../../lib/calendar/calendar-date-engine'
import { Icon } from '../../shared/icons'
import { TimelineExecutionFeed } from './TimelineExecutionFeed'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')
const RAIL_WIDTH_KEY = 'nx_cal_rail_width'
const MIN_RAIL = 280
const MAX_RAIL = 480

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
  onEditEvent?: (event: CalendarEvent) => void
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
  onEditEvent,
}: CalendarIntelligenceRailProps) {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return 360
    const stored = Number(window.localStorage.getItem(RAIL_WIDTH_KEY))
    return Number.isFinite(stored) && stored >= MIN_RAIL ? stored : 360
  })
  const resizing = useRef(false)

  const dayKey = selectedDate ? toIsoDate(selectedDate) : null
  const dayEvents = useMemo(() => {
    if (!dayKey) return []
    return events.filter((e) => toIsoDate(new Date(e.timestamp)) === dayKey)
  }, [dayKey, events])

  const upcomingAutomation = useMemo(() =>
    allEvents.filter((e) => isActionableEvent(e) && ['scheduled_sms', 'workflow_wake', 'workflow_task', 'seller_follow_up', 'campaign_scheduled'].includes(e.type)).slice(0, 6),
  [allEvents])

  const overdueRisk = useMemo(() => allEvents.filter((e) => e.overdue || e.automationBlocked).slice(0, 6), [allEvents])

  const stats = useMemo(() => ({
    total: dayEvents.length,
    overdue: dayEvents.filter((e) => e.overdue).length,
    blocked: dayEvents.filter((e) => e.automationBlocked || classifyEventTiming(e) === 'blocked').length,
    completed: allEvents.filter((e) => dayKey && toIsoDate(new Date(e.timestamp)) === dayKey && classifyEventTiming(e) === 'completed').length,
    actionable: dayEvents.filter(isActionableEvent).length,
  }), [dayEvents, allEvents, dayKey])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return
      const next = Math.min(MAX_RAIL, Math.max(MIN_RAIL, window.innerWidth - e.clientX - 24))
      setWidth(next)
      window.localStorage.setItem(RAIL_WIDTH_KEY, String(next))
      document.documentElement.style.setProperty('--cnx-rail-width', `${next}px`)
    }
    const onUp = () => { resizing.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  useEffect(() => {
    document.documentElement.style.setProperty('--cnx-rail-width', `${width}px`)
  }, [width])

  if (collapsed) {
    return (
      <aside className="nx-cal__intel-rail is-collapsed" data-testid="calendar-intel-rail-collapsed">
        <button type="button" className="nx-cal__intel-rail-expand" onClick={onToggleCollapse} aria-label="Expand intelligence rail">
          <Icon name="chevron-left" />
        </button>
      </aside>
    )
  }

  const isCompact = !selectedEvent && dayEvents.length === 0
  const isExpanded = Boolean(selectedEvent) || dayEvents.length > 0

  if (selectedEvent) {
    return (
      <aside className={cls('nx-cal__intel-rail', 'is-expanded')} style={{ width }} data-testid="calendar-intel-rail-event">
        <div className="nx-cal__intel-rail-resize" onMouseDown={() => { resizing.current = true }} aria-hidden="true" />
        <header className="nx-cal__intel-rail-head">
          <div>
            <span className="nx-cal__eyebrow">Selected Event</span>
            <strong>{selectedEvent.title}</strong>
          </div>
          <div className="nx-cal__intel-rail-head-actions">
            {selectedEvent.editable && onEditEvent ? (
              <button type="button" className="nx-cal__cmd-btn nx-cal__cmd-btn--sm" onClick={() => onEditEvent(selectedEvent)}>Edit</button>
            ) : null}
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
        {overdueRisk.length ? (
          <section className="nx-cal__intel-section">
            <span className="nx-cal__eyebrow">Overdue / Risk</span>
            <TimelineExecutionFeed events={overdueRisk} selectedId={selectedEventId} onSelect={onSelect} compact />
          </section>
        ) : null}
      </aside>
    )
  }

  return (
    <aside className={cls('nx-cal__intel-rail', isCompact && 'is-compact', isExpanded && 'is-expanded')} style={{ width }} data-testid="calendar-intel-rail-day">
      <div className="nx-cal__intel-rail-resize" onMouseDown={() => { resizing.current = true }} aria-hidden="true" />
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
          <>
            <span className="nx-cal__eyebrow">Today / Selected Day</span>
            <TimelineExecutionFeed events={dayEvents} selectedId={selectedEventId} onSelect={onSelect} compact />
          </>
        ) : (
          <div className="nx-cal__rail-empty-state">
            <strong>No events this day</strong>
            <p>Add a Task or Reminder, or adjust layers.</p>
          </div>
        )}
      </div>

      {!isCompact && upcomingAutomation.length ? (
        <section className="nx-cal__intel-section">
          <span className="nx-cal__eyebrow">Upcoming Automation</span>
          <TimelineExecutionFeed events={upcomingAutomation} selectedId={selectedEventId} onSelect={onSelect} compact />
        </section>
      ) : null}
    </aside>
  )
}