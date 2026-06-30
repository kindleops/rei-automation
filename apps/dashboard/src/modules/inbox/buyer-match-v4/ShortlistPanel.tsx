import type { RankedBuyer } from './buyer-match-v4.types'
import { fmtRange } from './formatters'
import { BuyerCard } from './BuyerCard'
import { BuyerDossier } from './BuyerDossier'
import type { PurchaseEvent } from './buyer-match-v4.types'

interface Props {
  shortlistedBuyers: RankedBuyer[]
  selectedBuyerId: string | null
  events: PurchaseEvent[]
  onSelectBuyer: (id: string) => void
  onToggleShortlist: (id: string) => void
  onBrowseBuyers: () => void
}

export function ShortlistPanel({
  shortlistedBuyers,
  selectedBuyerId,
  events,
  onSelectBuyer,
  onToggleShortlist,
  onBrowseBuyers,
}: Props) {
  const selected = shortlistedBuyers.find((b) => b.buyerId === selectedBuyerId) ?? null

  if (shortlistedBuyers.length === 0) {
    return (
      <div className="bmv4-shortlist-layout">
        <section className="bmv4-shortlist-empty">
          <h3>Session shortlist — not yet saved</h3>
          <p>Compare the buyers most likely to close on this subject. Shortlist buyers from the directory to compare likely bid, activity, and contact readiness side by side.</p>
          <ul className="bmv4-shortlist-criteria">
            <li>High match grade (A / A+)</li>
            <li>Recent purchase activity near subject</li>
            <li>Institutional or repeat buyer with local footprint</li>
            <li>Contact readiness when available</li>
          </ul>
          <button type="button" className="bmv4-btn" onClick={onBrowseBuyers}>Browse Buyers</button>
        </section>
      </div>
    )
  }

  return (
    <div className="bmv4-shortlist-layout">
      <aside className="bmv4-rail bmv4-rail--shortlist-summary">
        <h3>Session shortlist — not yet saved</h3>
        <p className="bmv4-tabular">{shortlistedBuyers.length} buyers shortlisted</p>
        <table className="bmv4-compare-table">
          <thead>
            <tr><th>Buyer</th><th>Grade</th><th>Bid</th><th>Contact</th><th /></tr>
          </thead>
          <tbody>
            {shortlistedBuyers.map((b) => (
              <tr key={b.buyerId} className={selectedBuyerId === b.buyerId ? 'is-selected' : ''}>
                <td><button type="button" className="bmv4-link" onClick={() => onSelectBuyer(b.buyerId)}>{b.buyerName}</button></td>
                <td>{b.matchGrade}</td>
                <td className="bmv4-tabular">{fmtRange(b.likelyBidLow, b.likelyBidHigh)}</td>
                <td>{b.contactReadiness}</td>
                <td>
                  <button type="button" className="bmv4-btn is-ghost is-sm" onClick={() => onToggleShortlist(b.buyerId)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </aside>

      <main className="bmv4-shortlist-main">
        <div className="bmv4-buyers__list">
          {shortlistedBuyers.map((b) => (
            <BuyerCard
              key={b.buyerId}
              buyer={b}
              selected={selectedBuyerId === b.buyerId}
              shortlisted
              onSelect={() => onSelectBuyer(b.buyerId)}
              onToggleShortlist={() => onToggleShortlist(b.buyerId)}
            />
          ))}
        </div>
      </main>

      <BuyerDossier
        buyer={selected}
        events={events}
        shortlisted
        onToggleShortlist={() => selected && onToggleShortlist(selected.buyerId)}
      />
    </div>
  )
}