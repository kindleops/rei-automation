import { Icon } from '../../shared/icons'
import { TimelineExecutionFeed } from './TimelineExecutionFeed'
import type { CalendarEvent } from '../../lib/data/calendarData'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type CalendarExecutionDrawerProps = {
  open: boolean
  events: CalendarEvent[]
  selectedEventId: string | null
  onToggle: () => void
  onSelect: (event: CalendarEvent) => void
}

export function CalendarExecutionDrawer({
  open,
  events,
  selectedEventId,
  onToggle,
  onSelect,
}: CalendarExecutionDrawerProps) {
  return (
    <section className={cls('nx-cal__exec-drawer', open && 'is-open')}>
      <button type="button" className="nx-cal__exec-drawer-handle" onClick={onToggle}>
        <Icon name="activity" />
        <span>Execution Feed</span>
        <em>{events.length}</em>
        <Icon name={open ? 'chevron-down' : 'chevron-up'} />
      </button>
      {open ? (
        <div className="nx-cal__exec-drawer-body">
          <TimelineExecutionFeed
            events={events.slice(0, 32)}
            selectedId={selectedEventId}
            onSelect={onSelect}
            grouped
            compact
          />
        </div>
      ) : null}
    </section>
  )
}