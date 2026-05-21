import { Icon } from '../../../../shared/icons'

export const ActivityEmptyState = () => (
  <div className="nx-activity-empty" role="status" aria-live="polite">
    <Icon name="activity" />
    <strong>No activity events found</strong>
    <span>Adjust filters or clear search to view mission log entries.</span>
  </div>
)
