import type { CompIntelligenceDecisionProjection } from '../../../domain/comp-intelligence/v3-types'

interface Props {
  projection: CompIntelligenceDecisionProjection | null
  marketValue: number | null
  marketClassification: string
  conservativeBuyerExit: number | null
  shadowOffer: number | null
  authorizedOffer: number | null
}

const fmt = (n: number | null | undefined) =>
  n != null
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
    : '—'

export function CompDecisionOverview({
  projection,
  marketValue,
  marketClassification,
  conservativeBuyerExit,
  shadowOffer,
  authorizedOffer,
}: Props) {
  const marketLabel = marketClassification === 'QUALIFIED'
    ? 'Qualified Market Value'
    : marketClassification === 'SCENARIO' || marketClassification === 'PROVISIONAL_SCENARIO'
      ? 'Scenario Market Value'
      : 'Market Value Unavailable'

  const offerLabel = authorizedOffer != null
    ? 'Live Authorized Offer'
    : shadowOffer != null
      ? 'Shadow Recommended Offer'
      : 'Offer Unavailable'

  const offerValue = authorizedOffer ?? shadowOffer

  const blockers = projection?.strategy_ranking?.ranked
    ?.flatMap((s) => s.blockers ?? [])
    .filter(Boolean)
    .slice(0, 3) ?? []

  return (
    <section className="ci-decision-overview" aria-label="Decision overview">
      <div className="ci-metric-grid">
        <article className="ci-metric-card">
          <span className="ci-metric-label">{marketLabel}</span>
          <span className="ci-metric-value tabular-nums">{fmt(marketValue)}</span>
          <span className="ci-metric-meta">{marketClassification}</span>
        </article>
        <article className="ci-metric-card">
          <span className="ci-metric-label">Conservative Buyer Exit</span>
          <span className="ci-metric-value tabular-nums">{fmt(conservativeBuyerExit)}</span>
        </article>
        <article className="ci-metric-card">
          <span className="ci-metric-label">{offerLabel}</span>
          <span className={`ci-metric-value tabular-nums ${authorizedOffer == null && shadowOffer != null ? 'ci-metric-value--shadow' : ''}`}>
            {fmt(offerValue)}
          </span>
          {authorizedOffer == null && shadowOffer != null && (
            <span className="ci-metric-meta">Underwritten shadow — not live authorized</span>
          )}
        </article>
        <article className="ci-metric-card">
          <span className="ci-metric-label">Primary Strategy</span>
          <span className="ci-metric-value">{projection?.primary_strategy ?? '—'}</span>
          <span className="ci-metric-meta">Backup: {projection?.backup_strategy ?? '—'}</span>
        </article>
      </div>

      <div className="ci-decision-meta">
        <div>
          <span className="ci-meta-label">Evidence depth</span>
          <span>{(projection?.evidence_depth?.total_clean_accepted_transaction_count as number) ?? '—'} clean / ESS {(projection?.dominant_model_ess as number) ?? '—'}</span>
        </div>
        <div>
          <span className="ci-meta-label">Model disagreement</span>
          <span>{projection?.model_disagreement != null ? `${Math.round(projection.model_disagreement)}%` : '—'}</span>
        </div>
        <div>
          <span className="ci-meta-label">Anomaly status</span>
          <span>{projection?.anomaly_materiality?.transaction_anomaly_material ? 'Material' : 'Clear'}</span>
        </div>
        <div>
          <span className="ci-meta-label">Largest blocker</span>
          <span>{blockers[0] ?? projection?.execution_state ?? '—'}</span>
        </div>
      </div>
    </section>
  )
}