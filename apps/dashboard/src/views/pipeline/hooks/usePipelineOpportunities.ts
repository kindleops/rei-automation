import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchPipelineMetrics,
  fetchPipelineOpportunities,
  fetchPipelineSavedViews,
  savePipelineView,
  transitionPipelineStage,
  transitionPipelineStatus,
  transitionPipelineTemperature,
} from '../../../domain/pipeline/pipeline-opportunity-api'
import type {
  PipelineCardDesign,
  PipelineFilterGroup,
  PipelineSortSpec,
  PipelineViewState,
} from '../../../domain/pipeline/pipeline-card-design.types'
import type {
  PipelineGroupByMode,
  PipelineMetrics,
  PipelineOpportunity,
  PipelineSavedView,
} from '../../../domain/pipeline/pipeline-opportunity.types'
import {
  loadPipelineGroupBy,
  savePipelineGroupBy,
  savePipelineScope,
  type PipelineScope,
} from '../../../domain/pipeline/pipeline-display-helpers'
import {
  applySavedViewToState,
  getCardDesignForGroup,
  loadPipelineViewState,
  resetPipelineViewState,
  savePipelineViewState,
  saveCardDesignsByGroup,
} from '../../../domain/pipeline/pipeline-view-state'

interface UsePipelineOpportunitiesOptions {
  enabled?: boolean
}

export function usePipelineOpportunities({ enabled = true }: UsePipelineOpportunitiesOptions = {}) {
  const [opportunities, setOpportunities] = useState<PipelineOpportunity[]>([])
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null)
  const [globalTotal, setGlobalTotal] = useState(0)
  const [savedViews, setSavedViews] = useState<PipelineSavedView[]>([])
  const [viewState, setViewState] = useState<PipelineViewState>(loadPipelineViewState)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const initialLoadDone = useRef(false)
  const requestSeq = useRef(0)

  const scopeParams = useMemo(() => {
    const params: Record<string, string> = { scope: viewState.scope }
    const hasFilters = viewState.filters.clauses.length > 0
    if (hasFilters) params.filter_json = JSON.stringify(viewState.filters)
    if (viewState.sorts.length > 0) params.sorts = JSON.stringify(viewState.sorts)
    return params
  }, [viewState.scope, viewState.filters, viewState.sorts])

  const setGroupBy = useCallback((mode: PipelineGroupByMode) => {
    setViewState((prev) => {
      const cardDesign = getCardDesignForGroup(mode, prev.cardDesignsByGroup)
      const next = { ...prev, groupBy: mode, cardDesign }
      savePipelineGroupBy(mode)
      savePipelineViewState(next)
      return next
    })
  }, [])

  const setScope = useCallback((scope: PipelineScope) => {
    setViewState((prev) => {
      const next = { ...prev, scope }
      savePipelineScope(scope)
      savePipelineViewState(next)
      return next
    })
  }, [])

  const setFilters = useCallback((filters: PipelineFilterGroup) => {
    setViewState((prev) => {
      const next = { ...prev, filters }
      savePipelineViewState(next)
      return next
    })
  }, [])

  const setSorts = useCallback((sorts: PipelineSortSpec[]) => {
    setViewState((prev) => {
      const next = { ...prev, sorts }
      savePipelineViewState(next)
      return next
    })
  }, [])

  const setCardDesign = useCallback((cardDesign: PipelineCardDesign) => {
    setViewState((prev) => {
      const cardDesignsByGroup = { ...prev.cardDesignsByGroup, [prev.groupBy]: cardDesign }
      const next = { ...prev, cardDesign, cardDesignsByGroup }
      saveCardDesignsByGroup(cardDesignsByGroup)
      savePipelineViewState(next)
      return next
    })
  }, [])

  const applySavedView = useCallback((view: PipelineSavedView) => {
    setViewState((prev) => {
      const next = applySavedViewToState(view, prev)
      savePipelineGroupBy(next.groupBy)
      savePipelineScope(next.scope as PipelineScope)
      savePipelineViewState(next)
      return next
    })
  }, [])

  const persistView = useCallback(async (payload: Partial<PipelineSavedView>) => {
    const saved = await savePipelineView(payload)
    setSavedViews((views) => {
      const idx = views.findIndex((v) => v.view_key === saved.view_key)
      if (idx >= 0) {
        const next = [...views]
        next[idx] = saved
        return next
      }
      return [...views, saved]
    })
    return saved
  }, [])

  const resetView = useCallback(() => {
    const next = resetPipelineViewState()
    setViewState(next)
    savePipelineGroupBy(next.groupBy)
    savePipelineScope(next.scope as PipelineScope)
  }, [])

  const duplicateView = useCallback(async (view: PipelineSavedView) => {
    await persistView({
      ...view,
      view_key: `${view.view_key}_copy_${Date.now()}`,
      label: `${view.label} (Copy)`,
      is_system: false,
      is_pinned: false,
      duplicate: true,
    } as Partial<PipelineSavedView> & { duplicate?: boolean })
  }, [persistView])

  const refresh = useCallback(async () => {
    if (!enabled) return
    const requestId = ++requestSeq.current
    const isInitial = !initialLoadDone.current
    if (isInitial) setLoading(true)
    else setRefreshing(true)
    setError(null)
    try {
      const [list, metricData, globalMetrics, views] = await Promise.all([
        fetchPipelineOpportunities({ limit: 500, hydrate_follow_up: true, ...scopeParams }),
        fetchPipelineMetrics({ scope: viewState.scope }),
        fetchPipelineMetrics({ scope: 'all' }),
        fetchPipelineSavedViews(),
      ])
      if (requestId !== requestSeq.current) return
      setOpportunities(list.rows)
      setTotal(list.total)
      setMetrics(metricData)
      setGlobalTotal(globalMetrics.total ?? 0)
      setSavedViews(views)
      initialLoadDone.current = true
    } catch (err) {
      if (requestId !== requestSeq.current) return
      setError(err instanceof Error ? err.message : 'pipeline_fetch_failed')
    } finally {
      if (requestId !== requestSeq.current) return
      setLoading(false)
      setRefreshing(false)
    }
  }, [enabled, scopeParams, viewState.scope])

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
    const result = await transitionPipelineStatus(id, { to_status: toStatus, reason })
    if (!result.ok) throw new Error(result.message || result.error || 'status_transition_failed')
    if (result.opportunity) patchOpportunity(id, result.opportunity)
    void refresh()
  }, [patchOpportunity, refresh])

  const moveTemperature = useCallback(async (id: string, toTemperature: string, reason?: string): Promise<void> => {
    const result = await transitionPipelineTemperature(id, { temperature: toTemperature, reason })
    if (!result.ok) throw new Error(result.message || result.error || 'temperature_transition_failed')
    if (result.opportunity) patchOpportunity(id, result.opportunity)
    void refresh()
  }, [patchOpportunity, refresh])

  return {
    opportunities,
    metrics,
    globalTotal,
    savedViews,
    viewState,
    groupBy: viewState.groupBy,
    scope: viewState.scope as PipelineScope,
    cardDesign: viewState.cardDesign,
    filters: viewState.filters,
    sorts: viewState.sorts,
    setGroupBy,
    setScope,
    setFilters,
    setSorts,
    setCardDesign,
    applySavedView,
    persistView,
    duplicateView,
    resetView,
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