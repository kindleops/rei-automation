import type { ClosingCase, ClosingBoardColumn } from '../../../domain/closing-desk/closing-desk.types'
import { CLOSING_BOARD_COLUMNS, LANE_GUIDANCE } from '../../../domain/closing-desk/closing-board'
import { ClosingDeskDealCard } from './ClosingDeskDealCard'

function laneHealth(cases: ClosingCase[]): 'critical' | 'warn' | 'healthy' | 'empty' {
  if (cases.length === 0) return 'empty'
  if (cases.some((c) => c.health.band === 'critical')) return 'critical'
  if (cases.some((c) => c.health.band === 'at_risk' || c.health.band === 'watch')) return 'warn'
  return 'healthy'
}

export interface ClosingDeskBoardProps {
  grouped: Map<ClosingBoardColumn, ClosingCase[]>
  selectedId: string | null
  mobileLane: ClosingBoardColumn | 'all'
  onOpenCase: (c: ClosingCase) => void
}

export function ClosingDeskBoard({ grouped, selectedId, mobileLane, onOpenCase }: ClosingDeskBoardProps) {
  const columns =
    mobileLane === 'all'
      ? CLOSING_BOARD_COLUMNS
      : CLOSING_BOARD_COLUMNS.filter((c) => c.id === mobileLane)

  return (
    <div className="cd-pipeline" data-testid="cd-board" role="region" aria-label="Closing lifecycle pipeline">
      <span className="cd-pipeline__scroll-hint" aria-hidden>Scroll →</span>
      <div className="cd-pipeline__track">
        {columns.map((col, idx) => {
          const cases = grouped.get(col.id) ?? []
          const guidance = LANE_GUIDANCE[col.id]
          const health = laneHealth(cases)
          return (
            <div
              className={`cd-lane ${col.id === 'issues_curative' ? 'is-curative' : ''} ${cases.length === 0 ? 'is-empty' : ''} cd-lane--${health}`}
              key={col.id}
              data-testid={`cd-lane-${col.id}`}
            >
              {idx > 0 ? <span className="cd-lane__connector" aria-hidden /> : null}
              <div className="cd-lane__head">
                <div className="cd-lane__title-wrap">
                  <span className="cd-lane__label">{col.label}</span>
                  <span className={`cd-lane__health cd-lane__health--${health}`} aria-hidden />
                </div>
                <span className="cd-lane__count" data-testid={`cd-lane-count-${col.id}`}>{cases.length}</span>
              </div>
              <p className="cd-lane__summary">{guidance.hint}</p>
              <div className="cd-lane__body">
                {cases.length === 0 ? (
                  <div className="cd-lane__empty">
                    <span>No cases</span>
                    <small title={guidance.qualifies}>Entry criteria in lifecycle guide</small>
                  </div>
                ) : (
                  cases.map((c) => (
                    <ClosingDeskDealCard
                      key={c.identity.closingCaseId}
                      closingCase={c}
                      selected={selectedId === c.identity.closingCaseId}
                      onOpen={onOpenCase}
                    />
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}