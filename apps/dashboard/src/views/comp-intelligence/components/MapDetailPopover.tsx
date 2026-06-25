import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'
import { fmtCurrency } from '../utils/mapGeo'

interface Props {
  row: CompTransactionEvidence
  onClose: () => void
  onViewEvidence: () => void
}

export function MapDetailPopover({ row, onClose, onViewEvidence }: Props) {
  return (
    <div className="ci-map-popover" role="dialog" aria-label="Comp detail">
      <button type="button" className="ci-map-popover__close" onClick={onClose} aria-label="Close">×</button>
      <div className="ci-map-popover__price tabular-nums">{fmtCurrency(row.sale_price)}</div>
      <div className="ci-map-popover__address">{row.address ?? 'Address unknown'}</div>
      <dl className="ci-map-popover__meta">
        <div><dt>Date</dt><dd>{row.sale_date ?? '—'}</dd></div>
        <div><dt>Universe</dt><dd>{row.routed_universe ?? '—'}</dd></div>
        <div><dt>Role</dt><dd>{row.evidence_role ?? '—'}</dd></div>
        <div><dt>Status</dt><dd>{row.qualification_status}</dd></div>
        <div><dt>ESS</dt><dd>{row.ess_contribution ?? '—'}</dd></div>
        <div><dt>Cluster</dt><dd>{row.transaction_cluster_id ?? '—'}</dd></div>
      </dl>
      <button type="button" className="ci-map-popover__action" onClick={onViewEvidence}>View evidence</button>
    </div>
  )
}