import type { BuyerMatchV4Projection, RankedBuyer } from './buyer-match-v4.types'
import { buildBidSegments } from './buyerBidSegments'
import { fmtCurrency, fmtDate, fmtRange, humanDataState } from './formatters'
import { BuyerCard } from './BuyerCard'

interface Props {
  projection: BuyerMatchV4Projection | null
  selectedBuyerId: string | null
  shortlistIds: string[]
  onSelectBuyer: (id: string) => void
  onToggleShortlist: (id: string) => void
  onViewAllBuyers: () => void
}

export function MarketIntelligenceRail({
  projection,
  selectedBuyerId,
  shortlistIds,
  onSelectBuyer,
  onToggleShortlist,
  onViewAllBuyers,
}: Props) {
  const market = projection?.market
  const segments = buildBidSegments(projection)
  const topFive = (projection?.rankedBuyers ?? []).slice(0, 5)
  const institutional = (projection?.rankedBuyers ?? []).filter(
    (b) => b.institutionalStatus === 'VERIFIED_INSTITUTIONAL' || b.institutionalStatus === 'CORPORATE',
  ).slice(0, 3)
  const recentEvents = [...(projection?.purchaseEvents ?? [])]
    .sort((a, b) => {
      const at = a.purchaseDate ? new Date(a.purchaseDate).getTime() : 0
      const bt = b.purchaseDate ? new Date(b.purchaseDate).getTime() : 0
      return bt - at
    })
    .slice(0, 5)

  const buyerName = (id: string) =>
    projection?.rankedBuyers.find((b) => b.buyerId === id)?.buyerName ?? 'Unknown buyer'

  return (
    <aside className="bmv4-rail bmv4-rail--intel">
      <section className="bmv4-panel">
        <h3 className="bmv4-panel__title">Market Summary</h3>
        <p className={`bmv4-state bmv4-state--${(market?.dataState ?? 'no_local_data').toLowerCase()}`}>
          {humanDataState(market?.dataState ?? 'NO_LOCAL_DATA')}
        </p>
        <dl className="bmv4-metrics is-compact">
          <div><dt>Verified buyers</dt><dd className="bmv4-tabular">{market?.verifiedBuyerCount ?? '—'}</dd></div>
          <div><dt>High-fit</dt><dd className="bmv4-tabular">{market?.highFitBuyerCount ?? '—'}</dd></div>
          <div><dt>Repeat buyers</dt><dd className="bmv4-tabular">{market?.repeatBuyerCount ?? '—'}</dd></div>
          <div><dt>Purchase events</dt><dd className="bmv4-tabular">{market?.verifiedPurchaseEventCount ?? '—'}</dd></div>
        </dl>
      </section>

      <section className="bmv4-panel">
        <h3 className="bmv4-panel__title">Likely Bid Distribution</h3>
        <dl className="bmv4-bid-segments">
          <div><dt>High-fit likely bid</dt><dd className="bmv4-tabular">{fmtRange(segments.highFitLow, segments.highFitHigh)}</dd></div>
          <div><dt>Median likely bid</dt><dd className="bmv4-tabular is-headline">{fmtCurrency(segments.medianLikelyBid)}</dd></div>
          <div><dt>Institutional range</dt><dd className="bmv4-tabular">{fmtRange(segments.institutionalLow, segments.institutionalHigh)}</dd></div>
          <div className="is-muted"><dt>Broad observed range</dt><dd className="bmv4-tabular">{fmtRange(segments.broadLow, segments.broadHigh)}</dd></div>
        </dl>
      </section>

      <section className="bmv4-panel">
        <div className="bmv4-panel__head">
          <h3 className="bmv4-panel__title">Top Buyers</h3>
          <button type="button" className="bmv4-btn is-ghost is-sm" onClick={onViewAllBuyers}>View All Buyers</button>
        </div>
        <div className="bmv4-top-buyers">
          {topFive.map((b: RankedBuyer) => (
            <BuyerCard
              key={b.buyerId}
              buyer={b}
              selected={selectedBuyerId === b.buyerId}
              shortlisted={shortlistIds.includes(b.buyerId)}
              onSelect={() => onSelectBuyer(b.buyerId)}
              onToggleShortlist={() => onToggleShortlist(b.buyerId)}
            />
          ))}
          {topFive.length === 0 && <p className="bmv4-muted">No ranked buyers yet.</p>}
        </div>
      </section>

      {institutional.length > 0 && (
        <section className="bmv4-panel">
          <h3 className="bmv4-panel__title">Institutional Activity</h3>
          <ul className="bmv4-simple-list">
            {institutional.map((b) => <li key={b.buyerId}>{b.buyerName}</li>)}
          </ul>
        </section>
      )}

      <section className="bmv4-panel">
        <h3 className="bmv4-panel__title">Recent Purchases</h3>
        <ul className="bmv4-feed is-compact">
          {recentEvents.map((e) => (
            <li key={e.eventId}>
              <strong>{buyerName(e.buyerId)}</strong>
              <span>{fmtCurrency(e.purchasePrice)} · {fmtDate(e.purchaseDate)}</span>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  )
}