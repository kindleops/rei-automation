import { Icon } from '../../../shared/icons'
import type { EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'
import { resolveIdentity, type EntityScope } from './entity-graph-mobile-format'
import {
  IDENTITY_SORT_COLUMN,
  SCOPE_TABLE_COLUMNS,
} from './entity-graph-table-columns'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type Props = {
  scope: EntityScope
  results: EntitySearchResult[]
  visibleColumns: string[]
  sortBy: string
  ascending: boolean
  selectionMode: boolean
  selectedKeys: Set<string>
  activeId?: string | null
  onSort: (sortBy: string) => void
  onOpen: (result: EntitySearchResult) => void
  onToggleSelect: (result: EntitySearchResult) => void
}

const resultKey = (r: EntitySearchResult) => `${r.entityType}:${r.entityId}`

/**
 * Mobile table. The identity column is pinned so a record never becomes
 * anonymous while the operator scrolls out to column nine — which is the whole
 * reason a table beats cards for comparison work.
 */
export function EntityGraphMobileTable({
  scope,
  results,
  visibleColumns,
  sortBy,
  ascending,
  selectionMode,
  selectedKeys,
  activeId,
  onSort,
  onOpen,
  onToggleSelect,
}: Props) {
  const columns = SCOPE_TABLE_COLUMNS[scope].filter((c) => visibleColumns.includes(c.key))
  const identitySort = IDENTITY_SORT_COLUMN[scope]
  const bodyWidth = columns.reduce((acc, c) => acc + c.width, 0)

  return (
    <div className="egt">
      <div className="egt-scroll">
        <div className="egt-grid" style={{ ['--egt-body-width' as string]: `${bodyWidth}px` }}>
          <div className="egt-row is-head">
            <button
              type="button"
              className={cls('egt-cell', 'is-identity', 'is-head', identitySort && 'is-sortable')}
              onClick={identitySort ? () => onSort(identitySort) : undefined}
              aria-sort={identitySort === sortBy ? (ascending ? 'ascending' : 'descending') : undefined}
            >
              {selectionMode ? <span className="egt-cell__check" aria-hidden /> : null}
              <span>{scope === 'properties' ? 'Address' : scope === 'contact_methods' ? 'Contact' : 'Name'}</span>
              {identitySort === sortBy ? <Icon name={ascending ? 'chevron-up' : 'chevron-down'} /> : null}
            </button>
            {columns.map((column) => (
              <button
                key={column.key}
                type="button"
                className={cls('egt-cell', 'is-head', column.align === 'right' && 'is-right', column.sortBy && 'is-sortable')}
                style={{ width: column.width }}
                onClick={column.sortBy ? () => onSort(column.sortBy as string) : undefined}
                aria-sort={column.sortBy === sortBy ? (ascending ? 'ascending' : 'descending') : undefined}
              >
                <span>{column.label}</span>
                {column.sortBy === sortBy ? (
                  <Icon name={ascending ? 'chevron-up' : 'chevron-down'} />
                ) : null}
              </button>
            ))}
          </div>

          {results.map((result) => {
            const identity = resolveIdentity(scope, result)
            const key = resultKey(result)
            const selected = selectedKeys.has(key)
            return (
              <div
                key={key}
                className={cls('egt-row', selected && 'is-selected', activeId === result.entityId && 'is-active')}
              >
                <div
                  className="egt-cell is-identity"
                  role="button"
                  tabIndex={0}
                  onClick={() => (selectionMode ? onToggleSelect(result) : onOpen(result))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      if (selectionMode) onToggleSelect(result)
                      else onOpen(result)
                    }
                  }}
                >
                  {selectionMode ? (
                    <span className={cls('egt-cell__check', selected && 'is-on')}>
                      <Icon name="check" />
                    </span>
                  ) : null}
                  <span className="egt-cell__identity">
                    <strong>{identity.primary}</strong>
                    {identity.secondary ? <em>{identity.secondary}</em> : null}
                  </span>
                </div>
                {columns.map((column) => {
                  const value = column.render(result)
                  return (
                    <div
                      key={column.key}
                      className={cls('egt-cell', column.align === 'right' && 'is-right', !value && 'is-empty')}
                      style={{ width: column.width }}
                    >
                      {/* An empty cell reads as an em dash, never as 0 or "N/A". */}
                      {value ?? '—'}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
