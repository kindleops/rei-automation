import type { CompMarketSummaryStats } from '../utils/comp-display'
import { fmtCurrency, fmtDate, fmtPpsf } from '../utils/comp-display'

interface Props {
  summary: CompMarketSummaryStats
}

export function CompMarketSummary({ summary }: Props) {
  const title = summary.isPreliminary ? 'Preliminary Comp Market' : 'Comp Market Summary'
  const range = summary.lowSale != null && summary.highSale != null
    ? `${fmtCurrency(summary.lowSale)} – ${fmtCurrency(summary.highSale)}`
    : '—'

  return (
    <section className="ci-market-summary" aria-label={title}>
      <header className="ci-market-summary__head">
        <h3>{title}</h3>
      </header>
      <div className="ci-market-summary__grid">
        <Pill label="Comps Found" value={String(summary.count)} />
        <Pill label="Median Sale" value={fmtCurrency(summary.medianSale)} highlight />
        <Pill label="Sale Range" value={range} />
        <Pill label="Median $/Sq Ft" value={fmtPpsf(summary.medianPpsf)} />
        <Pill
          label="Closest Comp"
          value={summary.closestSale ? fmtCurrency(summary.closestSale.sale_price) : '—'}
          sub={summary.closestSale?.geography.distance_miles != null
            ? `${summary.closestSale.geography.distance_miles.toFixed(2)} mi`
            : undefined}
        />
        <Pill label="Newest Sale" value={summary.newestSale ? fmtDate(summary.newestSale.sale_date) : '—'} />
      </div>
    </section>
  )
}

function Pill({
  label,
  value,
  sub,
  highlight,
}: {
  label: string
  value: string
  sub?: string
  highlight?: boolean
}) {
  return (
    <div className={`ci-market-pill${highlight ? ' is-highlight' : ''}`}>
      <span className="ci-market-pill__label">{label}</span>
      <strong className="ci-market-pill__value tabular-nums">{value}</strong>
      {sub && <span className="ci-market-pill__sub">{sub}</span>}
    </div>
  )
}