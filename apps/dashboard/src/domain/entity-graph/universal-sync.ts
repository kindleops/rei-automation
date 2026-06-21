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

export function findThreadForActiveContext(
  threads: InboxWorkflowThread[],
  active: ActiveInboxContext,
): InboxWorkflowThread | undefined {
  if (active.threadKey) {
    const byKey = findThreadByRef(threads, active.threadKey)
    if (byKey) return byKey
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

export function mergeSelectedThreadAndDealContext(
  thread: InboxWorkflowThread,
  dc: DealContext | null,
): DealContext {
  const t = thread as unknown as Record<string, unknown>
  const base = dc ?? normalizeDealContext(t)

  const dcLat = isValidCoord(base.latitude) ? base.latitude : (isValidCoord(base.lat) ? base.lat : null)
  const dcLng = isValidCoord(base.longitude) ? base.longitude : (isValidCoord(base.lng) ? base.lng : null)
  const tLat = isValidCoord(t.lat) ? t.lat as number : (isValidCoord(t.latitude) ? t.latitude as number : null)
  const tLng = isValidCoord(t.lng) ? t.lng as number : (isValidCoord(t.longitude) ? t.longitude as number : null)
  const lat = dcLat ?? tLat ?? 0
  const lng = dcLng ?? tLng ?? 0

  return {
    ...base,
    propertyId: pickStr(base.propertyId, t.property_id || t.propertyId) || base.propertyId,
    property_id: pickStr(base.property_id, t.property_id) || base.property_id,
    masterOwnerId: pickStr(base.masterOwnerId, t.master_owner_id || t.ownerId) || base.masterOwnerId,
    master_owner_id: pickStr(base.master_owner_id, t.master_owner_id) || base.master_owner_id,
    prospectId: pickStr(base.prospectId, t.prospect_id || t.prospectId) || base.prospectId,
    prospect_id: pickStr(base.prospect_id, t.prospect_id) || base.prospect_id,
    ownerName: pickStr(base.ownerName, t.owner_name || t.ownerName),
    owner_name: pickStr(base.owner_name, t.owner_name || t.ownerName),
    firstName: pickStr(base.firstName, t.seller_first_name || t.first_name),
    first_name: pickStr(base.first_name, t.first_name),
    propertyAddress: pickStr(base.propertyAddress, t.property_address_full || t.propertyAddress || t.subject),
    property_address_full: pickStr(base.property_address_full, t.property_address_full || t.propertyAddress),
    market: pickStr(base.market, t.market),
    market_name: pickStr(base.market_name, t.market || t.market_name),
    propertyState: pickStr(base.propertyState, t.property_address_state || t.propertyState),
    propertyZip: pickStr(base.propertyZip, t.property_address_zip || t.propertyZip),
    latitude: lat,
    longitude: lng,
    lat,
    lng,
    estimatedValue: pickNum(base.estimatedValue, t.estimated_value),
    estimated_value: pickNum(base.estimated_value, t.estimated_value),
    cashOffer: pickNum(base.cashOffer, t.cash_offer),
    cash_offer: pickNum(base.cash_offer, t.cash_offer),
    equityPercent: pickNum(base.equityPercent, t.equity_percent),
    equity_percent: pickNum(base.equity_percent, t.equity_percent),
    status: pickStr(base.status, t.universal_status),
    universal_status: pickStr(base.universal_status, t.universal_status),
    stage: pickStr(base.stage, t.universal_stage),
    universal_stage: pickStr(base.universal_stage, t.universal_stage),
    bucket: pickStr(base.bucket, t.inbox_bucket),
    inbox_bucket: pickStr(base.inbox_bucket, t.inbox_bucket),
    latestMessageBody: pickStr(base.latestMessageBody, t.latest_message_body || t.latestMessageBody),
    latest_message_body: pickStr(base.latest_message_body, t.latest_message_body),
    latestMessageDirection: pickStr(base.latestMessageDirection, t.latest_message_direction),
    latest_message_direction: pickStr(base.latest_message_direction, t.latest_message_direction),
    threadKey: pickStr(base.threadKey, t.threadKey || t.thread_key || thread.threadKey || thread.id),
    thread_key: pickStr(base.thread_key, t.thread_key || thread.threadKey || thread.id),
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
    const merged = mergeSelectedThreadAndDealContext(selected, dealContext)
    if (!activeFallback || activeContextMatchesThread(activeContext, selected)) {
      return merged
    }
    return {
      ...merged,
      ...activeFallback,
      propertyId: pickStr(activeFallback.propertyId, merged.propertyId) || merged.propertyId,
      property_id: pickStr(activeFallback.property_id, merged.property_id) || merged.property_id,
      masterOwnerId: pickStr(activeFallback.masterOwnerId, merged.masterOwnerId) || merged.masterOwnerId,
      master_owner_id: pickStr(activeFallback.master_owner_id, merged.master_owner_id) || merged.master_owner_id,
      ownerName: pickStr(activeFallback.ownerName, merged.ownerName),
      owner_name: pickStr(activeFallback.owner_name, merged.owner_name),
      propertyAddress: pickStr(activeFallback.propertyAddress, merged.propertyAddress),
      property_address_full: pickStr(activeFallback.property_address_full, merged.property_address_full),
      market: pickStr(activeFallback.market, merged.market),
      market_name: pickStr(activeFallback.market_name, merged.market_name),
      threadKey: pickStr(activeFallback.threadKey, merged.threadKey),
      thread_key: pickStr(activeFallback.thread_key, merged.thread_key),
    }
  }

  if (activeFallback) {
    if (dealContext) {
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