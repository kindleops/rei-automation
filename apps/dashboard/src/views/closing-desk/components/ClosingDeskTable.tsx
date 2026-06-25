import { useMemo, useState } from 'react'
import type { ClosingCase } from '../../../domain/closing-desk/closing-desk.types'
import { boardColumnLabel } from '../../../domain/closing-desk/closing-board'
import { ClosingHealthBadge } from './ClosingHealthBadge'
import { formatDate, money, primaryBlocker, sortCases, stageLabel, type TableSortKey } from '../closing-desk-utils'

const COLUMNS: { key: TableSortKey; label: string }[] = [
  { key: 'displayName', label: 'Property' },
  { key: 'sellerName', label: 'Seller' },
  { key: 'market', label: 'Market' },
  { key: 'universalStage', label: 'Universal Stage' },
  { key: 'boardColumn', label: 'Operational Lane' },
  { key: 'health', label: 'Health' },
  { key: 'scheduledClosingDate', label: 'Closing Date' },
  { key: 'daysRemaining', label: 'Days Remaining' },
  { key: 'blocker', label: 'Primary Blocker' },
  { key: 'blockerOwner', label: 'Blocker Owner' },
  { key: 'sellerPrice', label: 'Seller Price' },
  { key: 'expectedRevenue', label: 'Expected Revenue' },
  { key: 'nextAction', label: 'Next Required Action' },
]

export interface ClosingDeskTableProps {
  cases: ClosingCase[]
  selectedId: string | null
  onOpenCase: (c: ClosingCase) => void
}

export function ClosingDeskTable({ cases, selectedId, onOpenCase }: ClosingDeskTableProps) {
  const [sortKey, setSortKey] = useState<TableSortKey>('scheduledClosingDate')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const rows = useMemo(() => sortCases(cases, sortKey, sortDir), [cases, sortKey, sortDir])

  const toggleSort = (key: TableSortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  return (
    <div className="cd-ledger-wrap" data-testid="cd-table">
      <table className="cd-ledger">
        <thead>
          <tr>
            {COLUMNS.map((col) => (
              <th key={col.key}>
                <button type="button" className="cd-ledger__sort" onClick={() => toggleSort(col.key)}>
                  {col.label}
                  {sortKey === col.key ? <span aria-hidden>{sortDir === 'asc' ? ' ↑' : ' ↓'}</span> : null}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={COLUMNS.length} className="cd-ledger__empty">
                No cases in ledger view — adjust filters or wait for projection.
              </td>
            </tr>
          ) : (
            rows.map((c) => {
              const blocker = primaryBlocker(c)
              return (
                <tr
                  key={c.identity.closingCaseId}
                  className={selectedId === c.identity.closingCaseId ? 'is-selected' : ''}
                  onClick={() => onOpenCase(c)}
                  tabIndex={0}
                  data-testid="cd-table-row"
                  data-case-id={c.identity.closingCaseId}
                  onKeyDown={(e) => { if (e.key === 'Enter') onOpenCase(c) }}
                >
                  <td className="cd-ledger__property">{c.displayName}</td>
                  <td>{c.sellerName ?? '—'}</td>
                  <td>{c.market ?? '—'}</td>
                  <td>{stageLabel(c.universalStage)}</td>
                  <td>{boardColumnLabel(c.boardColumn)}</td>
                  <td><ClosingHealthBadge health={c.health} /></td>
                  <td>{formatDate(c.dates.scheduledClosingDate) ?? '—'}</td>
                  <td>{c.health.daysUntilClosing ?? '—'}</td>
                  <td className="cd-ledger__blocker">{blocker?.title ?? '—'}</td>
                  <td>{blocker?.owner ?? c.health.responsibleParty ?? '—'}</td>
                  <td>{money(c.financials.sellerContractPrice) ?? '—'}</td>
                  <td>{money(c.financials.expectedGrossRevenue) ?? '—'}</td>
                  <td className="cd-ledger__action">{c.health.nextRequiredAction ?? '—'}</td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
      <div className="cd-ledger__footer" aria-live="polite">
        {rows.length} case{rows.length === 1 ? '' : 's'}
      </div>
    </div>
  )
}