import type { CalendarEvent } from '../../../lib/data/calendarData'
import { formatRelativeTime } from '../../../shared/formatters'
import { Icon, type IconName } from '../../../shared/icons'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type CalendarAgendaViewProps = {
  events: CalendarEvent[]
  selectedEventId: string | null
  onSelect: (event: CalendarEvent) => void
  search?: string
}

const groupFor = (event: CalendarEvent) => {
  const now = new Date()
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const weekEnd = new Date(today)
  weekEnd.setDate(weekEnd.getDate() + 7)
  const eventDate = new Date(event.timestamp)
  if (event.overdue) return 'Overdue'
  if (eventDate < today) return 'Overdue'
  if (eventDate < tomorrow) return 'Today'
  if (eventDate < new Date(tomorrow.getTime() + 86400000)) return 'Tomorrow'
  if (eventDate < weekEnd) return 'This Week'
  return 'Later'
}

const iconFor = (event: CalendarEvent): IconName => {
  if (event.type.includes('workflow')) return 'cpu'
  if (event.type.includes('offer')) return 'dollar-sign'
  if (event.type.includes('contract') || event.type.includes('title') || event.type.includes('closing')) return 'briefcase'
  if (event.type.includes('reply')) return 'message'
  return 'calendar'
}

export function CalendarAgendaView({ events, selectedEventId, onSelect, search = '' }: CalendarAgendaViewProps) {
  const q = search.trim().toLowerCase()
  const filtered = events.filter((event) => {
    if (!q) return true
    return [event.title, event.sellerName, event.propertyAddress, event.market, event.sourceTable]
      .join(' ')
      .toLowerCase()
      .includes(q)
  })

  const sections = filtered.reduce<Record<string, CalendarEvent[]>>((acc, event) => {
    const label = groupFor(event)
    acc[label] ||= []
    acc[label].push(event)
    return acc
  }, {})

  const order = ['Overdue', 'Today', 'Tomorrow', 'This Week', 'Later']

  return (
    <section className="nx-cal__surface nx-cal__agenda">
      <div className="nx-cal__section-head">
        <div>
          <span className="nx-cal__eyebrow">Agenda</span>
          <strong>Chronological operator agenda</strong>
        </div>
        <span>{filtered.length}</span>
      </div>
      <div className="nx-cal__agenda-list">
        {order.filter((label) => sections[label]?.length).map((label) => (
          <section key={label} className="nx-cal__agenda-group">
            <div className="nx-cal__timeline-label">{label}</div>
            {sections[label].map((event) => (
              <button
                key={event.id}
                type="button"
                className={cls('nx-cal__agenda-row', `is-${event.tone}`, selectedEventId === event.id && 'is-selected', event.overdue && 'is-overdue')}
                onClick={() => onSelect(event)}
              >
                <span className="nx-cal__agenda-time">
                  {new Date(event.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </span>
                <span className="nx-cal__timeline-icon"><Icon name={iconFor(event)} /></span>
                <span className="nx-cal__agenda-main">
                  <strong>{event.title}</strong>
                  <small>{event.sellerName} · {event.propertyAddress} · {event.market}</small>
                  <small>{event.sourceTable.replace(/_/g, ' ')} · {event.status.replace(/_/g, ' ')} · {formatRelativeTime(event.timestamp)}</small>
                </span>
              </button>
            ))}
          </section>
        ))}
        {filtered.length === 0 ? (
          <p className="nx-cal__agenda-empty">No events match the selected range and active filters.</p>
        ) : null}
      </div>
    </section>
  )
}