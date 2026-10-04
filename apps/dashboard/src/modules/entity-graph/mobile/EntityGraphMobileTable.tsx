import { Icon } from '../../../shared/icons'
import type { EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'
import { resolveIdentity, type EntityScope } from './entity-graph-mobile-format'
import {
  IDENTITY_SORT_COLUMN,
  SCOPE_TABLE_COLUMNS,
  type HeaderSort,
} from './entity-graph-table-columns'
import { IDENTITY_COLUMN_KEY } from './entity-graph-table-layout'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type Props = {
  scope: EntityScope
  results: EntitySearchResult[]
  visibleColumns: string[]
  /** The operator's header sort (column key), or null. */
  headerSort: HeaderSort | null
  /** With no header sort: the Sort-menu column, shown on its header when visible. */
  fallbackSortBy: string | null
  fallbackAscending: boolean
  /** One honest line above the grid ("Sorted within 60 loaded rows", load errors). */
  status?: string | null
  selectionMode: boolean
  selectedKeys: Set<string>
  activeId?: string | null
  /** Header click: cycles asc → desc → none for that column key. */
  onSort: (columnKey: string) => void
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
  headerSort,
  fallbackSortBy,
  fallbackAscending,
  status,
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
  /** Direction shown on a header: the header sort, else the Sort menu's server column. */
  const dirFor = (key: string, serverSortBy: string | null | undefined): 'asc' | 'desc' | null => {
    if (headerSort) return headerSort.key === key ? headerSort.dir : null
    return serverSortBy && serverSortBy === fallbackSortBy ? (fallbackAscending ? 'asc' : 'desc') : null
  }
  const ariaSort = (dir: 'asc' | 'desc' | null) => (dir === 'asc' ? 'ascending' as const : dir === 'desc' ? 'descending' as const : undefined)
  const identityDir = dirFor(IDENTITY_COLUMN_KEY, identitySort)

  return (
    <div className="egt">
      {status ? <div className="egt-status" role="status">{status}</div> : null}
      <div className="egt-scroll">
        <div className="egt-grid" style={{ ['--egt-body-width' as string]: `${bodyWidth}px` }}>
          <div className="egt-row is-head">
            <button
              type="button"
              className={cls('egt-cell', 'is-identity', 'is-head', 'is-sortable')}
              onClick={() => onSort(IDENTITY_COLUMN_KEY)}
              aria-sort={ariaSort(identityDir)}
              title={identitySort ? undefined : 'Sorts the loaded rows'}
            >
              {selectionMode ? <span className="egt-cell__check" aria-hidden /> : null}
              <span>{scope === 'properties' ? 'Address' : scope === 'contact_methods' ? 'Contact' : 'Name'}</span>
              {identityDir ? <Icon name={identityDir === 'asc' ? 'chevron-up' : 'chevron-down'} /> : null}
            </button>
            {columns.map((column) => {
              const dir = dirFor(column.key, column.sortBy)
              return (
                <button
                  key={column.key}
                  type="button"
                  className={cls('egt-cell', 'is-head', 'is-sortable', column.align === 'right' && 'is-right')}
                  style={{ width: column.width }}
                  onClick={() => onSort(column.key)}
                  aria-sort={ariaSort(dir)}
                  title={column.sortBy ? undefined : 'Sorts the loaded rows'}
                >
                  <span>{column.label}</span>
                  {dir ? <Icon name={dir === 'asc' ? 'chevron-up' : 'chevron-down'} /> : null}
                </button>
              )
            })}
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
