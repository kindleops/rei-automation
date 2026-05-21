import type { SentMessageItem } from '../../lib/data/inboxWorkflowData'
import { formatRelativeTime } from '../../shared/formatters'

const deliveryClass = (status: string): string => `nx-thread-badge nx-thread-badge--${status.replace(/_/g, '-')}`

export const SentMessagesView = ({
  messages,
  onOpenThread,
}: {
  messages: SentMessageItem[]
  onOpenThread: (threadKey: string) => void
}) => {
  return (
    <div className="nx-sent-view">
      {messages.length === 0 && <div className="nx-inbox__empty">No outbound messages in this range.</div>}
      {messages.map((item) => (
        <div key={item.id} className="nx-sent-item">
          <div className="nx-sent-item__head">
            <span className="nx-sent-item__to">To {item.recipientNumber || 'unknown'}</span>
            <span className={deliveryClass(item.deliveryConfirmed ? 'delivered' : item.deliveryStatus)}>{item.deliveryConfirmed ? 'delivered' : item.deliveryStatus}</span>
            <span className="nx-sent-item__time">{formatRelativeTime(item.sentAt)}</span>
          </div>
          <p className="nx-sent-item__body">{item.body || 'No message body'}</p>
          <div className="nx-sent-item__meta">
            <span>From {item.fromNumber || 'unknown'}</span>
            {item.providerMessageId && <span>Provider {item.providerMessageId}</span>}
            {item.failedReason && <span className="nx-sent-item__failed">{item.failedReason}</span>}
            <button 
              type="button" 
              className="nx-inline-button" 
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onOpenThread(item.threadKey)
              }}
            >
              Open Thread
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
