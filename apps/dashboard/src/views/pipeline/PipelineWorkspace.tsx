import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ActiveInboxContext } from '../../modules/inbox/active-context'
import { buildContextFromOpportunity } from '../../modules/inbox/active-context'
import type { ViewLayoutMode } from '../../domain/inbox/view-layout'
import { fetchPipelineOpportunity } from '../../domain/pipeline/pipeline-opportunity-api'
import type { PipelineSavedView, PipelineOpportunity } from '../../domain/pipeline/pipeline-opportunity.types'
import { routeEntityGraphAction } from '../../domain/entity-graph/entity-graph-route-actions'
import { universalContextFromOpportunity } from '../../domain/pipeline/pipeline-universal-context'
import { setUniversalEntityContextSnapshot, UNIVERSAL_ENTITY_CONTEXT_EVENT } from '../../domain/entity-graph/universal-entity-context-store'
import { pushRoutePath } from '../../app/router'
import { usePipelineOpportunities } from './hooks/usePipelineOpportunities'
import { PipelineOpportunityBoard } from './PipelineOpportunityBoard'

const OPP_PARAM = 'opp'
const STORAGE_KEY = 'pipeline_selected_opp_v1'

interface PipelineWorkspaceProps {
  selectedId: string | null
  layoutMode: ViewLayoutMode
  onSelect: (id: string) => void
  onEstablishContext?: (context: ActiveInboxContext) => void
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
  onEstablishContext,
  onOpenCommandView,
  onOpenDealIntelligence,
  onAction,
}: PipelineWorkspaceProps) {
  const {
    opportunities,
    metrics,
    globalTotal,
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

  const listOpportunity = useMemo(
    () => opportunities.find((o) => o.id === selectedOpportunityId) ?? null,
    [opportunities, selectedOpportunityId],
  )

  const syncEntityContext = useCallback((opp: PipelineOpportunity | null) => {
    if (!opp) return
    const active = buildContextFromOpportunity(opp, 'pipeline')
    onEstablishContext?.(active)
    const universal = universalContextFromOpportunity(opp)
    setUniversalEntityContextSnapshot(universal)
    window.dispatchEvent(new CustomEvent(UNIVERSAL_ENTITY_CONTEXT_EVENT, { detail: universal }))
  }, [onEstablishContext])

  useEffect(() => {
    if (!selectedOpportunityId) {
      setDetailOpportunity(null)
      setDetailError(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)
    void fetchPipelineOpportunity(selectedOpportunityId)
      .then((row) => {
        if (cancelled) return
        setDetailOpportunity(row)
        syncEntityContext(row)
      })
      .catch((err) => {
        if (cancelled) return
        setDetailError(err instanceof Error ? err.message : 'detail_fetch_failed')
        if (listOpportunity) {
          setDetailOpportunity(listOpportunity)
          syncEntityContext(listOpportunity)
        }
      })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [selectedOpportunityId, listOpportunity, syncEntityContext])

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
    void refresh()
  }, [applySavedView, refresh])

  const handleSelectOpportunity = useCallback((opportunityId: string) => {
    setSelectedOpportunityId(opportunityId)
    writeOppToUrl(opportunityId)
    try { localStorage.setItem(STORAGE_KEY, opportunityId) } catch { /* ignore */ }
    const opp = opportunities.find((o) => o.id === opportunityId)
    if (opp) syncEntityContext(opp)
    onSelect(opp?.primary_thread_key || opportunityId)
  }, [onSelect, opportunities, syncEntityContext])

  const handleClearSelection = useCallback(() => {
    setSelectedOpportunityId(null)
    writeOppToUrl(null)
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
  }, [])

  if (error) {
    return (
      <div className="plv plv--error">
        <p>Pipeline unavailable: {error}</p>
        <button type="button" className="plv-action-btn" onClick={() => void refresh()}>Retry</button>
      </div>
    )
  }

  return (
    <PipelineOpportunityBoard
      opportunities={opportunities}
      metrics={metrics}
      globalTotal={globalTotal}
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
      onPersistView={persistView}
      onDuplicateView={duplicateView}
      onResetView={() => { resetView(); void refresh() }}
      selectedId={selectedOpportunityId}
      selectedOpportunity={detailOpportunity ?? listOpportunity}
      detailLoading={detailLoading}
      detailError={detailError}
      layoutMode={layoutMode}
      groupBy={groupBy}
      loading={loading}
      refreshing={refreshing}
      onGroupByChange={setGroupBy}
      onSelect={handleSelectOpportunity}
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