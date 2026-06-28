import type { BuyerMatchV4Projection } from './buyer-match-v4.types'
import { fmtCurrency, fmtRange } from './formatters'

interface Props {
  projection: BuyerMatchV4Projection | null
  loading: boolean
  selectedBuyerId: string | null
  gradeFilter: 'all' | 'A+' | 'A' | 'B'
  onSelectBuyer: (buyerId: string) => void
  onGradeFilter: (grade: 'all' | 'A+' | 'A' | 'B') => void
}

export function RankedBuyerPanel({
  projection,
  loading,
  selectedBuyerId,
  gradeFilter,
  onSelectBuyer,
  onGradeFilter,
}: Props) {
  const dataState = projection?.market.dataState
  const buyers = (projection?.rankedBuyers ?? []).filter((b) => {
    if (gradeFilter === 'all') return true
    return b.matchGrade === gradeFilter
  })

  if (loading && !projection) {
    return <div className="bmv4-buyers bmv4-buyers--loading">Loading buyer market…</div>
  }

  if (dataState === 'NO_LOCAL_DATA') {
    return (
      <div className="bmv4-buyers bmv4-buyers--empty">
        <h3>Local buyer evidence is unavailable</h3>
        <p>No verified local buyers were found for this property. State- or market-level counts are not shown as local demand.</p>
      </div>
    )
  }

  if (dataState === 'SUBJECT_COORDINATES_REQUIRED' && buyers.length === 0) {
    return (
      <div className="bmv4-buyers bmv4-buyers--empty">
        <h3>Buyer match limited</h3>
        <p>Subject coordinates are required to rank geographic buyer fit.</p>
      </div>
    )
  }

  return (
    <section className="bmv4-buyers">
      <div className="bmv4-buyers__toolbar">
        <h3 className="bmv4-buyers__title">Ranked Buyers</h3>
        {dataState === 'PARTIAL' && <span className="bmv4-badge is-partial">Partial evidence</span>}
        <div className="bmv4-buyers__filters">
          {(['all', 'A+', 'A', 'B'] as const).map((g) => (
            <button
              key={g}
              type="button"
              className={`bmv4-filter${gradeFilter === g ? ' is-active' : ''}`}
              onClick={() => onGradeFilter(g)}
            >
              {g === 'all' ? 'All' : g}
            </button>
          ))}
        </div>
      </div>

      <div className="bmv4-buyers__list">
        {buyers.length === 0 ? (
          <p className="bmv4-muted">No buyers matched current filters.</p>
        ) : (
          buyers.map((buyer) => (
            <button
              key={buyer.buyerId}
              type="button"
              className={`bmv4-buyer-card${selectedBuyerId === buyer.buyerId ? ' is-selected' : ''}${
                buyer.institutionalStatus === 'VERIFIED_INSTITUTIONAL' ? ' is-institutional' : ''
              }`}
              onClick={() => onSelectBuyer(buyer.buyerId)}
            >
              <div className="bmv4-buyer-card__head">
                <div>
                  <div className="bmv4-buyer-card__name">{buyer.buyerName}</div>
                  <div className="bmv4-buyer-card__meta">{buyer.buyerArchetype ?? 'Unknown'}</div>
                </div>
                <span className={`bmv4-grade is-${(buyer.matchGrade ?? 'd').toLowerCase().replace('+', 'plus')}`}>
                  {buyer.matchGrade ?? '—'}
                </span>
              </div>
              <div className="bmv4-buyer-card__scores">
                <span className="bmv4-tabular">Score {buyer.matchScore ?? '—'}</span>
                <span>Bid {fmtRange(buyer.likelyBidLow, buyer.likelyBidHigh)}</span>
              </div>
              {buyer.reasonSummary.length > 0 && (
                <ul className="bmv4-buyer-card__reasons">
                  {buyer.reasonSummary.map((r) => <li key={r}>{r}</li>)}
                </ul>
              )}
              <div className="bmv4-buyer-card__foot">
                <span>180d: {buyer.purchases180d ?? '—'}</span>
                <span>Contact: {buyer.contactReadiness === 'ENRICHMENT_REQUIRED' ? 'Enrichment required' : buyer.contactReadiness}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </section>
  )
}