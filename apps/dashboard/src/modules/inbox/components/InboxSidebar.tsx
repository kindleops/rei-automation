import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import { Icon } from '../../../shared/icons'
import { formatInboxThreadTimestamp } from '../../../shared/formatters'
import {
  resolveThreadAddressLine,
  resolveThreadMarketBadge,
  resolveThreadPrimaryName,
  type InboxSavedFilterPreset,
  type InboxViewSelectValue,
} from '../inbox-ui-helpers'
import type { InboxSourceMode } from '../../../lib/data/inboxData'
import {
  buildConversationDecision,
  isHotLeadDecision,
  matchesInboxBucket,
  sortThreadsByDecision,
  type ConversationDecision,
  type InboxBucket,
} from '../inbox-decisioning'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export interface AdvancedFilterOptions {
  markets: string[]
  states: string[]
  zips: string[]
  propertyTypes: string[]
  ownerTypes: string[]
  occupancies: string[]
  languages: string[]
  personas: string[]
  assignedAgents: string[]
}

interface InboxSidebarProps {
  threads: InboxWorkflowThread[]
  selectedId: string | null
  activeViewFilter: InboxViewSelectValue
  onSelect: (id: string) => void
  onThreadAction?: (id: string, action: string) => void
  savedPreset: InboxSavedFilterPreset
  onApplySavedPreset: (preset: InboxSavedFilterPreset) => void
  viewCounts: Record<string, number | string | null | undefined>
  onOpenAdvancedFilters: () => void
  onClearFilters?: () => void
  onLoadMore: () => void
  canLoadMore: boolean
  recentlyUpdatedThreadIds?: Set<string>
  searchQuery?: string
  onSearchQueryChange?: (value: string) => void
  visibleThreadCount?: number
  loadingError?: string | null
  densityMode?: 'full' | 'compact'
  inboxMode?: 'rail25' | 'review50' | 'ops75' | 'full100'
  sourceMode?: InboxSourceMode
  onSourceModeChange?: (mode: InboxSourceMode) => void
}

type BucketConfig = {
  bucket: InboxBucket | 'all_messages'
  view: InboxViewSelectValue | string
  label: string
  icon: string
  description: string
  accentClass: string
  countKey: string
}

const BUCKETS: BucketConfig[] = [
  { bucket: 'priority', view: 'priority', label: 'PRIORITY', icon: '🔥', description: 'Priority operations.', accentClass: 'is-hot', countKey: 'priority' },
  { bucket: 'new_replies', view: 'new_replies', label: 'NEW REPLIES', icon: '📥', description: 'Unread inbound replies', accentClass: 'is-inbound', countKey: 'new_replies' },
  { bucket: 'needs_review', view: 'needs_review', label: 'NEEDS REVIEW', icon: '🧠', description: 'Ambiguous threads', accentClass: 'is-review', countKey: 'needs_review' },
  { bucket: 'follow_up_due', view: 'follow_up_due', label: 'FOLLOW-UP', icon: '⏰', description: 'Follow-ups due', accentClass: 'is-outbound', countKey: 'follow_up_due' },
  { bucket: 'waiting_on_seller', view: 'not_contacted', label: 'COLD', icon: '🥶', description: 'Leads needs warming', accentClass: 'is-cold', countKey: 'not_contacted' },
  { bucket: 'dnc_suppressed', view: 'suppressed', label: 'SUPPRESSED', icon: '🚫', description: 'Opt-out/DNC', accentClass: 'is-dnc', countKey: 'suppressed' },
  { bucket: 'all_messages', view: 'all_messages', label: 'ALL MESSAGES', icon: '📦', description: 'All historic', accentClass: 'is-neutral', countKey: 'all' },
]

const INBOX_CHIPS = BUCKETS

type LocalSavedFilter = {
  id: string
  name: string
  view: InboxViewSelectValue
  query: string
}
const LOCAL_SAVED_FILTERS_KEY = 'nx.inbox.local-saved-filters.v1'

const numberOrNull = (value: unknown): number | null => {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}
const formatCount = (value: number | null | undefined) => value === null || value === undefined ? '—' : `${value}`
const formatLoadingError = (value: unknown) => {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  if (typeof value === 'object') {
    const maybeMessage = (value as { message?: unknown }).message
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) return maybeMessage.trim()
    try { return JSON.stringify(value) } catch { return 'Unable to load inbox data' }
  }
  return String(value)
}

const readString = (thread: InboxWorkflowThread, ...keys: string[]) => {
  const row = thread as unknown as Record<string, unknown>
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

const matchesSearch = (thread: InboxWorkflowThread, query: string) => {
  const search = query.trim().toLowerCase()
  if (!search) return true
  const values = [
    resolveThreadPrimaryName(thread),
    resolveThreadAddressLine(thread),
    resolveThreadMarketBadge(thread),
    readString(thread, 'latest_message_body', 'latestMessageBody', 'lastMessageBody', 'preview'),
    readString(thread, 'best_phone', 'canonical_e164', 'phone'),
    readString(thread, 'propertyType', 'property_type'),
  ]
  return values.some((value) => value.toLowerCase().includes(search))
}

const getThreadVars = (thread: InboxWorkflowThread, decision: ConversationDecision) => {
  const name = resolveThreadPrimaryName(thread) || readString(thread, 'best_phone', 'canonical_e164', 'phone') || 'Unknown Owner'
  const address = resolveThreadAddressLine(thread) || readString(thread, 'property_address_full', 'propertyAddressFull') || 'Property Unknown'
  const market = resolveThreadMarketBadge(thread) || 'Unknown Market'
  const propertyType = readString(thread, 'propertyType', 'property_type') || 'Unknown Type'
  
  let rawPreview = readString(thread, 'latest_message_body', 'latestMessageBody', 'lastMessageBody', 'preview') || 'No recent message'
  let preview = rawPreview
  
  // Semantic Preview Rendering
  const uiIntent = String((decision as any).ui_intent || (thread as any).uiIntent || '').toLowerCase()
  if (uiIntent === 'not_interested' || uiIntent === 'no') {
    preview = `[Negative Reply] "${rawPreview}"`
  } else if (uiIntent === 'yes' || uiIntent === 'interested' || uiIntent === 'positive') {
    preview = `[Positive Reply] "${rawPreview}"`
  } else if (uiIntent === 'question') {
    preview = `[Seller Question] "${rawPreview}"`
  } else if (uiIntent === 'price_discussion' || uiIntent === 'offer_discussion') {
    preview = `[Price Discussion] "${rawPreview}"`
  } else if (uiIntent === 'wrong_number') {
    preview = `[Wrong Number] "${rawPreview}"`
  } else if (uiIntent === 'dnc' || uiIntent === 'opt_out') {
    preview = `[Opt-Out] "${rawPreview}"`
  } else if (uiIntent === 'uncertain' || uiIntent === 'maybe') {
    preview = `[Unclear Reply] "${rawPreview}"`
  } else if (['none', 'unknown', ''].includes(rawPreview.toLowerCase())) {
    preview = '[Unclear Seller Reply]'
  }

  const timestamp = formatInboxThreadTimestamp(thread.lastMessageAt || (thread as any).lastMessageIso || thread.updatedAt)
  const isHot = isHotLeadDecision(decision) || ['urgent', 'high'].includes(String(thread.priority || '').toLowerCase())
  const stage = (thread as any).conversationStage || decision.conversation_stage
  const stageNum = stage.includes('stage_1') ? 'S1' : stage.includes('stage_2') ? 'S2' : stage.includes('stage_3') ? 'S3' : stage.includes('stage_4') ? 'S4' : stage.includes('stage_5') ? 'S5' : ''
  
  const pTypeShort = propertyType === 'Single Family' ? 'SFR' : propertyType === 'Multi Family' ? 'Multifamily' : propertyType
  
  // Intel Tags
  const intelTags: string[] = []
  if ((thread as any).highEquity || (decision as any).high_equity) intelTags.push('High Equity')
  if ((thread as any).vacant || (decision as any).vacant) intelTags.push('Vacant')
  if ((thread as any).probate || (decision as any).probate) intelTags.push('Probate')
  if ((thread as any).absenteeOwner || (decision as any).absentee_owner) intelTags.push('Absentee')
  if ((thread as any).distressScore > 70) intelTags.push('Distressed')

  
  return { name, address, market, propertyType, pTypeShort, preview, timestamp, isHot, stage, stageNum, intelTags }
}

const HoverActions = ({ selectedForBulk, onToggleBulk, threadId }: any) => (
  <div className="nx-thread-card-rebuilt__hover-actions">
    <div className="nx-thread-card-rebuilt__checkbox-wrap" onClick={(e) => { e.stopPropagation(); onToggleBulk(threadId); }}>
      <input type="checkbox" checked={selectedForBulk} onChange={() => {}} aria-label="Select" />
    </div>
    <button type="button" className="nx-thread-card-rebuilt__action-btn"><Icon name="bell" /></button>
    <button type="button" className="nx-thread-card-rebuilt__action-btn"><Icon name="star" /></button>
    <button type="button" className="nx-thread-card-rebuilt__action-btn"><Icon name="pin" /></button>
  </div>
)

const ConversationRow = memo(({ thread, selected, decision, onSelect, selectedForBulk, onToggleBulk }: any) => {
  const { name, address, market, pTypeShort, preview, timestamp, isHot, stageNum, intelTags } = getThreadVars(thread, decision)
  return (
    <div role="button" tabIndex={0}
      className={cls('nx-thread-card-rebuilt', selected && 'is-selected', decision.unread && 'is-unread')}
      data-thread-id={thread.id} onClick={() => onSelect(thread.id)}
    >
      <div className="nx-thread-card-rebuilt__left">
        <HoverActions selectedForBulk={selectedForBulk} onToggleBulk={onToggleBulk} threadId={thread.id} />
      </div>
      <div className="nx-thread-card-rebuilt__main">
        <div className="nx-thread-card-rebuilt__header">
          <div className="nx-thread-card-rebuilt__identity">
            <span className="nx-thread-card-rebuilt__name">{name}</span>
            <span className="nx-thread-card-rebuilt__address">{address}</span>
          </div>
          <div className="nx-thread-card-rebuilt__right">
            <time className="nx-thread-card-rebuilt__time">{timestamp.dayLabel === 'Today' ? timestamp.timeLabel : timestamp.dayLabel}</time>
            {decision.unread && <span className="nx-thread-card-rebuilt__unread-dot" />}
            {isHot && <span className="nx-thread-card-rebuilt__hot-icon">🔥</span>}
          </div>
        </div>
        <div className="nx-thread-card-rebuilt__metadata">
          {stageNum && <><span>{stageNum}</span><span className="nx-thread-card-rebuilt__dot">•</span></>}
          <span>{market}</span><span className="nx-thread-card-rebuilt__dot">•</span>
          <span>{pTypeShort}</span>
          {isHot && <><span className="nx-thread-card-rebuilt__dot">•</span><span>⚡ Fast</span></>}
          {intelTags.length > 0 && <><span className="nx-thread-card-rebuilt__dot">•</span><span style={{color: '#a1a1aa'}}>{intelTags[0]}</span></>}
        </div>
        <div className="nx-thread-card-rebuilt__preview">{preview}</div>
      </div>
    </div>
  )
})
ConversationRow.displayName = 'ConversationRow'

const ConversationRowOps75 = memo(({ thread, selected, decision, onSelect, selectedForBulk, onToggleBulk }: any) => {
  const { name, address, market, pTypeShort, preview, timestamp, isHot, stageNum, intelTags } = getThreadVars(thread, decision)
  return (
    <div role="button" tabIndex={0}
      className={cls('nx-thread-table-row-ops75', selected && 'is-selected', decision.unread && 'is-unread')}
      data-thread-id={thread.id} onClick={() => onSelect(thread.id)}
    >
      <div className="nx-ops75-col nx-ops75-col--check" onClick={(e) => { e.stopPropagation(); onToggleBulk(thread.id); }}>
        <input type="checkbox" checked={selectedForBulk} onChange={() => {}} />
      </div>
      <div className="nx-ops75-col nx-ops75-col--seller">
        <span className="nx-ops75-name">{name}</span>
        <span className="nx-ops75-address">{address}</span>
      </div>
      <div className="nx-ops75-col nx-ops75-col--msg">
        <span className="nx-ops75-preview">{preview}</span>
        <time className="nx-ops75-time">{timestamp.timeLabel}</time>
      </div>
      <div className="nx-ops75-col nx-ops75-col--meta">
        {stageNum && <span className="nx-ops75-badge">{stageNum}</span>}
        <span className="nx-ops75-badge">{market}</span>
        <span className="nx-ops75-badge">{pTypeShort}</span>
        {isHot && <span className="nx-ops75-badge nx-ops75-badge--hot">🔥</span>}
        {intelTags.map(t => <span key={t} className="nx-ops75-badge">{t}</span>)}
      </div>
      <div className="nx-ops75-col nx-ops75-col--status">
        <span className={cls("nx-ops75-status", decision.unread && "is-unread")}>{decision.unread ? "Unread" : "Reviewed"}</span>
      </div>
      <div className="nx-ops75-col nx-ops75-col--actions">
        <button type="button" className="nx-ops75-action-btn"><Icon name="message" /></button>
      </div>
    </div>
  )
})
ConversationRowOps75.displayName = 'ConversationRowOps75'

const DealSnapshotPlaceholder = ({ thread, decision }: any) => {
  if (!thread) return <div className="nx-deal-snapshot-empty">Select a thread to view details</div>
  const { name, address, market, preview } = getThreadVars(thread, decision)
  return (
    <div className="nx-deal-snapshot">
      <div className="nx-deal-snapshot__header">
        <h2>{name}</h2>
        <p>{address}</p>
        <span className="nx-deal-snapshot__badge">{market}</span>
      </div>
      <div className="nx-deal-snapshot__body">
        <h4>Latest Activity</h4>
        <div className="nx-deal-snapshot__card">
          <p>{preview}</p>
        </div>
      </div>
    </div>
  )
}

export const InboxSidebar = ({
  threads, selectedId, activeViewFilter, onSelect, savedPreset, onApplySavedPreset,
  viewCounts, onOpenAdvancedFilters, onClearFilters, onLoadMore, canLoadMore,
  recentlyUpdatedThreadIds = new Set(), searchQuery = '', onSearchQueryChange,
  visibleThreadCount = 1000, loadingError, inboxMode = 'rail25'
}: InboxSidebarProps) => {
  const groupsRef = useRef<HTMLDivElement | null>(null)
  const loadingErrorMessage = formatLoadingError(loadingError)

  const activeBucketConfig = useMemo(() => BUCKETS.find((bucket) => bucket.view === activeViewFilter) ?? BUCKETS.find((bucket) => bucket.bucket === 'priority') ?? BUCKETS[0], [activeViewFilter])
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set())
  const [savedFilters, setSavedFilters] = useState<LocalSavedFilter[]>([])
  const [showManageLists, setShowManageLists] = useState(false)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LOCAL_SAVED_FILTERS_KEY)
      if (raw) setSavedFilters(JSON.parse(raw) as LocalSavedFilter[])
    } catch {}
  }, [])
  const persistSavedFilters = (next: LocalSavedFilter[]) => {
    setSavedFilters(next)
    try { window.localStorage.setItem(LOCAL_SAVED_FILTERS_KEY, JSON.stringify(next)) } catch {}
  }

  const searchableThreads = useMemo(() => threads.filter((thread) => !recentlyUpdatedThreadIds.has(`hidden:${thread.id}`) && matchesSearch(thread, searchQuery)), [threads, recentlyUpdatedThreadIds, searchQuery])
  const decisionMap = useMemo(() => {
    const map = new Map<string, ConversationDecision>()
    searchableThreads.forEach((thread) => map.set(thread.id, buildConversationDecision(thread)))
    return map
  }, [searchableThreads])

  const bucketedThreads = useMemo(() => {
    const grouped = Object.fromEntries(BUCKETS.map((b) => [b.bucket, [] as InboxWorkflowThread[]])) as Record<InboxBucket | 'all_messages', InboxWorkflowThread[]>
    searchableThreads.forEach((thread) => {
      const decision = decisionMap.get(thread.id)
      if (!decision) return
      const isSuppressed = decision.suppression_status === 'suppressed' || Boolean(thread.isSuppressed)
      const isDead = thread.isArchived || decision.conversation_stage === 'closed'
      
      const negativeIntents = ['not_interested', 'wrong_number', 'no', 'not_for_sale', 'dnc', 'opt_out', 'stop', 'remove', 'dead_lead']
      const threadUiIntent = String((decision as any).ui_intent || (thread as any).uiIntent || '').toLowerCase()
      const isNegative = negativeIntents.includes(threadUiIntent)

      grouped.all_messages.push(thread)
      if (!isSuppressed && !isDead && !isNegative) {
        const isPriority = matchesInboxBucket(thread, 'new_replies', decision) || 
                           matchesInboxBucket(thread, 'needs_review', decision) || 
                           isHotLeadDecision(decision) || 
                           matchesInboxBucket(thread, 'follow_up_due', decision) ||
                           ['warm_reply', 'question', 'price_discussion', 'offer_discussion', 'uncertain'].includes(threadUiIntent)
        if (isPriority) grouped.priority.push(thread)
      }
      BUCKETS.filter(b => b.bucket !== 'priority' && b.bucket !== 'all_messages').forEach((b) => {
        if (matchesInboxBucket(thread, b.bucket as InboxBucket, decision)) grouped[b.bucket].push(thread)
      })
    })
    Object.keys(grouped).forEach((bucket) => {
      grouped[bucket as InboxBucket | 'all_messages'] = sortThreadsByDecision(grouped[bucket as InboxBucket | 'all_messages'], decisionMap).slice(0, visibleThreadCount)
    })
    return grouped
  }, [decisionMap, searchableThreads, visibleThreadCount])

  const activeGroupThreads = bucketedThreads[activeBucketConfig.bucket] || []
  const handleToggleBulk = (id: string) => {
    setBulkSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleBulkAction = (action: string) => {
    if (bulkSelectedIds.size === 0) return
    console.warn('BACKEND_ENDPOINT_NOT_READY', { action, selected: Array.from(bulkSelectedIds) })
  }

  useEffect(() => {
    if (!selectedId) return
    const root = groupsRef.current
    if (!root) return
    const selectedNode = root.querySelector<HTMLElement>(`[data-thread-id="${selectedId}"]`)
    selectedNode?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId, activeBucketConfig, visibleThreadCount])

  const renderTopActions = () => (
    <div className={cls('nx-sidebar-rebuilt__top-glow', `is-${activeBucketConfig.accentClass.replace('is-', '')}`)}>
      <div className="nx-sidebar-rebuilt__search-top">
        <div className="nx-sidebar-rebuilt__search-input-wrap">
          <Icon name="search" className="nx-sidebar-rebuilt__search-icon" />
          <input value={searchQuery} onChange={(e) => onSearchQueryChange?.(e.target.value)} placeholder="Search operator inbox..." aria-label="Search inbox threads" />
          {searchQuery && <button type="button" className="nx-sidebar-rebuilt__search-clear" onClick={() => onSearchQueryChange?.('')}><Icon name="close" /></button>}
        </div>
        <div className="nx-sidebar-rebuilt__top-actions">
          <button type="button" className="nx-sidebar__icon-button" title="Advanced filters" onClick={onOpenAdvancedFilters}><Icon name="filter" /></button>
          <button type="button" className="nx-sidebar__icon-button" title="Clear filters" onClick={() => onClearFilters?.()}><Icon name="close" /></button>
        </div>
      </div>
      <div className="nx-sidebar-rebuilt__chips-wrap" role="tablist">
        {INBOX_CHIPS.map((item) => {
          const countValue = numberOrNull(viewCounts[item.countKey]) ?? bucketedThreads[item.bucket]?.length ?? 0
          const isActive = activeBucketConfig.view === item.view
          return (
            <button key={item.view} type="button" className={cls('nx-inbox-chip-v2', isActive && 'is-active', item.accentClass)} onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onApplySavedPreset(viewToPreset(item.view))
            }}>
              <span className="nx-inbox-chip-v2__icon">{item.icon}</span>
              <span className="nx-inbox-chip-v2__label">{item.label}</span>
              <span className="nx-inbox-chip-v2__count">{formatCount(countValue)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )

  const renderSecondaryControls = () => (
    <>
      <div className="nx-sidebar-rebuilt__secondary-controls">
        <button type="button" onClick={() => {
          const name = typeof window !== 'undefined' ? window.prompt('Save current filter as:') : null
          if (!name) return
          const next: LocalSavedFilter[] = [{ id: `${Date.now()}`, name, view: activeViewFilter, query: searchQuery }, ...savedFilters].slice(0, 20)
          persistSavedFilters(next)
        }}>+ Save Current Filter</button>
        <button type="button" onClick={() => setShowManageLists((v) => !v)}>Manage Lists</button>
      </div>
      {showManageLists && (
        <div className="nx-sidebar-rebuilt__saved-list-panel">
          {savedFilters.length === 0 ? <div className="nx-sidebar-rebuilt__empty">Saved filters not ready.</div> : savedFilters.map((item) => (
            <div key={item.id} className="nx-sidebar-rebuilt__saved-list-row">
              <button type="button" onClick={(e) => {
                e.preventDefault(); e.stopPropagation(); 
                onSearchQueryChange?.(item.query); 
                onApplySavedPreset(viewToPreset(item.view)) 
              }}>{item.name}</button>
              <button type="button" onClick={() => persistSavedFilters(savedFilters.filter((f) => f.id !== item.id))}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </>
  )

  const renderMultiSelectBar = () => (
    bulkSelectedIds.size > 0 && (
      <div className="nx-inbox-rebuilt-floating-bar">
        <div className="nx-inbox-rebuilt-floating-bar__count"><strong>{bulkSelectedIds.size}</strong> selected</div>
        <div className="nx-inbox-rebuilt-floating-bar__actions">
          {['Mark Reviewed', 'Change Status', 'Schedule', 'Archive', 'Flag Hot', 'Suppress'].map((action) => (
            <button key={action} type="button" onClick={() => handleBulkAction(action)} title="BACKEND_ENDPOINT_NOT_READY">{action}</button>
          ))}
        </div>
      </div>
    )
  )

  const renderListContent = (RowComp: any) => (
    <div className="nx-sidebar-rebuilt__threads">
      {activeGroupThreads.length > 0 ? activeGroupThreads.map((thread) => {
        const decision = decisionMap.get(thread.id)
        if (!decision) return null
        return <RowComp key={thread.threadKey || thread.id} thread={thread} selected={selectedId === thread.id} decision={decision} onSelect={onSelect} selectedForBulk={bulkSelectedIds.has(thread.id)} onToggleBulk={handleToggleBulk} />
      }) : <div className="nx-sidebar-rebuilt__empty">No conversations match this filter.</div>}
      {canLoadMore && <div className="nx-sidebar-rebuilt__load-more"><button type="button" className="nx-load-more-btn" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onLoadMore(); }}>Loading more...</button></div>}
    </div>
  )

  if (inboxMode === 'review50') {
    return (
      <aside className={cls('nx-sidebar-rebuilt', `nx-sidebar--mode-${inboxMode}`, `nx-sidebar--active-${activeBucketConfig.accentClass.replace('is-', '')}`, savedPreset && 'has-preset')}>
        <div className="nx-review50-layout">
          <div className="nx-review50-left" ref={groupsRef}>
            {renderTopActions()}
            {renderSecondaryControls()}
            {loadingErrorMessage && <div className="nx-sidebar-rebuilt__error"><Icon name="alert" /><span>{loadingErrorMessage}</span></div>}
            {renderMultiSelectBar()}
            <div className="nx-sidebar-rebuilt__list-container">
              {renderListContent(ConversationRow)}
            </div>
          </div>
          <div className="nx-review50-right">
            <DealSnapshotPlaceholder thread={threads.find(t => t.id === selectedId)} decision={selectedId ? decisionMap.get(selectedId) : null} />
          </div>
        </div>
      </aside>
    )
  }

  if (inboxMode === 'full100') {
    return (
      <aside className={cls('nx-sidebar-rebuilt', `nx-sidebar--mode-${inboxMode}`, `nx-sidebar--active-${activeBucketConfig.accentClass.replace('is-', '')}`, savedPreset && 'has-preset')}>
        <div className="nx-full100-layout">
          <div className="nx-full100-left">
            {renderTopActions()}
            {renderSecondaryControls()}
          </div>
          <div className="nx-full100-center" ref={groupsRef}>
            {loadingErrorMessage && <div className="nx-sidebar-rebuilt__error"><Icon name="alert" /><span>{loadingErrorMessage}</span></div>}
            {renderMultiSelectBar()}
            <div className="nx-ops75-table-header">
              <div className="nx-ops75-col nx-ops75-col--check"></div>
              <div className="nx-ops75-col nx-ops75-col--seller">Seller & Address</div>
              <div className="nx-ops75-col nx-ops75-col--msg">Latest Message</div>
              <div className="nx-ops75-col nx-ops75-col--meta">Intel</div>
              <div className="nx-ops75-col nx-ops75-col--status">Status</div>
              <div className="nx-ops75-col nx-ops75-col--actions"></div>
            </div>
            <div className="nx-sidebar-rebuilt__list-container">
              {renderListContent(ConversationRowOps75)}
            </div>
          </div>
          <div className="nx-full100-right">
            <DealSnapshotPlaceholder thread={threads.find(t => t.id === selectedId)} decision={selectedId ? decisionMap.get(selectedId) : null} />
          </div>
        </div>
      </aside>
    )
  }

  const RowComponent = inboxMode === 'ops75' ? ConversationRowOps75 : ConversationRow

  return (
    <aside className={cls('nx-sidebar-rebuilt', `nx-sidebar--mode-${inboxMode}`, `nx-sidebar--active-${activeBucketConfig.accentClass.replace('is-', '')}`, savedPreset && 'has-preset')}>
      {renderTopActions()}
      {loadingErrorMessage && <div className="nx-sidebar-rebuilt__error"><Icon name="alert" /><span>{loadingErrorMessage}</span></div>}
      <div className="nx-sidebar-rebuilt__list-container" ref={groupsRef}>
        {renderSecondaryControls()}
        {renderMultiSelectBar()}
        {inboxMode === 'ops75' && (
          <div className="nx-ops75-table-header">
            <div className="nx-ops75-col nx-ops75-col--check"></div>
            <div className="nx-ops75-col nx-ops75-col--seller">Seller & Address</div>
            <div className="nx-ops75-col nx-ops75-col--msg">Latest Message</div>
            <div className="nx-ops75-col nx-ops75-col--meta">Intel</div>
            <div className="nx-ops75-col nx-ops75-col--status">Status</div>
            <div className="nx-ops75-col nx-ops75-col--actions"></div>
          </div>
        )}
        {renderListContent(RowComponent)}
      </div>
    </aside>
  )
}

const viewToPreset = (view: InboxViewSelectValue | string): InboxSavedFilterPreset => {
  if (view === 'new_replies') return 'new_inbounds'
  if (view === 'priority') return 'my_priority'
  if (view === 'negotiating') return 'offer_needed'
  if (view === 'follow_up_due') return 'offer_needed'
  if (view === 'waiting_on_seller') return 'outbound_only'
  if (view === 'automated') return 'auto_replied'
  if (view === 'needs_review') return 'review_required'
  if (view === 'not_contacted' || view === 'cold_no_response') return 'missing_context'
  if (view === 'suppressed' || view === 'dnc_opt_out') return 'suppressed'
  return 'all_messages'
}
