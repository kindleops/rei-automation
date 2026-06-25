import { useEffect, useRef } from 'react'
import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'
import { TransactionEvidenceCard } from './TransactionEvidenceCard'

interface Props {
  rows: CompTransactionEvidence[]
  selectedId: string | null
  hoveredId?: string | null
  onSelect: (id: string) => void
  onHover?: (id: string | null) => void
  height?: number
  compact?: boolean
}

export function TransactionEvidenceList({
  rows,
  selectedId,
  hoveredId = null,
  onSelect,
  onHover,
  height = 480,
  compact = false,
}: Props) {
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!selectedId || !listRef.current) return
    const card = listRef.current.querySelector(`[data-evidence-id="${CSS.escape(selectedId)}"]`)
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId])

  if (!rows.length) {
    return <p className="ci-empty">No transaction evidence matches current filters.</p>
  }

  return (
    <div
      ref={listRef}
      className={`ci-evidence-list ${compact ? 'ci-evidence-list--compact' : ''}`}
      style={{ maxHeight: height, overflowY: 'auto' }}
    >
      {rows.map((row) => {
        const id = row.candidate_id || row.property_id || ''
        return (
          <TransactionEvidenceCard
            key={id || row.address || ''}
            row={row}
            selected={selectedId === id}
            hovered={hoveredId === id}
            expanded={selectedId === id}
            onSelect={onSelect}
            onHover={onHover}
          />
        )
      })}
    </div>
  )
}