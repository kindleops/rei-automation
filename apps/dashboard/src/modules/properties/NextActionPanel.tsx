import { Icon } from '../../shared/icons'
import { evaluateContactReadiness } from './contactReadiness'
import type { PropertyActionHandlers, PropertyIntelligenceContext, PropertyRecord } from './property.types'

interface NextActionPanelProps {
  property: PropertyRecord
  context: PropertyIntelligenceContext
  priorityMarked: boolean
  handlers: PropertyActionHandlers
}

const nextMove = (property: PropertyRecord, context: PropertyIntelligenceContext) => {
  const readiness = evaluateContactReadiness(context)
  if (!readiness.canSendSms) return readiness.blockReason ?? 'Link contact before outreach.'
  if (!context.offerPathway.latestOffer && (property.valuation.equityPercent ?? 0) >= 50) return 'Create a cash offer scenario.'
  if (context.messages[0]?.direction === 'inbound') return 'Open thread and respond while heat is live.'
  if (property.distress.taxDelinquent || property.distress.activeLien) return 'Verify lien/tax exposure before sending terms.'
  return 'Send SMS and qualify motivation.'
}

export const NextActionPanel = ({ property, context, priorityMarked, handlers }: NextActionPanelProps) => {
  const readiness = evaluateContactReadiness(context)
  const hasOffer = Boolean(context.offerPathway.latestOffer)
  const hasContract = Boolean(context.offerPathway.activeContract)

  return (
    <aside className="pi-next-panel">
      <div className="pi-panel-heading">
        <Icon name="command" />
        <div>
          <span>Next Move</span>
          <h2>{nextMove(property, context)}</h2>
        </div>
      </div>
      <div className="pi-next-panel__actions">
        {!readiness.canSendSms ? (
          <button type="button" className="is-primary" onClick={handlers.linkContact}>
            <Icon name="users" />
            Link Contact
          </button>
        ) : (
          <button type="button" className="is-primary" onClick={handlers.sendSms}>
            <Icon name="send" />
            Send SMS
          </button>
        )}
        <button type="button" className="is-primary" disabled={!readiness.canCreateOffer} onClick={handlers.createOffer}>
          <Icon name="trending-up" />
          Create Offer
        </button>
        <button type="button" className="is-primary" disabled={!hasOffer} onClick={handlers.generateContract}>
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
      {!readiness.canSendSms && readiness.blockReason && (
        <p className="pi-action-hint">{readiness.blockReason}</p>
      )}
      {!hasOffer && <p className="pi-action-hint">No persisted offer on record.</p>}
      {!hasContract && hasOffer && <p className="pi-action-hint">Contract generation unlocks after offer workflow starts.</p>}
    </aside>
  )
}