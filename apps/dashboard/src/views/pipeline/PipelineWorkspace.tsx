import { useCallback } from 'react'
import type { ViewLayoutMode } from '../../domain/inbox/view-layout'
import type { PipelineSavedView } from '../../domain/pipeline/pipeline-opportunity.types'
import { usePipelineOpportunities } from './hooks/usePipelineOpportunities'
import { PipelineOpportunityBoard } from './PipelineOpportunityBoard'

interface PipelineWorkspaceProps {
  selectedId: string | null
  layoutMode: ViewLayoutMode
  onSelect: (id: string) => void
  onOpenCommandView: (threadId?: string | null) => void
  onOpenDealIntelligence: (threadId?: string | null) => void
  onAction: (id: string, action: string, payload?: Record<string, unknown>) => void | Promise<void>
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
    error,
    moveStage,
    refresh,
  } = usePipelineOpportunities({ enabled: true })

  const handleAction = useCallback(async (id: string, action: string, payload?: Record<string, unknown>) => {
    if (action === 'refresh') {
      await refresh()
      return
    }
    const opp = opportunities.find((o) => o.id === id)
    const threadId = opp?.primary_thread_key
    if (threadId) {
      await onAction(threadId, action, payload)
    } else {
      await onAction(id, action, payload)
    }
    await refresh()
  }, [onAction, opportunities, refresh])

  const handleApplySavedView = useCallback((view: PipelineSavedView) => {
    if (view.group_by) setGroupBy(view.group_by)
  }, [setGroupBy])

  const selectedOpportunityId = opportunities.find(
    (o) => o.primary_thread_key === selectedId || o.id === selectedId,
  )?.id ?? null

  const handleSelectOpportunity = useCallback((opportunityId: string) => {
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
      layoutMode={layoutMode}
      groupBy={groupBy}
      loading={loading}
      onGroupByChange={setGroupBy}
      onSelect={handleSelectOpportunity}
      onOpenCommandView={onOpenCommandView}
      onOpenDealIntelligence={onOpenDealIntelligence}
      onAction={handleAction}
      onMoveStage={moveStage}
      onApplySavedView={handleApplySavedView}
    />
  )
}