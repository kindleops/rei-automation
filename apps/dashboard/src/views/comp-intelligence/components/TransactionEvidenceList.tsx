import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'
import { TransactionEvidenceCard } from './TransactionEvidenceCard'

interface Props {
  rows: CompTransactionEvidence[]
  selectedId: string | null
  onSelect: (id: string) => void
  height?: number
}

export function TransactionEvidenceList({ rows, selectedId, onSelect, height = 480 }: Props) {
  if (!rows.length) {
    return <p className="ci-empty">No transaction evidence matches current filters.</p>
  }

  return (
    <div className="ci-evidence-list" style={{ maxHeight: height, overflowY: 'auto' }}>
      {rows.map((row) => (
        <TransactionEvidenceCard
          key={row.candidate_id || row.property_id || row.address || ''}
          row={row}
          selected={selectedId === (row.candidate_id || '')}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}