import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ViewLayoutMode } from '../../domain/inbox/view-layout'
import type { PipelineGroupByMode, PipelineMetrics, PipelineOpportunity, PipelineSavedView } from '../../domain/pipeline/pipeline-opportunity.types'
import {
  groupDefinitionsForMode,
  groupKeyForOpportunity,
  isFollowUpDue,
  portfolioLabel,
  stageAgeDays,
  stageLabel,
  type StageDefinition,
  displayCurrency,
} from '../../domain/pipeline/pipeline-display-helpers'
import { formatRelativeTime } from '../../shared/formatters'
import { PipelineViewSelector } from './components/PipelineViewSelector'
import { PipelineCommandPanel } from './components/PipelineCommandPanel'
import './pipeline-view.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type SortMode = 'priority' | 'recent' | 'value' | 'stage_age'

interface OppCard {
  opp: PipelineOpportunity
  sellerName: string
  address: string
  market: string
  hot: boolean
  unread: boolean
  followUpDue: boolean
  suppressed: boolean
}

function buildCard(opp: PipelineOpportunity): OppCard {
  return {
    opp,
    sellerName: opp.seller_display_name || 'Unknown Seller',
    address: portfolioLabel(opp),
    market: opp.market || 'Market Unknown',
    hot: opp.temperature === 'hot' || (opp.aos != null && opp.aos >= 75),
    unread: opp.conversation_state === 'needs_reply' || opp.conversation_state === 'seller_replied',
    followUpDue: isFollowUpDue(opp),
    suppressed: opp.opportunity_status === 'suppressed' || opp.opportunity_status === 'dead',
  }
}

interface StageModel {
  def: StageDefinition
  cards: OppCard[]
  count: number
}

interface PipelineOpportunityBoardProps {
  opportunities: PipelineOpportunity[]
  metrics: PipelineMetrics | null
  savedViews?: PipelineSavedView[]
  selectedId: string | null
  layoutMode: ViewLayoutMode
  groupBy: PipelineGroupByMode
  loading?: boolean
  onGroupByChange: (mode: PipelineGroupByMode) => void
  onSelect: (id: string) => void
  onOpenCommandView: (threadId?: string | null) => void
  onOpenDealIntelligence: (threadId?: string | null) => void
  onAction: (id: string, action: string, payload?: Record<string, unknown>) => void | Promise<void>
  onMoveStage: (id: string, stageId: string, reason?: string) => Promise<void>
  onApplySavedView?: (view: PipelineSavedView) => void
}

export function PipelineOpportunityBoard({
  opportunities,
  metrics,
  savedViews = [],
  selectedId,
  layoutMode,
  groupBy,
  loading,
  onGroupByChange,
  onSelect,
  onOpenCommandView,
  onOpenDealIntelligence,
  onAction,
  onMoveStage,
  onApplySavedView,
}: PipelineOpportunityBoardProps) {
  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('recent')
  const [hotOnly, setHotOnly] = useState(false)
  const [followUpOnly, setFollowUpOnly] = useState(false)
  const [showSuppressed, setShowSuppressed] = useState(false)
  const [activeStageId, setActiveStageId] = useState('')
  const [dragCardId, setDragCardId] = useState<string | null>(null)
  const [dragOverStage, setDragOverStage] = useState<string | null>(null)
  const [showDetail, setShowDetail] = useState(true)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [transitionError, setTransitionError] = useState<string | null>(null)
  const [sortOpen, setSortOpen] = useState(false)

  const allCards = useMemo(() => opportunities.map(buildCard), [opportunities])

  const visibleCards = useMemo(() => {
    const q = query.trim().toLowerCase()
    return allCards
      .filter((c) => {
        if (!showSuppressed && c.suppressed) return false
        if (hotOnly && !c.hot) return false
        if (followUpOnly && !c.followUpDue) return false
        if (!q) return true
        return [c.sellerName, c.address, c.market, c.opp.latest_intent, c.opp.next_action]
          .some((s) => String(s ?? '').toLowerCase().includes(q))
      })
      .sort((a, b) => {
        if (sortMode === 'value') return (b.opp.estimated_value ?? 0) - (a.opp.estimated_value ?? 0)
        if (sortMode === 'recent') return new Date(b.opp.last_activity_at ?? 0).getTime() - new Date(a.opp.last_activity_at ?? 0).getTime()
        if (sortMode === 'stage_age') return stageAgeDays(b.opp) - stageAgeDays(a.opp)
        const pw = (p: string) => (p === 'urgent' ? 4 : p === 'high' ? 3 : p === 'normal' ? 2 : 1)
        return pw(b.opp.priority) - pw(a.opp.priority)
      })
  }, [allCards, query, showSuppressed, hotOnly, followUpOnly, sortMode])

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

  const selectedCard = useMemo(
    () => visibleCards.find((c) => c.opp.id === selectedId) ?? null,
    [visibleCards, selectedId],
  )

  useEffect(() => {
    if (stageModels.some((s) => s.def.id === activeStageId)) return
    setActiveStageId(stageModels[0]?.def.id ?? '')
  }, [activeStageId, stageModels])

  const handleDrop = useCallback(async (e: React.DragEvent, stageId: string) => {
    e.preventDefault()
    const cardId = e.dataTransfer.getData('text/plain')
    setDragCardId(null)
    setDragOverStage(null)
    if (!cardId || groupBy !== 'acquisition_stage') return

    const card = visibleCards.find((c) => c.opp.id === cardId)
    if (!card || card.opp.acquisition_stage === stageId) return

    let reason: string | undefined
    const fromIdx = groupDefinitions.findIndex((d) => d.id === card.opp.acquisition_stage)
    const toIdx = groupDefinitions.findIndex((d) => d.id === stageId)
    if (toIdx < fromIdx || Math.abs(toIdx - fromIdx) > 1) {
      reason = window.prompt('Reason for stage change (required for skip/backward moves):') || undefined
      if (!reason) {
        setTransitionError('Stage change cancelled — reason required.')
        return
      }
    }

    try {
      setTransitionError(null)
      await onMoveStage(cardId, stageId, reason)
    } catch (err) {
      setTransitionError(err instanceof Error ? err.message : 'Stage transition failed')
    }
  }, [groupBy, groupDefinitions, onMoveStage, visibleCards])

  const kpi = metrics ?? {
    active_opportunities: visibleCards.filter((c) => !c.suppressed).length,
    new_replies: visibleCards.filter((c) => c.unread).length,
    negotiating: 0,
    contract_sent: 0,
    closing: 0,
    follow_ups_due: visibleCards.filter((c) => c.followUpDue).length,
    intent_positive_pct: 0,
    average_stage_age_days: 0,
  }

  const isCompact = layoutMode === 'compact'
  const isMedium = layoutMode === 'medium'
  const isOps = layoutMode === 'expanded'
  const isFull = layoutMode === 'full'
  const activeStage = stageModels.find((s) => s.def.id === activeStageId) ?? stageModels[0]

  if (isCompact) {
    return (
      <div className="plv plv--rail">
        <KpiStrip metrics={kpi} compact />
        {transitionError && <div className="plv-transition-error" role="alert">{transitionError}</div>}
        <div className="plv-filters">
          <PipelineViewSelector value={groupBy} onChange={onGroupByChange} compact />
        </div>
        <div className="plv-stage-chips plv-stage-chips--sm">
          {stageModels.map((s) => (
            <button key={s.def.id} type="button" className={cls('plv-stage-chip', s.def.id === activeStageId && 'is-active')} onClick={() => setActiveStageId(s.def.id)}>
              {s.def.label} {s.count > 0 && <span className="plv-stage-chip__count">{s.count}</span>}
            </button>
          ))}
        </div>
        <div className="plv-card-rail">
          {(activeStage?.cards ?? []).map((card) => (
            <article key={card.opp.id} className={cls('plv-card plv-card--compact', card.opp.id === selectedId && 'is-selected')} onClick={() => onSelect(card.opp.id)} role="button" tabIndex={0}>
              <div className="plv-card__seller">{card.sellerName}</div>
              <div className="plv-card__address">{card.address}</div>
              <div className="plv-card__snippet">{card.opp.latest_message_preview || 'No context'}</div>
            </article>
          ))}
        </div>
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
          {stageModels.map((s) => (
            <button key={s.def.id} type="button" className={cls('plv-stage-chip', s.def.id === activeStageId && 'is-active')} onClick={() => setActiveStageId(s.def.id)}>
              {s.def.label} {s.count > 0 && <span className="plv-stage-chip__count">{s.count}</span>}
            </button>
          ))}
        </div>
        <div className="plv-focused-list">
          {(activeStage?.cards ?? []).map((card) => (
            <article key={card.opp.id} className={cls('plv-card plv-card--focused', card.opp.id === selectedId && 'is-selected')} onClick={() => onSelect(card.opp.id)} role="button" tabIndex={0}>
              <div className="plv-card__seller">{card.sellerName}</div>
              <div className="plv-card__address">{card.address}</div>
              <div className="plv-card__snippet">{card.opp.latest_message_preview || 'No context'}</div>
            </article>
          ))}
        </div>
        {selectedCard && (
          <div className="plv-drawer">
            <PipelineCommandPanel
              opportunity={selectedCard.opp}
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
      <KpiStrip metrics={kpi} compact={isOps || layoutMode === 'medium'} />
      {transitionError && <div className="plv-transition-error" role="alert">{transitionError}</div>}
      {loading && <div className="plv-loading">Loading opportunities…</div>}

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
            <PipelineViewSelector value={groupBy} onChange={onGroupByChange} compact={layoutMode === 'compact'} />
            <div className="plv-sort-selector">
              <button type="button" className="plv-filter-chip nx-glass-menu" onClick={() => setSortOpen((v) => !v)}>
                Sort: {sortMode.replace('_', ' ')}
              </button>
              {sortOpen && (
                <div className="plv-sort-selector__menu nx-glass-menu">
                  {(['priority', 'recent', 'value', 'stage_age'] as SortMode[]).map((mode) => (
                    <button key={mode} type="button" className={cls('plv-sort-selector__option', sortMode === mode && 'is-active')} onClick={() => { setSortMode(mode); setSortOpen(false) }}>
                      {mode.replace('_', ' ')}
                    </button>
                  ))}
                </div>
              )}
            </div>
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

      <div className="plv-workspace">
        <div className="plv-board">
          {stageModels.map((stage) => (
            <div
              key={stage.def.id}
              className={cls('plv-lane', `is-${stage.def.tone}`, dragOverStage === stage.def.id && 'is-drag-over')}
              onDragOver={(e) => { e.preventDefault(); setDragOverStage(stage.def.id) }}
              onDrop={(e) => void handleDrop(e, stage.def.id)}
            >
              <header className="plv-lane__header">
                <div className="plv-lane__title-row">
                  <span className="plv-lane__name">{stage.def.label}</span>
                  <span className="plv-lane__count">{stage.count}</span>
                </div>
              </header>
              <div className="plv-lane__body">
                {stage.cards.map((card) => (
                  <article
                    key={card.opp.id}
                    className={cls('plv-card plv-card--kanban', card.opp.id === selectedId && 'is-selected', dragCardId === card.opp.id && 'is-dragging')}
                    draggable={groupBy === 'acquisition_stage'}
                    onDragStart={(e) => { setDragCardId(card.opp.id); e.dataTransfer.setData('text/plain', card.opp.id) }}
                    onDragEnd={() => { setDragCardId(null); setDragOverStage(null) }}
                    onClick={() => onSelect(card.opp.id)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="plv-card__accent" />
                    <div className="plv-card__body">
                      <div className="plv-card__seller">{card.sellerName}</div>
                      <div className="plv-card__address">{card.address}</div>
                      <div className="plv-card__chips-row">
                        {card.hot && <span className="plv-chip is-hot">Hot</span>}
                        {card.unread && <span className="plv-chip is-unread">Reply</span>}
                        {card.followUpDue && <span className="plv-chip is-due">Due</span>}
                        {card.opp.blocker && <span className="plv-chip is-suppressed">Block</span>}
                      </div>
                      <div className="plv-card__snippet">{card.opp.latest_message_preview || 'No recent context.'}</div>
                      <div className="plv-card__meta-row">
                        <span className="plv-card__meta-label">AOS</span>
                        <span className="plv-card__meta-val">{card.opp.aos != null ? Math.round(card.opp.aos) : '—'}</span>
                        <span className="plv-card__meta-label">Stage</span>
                        <span className="plv-card__meta-val">{stageLabel(card.opp.acquisition_stage)}</span>
                      </div>
                      <div className="plv-card__footer">
                        <span className="plv-card__age">{card.opp.last_activity_at ? formatRelativeTime(card.opp.last_activity_at) : '—'}</span>
                        <span className="plv-metric is-green">{displayCurrency(card.opp.asking_price)}</span>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ))}
        </div>

        {(isFull || (isOps && showDetail)) && (
          <aside className="plv-detail-panel">
            {selectedCard ? (
              <PipelineCommandPanel
                opportunity={selectedCard.opp}
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
                <p>Overview, intelligence, workflow, and activity appear here.</p>
              </div>
            )}
          </aside>
        )}
      </div>
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