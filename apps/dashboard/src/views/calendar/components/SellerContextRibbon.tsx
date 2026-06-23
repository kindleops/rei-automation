import { useState } from 'react'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import type { CalendarEvent } from '../../../lib/data/calendarData'
import { Icon } from '../../../shared/icons'

type SellerContextRibbonProps = {
  thread: InboxWorkflowThread
  nextEvent?: CalendarEvent | null
  onOpenDeal: () => void
  onOpenConversation: () => void
  onOpenIntelligence: () => void
}

export function SellerContextRibbon({
  thread,
  nextEvent,
  onOpenDeal,
  onOpenConversation,
  onOpenIntelligence,
}: SellerContextRibbonProps) {
  const [collapsed, setCollapsed] = useState(false)
  const sellerName = thread.ownerDisplayName || thread.ownerName || thread.sellerName || 'Unresolved entity'
  const address = thread.propertyAddressFull || thread.propertyAddress || thread.subject || ''
  const stage = String(thread.conversationStage || thread.inboxStage || '—').replace(/_/g, ' ')
  const nextAction = String((thread as { next_action?: string }).next_action || thread.nextSystemAction || 'Review')
  const nearest = nextEvent
    ? new Date(nextEvent.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '—'

  if (collapsed) {
    return (
      <section className="nx-cal__seller-ribbon is-collapsed">
        <button type="button" className="nx-cal__seller-ribbon-expand" onClick={() => setCollapsed(false)}>
          <Icon name="user" />
          <span>{sellerName}</span>
          <Icon name="chevron-down" />
        </button>
      </section>
    )
  }

  return (
    <section className="nx-cal__seller-ribbon">
      <div className="nx-cal__seller-ribbon-main">
        <strong title={sellerName}>{sellerName}</strong>
        {address ? <span className="nx-cal__seller-ribbon-address" title={address}>{address}</span> : null}
        <span className="nx-cal__seller-ribbon-chip"><em>Stage</em> {stage}</span>
        <span className="nx-cal__seller-ribbon-chip"><em>Next</em> {nextAction}</span>
        <span className="nx-cal__seller-ribbon-chip"><em>Nearest</em> {nearest}</span>
      </div>
      <div className="nx-cal__seller-ribbon-actions">
        <button type="button" className="nx-cal__cmd-btn nx-cal__cmd-btn--sm" onClick={onOpenDeal}>Open Deal</button>
        <button type="button" className="nx-cal__cmd-btn nx-cal__cmd-btn--sm" onClick={onOpenConversation}>Open Conversation</button>
        <button type="button" className="nx-cal__cmd-btn nx-cal__cmd-btn--sm" onClick={onOpenIntelligence}>Open Intelligence</button>
        <button type="button" className="nx-cal__icon-btn" onClick={() => setCollapsed(true)} aria-label="Collapse entity context">
          <Icon name="chevron-up" />
        </button>
      </div>
    </section>
  )
}