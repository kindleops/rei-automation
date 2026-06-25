import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchClosingDeskModel } from '../../../domain/closing-desk/closing-desk-api'
import type { ClosingCase, ClosingDeskModel } from '../../../domain/closing-desk/closing-desk.types'

export interface ClosingDeskFilters {
  search: string
  market: string | 'all'
  risk: string | 'all'
  boardColumn: string | 'all'
}

const EMPTY_FILTERS: ClosingDeskFilters = { search: '', market: 'all', risk: 'all', boardColumn: 'all' }

export interface UseClosingDeskOptions {
  fixture?: boolean
}

export function useClosingDesk({ fixture = false }: UseClosingDeskOptions = {}) {
  const [model, setModel] = useState<ClosingDeskModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<ClosingDeskFilters>(EMPTY_FILTERS)
  const requestSeq = useRef(0)

  const refresh = useCallback(async () => {
    const requestId = ++requestSeq.current
    setLoading(true)
    setError(null)
    try {
      const next = await fetchClosingDeskModel({ fixture })
      if (requestId !== requestSeq.current) return
      setModel(next)
    } catch (err) {
      if (requestId !== requestSeq.current) return
      setError(err instanceof Error ? err.message : 'closing_desk_fetch_failed')
    } finally {
      if (requestId === requestSeq.current) setLoading(false)
    }
  }, [fixture])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const markets = useMemo(() => {
    const set = new Set<string>()
    for (const c of model?.cases ?? []) if (c.market) set.add(c.market)
    return [...set].sort()
  }, [model])

  const filteredCases = useMemo(() => {
    const cases = model?.cases ?? []
    const q = filters.search.trim().toLowerCase()
    return cases.filter((c) => {
      if (filters.market !== 'all' && c.market !== filters.market) return false
      if (filters.risk !== 'all' && c.riskLevel !== filters.risk) return false
      if (filters.boardColumn !== 'all' && c.boardColumn !== filters.boardColumn) return false
      if (q) {
        const hay = `${c.displayName} ${c.sellerName ?? ''} ${c.market ?? ''} ${c.identity.closingCaseId}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [model, filters])

  return {
    model,
    loading,
    error,
    filters,
    setFilters,
    markets,
    filteredCases,
    refresh,
  }
}

export type ClosingDeskHook = ReturnType<typeof useClosingDesk>
export type { ClosingCase }
