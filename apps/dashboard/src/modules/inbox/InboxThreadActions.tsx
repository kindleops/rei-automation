import { Icon } from '../../shared/icons'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export const InboxThreadActions = ({
  thread,
  onArchive,
  onUnarchive,
  onMarkRead,
  onMarkUnread,
  onPin,
  onUnpin,
  onToggleStar,
  onSuppress,
  onAutoReply,
}: {
  thread: InboxWorkflowThread
  onArchive: () => void
  onUnarchive: () => void
  onMarkRead: () => void
  onMarkUnread: () => void
  onPin: () => void
  onUnpin: () => void
  onToggleStar: () => void
  onSuppress: () => void
  onAutoReply: () => void
}) => {
  const isAutoEligible = thread.inboxStatus === 'new_reply' && thread.automationState === 'active'

  return (
    <div className="nx-inbox-thread-actions">
      {isAutoEligible && (
        <button type="button" className="nx-inbox__conv-btn nx-inbox__conv-btn--primary" onClick={onAutoReply} title="Execute Deterministic Auto-Reply">
          <Icon name="zap" className="nx-inbox__conv-btn-icon" />
          Auto-Reply
        </button>
      )}
      <button type="button" className={cls('nx-inbox__conv-btn nx-inbox__conv-btn--ghost', thread.isStarred && 'is-active')} onClick={onToggleStar} title={thread.isStarred ? 'Remove Star' : 'Star Lead'}>
        <Icon name="star" className="nx-inbox__conv-btn-icon" />
        {thread.isStarred ? 'Unstar' : 'Star'}
      </button>
      <button type="button" className={cls('nx-inbox__conv-btn nx-inbox__conv-btn--ghost', thread.isPinned && 'is-active')} onClick={thread.isPinned ? onUnpin : onPin} title={thread.isPinned ? 'Unpin' : 'Pin to Top'}>
        <Icon name="flag" className="nx-inbox__conv-btn-icon" />
        {thread.isPinned ? 'Unpin' : 'Pin'}
      </button>
      <button type="button" className="nx-inbox__conv-btn nx-inbox__conv-btn--ghost" onClick={thread.isRead ? onMarkUnread : onMarkRead} title={thread.isRead ? 'Mark as Unread' : 'Mark as Read'}>
        <Icon name="inbox" className="nx-inbox__conv-btn-icon" />
        {thread.isRead ? 'Mark Unread' : 'Mark Read'}
      </button>
      {!thread.isArchived ? (
        <button type="button" className="nx-inbox__conv-btn nx-inbox__conv-btn--ghost" onClick={onArchive} title="Archive Thread">
          <Icon name="archive" className="nx-inbox__conv-btn-icon" />
          Archive
        </button>
      ) : (
        <button type="button" className="nx-inbox__conv-btn nx-inbox__conv-btn--ghost" onClick={onUnarchive} title="Unarchive Thread">
          <Icon name="archive" className="nx-inbox__conv-btn-icon" />
          Unarchive
        </button>
      )}
      {!thread.isSuppressed && (
        <button type="button" className="nx-inbox__conv-btn nx-inbox__conv-btn--ghost nx-inbox__conv-btn--danger" onClick={onSuppress} title="Suppress (DNC)">
          <Icon name="shield" className="nx-inbox__conv-btn-icon" />
          Suppress
        </button>
      )}
    </div>
  )
}
