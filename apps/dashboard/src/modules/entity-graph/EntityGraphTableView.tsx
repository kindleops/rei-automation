import type { EntityGraphTab, EntitySearchResult } from '../../domain/entity-graph/entity-graph.types'
import { TABLE_COLUMNS, renderTableRowCells } from './entity-graph-ui-helpers'

type Props = {
  tab: EntityGraphTab
  results: EntitySearchResult[]
  selectedType: string | null
  selectedId: string | null
  sortBy: string
  ascending: boolean
  onSelect: (result: EntitySearchResult) => void
  onSort: (column: string) => void
}

export function EntityGraphTableView({
  tab,
  results,
  selectedType,
  selectedId,
  sortBy,
  ascending,
  onSelect,
  onSort,
}: Props) {
  const columns = TABLE_COLUMNS[tab]

  return (
    <div className="eg-table-wrap">
      <table className="eg-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>
                {column.sortable ? (
                  <button
                    type="button"
                    className={`eg-table__sort${sortBy === column.key ? ' is-active' : ''}`}
                    onClick={() => onSort(column.key)}
                  >
                    {column.label}
                    {sortBy === column.key && <span>{ascending ? '↑' : '↓'}</span>}
                  </button>
                ) : column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {results.map((result) => {
            const cells = renderTableRowCells(tab, result)
            const isSelected = selectedType === result.entityType && selectedId === result.entityId
            return (
              <tr
                key={`${result.entityType}:${result.entityId}`}
                className={isSelected ? 'is-selected' : ''}
                data-entity-type={result.entityType}
                onClick={() => onSelect(result)}
              >
                {cells.map((cell, index) => (
                  <td key={`${result.entityId}-${index}`}>
                    {index === 0 ? (
                      <div className="eg-cell-primary">
                        <span className="eg-cell-title">{cell}</span>
                        {tab === 'properties' && result.subtitle && (
                          <span className="eg-cell-sub">{result.subtitle}</span>
                        )}
                      </div>
                    ) : (
                      <span className="eg-cell-value">{cell}</span>
                    )}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}