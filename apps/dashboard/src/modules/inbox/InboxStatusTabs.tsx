import type { CanonicalBucket } from '../../domain/inbox/classifyInboxBucket'

const TAB_META: Array<{ id: CanonicalBucket; label: string; icon: string }> = [
  { id: 'priority',    label: 'Priority',     icon: '🔥' },
  { id: 'new_replies', label: 'New Replies',  icon: '📥' },
  { id: 'needs_review',label: 'Needs Review', icon: '🧠' },
  { id: 'follow_up',   label: 'Follow Up',    icon: '⏰' },
  { id: 'cold',        label: 'Cold',         icon: '🥶' },
  { id: 'suppressed',  label: 'Suppressed',   icon: '🚫' },
  { id: 'all',         label: 'All',          icon: '📦' },
]

export const InboxStatusTabs = ({
  value,
  onChange,
  counts,
}: {
  value: CanonicalBucket
  onChange: (next: CanonicalBucket) => void
  counts?: Partial<Record<CanonicalBucket, number>>
}) => {
  return (
    <div className="nx-inbox-status-tabs" role="tablist" aria-label="Inbox bucket tabs">
      {TAB_META.map((tab) => {
        const count = counts?.[tab.id]
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={value === tab.id}
            className={`nx-inbox-status-tab ${value === tab.id ? 'is-active' : ''}`}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onChange(tab.id)
            }}
          >
            <span className="nx-inbox-status-tab__icon">{tab.icon}</span>
            <span className="nx-inbox-status-tab__label">{tab.label}</span>
            {count !== undefined && (
              <span className="nx-inbox-status-tab__badge">{count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
