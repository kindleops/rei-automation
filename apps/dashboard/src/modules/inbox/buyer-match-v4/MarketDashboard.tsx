import type { BuyerMatchV4Projection } from './buyer-match-v4.types'
import { buildBidSegments } from './buyerBidSegments'
import { fmtCurrency, fmtPercentScore, fmtRange } from './formatters'

interface Props {
  projection: BuyerMatchV4Projection | null
}

export function MarketDashboard({ projection }: Props) {
  const market = projection?.market
  const buyers = projection?.rankedBuyers ?? []
  const segments = buildBidSegments(projection)

  const gradeCounts = buyers.reduce<Record<string, number>>((acc, b) => {
    const g = b.matchGrade ?? 'Other'
    acc[g] = (acc[g] ?? 0) + 1
    return acc
  }, {})

  const maxGrade = Math.max(1, ...Object.values(gradeCounts))

  return (
    <section className="bmv4-market-dashboard" aria-label="Buyer market dashboard">
      <div className="bmv4-market-dashboard__grid">
        <div className="bmv4-stat">
          <span className="bmv4-stat__label">Demand score</span>
          <span className="bmv4-stat__value bmv4-tabular">{fmtPercentScore(market?.demandScore)}</span>
        </div>
        <div className="bmv4-stat">
          <span className="bmv4-stat__label">Liquidity</span>
          <span className="bmv4-stat__value bmv4-tabular">{fmtPercentScore(market?.liquidityScore)}</span>
        </div>
        <div className="bmv4-stat">
          <span className="bmv4-stat__label">Median likely bid</span>
          <span className="bmv4-stat__value bmv4-tabular is-accent">{fmtCurrency(segments.medianLikelyBid)}</span>
        </div>
        <div className="bmv4-stat">
          <span className="bmv4-stat__label">High-fit range</span>
          <span className="bmv4-stat__value bmv4-tabular">{fmtRange(segments.highFitLow, segments.highFitHigh)}</span>
        </div>
      </div>

      <div className="bmv4-viz">
        <span className="bmv4-eyebrow">Buyer grade composition</span>
        <div className="bmv4-viz__bars">
          {Object.entries(gradeCounts).map(([grade, count]) => (
            <div key={grade} className="bmv4-viz__row">
              <span>{grade}</span>
              <div className="bmv4-viz__track">
                <div className="bmv4-viz__fill" style={{ width: `${(count / maxGrade) * 100}%` }} />
              </div>
              <span className="bmv4-tabular">{count}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bmv4-viz">
        <span className="bmv4-eyebrow">Institutional vs local share</span>
        <div className="bmv4-viz__split">
          <span>Institutional {market?.institutionalBuyerCount ?? 0}</span>
          <span>Local / other {(market?.verifiedBuyerCount ?? 0) - (market?.institutionalBuyerCount ?? 0)}</span>
        </div>
      </div>
    </section>
  )
}