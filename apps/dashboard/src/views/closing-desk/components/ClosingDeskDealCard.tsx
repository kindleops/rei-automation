import type { ClosingCase } from '../../../domain/closing-desk/closing-desk.types'
import { ClosingHealthBadge } from './ClosingHealthBadge'
import { daysRemaining, emdState, formatDate, money, primaryBlocker, stageLabel } from '../closing-desk-utils'

export interface ClosingDeskDealCardProps {
  closingCase: ClosingCase
  selected?: boolean
  onOpen: (c: ClosingCase) => void
}

export function ClosingDeskDealCard({ closingCase: c, selected, onOpen }: ClosingDeskDealCardProps) {
  const blocker = primaryBlocker(c)
  const days = c.health.daysUntilClosing ?? daysRemaining(c.dates.scheduledClosingDate)
  const overdue = days !== null && days < 0

  return (
    <button
      type="button"
      className={`cd-deal-card ${selected ? 'is-selected' : ''} ${overdue ? 'is-overdue' : ''}`}
      onClick={() => onOpen(c)}
      data-testid="cd-card"
      data-case-id={c.identity.closingCaseId}
      aria-pressed={selected}
    >
      <div className="cd-deal-card__head">
        <span className="cd-deal-card__address">{c.displayName}</span>
        {days !== null ? (
          <span className={`cd-deal-card__days ${overdue ? 'is-overdue' : days <= 7 ? 'is-soon' : ''}`}>
            {overdue ? `${Math.abs(days)}d overdue` : `${days}d`}
          </span>
        ) : null}
      </div>

      <div className="cd-deal-card__meta">
        <span>{c.market ?? '—'}</span>
        <span>·</span>
        <span>{c.sellerName ?? 'Unknown seller'}</span>
      </div>

      <div className="cd-deal-card__stage-row">
        <span className="cd-deal-card__stage">{stageLabel(c.universalStage)}</span>
        <ClosingHealthBadge health={c.health} />
      </div>

      {blocker ? (
        <div className="cd-deal-card__blocker" data-sev={blocker.severity}>
          <span className="cd-deal-card__blocker-label">Blocker</span>
          <span className="cd-deal-card__blocker-text">{blocker.title}</span>
          <span className="cd-deal-card__blocker-owner">{blocker.owner ?? c.health.responsibleParty ?? 'Unassigned'}</span>
        </div>
      ) : null}

      {c.health.nextRequiredAction ? (
        <p className="cd-deal-card__action">{c.health.nextRequiredAction}</p>
      ) : null}

      <div className="cd-deal-card__financials">
        <div>
          <span className="k">Contract</span>
          <span className="v">{money(c.financials.sellerContractPrice) ?? '—'}</span>
        </div>
        <div>
          <span className="k">Expected</span>
          <span className="v">{money(c.financials.expectedGrossRevenue) ?? '—'}</span>
        </div>
        <div>
          <span className="k">Close</span>
          <span className="v">{formatDate(c.dates.scheduledClosingDate) ?? 'TBD'}</span>
        </div>
        <div>
          <span className="k">EMD</span>
          <span className="v">{emdState(c)}</span>
        </div>
      </div>
    </button>
  )
}