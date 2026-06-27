import type { CompIntelligenceDecisionProjection } from '../../../domain/comp-intelligence/v3-types'
import { fmtCurrency } from '../utils/comp-display'

interface Props {
  projection: CompIntelligenceDecisionProjection | null
  isAuthoritative: boolean
  supportingCompCount?: number
}

export function OfficialDecisionSection({
  projection,
  isAuthoritative,
  supportingCompCount = 0,
}: Props) {
  if (!isAuthoritative || !projection) {
    return (
      <section className="ci-official-unavailable" aria-label="Official underwriting status">
        <p>Official underwriting is temporarily unavailable. Comp research remains available.</p>
      </section>
    )
  }

  const qmv = projection.value_contract?.qualified_market_value
  const buyerExit = projection.value_contract?.qualified_buyer_exit?.conservative
  const shadowOffer = projection.offer_authorization?.authorized_recommended_offer
    ?? projection.offer_authorization?.scenario_recommended_offer
  const primaryStrategy = projection.strategy_ranking?.primary_strategy
    ?? projection.execution_state_basis?.basis_strategy
  const confidence = projection.final_confidence
  const executionState = projection.execution_state

  return (
    <section className="ci-official-decision" aria-label="Official acquisition decision">
      <header className="ci-official-decision__head">
        <h3>Official Acquisition Decision</h3>
        <span className="ci-official-decision__badge">V3 qualified</span>
      </header>
      <div className="ci-official-decision__grid">
        <DecisionMetric label="Qualified Market Value" value={formatRange(qmv)} />
        <DecisionMetric label="Conservative Buyer Exit" value={fmtCurrency(buyerExit)} />
        <DecisionMetric label="Recommended Shadow Offer" value={fmtCurrency(shadowOffer)} highlight />
        <DecisionMetric label="Primary Strategy" value={humanizeStrategy(primaryStrategy)} />
        <DecisionMetric label="Confidence" value={confidence != null ? `${Math.round(confidence)}%` : '—'} />
        <DecisionMetric label="Supporting Comps" value={String(supportingCompCount)} />
        {executionState === 'DATA_REQUIRED' && (
          <DecisionMetric label="Data Required" value="Yes" warn />
        )}
        {executionState === 'REVIEW_REQUIRED' && (
          <DecisionMetric label="Review Required" value="Yes" warn />
        )}
      </div>
    </section>
  )
}

function formatRange(range: { low?: number | null; mid?: number | null; high?: number | null } | null | undefined): string {
  if (!range) return '—'
  const mid = range.mid ?? range.high ?? range.low
  if (mid == null) return '—'
  if (range.low != null && range.high != null && range.low !== range.high) {
    return `${fmtCurrency(range.low)} – ${fmtCurrency(range.high)}`
  }
  return fmtCurrency(mid)
}

function humanizeStrategy(value: string | null | undefined): string {
  if (!value) return '—'
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function DecisionMetric({
  label,
  value,
  highlight,
  warn,
}: {
  label: string
  value: string
  highlight?: boolean
  warn?: boolean
}) {
  return (
    <div className={`ci-decision-metric${highlight ? ' is-highlight' : ''}${warn ? ' is-warn' : ''}`}>
      <span className="ci-decision-metric__label">{label}</span>
      <strong className="ci-decision-metric__value tabular-nums">{value}</strong>
    </div>
  )
}