import { Icon } from '../../shared/icons'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'

interface MobileThreadHeaderProps {
  thread: InboxWorkflowThread | null
  onBack: () => void
  onOpenIntelligence: () => void
  onOpenWorkflow?: () => void
}

export const MobileThreadHeader = ({
  thread,
  onBack,
  onOpenIntelligence,
  onOpenWorkflow,
}: MobileThreadHeaderProps) => {
  if (!thread) return null

  const name = thread.sellerName || 'Unknown prospect'
  const address = thread.propertyAddress || thread.market || ''

  return (
    <header className="nx-mobile-thread-header">
      <button
        type="button"
        className="nx-mobile-thread-header__back"
        aria-label="Back to inbox list"
        onClick={onBack}
      >
        <Icon name="chevron-left" />
      </button>
      <div className="nx-mobile-thread-header__identity">
        <span className="nx-mobile-thread-header__name">{name}</span>
        {address ? <span className="nx-mobile-thread-header__address">{address}</span> : null}
      </div>
      <div className="nx-mobile-thread-header__actions">
        {onOpenWorkflow ? (
          <button
            type="button"
            className="nx-mobile-thread-header__action"
            aria-label="Workflow execution"
            onClick={onOpenWorkflow}
          >
            <Icon name="grid" />
          </button>
        ) : null}
        <button
          type="button"
          className="nx-mobile-thread-header__action"
          aria-label="Deal Intelligence"
          onClick={onOpenIntelligence}
        >
          <Icon name="target" />
        </button>
      </div>
    </header>
  )
}