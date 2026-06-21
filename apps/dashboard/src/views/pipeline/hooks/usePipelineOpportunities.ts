import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchPipelineMetrics,
  fetchPipelineOpportunities,
  fetchPipelineSavedViews,
  transitionPipelineStage,
  transitionPipelineStatus,
  transitionPipelineTemperature,
} from '../../../domain/pipeline/pipeline-opportunity-api'
import type {
  PipelineGroupByMode,
  PipelineMetrics,
  PipelineOpportunity,
  PipelineSavedView,
} from '../../../domain/pipeline/pipeline-opportunity.types'
import { loadPipelineGroupBy } from '../../../domain/pipeline/pipeline-display-helpers'

const EMPTY_FILTERS: Record<string, string | number | boolean | undefined> = Object.freeze({})

interface UsePipelineOpportunitiesOptions {
  enabled?: boolean
  filters?: Record<string, string | number | boolean | undefined>
}

export function usePipelineOpportunities({
  enabled = true,
  filters = EMPTY_FILTERS,
}: UsePipelineOpportunitiesOptions = {}) {
  const [opportunities, setOpportunities] = useState<PipelineOpportunity[]>([])
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null)
  const [savedViews, setSavedViews] = useState<PipelineSavedView[]>([])
  const [groupBy, setGroupBy] = useState<PipelineGroupByMode>(loadPipelineGroupBy)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const initialLoadDone = useRef(false)

  const refresh = useCallback(async () => {
    if (!enabled) return
    const isInitial = !initialLoadDone.current
    if (isInitial) setLoading(true)
    else setRefreshing(true)
    setError(null)
    try {
      const [list, metricData, views] = await Promise.all([
        fetchPipelineOpportunities({ limit: 100, ...filters }),
        fetchPipelineMetrics(),
        fetchPipelineSavedViews(),
      ])
      setOpportunities(list.rows)
      setTotal(list.total)
      setMetrics(metricData)
      setSavedViews(views)
      initialLoadDone.current = true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'pipeline_fetch_failed')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [enabled, filters])

  useEffect(() => { void refresh() }, [refresh])

  const patchOpportunity = useCallback((id: string, row: PipelineOpportunity) => {
    setOpportunities((rows) => rows.map((r) => (r.id === id ? row : r)))
  }, [])

  const moveStage = useCallback(async (id: string, toStage: string, reason?: string): Promise<void> => {
    const result = await transitionPipelineStage(id, {
      to_stage: toStage,
      reason,
      idempotency_key: `ui-drag:${id}:${toStage}:${Date.now()}`,
    })
    if (!result.ok) throw new Error(result.message || result.error || 'stage_transition_failed')
    if (result.opportunity) patchOpportunity(id, result.opportunity)
    void refresh()
  }, [patchOpportunity, refresh])

  const moveStatus = useCallback(async (id: string, toStatus: string, reason?: string): Promise<void> => {
    const result = await transitionPipelineStatus(id, { opportunity_status: toStatus, reason })
    if (!result.ok) throw new Error(result.error || 'status_transition_failed')
    if (result.opportunity) patchOpportunity(id, result.opportunity)
    void refresh()
  }, [patchOpportunity, refresh])

  const moveTemperature = useCallback(async (id: string, toTemperature: string, reason?: string): Promise<void> => {
    const result = await transitionPipelineTemperature(id, { temperature: toTemperature, reason })
    if (!result.ok) throw new Error(result.error || 'temperature_transition_failed')
    if (result.opportunity) patchOpportunity(id, result.opportunity)
    void refresh()
  }, [patchOpportunity, refresh])

  return {
    opportunities,
    metrics,
    savedViews,
    groupBy,
    setGroupBy,
    loading,
    refreshing,
    error,
    total,
    refresh,
    moveStage,
    moveStatus,
    moveTemperature,
  }
}