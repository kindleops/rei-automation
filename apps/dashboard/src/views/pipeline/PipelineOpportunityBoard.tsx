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
import { PipelineConfigurableCard } from './components/PipelineConfigurableCard'
import { PipelineRichDealCard } from './components/PipelineRichDealCard'
import { PipelineFilterMenu } from './components/PipelineFilterMenu'
import { PipelineCardDesigner } from './components/PipelineCardDesigner'
import { PipelineSortBuilder } from './components/PipelineSortBuilder'
import { PipelineFilterBuilder } from './components/PipelineFilterBuilder'
import { PipelineViewManager } from './components/PipelineViewManager'
import { StageChangeConfirmModal } from '../../modules/inbox/components/StageChangeConfirmModal'
import { normalizeLifecycleStage, type LifecycleStageCode } from '../../domain/lead-state/universal-lead-state-registry'
import { useBreakpoint } from '../../modules/mobile/useBreakpoint'
import { PipelineMobileFilterSheet } from './components/PipelineMobileFilterSheet'
import {
  EMPTY_FILTERS,
  SORT_OPTIONS,
  activeFilterCount,
  applyFilters,
  applySort,
  followUpDue as isFollowUpDueCanonical,
  needsResponse as isNeedsResponse,
  stageOf,
  statusOf,
  temperatureOf,
  type PipelineMobileFilters,
  type PipelineMobileSortId,
} from './components/pipeline-mobile-filters'
import { PipelineMobileCommandBar } from './components/PipelineMobileCommandBar'
import { PipelineMobileSpine } from './components/PipelineMobileSpine'
import { PipelineMobileRow } from './components/PipelineMobileRow'
import { MobileWorkflowControls } from '../../modules/deal-intelligence/mobile/MobileWorkflowControls'
import { PipelineLeadCommandSheet } from './components/PipelineLeadCommandSheet'
import { PipelineMobileDetailSheet } from './components/PipelineMobileDetailSheet'
import { PipelineMobileOpportunityDetail } from './components/PipelineMobileOpportunityDetail'
import '../../modules/inbox/queue-ops.css'
import './pipeline-view.css'
import './pipeline-mobile.css'
import './pipeline-mobile-board.css'

/** Compact scope labels for the mobile board. */
const MOBILE_SCOPE_LABELS: Record<string, string> = {
  active: 'Active',
  needs_attention: 'Attention',
  all: 'All',
  dead: 'Dead',
  suppressed: 'Suppressed',
  closed: 'Closed',
}

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const COLLAPSED_LANES_KEY = 'pipeline_collapsed_lanes_v1'
const DRAG_THRESHOLD_PX = 8

function loadCollapsedLanes(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_LANES_KEY)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch { /* ignore */ }
  return new Set()
}

function saveCollapsedLanes(ids: Set<string>) {
  try { localStorage.setItem(COLLAPSED_LANES_KEY, JSON.stringify([...ids])) } catch { /* ignore */ }
}

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
  scopedTotal?: number
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
  onPersistView?: (payload: Partial<PipelineSavedView>) => Promise<PipelineSavedView | void>
  onDuplicateView?: (view: PipelineSavedView) => Promise<void>
  onResetView?: () => void
  selectedId: string | null
  selectedOpportunity?: PipelineOpportunity | null
  detailLoading?: boolean
  detailError?: string | null
  /** Re-reads the board so counts/membership reconcile after a workflow move. */
  onRefresh?: () => void | Promise<void>
  layoutMode: ViewLayoutMode
  groupBy: PipelineGroupByMode
  loading?: boolean
  refreshing?: boolean
  onGroupByChange: (mode: PipelineGroupByMode) => void
  onSelect: (id: string) => void
  onPreview?: (id: string) => void
  onClearPreview?: () => void
  onClearSelection?: () => void
  onRetryDetail?: () => void
  onOpenCommandView: (threadId?: string | null) => void
  onOpenDealIntelligence: (threadId?: string | null) => void
  onOpenSellerAutomation?: (opportunity: PipelineOpportunity) => void
  onAction: (id: string, action: string, payload?: Record<string, unknown>) => void | Promise<void>
  onMoveStage: (id: string, stageId: string, reason?: string, options?: { executeNextAction?: boolean }) => Promise<void>
  onMoveStatus: (id: string, statusId: string, reason?: string) => Promise<void>
  onMoveTemperature: (id: string, temperatureId: string, reason?: string) => Promise<void>
  onApplySavedView?: (view: PipelineSavedView) => void
}

export function PipelineOpportunityBoard({
  opportunities,
  metrics,
  globalTotal = 0,
  scopedTotal = 0,
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
  onRefresh,
  onGroupByChange,
  onSelect,
  onPreview,
  onClearPreview,
  onClearSelection,
  onRetryDetail,
  onOpenCommandView,
  onOpenDealIntelligence: _onOpenDealIntelligence,
  onOpenSellerAutomation,
  onAction,
  onMoveStage,
  onMoveStatus,
  onMoveTemperature,
  onApplySavedView,
}: PipelineOpportunityBoardProps) {
  const [query, setQuery] = useState('')
  const [hotOnly, setHotOnly] = useState(false)
  const [followUpOnly, setFollowUpOnly] = useState(false)
  // Mobile board filter/sort state. One object so the quick-filter chips and the
  // Filters sheet cannot disagree about what is selected.
  const [mobileFilters, setMobileFilters] = useState<PipelineMobileFilters>(EMPTY_FILTERS)
  const [mobileSort, setMobileSort] = useState<PipelineMobileSortId>('recent')
  const [filterSheetOpen, setFilterSheetOpen] = useState(false)
  const [showSuppressed, setShowSuppressed] = useState(false)
  const [activeStageId, setActiveStageId] = useState('')
  const [dragCardId, setDragCardId] = useState<string | null>(null)
  const [dragOverStage, setDragOverStage] = useState<string | null>(null)
  const [showDetail, setShowDetail] = useState(true)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [dockOpen, setDockOpen] = useState(false)
  const [transitionError, setTransitionError] = useState<string | null>(null)
  const [stageConfirm, setStageConfirm] = useState<{
    cardId: string
    stageId: string
    fromStage: LifecycleStageCode
    toStage: LifecycleStageCode
  } | null>(null)
  const [stageConfirmPending, setStageConfirmPending] = useState(false)
  const [cardDesignerOpen, setCardDesignerOpen] = useState(false)
  const [viewManagerOpen, setViewManagerOpen] = useState(false)
  const [groupOverrides, setGroupOverrides] = useState<Record<string, string>>({})
  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(loadCollapsedLanes)
  const pointerDragRef = useRef<{ cardId: string; startX: number; startY: number; active: boolean } | null>(null)
  const suppressClickRef = useRef(false)
  const { isMobile } = useBreakpoint()
  const [commandLead, setCommandLead] = useState<PipelineOpportunity | null>(null)
  const [workflowThread, setWorkflowThread] = useState<{
    threadKey: string; name: string; stage: string | null; status: string | null; temperature: string | null
  } | null>(null)

  useEffect(() => {
    setGroupOverrides({})
  }, [groupBy])

  const toggleLaneCollapse = useCallback((laneId: string) => {
    setCollapsedLanes((prev) => {
      const next = new Set(prev)
      if (next.has(laneId)) next.delete(laneId)
      else next.add(laneId)
      saveCollapsedLanes(next)
      return next
    })
  }, [])

  const activeCardDesign = normalizeCardDesign(
    cardDesign ?? viewState?.cardDesign ?? DEFAULT_PIPELINE_CARD_DESIGN,
    groupBy,
  )

  const allCards = useMemo(() => opportunities.map(buildCard), [opportunities])
  const mutableView = isGroupByMutable(groupBy)
  const readOnlyView = isGroupByReadOnly(groupBy)

  /**
   * Scope + query, before the mobile filter/sort funnel. Desktop stops here.
   */
  const scopedCards = useMemo(() => {
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

  /**
   * The mobile universe. Everything downstream — stage counts, the rendered
   * list, the header total — reads from this one array, which is what keeps the
   * numbers on screen describing the same set. See the count contract in
   * `pipeline-mobile-filters.ts`.
   */
  const visibleCards = useMemo(() => {
    if (!isMobile) return scopedCards
    const byId = new Map(scopedCards.map((c) => [c.opp.id, c]))
    const filtered = applyFilters(scopedCards.map((c) => c.opp), mobileFilters)
    return applySort(filtered, mobileSort)
      .map((opp) => byId.get(opp.id))
      .filter((c): c is OppCard => Boolean(c))
  }, [scopedCards, isMobile, mobileFilters, mobileSort])

  /** Facet counts are taken from the scoped set so a chip never reads zero
   *  purely because another filter is already hiding its matches. */
  const mobileFacets = useMemo(() => {
    const opps = scopedCards.map((c) => c.opp)
    const tally = (pick: (o: PipelineOpportunity) => string) => {
      const m = new Map<string, number>()
      for (const o of opps) {
        const k = pick(o)
        if (k) m.set(k, (m.get(k) ?? 0) + 1)
      }
      return m
    }
    const toOptions = (m: Map<string, number>, label: (k: string) => string) =>
      [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, count]) => ({ id, label: label(id), count }))

    return {
      stages: toOptions(tally(stageOf), (k) => stageLabel(k as never) || k),
      statuses: toOptions(tally(statusOf), (k) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())),
      temperatures: toOptions(tally(temperatureOf), (k) => k.replace(/^./, (c) => c.toUpperCase())),
      needsResponse: opps.filter(isNeedsResponse).length,
      followUpDue: opps.filter(isFollowUpDueCanonical).length,
    }
  }, [scopedCards])

  const groupDefinitions = useMemo(
    () => groupDefinitionsForMode(groupBy, visibleCards.map((c) => c.opp)),
    [groupBy, visibleCards],
  )

  const resolveGroupKey = useCallback((opp: PipelineOpportunity) => {
    return groupOverrides[opp.id] ?? groupKeyForOpportunity(opp, groupBy)
  }, [groupBy, groupOverrides])

  const stageModels = useMemo<StageModel[]>(() =>
    groupDefinitions.map((def) => ({
      def,
      cards: visibleCards.filter((c) => resolveGroupKey(c.opp) === def.id),
      count: visibleCards.filter((c) => resolveGroupKey(c.opp) === def.id).length,
    })),
  [groupDefinitions, resolveGroupKey, visibleCards])

  const displayStageModels = stageModels

  const selectedCard = useMemo(
    () => visibleCards.find((c) => c.opp.id === selectedId) ?? null,
    [visibleCards, selectedId],
  )

  const panelOpportunity = selectedOpportunity ?? selectedCard?.opp ?? null

  useEffect(() => {
    if (displayStageModels.some((s) => s.def.id === activeStageId)) return
    setActiveStageId(displayStageModels[0]?.def.id ?? '')
  }, [activeStageId, displayStageModels])

  /**
   * Land the operator somewhere with leads in it.
   *
   * Selecting "Follow-ups due" used to leave the board on whatever stage was
   * already active, which for 13 matching leads spread across other stages
   * meant an empty list under a header reading 13. The counts agreed; the board
   * was still useless. When the active stage empties out but the filtered set
   * is not empty, move to its biggest stage.
   *
   * Only fires on a genuinely empty active stage, so a deliberate tap on a
   * zero-count stage is never overridden.
   */
  const filterSignature = `${activeFilterCount(mobileFilters)}:${JSON.stringify(mobileFilters)}`
  const lastFilterSignature = useRef(filterSignature)
  useEffect(() => {
    if (!isMobile) return
    if (lastFilterSignature.current === filterSignature) return
    lastFilterSignature.current = filterSignature
    const active = displayStageModels.find((s) => s.def.id === activeStageId)
    if (active && active.count > 0) return
    const biggest = [...displayStageModels].sort((a, b) => b.count - a.count)[0]
    if (biggest && biggest.count > 0) setActiveStageId(biggest.def.id)
  }, [filterSignature, isMobile, displayStageModels, activeStageId])

  const commitDrop = useCallback(async (
    cardId: string,
    stageId: string,
    options?: { executeNextAction?: boolean },
  ) => {
    if (!cardId || !mutableView) return

    const card = visibleCards.find((c) => c.opp.id === cardId)
    if (!card) return

    const currentKey = resolveGroupKey(card.opp)
    if (currentKey === stageId) return

    const previousOverrides = groupOverrides
    setGroupOverrides((prev) => ({ ...prev, [cardId]: stageId }))

    try {
      setTransitionError(null)
      if (groupBy === 'stage') {
        await onMoveStage(cardId, stageId, 'pipeline_drag', options)
      } else if (groupBy === 'status') {
        await onMoveStatus(cardId, stageId)
      } else if (groupBy === 'temperature') {
        const temp = stageId === 'warming' ? 'warm' : stageId
        await onMoveTemperature(cardId, temp)
      }
      setGroupOverrides((prev) => {
        const next = { ...prev }
        delete next[cardId]
        return next
      })
    } catch (err) {
      setGroupOverrides(previousOverrides)
      const message = err instanceof Error ? err.message : 'Update failed'
      setTransitionError(message.includes('vendor-chunks') || message.includes('Cannot find module')
        ? 'Could not save move. Pipeline service may be restarting — retry.'
        : message)
    }
  }, [groupBy, groupOverrides, mutableView, onMoveStage, onMoveStatus, onMoveTemperature, resolveGroupKey, visibleCards])

  const requestDrop = useCallback((cardId: string, stageId: string) => {
    if (!cardId || !mutableView) return
    const card = visibleCards.find((c) => c.opp.id === cardId)
    if (!card) return
    const currentKey = resolveGroupKey(card.opp)
    if (currentKey === stageId) return

    if (groupBy === 'stage') {
      setStageConfirm({
        cardId,
        stageId,
        fromStage: normalizeLifecycleStage(resolvePipelineStage(card.opp)),
        toStage: normalizeLifecycleStage(stageId),
      })
      return
    }
    void commitDrop(cardId, stageId)
  }, [commitDrop, groupBy, mutableView, resolveGroupKey, visibleCards])

  const handleDrop = useCallback(async (e: React.DragEvent, stageId: string) => {
    e.preventDefault()
    const cardId = e.dataTransfer.getData('text/plain')
    setDragCardId(null)
    setDragOverStage(null)
    await requestDrop(cardId, stageId)
  }, [requestDrop])

  const handleDragStart = useCallback((e: React.DragEvent, cardId: string) => {
    if (!mutableView) return
    setDragCardId(cardId)
    e.dataTransfer.setData('text/plain', cardId)
    e.dataTransfer.effectAllowed = 'move'
  }, [mutableView])

  const handleDragEnd = useCallback(() => {
    setDragCardId(null)
    setDragOverStage(null)
  }, [])

  const handleCardPointerDown = useCallback((cardId: string, e: React.PointerEvent<HTMLElement>) => {
    if (!mutableView || e.button !== 0) return
    pointerDragRef.current = { cardId, startX: e.clientX, startY: e.clientY, active: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [mutableView])

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const drag = pointerDragRef.current
      if (!drag) return
      const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY)
      if (!drag.active && dist >= DRAG_THRESHOLD_PX) {
        drag.active = true
        setDragCardId(drag.cardId)
      }
      if (drag.active) {
        const el = document.elementFromPoint(e.clientX, e.clientY)
        const lane = el?.closest('[data-lane-id]') as HTMLElement | null
        setDragOverStage(lane?.dataset.laneId ?? null)
      }
    }
    const onPointerUp = (e: PointerEvent) => {
      const drag = pointerDragRef.current
      if (drag?.active) {
        suppressClickRef.current = true
        const el = document.elementFromPoint(e.clientX, e.clientY)
        const lane = el?.closest('[data-lane-id]') as HTMLElement | null
        const stageId = lane?.dataset.laneId
        if (stageId) void requestDrop(drag.cardId, stageId)
      }
      pointerDragRef.current = null
      setDragCardId(null)
      setDragOverStage(null)
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [requestDrop])

  const handleCardClick = useCallback((cardId: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    onSelect(cardId)
    setShowDetail(true)
    setPanelCollapsed(false)
    if (layoutMode === 'compact') setDockOpen(true)
  }, [layoutMode, onSelect])

  const handleCloseInspector = useCallback(() => {
    setShowDetail(false)
    setPanelCollapsed(false)
    setDockOpen(false)
    onClearSelection?.()
  }, [onClearSelection])

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

  const stageConfirmModal = (
    <StageChangeConfirmModal
      open={Boolean(stageConfirm)}
      fromStage={stageConfirm?.fromStage ?? null}
      toStage={stageConfirm?.toStage ?? null}
      pending={stageConfirmPending}
      onCancel={() => setStageConfirm(null)}
      onChangeStageOnly={() => {
        if (!stageConfirm) return
        setStageConfirmPending(true)
        void commitDrop(stageConfirm.cardId, stageConfirm.stageId, { executeNextAction: false })
          .finally(() => {
            setStageConfirmPending(false)
            setStageConfirm(null)
          })
      }}
      onChangeStageAndRunAction={() => {
        if (!stageConfirm) return
        setStageConfirmPending(true)
        void commitDrop(stageConfirm.cardId, stageConfirm.stageId, { executeNextAction: true })
          .finally(() => {
            setStageConfirmPending(false)
            setStageConfirm(null)
          })
      }}
    />
  )

  const desktopCardTier = (): '25' | '50' | '75' | '100' => {
    if (layoutMode === 'compact') return '25'
    if (layoutMode === 'medium') return '50'
    if (layoutMode === 'expanded') return '75'
    return '100'
  }

  const renderCard = (card: OppCard, mobileLayout = false) => {
    const shared = {
      selected: card.opp.id === selectedId,
      dragging: dragCardId === card.opp.id,
      mutableView,
      onClick: () => handleCardClick(card.opp.id),
      onMouseEnter: () => onPreview?.(card.opp.id),
      onMouseLeave: () => {
        if (card.opp.id !== selectedId) onClearPreview?.()
      },
      onReplyAction: () => onOpenCommandView(card.opp.primary_thread_key),
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => handleCardPointerDown(card.opp.id, e),
      onDragStart: (e: React.DragEvent) => handleDragStart(e, card.opp.id),
      onDragEnd: handleDragEnd,
    }

    if (mobileLayout) {
      return (
        <PipelineConfigurableCard
          key={card.opp.id}
          {...shared}
          opp={card.opp}
          design={activeCardDesign}
          layoutMode={layoutMode}
          displayTier="50"
          mobileCard
        />
      )
    }

    return (
      <PipelineRichDealCard
        key={card.opp.id}
        {...shared}
        opp={card.opp}
        tier={desktopCardTier()}
      />
    )
  }

  if (isCompact && isMobile) {
    const sheetOpp = panelOpportunity
    const activeCards = activeStage?.cards ?? []

    return (
      <div className="plv plv--mobile-studio plm">
        <PipelineMobileCommandBar
          // The header total is ALWAYS the filtered universe on mobile. Using
          // the server's `scopedTotal` made the header contradict the board:
          // switching to a scope with no leads still read "258" above an empty
          // list. `globalTotal` still carries the book-wide number beside it.
          total={visibleCards.length}
          globalTotal={globalTotal}
          needsReply={mobileFacets.needsResponse}
          followUpsDue={mobileFacets.followUpDue}
          needsReplyOn={mobileFilters.needsResponse}
          followUpOn={mobileFilters.followUpDue}
          onNeedsReply={() => setMobileFilters((f) => ({ ...f, needsResponse: !f.needsResponse }))}
          onFollowUp={() => setMobileFilters((f) => ({ ...f, followUpDue: !f.followUpDue }))}
          onOpenFilters={() => setFilterSheetOpen(true)}
          filterCount={activeFilterCount(mobileFilters)}
          sortLabel={SORT_OPTIONS.find((o) => o.id === mobileSort)?.label ?? 'Newest activity'}
          scope={scope}
          scopes={PIPELINE_SCOPE_OPTIONS.map((o) => ({
            id: o.value,
            // Shorter mobile labels; the full words collided at 375px.
            label: MOBILE_SCOPE_LABELS[o.value] ?? o.label,
          }))}
          onScopeChange={(id) => onScopeChange?.(id as typeof scope)}
          query={query}
          onQueryChange={setQuery}
          refreshing={refreshing}
        />

        {filterSheetOpen ? (
          <PipelineMobileFilterSheet
            filters={mobileFilters}
            onChange={setMobileFilters}
            sort={mobileSort}
            onSortChange={setMobileSort}
            stageOptions={mobileFacets.stages}
            statusOptions={mobileFacets.statuses}
            temperatureOptions={mobileFacets.temperatures}
            needsResponseCount={mobileFacets.needsResponse}
            followUpDueCount={mobileFacets.followUpDue}
            resultCount={visibleCards.length}
            onClose={() => setFilterSheetOpen(false)}
          />
        ) : null}

        {transitionError ? (
          <div className="plm-error" role="alert">
            <strong>Couldn’t update that lead</strong>
            <span>{transitionError}</span>
          </div>
        ) : null}

        <PipelineMobileSpine
          stages={displayStageModels.map((st) => ({
            id: st.def.id,
            label: st.def.label,
            count: st.count,
          }))}
          activeId={activeStageId}
          onSelect={setActiveStageId}
        />

        <div className="plm-list">
          {loading && opportunities.length === 0 ? (
            <div className="plm-skeleton" aria-hidden="true">
              <span /><span /><span /><span /><span /><span />
            </div>
          ) : null}
          {!loading && activeCards.length === 0 ? (
            // Compact on purpose: an empty stage must not push the spine off
            // screen, because the spine is how you leave the empty stage.
            <div className="plm-empty" role="status">
              <strong>No leads in {activeStage?.def.label ?? 'this stage'}</strong>
              {activeFilterCount(mobileFilters) > 0 ? (
                <button type="button" className="plm-empty__clear"
                  onClick={() => setMobileFilters(EMPTY_FILTERS)}>
                  Clear filters
                </button>
              ) : (
                <span>Pick another stage above or widen the scope.</span>
              )}
            </div>
          ) : null}
          {activeCards.map((card) => (
            <PipelineMobileRow
              key={card.opp.id}
              opp={card.opp}
              selected={card.opp.id === selectedId}
              onOpen={() => setCommandLead(card.opp)}
              onMessage={card.opp.primary_thread_key
                ? () => onOpenCommandView(card.opp.primary_thread_key)
                : undefined}
              onWorkflow={card.opp.primary_thread_key
                ? () => setWorkflowThread({
                    threadKey: card.opp.primary_thread_key as string,
                    name: card.opp.seller_display_name ?? card.opp.property_address_full ?? 'lead',
                    stage: (card.opp as unknown as Record<string, unknown>).canonical_lifecycle_stage as string ?? null,
                    status: (card.opp as unknown as Record<string, unknown>).canonical_operational_status as string ?? null,
                    temperature: (card.opp as unknown as Record<string, unknown>).canonical_lead_temperature as string ?? null,
                  })
                : undefined}
            />
          ))}
        </div>

        <div className="plm-safe" aria-hidden="true" />

        {commandLead ? (
          <PipelineLeadCommandSheet
            opp={commandLead}
            onClose={() => setCommandLead(null)}
            onOpenConversation={(tk) => { setCommandLead(null); onOpenCommandView(tk) }}
            onOpenFullDetail={(o) => { setCommandLead(null); handleCardClick(o.id) }}
            onWorkflowPatched={() => { void onRefresh?.() }}
          />
        ) : null}

        {workflowThread ? (
          <div className="plm-sheet-root" role="dialog" aria-modal="true" aria-label="Change workflow state">
            <button type="button" className="plm-sheet-scrim" aria-label="Close"
              onClick={() => setWorkflowThread(null)} />
            <div className="plm-sheet">
              <div className="plm-sheet__grip" aria-hidden="true" />
              <h3 className="plm-sheet__title">{workflowThread.name}</h3>
              {/* The same canonical control the Seller Detail uses — same
                  registry, same optimistic commit, same PATCH. */}
              <MobileWorkflowControls
                data={{
                  threadKey: workflowThread.threadKey,
                  lifecycle_stage: workflowThread.stage,
                  operational_status: workflowThread.status,
                  lead_temperature: workflowThread.temperature,
                }}
                onPatched={() => { void onRefresh?.() }}
              />
              <button type="button" className="plm-sheet__done" onClick={() => setWorkflowThread(null)}>Done</button>
            </div>
          </div>
        ) : null}

        <PipelineMobileDetailSheet
          open={dockOpen && Boolean(sheetOpp)}
          immersive
          onClose={handleCloseInspector}
        >
          {sheetOpp && (
            <PipelineMobileOpportunityDetail
              opportunity={sheetOpp}
              loading={detailLoading}
              hydrating={detailLoading}
              error={detailError}
              onRetry={onRetryDetail}
              onClose={handleCloseInspector}
              onAction={onAction}
              onOpenCommandView={(threadId) => {
                handleCloseInspector()
                onOpenCommandView(threadId)
              }}
              onOpenSellerAutomation={onOpenSellerAutomation}
            />
          )}
        </PipelineMobileDetailSheet>

        {stageConfirmModal}
      </div>
    )
  }

  if (isCompact) {
    const dockOpp = selectedCard?.opp ?? panelOpportunity
    return (
      <div className="plv plv--rail">
        <ScopeBar scope={scope} onScopeChange={onScopeChange} metrics={kpi} scopedTotal={scopedTotal} globalTotal={globalTotal} compact />
        <KpiStrip metrics={kpi} compact />
        {transitionError && <div className="plv-transition-error" role="alert">{transitionError}</div>}
        <div className="plv-filters">
          <PipelineViewSelector value={groupBy} onChange={onGroupByChange} compact />
        </div>
        <div className="plv-stage-chips plv-stage-chips--sm">
          {displayStageModels.map((s) => (
            <button key={s.def.id} type="button" className={cls('plv-stage-chip', `is-${s.def.tone}`, s.count === 0 && 'is-empty', s.def.id === activeStageId && 'is-active')} onClick={() => setActiveStageId(s.def.id)}>
              {s.def.label} <span className="plv-stage-chip__count">{s.count}</span>
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
          </div>
        )}
        {stageConfirmModal}
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
            <button key={s.def.id} type="button" className={cls('plv-stage-chip', `is-${s.def.tone}`, s.count === 0 && 'is-empty', s.def.id === activeStageId && 'is-active')} onClick={() => setActiveStageId(s.def.id)}>
              {s.def.label} <span className="plv-stage-chip__count">{s.count}</span>
            </button>
          ))}
        </div>
        <div className="plv-focused-list">
          {(activeStage?.cards ?? []).map((card) => renderCard(card))}
        </div>
        {panelOpportunity && showDetail && (
          <div className="plv-drawer plv-drawer--overlay">
            <PipelineMobileOpportunityDetail
              variant="sheet"
              opportunity={panelOpportunity}
              loading={detailLoading}
              hydrating={detailLoading}
              onClose={handleCloseInspector}
              onAction={onAction}
              onRetry={onRetryDetail}
              error={detailError}
              onOpenCommandView={onOpenCommandView}
              onOpenSellerAutomation={onOpenSellerAutomation}
            />
          </div>
        )}
        {stageConfirmModal}
      </div>
    )
  }

  return (
    <div className={cls('plv', isOps ? 'plv--ops' : isFull ? 'plv--full' : 'plv--focused')}>
      <KpiStrip metrics={kpi} compact={isOps} />
      {transitionError && <div className="plv-transition-error" role="alert">{transitionError}</div>}
      <ScopeBar scope={scope} onScopeChange={onScopeChange} metrics={kpi} scopedTotal={scopedTotal} globalTotal={globalTotal} />
      {loading && opportunities.length === 0 && <div className="plv-loading" aria-live="polite">Loading opportunities…</div>}
      <div className="plv-topbar">
        {refreshing && opportunities.length > 0 && (
          <span className="plv-sync-indicator" aria-live="polite" title="Syncing board data">
            <span className="plv-sync-indicator__dot" />
            Syncing
          </span>
        )}
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
            <PipelineFilterMenu
              layout="desktop"
              groupBy={groupBy}
              onGroupByChange={onGroupByChange}
              hotOnly={hotOnly}
              followUpOnly={followUpOnly}
              showSuppressed={showSuppressed}
              onHotOnly={setHotOnly}
              onFollowUpOnly={setFollowUpOnly}
              onShowSuppressed={setShowSuppressed}
            />
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
          {displayStageModels.map((stage) => {
            const isCollapsed = collapsedLanes.has(stage.def.id)
            return (
            <div
              key={stage.def.id}
              data-lane-id={stage.def.id}
              className={cls(
                'plv-lane',
                `is-${stage.def.tone}`,
                readOnlyView && 'is-readonly',
                isCollapsed && 'plv-lane--collapsed',
                dragOverStage === stage.def.id && 'is-drag-over',
              )}
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
                  <button
                    type="button"
                    className="plv-lane__collapse"
                    onClick={() => toggleLaneCollapse(stage.def.id)}
                    aria-expanded={!isCollapsed}
                    title={isCollapsed ? 'Expand column' : 'Collapse column'}
                  >
                    {isCollapsed ? '▸' : '▾'}
                  </button>
                </div>
                {readOnlyView && !isCollapsed && (
                  <span className="plv-lane__readonly-badge" title={`${groupBy.replace(/_/g, ' ')} grouping is read-only — switch to Stage, Status, or Temperature to drag cards`}>
                    Read-only
                  </span>
                )}
              </header>
              {!isCollapsed && (
                <div className="plv-lane__body">
                  {stage.cards.length > 0 ? (
                    stage.cards.map((card) => renderCard(card))
                  ) : (
                    <div className="plv-empty-lane"><span className="plv-empty-lane__icon">·</span><span>No deals in {stage.def.label}</span></div>
                  )}
                </div>
              )}
            </div>
          )})}
        </div>

        {(isFull || (isOps && showDetail)) && (
          <aside className="plv-detail-panel">
            {panelOpportunity ? (
              <PipelineMobileOpportunityDetail
                variant="panel"
                opportunity={panelOpportunity}
                loading={detailLoading}
                hydrating={detailLoading}
                error={detailError}
                onRetry={onRetryDetail}
                collapsed={panelCollapsed}
                onToggleCollapse={() => setPanelCollapsed((v) => !v)}
                onClose={handleCloseInspector}
                onAction={onAction}
                onOpenCommandView={onOpenCommandView}
                onOpenSellerAutomation={onOpenSellerAutomation}
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
      {stageConfirmModal}
    </div>
  )
}

function ScopeBar({
  scope,
  onScopeChange,
  metrics: _metrics,
  scopedTotal,
  globalTotal,
  compact,
}: {
  scope: PipelineScope
  onScopeChange?: (scope: PipelineScope) => void
  metrics: PipelineMetrics | Record<string, number>
  scopedTotal: number
  globalTotal: number
  compact?: boolean
}) {
  const scopeLabel = PIPELINE_SCOPE_OPTIONS.find((o) => o.value === scope)?.label?.toLowerCase() ?? scope
  return (
    <div className={cls('plv-scope-bar', compact && 'plv-scope-bar--compact')}>
      <div
        className="plv-scope-bar__counts"
        title={`${scopedTotal} active opportunities in current scope. ${globalTotal} total canonical opportunities in acquisition_opportunities. Active excludes closed, dead, suppressed, archived, and non-opportunity records. Message/thread counts (~7,846) are a separate grain and are not shown here.`}
      >
        <strong>{scopedTotal} {scopeLabel} opportunities</strong>
        <span>·</span>
        <span>{globalTotal} total opportunities</span>
        {scope === 'active' && (
          <span className="plv-scope-bar__hint" title="Active excludes closed, dead, suppressed, archived, and non-opportunity records.">
            (excludes closed/dead/suppressed)
          </span>
        )}
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