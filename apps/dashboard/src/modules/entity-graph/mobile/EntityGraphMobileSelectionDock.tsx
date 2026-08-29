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
  onSelectPage: () => void
  onClear: () => void
  onAction: (action: BulkAction) => void
}

export function EntityGraphMobileSelectionDock({
  count,
  scope,
  pageCount,
  allPageSelected,
  onSelectPage,
  onClear,
  onAction,
}: Props) {
  const actions = bulkActionsForScope(scope, count)
  const blocked = actions.filter((a) => a.unavailable && (a.key === 'campaign' || a.key === 'list'))

  return (
    <div className="egm-dock" role="region" aria-label="Bulk actions">
      <div className="egm-dock__top">
        <span className="egm-dock__count">
          {count} selected
          <em>of {pageCount} shown</em>
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

      {blocked.length > 0 ? (
        <p className="egm-dock__note" id="egm-dock-note">
          {blocked.map((a) => a.label).join(' · ')}: no id-list backend yet — tap for why.
        </p>
      ) : null}
    </div>
  )
}
