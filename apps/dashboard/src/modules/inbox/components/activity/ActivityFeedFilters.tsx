import type { ActivityFilterCategory, ActivityFilters } from '../../inbox-ui-helpers'

const categories: Array<{ value: ActivityFilterCategory; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'messages', label: 'Messages' },
  { value: 'ai', label: 'AI' },
  { value: 'queue', label: 'Queue' },
  { value: 'stage', label: 'Stage' },
  { value: 'property', label: 'Property' },
  { value: 'offer', label: 'Offer' },
  { value: 'contract', label: 'Contract' },
  { value: 'title', label: 'Title' },
  { value: 'buyer', label: 'Buyer' },
  { value: 'operator', label: 'Operator' },
  { value: 'errors', label: 'Errors' },
]

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

interface ActivityFeedFiltersProps {
  filters: ActivityFilters
  onChange: (next: Partial<ActivityFilters>) => void
}

export const ActivityFeedFilters = ({ filters, onChange }: ActivityFeedFiltersProps) => (
  <div className="nx-activity-filter-wrap">
    <div className="nx-activity-filter-pills" role="tablist" aria-label="Activity categories">
      {categories.map((category) => (
        <button
          key={category.value}
          type="button"
          className={cls('nx-activity-filter-chip', filters.category === category.value && 'is-active')}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onChange({ category: category.value })
          }}
        >
          {category.label}
        </button>
      ))}
    </div>

    <label className="nx-activity-search">
      <input
        type="search"
        placeholder="Search activity"
        value={filters.search}
        onChange={(event) => onChange({ search: event.target.value })}
      />
    </label>

    <div className="nx-activity-toggle-row">
      <label>
        <input
          type="checkbox"
          checked={filters.importantOnly}
          onChange={(event) => onChange({ importantOnly: event.target.checked })}
        />
        <span>Important only</span>
      </label>
      <label>
        <input
          type="checkbox"
          checked={filters.showSuppressed}
          onChange={(event) => onChange({ showSuppressed: event.target.checked })}
        />
        <span>Suppressed</span>
      </label>
      <label>
        <input
          type="checkbox"
          checked={filters.showAutomationEvents}
          onChange={(event) => onChange({ showAutomationEvents: event.target.checked })}
        />
        <span>Automation</span>
      </label>
      <label>
        <input
          type="checkbox"
          checked={filters.showOperatorEvents}
          onChange={(event) => onChange({ showOperatorEvents: event.target.checked })}
        />
        <span>Operator</span>
      </label>
    </div>
  </div>
)
