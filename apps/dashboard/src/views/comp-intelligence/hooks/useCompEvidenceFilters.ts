import { useMemo, useState } from 'react'
import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'

import {
  classifyComp,
  getMatchTierForFilter,
} from '../utils/comp-display'
import type { CompClassification, CompFilterKey } from '../utils/comp-display'

// Re-export the canonical filter key type for consumers of this hook
export type { CompFilterKey }

export interface EvidenceFilters {
  filter: CompFilterKey
  selectedId: string | null
  filtered: CompTransactionEvidence[]
  counts: Record<CompFilterKey, number>
  classifications: Map<string, CompClassification>
  setFilter: (next: CompFilterKey) => void
  setSelectedId: (id: string | null) => void
}

export function useCompEvidenceFilters(evidence: CompTransactionEvidence[]): EvidenceFilters {
  const [filter, setFilter] = useState<CompFilterKey>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { filtered, counts, classifications } = useMemo(() => {
    const classifications = new Map<string, CompClassification>()
    const counts: Record<CompFilterKey, number> = { all: 0, strong: 0, usable: 0, review: 0, excluded: 0 }

    const filteredRows: CompTransactionEvidence[] = []

    for (const row of evidence) {
      const c = classifyComp(row)
      const id = row.candidate_id || row.property_id || ''
      if (id) classifications.set(id, c)

      const tier = getMatchTierForFilter(c)
      counts.all += 1
      counts[tier] += 1

      if (filter === 'all') {
        filteredRows.push(row)
      } else if (tier === filter) {
        filteredRows.push(row)
      }
    }

    return { filtered: filteredRows, counts, classifications }
  }, [evidence, filter])

  // Gracefully clear selection if filtered out
  const effectiveSelected = useMemo(() => {
    if (!selectedId) return null
    const stillVisible = filtered.some((r) => (r.candidate_id || r.property_id || '') === selectedId)
    return stillVisible ? selectedId : null
  }, [filtered, selectedId])

  const setSelectedIdSafe = (id: string | null) => setSelectedId(id)

  return {
    filter,
    setFilter,
    selectedId: effectiveSelected,
    setSelectedId: setSelectedIdSafe,
    filtered,
    counts,
    classifications,
  }
}