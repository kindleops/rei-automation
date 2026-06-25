import { useCallback, useMemo, useState } from 'react'
import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'
import type { CompAnalystScenario } from '../../../domain/comp-intelligence/v3-types'

export function useAnalystScenario(
  canonicalEvidence: CompTransactionEvidence[],
  canonicalMarketValue: number | null,
) {
  const [includedOverrides, setIncludedOverrides] = useState<Set<string>>(new Set())
  const [excludedOverrides, setExcludedOverrides] = useState<Set<string>>(new Set())

  const reset = useCallback(() => {
    setIncludedOverrides(new Set())
    setExcludedOverrides(new Set())
  }, [])

  const toggleInclude = useCallback((candidateId: string) => {
    setExcludedOverrides((prev) => {
      const next = new Set(prev)
      next.delete(candidateId)
      return next
    })
    setIncludedOverrides((prev) => {
      const next = new Set(prev)
      if (next.has(candidateId)) next.delete(candidateId)
      else next.add(candidateId)
      return next
    })
  }, [])

  const toggleExclude = useCallback((candidateId: string) => {
    setIncludedOverrides((prev) => {
      const next = new Set(prev)
      next.delete(candidateId)
      return next
    })
    setExcludedOverrides((prev) => {
      const next = new Set(prev)
      if (next.has(candidateId)) next.delete(candidateId)
      else next.add(candidateId)
      return next
    })
  }, [])

  const scenario = useMemo((): CompAnalystScenario | null => {
    if (!includedOverrides.size && !excludedOverrides.size) return null

    const pricingRows = canonicalEvidence.filter((row) => {
      const id = row.candidate_id || ''
      if (excludedOverrides.has(id)) return false
      if (includedOverrides.has(id)) return row.pricing_eligibility === true
      return row.qualification_status === 'ACCEPTED' && row.pricing_eligibility === true
    })

    const prices = pricingRows.map((r) => r.sale_price).filter((p): p is number => p != null && p > 0)
    const scenarioValue = prices.length
      ? Math.round(prices.reduce((s, p) => s + p, 0) / prices.length / 1000) * 1000
      : null

    return {
      label: 'ANALYST SCENARIO',
      included_candidate_ids: [...includedOverrides],
      excluded_candidate_ids: [...excludedOverrides],
      scenario_market_value: scenarioValue
        ? { low: Math.min(...prices), mid: scenarioValue, high: Math.max(...prices) }
        : null,
      scenario_offer: scenarioValue ? Math.round(scenarioValue * 0.65) : null,
      delta_from_canonical: {
        market_value: scenarioValue != null && canonicalMarketValue != null
          ? scenarioValue - canonicalMarketValue
          : null,
      },
      invariant_changes: includedOverrides.size ? ['manual_inclusion_override'] : [],
      confidence_gate_changes: excludedOverrides.size ? ['manual_exclusion_override'] : [],
    }
  }, [canonicalEvidence, canonicalMarketValue, excludedOverrides, includedOverrides])

  return {
    scenario,
    hasOverrides: includedOverrides.size > 0 || excludedOverrides.size > 0,
    toggleInclude,
    toggleExclude,
    reset,
    includedOverrides,
    excludedOverrides,
  }
}