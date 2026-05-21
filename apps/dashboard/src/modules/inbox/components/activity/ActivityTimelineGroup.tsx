import type { ActivityEvent } from '../../inbox-ui-helpers'
import { ActivityEventRow } from './ActivityEventRow'

interface ActivityTimelineGroupProps {
  label: string
  events: ActivityEvent[]
  expandedEventId: string | null
  onToggleEvent: (id: string) => void
}

export const ActivityTimelineGroup = ({
  label,
  events,
  expandedEventId,
  onToggleEvent,
}: ActivityTimelineGroupProps) => (
  <section className="nx-activity-group">
    <header>{label}</header>
    <div className="nx-activity-group-events">
      {events.map((event) => (
        <ActivityEventRow
          key={event.id}
          event={event}
          expanded={expandedEventId === event.id}
          onToggle={() => onToggleEvent(event.id)}
        />
      ))}
    </div>
  </section>
)
