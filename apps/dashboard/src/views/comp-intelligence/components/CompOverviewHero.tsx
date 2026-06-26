import type { CompIntelligenceDecisionProjection } from '../../../domain/comp-intelligence/v3-types'

const fmt = (n: number | null | undefined) =>
  n != null
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
    : null

interface Props {
  isDegraded: boolean
  isAuthoritative: boolean
  projection: CompIntelligenceDecisionProjection | null
  marketValue: number | null
  marketClassification: string
  conservativeBuyerExit: number | null
  shadowOffer: number | null
  authorizedOffer: number | null
  evidenceCount: number
  mappedCount: number
  searchMode?: string | null
  subjectResolved: boolean
  primaryStrategy?: string | null
}

export function CompOverviewHero({
  isDegraded,
  isAuthoritative,
  projection,
  marketValue,
  marketClassification,
  conservativeBuyerExit,
  shadowOffer,
  authorizedOffer,
  evidenceCount,
  mappedCount,
  searchMode,
  subjectResolved,
  primaryStrategy,
}: Props) {
  if (isDegraded || !isAuthoritative) {
    return (
      <section className="ci-hero ci-hero--degraded" aria-label="Degraded decision state">
        <h2 className="ci-hero__title">Decision temporarily unavailable</h2>
        <p className="ci-hero__subtitle">
          Recovered {evidenceCount} transaction{evidenceCount === 1 ? '' : 's'} ({mappedCount} mapped).
          Evidence is non-authoritative and cannot produce official valuation or offers.
        </p>
        <div className="ci-hero__grid ci-hero__grid--degraded">
          <div className="ci-hero__metric">
            <span className="ci-hero__label">Evidence recovered</span>
            <strong className="ci-hero__value tabular-nums">{evidenceCount}</strong>
          </div>
          <div className="ci-hero__metric">
            <span className="ci-hero__label">Search mode</span>
            <strong className="ci-hero__value">{searchMode?.replace(/_/g, ' ') ?? '—'}</strong>
          </div>
          <div className="ci-hero__metric">
            <span className="ci-hero__label">Subject resolution</span>
            <strong className="ci-hero__value">{subjectResolved ? 'Exact coordinates' : 'Market-level'}</strong>
          </div>
          <div className="ci-hero__metric">
            <span className="ci-hero__label">Not authorized</span>
            <strong className="ci-hero__value">Valuation · Offers · ESS</strong>
          </div>
        </div>
      </section>
    )
  }

  const mv = fmt(marketValue)
  const exit = fmt(conservativeBuyerExit)
  const offer = fmt(authorizedOffer ?? shadowOffer)

  return (
    <section className="ci-hero ci-hero--v3" aria-label="Decision overview">
      <div className="ci-hero__grid">
        <div className="ci-hero__metric ci-hero__metric--primary">
          <span className="ci-hero__label">Market value</span>
          <strong className="ci-hero__value tabular-nums">{mv ?? '—'}</strong>
          <span className="ci-hero__meta">{marketClassification}</span>
        </div>
        <div className="ci-hero__metric">
          <span className="ci-hero__label">Buyer exit</span>
          <strong className="ci-hero__value tabular-nums">{exit ?? '—'}</strong>
        </div>
        <div className="ci-hero__metric">
          <span className="ci-hero__label">{authorizedOffer != null ? 'Authorized offer' : 'Shadow offer'}</span>
          <strong className="ci-hero__value tabular-nums">{offer ?? '—'}</strong>
        </div>
        <div className="ci-hero__metric">
          <span className="ci-hero__label">Primary strategy</span>
          <strong className="ci-hero__value">{primaryStrategy ?? projection?.strategy_ranking?.primary_strategy ?? '—'}</strong>
          <span className="ci-hero__meta">Confidence {projection?.final_confidence != null ? `${Math.round(projection.final_confidence)}%` : '—'}</span>
        </div>
      </div>
    </section>
  )
}