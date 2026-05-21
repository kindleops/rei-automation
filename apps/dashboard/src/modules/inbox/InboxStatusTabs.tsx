import type { InboxStatusTab } from '../../lib/data/inboxWorkflowData'

const TAB_META: Array<{ id: InboxStatusTab; label: string }> = [
  { id: 'priority', label: 'Priority' },
  { id: 'needs_response', label: 'Needs Response' },
  { id: 'sent', label: 'Sent' },
  { id: 'queued', label: 'Queued' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'failed', label: 'Failed' },
  { id: 'archived', label: 'Archived' },
  { id: 'all', label: 'All' },
]

export const InboxStatusTabs = ({
  value,
  onChange,
}: {
  value: InboxStatusTab
  onChange: (next: InboxStatusTab) => void
}) => {
  return (
    <div className="nx-inbox-status-tabs" role="tablist" aria-label="Inbox workflow tabs">
      {TAB_META.map((tab) => (
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
          {tab.label}
        </button>
      ))}
    </div>
  )
}
