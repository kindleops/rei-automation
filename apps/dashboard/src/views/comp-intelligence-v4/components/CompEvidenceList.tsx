/**
 * Comp Intelligence V4 — evidence list.
 * Renders the cards for the active tier. Virtualization is added in Checkpoint 4;
 * Checkpoint 1 renders the live set directly with an empty-state.
 */

import type { V4Evidence, V4Subject } from '../state/types'
import { CompCard } from './CompCard'

interface CompEvidenceListProps {
  evidence: V4Evidence[]
  subject: V4Subject
  tierLabel: string
  totalDiscovered: number
  selectedId: string | null
  hoveredId: string | null
  onHover: (id: string | null) => void
  onSelect: (id: string) => void
  onOpenDossier: (id: string) => void
}

export function CompEvidenceList(props: CompEvidenceListProps) {
  const { evidence, tierLabel, totalDiscovered } = props

  return (
    <div className="civ4-list" aria-label="Comparable evidence">
      <div className="civ4-list__head">
        <span className="civ4-list__title">{tierLabel}</span>
        <span className="civ4-list__count">
          {evidence.length} shown · {totalDiscovered} discovered
        </span>
      </div>
      {evidence.length === 0 ? (
        <div className="civ4-empty">
          <span className="civ4-empty__glyph">⊘</span>
          <span className="civ4-empty__title">No {tierLabel.toLowerCase()} in this view</span>
          <span className="civ4-empty__hint">
            Try a wider radius, a longer lookback, or switch the evidence tier.
          </span>
        </div>
      ) : (
        <div className="civ4-list__cards">
          {evidence.map((e) => (
            <CompCard
              key={e.id}
              evidence={e}
              subject={props.subject}
              selected={e.id === props.selectedId}
              hovered={e.id === props.hoveredId}
              onHover={props.onHover}
              onSelect={props.onSelect}
              onOpenDossier={props.onOpenDossier}
            />
          ))}
        </div>
      )}
    </div>
  )
}
