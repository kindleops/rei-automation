import { Icon } from '../../../shared/icons'
import {
  bulkActionsForScope,
  type BulkAction,
  type EntityScope,
} from './entity-graph-mobile-format'

export type { BulkAction, BulkActionKey } from './entity-graph-mobile-format'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type Props = {
  count: number
  scope: EntityScope
  pageCount: number
  allPageSelected: boolean
  /** Size of the whole filtered cohort, when "select all matching" is offered. */
  cohortTotal?: number | null
  cohortSelected?: boolean
  selectingAll?: boolean
  onSelectAllMatching?: () => void
  onSelectPage: () => void
  onClear: () => void
  onAction: (action: BulkAction) => void
}

export function EntityGraphMobileSelectionDock({
  count,
  scope,
  pageCount,
  allPageSelected,
  cohortTotal = null,
  cohortSelected = false,
  selectingAll = false,
  onSelectAllMatching,
  onSelectPage,
  onClear,
  onAction,
}: Props) {
  const actions = bulkActionsForScope(scope, count)
  const offerCohort = Boolean(onSelectAllMatching) && typeof cohortTotal === 'number' && cohortTotal > pageCount && !cohortSelected

  return (
    <div className="egm-dock" role="region" aria-label="Bulk actions">
      <div className="egm-dock__top">
        <span className="egm-dock__count">
          {count.toLocaleString()} selected
          <em>{cohortSelected ? 'whole cohort' : `of ${pageCount} shown`}</em>
        </span>
        <button type="button" className="egm-dock__link" onClick={onSelectPage}>
          {allPageSelected ? 'Deselect all' : 'Select all'}
        </button>
        <button type="button" className="egm-dock__link" onClick={onClear}>Done</button>
      </div>

      <div className="egm-dock__actions">
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            className={cls('egm-dock__act', action.primary && !action.unavailable && 'is-primary')}
            aria-disabled={Boolean(action.unavailable)}
            aria-describedby={action.unavailable ? 'egm-dock-note' : undefined}
            onClick={() => onAction(action)}
          >
            <Icon name={action.icon} />
            <span>{action.label}</span>
          </button>
        ))}
      </div>

      {offerCohort ? (
        <button type="button" className="egm-dock__cohort" onClick={onSelectAllMatching} disabled={selectingAll}>
          <Icon name="layers" />
          {selectingAll ? 'Gathering the cohort…' : `Select all ${Math.min(cohortTotal as number, 5000).toLocaleString()} matching`}
          {(cohortTotal as number) > 5000 ? <em>cap 5,000</em> : null}
        </button>
      ) : null}
    </div>
  )
}
