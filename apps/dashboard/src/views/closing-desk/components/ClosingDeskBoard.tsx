import type { ClosingCase } from '../../../domain/closing-desk/closing-desk.types'
import { CLOSING_BOARD_COLUMNS, LANE_GUIDANCE } from '../../../domain/closing-desk/closing-board'
import { ClosingHealthBadge } from './ClosingHealthBadge'

const money = (v: number) => `$${Math.round(v).toLocaleString()}`

function CaseCard({ c, onOpen }: { c: ClosingCase; onOpen: (c: ClosingCase) => void }) {
  return (
    <button type="button" className="cd-card" onClick={() => onOpen(c)} data-testid="cd-card">
      <span className="cd-card__title">{c.displayName}</span>
      <span className="cd-card__sub">{c.sellerName ?? 'Unknown seller'} · {c.market ?? '—'}</span>
      <span className="cd-card__row">
        <ClosingHealthBadge health={c.health} />
        <span className="cd-card__money">
          {c.financials.sellerContractPrice !== null ? money(c.financials.sellerContractPrice) : '—'}
        </span>
      </span>
      {c.health.nextRequiredAction ? (
        <span className="cd-card__sub cd-card__action">→ {c.health.nextRequiredAction}</span>
      ) : null}
    </button>
  )
}

export interface ClosingDeskBoardProps {
  grouped: Map<string, ClosingCase[]>
  onOpenCase: (c: ClosingCase) => void
}

export function ClosingDeskBoard({ grouped, onOpenCase }: ClosingDeskBoardProps) {
  return (
    <div className="cd-board" data-testid="cd-board" role="region" aria-label="Closing lifecycle board">
      {CLOSING_BOARD_COLUMNS.map((col) => {
        const cases = grouped.get(col.id) ?? []
        const guidance = LANE_GUIDANCE[col.id]
        return (
          <div
            className={`cd-col ${col.id === 'issues_curative' ? 'is-curative' : ''} ${cases.length === 0 ? 'is-empty' : ''}`}
            key={col.id}
            data-testid={`cd-lane-${col.id}`}
          >
            <div className="cd-col__head">
              <span className="cd-col__label">{col.label}</span>
              <span className="cd-col__count" aria-label={`${cases.length} cases`}>{cases.length}</span>
            </div>
            <p className="cd-col__hint">{guidance.hint}</p>
            <div className="cd-col__body">
              {cases.length === 0 ? (
                <div className="cd-col__empty">
                  <span className="cd-col__empty-label">No cases</span>
                  <span className="cd-col__qualifies">{guidance.qualifies}</span>
                </div>
              ) : (
                cases.map((c) => <CaseCard key={c.identity.closingCaseId} c={c} onOpen={onOpenCase} />)
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}