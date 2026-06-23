import type { CalendarEvent } from '../../lib/data/calendarData'
import { formatEntitySubtitle } from '../../lib/calendar/calendar-entity-display'
import { formatRelativeTime } from '../../shared/formatters'
import { Icon, type IconName } from '../../shared/icons'
import { CalendarEmptyState } from './CalendarEmptyState'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type TimelineExecutionFeedProps = {
  events: CalendarEvent[]
  selectedId: string | null
  onSelect: (event: CalendarEvent) => void
  grouped?: boolean
  compact?: boolean
  emptyTitle?: string
  emptyDescription?: string
}

const iconForEvent = (event: CalendarEvent): IconName => {
  if (event.type.includes('contract')) return 'file-text'
  if (event.type.includes('closing') || event.type.includes('title')) return 'briefcase'
  if (event.type.includes('offer')) return 'dollar-sign'
  if (event.type.includes('reply')) return 'message'
  if (event.type.includes('sms') || event.type.includes('follow_up')) return 'send'
  if (event.type.includes('automation') || event.type.includes('underwriting')) return 'cpu'
  return 'calendar'
}

const groupTitleForEvent = (event: CalendarEvent) => {
  const now = new Date()
  const eventDate = new Date(event.timestamp)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const weekEnd = new Date(today)
  weekEnd.setDate(weekEnd.getDate() + 7)

  if (eventDate < today) return 'Completed / Historical'
  if (eventDate < tomorrow) return 'Today'
  if (eventDate < new Date(tomorrow.getTime() + 86400000)) return 'Tomorrow'
  if (eventDate < weekEnd) return 'This Week'
  return 'Upcoming'
}

export function TimelineExecutionFeed({
  events,
  selectedId,
  onSelect,
  grouped = false,
  compact = false,
  emptyTitle = 'No execution events scheduled for this period.',
  emptyDescription = 'No events match the selected range and active filters.',
}: TimelineExecutionFeedProps) {
  if (events.length === 0) {
    return <CalendarEmptyState title={emptyTitle} description={emptyDescription} compact={compact} />
  }

  const sections = grouped
    ? events.reduce<Record<string, CalendarEvent[]>>((acc, event) => {
        const label = groupTitleForEvent(event)
        acc[label] ||= []
        acc[label].push(event)
        return acc
      }, {})
    : { Events: events }

  return (
    <div className={cls('calendar-command__timeline', 'nx-cal__timeline-feed', compact && 'is-compact')}>
      {Object.entries(sections).map(([label, items]) => (
        <section key={label} className="calendar-command__timeline-section nx-cal__timeline-section">
          {grouped ? <div className="calendar-command__timeline-label nx-cal__timeline-label">{label}</div> : null}
          <div className="calendar-command__timeline-list nx-cal__timeline-list">
            {items.map((event) => (
              <button
                key={event.id}
                type="button"
                className={cls('calendar-command__timeline-node', 'nx-cal__timeline-item', `is-${event.tone}`, selectedId === event.id && 'is-selected')}
                onClick={() => onSelect(event)}
              >
                <div className="calendar-command__timeline-icon nx-cal__timeline-icon">
                  <Icon name={iconForEvent(event)} />
                </div>
                <div className="calendar-command__timeline-content nx-cal__timeline-content">
                  <div className="calendar-command__timeline-head nx-cal__timeline-head">
                    <strong>{event.title}</strong>
                    <span>{formatRelativeTime(event.timestamp)}</span>
                  </div>
                  <p>{formatEntitySubtitle(event)}</p>
                  <div className="calendar-command__timeline-meta nx-cal__timeline-meta">
                    <span>{event.market}</span>
                    <span>{event.sourceTable.replace(/_/g, ' ')}</span>
                    <span className="calendar-command__event-pill nx-cal__event-pill">{event.overdue ? 'Overdue' : event.status.replace(/_/g, ' ')}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
