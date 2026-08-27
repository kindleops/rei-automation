import { Icon } from '../../../../shared/icons'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface QueueMobileControlBarProps {
  /** Compact range token, e.g. "7d" — never a full-width LAST 7D RANGE band. */
  rangeToken: string
  statusLabel: string
  activeFilters: number
  searchActive: boolean
  selectionMode: boolean
  selectableCount: number
  onOpenFilters: () => void
  onToggleSelectionMode: () => void
}

export function QueueMobileControlBar({
  rangeToken,
  statusLabel,
  activeFilters,
  searchActive,
  selectionMode,
  selectableCount,
  onOpenFilters,
  onToggleSelectionMode,
}: QueueMobileControlBarProps) {
  return (
    <div className="qm-bar" role="toolbar" aria-label="Queue controls">
      <button type="button" className="qm-bar__filters" onClick={onOpenFilters}>
        <Icon name="filter" size={13} />
        <span className="qm-bar__filters-label">{statusLabel}</span>
        {activeFilters > 0 && <span className="qm-bar__badge">{activeFilters}</span>}
        <Icon name="chevron-down" size={12} />
      </button>
      <span className="qm-bar__range" title="Active date range">{rangeToken}</span>
      {searchActive && (
        <span className="qm-bar__flag" title="Search filter active">
          <Icon name="search" size={11} />
        </span>
      )}
      <button
        type="button"
        className={cls('qm-bar__select', selectionMode && 'is-active')}
        onClick={onToggleSelectionMode}
        disabled={!selectionMode && selectableCount === 0}
        aria-pressed={selectionMode}
      >
        {selectionMode ? 'Done' : 'Select'}
      </button>
    </div>
  )
}
