import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import type { CalendarEvent } from '../../../lib/data/calendarData'
import { Icon } from '../../../shared/icons'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type SellerContextRibbonProps = {
  thread: InboxWorkflowThread
  nextEvent?: CalendarEvent | null
  compact?: boolean
  onOpenDeal: () => void
  onOpenConversation: () => void
  onOpenIntelligence: () => void
  onClearScope: () => void
}

export function SellerContextRibbon({
  thread,
  nextEvent,
  compact = false,
  onOpenDeal,
  onOpenConversation,
  onOpenIntelligence,
  onClearScope,
}: SellerContextRibbonProps) {
  const sellerName = thread.ownerDisplayName || thread.ownerName || thread.sellerName || 'Unknown Seller'
  const address = thread.propertyAddressFull || thread.propertyAddress || thread.subject || 'Property Unknown'
  const stage = String(thread.conversationStage || thread.inboxStage || 'Unknown').replace(/_/g, ' ')
  const status = String(thread.automationState || 'active').replace(/_/g, ' ')
  const temperature = String(thread.priority || 'normal').replace(/_/g, ' ')
  const nextAction = String((thread as { next_action?: string }).next_action || thread.nextSystemAction || 'Review conversation')

  return (
    <section className={cls('nx-cal__seller-ribbon', compact && 'is-compact')}>
      <div className="nx-cal__seller-ribbon-avatar" aria-hidden="true">
        <Icon name="home" />
      </div>

      <div className="nx-cal__seller-ribbon-main">
        <div className="nx-cal__seller-ribbon-top">
          <strong>{sellerName}</strong>
          <span className="nx-cal__seller-ribbon-address">{address}</span>
        </div>
        <div className="nx-cal__seller-ribbon-meta">
          <span><em>Stage</em> {stage}</span>
          <span><em>Status</em> {status}</span>
          <span><em>Temp</em> {temperature}</span>
          {!compact ? (
            <>
              <span><em>Next</em> {nextAction}</span>
              <span><em>Scheduled</em> {nextEvent ? new Date(nextEvent.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}</span>
            </>
          ) : null}
        </div>
      </div>

      <div className="nx-cal__seller-ribbon-actions">
        <button type="button" className="nx-cal__cmd-btn nx-cal__cmd-btn--sm" onClick={onOpenDeal}>Deal</button>
        <button type="button" className="nx-cal__cmd-btn nx-cal__cmd-btn--sm" onClick={onOpenConversation}>Chat</button>
        <button type="button" className="nx-cal__cmd-btn nx-cal__cmd-btn--sm" onClick={onOpenIntelligence}>Intel</button>
        <button type="button" className="nx-cal__cmd-btn nx-cal__cmd-btn--sm" onClick={onClearScope}>Clear</button>
      </div>
    </section>
  )
}