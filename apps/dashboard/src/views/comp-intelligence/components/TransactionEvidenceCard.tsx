import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'

interface Props {
  row: CompTransactionEvidence
  selected?: boolean
  onSelect?: (id: string) => void
}

const fmt = (n: number | null) =>
  n != null
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
    : '—'

function evidenceBadge(row: CompTransactionEvidence): string {
  if (row.qualification_status === 'REJECTED' || row.qualification_status === 'QUARANTINED') return 'REJECTED'
  if (row.pricing_eligibility) return 'PRICING EVIDENCE'
  if (row.demand_eligibility && !row.pricing_eligibility) return 'DEMAND ONLY'
  if (/review/i.test(row.qualification_status)) return 'REVIEW'
  return 'CONTEXT ONLY'
}

export function TransactionEvidenceCard({ row, selected, onSelect }: Props) {
  const id = row.candidate_id || row.property_id || ''
  const badge = evidenceBadge(row)

  return (
    <button
      type="button"
      className={`ci-evidence-card ${selected ? 'is-selected' : ''} ci-evidence-card--${badge.toLowerCase().replace(/\s+/g, '-')}`}
      onClick={() => onSelect?.(id)}
      aria-pressed={selected}
    >
      <div className="ci-evidence-card__top">
        <span className="ci-evidence-card__price tabular-nums">{fmt(row.sale_price)}</span>
        <span className="ci-chip">{badge}</span>
      </div>
      <div className="ci-evidence-card__address">{row.address ?? 'Address unknown'}</div>
      <div className="ci-evidence-card__meta">
        <span>{row.sale_date ?? '—'}</span>
        <span>{row.geography.distance_miles != null ? `${row.geography.distance_miles.toFixed(2)} mi` : '—'}</span>
        <span>{row.canonical_asset_lane ?? '—'}</span>
      </div>
      <div className="ci-evidence-card__detail">
        <span>{row.buyer ?? 'Buyer unknown'}</span>
        <span>{row.transaction_channel ?? '—'}</span>
        <span>{row.routed_universe ?? '—'}</span>
        <span>ESS {row.ess_contribution ?? '—'}</span>
      </div>
      {row.rejection_review_reasons.length > 0 && (
        <p className="ci-evidence-card__reasons">{row.rejection_review_reasons.join(' · ')}</p>
      )}
    </button>
  )
}