import { useCallback, useEffect, useMemo, useState } from 'react'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import { formatCurrency, formatPercent, formatPhone, formatRelativeTime } from '../../shared/formatters'
import { buildConversationDecision } from '../../modules/inbox/inbox-decisioning'
import type { ViewLayoutMode } from '../../../domain/inbox/view-layout'
import './pipeline-view.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

// ── Stage definitions ─────────────────────────────────────────────────────────

type StageTone = 'cyan' | 'blue' | 'gold' | 'orange' | 'green' | 'red' | 'neutral' | 'amber'

interface StageDefinition { id: string; label: string; tone: StageTone; matches: string[] }

const STAGE_GROUPS: StageDefinition[] = [
  { id: 'ownership_check',      label: 'Ownership Check',      tone: 'cyan',    matches: ['ownership'] },
  { id: 'interest_probe',       label: 'Interest Probe',       tone: 'blue',    matches: ['interest'] },
  { id: 'active_communication', label: 'Active Communication', tone: 'blue',    matches: ['active', 'seller_response', 'communication'] },
  { id: 'price_discovery',      label: 'Price Discovery',      tone: 'gold',    matches: ['price'] },
  { id: 'condition_details',    label: 'Condition Details',    tone: 'orange',  matches: ['condition'] },
  { id: 'underwriting',         label: 'Underwriting',         tone: 'orange',  matches: ['underwrit'] },
  { id: 'offer_sent',           label: 'Offer Sent',           tone: 'green',   matches: ['offer', 'negotiat', 'counter'] },
  { id: 'contract_sent',        label: 'Contract Sent',        tone: 'green',   matches: ['contract'] },
  { id: 'title_closing',        label: 'Title / Closing',      tone: 'green',   matches: ['title', 'closing'] },
  { id: 'dead_suppressed',      label: 'Dead / Suppressed',    tone: 'red',     matches: ['dead', 'suppressed', 'closed'] },
]

type GroupByMode = 'stage' | 'status' | 'market' | 'property_type' | 'queue_status'
const GROUP_BY_OPTIONS: Array<{ value: GroupByMode; label: string }> = [
  { value: 'stage', label: 'Stage' },
  { value: 'status', label: 'Status' },
  { value: 'queue_status', label: 'Queue Status' },
  { value: 'market', label: 'Market' },
  { value: 'property_type', label: 'Property Type' },
]

const STATUS_GROUPS: StageDefinition[] = [
  { id: 'new', label: 'New', tone: 'cyan', matches: ['new'] },
  { id: 'not_contacted', label: 'Not Contacted', tone: 'neutral', matches: ['not_contacted'] },
  { id: 'ownership_check_sent', label: 'Ownership Check Sent', tone: 'blue', matches: ['ownership_check_sent'] },
  { id: 'message_sent', label: 'Message Sent', tone: 'blue', matches: ['message_sent', 'sent_message'] },
  { id: 'awaiting_response', label: 'Awaiting Response', tone: 'blue', matches: ['waiting', 'awaiting_response'] },
  { id: 'seller_replied', label: 'Seller Replied', tone: 'cyan', matches: ['new_reply', 'seller_replied'] },
  { id: 'positive_intent', label: 'Positive Intent', tone: 'green', matches: ['positive', 'interested'] },
  { id: 'asking_price_provided', label: 'Asking Price Provided', tone: 'gold', matches: ['asking_price'] },
  { id: 'needs_follow_up', label: 'Needs Follow-Up', tone: 'amber', matches: ['follow_up'] },
  { id: 'negotiating', label: 'Negotiating', tone: 'green', matches: ['negotiat'] },
  { id: 'offer_sent', label: 'Offer Sent', tone: 'green', matches: ['offer_sent'] },
  { id: 'contract_sent', label: 'Contract Sent', tone: 'green', matches: ['contract_sent'] },
  { id: 'review_required', label: 'Review Required', tone: 'amber', matches: ['review'] },
  { id: 'auto_blocked', label: 'Auto Blocked', tone: 'red', matches: ['auto_blocked'] },
  { id: 'suppressed', label: 'Suppressed', tone: 'red', matches: ['suppressed'] },
  { id: 'wrong_number', label: 'Wrong Number', tone: 'red', matches: ['wrong_number'] },
  { id: 'failed', label: 'Failed', tone: 'red', matches: ['failed'] },
]

const QUEUE_GROUPS: StageDefinition[] = [
  { id: 'scheduled', label: 'Scheduled', tone: 'blue', matches: ['scheduled'] },
  { id: 'queued', label: 'Queued', tone: 'blue', matches: ['queued'] },
  { id: 'ready', label: 'Ready', tone: 'cyan', matches: ['ready'] },
  { id: 'sending', label: 'Sending', tone: 'blue', matches: ['sending'] },
  { id: 'sent', label: 'Sent', tone: 'blue', matches: ['sent'] },
  { id: 'delivered', label: 'Delivered', tone: 'green', matches: ['delivered'] },
  { id: 'failed', label: 'Failed', tone: 'red', matches: ['failed'] },
  { id: 'blocked', label: 'Blocked', tone: 'red', matches: ['blocked'] },
  { id: 'cancelled', label: 'Cancelled', tone: 'neutral', matches: ['cancelled'] },
  { id: 'paused', label: 'Paused', tone: 'amber', matches: ['paused'] },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

const norm = (v: unknown) => String(v ?? '').trim()

const first = (...vals: unknown[]) => {
  for (const v of vals) { const s = norm(v); if (s) return s }
  return ''
}

const num = (v: unknown): number | null => {
  const n = Number(norm(v).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) && !Number.isNaN(n) ? n : null
}

const stageFmt = (v: string) =>
  v.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

const daysSince = (thread: InboxWorkflowThread): number => {
  const iso = thread.lastInboundAt || thread.lastOutboundAt || thread.lastMessageAt || thread.updatedAt
  if (!iso) return 0
  const d = (Date.now() - new Date(iso).getTime()) / 86400000
  return Number.isFinite(d) && d >= 0 ? d : 0
}

const ageLabel = (days: number) => {
  if (!days || days < 0) return 'Fresh'
  if (days < 1) return `${Math.round(days * 24)}h`
  return `${Math.round(days)}d`
}

const deriveStageId = (thread: InboxWorkflowThread): string => {
  // Use the canonical pipeline_stage from v_inbox_enriched if present (direct match to STAGE_GROUPS id)
  const canonical = norm((thread as any).pipeline_stage).toLowerCase()
  if (canonical && STAGE_GROUPS.some(s => s.id === canonical)) return canonical

  // Fall back to string-matching on conversationStage / inboxStage
  const raw = norm(thread.conversationStage || thread.inboxStage).toLowerCase()
  // Map inbox thread states that don't match STAGE_GROUPS.matches
  if (raw === 'waiting' || raw === 'sent_waiting') return 'active_communication'
  if (raw === 'needs_response') return 'active_communication'
  if (raw === 'needs_review') return 'ownership_check'
  for (const s of STAGE_GROUPS) {
    if (s.matches.some(m => raw.includes(m))) return s.id
  }
  return 'ownership_check'
}

const effectiveStageId = (thread: InboxWorkflowThread, overrides: Map<string, string>): string =>
  overrides.get(thread.id) ?? deriveStageId(thread)

const toneForIndex = (index: number): StageTone =>
  (['cyan', 'blue', 'gold', 'orange', 'green', 'red', 'neutral'] as StageTone[])[index % 7] ?? 'neutral'

const priorityWeight = (p: string) => {
  if (p === 'urgent') return 4
  if (p === 'high') return 3
  if (p === 'normal') return 2
  return 1
}

const priorityAccent = (p: string, hot: boolean): string => {
  if (hot) return 'amber'
  if (p === 'urgent') return 'red'
  if (p === 'high') return 'orange'
  return 'blue'
}

// ── Card model ────────────────────────────────────────────────────────────────

interface DealCard {
  thread: InboxWorkflowThread
  sellerName: string
  address: string
  market: string
  propertyType: string
  queueStatus: string
  zip: string
  county: string
  phone: string
  status: string
  priority: string
  automation: string
  lastIntent: string
  nextAction: string
  snippet: string
  value: number | null
  equityPct: number | null
  repairs: number | null
  lastContact: string | null
  unread: boolean
  hot: boolean
  suppressed: boolean
  followUpDue: boolean
  confidence: number
}

const buildCard = (thread: InboxWorkflowThread): DealCard => {
  const dec = buildConversationDecision(thread)
  const followUpIso = (thread as any).next_action_at ||
    (thread as any).next_follow_up_at ||
    dec.next_follow_up_at
  return {
    thread,
    sellerName: first(thread.ownerDisplayName, thread.ownerName, thread.sellerName,
      (thread as any).prospect_name) || 'Unknown Seller',
    address: first(thread.propertyAddressFull, thread.propertyAddress, thread.subject) || 'Property Unknown',
    market: first(thread.displayMarket, thread.market, thread.marketName) || 'Market Unknown',
    propertyType: first((thread as any).propertyType, (thread as any).property_type) || 'Unknown',
    queueStatus: first((thread as any).queueStatus, (thread as any).queue_status, thread.autoReplyStatus) || 'Unknown',
    zip: first((thread as any).property_address_zip,
      (thread as any).zip) || '—',
    county: first((thread as any).property_address_county_name,
      (thread as any).county) || '—',
    phone: first(thread.phoneNumber, thread.canonicalE164, thread.displayPhone) || '—',
    status: first((thread as any).seller_status, thread.inboxStatus, thread.status) || 'needs_review',
    priority: first(thread.priority) || 'normal',
    automation: first(thread.automationState, thread.autoReplyStatus) || dec.automation_status,
    lastIntent: first((thread as any).last_intent, dec.seller_intent) || 'unknown',
    nextAction: first((thread as any).next_action,
      thread.nextSystemAction, dec.next_action) || 'Review conversation',
    snippet: first(thread.lastMessageBody, thread.latestMessageBody, thread.preview) || 'No recent context.',
    value: num(thread.estimatedValue ?? (thread as any).estimated_value),
    equityPct: num(thread.equity_percent ?? (thread as any).equityPercent),
    repairs: num(thread.estimatedRepairCost ?? (thread as any).estimated_repair_cost),
    lastContact: thread.lastInboundAt || thread.lastOutboundAt || thread.lastMessageAt || thread.updatedAt || null,
    unread: dec.unread,
    hot: Boolean(thread.isHotLead || thread.sentiment === 'hot' ||
      (thread as any).is_hot_lead),
    suppressed: Boolean(thread.isSuppressed || thread.isOptOut ||
      (thread as any).is_suppressed),
    followUpDue: Boolean(followUpIso && new Date(String(followUpIso)).getTime() - Date.now() < 36 * 3600000),
    confidence: dec.confidence,
  }
}

// ── Stage model ───────────────────────────────────────────────────────────────

interface StageModel {
  def: StageDefinition
  cards: DealCard[]
  count: number
  hotCount: number
  dueCount: number
  unreadCount: number
  autoCount: number
  stuckCount: number
  avgAge: string
  health: number
}

const buildStageModel = (def: StageDefinition, cards: DealCard[]): StageModel => {
  const hotCount   = cards.filter(c => c.hot).length
  const dueCount   = cards.filter(c => c.followUpDue).length
  const unreadCount = cards.filter(c => c.unread).length
  const autoCount  = cards.filter(c => c.automation.toLowerCase().includes('auto') || c.automation.toLowerCase().includes('active')).length
  const stuckCount = cards.filter(c => daysSince(c.thread) >= 7).length
  const ages       = cards.map(c => daysSince(c.thread))
  const avgDays    = ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : 0
  const signal     = hotCount + dueCount + unreadCount + autoCount
  const health     = cards.length ? Math.min(100, Math.round((signal / Math.max(cards.length, 1)) * 45 + autoCount * 3)) : 0
  return { def, cards, count: cards.length, hotCount, dueCount, unreadCount, autoCount, stuckCount, avgAge: ageLabel(avgDays), health }
}

// ── Summary ───────────────────────────────────────────────────────────────────

interface PipelineSummary {
  active: number; hot: number; replies: number
  negotiating: number; contractSent: number; closing: number
  dead: number; followUpsDue: number; positiveIntent: string; avgAge: string
}

type SortMode = 'priority' | 'recent' | 'value' | 'stage_age'

// ── Props ─────────────────────────────────────────────────────────────────────

interface InboxPipelineViewProps {
  threads: InboxWorkflowThread[]
  selectedId: string | null
  selectedThread: InboxWorkflowThread | null
  layoutMode: ViewLayoutMode
  onSelect: (id: string) => void
  onActivateThread?: (thread: InboxWorkflowThread) => void
  onOpenCommandView: (threadId?: string | null) => void
  onThreadAction: (id: string, action: string) => void | Promise<void>
}

// ── Main component ────────────────────────────────────────────────────────────

export function InboxPipelineView({
  threads, selectedId, selectedThread, layoutMode,
  onSelect, onActivateThread, onOpenCommandView, onThreadAction,
}: InboxPipelineViewProps) {
  const [query,          setQuery]          = useState('')
  const [groupBy,        setGroupBy]        = useState<GroupByMode>('stage')
  const [sortMode,       setSortMode]       = useState<SortMode>('recent')
  const [hotOnly,        setHotOnly]        = useState(false)
  const [followUpOnly,   setFollowUpOnly]   = useState(false)
  const [automationOnly, setAutomationOnly] = useState(false)
  const [showSuppressed, setShowSuppressed] = useState(false)
  const [activeStageId,  setActiveStageId]  = useState<string>(STAGE_GROUPS[0].id)
  const [stageOverrides, setStageOverrides] = useState<Map<string, string>>(new Map())
  const [dragCardId,     setDragCardId]     = useState<string | null>(null)
  const [dragOverStage,  setDragOverStage]  = useState<string | null>(null)
  const [showDetail,     setShowDetail]     = useState(true)
  const [drawerOpen,     setDrawerOpen]     = useState(false)

  const allCards = useMemo(() => threads.map(buildCard), [threads])

  // DEV-only pipeline proof — remove before prod
  useEffect(() => {
    if (!import.meta.env.DEV || allCards.length === 0) return
    const stageDist: Record<string, number> = {}
    const statusDist: Record<string, number> = {}
    for (const c of allCards) {
      const stage = (c.thread as any).pipeline_stage || deriveStageId(c.thread)
      stageDist[stage] = (stageDist[stage] ?? 0) + 1
      statusDist[c.status] = (statusDist[c.status] ?? 0) + 1
    }
    const sample = allCards.slice(0, 10).map(c => ({
      sellerName: c.sellerName,
      snippet: c.snippet?.slice(0, 40),
      inbound_count: (c.thread as any).inbound_count ?? 0,
      pipeline_stage: (c.thread as any).pipeline_stage,
      seller_status: (c.thread as any).seller_status,
      seller_state: (c.thread as any).seller_state,
    }))
    console.group('[InboxPipelineView] DEV proof')
    console.log('Total cards rendered:', allCards.length)
    console.log('Stage distribution:', stageDist)
    console.log('Status distribution:', statusDist)
    console.table(sample)
    console.groupEnd()
  }, [allCards])

  const visibleCards = useMemo(() => {
    const q = query.trim().toLowerCase()
    return allCards
      .filter(c => {
        if (!showSuppressed && c.suppressed) return false
        if (hotOnly && !c.hot) return false
        if (followUpOnly && !c.followUpDue) return false
        if (automationOnly && !c.automation.toLowerCase().includes('auto') &&
            !c.automation.toLowerCase().includes('active')) return false
        if (!q) return true
        return [c.sellerName, c.address, c.market, c.lastIntent, c.nextAction, c.snippet]
          .some(s => s.toLowerCase().includes(q))
      })
      .sort((a, b) => {
        if (sortMode === 'value')     return (b.value ?? 0) - (a.value ?? 0)
        if (sortMode === 'recent')    return new Date(b.lastContact ?? 0).getTime() - new Date(a.lastContact ?? 0).getTime()
        if (sortMode === 'stage_age') return daysSince(b.thread) - daysSince(a.thread)
        return priorityWeight(b.priority) - priorityWeight(a.priority)
      })
  }, [allCards, query, showSuppressed, hotOnly, followUpOnly, automationOnly, sortMode])

  const groupDefinitions = useMemo<StageDefinition[]>(() => {
    if (groupBy === 'stage') return STAGE_GROUPS
    if (groupBy === 'status') return STATUS_GROUPS
    if (groupBy === 'queue_status') return QUEUE_GROUPS
    if (groupBy === 'market') {
      const counts = new Map<string, number>()
      visibleCards.forEach((card) => counts.set(card.market, (counts.get(card.market) ?? 0) + 1))
      return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([label], index) => ({ id: label, label, tone: toneForIndex(index), matches: [label] }))
    }
    const propertyOrder = ['Single Family', 'Multifamily', 'Apartment', 'Duplex/Triplex/Quadplex', 'Land', 'Commercial', 'Unknown']
    return propertyOrder.map((label, index) => ({ id: label, label, tone: toneForIndex(index), matches: [label] }))
  }, [groupBy, visibleCards])

  const groupKeyForCard = useCallback((card: DealCard): string => {
    if (groupBy === 'stage') return effectiveStageId(card.thread, stageOverrides)
    if (groupBy === 'status') {
      // seller_status from v_inbox_enriched uses snake_case ids that match STATUS_GROUPS directly
      const raw = `${card.status} ${(card.thread as any).seller_status ?? ''} ${(card.thread as any).status ?? ''}`.toLowerCase()
      return STATUS_GROUPS.find((group) => group.matches.some((match) => raw.includes(match)))?.id ?? 'new'
    }
    if (groupBy === 'queue_status') {
      const raw = card.queueStatus.toLowerCase()
      return QUEUE_GROUPS.find((group) => group.matches.some((match) => raw.includes(match)))?.id ?? 'scheduled'
    }
    if (groupBy === 'market') return card.market
    return card.propertyType
  }, [groupBy, stageOverrides])

  const stageModels = useMemo(() =>
    groupDefinitions.map(def => {
      const cards = visibleCards.filter(c => groupKeyForCard(c) === def.id)
      return buildStageModel(def, cards)
    }),
  [groupDefinitions, groupKeyForCard, visibleCards])

  const summary = useMemo<PipelineSummary>(() => {
    const active   = visibleCards.filter(c => !c.suppressed)
    const avgDays  = active.length ? active.reduce((s, c) => s + daysSince(c.thread), 0) / active.length : 0
    const posCount = visibleCards.filter(c => ['seller_interested', 'price_interest'].includes(c.lastIntent)).length
    return {
      active:        active.length,
      hot:           visibleCards.filter(c => c.hot).length,
      replies:       visibleCards.filter(c => c.unread || (c.thread as any).seller_state === 'new_reply').length,
      negotiating:   stageModels.find(s => s.def.id === 'offer_sent')?.count ?? 0,
      contractSent:  stageModels.find(s => s.def.id === 'contract_sent')?.count ?? 0,
      closing:       stageModels.find(s => s.def.id === 'title_closing')?.count ?? 0,
      dead:          stageModels.find(s => s.def.id === 'dead_suppressed')?.count ?? 0,
      followUpsDue:  visibleCards.filter(c => c.followUpDue).length,
      positiveIntent: active.length ? `${Math.round((posCount / active.length) * 100)}%` : '0%',
      avgAge:        ageLabel(avgDays),
    }
  }, [visibleCards, stageModels])

  const selectedCard = useMemo(() =>
    visibleCards.find(c => c.thread.id === selectedId) ??
    (selectedThread ? buildCard(selectedThread) : null),
  [visibleCards, selectedId, selectedThread])

  useEffect(() => {
    if (!selectedThread) return
    setActiveStageId(groupKeyForCard(buildCard(selectedThread)))
  }, [groupKeyForCard, selectedThread])

  useEffect(() => {
    if (stageModels.some((stage) => stage.def.id === activeStageId)) return
    setActiveStageId(stageModels[0]?.def.id ?? '')
  }, [activeStageId, stageModels])

  // Open drawer on selection at 50%
  useEffect(() => {
    if (selectedId && layoutMode === 'medium') setDrawerOpen(true)
  }, [selectedId, layoutMode])

  // ── DnD handlers ──────────────────────────────────────────────────────────

  const handleDragStart = (e: React.DragEvent, cardId: string) => {
    setDragCardId(cardId)
    e.dataTransfer.setData('text/plain', cardId)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e: React.DragEvent, stageId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverStage !== stageId) setDragOverStage(stageId)
  }

  const handleDrop = (e: React.DragEvent, stageId: string) => {
    e.preventDefault()
    const cardId = e.dataTransfer.getData('text/plain')
    if (cardId) {
      setStageOverrides(prev => { const m = new Map(prev); m.set(cardId, stageId); return m })
      // TODO: wire stage update → onThreadAction(cardId, `move_stage:${stageId}`) when backend handler is ready
    }
    setDragCardId(null)
    setDragOverStage(null)
  }

  const handleDragEnd = () => { setDragCardId(null); setDragOverStage(null) }

  const hasFilters = !!(query || hotOnly || followUpOnly || automationOnly || groupBy !== 'stage')
  const clearFilters = () => { setQuery(''); setHotOnly(false); setFollowUpOnly(false); setAutomationOnly(false); setGroupBy('stage') }

  const dnd = { handleDragStart, handleDragOver, handleDrop, handleDragEnd, dragCardId, dragOverStage }
  const acts = { onSelect, onActivateThread, onOpenCommandView, onThreadAction }

  // ── 25% — Pipeline Rail ────────────────────────────────────────────────────
  if (layoutMode === 'compact') {
    return (
      <div className="plv plv--rail">
        <RailKpi summary={summary} />
        <FilterBar
          query={query}
          sortMode={sortMode}
          groupBy={groupBy}
          hotOnly={hotOnly}
          followUpOnly={followUpOnly}
          automationOnly={automationOnly}
          showSuppressed={showSuppressed}
          hasFilters={hasFilters}
          layoutMode={layoutMode}
          onQueryChange={setQuery}
          onSortModeChange={setSortMode}
          onGroupByChange={setGroupBy}
          onHotOnly={setHotOnly}
          onFollowUpOnly={setFollowUpOnly}
          onAutomationOnly={setAutomationOnly}
          onShowSuppressed={setShowSuppressed}
          onClear={clearFilters}
        />
        <StageChips stages={stageModels} activeId={activeStageId} onSelect={setActiveStageId} size="sm" />
        <CardRail
          cards={stageModels.find(s => s.def.id === activeStageId)?.cards ?? []}
          stageLabel={stageModels.find(s => s.def.id === activeStageId)?.def.label ?? ''}
          selectedId={selectedId}
          {...acts}
        />
      </div>
    )
  }

  // ── 50% — Focused pipeline ─────────────────────────────────────────────────
  if (layoutMode === 'medium') {
    return (
      <div className="plv plv--focused">
        <KpiStrip summary={summary} compact />
        <FilterBar
          query={query} sortMode={sortMode} groupBy={groupBy} hotOnly={hotOnly}
          followUpOnly={followUpOnly} automationOnly={automationOnly}
          showSuppressed={showSuppressed} hasFilters={hasFilters} layoutMode={layoutMode}
          onQueryChange={setQuery} onSortModeChange={setSortMode} onGroupByChange={setGroupBy}
          onHotOnly={setHotOnly} onFollowUpOnly={setFollowUpOnly}
          onAutomationOnly={setAutomationOnly} onShowSuppressed={setShowSuppressed}
          onClear={clearFilters}
        />
        <StageChips stages={stageModels} activeId={activeStageId} onSelect={setActiveStageId} size="md" />
        <FocusedList
          stage={stageModels.find(s => s.def.id === activeStageId) ?? stageModels[0]}
          selectedId={selectedId}
          {...acts}
        />
        {drawerOpen && selectedCard && (
          <DealDrawer card={selectedCard} onClose={() => setDrawerOpen(false)} {...acts} />
        )}
      </div>
    )
  }

  // ── 75% + 100% — Kanban board ──────────────────────────────────────────────
  const isOps  = layoutMode === 'expanded'
  const isFull = layoutMode === 'full'

  return (
    <div className={cls('plv', isOps ? 'plv--ops' : 'plv--full')}>
      <KpiStrip summary={summary} compact={isOps} />
      <div className="plv-topbar">
        <FilterBar
          query={query} sortMode={sortMode} groupBy={groupBy} hotOnly={hotOnly}
          followUpOnly={followUpOnly} automationOnly={automationOnly}
          showSuppressed={showSuppressed} hasFilters={hasFilters} layoutMode={layoutMode}
          onQueryChange={setQuery} onSortModeChange={setSortMode} onGroupByChange={setGroupBy}
          onHotOnly={setHotOnly} onFollowUpOnly={setFollowUpOnly}
          onAutomationOnly={setAutomationOnly} onShowSuppressed={setShowSuppressed}
          onClear={clearFilters}
        />
        {isOps && (
          <button
            type="button"
            className={cls('plv-detail-toggle', showDetail && 'is-active')}
            onClick={() => setShowDetail(d => !d)}
            title="Toggle deal detail panel"
          >
            {showDetail ? '⊠' : '⊡'} Detail
          </button>
        )}
      </div>

      <div className="plv-workspace">
        <div className="plv-board">
          {stageModels.map(stage => (
            <PipelineLane
              key={stage.def.id}
              stage={stage}
              selectedId={selectedId}
              compact={isOps}
              dnd={dnd}
              {...acts}
            />
          ))}
        </div>
        {(isFull || (isOps && showDetail)) && (
          <aside className="plv-detail-panel">
            {selectedCard ? (
              <SelectedDealPanel card={selectedCard} {...acts} />
            ) : (
              <div className="plv-detail-empty">
                <span className="plv-detail-empty__icon">◎</span>
                <strong>Select a deal</strong>
                <p>Snapshot, conversation intelligence, and next moves appear here.</p>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

// ── KPI components ────────────────────────────────────────────────────────────

function RailKpi({ summary }: { summary: PipelineSummary }) {
  return (
    <div className="plv-rail-kpi">
      {([
        ['Active', summary.active, 'blue'],
        ['Hot',    summary.hot,    'amber'],
        ['Due',    summary.followUpsDue, 'amber'],
        ['Replies',summary.replies,'cyan'],
      ] as [string, number, string][]).map(([label, value, tone]) => (
        <div key={label} className="plv-rail-kpi__cell">
          <strong className={`plv-rail-kpi__val is-${tone}`}>{value}</strong>
          <span className="plv-rail-kpi__label">{label}</span>
        </div>
      ))}
    </div>
  )
}

function KpiStrip({ summary, compact }: { summary: PipelineSummary; compact?: boolean }) {
  const items = compact
    ? [
        { label: 'Active',      value: String(summary.active),        tone: 'blue'    },
        { label: 'Hot',         value: String(summary.hot),           tone: 'amber'   },
        { label: 'Replies',     value: String(summary.replies),       tone: 'cyan'    },
        { label: 'Negotiating', value: String(summary.negotiating),   tone: 'green'   },
        { label: 'Contract',    value: String(summary.contractSent),  tone: 'green'   },
        { label: 'Follow-Ups',  value: String(summary.followUpsDue),  tone: 'amber'   },
      ]
    : [
        { label: 'Active Deals',   value: String(summary.active),        tone: 'blue'    },
        { label: 'Hot Deals',      value: String(summary.hot),           tone: 'amber'   },
        { label: 'New Replies',    value: String(summary.replies),       tone: 'cyan'    },
        { label: 'Negotiating',    value: String(summary.negotiating),   tone: 'green'   },
        { label: 'Contract Sent',  value: String(summary.contractSent),  tone: 'green'   },
        { label: 'Closing',        value: String(summary.closing),       tone: 'green'   },
        { label: 'Dead / Supp.',   value: String(summary.dead),          tone: 'red'     },
        { label: 'Follow-Ups Due', value: String(summary.followUpsDue),  tone: 'amber'   },
        { label: 'Intent+',        value: summary.positiveIntent,        tone: 'green'   },
        { label: 'Avg Stage Age',  value: summary.avgAge,                tone: 'neutral' },
      ]
  return (
    <div className={cls('plv-kpi', compact && 'plv-kpi--compact')}>
      {items.map(({ label, value, tone }) => (
        <div key={label} className="plv-kpi__item">
          <span className="plv-kpi__label">{label}</span>
          <strong className={cls('plv-kpi__value', `is-${tone}`)}>{value}</strong>
        </div>
      ))}
    </div>
  )
}

// ── Filter bar ────────────────────────────────────────────────────────────────

interface FilterBarProps {
  query: string; sortMode: SortMode; groupBy: GroupByMode; hotOnly: boolean; followUpOnly: boolean
  automationOnly: boolean; showSuppressed: boolean; hasFilters: boolean; layoutMode: ViewLayoutMode
  onQueryChange: (v: string) => void; onSortModeChange: (v: SortMode) => void; onGroupByChange: (v: GroupByMode) => void
  onHotOnly: (v: boolean) => void; onFollowUpOnly: (v: boolean) => void
  onAutomationOnly: (v: boolean) => void; onShowSuppressed: (v: boolean) => void; onClear: () => void
}

function FilterBar(p: FilterBarProps) {
  return (
    <div className="plv-filters">
      <div className="plv-filters__search">
        <span className="plv-filters__search-icon">⌕</span>
        <input
          type="search"
          className="plv-filters__input"
          value={p.query}
          onChange={e => p.onQueryChange(e.target.value)}
          placeholder={p.layoutMode === 'medium' ? 'Search pipeline…' : 'Seller, address, intent, action…'}
        />
        {p.hasFilters && (
          <button type="button" className="plv-filters__clear" onClick={p.onClear} title="Clear filters">✕</button>
        )}
      </div>
      <div className="plv-filters__controls">
        <select
          className="plv-filters__sort"
          value={p.groupBy}
          onChange={e => p.onGroupByChange(e.target.value as GroupByMode)}
        >
          {GROUP_BY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select
          className="plv-filters__sort"
          value={p.sortMode}
          onChange={e => p.onSortModeChange(e.target.value as SortMode)}
        >
          <option value="priority">Priority</option>
          <option value="recent">Recent Activity</option>
          <option value="value">Value</option>
          <option value="stage_age">Stage Age</option>
        </select>
        <button type="button" className={cls('plv-filter-chip', p.hotOnly && 'is-active')} onClick={() => p.onHotOnly(!p.hotOnly)}>
          🔥 Hot
        </button>
        <button type="button" className={cls('plv-filter-chip', p.followUpOnly && 'is-active')} onClick={() => p.onFollowUpOnly(!p.followUpOnly)}>
          Due
        </button>
        {p.layoutMode !== 'compact' && (
          <button type="button" className={cls('plv-filter-chip', p.automationOnly && 'is-active')} onClick={() => p.onAutomationOnly(!p.automationOnly)}>
            Auto
          </button>
        )}
        <button type="button" className={cls('plv-filter-chip', p.showSuppressed && 'is-active')} onClick={() => p.onShowSuppressed(!p.showSuppressed)}>
          {p.showSuppressed ? 'Hide Supp.' : 'Show Supp.'}
        </button>
      </div>
    </div>
  )
}

// ── Stage chips ───────────────────────────────────────────────────────────────

function StageChips({ stages, activeId, onSelect, size }: {
  stages: StageModel[]; activeId: string; onSelect: (id: string) => void; size: 'sm' | 'md'
}) {
  return (
    <div className={cls('plv-stage-chips', `plv-stage-chips--${size}`)}>
      {stages.map(s => (
        <button
          key={s.def.id}
          type="button"
          className={cls(
            'plv-stage-chip',
            `is-${s.def.tone}`,
            s.def.id === activeId && 'is-active',
            s.count === 0 && 'is-empty',
          )}
          onClick={() => onSelect(s.def.id)}
        >
          <span className="plv-stage-chip__label">{s.def.label}</span>
          {s.count > 0 && <span className="plv-stage-chip__count">{s.count}</span>}
          {s.hotCount > 0 && <span className="plv-stage-chip__hot">🔥</span>}
        </button>
      ))}
    </div>
  )
}

// ── Card rail (25%) ───────────────────────────────────────────────────────────

function CardRail({ cards, stageLabel, selectedId, onSelect, onOpenCommandView }: {
  cards: DealCard[]; stageLabel: string; selectedId: string | null
  onSelect: (id: string) => void; onOpenCommandView: (id?: string | null) => void
  onThreadAction: (id: string, action: string) => void | Promise<void>
}) {
  if (!cards.length) {
    return (
      <div className="plv-empty plv-empty--rail">
        <span className="plv-empty__icon">○</span>
        <strong>No deals in {stageLabel}</strong>
        <span>Deals will appear as they enter this stage.</span>
      </div>
    )
  }
  return (
    <div className="plv-card-rail">
      {cards.map(card => (
        <CompactCard
          key={card.thread.id}
          card={card}
          selected={card.thread.id === selectedId}
          onSelect={onSelect}
          onOpenCommandView={onOpenCommandView}
        />
      ))}
    </div>
  )
}

// ── Focused card list (50%) ───────────────────────────────────────────────────

function FocusedList({ stage, selectedId, onSelect, onOpenCommandView, onThreadAction }: {
  stage: StageModel; selectedId: string | null
  onSelect: (id: string) => void; onOpenCommandView: (id?: string | null) => void
  onThreadAction: (id: string, action: string) => void | Promise<void>
}) {
  if (!stage.cards.length) {
    return (
      <div className="plv-empty plv-empty--focused">
        <span className="plv-empty__icon">○</span>
        <strong>No deals in {stage.def.label}</strong>
        <span>Deals enter this stage automatically based on conversation progress.</span>
      </div>
    )
  }
  return (
    <div className="plv-focused-list">
      {stage.cards.map(card => (
        <FocusedCard
          key={card.thread.id}
          card={card}
          selected={card.thread.id === selectedId}
          onSelect={onSelect}
          onOpenCommandView={onOpenCommandView}
          onThreadAction={onThreadAction}
        />
      ))}
    </div>
  )
}

// ── Kanban lane (75/100%) ─────────────────────────────────────────────────────

interface DndState {
  handleDragStart: (e: React.DragEvent, cardId: string) => void
  handleDragOver:  (e: React.DragEvent, stageId: string) => void
  handleDrop:      (e: React.DragEvent, stageId: string) => void
  handleDragEnd:   () => void
  dragCardId:      string | null
  dragOverStage:   string | null
}

function PipelineLane({ stage, selectedId, compact, dnd, onSelect, onOpenCommandView, onThreadAction }: {
  stage: StageModel; selectedId: string | null; compact: boolean; dnd: DndState
  onSelect: (id: string) => void; onOpenCommandView: (id?: string | null) => void
  onThreadAction: (id: string, action: string) => void | Promise<void>
}) {
  const isOver = dnd.dragOverStage === stage.def.id
  return (
    <div className={cls('plv-lane', `is-${stage.def.tone}`, compact && 'plv-lane--compact', isOver && 'is-drag-over')}>
      <LaneHeader stage={stage} compact={compact} />
      <div
        className="plv-lane__body"
        onDragOver={e => dnd.handleDragOver(e, stage.def.id)}
        onDrop={e => dnd.handleDrop(e, stage.def.id)}
        onDragLeave={e => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) dnd.handleDragEnd()
        }}
      >
        {stage.cards.length > 0 ? (
          stage.cards.map(card => (
            <KanbanCard
              key={card.thread.id}
              card={card}
              selected={card.thread.id === selectedId}
              isDragging={dnd.dragCardId === card.thread.id}
              compact={compact}
              onDragStart={dnd.handleDragStart}
              onDragEnd={dnd.handleDragEnd}
              onSelect={onSelect}
              onOpenCommandView={onOpenCommandView}
              onThreadAction={onThreadAction}
            />
          ))
        ) : (
          <EmptyLane label={stage.def.label} />
        )}
      </div>
    </div>
  )
}

function LaneHeader({ stage, compact }: { stage: StageModel; compact: boolean }) {
  const healthPct = stage.health
  const healthTone = healthPct > 60 ? 'green' : healthPct > 30 ? 'amber' : healthPct > 0 ? 'red' : 'muted'
  return (
    <header className="plv-lane__header">
      <div className="plv-lane__title-row">
        <span className="plv-lane__name">{stage.def.label}</span>
        <span className={cls('plv-lane__count', stage.count > 0 && `is-${stage.def.tone}`)}>{stage.count}</span>
      </div>
      {stage.count > 0 && (
        <div className="plv-lane__health-track">
          <div className={cls('plv-lane__health-fill', `is-${healthTone}`)} style={{ width: `${healthPct}%` }} />
        </div>
      )}
      {!compact && stage.count > 0 && (
        <div className="plv-lane__stats">
          {stage.hotCount > 0    && <span className="plv-lane__stat is-amber">🔥{stage.hotCount}</span>}
          {stage.dueCount > 0    && <span className="plv-lane__stat is-amber">⏰{stage.dueCount}</span>}
          {stage.stuckCount > 0  && <span className="plv-lane__stat is-red">⚑{stage.stuckCount}</span>}
          {stage.autoCount > 0   && <span className="plv-lane__stat is-green">⚡{stage.autoCount}</span>}
          <span className="plv-lane__stat is-muted">{stage.avgAge}</span>
        </div>
      )}
    </header>
  )
}

function EmptyLane({ label }: { label: string }) {
  return (
    <div className="plv-empty-lane">
      <span className="plv-empty-lane__icon">·</span>
      <span>No deals in {label}</span>
    </div>
  )
}

// ── Card components ───────────────────────────────────────────────────────────

function CompactCard({ card, selected, onSelect, onOpenCommandView }: {
  card: DealCard; selected: boolean
  onSelect: (id: string) => void; onOpenCommandView: (id?: string | null) => void
}) {
  const accent = priorityAccent(card.priority, card.hot)
  return (
    <article
      className={cls('plv-card plv-card--compact', `is-accent-${accent}`, selected && 'is-selected')}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(card.thread.id)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(card.thread.id) } }}
    >
      <div className="plv-card__accent" />
      <div className="plv-card__body">
        <div className="plv-card__seller">{card.sellerName}</div>
        <div className="plv-card__address">{card.address}</div>
        <div className="plv-card__chips-row">
          {card.hot      && <span className="plv-chip is-hot">Hot</span>}
          {card.unread   && <span className="plv-chip is-unread">New</span>}
          {card.followUpDue && <span className="plv-chip is-due">Due</span>}
        </div>
        <div className="plv-card__snippet">{card.snippet}</div>
        <div className="plv-card__footer">
          <span className="plv-card__age">{card.lastContact ? formatRelativeTime(card.lastContact) : '—'}</span>
          <button
            type="button"
            className="plv-card__open-btn"
            onClick={e => { e.stopPropagation(); onOpenCommandView(card.thread.id) }}
          >
            ↗
          </button>
        </div>
      </div>
    </article>
  )
}

function FocusedCard({ card, selected, onSelect, onOpenCommandView, onThreadAction }: {
  card: DealCard; selected: boolean
  onSelect: (id: string) => void; onOpenCommandView: (id?: string | null) => void
  onThreadAction: (id: string, action: string) => void | Promise<void>
}) {
  const accent = priorityAccent(card.priority, card.hot)
  return (
    <article
      className={cls('plv-card plv-card--focused', `is-accent-${accent}`, selected && 'is-selected')}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(card.thread.id)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(card.thread.id) } }}
    >
      <div className="plv-card__accent" />
      <div className="plv-card__body">
        <div className="plv-card__header-row">
          <div>
            <div className="plv-card__seller">{card.sellerName}</div>
            <div className="plv-card__address">{card.address}</div>
          </div>
          <div className="plv-card__market">{card.market}</div>
        </div>
        <div className="plv-card__chips-row">
          {card.hot         && <span className="plv-chip is-hot">Hot</span>}
          {card.unread      && <span className="plv-chip is-unread">New Reply</span>}
          {card.followUpDue && <span className="plv-chip is-due">Due</span>}
          {(card.automation.toLowerCase().includes('auto') || card.automation.toLowerCase().includes('active')) &&
            <span className="plv-chip is-auto">Auto</span>}
          {card.suppressed  && <span className="plv-chip is-suppressed">Suppressed</span>}
        </div>
        <div className="plv-card__meta-row">
          <span className="plv-card__meta-label">Intent</span>
          <span className="plv-card__meta-val">{stageFmt(card.lastIntent)}</span>
          <span className="plv-card__meta-label">Next</span>
          <span className="plv-card__meta-val">{card.nextAction}</span>
        </div>
        <div className="plv-card__snippet">{card.snippet}</div>
        <div className="plv-card__footer">
          <span className="plv-card__age">{card.lastContact ? formatRelativeTime(card.lastContact) : '—'}</span>
          {card.value !== null && (
            <span className="plv-metric is-green">{formatCurrency(card.value)}</span>
          )}
          {card.equityPct !== null && (
            <span className="plv-metric is-blue">{formatPercent(card.equityPct)} eq</span>
          )}
        </div>
        <div className="plv-card__hover-actions">
          <button type="button" className="plv-card__action-btn" onClick={e => { e.stopPropagation(); onOpenCommandView(card.thread.id) }}>
            Command View
          </button>
          <button type="button" className="plv-card__action-btn" onClick={e => { e.stopPropagation(); onThreadAction(card.thread.id, 'pause_automation') }}>
            Pause Auto
          </button>
        </div>
      </div>
    </article>
  )
}

function KanbanCard({ card, selected, isDragging, compact, onDragStart, onDragEnd, onSelect, onOpenCommandView, onThreadAction }: {
  card: DealCard; selected: boolean; isDragging: boolean; compact: boolean
  onDragStart: (e: React.DragEvent, id: string) => void; onDragEnd: () => void
  onSelect: (id: string) => void; onOpenCommandView: (id?: string | null) => void
  onThreadAction: (id: string, action: string) => void | Promise<void>
}) {
  const accent = priorityAccent(card.priority, card.hot)
  return (
    <article
      className={cls(
        'plv-card', compact ? 'plv-card--kanban-sm' : 'plv-card--kanban',
        `is-accent-${accent}`, selected && 'is-selected', isDragging && 'is-dragging',
      )}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={e => onDragStart(e, card.thread.id)}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(card.thread.id)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(card.thread.id) } }}
    >
      <div className="plv-card__accent" />
      <div className="plv-card__body">
        <div className="plv-card__seller">{card.sellerName}</div>
        {!compact && <div className="plv-card__address">{card.address}</div>}
        <div className="plv-card__chips-row">
          {card.hot         && <span className="plv-chip is-hot">Hot</span>}
          {card.unread      && <span className="plv-chip is-unread">New</span>}
          {card.followUpDue && <span className="plv-chip is-due">Due</span>}
          {(card.automation.toLowerCase().includes('auto') || card.automation.toLowerCase().includes('active')) &&
            <span className="plv-chip is-auto">A</span>}
        </div>
        {!compact && <div className="plv-card__snippet">{card.snippet}</div>}
        <div className="plv-card__footer">
          <span className="plv-card__age">{card.lastContact ? formatRelativeTime(card.lastContact) : '—'}</span>
          {card.value !== null && <span className="plv-metric is-green">{formatCurrency(card.value)}</span>}
        </div>
        <div className="plv-card__hover-actions">
          <button type="button" className="plv-card__action-btn" onClick={e => { e.stopPropagation(); onOpenCommandView(card.thread.id) }}>
            ↗ Open
          </button>
          <button type="button" className="plv-card__action-btn is-quiet" onClick={e => { e.stopPropagation(); onThreadAction(card.thread.id, 'pause_automation') }}>
            Pause
          </button>
        </div>
      </div>
    </article>
  )
}

// ── Selected deal panel (75/100%) ─────────────────────────────────────────────

function SelectedDealPanel({ card, onOpenCommandView, onThreadAction }: {
  card: DealCard
  onOpenCommandView: (id?: string | null) => void
  onThreadAction: (id: string, action: string) => void | Promise<void>
}) {
  const accent = priorityAccent(card.priority, card.hot)
  return (
    <div className="plv-deal-detail">
      <div className={cls('plv-deal-detail__hero', `is-accent-${accent}`)}>
        <div className="plv-deal-detail__address">{card.address}</div>
        <div className="plv-deal-detail__seller">{card.sellerName} · {card.market}</div>
        <div className="plv-deal-detail__chips">
          {card.hot         && <span className="plv-chip is-hot">Hot</span>}
          {card.unread      && <span className="plv-chip is-unread">New Reply</span>}
          {card.followUpDue && <span className="plv-chip is-due">Follow-Up Due</span>}
          {card.suppressed  && <span className="plv-chip is-suppressed">Suppressed</span>}
        </div>
      </div>

      <div className="plv-deal-detail__grid">
        <DetailRow label="Status"       value={stageFmt(card.status)} />
        <DetailRow label="Stage"        value={stageFmt(card.priority)} />
        <DetailRow label="Priority"     value={stageFmt(card.priority)} />
        <DetailRow label="Last Contact" value={card.lastContact ? formatRelativeTime(card.lastContact) : 'Pending'} />
        <DetailRow label="Phone"        value={formatPhone(card.phone)} />
        <DetailRow label="County"       value={card.county} />
      </div>

      <div className="plv-deal-detail__section">
        <span className="plv-deal-detail__section-label">Conversation</span>
        <p className="plv-deal-detail__text">{card.snippet}</p>
      </div>

      <div className="plv-deal-detail__section">
        <span className="plv-deal-detail__section-label">Next Action</span>
        <p className="plv-deal-detail__text">{card.nextAction}</p>
      </div>

      <div className="plv-deal-detail__metrics">
        {card.value !== null && <MetricBlock label="Est. Value" value={formatCurrency(card.value)} tone="green" />}
        {card.equityPct !== null && <MetricBlock label="Equity" value={formatPercent(card.equityPct)} tone="blue" />}
        {card.repairs !== null && <MetricBlock label="Repairs" value={formatCurrency(card.repairs)} tone="amber" />}
      </div>

      <div className="plv-deal-detail__section">
        <span className="plv-deal-detail__section-label">Intelligence</span>
        <div className="plv-deal-detail__intel">
          <DetailRow label="Intent"      value={stageFmt(card.lastIntent)} />
          <DetailRow label="Automation"  value={card.automation || '—'} />
          <DetailRow label="Confidence"  value={`${Math.round(card.confidence * 100)}/100`} />
          <DetailRow label="Stage Age"   value={ageLabel(daysSince(card.thread))} />
        </div>
      </div>

      <div className="plv-deal-detail__actions">
        <button type="button" className="plv-action-btn is-primary" onClick={() => onOpenCommandView(card.thread.id)}>
          Open Command View
        </button>
        <button type="button" className="plv-action-btn" onClick={() => onOpenCommandView(card.thread.id)}>
          Open Conversation
        </button>
        <button type="button" className="plv-action-btn" onClick={() => onOpenCommandView(card.thread.id)}>
          Comp Intelligence
        </button>
        <div className="plv-deal-detail__actions-divider" />
        <button type="button" className="plv-action-btn is-warning" onClick={() => onThreadAction(card.thread.id, 'pause_automation')}>
          Pause Automation
        </button>
        <button type="button" className="plv-action-btn is-danger" onClick={() => onThreadAction(card.thread.id, 'suppress')}>
          Suppress
        </button>
        <button type="button" className="plv-action-btn is-danger" onClick={() => onThreadAction(card.thread.id, 'archive')}>
          DNC
        </button>
      </div>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="plv-detail-row">
      <span className="plv-detail-row__label">{label}</span>
      <span className="plv-detail-row__value">{value}</span>
    </div>
  )
}

function MetricBlock({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className={cls('plv-metric-block', `is-${tone}`)}>
      <span className="plv-metric-block__label">{label}</span>
      <strong className="plv-metric-block__value">{value}</strong>
    </div>
  )
}

// ── Deal drawer (50% slide-up) ─────────────────────────────────────────────────

function DealDrawer({ card, onClose, onOpenCommandView, onThreadAction }: {
  card: DealCard; onClose: () => void
  onOpenCommandView: (id?: string | null) => void
  onThreadAction: (id: string, action: string) => void | Promise<void>
}) {
  return (
    <div className="plv-drawer">
      <div className="plv-drawer__header">
        <div className="plv-drawer__title">
          <strong>{card.sellerName}</strong>
          <span>{card.address}</span>
        </div>
        <button type="button" className="plv-drawer__close" onClick={onClose} aria-label="Close detail">✕</button>
      </div>
      <div className="plv-drawer__body">
        <SelectedDealPanel card={card} onOpenCommandView={onOpenCommandView} onThreadAction={onThreadAction} />
      </div>
    </div>
  )
}

// ── Metric chip (inline) ──────────────────────────────────────────────────────

// plv-metric is used inline in cards — keeping it simple
// MetricBlock is used in detail panels

// (All types are used above — nothing unused)
