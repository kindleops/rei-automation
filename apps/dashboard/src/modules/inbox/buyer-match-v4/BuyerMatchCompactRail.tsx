import type { BuyerMatchV4Projection } from './buyer-match-v4.types'
import { fmtRange, humanDataState } from './formatters'

interface Props {
  projection: BuyerMatchV4Projection | null
  shortlistCount?: number
  onOpenFull: () => void
}

export function BuyerMatchCompactRail({ projection, shortlistCount = 0, onOpenFull }: Props) {
  const market = projection?.market
  const topThree = (projection?.rankedBuyers ?? []).slice(0, 3)

  return (
    <div className="bmv4-compact-rail">
      <div className="bmv4-compact-rail__head">
        <span className="bmv4-eyebrow">Buyer Match</span>
        <span className="bmv4-compact-rail__state">{humanDataState(market?.dataState ?? 'NO_LOCAL_DATA')}</span>
        {shortlistCount > 0 && <span className="bmv4-nav__count">{shortlistCount}</span>}
      </div>
      <div className="bmv4-compact-rail__stats">
        <div><span className="bmv4-tabular">{market?.verifiedBuyerCount ?? '—'}</span><label>Verified buyers</label></div>
        <div><span className="bmv4-tabular">{market?.demandScore ?? '—'}</span><label>Demand</label></div>
        <div><span>{fmtRange(market?.likelyBidLow ?? null, market?.likelyBidHigh ?? null)}</span><label>Likely bid</label></div>
        <div><span className="bmv4-tabular">{market?.institutionalBuyerCount ?? '—'}</span><label>Institutional</label></div>
      </div>
      <ol className="bmv4-compact-rail__top">
        {topThree.map((b, i) => (
          <li key={b.buyerId}>
            <span className="bmv4-compact-rail__rank">{i + 1}</span>
            <span className="bmv4-compact-rail__name">{b.buyerName}</span>
            <span className="bmv4-grade is-sm">{b.matchGrade}</span>
          </li>
        ))}
        {topThree.length === 0 && <li className="bmv4-muted">No local buyers ranked</li>}
      </ol>
      <button type="button" className="bmv4-open-full" onClick={onOpenFull}>
        Open Full Buyer Match
      </button>
    </div>
  )
}