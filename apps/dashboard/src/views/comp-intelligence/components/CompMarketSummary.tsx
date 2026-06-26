import type { CompMarketSummaryStats } from '../utils/comp-display'
import { fmtCurrency, fmtDate, fmtPpsf } from '../utils/comp-display'

interface Props {
  summary: CompMarketSummaryStats
}

export function CompMarketSummary({ summary }: Props) {
  const title = summary.isPreliminary ? 'Preliminary Comp Market' : 'Comp Market Summary'

  return (
    <section className="ci-market-summary" aria-label={title}>
      <header className="ci-market-summary__head">
        <h3>{title}</h3>
        {summary.isPreliminary && (
          <span className="ci-market-summary__badge">Raw comp statistics · not official valuation</span>
        )}
      </header>
      <div className="ci-market-summary__grid">
        <Stat label="Comps found" value={String(summary.count)} />
        <Stat label="Closest sale" value={summary.closestSale ? fmtCurrency(summary.closestSale.sale_price) : '—'} sub={summary.closestSale?.geography.distance_miles != null ? `${summary.closestSale.geography.distance_miles.toFixed(2)} mi` : undefined} />
        <Stat label="Newest sale" value={summary.newestSale ? fmtDate(summary.newestSale.sale_date) : '—'} />
        <Stat label="Low sale" value={fmtCurrency(summary.lowSale)} />
        <Stat label="Median sale" value={fmtCurrency(summary.medianSale)} highlight />
        <Stat label="High sale" value={fmtCurrency(summary.highSale)} />
        <Stat label="Median PPSF" value={fmtPpsf(summary.medianPpsf)} />
        <Stat label="Search radius" value={`${summary.radiusMiles} mi`} />
        <Stat label="Date range" value={`${summary.monthsBack} months`} />
      </div>
    </section>
  )
}

function Stat({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className={`ci-market-stat${highlight ? ' is-highlight' : ''}`}>
      <span className="ci-market-stat__label">{label}</span>
      <strong className="ci-market-stat__value tabular-nums">{value}</strong>
      {sub && <span className="ci-market-stat__sub">{sub}</span>}
    </div>
  )
}