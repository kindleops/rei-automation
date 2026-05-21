import { Icon } from '../../shared/icons'
import type { PropertyActionHandlers, PropertyIntelligenceContext, PropertyRecord } from './property.types'

interface NextActionPanelProps {
  property: PropertyRecord
  context: PropertyIntelligenceContext
  priorityMarked: boolean
  handlers: PropertyActionHandlers
}

const nextMove = (property: PropertyRecord, context: PropertyIntelligenceContext) => {
  if (!context.contacts.primaryPhone && !context.contacts.primaryEmail) return 'Link contact before outreach.'
  if (!context.offerPathway.latestOffer && (property.valuation.equityPercent ?? 0) >= 50) return 'Create a cash offer scenario.'
  if (context.messages[0]?.direction === 'inbound') return 'Open thread and respond while heat is live.'
  if (property.distress.taxDelinquent || property.distress.activeLien) return 'Verify lien/tax exposure before sending terms.'
  return 'Send SMS and qualify motivation.'
}

export const NextActionPanel = ({ property, context, priorityMarked, handlers }: NextActionPanelProps) => (
  <aside className="pi-next-panel">
    <div className="pi-panel-heading">
      <Icon name="command" />
      <div>
        <span>Next Move</span>
        <h2>{nextMove(property, context)}</h2>
      </div>
    </div>
    <div className="pi-next-panel__actions">
      <button type="button" className="is-primary" onClick={handlers.sendSms}>
        <Icon name="send" />
        Send SMS
      </button>
      <button type="button" className="is-primary" onClick={handlers.createOffer}>
        <Icon name="trending-up" />
        Create Offer
      </button>
      <button type="button" className="is-primary" onClick={handlers.generateContract}>
        <Icon name="file-text" />
        Generate Contract
      </button>
      <button type="button" onClick={handlers.openInbox}>
        <Icon name="inbox" />
        Open Inbox Thread
      </button>
      <button type="button" onClick={handlers.viewOnMap}>
        <Icon name="map" />
        View on Map
      </button>
      <button type="button" onClick={handlers.addToCampaign}>
        <Icon name="layers" />
        Add to Campaign
      </button>
      <button type="button" className={priorityMarked ? 'is-active' : ''} onClick={handlers.markPriority}>
        <Icon name="star" />
        Mark Priority
      </button>
      <button type="button" onClick={handlers.openRawRecord}>
        <Icon name="file-text" />
        Open Raw Record
      </button>
    </div>
  </aside>
)
