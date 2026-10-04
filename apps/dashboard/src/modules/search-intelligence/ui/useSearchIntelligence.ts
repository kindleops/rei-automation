import { useEffect, useMemo, useState } from 'react'
import { loadPortfolioDataset } from '../data/snapshot-loader'
import { buildModel, type SearchModel } from '../domain/model'
import { allOpportunities } from '../domain/opportunities'
import { propertySummary, type PropertySummary } from '../domain/brief'
import { buildSearchIndex } from '../domain/search'
import type { Opportunity } from '../domain/types'

export interface SiData {
  model: SearchModel
  opportunities: Opportunity[]
  summaries: PropertySummary[]
  index: ReturnType<typeof buildSearchIndex>
  snapshots: Array<{ propertyId: string; repo: string; branch: string; commit: string; dirty: boolean }>
}

type Load = { state: 'loading' } | { state: 'ready'; data: SiData } | { state: 'error'; message: string }

/** Loads the planning snapshots once (lazy chunk) and derives every read model. */
export function useSearchIntelligence(): Load {
  const [raw, setRaw] = useState<Awaited<ReturnType<typeof loadPortfolioDataset>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    loadPortfolioDataset().then((r) => { if (alive) setRaw(r) }, (e: unknown) => { if (alive) setError(e instanceof Error ? e.message : 'The planning snapshots could not be loaded.') })
    return () => { alive = false }
  }, [])
  const data = useMemo<SiData | null>(() => {
    if (!raw) return null
    const model = buildModel(raw.dataset, raw.navTargets)
    const opportunities = allOpportunities(model, null)
    return {
      model,
      opportunities,
      summaries: model.dataset.properties.map((p) => propertySummary(model, p, opportunities)),
      index: buildSearchIndex(model, opportunities),
      snapshots: raw.snapshots,
    }
  }, [raw])
  if (error) return { state: 'error', message: error }
  return data ? { state: 'ready', data } : { state: 'loading' }
}
