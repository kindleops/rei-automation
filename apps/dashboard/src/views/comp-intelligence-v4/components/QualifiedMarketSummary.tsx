/**
 * Comp Intelligence V4 — qualified market summary.
 *
 * The headline statistics are computed STRICTLY from qualified pricing comps
 * (Phase 6). When there are none, the summary says so and never manufactures a
 * median/range. The raw discovered range is shown only as secondary context.
 */

import type { V4MarketSummary } from '../state/types'
import { fmtDate, fmtMiles, fmtMoneyShort, fmtNumber, fmtPpsf } from '../adapters/format'

interface QualifiedMarketSummaryProps {
  summary: V4MarketSummary
}

export function QualifiedMarketSummary({ summary }: QualifiedMarketSummaryProps) {
  const qualifiedRange =
    summary.qualifiedSaleLow != null && summary.qualifiedSaleHigh != null
      ? `${fmtMoneyShort(summary.qualifiedSaleLow)} – ${fmtMoneyShort(summary.qualifiedSaleHigh)}`
      : null
  const discoveredRange =
    summary.discoveredSaleLow != null && summary.discoveredSaleHigh != null
      ? `${fmtMoneyShort(summary.discoveredSaleLow)} – ${fmtMoneyShort(summary.discoveredSaleHigh)}`
      : '—'

  return (
    <section className="civ4-summary" aria-label="Qualified market summary">
      <div className="civ4-summary__counts">
        <Count label="Discovered" value={summary.discovered} tone="neutral" />
        <Count label="Qualified" value={summary.qualified} tone="qualified" />
        <Count label="Candidate" value={summary.candidate} tone="candidate" />
        <Count label="Review" value={summary.review} tone="review" />
        <Count label="Demand" value={summary.demandOnly} tone="demand" />
        <Count label="Excluded" value={summary.excluded} tone="excluded" />
      </div>

      {summary.hasQualified ? (
        <div className="civ4-summary__stats">
          <Stat label="Qualified median" value={fmtMoneyShort(summary.qualifiedMedianSale)} strong />
          <Stat label="Qualified range" value={qualifiedRange ?? '—'} strong />
          <Stat label="Median $/sf" value={fmtPpsf(summary.qualifiedMedianPpsf)} />
          <Stat label="Closest" value={fmtMiles(summary.closestQualifiedMiles)} />
          <Stat label="Newest" value={fmtDate(summary.newestQualifiedDate)} />
          <Stat
            label="Qualified ESS"
            value={summary.qualifiedEss != null ? fmtNumber(summary.qualifiedEss, 1) : '—'}
          />
        </div>
      ) : (
        <div className="civ4-summary__noqual">
          <div className="civ4-summary__noqualtitle">No qualified pricing comps</div>
          <div className="civ4-summary__noqualhint">
            No transaction passed canonical qualification for this subject, radius, and lookback.
            Showing candidate, review, demand-only, and excluded evidence below.
          </div>
        </div>
      )}

      <div className="civ4-summary__context">
        <Stat label="Discovered range (context)" value={discoveredRange} />
        {summary.largestExcludedSale != null && (
          <Stat
            label="Largest excluded"
            value={`${fmtMoneyShort(summary.largestExcludedSale)} · ${summary.largestExcludedReason ?? ''}`}
          />
        )}
      </div>
    </section>
  )
}

function Count(props: { label: string; value: number; tone: string }) {
  return (
    <div className={`civ4-count civ4-count--${props.tone}`}>
      <span className="civ4-count__value">{props.value}</span>
      <span className="civ4-count__label">{props.label}</span>
    </div>
  )
}

function Stat(props: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`civ4-stat ${props.strong ? 'civ4-stat--strong' : ''}`}>
      <span className="civ4-stat__label">{props.label}</span>
      <span className="civ4-stat__value">{props.value}</span>
    </div>
  )
}
