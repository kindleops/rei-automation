import { useCallback, useEffect, useState } from 'react'
import {
  fetchPipelineMetrics,
  fetchPipelineOpportunities,
  fetchPipelineSavedViews,
  transitionPipelineStage,
} from '../../../domain/pipeline/pipeline-opportunity-api'
import type {
  PipelineGroupByMode,
  PipelineMetrics,
  PipelineOpportunity,
  PipelineSavedView,
} from '../../../domain/pipeline/pipeline-opportunity.types'
import { loadPipelineGroupBy } from '../../../domain/pipeline/pipeline-display-helpers'

interface UsePipelineOpportunitiesOptions {
  enabled?: boolean
  filters?: Record<string, string | number | boolean | undefined>
}

export function usePipelineOpportunities({ enabled = true, filters = {} }: UsePipelineOpportunitiesOptions = {}) {
  const [opportunities, setOpportunities] = useState<PipelineOpportunity[]>([])
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null)
  const [savedViews, setSavedViews] = useState<PipelineSavedView[]>([])
  const [groupBy, setGroupBy] = useState<PipelineGroupByMode>(loadPipelineGroupBy)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState(0)

  const refresh = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    setError(null)
    try {
      const [list, metricData, views] = await Promise.all([
        fetchPipelineOpportunities({ limit: 500, ...filters }),
        fetchPipelineMetrics(),
        fetchPipelineSavedViews(),
      ])
      setOpportunities(list.rows)
      setTotal(list.total)
      setMetrics(metricData)
      setSavedViews(views)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'pipeline_fetch_failed')
    } finally {
      setLoading(false)
    }
  }, [enabled, filters])

  useEffect(() => { void refresh() }, [refresh])

  const moveStage = useCallback(async (id: string, toStage: string, reason?: string): Promise<void> => {
    const result = await transitionPipelineStage(id, {
      to_stage: toStage,
      reason,
      idempotency_key: `ui-drag:${id}:${toStage}:${Date.now()}`,
    })
    if (!result.ok) throw new Error(result.message || result.error || 'stage_transition_failed')
    if (result.opportunity) {
      setOpportunities((rows) => rows.map((r) => (r.id === id ? result.opportunity! : r)))
    }
    void refresh()
  }, [refresh])

  return {
    opportunities,
    metrics,
    savedViews,
    groupBy,
    setGroupBy,
    loading,
    error,
    total,
    refresh,
    moveStage,
  }
}