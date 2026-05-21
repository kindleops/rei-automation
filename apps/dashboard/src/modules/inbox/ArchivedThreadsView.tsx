import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import { InboxThreadRow } from './InboxThreadRow'

export const ArchivedThreadsView = ({
  threads,
  selectedId,
  onSelect,
  onUnarchive,
}: {
  threads: InboxWorkflowThread[]
  selectedId: string | null
  onSelect: (threadId: string) => void
  onUnarchive: (thread: InboxWorkflowThread) => void
}) => {
  return (
    <div className="nx-archived-view">
      {threads.length === 0 && <div className="nx-inbox__empty">No archived threads.</div>}
      {threads.map((thread) => (
        <div key={thread.id} className="nx-archived-view__row">
          <InboxThreadRow
            thread={thread}
            selected={selectedId === thread.id}
            onSelect={() => onSelect(thread.id)}
            onArchive={() => onUnarchive(thread)}
          />
          <button 
            type="button" 
            className="nx-inline-button" 
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onUnarchive(thread)
            }}
          >
            Unarchive
          </button>
        </div>
      ))}
    </div>
  )
}
