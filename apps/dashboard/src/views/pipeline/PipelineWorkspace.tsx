import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ViewLayoutMode } from '../../domain/inbox/view-layout'
import { fetchPipelineOpportunity } from '../../domain/pipeline/pipeline-opportunity-api'
import type { PipelineSavedView, PipelineOpportunity } from '../../domain/pipeline/pipeline-opportunity.types'
import { usePipelineOpportunities } from './hooks/usePipelineOpportunities'
import { PipelineOpportunityBoard } from './PipelineOpportunityBoard'

const OPP_PARAM = 'opp'
const STORAGE_KEY = 'pipeline_selected_opp_v1'

interface PipelineWorkspaceProps {
  selectedId: string | null
  layoutMode: ViewLayoutMode
  onSelect: (id: string) => void
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
  onOpenCommandView,
  onOpenDealIntelligence,
  onAction,
}: PipelineWorkspaceProps) {
  const {
    opportunities,
    metrics,
    savedViews,
    groupBy,
    setGroupBy,
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

  const listOpportunity = useMemo(
    () => opportunities.find((o) => o.id === selectedOpportunityId) ?? null,
    [opportunities, selectedOpportunityId],
  )

  useEffect(() => {
    if (!selectedOpportunityId) {
      setDetailOpportunity(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    void fetchPipelineOpportunity(selectedOpportunityId)
      .then((row) => { if (!cancelled) setDetailOpportunity(row) })
      .catch(() => { if (!cancelled) setDetailOpportunity(listOpportunity) })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [selectedOpportunityId, listOpportunity])

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
    const legacyMap: Record<string, typeof groupBy> = {
      acquisition_stage: 'stage',
      opportunity_status: 'status',
      conversation_state: 'status',
      queue_execution: 'queue_status',
      workflow_state: 'workflow_status',
      follow_up: 'follow_up_state',
      asset_class: 'property_type',
    }
    const next = legacyMap[String(view.group_by)] ?? (view.group_by as typeof groupBy)
    if (next) setGroupBy(next)
  }, [setGroupBy])

  const handleSelectOpportunity = useCallback((opportunityId: string) => {
    setSelectedOpportunityId(opportunityId)
    writeOppToUrl(opportunityId)
    try { localStorage.setItem(STORAGE_KEY, opportunityId) } catch { /* ignore */ }
    const opp = opportunities.find((o) => o.id === opportunityId)
    onSelect(opp?.primary_thread_key || opportunityId)
  }, [onSelect, opportunities])

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
      savedViews={savedViews}
      selectedId={selectedOpportunityId}
      selectedOpportunity={detailOpportunity ?? listOpportunity}
      detailLoading={detailLoading}
      layoutMode={layoutMode}
      groupBy={groupBy}
      loading={loading}
      refreshing={refreshing}
      onGroupByChange={setGroupBy}
      onSelect={handleSelectOpportunity}
      onOpenCommandView={onOpenCommandView}
      onOpenDealIntelligence={onOpenDealIntelligence}
      onAction={handleAction}
      onMoveStage={moveStage}
      onMoveStatus={moveStatus}
      onMoveTemperature={moveTemperature}
      onApplySavedView={handleApplySavedView}
    />
  )
}