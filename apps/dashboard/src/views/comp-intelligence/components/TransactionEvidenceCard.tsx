import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'

interface Props {
  row: CompTransactionEvidence
  selected?: boolean
  hovered?: boolean
  expanded?: boolean
  cardRef?: (el: HTMLButtonElement | null) => void
  onSelect?: (id: string) => void
  onHover?: (id: string | null) => void
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

export function TransactionEvidenceCard({
  row,
  selected,
  hovered,
  expanded,
  cardRef,
  onSelect,
  onHover,
}: Props) {
  const id = row.candidate_id || row.property_id || ''
  const badge = evidenceBadge(row)

  return (
    <button
      ref={cardRef}
      type="button"
      data-evidence-id={id}
      className={[
        'ci-evidence-card',
        selected ? 'is-selected' : '',
        hovered ? 'is-hovered' : '',
        expanded ? 'is-expanded' : '',
        `ci-evidence-card--${badge.toLowerCase().replace(/\s+/g, '-')}`,
      ].filter(Boolean).join(' ')}
      onClick={() => onSelect?.(id)}
      onMouseEnter={() => onHover?.(id)}
      onMouseLeave={() => onHover?.(null)}
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
        <span>{row.routed_universe ?? row.canonical_asset_lane ?? '—'}</span>
      </div>
      <div className="ci-evidence-card__detail">
        {row.buyer && <span>{row.buyer}</span>}
        {row.transaction_channel && <span>{row.transaction_channel}</span>}
        <span>ESS {row.ess_contribution ?? '—'}</span>
        {row.similarity != null && <span>Match {Math.round(row.similarity)}</span>}
      </div>
      {row.rejection_review_reasons.length > 0 && (
        <p className="ci-evidence-card__reasons">{row.rejection_review_reasons.slice(0, expanded ? 6 : 2).join(' · ')}</p>
      )}
      {expanded && (
        <div className="ci-evidence-card__expanded">
          <div>Cluster: {row.transaction_cluster_id ?? '—'}</div>
          <div>Role: {row.evidence_role ?? '—'}</div>
          <div>Source: {row.source_lineage.source_table ?? '—'}</div>
        </div>
      )}
    </button>
  )
}