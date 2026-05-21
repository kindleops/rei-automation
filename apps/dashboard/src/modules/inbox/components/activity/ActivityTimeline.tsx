import { useMemo, useState } from 'react'
import type { ActivityEvent } from '../../inbox-ui-helpers'
import { ActivityTimelineGroup } from './ActivityTimelineGroup'

interface ActivityTimelineProps {
  groupedEvents: Array<{ label: string; events: ActivityEvent[] }>
}

const WINDOW_SIZE = 100

export const ActivityTimeline = ({ groupedEvents }: ActivityTimelineProps) => {
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null)

  const totalCount = useMemo(() => groupedEvents.reduce((sum, group) => sum + group.events.length, 0), [groupedEvents])
  const virtualizationEnabled = totalCount > 100 && !expandedEventId

  const windowed = useMemo(() => {
    if (!virtualizationEnabled) return groupedEvents

    let consumed = 0
    return groupedEvents
      .map((group) => {
        if (consumed >= WINDOW_SIZE) return { ...group, events: [] }
        const room = WINDOW_SIZE - consumed
        const sliced = group.events.slice(0, room)
        consumed += sliced.length
        return { ...group, events: sliced }
      })
      .filter((group) => group.events.length > 0)
  }, [groupedEvents, virtualizationEnabled])

  return (
    <div className="nx-activity-timeline" role="feed" aria-label="Mission log timeline">
      {virtualizationEnabled && (
        <div className="nx-activity-windowing-note">Windowed timeline active (showing newest 100 events).</div>
      )}

      {windowed.map((group) => (
        <ActivityTimelineGroup
          key={group.label}
          label={group.label}
          events={group.events}
          expandedEventId={expandedEventId}
          onToggleEvent={(id) => setExpandedEventId((current) => (current === id ? null : id))}
        />
      ))}
    </div>
  )
}
