import { Icon } from '../../shared/icons'
import { formatDate } from '../../lib/data/propertyData'
import type { PropertyIntelligenceContext } from './property.types'

interface OutreachPanelProps {
  context: PropertyIntelligenceContext
}

export const OutreachPanel = ({ context }: OutreachPanelProps) => {
  const latestQueue = context.queue.latest
  const recentMessages = context.messages.slice(0, 3)

  return (
    <section className="pi-panel pi-outreach-panel">
      <div className="pi-panel-heading">
        <Icon name="message" />
        <div>
          <span>Queue / Outreach</span>
          <h2>{latestQueue?.status ?? 'No active queue'}</h2>
        </div>
      </div>
      <div className="pi-outreach-stats">
        <div>
          <span>Scheduled</span>
          <strong>{formatDate(latestQueue?.scheduledAt)}</strong>
        </div>
        <div>
          <span>Messages</span>
          <strong>{context.queue.messageCount}</strong>
        </div>
        <div>
          <span>Delivery</span>
          <strong>{context.queue.deliveryState ?? 'N/A'}</strong>
        </div>
      </div>
      <div className="pi-message-preview">
        {recentMessages.length > 0 ? (
          recentMessages.map((message) => (
            <article key={message.id}>
              <span>{message.direction} / {message.status ?? message.deliveryStatus ?? 'unknown'}</span>
              <p>{message.body || 'No message body'}</p>
              <small>{formatDate(message.timestamp)}</small>
            </article>
          ))
        ) : (
          <div className="pi-empty-state">
            <Icon name="message" />
            <p>No message events linked yet.</p>
          </div>
        )}
      </div>
    </section>
  )
}
