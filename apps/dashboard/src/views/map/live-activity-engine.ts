import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { BuyerRecentPurchase } from '../../views/buyer-match/buyerCommandData'
import type { RecentSoldComp } from '../../lib/data/commandMapData'
import type {
  CommandMapActivityEvent,
  CommandMapActivityPinSource,
  CommandMapActivityPriority,
  CommandMapActivityType,
  CommandMapBounds,
  CommandMapLiveActivitySettings,
} from './commandMapLiveActivity'

export type LiveActivityScope = 'viewport' | 'selected' | 'market' | 'global'
export type LiveActivityChannel = 'live' | 'context'
export type LiveActivitySeverity = 'info' | 'success' | 'attention' | 'urgent' | 'blocked'

export type LiveActivityEvent = CommandMapActivityEvent & {
  channel: LiveActivityChannel
  severity: LiveActivitySeverity
  summary: string
  primaryAction: string
  secondaryAction: string | null
  occurredAt: string
  receivedAt: string
  source: string
  isUnread: boolean
  isPinned: boolean
  isAcknowledged: boolean
  rankScore: number
  isGlobalCritical: boolean
}

export type LiveActivityFeedSnapshot = {
  live: LiveActivityEvent[]
  context: LiveActivityEvent[]
  visible: LiveActivityEvent[]
  visibleCount: number
  globalCritical: LiveActivityEvent[]
  rankedForRotation: LiveActivityEvent[]
  /** Live-channel queue used by Minimal/Compact flip ticker */
  tickerQueue: LiveActivityEvent[]
  tickerCount: number
}

const LIVE_EVENT_TYPES = new Set<CommandMapActivityType>([
  'message_sent',
  'message_delivered',
  'message_failed',
  'queue_scheduled',
  'queue_ready',
  'queue_blocked',
  'queue_paused',
  'new_reply',
  'positive_reply',
  'hot_lead',
  'follow_up_due',
  'offer',
  'contract',
  'closing',
  'system_alert',
  'routing_block',
  'opt_out',
  'automation_block',
  'missing_message_event',
  'provider_id_missing',
])

const CONTEXT_EVENT_TYPES = new Set<CommandMapActivityType>([
  'sold_comp',
  'buyer_activity',
])

const GLOBAL_CRITICAL_TYPES = new Set<CommandMapActivityType>([
  'new_reply',
  'positive_reply',
  'hot_lead',
  'message_failed',
  'queue_blocked',
  'automation_block',
  'routing_block',
  'opt_out',
  'offer',
  'contract',
  'closing',
  'missing_message_event',
  'provider_id_missing',
  'system_alert',
])

const CONTEXT_AGE_DAYS = 30
const LIVE_STALE_DAYS = 14

const text = (value: unknown): string => String(value ?? '').trim()
const lower = (value: unknown): string => text(value).toLowerCase()
const isFiniteCoord = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const daysSince = (iso: string | null | undefined): number => {
  if (!iso) return Number.POSITIVE_INFINITY
  const target = new Date(iso).getTime()
  if (!Number.isFinite(target)) return Number.POSITIVE_INFINITY
  return (Date.now() - target) / 86400000
}

const formatRelative = (value: string | null | undefined): string => {
  if (!value) return 'Unknown'
  const target = new Date(value).getTime()
  if (!Number.isFinite(target)) return 'Unknown'
  const minutes = (Date.now() - target) / 60000
  if (Math.abs(minutes) < 1) return 'Now'
  if (Math.abs(minutes) < 60) return minutes < 0 ? `in ${Math.ceil(Math.abs(minutes))}m` : `${Math.floor(minutes)}m`
  if (Math.abs(minutes) < 1440) return minutes < 0 ? `in ${Math.ceil(Math.abs(minutes) / 60)}h` : `${Math.floor(minutes / 60)}h`
  return minutes < 0 ? `in ${Math.ceil(Math.abs(minutes) / 1440)}d` : `${Math.floor(minutes / 1440)}d`
}

const formatCompactCurrency = (value: number | null | undefined): string | undefined => {
  if (!Number.isFinite(value ?? NaN)) return undefined
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value as number)
}

export const isWithinBounds = (
  lat: number | undefined,
  lng: number | undefined,
  bounds?: CommandMapBounds | null,
): boolean => {
  if (!bounds) return true
  if (!isFiniteCoord(lat) || !isFiniteCoord(lng)) return false
  return lat >= bounds.south && lat <= bounds.north && lng >= bounds.west && lng <= bounds.east
}

const priorityToSeverity = (priority: CommandMapActivityPriority, type: CommandMapActivityType): LiveActivitySeverity => {
  if (type === 'message_delivered' || type === 'positive_reply' || type === 'closing') return 'success'
  if (type === 'message_failed' || type === 'queue_blocked' || type === 'opt_out' || type === 'routing_block' || type === 'missing_message_event' || type === 'provider_id_missing') return 'blocked'
  if (priority === 'critical' || type === 'hot_lead' || type === 'new_reply' || type === 'follow_up_due') return 'urgent'
  if (type === 'automation_block' || type === 'queue_paused' || type === 'system_alert') return 'attention'
  return 'info'
}

const resolvePrimaryAction = (event: CommandMapActivityEvent): string => {
  if (event.actionLabel) return event.actionLabel
  switch (event.type) {
    case 'new_reply':
    case 'positive_reply':
    case 'message_sent':
    case 'message_delivered':
    case 'message_failed':
      return 'Open Thread'
    case 'follow_up_due':
      return 'Follow Up'
    case 'opt_out':
      return 'Review Thread'
    case 'automation_block':
      return 'Review Block'
    case 'queue_blocked':
    case 'queue_paused':
    case 'missing_message_event':
    case 'provider_id_missing':
      return 'Open Queue'
    case 'routing_block':
      return 'Review Routing'
    case 'offer':
      return 'Open Offer'
    case 'contract':
      return 'Open Contract'
    case 'closing':
      return 'Open Closing'
    case 'buyer_activity':
      return 'Open Buyer'
    case 'sold_comp':
      return 'Open Comp'
    case 'hot_lead':
      return 'Open Deal'
    default:
      return 'Open'
  }
}

const resolveSecondaryAction = (event: CommandMapActivityEvent): string | null => {
  if (isFiniteCoord(event.lat) && isFiniteCoord(event.lng)) return 'Focus'
  return null
}

const computeRankScore = (event: LiveActivityEvent): number => {
  const typeRank: Partial<Record<CommandMapActivityType, number>> = {
    new_reply: 1000,
    positive_reply: 980,
    hot_lead: 960,
    follow_up_due: 900,
    offer: 880,
    contract: 860,
    closing: 850,
    queue_blocked: 840,
    automation_block: 830,
    routing_block: 820,
    message_failed: 810,
    opt_out: 420,
    queue_ready: 500,
    message_sent: 400,
    message_delivered: 380,
    queue_scheduled: 360,
    queue_paused: 350,
    missing_message_event: 920,
    provider_id_missing: 910,
    system_alert: 870,
    buyer_activity: 200,
    sold_comp: 100,
  }
  const priorityBoost: Record<CommandMapActivityPriority, number> = {
    critical: 80,
    hot: 60,
    normal: 20,
    info: 0,
    muted: -20,
  }
  const ageDays = daysSince(event.occurredAt)
  const recencyBoost = ageDays < 1 ? 50 : ageDays < 7 ? 30 : ageDays < 30 ? 10 : 0
  const unreadBoost = event.isUnread ? 40 : 0
  return (typeRank[event.type] ?? 300) + priorityBoost[event.priority] + recencyBoost + unreadBoost
}

export const enrichActivityEvent = (
  event: CommandMapActivityEvent,
  channel: LiveActivityChannel,
  source: string,
): LiveActivityEvent => {
  const occurredAt = event.createdAt || new Date().toISOString()
  const summary = event.detail || event.address || event.subtitle || ''
  const severity = priorityToSeverity(event.priority, event.type)
  const enriched: LiveActivityEvent = {
    ...event,
    channel,
    severity,
    summary,
    primaryAction: resolvePrimaryAction(event),
    secondaryAction: resolveSecondaryAction(event),
    occurredAt,
    receivedAt: new Date().toISOString(),
    source,
    isUnread: event.priority === 'hot' || event.priority === 'critical',
    isPinned: false,
    isAcknowledged: false,
    timeAgo: event.timeAgo || formatRelative(occurredAt),
    rankScore: 0,
    isGlobalCritical: GLOBAL_CRITICAL_TYPES.has(event.type) && daysSince(occurredAt) < LIVE_STALE_DAYS,
  }
  enriched.rankScore = computeRankScore(enriched)
  return enriched
}

const dedupeLiveEvents = (events: LiveActivityEvent[]): LiveActivityEvent[] => {
  const seen = new Map<string, LiveActivityEvent>()
  for (const event of events) {
    const threadKey = event.threadKey || event.targetId
    const key = threadKey ? `thread:${threadKey}` : `event:${event.id}`
    const existing = seen.get(key)
    if (!existing) {
      seen.set(key, event)
      continue
    }
    const existingRank = existing.rankScore
    const incomingRank = event.rankScore
    if (incomingRank > existingRank || new Date(event.occurredAt).getTime() > new Date(existing.occurredAt).getTime()) {
      seen.set(key, {
        ...event,
        id: threadKey ? `live-${threadKey}` : event.id,
      })
    }
  }
  return [...seen.values()]
}

export const filterByScope = (
  events: LiveActivityEvent[],
  scope: LiveActivityScope,
  bounds: CommandMapBounds | null | undefined,
  selectedPropertyId: string | null | undefined,
  selectedThreadKey: string | null | undefined,
  selectedMarket: string | null | undefined,
): LiveActivityEvent[] => {
  switch (scope) {
    case 'viewport':
      return events.filter((event) => isWithinBounds(event.lat, event.lng, bounds))
    case 'selected': {
      if (!selectedPropertyId && !selectedThreadKey) return events
      return events.filter((event) => {
        if (selectedPropertyId && event.propertyId === selectedPropertyId) return true
        if (selectedThreadKey && (event.threadKey === selectedThreadKey || event.targetId === selectedThreadKey)) return true
        if (selectedPropertyId && event.targetId === selectedPropertyId) return true
        return false
      })
    }
    case 'market':
      if (!selectedMarket) return events
      return events.filter((event) => {
        const market = lower(event.market || event.subtitle)
        return market.includes(lower(selectedMarket)) || lower(selectedMarket).includes(market)
      })
    case 'global':
    default:
      return events
  }
}

export const filterByChannel = (
  events: LiveActivityEvent[],
  channel: LiveActivityChannel,
): LiveActivityEvent[] => events.filter((event) => event.channel === channel)

export const applyEventFilters = (
  events: LiveActivityEvent[],
  settings: CommandMapLiveActivitySettings,
  selectedMarket: string | null | undefined,
): LiveActivityEvent[] => events
  .filter((event) => settings.eventTypes[event.type])
  .filter((event) => !settings.onlyHotCritical || event.priority === 'hot' || event.priority === 'critical')
  .filter((event) => {
    if (!settings.onlySelectedMarket || !selectedMarket) return true
    const market = event.market || event.subtitle
    return market === selectedMarket
  })

export const sortLiveActivityEvents = (events: LiveActivityEvent[]): LiveActivityEvent[] =>
  events.slice().sort((left, right) => {
    if (right.rankScore !== left.rankScore) return right.rankScore - left.rankScore
    return new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime()
  })

export type BuildLiveActivityFeedArgs = {
  pins: CommandMapActivityPinSource[]
  threadsById: Map<string, InboxWorkflowThread>
  buyerPurchases?: BuyerRecentPurchase[]
  soldComps?: RecentSoldComp[]
  settings: CommandMapLiveActivitySettings
  selectedMarket?: string | null
  bounds?: CommandMapBounds | null
  selectedThread?: InboxWorkflowThread | null
  selectedPropertyId?: string | null
  buildPinEvent: (pin: CommandMapActivityPinSource, thread: InboxWorkflowThread | null) => CommandMapActivityEvent | null
}

export const buildLiveActivityFeedSnapshot = ({
  pins,
  threadsById,
  buyerPurchases = [],
  soldComps = [],
  settings,
  selectedMarket,
  bounds,
  selectedThread,
  selectedPropertyId,
  buildPinEvent,
}: BuildLiveActivityFeedArgs): LiveActivityFeedSnapshot => {
  const scope: LiveActivityScope = settings.scope ?? 'viewport'
  const activeChannel: LiveActivityChannel = settings.activeChannel ?? 'live'
  const selectedThreadKey = text((selectedThread as any)?.threadKey || (selectedThread as any)?.id)

  const prioritizedPins = pins
    .slice()
    .sort((left, right) => {
      const lp = Number(left.priority_score ?? 0)
      const rp = Number(right.priority_score ?? 0)
      if (rp !== lp) return rp - lp
      const lHot = left.activity_state === 'hot' || left.activity_state === 'replied' || left.activity_state === 'needs_review' ? 1 : 0
      const rHot = right.activity_state === 'hot' || right.activity_state === 'replied' || right.activity_state === 'needs_review' ? 1 : 0
      if (rHot !== lHot) return rHot - lHot
      return new Date(right.last_activity_at || 0).getTime() - new Date(left.last_activity_at || 0).getTime()
    })
    .slice(0, 240)

  const pinEvents = prioritizedPins
    .map((pin) => buildPinEvent(pin, threadsById.get(pin.conversation_id) || null))
    .filter((event): event is CommandMapActivityEvent => Boolean(event))
    .filter((event) => daysSince(event.createdAt) <= LIVE_STALE_DAYS || event.priority === 'critical' || event.priority === 'hot')
    .map((event) => enrichActivityEvent(event, 'live', 'pin_pipeline'))

  const buyerEvents = buyerPurchases.slice(0, 12).map((purchase) => {
    const occurredAt = purchase.saleDate || new Date().toISOString()
    const isRecent = daysSince(occurredAt) <= CONTEXT_AGE_DAYS
    const channel: LiveActivityChannel = isRecent ? 'live' : 'context'
    const base = {
      id: `buyer-${purchase.buyerKey}-${purchase.propertyId}-${occurredAt}`,
      type: 'buyer_activity' as const,
      priority: isRecent ? 'hot' as const : 'info' as const,
      title: purchase.buyerName || 'Buyer Activity',
      subtitle: purchase.market || 'Market Unknown',
      address: purchase.propertyAddressFull || 'Property Unknown',
      detail: `Purchase${purchase.saleDate ? ` • ${formatRelative(purchase.saleDate)}` : ''}`,
      market: purchase.market || undefined,
      createdAt: occurredAt,
      lat: purchase.latitude,
      lng: purchase.longitude,
      targetType: 'buyer' as const,
      targetId: purchase.buyerKey,
      propertyId: purchase.propertyId,
      actionLabel: 'Open Buyer',
      badgeLabel: channel === 'context' ? 'CONTEXT' : 'Buyer Activity',
      valueLabel: formatCompactCurrency(purchase.salePrice ?? null),
      scoreLabel: Number.isFinite(purchase.investorFitScore ?? NaN) ? `Fit ${Math.round(purchase.investorFitScore as number)}` : undefined,
    }
    return enrichActivityEvent(base, channel, 'buyer_purchases')
  })

  const subjectLat = Number((selectedThread as any)?.lat ?? (selectedThread as any)?.latitude ?? NaN)
  const subjectLng = Number((selectedThread as any)?.lng ?? (selectedThread as any)?.longitude ?? NaN)

  const soldCompEvents = soldComps.slice(0, 12).map((comp) => {
    const occurredAt = comp.sale_date || comp.mls_sold_date || new Date().toISOString()
    const distance =
      Number.isFinite(subjectLat) && Number.isFinite(subjectLng)
        ? haversineMiles(subjectLat, subjectLng, comp.latitude, comp.longitude)
        : null
    const base = {
      id: `sold-comp-${comp.property_id}-${occurredAt}`,
      type: 'sold_comp' as const,
      priority: 'info' as const,
      title: comp.property_address_full || 'Sold Comp',
      subtitle: `${comp.property_address_city || ''}${comp.property_address_state ? `, ${comp.property_address_state}` : ''}`.trim() || 'Market Unknown',
      address: comp.property_address_full || 'Property Unknown',
      detail: distance != null
        ? `${distance.toFixed(distance < 1 ? 2 : 1)} mi from selected property`
        : (comp.sale_source || 'Sold comp intelligence'),
      market: `${comp.property_address_city || ''}${comp.property_address_state ? `, ${comp.property_address_state}` : ''}`.trim() || undefined,
      createdAt: occurredAt,
      lat: comp.latitude,
      lng: comp.longitude,
      targetType: 'sold_comp' as const,
      targetId: String(comp.property_id),
      propertyId: String(comp.property_id),
      actionLabel: 'Open Comp',
      badgeLabel: 'CONTEXT',
      valueLabel: formatCompactCurrency(comp.sale_price ?? comp.mls_sold_price ?? null),
      scoreLabel: Number.isFinite(comp.comp_confidence_score ?? NaN) ? `Conf ${Math.round(comp.comp_confidence_score as number)}` : undefined,
    }
    return enrichActivityEvent(base, 'context', 'sold_comps')
  })

  const allLive = sortLiveActivityEvents(dedupeLiveEvents([
    ...pinEvents,
    ...buyerEvents.filter((event) => event.channel === 'live'),
  ]))

  const allContext = sortLiveActivityEvents([
    ...soldCompEvents,
    ...buyerEvents.filter((event) => event.channel === 'context'),
  ])

  const globalCritical = allLive.filter((event) => event.isGlobalCritical)

  const scopedLive = filterByScope(allLive, scope, bounds, selectedPropertyId, selectedThreadKey, selectedMarket)
  const scopedContext = filterByScope(allContext, scope, bounds, selectedPropertyId, selectedThreadKey, selectedMarket)

  const filteredLive = applyEventFilters(scopedLive, settings, selectedMarket)
  const filteredContext = applyEventFilters(scopedContext, settings, selectedMarket)

  const channelEvents = activeChannel === 'live' ? filteredLive : filteredContext
  const visible = sortLiveActivityEvents(channelEvents).slice(0, Math.min(100, Math.max(8, settings.maxCardsVisible)))

  const rotationPool = activeChannel === 'live'
    ? sortLiveActivityEvents(filteredLive)
    : sortLiveActivityEvents(filteredContext)

  const tickerQueue = sortLiveActivityEvents(filteredLive).slice(0, Math.min(50, settings.maxCardsVisible))

  return {
    live: allLive,
    context: allContext,
    visible,
    visibleCount: visible.length,
    globalCritical,
    rankedForRotation: rotationPool.slice(0, Math.min(50, settings.maxCardsVisible)),
    tickerQueue,
    tickerCount: tickerQueue.length,
  }
}

const haversineMiles = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const toRadians = (value: number) => (value * Math.PI) / 180
  const earthRadiusMiles = 3958.8
  const dLat = toRadians(lat2 - lat1)
  const dLng = toRadians(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export const isLiveEventType = (type: CommandMapActivityType): boolean => LIVE_EVENT_TYPES.has(type)
export const isContextEventType = (type: CommandMapActivityType): boolean => CONTEXT_EVENT_TYPES.has(type)