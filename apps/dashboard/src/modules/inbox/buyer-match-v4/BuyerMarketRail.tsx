import type { BuyerMatchSubjectContext, BuyerMatchV4Projection } from './buyer-match-v4.types'
import { AcquisitionContextRibbon } from './AcquisitionContextRibbon'
import { fmtCurrency, fmtRange, humanDataState, humanFallback } from './formatters'

interface Props {
  subject: BuyerMatchSubjectContext
  projection: BuyerMatchV4Projection | null
  loading: boolean
  refreshing: boolean
  compact?: boolean
}

export function BuyerMarketRail({ subject, projection, loading, refreshing, compact = false }: Props) {
  const market = projection?.market
  const dataState = market?.dataState ?? (loading ? 'REFRESHING' : 'NO_LOCAL_DATA')

  return (
    <aside className={`bmv4-market-rail${compact ? ' is-compact' : ''}`}>
      <div className="bmv4-subject-card">
        <div className="bmv4-subject-card__eyebrow">Subject Property</div>
        <div className="bmv4-subject-card__addr">{subject.canonicalAddress}</div>
        <div className="bmv4-subject-card__meta">
          {subject.assetLane && <span>{subject.assetLane}</span>}
          {subject.propertyId && <span className="bmv4-mono">{subject.propertyId}</span>}
        </div>
      </div>

      <section className="bmv4-pulse" aria-label="Buyer market pulse">
        <div className="bmv4-pulse__head">
          <span className="bmv4-eyebrow">Buyer Market Pulse</span>
          {refreshing && <span className="bmv4-pulse__refresh">Refreshing buyer market</span>}
        </div>
        {dataState === 'NO_LOCAL_DATA' ? (
          <p className="bmv4-state bmv4-state--muted">Local buyer evidence is unavailable.</p>
        ) : (
          <>
            <div className="bmv4-pulse__hero">
              <div>
                <span className="bmv4-pulse__count bmv4-tabular">{market?.verifiedBuyerCount ?? '—'}</span>
                <span className="bmv4-pulse__label">verified buyers</span>
              </div>
              <div>
                <span className="bmv4-pulse__count bmv4-tabular is-fit">{market?.highFitBuyerCount ?? '—'}</span>
                <span className="bmv4-pulse__label">high-fit</span>
              </div>
              <div>
                <span className="bmv4-pulse__count bmv4-tabular is-inst">{market?.institutionalBuyerCount ?? '—'}</span>
                <span className="bmv4-pulse__label">institutional</span>
              </div>
            </div>
            <div className="bmv4-pulse__bid">
              Likely bid {fmtRange(market?.likelyBidLow ?? null, market?.likelyBidHigh ?? null)}
            </div>
          </>
        )}
        <p className={`bmv4-state bmv4-state--${dataState.toLowerCase()}`}>{humanDataState(dataState)}</p>
      </section>

      <dl className="bmv4-metrics">
        <div><dt>90d activity</dt><dd className="bmv4-tabular">{market?.activeBuyerCount90d ?? '—'}</dd></div>
        <div><dt>180d activity</dt><dd className="bmv4-tabular">{market?.activeBuyerCount180d ?? '—'}</dd></div>
        <div><dt>Liquidity</dt><dd className="bmv4-tabular">{market?.liquidityScore ?? '—'}</dd></div>
        <div><dt>Demand</dt><dd className="bmv4-tabular">{market?.demandScore ?? '—'}</dd></div>
        <div><dt>Fallback</dt><dd>{humanFallback(market?.fallbackLevel ?? 'NONE')}</dd></div>
        <div><dt>Last refresh</dt><dd>{market?.refreshedAt ? new Date(market.refreshedAt).toLocaleString() : '—'}</dd></div>
      </dl>

      {!compact && <AcquisitionContextRibbon subject={subject} />}
    </aside>
  )
}