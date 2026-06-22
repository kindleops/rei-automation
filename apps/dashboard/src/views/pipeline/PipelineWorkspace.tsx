import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActiveInboxContext } from '../../modules/inbox/active-context'
import type { ViewLayoutMode } from '../../domain/inbox/view-layout'
import { fetchPipelineOpportunity } from '../../domain/pipeline/pipeline-opportunity-api'
import type { PipelineSavedView, PipelineOpportunity } from '../../domain/pipeline/pipeline-opportunity.types'
import { routeEntityGraphAction } from '../../domain/entity-graph/entity-graph-route-actions'
import { universalContextFromOpportunity } from '../../domain/pipeline/pipeline-universal-context'
import { setUniversalEntityContextSnapshot } from '../../domain/entity-graph/universal-entity-context-store'
import {
  findOpportunityForActiveContext,
  opportunityMatchesActiveContext,
  syncPayloadFromOpportunity,
} from '../../domain/entity-graph/universal-sync'
import { pushRoutePath } from '../../app/router'
import { usePipelineOpportunities } from './hooks/usePipelineOpportunities'
import { sanitizePipelineError } from '../../domain/pipeline/pipeline-operator-error'
import { PipelineOpportunityBoard } from './PipelineOpportunityBoard'

const OPP_PARAM = 'opp'
const STORAGE_KEY = 'pipeline_selected_opp_v1'

interface PipelineWorkspaceProps {
  selectedId: string | null
  layoutMode: ViewLayoutMode
  onSelect: (id: string) => void
  onAnchorThread?: (id: string) => void
  onEstablishContext?: (context: ActiveInboxContext) => void
  onSyncOpportunity?: (opportunity: PipelineOpportunity, mode: 'select' | 'preview') => void
  onClearOpportunityPreview?: () => void
  externalContext?: ActiveInboxContext
  onOpenCommandView: (threadId?: string | null) => void
  onOpenDealIntelligence: (threadId?: string | null) => void
  onAction: (id: string, action: string, payload?: Record<string, unknown>) => void | Promise<void>
}

function readOppFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search)
    return params.get(OPP_PARAM)
  } catch {
    return null
  }
}

function writeOppToUrl(opportunityId: string | null) {
  try {
    const url = new URL(window.location.href)
    if (opportunityId) url.searchParams.set(OPP_PARAM, opportunityId)
    else url.searchParams.delete(OPP_PARAM)
    window.history.replaceState(window.history.state, '', url.toString())
  } catch { /* ignore */ }
}

export function PipelineWorkspace({
  selectedId,
  layoutMode,
  onSelect,
  onAnchorThread,
  onEstablishContext,
  onSyncOpportunity,
  onClearOpportunityPreview,
  externalContext,
  onOpenCommandView,
  onOpenDealIntelligence,
  onAction,
}: PipelineWorkspaceProps) {
  const {
    opportunities,
    metrics,
    globalTotal,
    total: scopedTotal,
    savedViews,
    viewState,
    groupBy,
    setGroupBy,
    scope,
    setScope,
    cardDesign,
    filters,
    sorts,
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
    moveStage,
    moveStatus,
    moveTemperature,
    refresh,
  } = usePipelineOpportunities({ enabled: true })

  const [selectedOpportunityId, setSelectedOpportunityId] = useState<string | null>(() => {
    return readOppFromUrl() || (() => {
      try { return localStorage.getItem(STORAGE_KEY) } catch { return null }
    })()
  })
  const [detailOpportunity, setDetailOpportunity] = useState<PipelineOpportunity | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'loaded' | 'partial' | 'error'>('idle')
  const detailRequestRef = useRef(0)

  const listOpportunity = useMemo(
    () => opportunities.find((o) => o.id === selectedOpportunityId) ?? null,
    [opportunities, selectedOpportunityId],
  )

  const shouldPublishContext = useCallback((opp: PipelineOpportunity) => {
    if (!externalContext) return true
    if (externalContext.sourceView === 'pipeline') return true
    return !opportunityMatchesActiveContext(opp, externalContext)
  }, [externalContext])

  const syncEntityContext = useCallback((
    opp: PipelineOpportunity | null,
    mode: 'select' | 'preview' = 'select',
    options?: { force?: boolean },
  ) => {
    if (!opp) return
    if (mode === 'select' && !options?.force && !shouldPublishContext(opp)) return
    if (onSyncOpportunity) {
      onSyncOpportunity(opp, mode)
      return
    }
    const { active, universal } = syncPayloadFromOpportunity(opp)
    onEstablishContext?.(active)
    setUniversalEntityContextSnapshot(universal)
  }, [onEstablishContext, onSyncOpportunity, shouldPublishContext])

  useEffect(() => {
    if (!selectedOpportunityId) {
      setDetailOpportunity(null)
      setDetailError(null)
      setDetailLoading(false)
      setDetailState('idle')
      return
    }

    const requestId = ++detailRequestRef.current
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), 15000)

    setDetailLoading(true)
    setDetailError(null)
    setDetailState(listOpportunity ? 'partial' : 'loading')
    if (listOpportunity) setDetailOpportunity(listOpportunity)

    void fetchPipelineOpportunity(selectedOpportunityId, { signal: controller.signal })
      .then((row) => {
        if (requestId !== detailRequestRef.current) return
        setDetailOpportunity(row)
        setDetailState('loaded')
        setDetailError(null)
      })
      .catch((err) => {
        if (requestId !== detailRequestRef.current) return
        const message = err instanceof Error ? err.message : 'detail_fetch_failed'
        const isAbort = err instanceof Error && err.name === 'AbortError'
        if (isAbort) {
          setDetailError('Detail request timed out')
        } else {
          setDetailError(message)
        }
        if (listOpportunity) {
          setDetailOpportunity(listOpportunity)
          setDetailState('partial')
        } else {
          setDetailState('error')
        }
      })
      .finally(() => {
        if (requestId !== detailRequestRef.current) return
        setDetailLoading(false)
      })

    return () => {
      controller.abort()
      window.clearTimeout(timeoutId)
    }
  }, [selectedOpportunityId, listOpportunity?.id])

  useEffect(() => {
    if (!externalContext) return
    const matched = findOpportunityForActiveContext(opportunities, externalContext)
    if (matched) {
      if (matched.id !== selectedOpportunityId) {
        setSelectedOpportunityId(matched.id)
        writeOppToUrl(matched.id)
      }
      return
    }
    if (
      selectedOpportunityId
      && externalContext.sourceView
      && externalContext.sourceView !== 'pipeline'
    ) {
      const current = opportunities.find((o) => o.id === selectedOpportunityId)
      if (current && !opportunityMatchesActiveContext(current, externalContext)) {
        setSelectedOpportunityId(null)
        writeOppToUrl(null)
      }
    }
  }, [externalContext, opportunities, selectedOpportunityId])

  useEffect(() => {
    if (selectedOpportunityId) return
    const fromParent = opportunities.find(
      (o) => o.primary_thread_key === selectedId || o.id === selectedId,
    )?.id
    if (fromParent) setSelectedOpportunityId(fromParent)
  }, [opportunities, selectedId, selectedOpportunityId])

  const handleAction = useCallback(async (id: string, action: string, payload?: Record<string, unknown>) => {
    if (action === 'refresh') {
      await refresh()
      if (selectedOpportunityId) {
        try {
          const row = await fetchPipelineOpportunity(selectedOpportunityId)
          setDetailOpportunity(row)
        } catch { /* ignore */ }
      }
      return
    }
    const opp = opportunities.find((o) => o.id === id) ?? detailOpportunity
    const threadId = opp?.primary_thread_key
    const universal = universalContextFromOpportunity(opp ?? null)

    if (action === 'open_map') {
      routeEntityGraphAction('show_on_map', universal)
      pushRoutePath('/map')
      return
    }
    if (action === 'open_property') {
      if (opp?.primary_property_id) pushRoutePath(`/list?property=${encodeURIComponent(opp.primary_property_id)}`)
      return
    }
    if (action === 'open_comp_intelligence') {
      routeEntityGraphAction('open_comp_intelligence', universal)
      return
    }
    if (action === 'open_inbox_thread' && threadId) {
      onSelect(threadId)
      onOpenCommandView(threadId)
      return
    }
    if (action === 'open_workflow_run') {
      pushRoutePath('/workflow-studio')
      return
    }

    if (threadId) {
      await onAction(threadId, action, payload)
    } else {
      await onAction(id, action, payload)
    }
    await refresh()
    if (selectedOpportunityId === id) {
      try {
        const row = await fetchPipelineOpportunity(id)
        setDetailOpportunity(row)
      } catch { /* ignore */ }
    }
  }, [onAction, opportunities, detailOpportunity, refresh, selectedOpportunityId])

  const handleApplySavedView = useCallback((view: PipelineSavedView) => {
    applySavedView(view)
  }, [applySavedView])

  const handleSelectOpportunity = useCallback((opportunityId: string) => {
    setSelectedOpportunityId(opportunityId)
    writeOppToUrl(opportunityId)
    try { localStorage.setItem(STORAGE_KEY, opportunityId) } catch { /* ignore */ }
    const opp = opportunities.find((o) => o.id === opportunityId)
    if (!opp) return
    syncEntityContext(opp, 'select', { force: true })
    const anchor = onAnchorThread ?? onSelect
    if (opp.primary_thread_key) anchor(opp.primary_thread_key)
    else if (opp.id) anchor(opp.id)
  }, [onAnchorThread, onSelect, opportunities, syncEntityContext])

  const handlePreviewOpportunity = useCallback((opportunityId: string) => {
    const opp = opportunities.find((o) => o.id === opportunityId)
    if (opp) syncEntityContext(opp, 'preview', { force: true })
  }, [opportunities, syncEntityContext])

  const handleClearSelection = useCallback(() => {
    setSelectedOpportunityId(null)
    writeOppToUrl(null)
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
    onClearOpportunityPreview?.()
  }, [onClearOpportunityPreview])

  if (error) {
    const operatorError = sanitizePipelineError(error)
    return (
      <div className="plv plv--error" role="alert">
        <p>{operatorError.message}</p>
        {operatorError.traceId && <small>Trace: {operatorError.traceId}</small>}
        {operatorError.retryable && (
          <button type="button" className="plv-action-btn" onClick={() => void refresh()}>Retry</button>
        )}
      </div>
    )
  }

  return (
    <PipelineOpportunityBoard
      opportunities={opportunities}
      metrics={metrics}
      globalTotal={globalTotal}
      scopedTotal={scopedTotal}
      scope={scope}
      onScopeChange={setScope}
      savedViews={savedViews}
      viewState={viewState}
      cardDesign={cardDesign}
      filters={filters}
      sorts={sorts}
      onFiltersChange={setFilters}
      onSortsChange={setSorts}
      onCardDesignChange={setCardDesign}
      onPersistView={async (payload) => { await persistView(payload) }}
      onDuplicateView={duplicateView}
      onResetView={() => { resetView(); void refresh() }}
      selectedId={selectedOpportunityId}
      selectedOpportunity={detailOpportunity ?? listOpportunity}
      detailLoading={detailLoading && detailState !== 'partial'}
      detailError={detailError}
      layoutMode={layoutMode}
      groupBy={groupBy}
      loading={loading}
      refreshing={refreshing}
      onGroupByChange={setGroupBy}
      onSelect={handleSelectOpportunity}
      onPreview={handlePreviewOpportunity}
      onClearPreview={onClearOpportunityPreview}
      onClearSelection={handleClearSelection}
      onOpenCommandView={onOpenCommandView}
      onOpenDealIntelligence={onOpenDealIntelligence}
      onAction={handleAction}
      onMoveStage={moveStage}
      onMoveStatus={moveStatus}
      onMoveTemperature={moveTemperature}
      onApplySavedView={handleApplySavedView}
      onRetryDetail={() => {
        if (!selectedOpportunityId) return
        setDetailLoading(true)
        setDetailError(null)
        void fetchPipelineOpportunity(selectedOpportunityId)
          .then((row) => { setDetailOpportunity(row); syncEntityContext(row) })
          .catch((err) => setDetailError(err instanceof Error ? err.message : 'detail_fetch_failed'))
          .finally(() => setDetailLoading(false))
      }}
    />
  )
}