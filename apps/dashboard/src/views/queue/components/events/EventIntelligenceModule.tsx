import { useMemo, useState } from 'react'
import type { QueueItem } from '../../../../domain/queue/queue.types'
import {
  buildEventTimelineItems,
  buildHourlyVelocity,
  buildTimelineGroups,
  matchesTimelineFilter,
  summarizeEventTimeline,
  type TimelineGroupBy,
  type TimelineTypeFilter,
} from '../../event-timeline-stats'
import { EventTimelineCards } from './EventTimelineCards'
import { EventTimelineHeader } from './EventTimelineHeader'
import { EventTimelineSpine } from './EventTimelineSpine'
import './event-intelligence.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface EventIntelligenceModuleProps {
  items: QueueItem[]
  loading?: boolean
  density: 'comfortable' | 'compact'
  onDensityChange: (density: 'comfortable' | 'compact') => void
  selectedEventId: string | null
  onSelectEvent: (item: QueueItem | null) => void
  isMobileLayout?: boolean
  globalRangeLabel?: string
}

export function EventIntelligenceModule({
  items,
  loading = false,
  density,
  onDensityChange,
  selectedEventId,
  onSelectEvent,
  isMobileLayout = false,
  globalRangeLabel = 'selected range',
}: EventIntelligenceModuleProps) {
  const [typeFilter, setTypeFilter] = useState<TimelineTypeFilter>('all')
  const [groupBy, setGroupBy] = useState<TimelineGroupBy>('time')

  const allEvents = useMemo(() => buildEventTimelineItems(items), [items])
  const filtered = useMemo(
    () => allEvents.filter((i) => matchesTimelineFilter(i, typeFilter)),
    [allEvents, typeFilter],
  )
  const summary = useMemo(() => summarizeEventTimeline(filtered), [filtered])
  const velocity = useMemo(() => buildHourlyVelocity(filtered, isMobileLayout ? 8 : 12), [filtered, isMobileLayout])
  const groupedEvents = useMemo(
    () => buildTimelineGroups(filtered, groupBy),
    [filtered, groupBy],
  )

  return (
    <div className={cls('occ-evt-intel', isMobileLayout && 'occ-evt-intel--mobile', `is-density-${density}`)}>
      <EventTimelineHeader
        summary={summary}
        velocity={velocity}
        rangeLabel={globalRangeLabel}
        isMobileLayout={isMobileLayout}
        typeFilter={typeFilter}
        groupBy={groupBy}
        density={density}
        onTypeFilter={setTypeFilter}
        onGroupBy={setGroupBy}
        onDensityChange={onDensityChange}
      />

      {loading ? (
        <div className="occ-module-empty">Loading full event stream…</div>
      ) : filtered.length === 0 ? (
        <div className="occ-module-empty">No events for this filter and date range.</div>
      ) : isMobileLayout ? (
        <EventTimelineCards
          groups={groupedEvents}
          groupBy={groupBy}
          selectedEventId={selectedEventId}
          onSelect={onSelectEvent}
          isMobileLayout
        />
      ) : (
        <EventTimelineSpine
          groups={groupedEvents}
          groupBy={groupBy}
          selectedEventId={selectedEventId}
          density={density}
          onSelect={onSelectEvent}
        />
      )}

      {!loading && filtered.length > 0 && (
        <div className="occ-table-footer occ-evt-footer">
          <span className="occ-table-footer__count">
            Showing <strong>{filtered.length.toLocaleString()}</strong> events
            {groupBy !== 'time' && (
              <> in <strong>{groupedEvents.length.toLocaleString()}</strong> groups</>
            )}
          </span>
        </div>
      )}
    </div>
  )
}