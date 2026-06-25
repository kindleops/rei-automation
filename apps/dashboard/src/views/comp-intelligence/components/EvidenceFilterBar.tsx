import type { EvidenceFilters } from '../hooks/useCompEvidenceFilters'
import { hasBuyerIdentityData, hasInstitutionalData } from '../adapters/compDecisionProjection'
import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'

interface Props {
  filters: EvidenceFilters
  setFilters: (next: EvidenceFilters) => void
  evidence: CompTransactionEvidence[]
}

export function EvidenceFilterBar({ filters, setFilters, evidence }: Props) {
  const showBuyer = hasBuyerIdentityData(evidence)
  const showInstitutional = hasInstitutionalData(evidence)

  const universes = [...new Set(evidence.map((r) => r.routed_universe).filter(Boolean))] as string[]

  return (
    <div className="ci-filter-bar" role="toolbar" aria-label="Evidence filters">
      <select
        aria-label="Universe filter"
        value={filters.universe ?? ''}
        onChange={(e) => setFilters({ ...filters, universe: e.target.value || null })}
      >
        <option value="">All universes</option>
        {universes.map((u) => <option key={u} value={u}>{u}</option>)}
      </select>
      <select
        aria-label="Status filter"
        value={filters.status}
        onChange={(e) => setFilters({ ...filters, status: e.target.value as EvidenceFilters['status'] })}
      >
        <option value="all">All status</option>
        <option value="accepted">Accepted</option>
        <option value="review">Review</option>
        <option value="rejected">Rejected</option>
      </select>
      {showBuyer && (
        <select
          aria-label="Buyer archetype filter"
          value={filters.buyerArchetype ?? ''}
          onChange={(e) => setFilters({ ...filters, buyerArchetype: e.target.value || null })}
        >
          <option value="">All buyers</option>
          {[...new Set(evidence.map((r) => r.buyer_archetype).filter(Boolean))].map((b) => (
            <option key={b} value={b!}>{b}</option>
          ))}
        </select>
      )}
      {showInstitutional && (
        <label className="ci-filter-check">
          <input
            type="checkbox"
            checked={filters.packageOnly}
            onChange={(e) => setFilters({ ...filters, packageOnly: e.target.checked, singleAssetOnly: false })}
          />
          Package / institutional
        </label>
      )}
      <label className="ci-filter-check">
        <input
          type="checkbox"
          checked={filters.singleAssetOnly}
          onChange={(e) => setFilters({ ...filters, singleAssetOnly: e.target.checked, packageOnly: false })}
        />
        Single asset
      </label>
    </div>
  )
}