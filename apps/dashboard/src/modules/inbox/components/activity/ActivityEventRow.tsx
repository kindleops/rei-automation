import { Icon } from '../../../../shared/icons'
import {
  formatActivityTimestamp,
  getActivityEventIcon,
  getActivitySourceBadge,
  type ActivityEvent,
} from '../../inbox-ui-helpers'
import { ActivityEventDetails } from './ActivityEventDetails'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

interface ActivityEventRowProps {
  event: ActivityEvent
  expanded: boolean
  onToggle: () => void
}

export const ActivityEventRow = ({ event, expanded, onToggle }: ActivityEventRowProps) => (
  <article className={cls('nx-activity-event', `is-${event.severity}`, expanded && 'is-expanded')}>
    <button 
      type="button" 
      className="nx-activity-event-button" 
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onToggle()
      }} 
      aria-expanded={expanded}
    >
      <span className="nx-activity-event__timeline-node">
        <Icon name={getActivityEventIcon(event)} />
      </span>

      <span className="nx-activity-event__content">
        <strong>{event.title}</strong>
        <span>{event.summary}</span>
        <small>
          <time>{formatActivityTimestamp(event.timestamp)}</time>
          <b>{getActivitySourceBadge(event)}</b>
          {event.status && <i>{event.status}</i>}
          {typeof event.confidence === 'number' && <em>{Math.round(event.confidence)}%</em>}
        </small>
      </span>
    </button>

    {expanded && <ActivityEventDetails event={event} />}
  </article>
)
