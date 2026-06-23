import { Icon } from '../../../shared/icons'
import type { BulkActionPreview } from '../queue-ui-helpers'

interface QueueBulkActionDockProps {
  selectedCount: number
  onRetry: () => void
  onReschedule: () => void
  onPause: () => void
  onCancel: () => void
  onSuppress: () => void
  onOpenFailures: () => void
  onClear: () => void
  retryEligible: number
  nonRetryable: number
}

export function QueueBulkActionDock({
  selectedCount, onRetry, onReschedule, onPause, onCancel, onSuppress, onOpenFailures, onClear, retryEligible, nonRetryable,
}: QueueBulkActionDockProps) {
  if (selectedCount === 0) return null

  return (
    <div className="occ-bulk-dock" role="toolbar" aria-label="Bulk queue actions">
      <div className="occ-bulk-dock__atmo" aria-hidden="true" />
      <div className="occ-bulk-dock__summary">
        <strong>{selectedCount}</strong> selected
        {retryEligible > 0 && <span className="is-green">{retryEligible} retryable</span>}
        {nonRetryable > 0 && <span className="is-red">{nonRetryable} excluded</span>}
      </div>
      <div className="occ-bulk-dock__actions">
        <button type="button" className="occ-bulk-btn is-primary" disabled={retryEligible === 0} onClick={onRetry} title="Retry eligible rows only">
          <Icon name="zap" size={12} /> Retry
        </button>
        <button type="button" className="occ-bulk-btn" onClick={onReschedule}><Icon name="clock" size={12} /> Reschedule</button>
        <button type="button" className="occ-bulk-btn" onClick={onPause}><Icon name="pause" size={12} /> Pause</button>
        <button type="button" className="occ-bulk-btn" onClick={onCancel}><Icon name="close" size={12} /> Cancel</button>
        <button type="button" className="occ-bulk-btn is-danger" onClick={onSuppress}><Icon name="shield" size={12} /> Suppress</button>
        <button type="button" className="occ-bulk-btn" onClick={onOpenFailures}><Icon name="alert-circle" size={12} /> Failures</button>
        <button type="button" className="occ-bulk-btn is-muted" onClick={onClear}>Clear</button>
      </div>
    </div>
  )
}

export function extendBulkPreview(preview: BulkActionPreview) {
  return preview
}