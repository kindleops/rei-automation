import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import { Icon } from '../../../shared/icons'
import { formatCurrency, formatInboxThreadTimestamp, formatPercent, formatPhone } from '../../../shared/formatters'
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
  sortThreadsByDecision,
  type ConversationDecision,
} from '../../../domain/inbox/inbox-decisioning'
import { classifyInboxBucket, type CanonicalBucket } from '../../../domain/inbox/classifyInboxBucket'

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
  onRetryLoad?: () => void
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
  loading?: boolean
  realtimeStatus?: 'connected' | 'connecting' | 'disconnected' | 'error' | 'disabled'
  refreshMode?: 'realtime' | 'polling' | 'disabled'
}

type BucketConfig = {
  bucket: CanonicalBucket
  view: InboxViewSelectValue
  label: string
  icon: string
  description: string
  accentClass: string
  countKey: string
}

const BUCKETS: BucketConfig[] = [
  { bucket: 'priority', view: 'priority', label: 'Priority', icon: '🔥', description: 'High-intent sellers, active negotiation', accentClass: 'is-hot', countKey: 'priority' },
  { bucket: 'new_replies', view: 'new_replies', label: 'New Replies', icon: '📥', description: 'Unread inbound replies', accentClass: 'is-inbound', countKey: 'new_replies' },
  { bucket: 'needs_review', view: 'needs_review', label: 'Needs Review', icon: '🧠', description: 'Low AI confidence or legal/hostile flags', accentClass: 'is-review', countKey: 'needs_review' },
  { bucket: 'waiting', view: 'waiting', label: 'Waiting', icon: '⏳', description: 'Outbound sent, awaiting seller response', accentClass: 'is-wait', countKey: 'waiting' },
  { bucket: 'follow_up', view: 'follow_up', label: 'Follow Up', icon: '⏰', description: 'Follow-up due or waiting on seller', accentClass: 'is-outbound', countKey: 'follow_up' },
  { bucket: 'cold', view: 'cold', label: 'Cold', icon: '🥶', description: 'Stale leads with no inbound reply', accentClass: 'is-cold', countKey: 'cold' },
  { bucket: 'dead', view: 'dead', label: 'Dead', icon: '💀', description: 'Not interested / wrong number', accentClass: 'is-dead', countKey: 'dead' },
  { bucket: 'suppressed', view: 'suppressed', label: 'Suppressed', icon: '🚫', description: 'Opt-out / DNC', accentClass: 'is-dnc', countKey: 'suppressed' },
  { bucket: 'all_messages', view: 'all_conversations', label: 'All Messages', icon: '📦', description: 'Every thread', accentClass: 'is-neutral', countKey: 'all_messages' },
]

const VISIBLE_INBOX_CHIPS: BucketConfig[] = [
  BUCKETS[0],
  BUCKETS[1],
  BUCKETS[2],
  BUCKETS[3],
  BUCKETS[8],
]

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

const readNumber = (thread: InboxWorkflowThread, ...keys: string[]) => {
  const row = thread as unknown as Record<string, unknown>
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const normalized = Number(value.replace(/[,$%\s]/g, ''))
      if (Number.isFinite(normalized)) return normalized
    }
  }
  return null
}

const readBoolean = (thread: InboxWorkflowThread, ...keys: string[]) => {
  const row = thread as unknown as Record<string, unknown>
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (['true', '1', 'yes', 'y'].includes(normalized)) return true
      if (['false', '0', 'no', 'n'].includes(normalized)) return false
    }
  }
  return false
}

const readStringList = (thread: InboxWorkflowThread, ...keys: string[]) => {
  const row = thread as unknown as Record<string, unknown>
  for (const key of keys) {
    const value = row[key]
    if (Array.isArray(value)) {
      const items = value.map((item) => String(item ?? '').trim()).filter(Boolean)
      if (items.length > 0) return items
    }
    if (typeof value === 'string' && value.trim()) {
      const items = value.split(',').map((item) => item.trim()).filter(Boolean)
      if (items.length > 0) return items
    }
  }
  return []
}

const normalizeLabel = (value: string) => value.replace(/_/g, ' ').trim()

const formatMoneyCompact = (value: number | null) => (value && value > 0 ? formatCurrency(value) : '—')

const formatPercentCompact = (value: number | null) => (value && value > 0 ? formatPercent(value) : '—')

const formatCompactMoney = (value: number | null): string => {
  if (value == null || value <= 0) return '—'
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`
  return `$${Math.round(value).toLocaleString()}`
}

const formatEquityDisplay = (amount: number | null, percent: number | null): string => {
  if (percent != null && percent > 0) return `${Math.round(percent)}%`
  if (amount != null && amount > 0) return formatCompactMoney(amount)
  return '—'
}

const resolvePropertyTypeLabel = (propertyType: string): string => {
  const t = propertyType.toLowerCase()
  if (!t || t === 'unknown type') return ''
  if (t.includes('single') || t === 'sfr') return 'SFR'
  if (t.includes('multi')) return 'Multifamily'
  if (t.includes('condo')) return 'Condo'
  if (t.includes('town')) return 'Townhome'
  if (t.includes('land')) return 'Land'
  if (t.includes('commercial')) return 'Commercial'
  return propertyType
}

const resolveStageNumber = (stage: string): number | null => {
  const s = stage.toLowerCase()
  const match = s.match(/stage[_\s#-]*(\d+)/)
  if (match) return Number(match[1])
  if (s.includes('stage_1') || s === '1') return 1
  if (s.includes('stage_2')) return 2
  if (s.includes('stage_3')) return 3
  if (s.includes('stage_4')) return 4
  if (s.includes('stage_5')) return 5
  return null
}

type DeliveryReceipt = {
  type: 'inbound' | 'delivered' | 'failed' | 'sent' | 'pending'
  label: string
  icon: 'arrow-down-left' | 'check-double' | 'x' | 'check' | 'clock'
}

const resolveDeliveryReceipt = (
  thread: InboxWorkflowThread,
  latestDirection: string,
  deliveryStatus: 'sent' | 'delivered' | 'failed' | null,
): DeliveryReceipt | null => {
  if (latestDirection === 'inbound') {
    return { type: 'inbound', label: 'Inbound', icon: 'arrow-down-left' }
  }
  const latestStatus = String(
    (thread as Record<string, unknown>).latestDeliveryStatus
    || (thread as Record<string, unknown>).deliveryStatus
    || '',
  ).toLowerCase()
  if (deliveryStatus === 'delivered' || latestStatus === 'delivered') {
    return { type: 'delivered', label: 'Delivered', icon: 'check-double' }
  }
  if (deliveryStatus === 'failed' || latestStatus.includes('fail') || latestStatus.includes('undeliv')) {
    return { type: 'failed', label: 'Failed', icon: 'x' }
  }
  if (latestStatus.includes('pending') || latestStatus.includes('queue') || latestStatus.includes('schedul')) {
    return { type: 'pending', label: 'Pending', icon: 'clock' }
  }
  if (deliveryStatus === 'sent' || latestDirection === 'outbound') {
    return { type: 'sent', label: 'Sent', icon: 'check' }
  }
  return null
}

const priorityScoreClass = (score: number | null): string => {
  if (score == null) return 'is-muted'
  if (score >= 80) return 'is-priority-critical'
  if (score >= 60) return 'is-priority-high'
  return 'is-priority-low'
}

const resolveMaterialIntent = (thread: InboxWorkflowThread, decision: ConversationDecision): string | null => {
  const intent = String((decision as any).ui_intent || (thread as any).uiIntent || (thread as any).detected_intent || '').toLowerCase()
  const status = readString(thread, 'universalStatus', 'universal_status', 'inboxStatus', 'statusText', 'status').toLowerCase()
  const haystack = `${intent} ${status}`

  if (haystack.includes('wrong_number') || haystack.includes('wrong number')) return 'Wrong Number'
  if (haystack.includes('not_interested') || haystack.includes('not interested')) return 'Not Interested'
  if (haystack.includes('ownership') && haystack.includes('confirm')) return 'Ownership Confirmed'
  if (haystack.includes('price_provided') || haystack.includes('price provided') || haystack.includes('asking price')) return 'Price Provided'
  if (haystack.includes('asks_offer') || haystack.includes('ask offer') || haystack.includes('make offer')) return 'Asks Offer'
  if (haystack.includes('interested') || intent === 'yes') return 'Seller Interested'

  return null
}

const formatDirectionLabel = (direction: string): string => {
  const d = direction.toLowerCase()
  if (d === 'inbound') return 'Inbound'
  if (d === 'outbound') return 'Outbound'
  return ''
}

const resolveStatusChipClass = (thread: InboxWorkflowThread): string => {
  const bucket = resolveBucketFromThreadState(thread) ?? classifyInboxBucket(thread).bucket
  if (bucket === 'priority') return 'is-priority'
  if (bucket === 'new_replies') return 'is-new_replies'
  if (bucket === 'needs_review') return 'is-needs_review'
  if (bucket === 'follow_up' || bucket === 'waiting_on_seller') return 'is-waiting'
  return 'is-all_messages'
}

const renderBadge = (label: string, key: string) => (
  <span key={key} className="nx-ops75-badge">{label}</span>
)

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

const resolveBucketFromThreadState = (thread: InboxWorkflowThread): CanonicalBucket | null => {
  const raw = readString(
    thread,
    'inbox_bucket',
    'inboxBucket',
    'status_bucket',
    'inbox_category',
    'inboxCategory',
    'priority_bucket',
    'priorityBucket',
  ).toLowerCase()
  if (!raw) return null
  if (raw.includes('priority') || raw.includes('hot_leads') || raw === 'hot') return 'priority'
  if (raw.includes('new_reply') || raw.includes('new_replies') || raw.includes('new_inbound') || raw.includes('needs_reply')) return 'new_replies'
  if (raw.includes('needs_review') || raw.includes('manual_review')) return 'needs_review'
  if (raw.includes('follow_up') || raw.includes('follow-up') || raw.includes('outbound_active') || raw.includes('automated') || raw.includes('waiting_on_seller') || raw.includes('waiting')) return 'follow_up'
  if (raw.includes('dead') || raw.includes('wrong_number') || raw.includes('not_interested')) return 'dead'
  if (raw.includes('suppressed') || raw.includes('dnc') || raw.includes('opt_out')) return 'suppressed'
  if (raw.includes('cold') || raw.includes('not_contacted')) return 'cold'
  if (raw === 'all' || raw === 'all_messages' || raw === 'all_conversations') return 'all'
  return null
}

const getThreadVars = (thread: InboxWorkflowThread, decision: ConversationDecision) => {
  const name = resolveThreadPrimaryName(thread) || readString(thread, 'best_phone', 'canonical_e164', 'phone') || 'Unknown Owner'
  const address = resolveThreadAddressLine(thread) || readString(thread, 'property_address_full', 'propertyAddressFull') || 'Property Unknown'
  const market = resolveThreadMarketBadge(thread) || 'Unknown Market'
  const propertyType = readString(thread, 'propertyType', 'property_type') || 'Unknown Type'
  const sellerPhone = readString(thread, 'sellerPhone', 'seller_phone', 'displayPhone', 'best_phone', 'canonical_e164', 'phone')
  const latestMessageBody = readString(thread, 'latestMessageBody', 'latest_message_body', 'lastMessageBody', 'preview') || 'No latest message'
  const latestDirection = String(thread.latestDirection || (thread as any).latest_direction || '').toLowerCase() || 'unknown'
  const statusLabel = normalizeLabel(readString(thread, 'universalStatus', 'universal_status', 'workflowStatus', 'inboxStatus', 'statusText', 'status') || 'unknown')
  const stageLabel = normalizeLabel(readString(thread, 'universalStage', 'universal_stage', 'stage', 'conversationStage', 'workflowStage') || 'unknown')
  const bucketLabel = normalizeLabel(readString(thread, 'inboxBucket', 'inbox_bucket', 'priorityBucket', 'priority_bucket', 'inboxCategory', 'inbox_category') || 'all_messages')
  const latestActivityAt = readString(thread, 'latestActivityAt', 'latest_activity_at', 'latestMessageAt', 'lastMessageAt', 'lastMessageIso')
  const cashOffer = readNumber(thread, 'cashOffer', 'cash_offer')
  const estimatedValue = readNumber(thread, 'estimatedValue', 'estimated_value')
  const equityAmount = readNumber(thread, 'equityAmount', 'equity_amount')
  const equityPercent = readNumber(thread, 'equityPercent', 'equity_percent')
  const estimatedRepairCost = readNumber(thread, 'estimatedRepairCost', 'estimated_repair_cost')
  const finalAcquisitionScore = readNumber(thread, 'finalAcquisitionScore', 'final_acquisition_score')
  const propertyTags = readStringList(thread, 'propertyTags', 'podio_tags')
  const sellerTags = readStringList(thread, 'sellerTags', 'seller_tags_text')
  const contactFlags = [
    readBoolean(thread, 'optOut', 'isOptOut') && 'Opt Out',
    readBoolean(thread, 'wrongNumber', 'wrong_number') && 'Wrong Number',
    readBoolean(thread, 'notInterested', 'not_interested') && 'Not Interested',
  ].filter(Boolean) as string[]
  const contactStatus = contactFlags[0]
    || (readBoolean(thread, 'suppressed', 'isSuppressed') ? 'Suppressed' : decision.unread ? 'Needs Response' : 'Active')

  const timestamp = formatInboxThreadTimestamp(thread.lastMessageAt || (thread as any).lastMessageIso || thread.updatedAt)
  const isHot = (
    ['HOT', 'VERY_HOT', 'READY_TO_CLOSE'].includes(decision.lead_temperature) &&
    decision.suppression_status === 'clear'
  ) || ['urgent', 'high'].includes(String(thread.priority || '').toLowerCase())
  const stage = String((thread as any).conversationStage || decision.conversation_stage || '')
  const stageNumber = resolveStageNumber(stage)
  const stageNum = stageNumber ? `S${stageNumber}` : ''
  const stageDisplay = stageNumber ? `Stage #${stageNumber}` : ''
  const propertyTypeLabel = resolvePropertyTypeLabel(propertyType)
  const pTypeShort = propertyTypeLabel || propertyType
  const unitCount = readNumber(thread, 'unitCount', 'unit_count', 'units', 'number_of_units', 'units_count', 'portfolio_total_units')
  
  // Intel Tags
  const intelTags: string[] = []
  if ((thread as any).highEquity || (decision as any).high_equity) intelTags.push('High Equity')
  if ((thread as any).vacant || (decision as any).vacant) intelTags.push('Vacant')
  if ((thread as any).probate || (decision as any).probate) intelTags.push('Probate')
  if ((thread as any).absenteeOwner || (decision as any).absentee_owner) intelTags.push('Absentee')
  if ((thread as any).distressScore > 70) intelTags.push('Distressed')

  // 1. Delivery Status Logic (Outbound ONLY)
  let deliveryStatus: 'sent' | 'delivered' | 'failed' | null = null

  if (latestDirection === 'outbound') {
    const latestDeliveredAt = (thread as any).latestDeliveredAt || (thread as any).lastDeliveredAt
    const latestSentAt = (thread as any).latestSentAt || (thread as any).sentAt
    const latestStatus = String((thread as any).latestDeliveryStatus || (thread as any).deliveryStatus || '').toLowerCase()

    if (latestDeliveredAt || latestStatus === 'delivered') {
      deliveryStatus = 'delivered'
    } else if (latestStatus === 'failed' || latestStatus.includes('undeliv')) {
      deliveryStatus = 'failed'
    } else if (latestSentAt || (thread as any).latestProviderSid || (thread as any).outbound_count > 0) {
      deliveryStatus = 'sent'
    }
  }

  const deliveryReceipt = resolveDeliveryReceipt(thread, latestDirection, deliveryStatus)
  const marketLine = market && market !== 'Unknown Market' ? market : '—'
  const metaParts: string[] = []
  if (propertyTypeLabel) metaParts.push(propertyTypeLabel)
  if (unitCount != null && unitCount > 1) metaParts.push(`${unitCount} Units`)
  if (stageDisplay) metaParts.push(stageDisplay)
  const metaLine = metaParts.join(' · ') || '—'
  const contextParts: string[] = []
  if (marketLine !== '—') contextParts.push(marketLine)
  if (propertyTypeLabel) contextParts.push(propertyTypeLabel)
  if (unitCount != null && unitCount > 1) contextParts.push(`${unitCount} Units`)
  if (stageDisplay) contextParts.push(stageDisplay)
  const contextLine = contextParts.join(' · ') || '—'

  // 2. Visual Category Logic (Inbound ONLY)
  let visualCategory: 'positive' | 'negative' | 'autopilot' | 'review' | 'none' = 'none'
  
  if (latestDirection === 'inbound') {
    const intent = String((decision as any).ui_intent || (thread as any).uiIntent || '').toLowerCase()
    
    if (['yes', 'interested', 'positive', 'hot'].includes(intent) || isHot) {
      visualCategory = 'positive'
    } else if (['not_interested', 'no', 'negative', 'dnc', 'opt_out'].includes(intent)) {
      visualCategory = 'negative'
    } else if (thread.inboxCategory === 'automated' || (thread as any).automation_status === 'active' || (thread as any).automation_state === 'active') {
      visualCategory = 'autopilot'
    } else if (thread.inboxStatus === 'needs_review' || intent === 'question') {
      visualCategory = 'review'
    }
  }

  return {
    name,
    address,
    market,
    propertyType,
    pTypeShort,
    sellerPhone,
    latestMessageBody,
    latestDirection,
    statusLabel,
    stageLabel,
    bucketLabel,
    latestActivityAt,
    cashOffer,
    estimatedValue,
    equityAmount,
    equityPercent,
    estimatedRepairCost,
    finalAcquisitionScore,
    propertyTags,
    sellerTags,
    contactStatus,
    contactFlags,
    timestamp,
    isHot,
    stage,
    stageNum,
    stageNumber,
    stageDisplay,
    propertyTypeLabel,
    unitCount,
    contextLine,
    marketLine,
    metaLine,
    intelTags,
    deliveryStatus,
    deliveryReceipt,
    visualCategory,
  }
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
  const {
    name,
    address,
    market,
    pTypeShort,
    sellerPhone,
    latestMessageBody,
    latestDirection,
    statusLabel,
    stageLabel,
    bucketLabel,
    cashOffer,
    estimatedValue,
    equityAmount,
    equityPercent,
    estimatedRepairCost,
    finalAcquisitionScore,
    propertyTags,
    sellerTags,
    contactStatus,
    contactFlags,
    timestamp,
    isHot,
    stageNum,
    intelTags,
    deliveryStatus,
    visualCategory,
  } = getThreadVars(thread, decision)
  const isInbound = latestDirection === 'inbound'
  const isOutbound = latestDirection === 'outbound'
  const badges = [
    renderBadge(latestDirection || 'unknown', 'direction'),
    renderBadge(statusLabel, 'status'),
    renderBadge(stageLabel, 'stage'),
    renderBadge(bucketLabel, 'bucket'),
  ]
  const tagSummary = [...propertyTags, ...sellerTags].slice(0, 3)

  return (
    <div role="button" tabIndex={0}
      className={cls(
        'nx-thread-card-rebuilt',
        selected && 'is-selected',
        decision.unread && 'is-unread',
        isInbound && 'is-inbound',
        isOutbound && 'is-outbound',
        `is-category-${visualCategory}`
      )}
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
          {sellerPhone && <><span className="nx-thread-card-rebuilt__dot">•</span><span>{formatPhone(sellerPhone)}</span></>}
          {isHot && <><span className="nx-thread-card-rebuilt__dot">•</span><span>⚡ Fast</span></>}
          {intelTags.length > 0 && <><span className="nx-thread-card-rebuilt__dot">•</span><span style={{color: '#a1a1aa'}}>{intelTags[0]}</span></>}
        </div>
        <div className="nx-thread-card-rebuilt__preview">{latestMessageBody}</div>
        <div className="nx-thread-card-rebuilt__metadata">{badges}</div>
        <div className="nx-thread-card-rebuilt__metadata">
          <span>Offer {formatMoneyCompact(cashOffer)}</span>
          <span className="nx-thread-card-rebuilt__dot">•</span>
          <span>Value {formatMoneyCompact(estimatedValue)}</span>
          <span className="nx-thread-card-rebuilt__dot">•</span>
          <span>Equity {formatMoneyCompact(equityAmount)} / {formatPercentCompact(equityPercent)}</span>
        </div>
        <div className="nx-thread-card-rebuilt__metadata">
          <span>Repairs {formatMoneyCompact(estimatedRepairCost)}</span>
          <span className="nx-thread-card-rebuilt__dot">•</span>
          <span>Score {finalAcquisitionScore ?? '—'}</span>
          <span className="nx-thread-card-rebuilt__dot">•</span>
          <span>Contact {contactStatus}</span>
        </div>
        <div className="nx-thread-card-rebuilt__metadata">
          <span>Tags {tagSummary.length > 0 ? tagSummary.join(', ') : '—'}</span>
        </div>
        {contactFlags.length > 0 && (
          <div className="nx-thread-card-rebuilt__metadata">
            {contactFlags.map((flag) => renderBadge(flag, `flag-${flag}`))}
          </div>
        )}

        {/* Delivery Status Icon */}
        {deliveryStatus && (
          <div className={cls('nx-thread-card-rebuilt__delivery-status', `is-${deliveryStatus}`)}>
            {deliveryStatus === 'delivered' ? <Icon name="check-double" style={{ width: 14, height: 14 }} /> : 
             deliveryStatus === 'failed' ? <Icon name="close" style={{ width: 14, height: 14 }} /> : 
             <Icon name="check" style={{ width: 14, height: 14 }} />}
          </div>
        )}
      </div>
    </div>
  )
})
ConversationRow.displayName = 'ConversationRow'

const ConversationRowOps75 = memo(({ thread, selected, decision, onSelect, selectedForBulk, onToggleBulk }: any) => {
  const {
    name,
    address,
    market,
    pTypeShort,
    sellerPhone,
    latestMessageBody,
    latestDirection,
    statusLabel,
    stageLabel,
    bucketLabel,
    cashOffer,
    estimatedValue,
    equityAmount,
    equityPercent,
    finalAcquisitionScore,
    propertyTags,
    sellerTags,
    contactStatus,
    contactFlags,
    timestamp,
    isHot,
    stageNum,
    intelTags,
  } = getThreadVars(thread, decision)
  const tagSummary = [...propertyTags, ...sellerTags].slice(0, 3)
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
        <span className="nx-ops75-address">{market}{sellerPhone ? ` • ${formatPhone(sellerPhone)}` : ''}</span>
      </div>
      <div className="nx-ops75-col nx-ops75-col--msg">
        <span className="nx-ops75-preview">{latestMessageBody}</span>
        <time className="nx-ops75-time">{timestamp.timeLabel}</time>
        <span className="nx-ops75-time">{normalizeLabel(latestDirection || 'unknown')}</span>
      </div>
      <div className="nx-ops75-col nx-ops75-col--meta">
        {stageNum && <span className="nx-ops75-badge">{stageNum}</span>}
        <span className="nx-ops75-badge">{market}</span>
        <span className="nx-ops75-badge">{pTypeShort}</span>
        {isHot && <span className="nx-ops75-badge nx-ops75-badge--hot">🔥</span>}
        {intelTags.map(t => <span key={t} className="nx-ops75-badge">{t}</span>)}
        <span className="nx-ops75-badge">Offer {formatMoneyCompact(cashOffer)}</span>
        <span className="nx-ops75-badge">Value {formatMoneyCompact(estimatedValue)}</span>
        <span className="nx-ops75-badge">Equity {formatMoneyCompact(equityAmount)} / {formatPercentCompact(equityPercent)}</span>
        <span className="nx-ops75-badge">Score {finalAcquisitionScore ?? '—'}</span>
        {tagSummary.map((tag) => <span key={tag} className="nx-ops75-badge">{tag}</span>)}
      </div>
      <div className="nx-ops75-col nx-ops75-col--status">
        <span className={cls("nx-ops75-status", decision.unread && "is-unread")}>{statusLabel}</span>
        <span className="nx-ops75-badge">{stageLabel}</span>
        <span className="nx-ops75-badge">{bucketLabel}</span>
        <span className="nx-ops75-badge">{contactStatus}</span>
        {contactFlags.map((flag) => <span key={flag} className="nx-ops75-badge">{flag}</span>)}
      </div>
      <div className="nx-ops75-col nx-ops75-col--actions">
        <button type="button" className="nx-ops75-action-btn"><Icon name="message" /></button>
      </div>
    </div>
  )
})
ConversationRowOps75.displayName = 'ConversationRowOps75'

// Elite four-zone row — rail25 / review50 / ops75 / full100 (one component, responsive CSS)
const CompactRow25 = memo(({ thread, selected, decision, onSelect }: {
  thread: InboxWorkflowThread
  selected: boolean
  decision: ConversationDecision
  onSelect: (id: string) => void
}) => {
  const vars = getThreadVars(thread, decision)
  const {
    name, address, marketLine, metaLine, latestMessageBody, latestDirection,
    statusLabel, bucketLabel, estimatedValue, equityAmount, equityPercent,
    finalAcquisitionScore, timestamp, deliveryReceipt,
  } = vars

  const ageLabel = timestamp.dayLabel === 'Today' ? timestamp.timeLabel : timestamp.dayLabel
  const statusChipClass = resolveStatusChipClass(thread)
  const bucketAccentClass = statusChipClass.replace('is-', 'is-bucket-')
  const statusChipLabel = bucketLabel !== 'all messages' ? bucketLabel : statusLabel
  const unreadCount = readNumber(thread, 'unreadCount', 'unread_count', 'unreadMessages', 'unread_messages')
  const directionLabel = formatDirectionLabel(latestDirection)
  const materialIntent = resolveMaterialIntent(thread, decision)
  const valueDisplay = formatCompactMoney(estimatedValue)
  const scoreDisplay = finalAcquisitionScore != null ? String(Math.round(finalAcquisitionScore)) : '—'
  const equityDisplay = formatEquityDisplay(equityAmount, equityPercent)

  return (
    <div
      role="button"
      tabIndex={0}
      className={cls(
        'nx-row25',
        bucketAccentClass,
        selected && 'is-selected',
        decision.unread && 'is-unread',
        latestDirection === 'inbound' && 'is-inbound',
        latestDirection === 'outbound' && 'is-outbound',
      )}
      data-thread-id={thread.id}
      onClick={() => onSelect(thread.id)}
      onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') onSelect(thread.id) }}
    >
      <div className="nx-row25__zone nx-row25__zone--context">
        <span className="nx-row25__market">{marketLine}</span>
        <span className="nx-row25__meta">{metaLine}</span>
      </div>

      <div className="nx-row25__zone nx-row25__zone--conversation">
        <div className="nx-row25__head">
          <span className="nx-row25__name-wrap">
            {decision.unread && <span className="nx-row25__unread-dot" aria-hidden="true" />}
            <span className="nx-row25__name">{name}</span>
          </span>
          <time className="nx-row25__time nx-row25__time--head">{ageLabel}</time>
        </div>
        <span className="nx-row25__addr">{address}</span>
        <span className="nx-row25__preview">{latestMessageBody}</span>
        <div className="nx-row25__footer">
          {deliveryReceipt && (
            <span className={cls('nx-row25__receipt', `is-${deliveryReceipt.type}`)}>
              <Icon name={deliveryReceipt.icon} />
              <span>{deliveryReceipt.label}</span>
            </span>
          )}
          {deliveryReceipt && directionLabel && <span className="nx-row25__footer-sep" aria-hidden="true">·</span>}
          {directionLabel && <span className="nx-row25__direction">{directionLabel}</span>}
          {materialIntent && (
            <>
              <span className="nx-row25__footer-sep" aria-hidden="true">·</span>
              <span className="nx-row25__intent">{materialIntent}</span>
            </>
          )}
        </div>
      </div>

      <div className="nx-row25__zone nx-row25__zone--metrics">
        <div className="nx-row25__metrics-group" aria-label="Opportunity metrics">
          <div className="nx-row25__metric-cell">
            <span className="nx-row25__metric-v">{valueDisplay}</span>
            <span className="nx-row25__metric-k">Value</span>
          </div>
          <div className="nx-row25__metric-cell">
            <span className={cls('nx-row25__metric-v', priorityScoreClass(finalAcquisitionScore))}>{scoreDisplay}</span>
            <span className="nx-row25__metric-k">Priority</span>
          </div>
          <div className="nx-row25__metric-cell">
            <span className="nx-row25__metric-v">{equityDisplay}</span>
            <span className="nx-row25__metric-k">Equity</span>
          </div>
        </div>
        <span className="nx-row25__metrics-inline" aria-hidden="true">
          {valueDisplay} · {scoreDisplay} · {equityDisplay}
        </span>
      </div>

      <div className="nx-row25__zone nx-row25__zone--action">
        <span className={cls('nx-row25__status-chip', statusChipClass)}>{statusChipLabel}</span>
        {unreadCount != null && unreadCount > 1 && (
          <span className="nx-row25__unread-badge">{unreadCount}</span>
        )}
        <button
          type="button"
          className="nx-row25__overflow-btn"
          aria-label="Thread actions"
          onClick={(e) => { e.stopPropagation() }}
        >
          <Icon name="more" />
        </button>
      </div>
    </div>
  )
})
CompactRow25.displayName = 'CompactRow25'

const DealSnapshotPlaceholder = ({ thread, decision }: any) => {
  if (!thread) return <div className="nx-deal-snapshot-empty">Select a thread to view details</div>
  const { name, address, market, latestMessageBody } = getThreadVars(thread, decision)
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
          <p>{latestMessageBody}</p>
        </div>
      </div>
    </div>
  )
}

export const InboxSidebar = ({
  threads, selectedId, activeViewFilter, onSelect, savedPreset, onApplySavedPreset,
  viewCounts, onOpenAdvancedFilters, onClearFilters, onRetryLoad, onLoadMore, canLoadMore,
  recentlyUpdatedThreadIds = new Set(), searchQuery = '', onSearchQueryChange,
  visibleThreadCount = 1000, loadingError, inboxMode = 'rail25', densityMode = 'compact',
  loading = false,
  realtimeStatus = 'connecting',
  refreshMode = 'realtime',
}: InboxSidebarProps) => {
  const groupsRef = useRef<HTMLDivElement | null>(null)
  // Stores scroll position before a Load More so it can be restored after new rows paint.
  const scrollPreserveRef = useRef<{ top: number; height: number } | null>(null)
  const loadMoreTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [loadMoreLoading, setLoadMoreLoading] = useState(false)
  const prevThreadsLengthRef = useRef(threads.length)
  const inboxLoadFailed = Boolean(formatLoadingError(loadingError))
  const canonicalActiveView = useMemo<InboxViewSelectValue>(() => {
    if (activeViewFilter === 'waiting_on_seller' || activeViewFilter === 'waiting') return 'waiting'
    if (activeViewFilter === 'follow_up_due' || activeViewFilter === 'follow_up') return 'follow_up'
    if (activeViewFilter === 'dnc_opt_out' || activeViewFilter === 'opt_out') return 'suppressed'
    if (activeViewFilter === 'cold_no_response' || activeViewFilter === 'not_contacted') return 'cold'
    if (activeViewFilter === 'wrong_number' || (activeViewFilter as string) === 'not_interested') return 'dead'
    if ((activeViewFilter as string) === 'all' || activeViewFilter === 'all_messages' || activeViewFilter === 'all_conversations') return 'all_conversations'
    return activeViewFilter
  }, [activeViewFilter])

  const activeBucketConfig = useMemo(
    () => BUCKETS.find((bucket) => bucket.view === canonicalActiveView)
      ?? BUCKETS.find((bucket) => bucket.bucket === 'all_messages')
      ?? VISIBLE_INBOX_CHIPS[VISIBLE_INBOX_CHIPS.length - 1],
    [canonicalActiveView],
  )
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set())
  const [savedFilters, setSavedFilters] = useState<LocalSavedFilter[]>([])
  const [showManageLists, setShowManageLists] = useState(false)
  // Cold follow-up stale-age sub-filter (null = all cold, number = min days since last outbound)
  const [coldStaleDays, setColdStaleDays] = useState<number | null>(null)

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

  const searchableThreads = useMemo(() => {
    return threads.filter((thread) => !recentlyUpdatedThreadIds.has(`hidden:${thread.id}`) && matchesSearch(thread, searchQuery))
  }, [threads, recentlyUpdatedThreadIds, searchQuery])

  const decisionMap = useMemo(() => {
    const map = new Map<string, ConversationDecision>()
    searchableThreads.forEach((thread) => map.set(thread.id, buildConversationDecision(thread)))
    return map
  }, [searchableThreads])

  // Single source of visible threads.
  // `threads` prop is already bucket-scoped by the store (useInboxData fetches by view filter).
  // We only apply: search, sort, a safety hard-reject for any wrong-bucket backend rows, and
  // the cold stale-age sub-filter. No in-component re-bucketing, no fallback to other buckets.
  const displayedActiveThreads = useMemo(() => {
    const activeBucket = activeBucketConfig.bucket
    const now = new Date()

    // Safety hard-filter: reject any rows the backend returned with a mismatched bucket.
    // In normal operation this is a no-op; it protects against backend classification drift.
    let filtered = activeBucket === 'all_messages'
      ? searchableThreads
      : searchableThreads.filter((thread) => {
          const stateBucket = resolveBucketFromThreadState(thread)
          const resolvedBucket = stateBucket || classifyInboxBucket(thread, now).bucket
          if (resolvedBucket !== activeBucket) {
            console.log(
              '[VISIBLE_THREAD_REJECT]',
              thread.threadKey || thread.id,
              activeBucket,
              readString(thread, 'inbox_bucket', 'inboxBucket', 'inbox_category', 'inboxCategory'),
            )
            return false
          }
          return true
        })

    const sorted = sortThreadsByDecision(filtered, decisionMap).slice(0, visibleThreadCount)

    console.log('[VISIBLE_THREADS_SOURCE]', activeBucket, threads.length, sorted.length, 'store')

    if (activeBucket !== 'cold' || coldStaleDays === null) return sorted
    const cutoff = Date.now() - coldStaleDays * 24 * 60 * 60 * 1000
    return sorted.filter((thread) => {
      const ts = thread.lastOutboundAt
        || (thread as any).last_outbound_at
        || (thread as any).latestMessageAt
        || thread.lastMessageAt
      if (!ts) return true
      return new Date(ts).getTime() <= cutoff
    })
  }, [searchableThreads, decisionMap, visibleThreadCount, activeBucketConfig.bucket, coldStaleDays, threads.length])

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

  const handleClearFilters = useCallback(() => {
    setColdStaleDays(null)
    onSearchQueryChange?.('')
    onClearFilters?.()
    onApplySavedPreset('all_messages')
  }, [onApplySavedPreset, onClearFilters, onSearchQueryChange])

  // Clear load-more spinner when new threads arrive; timeout is a fallback for empty loads.
  useEffect(() => {
    if (threads.length !== prevThreadsLengthRef.current) {
      prevThreadsLengthRef.current = threads.length
      setLoadMoreLoading(false)
      if (loadMoreTimeoutRef.current) { clearTimeout(loadMoreTimeoutRef.current); loadMoreTimeoutRef.current = null }
    }
  }, [threads.length])

  // Captures scroll before Load More fires, so it can be restored after new rows append.
  const handleLoadMorePreservingScroll = useCallback(() => {
    const el = groupsRef.current
    const previousScrollTop = el?.scrollTop ?? 0
    const previousScrollHeight = el?.scrollHeight ?? 0
    console.log('[InboxUX] load more start', { activeFilter: activeViewFilter, cursor: null, previousScrollTop, previousScrollHeight })
    scrollPreserveRef.current = { top: previousScrollTop, height: previousScrollHeight }
    setLoadMoreLoading(true)
    if (loadMoreTimeoutRef.current) clearTimeout(loadMoreTimeoutRef.current)
    loadMoreTimeoutRef.current = setTimeout(() => setLoadMoreLoading(false), 8000)
    onLoadMore()
  }, [onLoadMore, activeViewFilter])

  // Only scroll to the selected thread when it is outside the visible area.
  // Unconditional scrollIntoView was the primary cause of the list jumping on every click.
  useEffect(() => {
    if (!selectedId) return
    const root = groupsRef.current
    if (!root) return
    const selectedNode = root.querySelector<HTMLElement>(`[data-thread-id="${selectedId}"]`)
    if (!selectedNode) return
    const rootRect = root.getBoundingClientRect()
    const nodeRect = selectedNode.getBoundingClientRect()
    const isAlreadyVisible = nodeRect.top >= rootRect.top && nodeRect.bottom <= rootRect.bottom
    if (!isAlreadyVisible) {
      selectedNode.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [selectedId, activeBucketConfig, visibleThreadCount])

  // After new rows are appended by Load More, restore the scroll position that was
  // captured in scrollPreserveRef so the viewport doesn't jump to the top.
  useEffect(() => {
    if (scrollPreserveRef.current === null) return
    const saved = scrollPreserveRef.current
    scrollPreserveRef.current = null
    requestAnimationFrame(() => {
      const el = groupsRef.current
      if (!el) return
      const newScrollHeight = el.scrollHeight
      el.scrollTop = saved.top + (newScrollHeight - saved.height)
      console.log('[InboxUX] restored scroll', { scrollTop: el.scrollTop })
    })
  }, [displayedActiveThreads.length])

  // Reset scroll to top on every bucket/category switch.
  // scrollPreserveRef is only set by Load More, so this never conflicts with it.
  useEffect(() => {
    const el = groupsRef.current
    if (!el) return
    console.log('[BUCKET_SWITCH_RESET_SCROLL]', { bucket: activeBucketConfig.bucket })
    el.scrollTop = 0
  }, [activeBucketConfig.bucket])

  // Log the row state for the active bucket each time it changes.
  useEffect(() => {
    if (displayedActiveThreads.length === 0) return
    const first = displayedActiveThreads[0] as any
    console.log('[INBOX_BUCKET_ROWS]', {
      bucket: activeBucketConfig.bucket,
      count: displayedActiveThreads.length,
      firstThreadKey: first?.threadKey ?? first?.id ?? null,
      firstLatestAt: first?.lastMessageAt ?? first?.latestMessageAt ?? first?.latest_activity_at ?? null,
    })
  }, [activeBucketConfig.bucket, displayedActiveThreads.length])

  const renderTopActions = () => (
    <div className="nx-inbox-header-shell">
      <div className={cls('nx-inbox-header-shell__inner', 'nx-sidebar-rebuilt__top-glow', `is-${activeBucketConfig.accentClass.replace('is-', '')}`)}>
      <div className="nx-sidebar-rebuilt__search-top">
        <div className="nx-sidebar-rebuilt__search-input-wrap">
          <Icon name="search" className="nx-sidebar-rebuilt__search-icon" />
          <input value={searchQuery} onChange={(e) => onSearchQueryChange?.(e.target.value)} placeholder="Search operator inbox..." aria-label="Search inbox threads" />
          {searchQuery && <button type="button" className="nx-sidebar-rebuilt__search-clear" onClick={() => onSearchQueryChange?.('')}><Icon name="close" /></button>}
        </div>
        <div className="nx-sidebar-rebuilt__top-actions">
          <button type="button" className="nx-sidebar__icon-button" title="Advanced filters" onClick={onOpenAdvancedFilters}><Icon name="filter" /></button>
          <button type="button" className="nx-sidebar__icon-button" title="Clear filters" onClick={handleClearFilters}><Icon name="close" /></button>
        </div>
      </div>
      <div className="nx-cat-nav" role="tablist" aria-label="Inbox categories">
        {VISIBLE_INBOX_CHIPS.map((item) => {
          const countValue = numberOrNull(viewCounts[item.countKey])
          const isActive = activeBucketConfig.view === item.view
          const showUnread = item.bucket === 'new_replies' && Number(countValue ?? 0) > 0
          return (
            <button
              key={item.view}
              type="button"
              role="tab"
              aria-selected={isActive}
              data-category={item.bucket}
              className={cls('nx-cat-nav__item', isActive && 'is-active')}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onApplySavedPreset(viewToPreset(item.view))
              }}
            >
              <span className="nx-cat-nav__icon" aria-hidden="true">{item.icon}</span>
              <span className="nx-cat-nav__label">{item.label}</span>
              <span className="nx-cat-nav__count">{formatCount(countValue)}</span>
              {showUnread && <span className="nx-cat-nav__unread" aria-label="Unread replies" />}
            </button>
          )
        })}
      </div>
      {activeBucketConfig.bucket === 'cold' && (
        <div className="nx-cold-stale-chips" role="group" aria-label="Cold follow-up age filter">
          {([
            { label: 'All Cold', days: null as number | null },
            { label: '24h+', days: 1 },
            { label: '3d+', days: 3 },
            { label: '7d+', days: 7 },
            { label: '14d+', days: 14 },
            { label: '30d+', days: 30 },
          ] as Array<{ label: string; days: number | null }>).map(({ label, days }) => (
            <button
              key={label}
              type="button"
              className={cls('nx-cold-stale-chip', coldStaleDays === days && 'is-active')}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setColdStaleDays(days) }}
            >{label}</button>
          ))}
        </div>
      )}
      </div>
    </div>
  )

  const renderSecondaryControls = () => (
    <>
      <div className="nx-sidebar-rebuilt__secondary-controls">
        {inboxLoadFailed && (
          <button
            type="button"
            className="nx-sidebar-rebuilt__telemetry-indicator"
            onClick={() => onRetryLoad?.()}
          >
            <Icon name="alert" /> Inbox could not load. Retry.
          </button>
        )}
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
      {loading && displayedActiveThreads.length === 0 ? (
        <div className="nx-sidebar-skeleton">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className={cls("nx-sidebar-skeleton__row", densityMode === 'compact' && 'is-compact')}>
              <div className="nx-sidebar-skeleton__avatar shimmer" />
              <div className="nx-sidebar-skeleton__content">
                <div className="nx-sidebar-skeleton__line nx-sidebar-skeleton__line--title shimmer" style={{ width: '45%' }} />
                <div className="nx-sidebar-skeleton__line shimmer" style={{ width: '75%' }} />
              </div>
            </div>
          ))}
        </div>
      ) : displayedActiveThreads.length > 0 ? displayedActiveThreads.map((thread) => {
        const decision = decisionMap.get(thread.id)
        if (!decision) return null
        return <RowComp key={thread.threadKey || thread.id} thread={thread} selected={selectedId === thread.id} decision={decision} onSelect={(id: string) => { console.log('[InboxUX] select thread', { threadKey: thread.threadKey || thread.id, activeFilter: activeViewFilter }); onSelect(id) }} selectedForBulk={bulkSelectedIds.has(thread.id)} onToggleBulk={handleToggleBulk} />
      }) : (
        <div className={cls('nx-sidebar-rebuilt__empty', inboxLoadFailed && 'is-degraded')}>
          {inboxLoadFailed ? (
            <button type="button" className="nx-sidebar-rebuilt__telemetry-indicator" onClick={() => onRetryLoad?.()}>
              <Icon name="alert" /> Inbox could not load. Retry.
            </button>
          ) : 'No conversations match this filter.'}
        </div>
      )}
      {canLoadMore && (
        <div className="nx-sidebar-rebuilt__load-more">
          <button type="button" className={cls('nx-load-more-btn', loadMoreLoading && 'is-loading')} disabled={loadMoreLoading} onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleLoadMorePreservingScroll() }}>
            {loadMoreLoading ? <><span className="nx-load-more-spinner" aria-hidden="true" /><span>Loading…</span></> : 'Load More'}
          </button>
        </div>
      )}
    </div>
  )

  const sidebarShellClass = cls(
    'nx-sidebar-rebuilt',
    `nx-sidebar--mode-${inboxMode}`,
    inboxMode === 'review50' && 'nx-sidebar--mode-rail25',
    `nx-sidebar--active-${activeBucketConfig.accentClass.replace('is-', '')}`,
    savedPreset && 'has-preset',
  )

  if (inboxMode === 'review50') {
    return (
      <aside className={sidebarShellClass} data-active-category={activeBucketConfig.bucket}>
        <div className="nx-review50-layout">
          <div className="nx-review50-left" ref={groupsRef}>
            {renderTopActions()}
            {renderSecondaryControls()}
            {renderMultiSelectBar()}
            <div className="nx-sidebar-rebuilt__list-container">
              {renderListContent(CompactRow25)}
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
      <aside className={sidebarShellClass} data-active-category={activeBucketConfig.bucket}>
        <div className="nx-full100-layout">
          <div className="nx-full100-left">
            {renderTopActions()}
            {renderSecondaryControls()}
          </div>
          <div className="nx-full100-center" ref={groupsRef}>
            {renderMultiSelectBar()}
            <div className="nx-sidebar-rebuilt__list-container">
              {renderListContent(CompactRow25)}
            </div>
          </div>
          <div className="nx-full100-right">
            <DealSnapshotPlaceholder thread={threads.find(t => t.id === selectedId)} decision={selectedId ? decisionMap.get(selectedId) : null} />
          </div>
        </div>
      </aside>
    )
  }

  return (
    <aside className={sidebarShellClass} data-active-category={activeBucketConfig.bucket}>
      {renderTopActions()}
      <div className="nx-sidebar-rebuilt__list-container" ref={groupsRef}>
        {renderSecondaryControls()}
        {renderMultiSelectBar()}
        {renderListContent(CompactRow25)}
      </div>
    </aside>
  )
}

const viewToPreset = (view: InboxViewSelectValue | string): InboxSavedFilterPreset => {
  if (view === 'new_replies') return 'new_inbounds'
  if (view === 'priority') return 'my_priority'
  if (view === 'needs_review') return 'review_required'
  if (view === 'waiting' || view === 'waiting_on_seller') return 'waiting'
  if (view === 'follow_up' || view === 'follow_up_due') return 'offer_needed'
  if (view === 'cold' || view === 'cold_no_response' || view === 'not_contacted') return 'missing_context'
  if (view === 'dead' || view === 'wrong_number') return 'wrong_numbers'
  if (view === 'suppressed' || view === 'dnc_opt_out') return 'suppressed'
  return 'all_messages'
}
