import type { QueueItem } from '../../lib/data/queueData'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import { getConversationThreadIdForThread } from '../../lib/data/inboxData'
import { normalizeDealContext, type DealContext } from '../../lib/data/dealContext'
import type { ActiveInboxContext } from '../../modules/inbox/active-context'
import type { PipelineOpportunity } from '../pipeline/pipeline-opportunity.types'
import { buildContextFromOpportunity } from '../../modules/inbox/active-context'
import { universalContextFromOpportunity } from '../pipeline/pipeline-universal-context'
import type { UniversalEntityContext } from './entity-graph.types'
import { activeInboxFromUniversalContext } from './universal-entity-context'

const INVALID_STRING_VALUES = new Set(['', 'Unknown', 'Unknown Property', 'Unknown Owner', 'Unknown Seller', 'Unknown Address', 'Unknown Market'])
const isValidStr = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && !INVALID_STRING_VALUES.has(v.trim())
const isValidNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v !== 0
const isValidCoord = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) > 0.001
const pickStr = (a: unknown, b: unknown): string => (isValidStr(a) ? (a as string) : isValidStr(b) ? (b as string) : '')
const pickNum = (a: unknown, b: unknown): number => (isValidNum(a) ? (a as number) : isValidNum(b) ? (b as number) : 0)

export function findThreadByRef(
  threads: InboxWorkflowThread[],
  ref: string | null | undefined,
): InboxWorkflowThread | undefined {
  const normalized = String(ref ?? '').trim()
  if (!normalized) return undefined
  return threads.find((thread) => {
    const key = thread.threadKey || thread.id
    const conversationId = getConversationThreadIdForThread(thread) || key
    return thread.id === normalized
      || key === normalized
      || conversationId === normalized
  })
}

export function activeContextMatchesThread(
  active: ActiveInboxContext,
  thread: InboxWorkflowThread,
): boolean {
  const key = thread.threadKey || thread.id
  const conversationId = getConversationThreadIdForThread(thread) || key
  const ownerId = thread.ownerId
  const propertyId = thread.propertyId
  return Boolean(
    (active.threadKey && (active.threadKey === key || active.threadKey === conversationId))
    || (active.propertyId && propertyId && active.propertyId === propertyId)
    || (active.sellerId && ownerId && active.sellerId === ownerId)
    || (active.masterOwnerId && ownerId && active.masterOwnerId === ownerId),
  )
}

export function hasEntityAnchor(active: ActiveInboxContext): boolean {
  return Boolean(
    active.opportunityId
    || active.threadKey
    || active.propertyId
    || active.masterOwnerId
    || active.sellerId
    || active.queueId,
  )
}

export function findQueueItemForActiveContext(
  items: QueueItem[],
  active: ActiveInboxContext,
): QueueItem | undefined {
  if (!items.length || !hasEntityAnchor(active)) return undefined
  if (active.queueId) {
    const byQueue = items.find((item) => item.id === active.queueId || item.queueId === active.queueId)
    if (byQueue) return byQueue
  }
  if (active.messageEventId) {
    const byEvent = items.find((item) => item.messageEventId === active.messageEventId || item.id === active.messageEventId)
    if (byEvent) return byEvent
  }
  if (active.threadKey) {
    const byThread = items.find((item) => item.linkedInboxThreadId === active.threadKey)
    if (byThread) return byThread
  }
  if (active.propertyId) {
    const byProperty = items.find((item) => item.linkedPropertyId === active.propertyId)
    if (byProperty) return byProperty
  }
  const ownerId = active.masterOwnerId || active.sellerId
  if (ownerId) {
    return items.find((item) => item.linkedOwnerId === ownerId)
  }
  return undefined
}

export function queueItemMatchesActiveContext(
  item: QueueItem,
  active: ActiveInboxContext,
): boolean {
  if (active.queueId && (item.id === active.queueId || item.queueId === active.queueId)) return true
  if (active.messageEventId && (item.messageEventId === active.messageEventId || item.id === active.messageEventId)) return true
  if (active.threadKey && item.linkedInboxThreadId === active.threadKey) return true
  if (active.propertyId && item.linkedPropertyId === active.propertyId) return true
  const ownerId = active.masterOwnerId || active.sellerId
  if (ownerId && item.linkedOwnerId === ownerId) return true
  return false
}

export function findOpportunityForActiveContext(
  opportunities: PipelineOpportunity[],
  active: ActiveInboxContext,
): PipelineOpportunity | undefined {
  if (!opportunities.length || !hasEntityAnchor(active)) return undefined
  if (active.opportunityId) {
    const byId = opportunities.find((o) => o.id === active.opportunityId)
    if (byId) return byId
  }
  if (active.threadKey) {
    const byThread = opportunities.find((o) => o.primary_thread_key === active.threadKey)
    if (byThread) return byThread
  }
  if (active.propertyId) {
    const byProperty = opportunities.find((o) => o.primary_property_id === active.propertyId)
    if (byProperty) return byProperty
  }
  const ownerId = active.masterOwnerId || active.sellerId
  if (ownerId) {
    return opportunities.find((o) => o.master_owner_id === ownerId)
  }
  return undefined
}

export function resolveInboxHighlightId(
  threads: InboxWorkflowThread[],
  selected: InboxWorkflowThread | null,
  active: ActiveInboxContext,
): string | null {
  if (selected?.id) return selected.id
  return findThreadForActiveContext(threads, active)?.id ?? null
}

export function opportunityMatchesActiveContext(
  opportunity: PipelineOpportunity,
  active: ActiveInboxContext,
): boolean {
  if (active.opportunityId && opportunity.id === active.opportunityId) return true
  if (active.threadKey && opportunity.primary_thread_key === active.threadKey) return true
  if (active.propertyId && opportunity.primary_property_id === active.propertyId) return true
  const ownerId = active.masterOwnerId || active.sellerId
  if (ownerId && opportunity.master_owner_id === ownerId) return true
  return false
}

export function findThreadForActiveContext(
  threads: InboxWorkflowThread[],
  active: ActiveInboxContext,
): InboxWorkflowThread | undefined {
  if (active.threadKey) {
    const byKey = findThreadByRef(threads, active.threadKey)
    if (byKey) return byKey
  }
  if (active.opportunityId) {
    const byOpportunity = threads.find((thread) => {
      const record = thread as unknown as Record<string, unknown>
      return record.opportunityId === active.opportunityId
        || record.opportunity_id === active.opportunityId
    })
    if (byOpportunity) return byOpportunity
  }
  if (active.propertyId) {
    const byProperty = threads.find((thread) => thread.propertyId === active.propertyId)
    if (byProperty) return byProperty
  }
  const ownerId = active.masterOwnerId || active.sellerId
  if (ownerId) {
    return threads.find((thread) => thread.ownerId === ownerId)
  }
  return undefined
}

export function dealContextFromActiveInbox(active: ActiveInboxContext): DealContext | null {
  if (!active.threadKey && !active.propertyId && !active.sellerId && !active.masterOwnerId && !active.opportunityId) {
    return null
  }
  const id = active.threadKey || active.opportunityId || active.propertyId || active.masterOwnerId || active.sellerId || 'context'
  return normalizeDealContext({
    id,
    deal_context_id: id,
    thread_key: active.threadKey,
    threadKey: active.threadKey,
    property_id: active.propertyId,
    propertyId: active.propertyId,
    master_owner_id: active.masterOwnerId || active.sellerId,
    masterOwnerId: active.masterOwnerId || active.sellerId,
    ownerId: active.masterOwnerId || active.sellerId,
    prospect_id: active.prospectId,
    prospectId: active.prospectId,
    property_address_full: active.propertyAddress,
    propertyAddress: active.propertyAddress,
    owner_name: active.sellerName,
    ownerName: active.sellerName,
    seller_display_name: active.sellerName,
    display_name: active.sellerName,
    market: active.market,
    market_name: active.market,
    opportunity_id: active.opportunityId,
  })
}

/** True when dealContext identity matches the selected thread — never blend mismatched properties. */
export function dealContextMatchesThread(
  thread: InboxWorkflowThread | null | undefined,
  dc: DealContext | null | undefined,
): boolean {
  if (!thread || !dc) return false
  const t = thread as unknown as Record<string, unknown>
  const threadKey = String(thread.threadKey || thread.id || '').trim()
  const conversationId = String(getConversationThreadIdForThread(thread) || threadKey).trim()
  const dcThreadKey = String(dc.threadKey || dc.thread_key || '').trim()
  if (dcThreadKey && (dcThreadKey === threadKey || dcThreadKey === conversationId)) return true

  const threadPropertyId = String(t.propertyId || t.property_id || '').trim()
  const dcPropertyId = String(dc.propertyId || dc.property_id || '').trim()
  if (threadPropertyId && dcPropertyId && threadPropertyId === dcPropertyId) return true

  // Same phone identity (canonical e164) is also a valid match when property is unknown.
  const threadPhone = String(
    t.canonicalE164 || t.canonical_e164 || t.bestPhone || t.sellerPhone || '',
  ).trim()
  const dcPhone = String(
    (dc as Record<string, unknown>).canonicalE164
    || (dc as Record<string, unknown>).canonical_e164
    || '',
  ).trim()
  if (threadPhone && dcPhone && threadPhone === dcPhone) return true

  // No conflicting identity → allow enrichment only when dealContext has no property and thread has none.
  if (!threadPropertyId && !dcPropertyId && !dcThreadKey) return true
  return false
}

export function mergeSelectedThreadAndDealContext(
  thread: InboxWorkflowThread,
  dc: DealContext | null,
): DealContext {
  const t = thread as unknown as Record<string, unknown>
  // Reject stale deal context from a previous thread/property (cross-thread contamination).
  const safeDc = dealContextMatchesThread(thread, dc) ? dc : null
  const base = safeDc ?? normalizeDealContext(t)

  const dcLat = isValidCoord(base.latitude) ? base.latitude : (isValidCoord(base.lat) ? base.lat : null)
  const dcLng = isValidCoord(base.longitude) ? base.longitude : (isValidCoord(base.lng) ? base.lng : null)
  const tLat = isValidCoord(t.lat) ? t.lat as number : (isValidCoord(t.latitude) ? t.latitude as number : null)
  const tLng = isValidCoord(t.lng) ? t.lng as number : (isValidCoord(t.longitude) ? t.longitude as number : null)
  // Prefer thread coords only when deal context is absent or matched; never keep foreign coords.
  const lat = (safeDc ? (dcLat ?? tLat) : tLat) ?? 0
  const lng = (safeDc ? (dcLng ?? tLng) : tLng) ?? 0

  // Selected thread identity always wins over deal-context enrichment for identity fields.
  const threadPropertyId = pickStr(t.property_id || t.propertyId, null)
  const threadOwnerId = pickStr(t.master_owner_id || t.ownerId || t.masterOwnerId, null)
  const threadProspectId = pickStr(t.prospect_id || t.prospectId, null)
  const threadKey = pickStr(t.threadKey || t.thread_key || thread.threadKey || thread.id, null)

  return {
    ...base,
    propertyId: threadPropertyId || pickStr(base.propertyId, null) || base.propertyId,
    property_id: threadPropertyId || pickStr(base.property_id, null) || base.property_id,
    masterOwnerId: threadOwnerId || pickStr(base.masterOwnerId, null) || base.masterOwnerId,
    master_owner_id: threadOwnerId || pickStr(base.master_owner_id, null) || base.master_owner_id,
    prospectId: threadProspectId || pickStr(base.prospectId, null) || base.prospectId,
    prospect_id: threadProspectId || pickStr(base.prospect_id, null) || base.prospect_id,
    // Display fields: prefer thread when present so UI never shows previous-record names/addresses.
    ownerName: pickStr(t.owner_name || t.ownerName, base.ownerName),
    owner_name: pickStr(t.owner_name || t.ownerName, base.owner_name),
    firstName: pickStr(t.seller_first_name || t.first_name, base.firstName),
    first_name: pickStr(t.first_name, base.first_name),
    propertyAddress: pickStr(t.property_address_full || t.propertyAddress || t.subject, base.propertyAddress),
    property_address_full: pickStr(t.property_address_full || t.propertyAddress, base.property_address_full),
    market: pickStr(t.market, base.market),
    market_name: pickStr(t.market || t.market_name, base.market_name),
    propertyState: pickStr(t.property_address_state || t.propertyState, base.propertyState),
    propertyZip: pickStr(t.property_address_zip || t.propertyZip, base.propertyZip),
    latitude: lat,
    longitude: lng,
    lat,
    lng,
    estimatedValue: pickNum(safeDc ? base.estimatedValue : null, t.estimated_value),
    estimated_value: pickNum(safeDc ? base.estimated_value : null, t.estimated_value),
    cashOffer: pickNum(safeDc ? base.cashOffer : null, t.cash_offer),
    cash_offer: pickNum(safeDc ? base.cash_offer : null, t.cash_offer),
    equityPercent: pickNum(safeDc ? base.equityPercent : null, t.equity_percent),
    equity_percent: pickNum(safeDc ? base.equity_percent : null, t.equity_percent),
    status: pickStr(t.universal_status || t.operational_status || t.inboxStatus, base.status),
    universal_status: pickStr(t.universal_status || t.operational_status, base.universal_status),
    stage: pickStr(t.universal_stage || t.lifecycle_stage || t.conversationStage, base.stage),
    universal_stage: pickStr(t.universal_stage || t.lifecycle_stage, base.universal_stage),
    bucket: pickStr(t.inbox_bucket || t.inboxBucket, base.bucket),
    inbox_bucket: pickStr(t.inbox_bucket || t.inboxBucket, base.inbox_bucket),
    latestMessageBody: pickStr(t.latest_message_body || t.latestMessageBody, base.latestMessageBody),
    latest_message_body: pickStr(t.latest_message_body || t.latestMessageBody, base.latest_message_body),
    latestMessageDirection: pickStr(t.latest_message_direction || t.latestDirection, base.latestMessageDirection),
    latest_message_direction: pickStr(t.latest_message_direction || t.latestDirection, base.latest_message_direction),
    threadKey: threadKey || base.threadKey,
    thread_key: threadKey || base.thread_key,
  }
}

export function resolveCanonicalWorkspaceContext(args: {
  selected: InboxWorkflowThread | null
  dealContext: DealContext | null
  activeContext: ActiveInboxContext
}): DealContext | null {
  const { selected, dealContext, activeContext } = args
  const activeFallback = dealContextFromActiveInbox(activeContext)

  if (selected) {
    // Never feed mismatched dealContext into the merge — selected thread is authority.
    const matchedDc = dealContextMatchesThread(selected, dealContext) ? dealContext : null
    const merged = mergeSelectedThreadAndDealContext(selected, matchedDc)
    if (!activeFallback || activeContextMatchesThread(activeContext, selected)) {
      return merged
    }
    // Active context only fills gaps; selected thread identity stays authoritative.
    return {
      ...merged,
      propertyId: pickStr(merged.propertyId, activeFallback.propertyId) || merged.propertyId,
      property_id: pickStr(merged.property_id, activeFallback.property_id) || merged.property_id,
      masterOwnerId: pickStr(merged.masterOwnerId, activeFallback.masterOwnerId) || merged.masterOwnerId,
      master_owner_id: pickStr(merged.master_owner_id, activeFallback.master_owner_id) || merged.master_owner_id,
      ownerName: pickStr(merged.ownerName, activeFallback.ownerName),
      owner_name: pickStr(merged.owner_name, activeFallback.owner_name),
      propertyAddress: pickStr(merged.propertyAddress, activeFallback.propertyAddress),
      property_address_full: pickStr(merged.property_address_full, activeFallback.property_address_full),
      market: pickStr(merged.market, activeFallback.market),
      market_name: pickStr(merged.market_name, activeFallback.market_name),
      threadKey: pickStr(merged.threadKey, activeFallback.threadKey),
      thread_key: pickStr(merged.thread_key, activeFallback.thread_key),
    }
  }

  if (activeFallback) {
    if (dealContext) {
      const activeThreadKey = String(activeContext.threadKey || '').trim()
      const activePropertyId = String(activeContext.propertyId || '').trim()
      const dcThreadKey = String(dealContext.threadKey || dealContext.thread_key || '').trim()
      const dcPropertyId = String(dealContext.propertyId || dealContext.property_id || '').trim()
      const identityMatches = Boolean(
        (activeThreadKey && dcThreadKey && activeThreadKey === dcThreadKey)
        || (activePropertyId && dcPropertyId && activePropertyId === dcPropertyId)
        || (!dcThreadKey && !dcPropertyId),
      )
      if (!identityMatches) return activeFallback
      return {
        ...dealContext,
        ...activeFallback,
        ownerName: pickStr(activeFallback.ownerName, dealContext.ownerName),
        owner_name: pickStr(activeFallback.owner_name, dealContext.owner_name),
        propertyAddress: pickStr(activeFallback.propertyAddress, dealContext.propertyAddress),
        property_address_full: pickStr(activeFallback.property_address_full, dealContext.property_address_full),
        market: pickStr(activeFallback.market, dealContext.market),
        threadKey: pickStr(activeFallback.threadKey, dealContext.threadKey),
        thread_key: pickStr(activeFallback.thread_key, dealContext.thread_key),
      }
    }
    return activeFallback
  }

  return dealContext
}

export function syncPayloadFromOpportunity(
  opportunity: PipelineOpportunity,
): { active: ActiveInboxContext; universal: UniversalEntityContext } {
  const active = buildContextFromOpportunity(opportunity, 'pipeline')
  return {
    active: {
      ...active,
      entityType: active.propertyId ? 'property' : active.masterOwnerId ? 'master_owner' : active.entityType,
      entityId: active.propertyId || active.masterOwnerId || active.opportunityId || active.entityId,
    },
    universal: universalContextFromOpportunity(opportunity),
  }
}

export function syncPayloadFromUniversal(
  universal: UniversalEntityContext,
  sourceView: ActiveInboxContext['sourceView'] = 'pipeline',
): ActiveInboxContext {
  return activeInboxFromUniversalContext(universal, sourceView)
}

/** Minimal inbox thread row for cross-app views when the inbox list has no matching row yet. */
export function threadStubFromActiveContext(
  active: ActiveInboxContext,
  dc: DealContext | null,
): InboxWorkflowThread | null {
  if (!active.threadKey && !active.propertyId && !active.sellerId && !active.masterOwnerId && !active.opportunityId) {
    return null
  }
  const id = active.threadKey || active.opportunityId || active.propertyId || active.masterOwnerId || active.sellerId || 'context'
  const address = active.propertyAddress || dc?.propertyAddress || dc?.property_address_full || ''
  const owner = active.sellerName || dc?.ownerName || dc?.owner_name || ''
  return {
    id,
    threadKey: active.threadKey || id,
    propertyId: active.propertyId || dc?.propertyId || dc?.property_id || undefined,
    ownerId: active.masterOwnerId || active.sellerId || dc?.masterOwnerId || dc?.master_owner_id || undefined,
    prospectId: active.prospectId || dc?.prospectId || dc?.prospect_id || undefined,
    market: active.market || dc?.market || dc?.market_name || undefined,
    ownerName: owner,
    propertyAddress: address,
    subject: address || owner || 'Selected opportunity',
    latestMessageBody: dc?.latestMessageBody || dc?.latest_message_body || '',
    universal_stage: dc?.universal_stage || dc?.stage || undefined,
    universal_status: dc?.universal_status || dc?.status || undefined,
    lat: dc?.lat || dc?.latitude || undefined,
    lng: dc?.lng || dc?.longitude || undefined,
  } as InboxWorkflowThread
}