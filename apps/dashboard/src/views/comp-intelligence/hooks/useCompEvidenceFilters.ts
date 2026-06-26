import { useMemo, useState } from 'react'
import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'

import { compQuality, type CompQuality } from '../utils/comp-display'

export type CompQualityFilter = 'all' | CompQuality

export function useCompEvidenceFilters(evidence: CompTransactionEvidence[]) {
  const [qualityFilter, setQualityFilter] = useState<CompQualityFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    return evidence.filter((row) => {
      if (qualityFilter === 'all') return true
      return compQuality(row) === qualityFilter
    })
  }, [evidence, qualityFilter])

  return {
    qualityFilter,
    setQualityFilter,
    selectedId,
    setSelectedId,
    filtered,
  }
}