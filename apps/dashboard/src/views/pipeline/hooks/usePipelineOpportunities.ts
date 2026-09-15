import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  savePipelineView,
  transitionPipelineStage,
  transitionPipelineStatus,
  transitionPipelineTemperature,
} from '../../../domain/pipeline/pipeline-opportunity-api'
import { loadPipelineBoardSurface } from '../../../domain/pipeline/pipeline-surface-loader'
import { buildPipelineQueryParams } from '../../../domain/pipeline/pipeline-query-params'
import { subscribeToTableChanges } from '../../../lib/data/realtime'
import type { OpsSurfaceErrorType } from '../../../domain/ops/ops-surface-result'
import { patchLeadStateFromView } from '../../../domain/lead-state/persistUniversalLeadState'
import { normalizeLifecycleStage } from '../../../domain/lead-state/universal-lead-state-registry'
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
  loadPipelineGroupBy as _loadPipelineGroupBy,
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
  const [errorType, setErrorType] = useState<OpsSurfaceErrorType | null>(null)
  const [retryable, setRetryable] = useState(true)
  const [total, setTotal] = useState(0)
  /**
   * SEARCH IS SERVER-SIDE — §1.
   *
   * The box used to narrow only the hydrated board. Scope `all` is 768
   * opportunities against a 500-row response cap, so any match in the
   * remaining 268 was unreachable: "Frauli" existed in the pipeline and the UI
   * could not find it. The debounced value is the one that reaches the server,
   * so a refetch happens per settled query rather than per keystroke.
   */
  const [query, setQueryState] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const initialLoadDone = useRef(false)
  const requestSeq = useRef(0)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [query])

  /**
   * The server evaluates scope AND query together, so the two compose instead
   * of "load the first 500, then filter in the browser". Clearing the query
   * drops `q` and leaves `scope` untouched, which is what makes clearing a
   * search return the operator to the scope they were in rather than Active.
   */
  const scopeParams = useMemo(
    () => buildPipelineQueryParams(viewState, debouncedQuery),
    [viewState, debouncedQuery],
  )

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
    setErrorType(null)
    // A superseded request returns early below without writing any result. On a
    // first load that used to leave rows=[] / total=0 / error=null — an abort
    // wearing the costume of a legitimate empty pipeline. `settled` records
    // whether THIS request actually produced an outcome.
    let settled = false
    try {
      const surface = await loadPipelineBoardSurface({
        // 500 is the server's MAX_LIMIT (opportunity-service.js), so asking for
        // more returns the same page. Five of six scopes fit inside it and
        // load whole, which is what lets their counts be exact. `all` is 768
        // and genuinely cannot, so the board compares the loaded count against
        // the canonical scope total and says "Showing 500 of 768" rather than
        // presenting a prefix as the scope.
        limit: 500,
        hydrate_follow_up: false,
        ...scopeParams,
      })
      if (requestId !== requestSeq.current) return
      if (!surface.ok) {
        setError(surface.errorMessage ?? 'pipeline_fetch_failed')
        setErrorType(surface.errorType ?? 'query_failed')
        setRetryable(surface.retryable ?? true)
        if (initialLoadDone.current) {
          // Preserve stale rows with warning — do not wipe board on refresh failure.
          return
        }
        settled = true
        setOpportunities([])
        setTotal(0)
        setMetrics(null)
        setGlobalTotal(0)
        return
      }
      const { list, metrics: metricData, globalMetrics, views } = surface.data
      settled = true
      setOpportunities(list.rows)
      setTotal(list.total)
      setMetrics(metricData)
      setGlobalTotal(globalMetrics.total ?? 0)
      setSavedViews(views)
      setRetryable(true)
      initialLoadDone.current = true
    } catch (err) {
      if (requestId !== requestSeq.current) return
      // Reaching here past the requestId guard means THIS request produced a real
      // outcome — it threw. That is settled: the error state is what drives the
      // retry affordance, so staying in `loading` on top of it just hangs the board
      // on "Loading opportunities…" forever while the stage columns render empty.
      // Only a superseded/aborted request (filtered out above) may stay unsettled.
      settled = true
      setError(err instanceof Error ? err.message : 'pipeline_fetch_failed')
      setErrorType('query_failed')
      setRetryable(true)
    } finally {
      if (requestId !== requestSeq.current) return
      // Never drop out of loading on an unsettled (aborted/superseded) request:
      // that is what rendered a confident "0 leads" for a load that never
      // delivered. Stay in loading so the retry/refresh path can take over.
      if (settled) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [enabled, scopeParams, viewState.scope])

  useEffect(() => { void refresh() }, [refresh])

  /**
   * LIVE UPDATES — §26.
   *
   * The board refreshed on mount and on an explicit operator action, and
   * nothing else. So a seller replying, a backend classification advancing a
   * stage, or a suppression landing while Pipeline was open left the card,
   * the lane and the rail counts stale until a manual reload.
   *
   * Subscribed to the tables the opportunity row is actually derived from,
   * through the SAME `subscribeToTableChanges` helper the Inbox uses — no
   * second realtime system:
   *
   *   acquisition_opportunities  stage / status / next_action / automation
   *   inbox_thread_state         the projection an operator move writes first
   *   message_events             a new inbound, which changes disposition
   *
   * Coalesced behind a short timer because one inbound writes several of these
   * rows in quick succession, and a refresh per row would stampede the counts
   * endpoint (which takes ~11s on this dataset).
   */
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    if (!enabled) return undefined
    let timer: number | null = null
    const coalesced = () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => { timer = null; void refreshRef.current() }, 1200)
    }
    const subs = ['acquisition_opportunities', 'inbox_thread_state', 'message_events']
      .map((table) => subscribeToTableChanges(table, coalesced))
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      subs.forEach((sub) => sub.unsubscribe())
    }
  }, [enabled])

  const patchOpportunity = useCallback((id: string, row: PipelineOpportunity) => {
    setOpportunities((rows) => rows.map((r) => (r.id === id ? row : r)))
  }, [])

  const moveStage = useCallback(async (
    id: string,
    toStage: string,
    reason?: string,
    options?: { executeNextAction?: boolean },
  ): Promise<void> => {
    let snapshot: PipelineOpportunity | undefined
    setOpportunities((rows) => {
      snapshot = rows.find((r) => r.id === id)
      return rows.map((r) => (r.id === id ? { ...r, pipeline_stage: toStage } : r))
    })
    try {
      const result = await transitionPipelineStage(id, {
        to_stage: toStage,
        reason,
        idempotency_key: `ui-drag:${id}:${toStage}:${Date.now()}`,
      })
      if (!result.ok) throw new Error(result.message || result.error || 'stage_transition_failed')
      if (result.opportunity) {
        patchOpportunity(id, result.opportunity)
        const threadKey = String(result.opportunity.primary_thread_key ?? '').trim()
        if (threadKey) {
          await patchLeadStateFromView('pipeline', threadKey, {
            lifecycle_stage: normalizeLifecycleStage(toStage),
          }, {
            reason: reason ?? 'pipeline_stage_drag',
            execute_next_action: options?.executeNextAction === true,
          })
        }
      }
    } catch (err) {
      if (snapshot) {
        setOpportunities((rows) => rows.map((r) => (r.id === id ? snapshot! : r)))
      }
      throw err
    }
  }, [patchOpportunity])

  const moveStatus = useCallback(async (id: string, toStatus: string, reason?: string): Promise<void> => {
    let snapshot: PipelineOpportunity | undefined
    setOpportunities((rows) => {
      snapshot = rows.find((r) => r.id === id)
      return rows.map((r) => (r.id === id ? { ...r, universal_status: toStatus } : r))
    })
    try {
      const result = await transitionPipelineStatus(id, { to_status: toStatus, reason })
      if (!result.ok) throw new Error(result.message || result.error || 'status_transition_failed')
      if (result.opportunity) patchOpportunity(id, result.opportunity)
    } catch (err) {
      if (snapshot) {
        setOpportunities((rows) => rows.map((r) => (r.id === id ? snapshot! : r)))
      }
      throw err
    }
  }, [patchOpportunity])

  const moveTemperature = useCallback(async (id: string, toTemperature: string, reason?: string): Promise<void> => {
    let snapshot: PipelineOpportunity | undefined
    setOpportunities((rows) => {
      snapshot = rows.find((r) => r.id === id)
      return rows.map((r) => (r.id === id ? { ...r, temperature: toTemperature } : r))
    })
    try {
      const result = await transitionPipelineTemperature(id, { temperature: toTemperature, reason })
      if (!result.ok) throw new Error(result.message || result.error || 'temperature_transition_failed')
      if (result.opportunity) patchOpportunity(id, result.opportunity)
    } catch (err) {
      if (snapshot) {
        setOpportunities((rows) => rows.map((r) => (r.id === id ? snapshot! : r)))
      }
      throw err
    }
  }, [patchOpportunity])

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
    errorType,
    retryable,
    total,
    query,
    setQuery: setQueryState,
    /** True once the settled query has reached the server, not on first keypress. */
    searchActive: debouncedQuery.length > 0,
    /** The query the CURRENT rows answer — distinct from `query`, which is per keystroke. */
    appliedQuery: debouncedQuery,
    searchPending: query.trim() !== debouncedQuery,
    refresh,
    moveStage,
    moveStatus,
    moveTemperature,
  }
}