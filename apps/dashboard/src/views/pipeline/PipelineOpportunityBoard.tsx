import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ViewLayoutMode } from '../../domain/inbox/view-layout'
import type { PipelineCardDesign, PipelineFilterGroup, PipelineSortSpec, PipelineViewState } from '../../domain/pipeline/pipeline-card-design.types'
import type { PipelineGroupByMode, PipelineMetrics, PipelineOpportunity, PipelineSavedView } from '../../domain/pipeline/pipeline-opportunity.types'
import {
  groupDefinitionsForMode,
  groupKeyForOpportunity,
  isFollowUpDue,
  isGroupByMutable,
  isGroupByReadOnly,
  PIPELINE_SCOPE_OPTIONS,
  portfolioLabel,
  resolvePipelineStage,
  resolveTemperature,
  resolveUniversalStatus,
  stageLabel,
  type PipelineScope,
} from '../../domain/pipeline/pipeline-display-helpers'
import { resolveReplyAttentionState } from '../../domain/pipeline/pipeline-field-resolver'
import { DEFAULT_PIPELINE_CARD_DESIGN, normalizeCardDesign } from '../../domain/pipeline/pipeline-card-presets'
import { PipelineViewSelector } from './components/PipelineViewSelector'
import { PipelineCommandPanel } from './components/PipelineCommandPanel'
import { PipelineConfigurableCard } from './components/PipelineConfigurableCard'
import { PipelineCardDesigner } from './components/PipelineCardDesigner'
import { PipelineSortBuilder } from './components/PipelineSortBuilder'
import { PipelineFilterBuilder } from './components/PipelineFilterBuilder'
import { PipelineViewManager } from './components/PipelineViewManager'
import './pipeline-view.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const DRAG_THRESHOLD_PX = 6

interface OppCard {
  opp: PipelineOpportunity
  followUpDue: boolean
  suppressed: boolean
  needsAttention: boolean
}

function buildCard(opp: PipelineOpportunity): OppCard {
  return {
    opp,
    followUpDue: isFollowUpDue(opp),
    suppressed: opp.opportunity_status === 'suppressed' || opp.opportunity_status === 'dead',
    needsAttention: Boolean(resolveReplyAttentionState(opp)),
  }
}

interface StageModel {
  def: { id: string; label: string; tone: string }
  cards: OppCard[]
  count: number
}

interface PipelineOpportunityBoardProps {
  opportunities: PipelineOpportunity[]
  metrics: PipelineMetrics | null
  globalTotal?: number
  scope?: PipelineScope
  onScopeChange?: (scope: PipelineScope) => void
  savedViews?: PipelineSavedView[]
  viewState?: PipelineViewState
  cardDesign?: PipelineCardDesign
  filters?: PipelineFilterGroup
  sorts?: PipelineSortSpec[]
  onFiltersChange?: (filters: PipelineFilterGroup) => void
  onSortsChange?: (sorts: PipelineSortSpec[]) => void
  onCardDesignChange?: (design: PipelineCardDesign) => void
  onPersistView?: (payload: Partial<PipelineSavedView>) => Promise<void>
  onDuplicateView?: (view: PipelineSavedView) => Promise<void>
  onResetView?: () => void
  selectedId: string | null
  selectedOpportunity?: PipelineOpportunity | null
  detailLoading?: boolean
  detailError?: string | null
  layoutMode: ViewLayoutMode
  groupBy: PipelineGroupByMode
  loading?: boolean
  refreshing?: boolean
  onGroupByChange: (mode: PipelineGroupByMode) => void
  onSelect: (id: string) => void
  onClearSelection?: () => void
  onRetryDetail?: () => void
  onOpenCommandView: (threadId?: string | null) => void
  onOpenDealIntelligence: (threadId?: string | null) => void
  onAction: (id: string, action: string, payload?: Record<string, unknown>) => void | Promise<void>
  onMoveStage: (id: string, stageId: string, reason?: string) => Promise<void>
  onMoveStatus: (id: string, statusId: string, reason?: string) => Promise<void>
  onMoveTemperature: (id: string, temperatureId: string, reason?: string) => Promise<void>
  onApplySavedView?: (view: PipelineSavedView) => void
}

export function PipelineOpportunityBoard({
  opportunities,
  metrics,
  globalTotal = 0,
  scope = 'active',
  onScopeChange,
  savedViews = [],
  viewState,
  cardDesign,
  filters,
  sorts,
  onFiltersChange,
  onSortsChange,
  onCardDesignChange,
  onPersistView,
  onDuplicateView,
  onResetView,
  selectedId,
  selectedOpportunity,
  detailLoading,
  detailError,
  layoutMode,
  groupBy,
  loading,
  refreshing,
  onGroupByChange,
  onSelect,
  onClearSelection,
  onRetryDetail,
  onOpenCommandView,
  onOpenDealIntelligence,
  onAction,
  onMoveStage,
  onMoveStatus,
  onMoveTemperature,
  onApplySavedView,
}: PipelineOpportunityBoardProps) {
  const [query, setQuery] = useState('')
  const [hotOnly, setHotOnly] = useState(false)
  const [followUpOnly, setFollowUpOnly] = useState(false)
  const [showSuppressed, setShowSuppressed] = useState(false)
  const [activeStageId, setActiveStageId] = useState('')
  const [dragCardId, setDragCardId] = useState<string | null>(null)
  const [dragOverStage, setDragOverStage] = useState<string | null>(null)
  const [showDetail, setShowDetail] = useState(true)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [dockOpen, setDockOpen] = useState(false)
  const [transitionError, setTransitionError] = useState<string | null>(null)
  const [cardDesignerOpen, setCardDesignerOpen] = useState(false)
  const [viewManagerOpen, setViewManagerOpen] = useState(false)
  const dragStateRef = useRef<{ id: string; startX: number; startY: number; dragging: boolean } | null>(null)

  const activeCardDesign = normalizeCardDesign(
    cardDesign ?? viewState?.cardDesign ?? DEFAULT_PIPELINE_CARD_DESIGN,
    groupBy,
  )

  const allCards = useMemo(() => opportunities.map(buildCard), [opportunities])
  const mutableView = isGroupByMutable(groupBy)
  const readOnlyView = isGroupByReadOnly(groupBy)

  const visibleCards = useMemo(() => {
    const q = query.trim().toLowerCase()
    return allCards
      .filter((c) => {
        if (!showSuppressed && c.suppressed) return false
        if (hotOnly && resolveTemperature(c.opp) !== 'hot') return false
        if (followUpOnly && !c.followUpDue) return false
        if (!q) return true
        return [
          c.opp.seller_display_name,
          c.opp.property_address_full,
          c.opp.market,
          c.opp.latest_intent,
          c.opp.next_action,
        ].some((s) => String(s ?? '').toLowerCase().includes(q))
      })
  }, [allCards, query, showSuppressed, hotOnly, followUpOnly])

  const groupDefinitions = useMemo(
    () => groupDefinitionsForMode(groupBy, visibleCards.map((c) => c.opp)),
    [groupBy, visibleCards],
  )

  const stageModels = useMemo<StageModel[]>(() =>
    groupDefinitions.map((def) => ({
      def,
      cards: visibleCards.filter((c) => groupKeyForOpportunity(c.opp, groupBy) === def.id),
      count: visibleCards.filter((c) => groupKeyForOpportunity(c.opp, groupBy) === def.id).length,
    })),
  [groupDefinitions, groupBy, visibleCards])

  const displayStageModels = useMemo(() => {
    if (dragCardId && mutableView) return stageModels
    const populated = stageModels.filter((s) => s.count > 0)
    return populated.length > 0 ? populated : stageModels
  }, [stageModels, dragCardId, mutableView])

  const selectedCard = useMemo(
    () => visibleCards.find((c) => c.opp.id === selectedId) ?? null,
    [visibleCards, selectedId],
  )

  const panelOpportunity = selectedOpportunity ?? selectedCard?.opp ?? null

  useEffect(() => {
    if (displayStageModels.some((s) => s.def.id === activeStageId)) return
    setActiveStageId(displayStageModels[0]?.def.id ?? '')
  }, [activeStageId, displayStageModels])

  const handleDrop = useCallback(async (e: React.DragEvent, stageId: string) => {
    e.preventDefault()
    const cardId = e.dataTransfer.getData('text/plain')
    setDragCardId(null)
    setDragOverStage(null)
    if (!cardId || !mutableView) return

    const card = visibleCards.find((c) => c.opp.id === cardId)
    if (!card) return

    const currentKey = groupKeyForOpportunity(card.opp, groupBy)
    if (currentKey === stageId) return

    try {
      setTransitionError(null)
      if (groupBy === 'stage') {
        await onMoveStage(cardId, stageId)
      } else if (groupBy === 'status') {
        await onMoveStatus(cardId, stageId)
      } else if (groupBy === 'temperature') {
        const temp = stageId === 'warm' ? 'warming' : stageId
        await onMoveTemperature(cardId, temp)
      }
    } catch (err) {
      setTransitionError(err instanceof Error ? err.message : 'Update failed')
    }
  }, [groupBy, mutableView, onMoveStage, onMoveStatus, onMoveTemperature, visibleCards])

  const beginPointerDrag = useCallback((e: React.PointerEvent, cardId: string) => {
    if (!mutableView) return
    dragStateRef.current = { id: cardId, startX: e.clientX, startY: e.clientY, dragging: false }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }, [mutableView])

  const movePointerDrag = useCallback((e: React.PointerEvent) => {
    const state = dragStateRef.current
    if (!state || state.dragging) return
    const dx = Math.abs(e.clientX - state.startX)
    const dy = Math.abs(e.clientY - state.startY)
    if (dx > DRAG_THRESHOLD_PX || dy > DRAG_THRESHOLD_PX) {
      state.dragging = true
      setDragCardId(state.id)
    }
  }, [])

  const endPointerDrag = useCallback(() => {
    dragStateRef.current = null
    setDragCardId(null)
    setDragOverStage(null)
  }, [])

  const handleCardClick = useCallback((cardId: string) => {
    if (dragStateRef.current?.dragging) return
    onSelect(cardId)
    setShowDetail(true)
    setPanelCollapsed(false)
    if (layoutMode === 'compact') setDockOpen(true)
  }, [layoutMode, onSelect])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDockOpen(false)
        onClearSelection?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClearSelection])

  const kpi = metrics ?? {
    active_opportunities: visibleCards.filter((c) => !c.suppressed).length,
    new_replies: visibleCards.filter((c) => c.needsAttention).length,
    offer_ready: 0,
    follow_ups_due: visibleCards.filter((c) => c.followUpDue).length,
    negotiating: 0,
    under_contract: 0,
    blocked: 0,
    intent_positive_pct: 0,
    average_stage_age_days: 0,
  }

  const previewOpp = selectedOpportunity ?? selectedCard?.opp ?? visibleCards[0]?.opp ?? null

  const isCompact = layoutMode === 'compact'
  const isMedium = layoutMode === 'medium'
  const isOps = layoutMode === 'expanded'
  const isFull = layoutMode === 'full'
  const activeStage = displayStageModels.find((s) => s.def.id === activeStageId) ?? displayStageModels[0]

  const renderCard = (card: OppCard) => {
    return (
      <PipelineConfigurableCard
        key={card.opp.id}
        opp={card.opp}
        design={activeCardDesign}
        layoutMode={layoutMode}
        selected={card.opp.id === selectedId}
        dragging={dragCardId === card.opp.id}
        mutableView={mutableView}
        onClick={() => handleCardClick(card.opp.id)}
        onReplyAction={() => onOpenCommandView(card.opp.primary_thread_key)}
        onDragStart={(e) => {
          setDragCardId(card.opp.id)
          e.dataTransfer.setData('text/plain', card.opp.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={endPointerDrag}
        onPointerDown={(e) => beginPointerDrag(e, card.opp.id)}
        onPointerMove={movePointerDrag}
        onPointerUp={endPointerDrag}
      />
    )
  }

  if (isCompact) {
    const dockOpp = selectedCard?.opp ?? panelOpportunity
    return (
      <div className="plv plv--rail">
        <ScopeBar scope={scope} onScopeChange={onScopeChange} metrics={kpi} globalTotal={globalTotal} compact />
        <KpiStrip metrics={kpi} compact />
        {transitionError && <div className="plv-transition-error" role="alert">{transitionError}</div>}
        <div className="plv-filters">
          <PipelineViewSelector value={groupBy} onChange={onGroupByChange} compact />
        </div>
        <div className="plv-stage-chips plv-stage-chips--sm">
          {displayStageModels.map((s) => (
            <button key={s.def.id} type="button" className={cls('plv-stage-chip', `is-${s.def.tone}`, s.def.id === activeStageId && 'is-active')} onClick={() => setActiveStageId(s.def.id)}>
              {s.def.label} {s.count > 0 && <span className="plv-stage-chip__count">{s.count}</span>}
            </button>
          ))}
        </div>
        <div className="plv-card-rail">
          {(activeStage?.cards ?? []).map((card) => renderCard(card))}
        </div>
        {dockOpen && dockOpp && (
          <div className="plv-context-dock nx-glass-menu" role="dialog" aria-label="Opportunity context">
            <button type="button" className="plv-context-dock__close" onClick={() => { setDockOpen(false); onClearSelection?.() }} aria-label="Close">×</button>
            <strong>{dockOpp.seller_display_name || 'Unknown Seller'}</strong>
            <span>{dockOpp.property_address_full || portfolioLabel(dockOpp)}</span>
            <div className="plv-context-dock__chips">
              <span>{stageLabel(resolvePipelineStage(dockOpp))}</span>
              <span>{stageLabel(resolveUniversalStatus(dockOpp))}</span>
              <span>{stageLabel(resolveTemperature(dockOpp))}</span>
            </div>
            <p>{dockOpp.latest_message_preview || 'No recent message.'}</p>
            <p className="plv-context-dock__action">{dockOpp.next_action || 'Review'}</p>
            <div className="plv-context-dock__actions">
              <button type="button" className="plv-action-btn" onClick={() => onOpenCommandView(dockOpp.primary_thread_key)}>Open Conversation</button>
              <button type="button" className="plv-action-btn" onClick={() => onOpenDealIntelligence(dockOpp.primary_thread_key)}>Deal Intelligence</button>
              <button type="button" className="plv-action-btn" onClick={() => onAction(dockOpp.id, 'open_map')}>Map</button>
            </div>
          </div>
        )}
      </div>
    )
  }

  if (isMedium) {
    return (
      <div className="plv plv--focused">
        <KpiStrip metrics={kpi} compact />
        {transitionError && <div className="plv-transition-error" role="alert">{transitionError}</div>}
        <div className="plv-filters">
          <PipelineViewSelector value={groupBy} onChange={onGroupByChange} />
        </div>
        <div className="plv-stage-chips plv-stage-chips--md">
          {displayStageModels.map((s) => (
            <button key={s.def.id} type="button" className={cls('plv-stage-chip', `is-${s.def.tone}`, s.def.id === activeStageId && 'is-active')} onClick={() => setActiveStageId(s.def.id)}>
              {s.def.label} {s.count > 0 && <span className="plv-stage-chip__count">{s.count}</span>}
            </button>
          ))}
        </div>
        <div className="plv-focused-list">
          {(activeStage?.cards ?? []).map((card) => renderCard(card))}
        </div>
        {panelOpportunity && (
          <div className="plv-drawer">
            <PipelineCommandPanel
              opportunity={panelOpportunity}
              loading={detailLoading}
              onOpenCommandView={onOpenCommandView}
              onOpenConversation={onOpenCommandView}
              onOpenDealIntelligence={onOpenDealIntelligence}
              onAction={onAction}
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={cls('plv', isOps ? 'plv--ops' : isFull ? 'plv--full' : 'plv--focused')}>
      <KpiStrip metrics={kpi} compact={isOps} />
      {transitionError && <div className="plv-transition-error" role="alert">{transitionError}</div>}
      <ScopeBar scope={scope} onScopeChange={onScopeChange} metrics={kpi} globalTotal={globalTotal} />
      {loading && opportunities.length === 0 && <div className="plv-loading" aria-live="polite">Loading opportunities…</div>}
      {refreshing && opportunities.length > 0 && <div className="plv-refreshing" aria-live="polite">Refreshing…</div>}

      <div className="plv-topbar">
        <div className="plv-filters">
          <div className="plv-filters__search">
            <span className="plv-filters__search-icon">⌕</span>
            <input
              type="search"
              className="plv-filters__input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Seller, address, intent, action…"
            />
          </div>
          <div className="plv-filters__controls">
            <PipelineViewSelector value={groupBy} onChange={onGroupByChange} compact={isCompact} />
            {onSortsChange && sorts && (
              <PipelineSortBuilder sorts={sorts} onChange={onSortsChange} />
            )}
            {onFiltersChange && filters && (
              <PipelineFilterBuilder filters={filters} onChange={onFiltersChange} />
            )}
            <button type="button" className="plv-filter-chip nx-glass-menu" onClick={() => setCardDesignerOpen(true)}>
              Customize Cards
            </button>
            {viewState && onPersistView && onDuplicateView && (
              <PipelineViewManager
                open={viewManagerOpen}
                onClose={() => setViewManagerOpen(false)}
                viewState={viewState}
                savedViews={savedViews}
                onApplyView={(v) => onApplySavedView?.(v)}
                onSaveView={onPersistView}
                onDuplicateView={onDuplicateView}
              />
            )}
            <button type="button" className="plv-filter-chip nx-glass-menu" onClick={() => setViewManagerOpen(true)}>
              Save View
            </button>
            {onResetView && (
              <button type="button" className="plv-filter-chip nx-glass-menu" onClick={onResetView}>
                Reset View
              </button>
            )}
            <button type="button" className={cls('plv-filter-chip', hotOnly && 'is-active')} onClick={() => setHotOnly(!hotOnly)}>Hot</button>
            <button type="button" className={cls('plv-filter-chip', followUpOnly && 'is-active')} onClick={() => setFollowUpOnly(!followUpOnly)}>Due</button>
            <button type="button" className={cls('plv-filter-chip', showSuppressed && 'is-active')} onClick={() => setShowSuppressed(!showSuppressed)}>
              {showSuppressed ? 'Hide Supp.' : 'Show Supp.'}
            </button>
          </div>
        </div>
        {savedViews.length > 0 && (
          <div className="plv-saved-views">
            {savedViews.filter((v) => v.is_pinned).map((view) => (
              <button key={view.id} type="button" className="plv-saved-view-chip" onClick={() => onApplySavedView?.(view)}>
                {view.label}
              </button>
            ))}
          </div>
        )}
        {isOps && (
          <button type="button" className={cls('plv-detail-toggle', showDetail && 'is-active')} onClick={() => setShowDetail((d) => !d)}>
            {showDetail ? '⊠' : '⊡'} Detail
          </button>
        )}
      </div>

      {readOnlyView && (
        <div className="plv-readonly-banner" role="status">
          Read-only view — drag is disabled for {groupBy.replace(/_/g, ' ')} grouping
        </div>
      )}

      {!loading && opportunities.length === 0 && (
        <div className="plv-board-empty" role="status">
          <strong>No opportunities in this view</strong>
          <span>Try changing scope, clearing filters, or resetting the view.</span>
          {onResetView && (
            <button type="button" className="plv-glass-btn plv-glass-btn--primary" onClick={onResetView}>
              Reset filters &amp; card layout
            </button>
          )}
        </div>
      )}

      <div className="plv-workspace">
        <div className="plv-board">
          {displayStageModels.map((stage) => (
            <div
              key={stage.def.id}
              className={cls('plv-lane', `is-${stage.def.tone}`, readOnlyView && 'is-readonly', dragOverStage === stage.def.id && 'is-drag-over')}
              onDragOver={(e) => {
                if (!mutableView) return
                e.preventDefault()
                setDragOverStage(stage.def.id)
              }}
              onDrop={(e) => void handleDrop(e, stage.def.id)}
            >
              <header className="plv-lane__header">
                <div className="plv-lane__title-row">
                  <span className="plv-lane__name">{stage.def.label}</span>
                  <span className={cls('plv-lane__count', stage.count > 0 && `is-${stage.def.tone}`)}>{stage.count}</span>
                </div>
                {readOnlyView && <span className="plv-lane__readonly-badge">Read-only</span>}
              </header>
              <div className="plv-lane__body">
                {stage.cards.length > 0 ? (
                  stage.cards.map((card) => renderCard(card))
                ) : (
                  <div className="plv-empty-lane"><span className="plv-empty-lane__icon">·</span><span>No deals in {stage.def.label}</span></div>
                )}
              </div>
            </div>
          ))}
        </div>

        {(isFull || (isOps && showDetail)) && (
          <aside className="plv-detail-panel">
            {panelOpportunity ? (
              <PipelineCommandPanel
                opportunity={panelOpportunity}
                loading={detailLoading}
                error={detailError}
                onRetry={onRetryDetail}
                collapsed={panelCollapsed}
                onToggleCollapse={() => setPanelCollapsed((v) => !v)}
                onOpenCommandView={onOpenCommandView}
                onOpenConversation={onOpenCommandView}
                onOpenDealIntelligence={onOpenDealIntelligence}
                onAction={onAction}
              />
            ) : (
              <div className="plv-detail-empty">
                <span className="plv-detail-empty__icon">◎</span>
                <strong>Select an opportunity</strong>
                <p>Overview, conversation, property, intelligence, workflow, and activity appear here.</p>
              </div>
            )}
          </aside>
        )}
      </div>

      {activeCardDesign && onCardDesignChange && (
        <PipelineCardDesigner
          open={cardDesignerOpen}
          onClose={() => setCardDesignerOpen(false)}
          design={activeCardDesign}
          groupBy={groupBy}
          previewOpp={previewOpp}
          onChange={onCardDesignChange}
          onSave={() => onCardDesignChange(activeCardDesign)}
        />
      )}
    </div>
  )
}

function ScopeBar({
  scope,
  onScopeChange,
  metrics,
  globalTotal,
  compact,
}: {
  scope: PipelineScope
  onScopeChange?: (scope: PipelineScope) => void
  metrics: PipelineMetrics | Record<string, number>
  globalTotal: number
  compact?: boolean
}) {
  const m = metrics as PipelineMetrics
  const scoped = m.active_opportunities ?? m.total ?? 0
  return (
    <div className={cls('plv-scope-bar', compact && 'plv-scope-bar--compact')}>
      <div className="plv-scope-bar__counts">
        <strong>{scoped} scoped</strong>
        <span>·</span>
        <span>{globalTotal} total</span>
      </div>
      {onScopeChange && (
        <div className="plv-scope-bar__options">
          {PIPELINE_SCOPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={cls('plv-scope-chip', scope === opt.value && 'is-active')}
              onClick={() => onScopeChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function KpiStrip({ metrics, compact }: { metrics: PipelineMetrics | Record<string, number>; compact?: boolean }) {
  const m = metrics as PipelineMetrics
  const items = compact
    ? [
        { label: 'Active Opportunities', value: String(m.active_opportunities ?? 0), tip: 'Active + waiting + paused opportunities', tone: 'blue' },
        { label: 'New Replies', value: String(m.new_replies ?? 0), tip: 'Seller replies needing attention', tone: 'cyan' },
        { label: 'Offer Ready', value: String(m.offer_ready ?? 0), tip: 'Decision & Offer stage', tone: 'green' },
        { label: 'Follow-Ups Due', value: String(m.follow_ups_due ?? 0), tip: 'Workflow scheduled tasks due now', tone: 'amber' },
      ]
    : [
        { label: 'Active Opportunities', value: String(m.active_opportunities ?? 0), tip: 'Canonical active deal count', tone: 'blue' },
        { label: 'New Replies', value: String(m.new_replies ?? 0), tip: 'Unread or seller-replied conversations', tone: 'cyan' },
        { label: 'Qualified', value: String(m.qualified ?? 0), tip: 'Interest qualification stage', tone: 'blue' },
        { label: 'Negotiating', value: String(m.negotiating ?? 0), tip: 'Decision & Offer stage', tone: 'green' },
        { label: 'Under Contract', value: String(m.under_contract ?? 0), tip: 'Contract to Close stage', tone: 'green' },
        { label: 'Follow-Ups Due', value: String(m.follow_ups_due ?? 0), tip: 'From workflow_scheduled_tasks', tone: 'amber' },
        { label: 'Blocked', value: String(m.blocked ?? 0), tip: 'Workflow blocked or explicit blocker', tone: 'red' },
        { label: 'Intent+', value: `${m.intent_positive_pct ?? 0}%`, tip: 'Positive intent share', tone: 'green' },
        { label: 'Avg Stage Age', value: `${m.average_stage_age_days ?? 0}d`, tip: 'Average days in current stage', tone: 'neutral' },
      ]

  return (
    <div className={cls('plv-kpi', compact && 'plv-kpi--compact')}>
      {items.map(({ label, value, tip, tone }) => (
        <div key={label} className="plv-kpi__item" title={tip}>
          <span className="plv-kpi__label">{label}</span>
          <strong className={cls('plv-kpi__value', `is-${tone}`)}>{value}</strong>
        </div>
      ))}
    </div>
  )
}