import type { RankedBuyer } from './buyer-match-v4.types'
import { buildMatchChips } from './buyerFilters'
import { fmtDate, fmtMiles, fmtRange, humanContactReadiness } from './formatters'

interface Props {
  buyer: RankedBuyer
  selected: boolean
  shortlisted: boolean
  onSelect: () => void
  onToggleShortlist: () => void
}

export function BuyerCard({ buyer, selected, shortlisted, onSelect, onToggleShortlist }: Props) {
  const chips = buildMatchChips(buyer)
  const isInst = buyer.institutionalStatus === 'VERIFIED_INSTITUTIONAL' || buyer.institutionalStatus === 'CORPORATE'

  return (
    <article
      className={`bmv4-buyer-card${selected ? ' is-selected' : ''}${isInst ? ' is-institutional' : ''}`}
    >
      <div className="bmv4-buyer-card__head">
        <button type="button" className="bmv4-buyer-card__select" onClick={onSelect}>
          <div className="bmv4-buyer-card__name">{buyer.buyerName}</div>
          <div className="bmv4-buyer-card__meta">{buyer.buyerArchetype ?? 'Unknown buyer type'}</div>
        </button>
        <div className="bmv4-buyer-card__badges">
          <span className={`bmv4-grade is-${(buyer.matchGrade ?? 'd').toLowerCase().replace('+', 'plus')}`}>
            {buyer.matchGrade ?? '—'}
          </span>
          {isInst && <span className="bmv4-badge is-inst">Institutional</span>}
          <button
            type="button"
            className={`bmv4-shortlist-btn${shortlisted ? ' is-on' : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggleShortlist() }}
            aria-label={shortlisted ? 'Remove from shortlist' : 'Add to shortlist'}
          >
            {shortlisted ? '★' : '☆'}
          </button>
        </div>
      </div>

      <div className="bmv4-buyer-card__scores bmv4-tabular">
        <span>Score {buyer.matchScore ?? '—'}</span>
        <span>Bid {fmtRange(buyer.likelyBidLow, buyer.likelyBidHigh)}</span>
        <span>90d {buyer.purchases90d ?? '—'}</span>
        <span>180d {buyer.purchases180d ?? '—'}</span>
      </div>

      <div className="bmv4-buyer-card__scores">
        <span>Nearest {fmtMiles(buyer.nearestPurchaseMiles)}</span>
        <span>Last {fmtDate(buyer.lastPurchaseAt)}</span>
      </div>

      <div className="bmv4-buyer-card__chips">
        {chips.map((c) => <span key={c} className="bmv4-chip">{c}</span>)}
      </div>

      <div className="bmv4-buyer-card__foot">
        <span className={`bmv4-contact is-${buyer.contactReadiness.toLowerCase()}`}>
          {humanContactReadiness(buyer.contactReadiness)}
        </span>
        {selected && <span className="bmv4-buyer-card__selected-label">Dossier open →</span>}
      </div>
    </article>
  )
}