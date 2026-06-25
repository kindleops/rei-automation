import { useMemo, useState } from 'react'
import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'

export type EvidenceMapMode = 'PRICING' | 'DEMAND' | 'RISK'

export interface EvidenceFilters {
  universe: string | null
  evidenceRole: string | null
  transactionChannel: string | null
  buyerArchetype: string | null
  status: 'all' | 'accepted' | 'review' | 'rejected'
  packageOnly: boolean
  singleAssetOnly: boolean
  source: string | null
}

const DEFAULT_FILTERS: EvidenceFilters = {
  universe: null,
  evidenceRole: null,
  transactionChannel: null,
  buyerArchetype: null,
  status: 'all',
  packageOnly: false,
  singleAssetOnly: false,
  source: null,
}

export function useCompEvidenceFilters(evidence: CompTransactionEvidence[]) {
  const [filters, setFilters] = useState<EvidenceFilters>(DEFAULT_FILTERS)
  const [mapMode, setMapMode] = useState<EvidenceMapMode>('PRICING')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    return evidence.filter((row) => {
      if (filters.universe && row.routed_universe !== filters.universe) return false
      if (filters.evidenceRole && row.evidence_role !== filters.evidenceRole) return false
      if (filters.transactionChannel && row.transaction_channel !== filters.transactionChannel) return false
      if (filters.buyerArchetype && row.buyer_archetype !== filters.buyerArchetype) return false
      if (filters.status === 'accepted' && row.qualification_status !== 'ACCEPTED') return false
      if (filters.status === 'review' && !/review/i.test(row.qualification_status)) return false
      if (filters.status === 'rejected' && row.qualification_status !== 'REJECTED' && row.qualification_status !== 'QUARANTINED') return false
      if (filters.packageOnly && !(row.package_probability && row.package_probability > 0.5)) return false
      if (filters.singleAssetOnly && row.package_probability && row.package_probability > 0.5) return false
      if (filters.source && row.source_lineage?.source_table !== filters.source) return false
      return true
    })
  }, [evidence, filters])

  return {
    filters,
    setFilters,
    mapMode,
    setMapMode,
    selectedId,
    setSelectedId,
    filtered,
    resetFilters: () => setFilters(DEFAULT_FILTERS),
  }
}