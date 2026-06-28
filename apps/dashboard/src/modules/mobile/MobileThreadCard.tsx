import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import { formatInboxThreadTimestamp } from '../../shared/formatters'
import { resolveThreadAddressLine, resolveThreadPrimaryName } from '../inbox/inbox-ui-helpers'
import type { ConversationDecision } from '../../domain/inbox/inbox-decisioning'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

interface MobileThreadCardProps {
  thread: InboxWorkflowThread
  decision: ConversationDecision
  selected?: boolean
  onSelect: (id: string) => void
}

export const MobileThreadCard = ({
  thread,
  decision,
  selected,
  onSelect,
}: MobileThreadCardProps) => {
  const name = resolveThreadPrimaryName(thread)
  const address = resolveThreadAddressLine(thread)
  const preview = thread.latestMessageBody || thread.lastMessageBodyPreview || 'No messages yet'
  const direction = decision.last_message_direction === 'outbound' ? '→' : '←'
  const ts = formatInboxThreadTimestamp(thread.lastMessageAt || thread.lastMessageIso)
  const time = ts.timeLabel || ts.fullLabel

  return (
    <button
      type="button"
      className={cls('nx-mobile-thread-card', selected && 'is-selected', thread.isUnread && 'is-unread')}
      onClick={() => onSelect(thread.id)}
    >
      <div className="nx-mobile-thread-card__top">
        <span className="nx-mobile-thread-card__name">{name}</span>
        <span className="nx-mobile-thread-card__time">{time}</span>
      </div>
      {address ? <span className="nx-mobile-thread-card__address">{address}</span> : null}
      <p className="nx-mobile-thread-card__preview">
        <span className="nx-mobile-thread-card__direction" aria-hidden>{direction}</span>
        {preview}
      </p>
      <div className="nx-mobile-thread-card__meta">
        {decision.conversation_stage ? (
          <span className="nx-mobile-thread-card__chip">{decision.conversation_stage.replace(/_/g, ' ')}</span>
        ) : null}
        {thread.inboxStatus ? (
          <span className="nx-mobile-thread-card__chip is-muted">{thread.inboxStatus.replace(/_/g, ' ')}</span>
        ) : null}
        {decision.lead_temperature ? (
          <span className={cls('nx-mobile-thread-card__chip', 'is-temp')}>
            {decision.lead_temperature.replace(/_/g, ' ')}
          </span>
        ) : null}
        {thread.isStarred ? <span className="nx-mobile-thread-card__flag" aria-label="Starred">★</span> : null}
        {thread.isPinned ? <span className="nx-mobile-thread-card__flag" aria-label="Pinned">📌</span> : null}
        {decision.suppression_status === 'suppressed' ? (
          <span className="nx-mobile-thread-card__warn" title="Suppressed">⚠</span>
        ) : null}
      </div>
    </button>
  )
}