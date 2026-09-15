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
import { readPropertyLocator } from '../../domain/locator/property-locator'
import { getUniversalEntityContextSnapshot } from '../../domain/entity-graph/universal-entity-context-store'
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

/** Names the searched set, so "Searched every Dead opportunity" reads truthfully. */
const scopeLabelFor = (scope: string) => MOBILE_SCOPE_LABELS[scope] ?? scope.replace(/_/g, ' ')

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
  /** Server-backed search state, owned by usePipelineOpportunities. */
  query?: string
  onQueryChange?: (value: string) => void
  searchActive?: boolean
  searchPending?: boolean
  appliedQuery?: string
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
  query = '',
  onQueryChange,
  searchActive = false,
  searchPending = false,
  appliedQuery = '',
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
  const [hotOnly, setHotOnly] = useState(false)
  const [followUpOnly, setFollowUpOnly] = useState(false)
  // Mobile board filter/sort state. One object so the quick-filter chips and the
  // Filters sheet cannot disagree about what is selected.
  const [mobileFilters, setMobileFilters] = useState<PipelineMobileFilters>(EMPTY_FILTERS)
  const [mobileSort, setMobileSort] = useState<PipelineMobileSortId>('recent')
  const [filterSheetOpen, setFilterSheetOpen] = useState(false)
  const [hideSuppressed, setHideSuppressed] = useState(false)
  const [activeStageId, setActiveStageId] = useState('')
  const [dragCardId, setDragCardId] = useState<string | null>(null)
  const [dragOverStage, setDragOverStage] = useState<string | null>(null)
  const [showDetail, setShowDetail] = useState(true)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [dockOpen, setDockOpen] = useState(false)

  /**
   * INCOMING PROPERTY CONTEXT — §14 / §16.
   *
   * Pipeline published context on every action but never CONSUMED it, so
   * arriving with a property subject silently dropped it. Measured 2026-09-15:
   * /pipeline?property_id=232714379 (Bertha A Daniels, a real Inbox thread with
   * NO opportunity) rendered the ordinary list starting at an unrelated
   * Indianapolis property and said nothing about the request.
   *
   * It never SUBSTITUTED a subject — nothing was selected — but silently
   * clearing the context is the other half of what §14 forbids. The operator
   * asked about one property and got a list about other ones.
   *
   * URL first (survives reload and sharing), then the sessionStorage property
   * locator, which is what the app dock and every other surface publish
   * through.
   */
  const incomingPropertyId = useMemo(() => {
    if (typeof window === 'undefined') return null
    const fromUrl = new URLSearchParams(window.location.search).get('property_id')
      ?? new URLSearchParams(window.location.search).get('property')
    const direct = String(fromUrl ?? '').trim()
    if (direct) return direct
    const locator = readPropertyLocator()
    const fromLocator = String(locator?.propertyId ?? '').trim()
    if (fromLocator) return fromLocator
    const snapshot = getUniversalEntityContextSnapshot()
    return String(snapshot?.propertyId ?? '').trim() || null
  }, [])

  /**
   * Whether that property has an opportunity at all. `null` = no property was
   * requested, so there is nothing to answer.
   */
  /**
   * §14 is about ARRIVAL, so the claim is only made in the arrival state.
   *
   * My first version searched the currently-loaded `opportunities` and said
   * "no opportunity exists" whenever it found none — which made the banner lie
   * as soon as the operator changed scope. Switching to Suppressed showed
   * "No acquisition opportunity exists for property 225438557" about David
   * Larson, whose opportunity is real and active; it simply is not suppressed.
   *
   * Once the operator narrows the board themselves, an absent row means "not in
   * this scope", which is their own doing and needs no announcement.
   */
  const scopeTouchedRef = useRef(false)
  const arrivalScopeRef = useRef<string | null>(null)
  if (arrivalScopeRef.current === null) arrivalScopeRef.current = String(viewState?.scope ?? '')
  if (arrivalScopeRef.current !== String(viewState?.scope ?? '')) scopeTouchedRef.current = true

  const incomingPropertyMatch = useMemo(() => {
    if (!incomingPropertyId) return null
    const match = opportunities.find(
      (o) => String((o as unknown as Record<string, unknown>).primary_property_id ?? '') === incomingPropertyId,
    )
    if (!match && scopeTouchedRef.current) return null
    return { propertyId: incomingPropertyId, opportunity: match ?? null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingPropertyId, opportunities, viewState?.scope])

  /**
   * When the requested property DOES have an opportunity, move to its stage so
   * the operator lands on the subject they asked for rather than on whichever
   * stage happened to be active. Once per property — re-running would fight
   * the operator's own stage navigation.
   */
  const focusedPropertyRef = useRef<string | null>(null)
  useEffect(() => {
    const match = incomingPropertyMatch?.opportunity
    if (!match) return
    const propertyId = incomingPropertyMatch?.propertyId ?? null
    if (!propertyId || focusedPropertyRef.current === propertyId) return
    focusedPropertyRef.current = propertyId
    const stage = String((match as unknown as Record<string, unknown>).acquisition_stage ?? '').trim()
    if (stage) setActiveStageId(stage)
  }, [incomingPropertyMatch])
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
  /**
   * SCOPE IS THE MEMBERSHIP AUTHORITY — §31.9.
   *
   * `suppressed`, `dead` and `closed` scopes select exactly the rows this
   * refinement removes, so applying it there subtracts the whole scope. The
   * header kept reporting the canonical count from /pipeline/counts while the
   * list rendered a different set. Measured on 2026-09-15:
   *
   *   scope            header   rendered
   *   suppressed          156          0
   *   dead                348          0
   *   closed              476          1
   *   needs_attention     292        263   (29 dropped silently)
   *   all                 768        181
   *
   * Three scopes were unreachable and two lied. The refinement is now off by
   * default and unavailable where it would empty the scope, so rows === count
   * unless the operator engages a filter that says so.
   */
  const suppressionFilterAvailable = scope !== 'suppressed' && scope !== 'dead' && scope !== 'closed'
  const hideSuppressedEffective = hideSuppressed && suppressionFilterAvailable

  /**
   * Every count on the mobile board describes the rows the board holds, which
   * is only truthful while the board holds the entire scope. If the scope ever
   * outgrows the fetch limit the operator must be told, not shown a prefix
   * that looks complete. Compared against the canonical scope total from
   * /pipeline/counts, never against another page of rows.
   */
  const loadedShortOfScope = scopedTotal > 0 && opportunities.length > 0 && opportunities.length < scopedTotal

  /**
   * NO CLIENT-SIDE QUERY FILTER — §1.
   *
   * The rows in `allCards` are already the server's answer to scope AND query.
   * Re-filtering them here would DROP real matches, because the server also
   * searches fields the card does not carry: `latest_message_preview`,
   * `primary_thread_key` (the phone), `primary_property_id` and the
   * opportunity id. A phone-number search returned rows the old client filter
   * then deleted. Same reasoning as the certified Inbox search.
   *
   * The remaining predicates are operator refinements over the returned set,
   * not a second search authority.
   */
  const scopedCards = useMemo(() => {
    return allCards
      .filter((c) => {
        if (hideSuppressedEffective && c.suppressed) return false
        if (hotOnly && resolveTemperature(c.opp) !== 'hot') return false
        if (followUpOnly && !c.followUpDue) return false
        return true
      })
  }, [allCards, hideSuppressedEffective, hotOnly, followUpOnly])

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

  /**
   * The first stage the operator lands on must be one that has leads in it.
   *
   * This used to fall back to `displayStageModels[0]` — S1 — whatever its
   * count. The Suppressed scope holds 156 opportunities in S2 and S10 and none
   * in S1, so arriving there showed an EMPTY list under a header reading 156.
   * Dead (348) and Closed (476) landed the same way. The counts were right and
   * the board was still useless, which is the same defect the stage-refocus
   * effect below was written for — it just never covered arrival.
   */
  const firstPopulatedStageId = useCallback(() => {
    const populated = displayStageModels.find((s) => s.count > 0)
    return (populated ?? displayStageModels[0])?.def.id ?? ''
  }, [displayStageModels])

  /**
   * Keep landing on a populated stage until the operator picks one themselves.
   *
   * A single arrival effect is not enough: on the first render the rows have
   * not arrived, every stage count is 0, and "the first populated stage" is
   * just S1. Once the data lands the active stage is a VALID id, so a
   * fire-once-on-invalid-id effect never runs again — which is how Suppressed
   * (156 rows, none in S1) showed an empty list under a header reading 156,
   * and Dead (348) and Closed (476) did the same.
   *
   * Re-evaluating on every count change fixes that, and the manual-choice
   * latch is what stops it from fighting the operator: a deliberate tap on a
   * zero-count stage must stick, including through a realtime refresh.
   */
  const stageChosenByOperator = useRef(false)
  const chooseStage = useCallback((id: string) => {
    stageChosenByOperator.current = true
    setActiveStageId(id)
  }, [])

  useEffect(() => {
    if (displayStageModels.length === 0) return
    const active = displayStageModels.find((s) => s.def.id === activeStageId)
    if (!active) {
      setActiveStageId(firstPopulatedStageId())
      return
    }
    if (stageChosenByOperator.current) return
    if (active.count > 0) return
    const populated = firstPopulatedStageId()
    if (populated && populated !== activeStageId) setActiveStageId(populated)
  }, [activeStageId, displayStageModels, firstPopulatedStageId])

  /**
   * Changing scope is a fresh arrival: it releases the latch so the operator
   * is landed somewhere useful in the new scope rather than kept on a stage
   * that is empty there.
   */
  const lastScopeRef = useRef(scope)
  useEffect(() => {
    if (lastScopeRef.current === scope) return
    lastScopeRef.current = scope
    stageChosenByOperator.current = false
  }, [scope])

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
   *
   * A SEARCH is the same failure mode and now shares the mechanism: q=Frauli
   * returned its one real match into a stage the operator was not looking at,
   * so the board read "1 match" above an empty list. Keyed on the APPLIED
   * query (the one the current rows answer), not the keystroke, so the stage
   * moves once per settled search rather than mid-typing.
   */
  const filterSignature = `${activeFilterCount(mobileFilters)}:${JSON.stringify(mobileFilters)}:q=${appliedQuery}`
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
          onQueryChange={onQueryChange ?? (() => {})}
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

        {/* §14 — a property with no opportunity gets a straight answer, not a
            list about other properties. Creation is NOT offered: the pipeline
            API exposes GET and PATCH only, so a "Create Opportunity" button
            here would be a dead control. */}
        {incomingPropertyMatch && !incomingPropertyMatch.opportunity ? (
          <div className="plm-nocontext" role="status">
            <strong>No acquisition opportunity exists for this property.</strong>
            <span>
              Property {incomingPropertyMatch.propertyId} has no opportunity in the pipeline, so
              nothing here is about it.
            </span>
          </div>
        ) : null}

        <PipelineMobileSpine
          stages={displayStageModels.map((st) => ({
            id: st.def.id,
            label: st.def.label,
            count: st.count,
          }))}
          activeId={activeStageId}
          onSelect={chooseStage}
        />

        <div className="plm-list">
          {/* §3 — a search states its own result count, never the scope's. */}
          {searchActive ? (
            <div className="plm-searchstate" role="status" aria-live="polite">
              {searchPending ? (
                <strong>Searching…</strong>
              ) : (
                <strong>
                  {scopedTotal} {scopedTotal === 1 ? 'match' : 'matches'} for “{query.trim()}”
                </strong>
              )}
              <span>
                Searched the whole {scopeLabelFor(scope).toLowerCase()} scope on the server — not just the loaded page.
              </span>
            </div>
          ) : null}
          {loadedShortOfScope ? (
            <div className="plm-truncated" role="status">
              <strong>
                Showing {opportunities.length} of {scopedTotal}
                {searchActive ? ' matches' : ''}
              </strong>
              <span>
                {searchActive
                  ? `More than one page of opportunities match. The counts below describe the ${opportunities.length} loaded — narrow the search to see them all.`
                  : `This scope is larger than one load, so the counts below describe the ${opportunities.length} loaded. Narrow the scope to see exact numbers.`}
              </span>
            </div>
          ) : null}
          {loading && opportunities.length === 0 ? (
            <div className="plm-skeleton" aria-hidden="true">
              <span /><span /><span /><span /><span /><span />
            </div>
          ) : null}
          {!loading && activeCards.length === 0 ? (
            // Compact on purpose: an empty stage must not push the spine off
            // screen, because the spine is how you leave the empty stage.
            <div className="plm-empty" role="status">
              {/* During a search the scope is not the thing to widen — naming
                  the query is what tells the operator why the list is empty. */}
              {searchActive ? (
                <>
                  <strong>No {scopeLabelFor(scope)} opportunity matches “{appliedQuery}”</strong>
                  <button type="button" className="plm-empty__clear" onClick={() => onQueryChange?.('')}>
                    Clear search
                  </button>
                </>
              ) : (
                <>
                  <strong>No leads in {activeStage?.def.label ?? 'this stage'}</strong>
                  {activeFilterCount(mobileFilters) > 0 ? (
                    <button type="button" className="plm-empty__clear"
                      onClick={() => setMobileFilters(EMPTY_FILTERS)}>
                      Clear filters
                    </button>
                  ) : (
                    <span>Pick another stage above or widen the scope.</span>
                  )}
                </>
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
            <button key={s.def.id} type="button" className={cls('plv-stage-chip', `is-${s.def.tone}`, s.count === 0 && 'is-empty', s.def.id === activeStageId && 'is-active')} onClick={() => chooseStage(s.def.id)}>
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
            <button key={s.def.id} type="button" className={cls('plv-stage-chip', `is-${s.def.tone}`, s.count === 0 && 'is-empty', s.def.id === activeStageId && 'is-active')} onClick={() => chooseStage(s.def.id)}>
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
              onChange={(e) => onQueryChange?.(e.target.value)}
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
              hideSuppressed={hideSuppressed}
              suppressionFilterAvailable={suppressionFilterAvailable}
              onHotOnly={setHotOnly}
              onFollowUpOnly={setFollowUpOnly}
              onHideSuppressed={setHideSuppressed}
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