import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'

type ContextStat = {
  label: string
  value: string
}

type SellerCalendarContextProps = {
  thread: InboxWorkflowThread
  stats: ContextStat[]
  compact?: boolean
  onBackToGlobal: () => void
  onOpenDeal: () => void
  onOpenConversation: () => void
}

export function SellerCalendarContext({
  thread,
  stats,
  compact = false,
  onBackToGlobal,
  onOpenDeal,
  onOpenConversation,
}: SellerCalendarContextProps) {
  const sellerName = thread.ownerDisplayName || thread.ownerName || thread.sellerName || 'Unknown Seller'
  const address = thread.propertyAddressFull || thread.propertyAddress || thread.subject || 'Property Unknown'
  const priorityTone = String(thread.priority || 'normal').toLowerCase()

  return (
    <section className={`calendar-command__seller-dossier nx-cal__seller-context is-${priorityTone}`}>
      <div className="calendar-command__seller-identity nx-cal__seller-identity">
        <div>
          <strong>{sellerName}</strong>
          <p>{address}</p>
        </div>
        <div className="calendar-command__seller-status-row nx-cal__seller-status-row">
          {(compact ? stats.slice(0, 4) : stats).map((item) => (
            <div key={item.label} className="calendar-command__seller-chip nx-cal__seller-chip">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      </div>

      <div className="calendar-command__seller-actions nx-cal__seller-actions">
        <button type="button" className="calendar-command__chip-btn nx-cal__chip-btn is-active" onClick={onOpenDeal}>Open Full Deal</button>
        <button type="button" className="calendar-command__chip-btn nx-cal__chip-btn" onClick={onOpenConversation}>Open Conversation</button>
        {!compact ? <button type="button" className="calendar-command__chip-btn nx-cal__chip-btn" onClick={onOpenDeal}>Comp Intelligence</button> : null}
        <button type="button" className="calendar-command__chip-btn nx-cal__chip-btn" onClick={onBackToGlobal}>Back to Global Calendar</button>
      </div>
    </section>
  )
}
