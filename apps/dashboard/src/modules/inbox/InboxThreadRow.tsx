import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import { formatRelativeTime } from '../../shared/formatters'

const statusClass = (status?: string): string => `nx-thread-badge nx-thread-badge--${(status ?? 'unknown').replace(/_/g, '-')}`

export const InboxThreadRow = ({
  thread,
  selected,
  onSelect,
  onArchive,
  onMarkRead,
}: {
  thread: InboxWorkflowThread
  selected: boolean
  onSelect: () => void
  onArchive: () => void
  onMarkRead?: () => void
}) => {
  const chips = [
    thread.priority,
    thread.inboxStatus,
  ].filter(Boolean).slice(0, 2)

  return (
    <div
      role="button"
      tabIndex={0}
      className={`nx-thread-card nx-thread-row ${selected ? 'is-selected' : ''} ${!thread.isRead ? 'is-unread' : ''}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <div className="nx-thread-row__top">
        <div className="nx-thread-row__title">
          {!thread.isRead && <span className="nx-thread-row__unread-dot" />}
          <span className="nx-thread-row__owner">{thread.ownerName}</span>
          <span className="nx-thread-row__phone">{thread.phoneNumber || thread.canonicalE164 || 'no phone'}</span>
        </div>
        <span className="nx-thread-row__time">{formatRelativeTime(thread.lastMessageAt)}</span>
      </div>

      <div className="nx-thread-row__preview">{thread.lastMessageBody || thread.preview}</div>

      <div className="nx-thread-row__meta">
        {chips.map((chip) => (
          <span key={chip} className={statusClass(chip)}>{chip.replace(/_/g, ' ')}</span>
        ))}
        <span className="nx-thread-badge nx-thread-badge--stage">{thread.conversationStage.replace(/_/g, ' ')}</span>
        {thread.isPinned && <span className="nx-thread-row__pin">Pinned</span>}
      </div>

      <div className="nx-thread-row__footer nx-thread-row__hover-actions">
        {!thread.isArchived && (
          <>
            {onMarkRead && !thread.isRead && (
              <button 
                type="button" 
                className="nx-inline-button" 
                onClick={(e) => { 
                  e.preventDefault()
                  e.stopPropagation()
                  onMarkRead() 
                }}
              >
                Read
              </button>
            )}
            <button 
              type="button" 
              className="nx-inline-button" 
              onClick={(e) => { 
                e.preventDefault()
                e.stopPropagation()
                onArchive() 
              }}
            >
              Archive
            </button>
          </>
        )}
        {thread.isArchived && <span className="nx-thread-row__archived">Archived</span>}
      </div>
    </div>
  )
}
