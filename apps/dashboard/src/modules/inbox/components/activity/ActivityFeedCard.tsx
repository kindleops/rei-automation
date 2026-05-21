import { useMemo, useState } from 'react'
import type { ThreadContext, ThreadMessage } from '../../../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../../../lib/data/inboxWorkflowData'
import {
  filterActivityEvents,
  getThreadActivityFeed,
  groupActivityEventsByTime,
  type ActivityFilters,
} from '../../inbox-ui-helpers'
import { ActivityEmptyState } from './ActivityEmptyState'
import { getDefaultActivityFilters } from './activityDefaults'
import { ActivityFeedFilters } from './ActivityFeedFilters'
import { ActivityTimeline } from './ActivityTimeline'

interface ActivityFeedCardProps {
  thread: InboxWorkflowThread
  context: ThreadContext | null
  messages: ThreadMessage[]
}

export const ActivityFeedCard = ({ thread, context, messages }: ActivityFeedCardProps) => {
  const [filters, setFilters] = useState<ActivityFilters>(getDefaultActivityFilters)

  const allEvents = useMemo(() => getThreadActivityFeed(thread, context, messages), [thread, context, messages])
  const filteredEvents = useMemo(() => filterActivityEvents(allEvents, filters), [allEvents, filters])
  const groupedEvents = useMemo(() => groupActivityEventsByTime(filteredEvents), [filteredEvents])

  return (
    <div className="nx-activity-feed">
      <ActivityFeedFilters
        filters={filters}
        onChange={(next) => setFilters((current) => ({ ...current, ...next }))}
      />

      {groupedEvents.length === 0 ? <ActivityEmptyState /> : <ActivityTimeline groupedEvents={groupedEvents} />}
    </div>
  )
}
