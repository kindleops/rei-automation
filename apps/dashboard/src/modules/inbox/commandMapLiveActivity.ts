import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { BuyerRecentPurchase } from '../../views/buyer-match/buyerCommandData'
import type { RecentSoldComp } from '../../lib/data/commandMapData'

export type CommandMapActivityType =
  | 'message_sent'
  | 'message_delivered'
  | 'message_failed'
  | 'queue_scheduled'
  | 'queue_ready'
  | 'queue_blocked'
  | 'queue_paused'
  | 'new_reply'
  | 'positive_reply'
  | 'hot_lead'
  | 'follow_up_due'
  | 'offer'
  | 'contract'
  | 'closing'
  | 'buyer_activity'
  | 'sold_comp'
  | 'system_alert'
  | 'routing_block'
  | 'opt_out'
  | 'automation_block'
  | 'missing_message_event'
  | 'provider_id_missing'

export type CommandMapActivityPriority = 'critical' | 'hot' | 'normal' | 'info' | 'muted'

export type CommandMapActivityTargetType = 'seller' | 'buyer' | 'sold_comp' | 'system'
export type LiveActivityDisplayMode = 'minimal' | 'compact' | 'expanded' | 'docked' | 'hidden'
export type LiveActivitySpeed = 'paused' | 'slow' | 'normal' | 'fast'

export type CommandMapActivityEvent = {
  id: string
  type: CommandMapActivityType
  priority: CommandMapActivityPriority
  title: string
  subtitle?: string
  detail?: string
  market?: string
  address?: string
  valueLabel?: string
  scoreLabel?: string
  timeAgo?: string
  createdAt?: string
  lat?: number
  lng?: number
  targetType?: CommandMapActivityTargetType
  targetId?: string
  propertyId?: string
  masterOwnerId?: string
  prospectId?: string
  threadKey?: string
  queueId?: string
  messageEventId?: string
  targetView?: 'thread' | 'queue' | 'calendar' | 'map' | 'deal'
  actionLabel?: string
  badgeLabel?: string
  accentTone?: string
  pinUntil?: string
}

export type LiveActivityEventTypeFilters = Record<CommandMapActivityType, boolean>

export type CommandMapLiveActivitySettings = {
  visible: boolean
  displayMode: LiveActivityDisplayMode
  speed: LiveActivitySpeed
  pauseOnHover: boolean
  onlyCurrentBounds: boolean
  onlySelectedMarket: boolean
  onlyHotCritical: boolean
  maxCardsVisible: number
  autoScroll: boolean
  eventTypes: LiveActivityEventTypeFilters
  pinHotEvents: boolean
  autoPinCriticalSeconds: number
  subtleSpeedVariance: boolean
}

export type CommandMapPerformanceMode = 'auto' | 'quality' | 'balanced' | 'speed'
export type CommandMapMarkerDensity = 'low' | 'medium' | 'high'
export type CommandMapAnimationMode = 'full' | 'reduced' | 'off'
export type CommandMapClusterAggressiveness = 'low' | 'medium' | 'high'

export type CommandMapPerformanceSettings = {
  performanceMode: CommandMapPerformanceMode
  markerDensity: CommandMapMarkerDensity
  animation: CommandMapAnimationMode
  liveActivityMode: LiveActivityDisplayMode
  showHeatEffects: boolean
  clusterAggressiveness: CommandMapClusterAggressiveness
}

export type CommandMapBounds = {
  west: number
  south: number
  east: number
  north: number
}

export type CommandMapActivityPinSource = {
  conversation_id: string
  seller_name: string
  address: string
  city: string
  state: string
  market: string
  lat: number
  lng: number
  priority_score: number
  conversation_stage: string
  conversation_status: string
  next_action: string
  next_follow_up_at: string | null
  last_activity_at: string
  last_message: string
  last_inbound_at: string | null
  last_outbound_at: string | null
  unread: boolean
  offer_status: string
  contract_status: string
  suppression_status: string
  automation_status: string
  queue_status: string | null
  delivery_status?: string | null
  latest_message_body: string | null
  activity_state: string
  property_address_full?: string | null
  property_address_city?: string | null
  property_address_state?: string | null
  owner_name?: string | null
  owner_display_name?: string | null
  motivation_score?: number | null
  final_acquisition_score?: number | null
}

export const LIVE_ACTIVITY_SETTINGS_STORAGE_KEY = 'nexus.commandMap.liveActivitySettings'
export const PERFORMANCE_SETTINGS_STORAGE_KEY = 'nexus.commandMap.performanceSettings'

const DEFAULT_EVENT_FILTERS: LiveActivityEventTypeFilters = {
  message_sent: true,
  message_delivered: true,
  message_failed: true,
  queue_scheduled: true,
  queue_ready: true,
  queue_blocked: true,
  queue_paused: true,
  new_reply: true,
  positive_reply: true,
  hot_lead: true,
  follow_up_due: true,
  offer: true,
  contract: true,
  closing: true,
  buyer_activity: true,
  sold_comp: true,
  system_alert: true,
  routing_block: true,
  opt_out: true,
  automation_block: true,
  missing_message_event: true,
  provider_id_missing: true,
}

const text = (value: unknown): string => String(value ?? '').trim()
const lower = (value: unknown): string => text(value).toLowerCase()

const isFiniteCoord = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const formatRelative = (value: string | null | undefined): string => {
  if (!value) return 'Unknown'
  const target = new Date(value).getTime()
  if (!Number.isFinite(target)) return 'Unknown'
  const minutes = (Date.now() - target) / 60000
  if (Math.abs(minutes) < 1) return 'Just now'
  if (Math.abs(minutes) < 60) return minutes < 0 ? `in ${Math.ceil(Math.abs(minutes))}m` : `${Math.floor(minutes)}m ago`
  if (Math.abs(minutes) < 1440) return minutes < 0 ? `in ${Math.ceil(Math.abs(minutes) / 60)}h` : `${Math.floor(minutes / 60)}h ago`
  return minutes < 0 ? `in ${Math.ceil(Math.abs(minutes) / 1440)}d` : `${Math.floor(minutes / 1440)}d ago`
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

const resolveSellerName = (thread: InboxWorkflowThread | null, pin: CommandMapActivityPinSource): string =>
  [
    text((thread as any)?.owner_display_name),
    text((thread as any)?.owner_name),
    text((thread as any)?.prospect_name),
    text((thread as any)?.contact_name),
    text(pin.owner_display_name),
    text(pin.owner_name),
    text(pin.seller_name),
  ].find((value) => value && lower(value) !== 'unknown seller') || 'Unknown Seller'

const resolveAddress = (thread: InboxWorkflowThread | null, pin: CommandMapActivityPinSource): string =>
  [
    text((thread as any)?.property_address_full),
    text((thread as any)?.property_address),
    text((thread as any)?.address),
    text((thread as any)?.situs_address),
    text(pin.property_address_full),
    text(pin.address),
  ].find(Boolean) || 'Property Unknown'

const resolveMarket = (thread: InboxWorkflowThread | null, pin: CommandMapActivityPinSource): string =>
  [
    text((thread as any)?.market),
    [text((thread as any)?.property_address_city || pin.property_address_city || pin.city), text((thread as any)?.property_address_state || pin.property_address_state || pin.state)].filter(Boolean).join(', '),
    text(pin.market),
  ].find(Boolean) || 'Market Unknown'

const isWithinBounds = (lat: number | undefined, lng: number | undefined, bounds?: CommandMapBounds | null): boolean => {
  if (!bounds) return true
  if (!isFiniteCoord(lat) || !isFiniteCoord(lng)) return false
  return lat >= bounds.south && lat <= bounds.north && lng >= bounds.west && lng <= bounds.east
}

export const getActivityPriority = (event: Pick<CommandMapActivityEvent, 'type' | 'createdAt'>): CommandMapActivityPriority => {
  if (event.type === 'contract' || event.type === 'closing' || event.type === 'routing_block' || event.type === 'opt_out' || event.type === 'automation_block' || event.type === 'system_alert' || event.type === 'message_failed' || event.type === 'queue_blocked' || event.type === 'missing_message_event' || event.type === 'provider_id_missing') {
    return 'critical'
  }
  if (event.type === 'new_reply' || event.type === 'positive_reply' || event.type === 'hot_lead' || event.type === 'offer' || event.type === 'follow_up_due' || event.type === 'queue_ready') {
    return 'hot'
  }
  if (event.type === 'buyer_activity' || event.type === 'sold_comp') return 'info'
  return 'normal'
}

export const getActivityVisualType = (event: Pick<CommandMapActivityEvent, 'type' | 'priority'>): string => {
  if (event.type === 'message_sent') return 'blue'
  if (event.type === 'message_delivered') return 'green'
  if (event.type === 'message_failed') return 'red'
  if (event.type === 'queue_scheduled') return 'blue'
  if (event.type === 'queue_ready') return 'cyan'
  if (event.type === 'queue_blocked' || event.type === 'queue_paused') return 'red'
  if (event.type === 'new_reply') return 'cyan'
  if (event.type === 'positive_reply') return 'green'
  if (event.type === 'hot_lead') return 'amber'
  if (event.type === 'offer') return 'emerald'
  if (event.type === 'contract') return 'violet'
  if (event.type === 'closing') return 'gold'
  if (event.type === 'buyer_activity') return 'indigo'
  if (event.type === 'sold_comp') return 'red'
  if (event.priority === 'critical') return 'red'
  return 'slate'
}

export const getActivityTarget = (event: CommandMapActivityEvent) => ({
  targetType: event.targetType,
  targetId: event.targetId,
  lat: event.lat,
  lng: event.lng,
})

export const centerMapOnActivity = (event: CommandMapActivityEvent): [number, number] | null =>
  isFiniteCoord(event.lng) && isFiniteCoord(event.lat) ? [event.lng, event.lat] : null

export const loadLiveActivitySettings = (isUltrawide = false): CommandMapLiveActivitySettings => {
  const defaults: CommandMapLiveActivitySettings = {
    visible: true,
    displayMode: isUltrawide ? 'compact' : 'minimal',
    speed: 'normal',
    pauseOnHover: true,
    onlyCurrentBounds: false,
    onlySelectedMarket: false,
    onlyHotCritical: false,
    maxCardsVisible: isUltrawide ? 28 : 18,
    autoScroll: true,
    eventTypes: { ...DEFAULT_EVENT_FILTERS },
    pinHotEvents: true,
    autoPinCriticalSeconds: 22,
    subtleSpeedVariance: true,
  }
  if (typeof window === 'undefined') return defaults
  try {
    const raw = window.localStorage.getItem(LIVE_ACTIVITY_SETTINGS_STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<CommandMapLiveActivitySettings>
    return {
      ...defaults,
      ...parsed,
      eventTypes: {
        ...DEFAULT_EVENT_FILTERS,
        ...(parsed.eventTypes ?? {}),
      },
    }
  } catch {
    return defaults
  }
}

export const persistLiveActivitySettings = (settings: CommandMapLiveActivitySettings): void => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(LIVE_ACTIVITY_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
}

export const loadPerformanceSettings = (isUltrawide = false): CommandMapPerformanceSettings => {
  const defaults: CommandMapPerformanceSettings = {
    performanceMode: isUltrawide ? 'balanced' : 'quality',
    markerDensity: isUltrawide ? 'medium' : 'high',
    animation: isUltrawide ? 'reduced' : 'full',
    liveActivityMode: isUltrawide ? 'compact' : 'minimal',
    showHeatEffects: !isUltrawide,
    clusterAggressiveness: isUltrawide ? 'high' : 'medium',
  }
  if (typeof window === 'undefined') return defaults
  try {
    const raw = window.localStorage.getItem(PERFORMANCE_SETTINGS_STORAGE_KEY)
    if (!raw) return defaults
    return { ...defaults, ...(JSON.parse(raw) as Partial<CommandMapPerformanceSettings>) }
  } catch {
    return defaults
  }
}

export const persistPerformanceSettings = (settings: CommandMapPerformanceSettings): void => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PERFORMANCE_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
}

const normalizeLiveActivityEvent = (event: CommandMapActivityEvent): CommandMapActivityEvent => {
  const priority = event.priority || getActivityPriority(event)
  const createdAt = event.createdAt || new Date().toISOString()
  const badgeLabel = event.badgeLabel || event.type.replace(/_/g, ' ').toUpperCase()
  return {
    ...event,
    priority,
    createdAt,
    badgeLabel,
    accentTone: event.accentTone || getActivityVisualType({ type: event.type, priority }),
    timeAgo: event.timeAgo || formatRelative(createdAt),
  }
}

const maybeBuildPinEvent = (
  pin: CommandMapActivityPinSource,
  thread: InboxWorkflowThread | null,
): CommandMapActivityEvent | null => {
  const sellerName = resolveSellerName(thread, pin)
  const address = resolveAddress(thread, pin)
  const market = resolveMarket(thread, pin)
  const lastIntent = lower((thread as any)?.last_intent || (thread as any)?.lastIntent || '')
  const latestMessage = text((thread as any)?.latest_message_body || (thread as any)?.latestMessageBody || pin.latest_message_body || pin.last_message)
  const stage = lower(pin.conversation_stage)
  const status = lower(pin.conversation_status)
  const queueStatus = lower(pin.queue_status)
  const deliveryStatus = lower((thread as any)?.deliveryStatus || (thread as any)?.delivery_status || pin.delivery_status)
  const automation = lower(pin.automation_status)
  const suppression = lower(pin.suppression_status)
  const createdAt = pin.last_inbound_at || pin.next_follow_up_at || pin.last_activity_at
  const baseContext = {
    propertyId: text((thread as any)?.propertyId),
    masterOwnerId: text((thread as any)?.ownerId),
    prospectId: text((thread as any)?.prospectId),
    threadKey: text((thread as any)?.threadKey || (thread as any)?.id || pin.conversation_id),
    queueId: text((thread as any)?.queueId),
    messageEventId: text((thread as any)?.latestMessageEventId),
  }

  if (queueStatus === 'sent' && !(thread as any)?.latestMessageEventId && !(thread as any)?.message_event_id) {
    return normalizeLiveActivityEvent({
      id: `missing-event-${pin.conversation_id}-${createdAt}`,
      type: 'missing_message_event',
      priority: 'critical',
      title: sellerName,
      subtitle: market,
      address,
      detail: 'Sent queue row missing message event.',
      createdAt,
      lat: pin.lat,
      lng: pin.lng,
      targetType: 'seller',
      targetId: pin.conversation_id,
      targetView: 'queue',
      actionLabel: 'Open Queue',
      badgeLabel: 'Missing Event',
      ...baseContext,
    })
  }

  if (queueStatus === 'sent' && !(thread as any)?.providerMessageSid && !(thread as any)?.provider_message_sid) {
    return normalizeLiveActivityEvent({
      id: `provider-missing-${pin.conversation_id}-${createdAt}`,
      type: 'provider_id_missing',
      priority: 'critical',
      title: sellerName,
      subtitle: market,
      address,
      detail: 'Sent queue row missing provider ID.',
      createdAt,
      lat: pin.lat,
      lng: pin.lng,
      targetType: 'seller',
      targetId: pin.conversation_id,
      targetView: 'queue',
      actionLabel: 'Open Queue',
      badgeLabel: 'Provider Missing',
      ...baseContext,
    })
  }

  if (queueStatus.includes('blocked') || pin.activity_state === 'queue_blocked') {
    return normalizeLiveActivityEvent({
      id: `routing-${pin.conversation_id}-${createdAt}`,
      type: 'queue_blocked',
      priority: 'critical',
      title: sellerName,
      subtitle: market,
      address,
      detail: pin.next_action || pin.queue_status || 'Routing is blocked.',
      createdAt,
      lat: pin.lat,
      lng: pin.lng,
      targetType: 'seller',
      targetId: pin.conversation_id,
      targetView: 'queue',
      actionLabel: 'Open Thread',
      badgeLabel: 'Routing Block',
      scoreLabel: pin.queue_status || undefined,
      ...baseContext,
    })
  }

  if (queueStatus.includes('paused')) {
    return normalizeLiveActivityEvent({
      id: `queue-paused-${pin.conversation_id}-${createdAt}`,
      type: 'queue_paused',
      priority: 'critical',
      title: sellerName,
      subtitle: market,
      address,
      detail: pin.next_action || pin.queue_status || 'Queue row is paused.',
      createdAt,
      lat: pin.lat,
      lng: pin.lng,
      targetType: 'seller',
      targetId: pin.conversation_id,
      targetView: 'queue',
      actionLabel: 'Open Queue',
      badgeLabel: 'Queue Paused',
      ...baseContext,
    })
  }

  if (queueStatus === 'scheduled' || queueStatus === 'queued') {
    return normalizeLiveActivityEvent({
      id: `queue-scheduled-${pin.conversation_id}-${createdAt}`,
      type: 'queue_scheduled',
      priority: 'normal',
      title: sellerName,
      subtitle: market,
      address,
      detail: pin.next_action || latestMessage || 'Scheduled queue activity is waiting to send.',
      createdAt,
      lat: pin.lat,
      lng: pin.lng,
      targetType: 'seller',
      targetId: pin.conversation_id,
      targetView: 'queue',
      actionLabel: 'Open Queue',
      badgeLabel: 'Queue Scheduled',
      ...baseContext,
    })
  }

  if (queueStatus === 'ready' || queueStatus === 'sending') {
    return normalizeLiveActivityEvent({
      id: `queue-ready-${pin.conversation_id}-${createdAt}`,
      type: 'queue_ready',
      priority: queueStatus === 'sending' ? 'hot' : 'normal',
      title: sellerName,
      subtitle: market,
      address,
      detail: pin.next_action || 'Queue row is ready to send.',
      createdAt,
      lat: pin.lat,
      lng: pin.lng,
      targetType: 'seller',
      targetId: pin.conversation_id,
      targetView: 'queue',
      actionLabel: 'Open Queue',
      badgeLabel: queueStatus === 'sending' ? 'Sending' : 'Queue Ready',
      ...baseContext,
    })
  }

  if (queueStatus === 'sent') {
    return normalizeLiveActivityEvent({
      id: `message-sent-${pin.conversation_id}-${createdAt}`,
      type: 'message_sent',
      priority: 'normal',
      title: sellerName,
      subtitle: market,
      address,
      detail: latestMessage || 'Outbound message sent.',
      createdAt: pin.last_outbound_at || createdAt,
      lat: pin.lat,
      lng: pin.lng,
      targetType: 'seller',
      targetId: pin.conversation_id,
      targetView: 'thread',
      actionLabel: 'Open Thread',
      badgeLabel: 'Message Sent',
      ...baseContext,
    })
  }

  if (queueStatus === 'delivered' || deliveryStatus === 'delivered') {
    return normalizeLiveActivityEvent({
      id: `message-delivered-${pin.conversation_id}-${createdAt}`,
      type: 'message_delivered',
      priority: 'normal',
      title: sellerName,
      subtitle: market,
      address,
      detail: latestMessage || 'Outbound message delivered.',
      createdAt: pin.last_outbound_at || createdAt,
      lat: pin.lat,
      lng: pin.lng,
      targetType: 'seller',
      targetId: pin.conversation_id,
      targetView: 'thread',
      actionLabel: 'Open Thread',
      badgeLabel: 'Delivered',
      ...baseContext,
    })
  }

  if (queueStatus === 'failed' || deliveryStatus === 'failed') {
    return normalizeLiveActivityEvent({
      id: `message-failed-${pin.conversation_id}-${createdAt}`,
      type: 'message_failed',
      priority: 'critical',
      title: sellerName,
      subtitle: market,
      address,
      detail: latestMessage || 'Outbound message failed.',
      createdAt,
      lat: pin.lat,
      lng: pin.lng,
      targetType: 'seller',
      targetId: pin.conversation_id,
      targetView: 'queue',
      actionLabel: 'Open Queue',
      badgeLabel: 'Failed',
      ...baseContext,
    })
  }

  if (suppression && suppression !== 'clear') {
    return normalizeLiveActivityEvent({
      id: `opt-out-${pin.conversation_id}-${createdAt}`,
      type: 'opt_out',
      priority: 'critical',
      title: sellerName,
      subtitle: market,
      address,
      detail: latestMessage || pin.next_action || 'Suppression or opt-out detected.',
      createdAt,
      lat: pin.lat,
      lng: pin.lng,
      targetType: 'seller',
      targetId: pin.conversation_id,
      actionLabel: 'Review',
      badgeLabel: 'DNC / Opt-Out',
    })
  }

  if (automation.includes('blocked') || automation.includes('paused') || automation.includes('error')) {
    return normalizeLiveActivityEvent({
      id: `automation-${pin.conversation_id}-${createdAt}`,
      type: 'automation_block',
      priority: 'critical',
      title: sellerName,
      subtitle: market,
      address,
      detail: pin.next_action || pin.automation_status || 'Automation requires attention.',
      createdAt,
      lat: pin.lat,
      lng: pin.lng,
      targetType: 'seller',
      targetId: pin.conversation_id,
      actionLabel: 'Inspect',
      badgeLabel: 'Automation Block',
    })
  }

  if (lower(pin.contract_status).includes('active') || stage.includes('contract') || stage.includes('closing')) {
    return normalizeLiveActivityEvent({
      id: `contract-${pin.conversation_id}-${createdAt}`,
      type: stage.includes('closing') ? 'closing' : 'contract',
      priority: stage.includes('closing') ? 'critical' : 'critical',
      title: sellerName,
      subtitle: market,
      address,
      detail: pin.next_action || pin.conversation_stage || 'Contract motion is active.',
      createdAt,
      lat: pin.lat,
      lng: pin.lng,
      targetType: 'seller',
      targetId: pin.conversation_id,
      actionLabel: 'Open Deal',
      badgeLabel: stage.includes('closing') ? 'Closing' : 'Contract',
    })
  }

  if (lower(pin.offer_status).includes('ready') || lower(pin.offer_status).includes('sent') || stage.includes('offer') || status.includes('offer')) {
    return normalizeLiveActivityEvent({
      id: `offer-${pin.conversation_id}-${createdAt}`,
      type: 'offer',
      priority: 'hot',
      title: sellerName,
      subtitle: market,
      address,
      detail: pin.next_action || 'Offer activity is ready for review.',
      createdAt,
      lat: pin.lat,
      lng: pin.lng,
      targetType: 'seller',
      targetId: pin.conversation_id,
      actionLabel: 'Open Deal',
      badgeLabel: 'Offer',
    })
  }

  if (pin.activity_state === 'due_now' || pin.activity_state === 'overdue' || pin.activity_state === 'follow_up_due') {
    return normalizeLiveActivityEvent({
      id: `follow-up-${pin.conversation_id}-${createdAt}`,
      type: 'follow_up_due',
      priority: pin.activity_state === 'overdue' ? 'critical' : 'hot',
      title: sellerName,
      subtitle: market,
      address,
      detail: pin.next_action || 'Follow-up is due.',
      createdAt: pin.next_follow_up_at || createdAt,
      lat: pin.lat,
      lng: pin.lng,
      targetType: 'seller',
      targetId: pin.conversation_id,
      actionLabel: 'Open Thread',
      badgeLabel: pin.activity_state === 'overdue' ? 'Overdue' : 'Follow-Up',
    })
  }

  if (
    lastIntent.includes('sell')
    || lastIntent.includes('interested')
    || lastIntent.includes('positive')
    || lastIntent.includes('price')
    || /\b(yes|yeah|yep|si|interested|price)\b/i.test(latestMessage)
  ) {
    return normalizeLiveActivityEvent({
      id: `positive-${pin.conversation_id}-${createdAt}`,
      type: 'positive_reply',
      priority: 'hot',
      title: sellerName,
      subtitle: market,
      address,
      detail: latestMessage || 'Positive intent detected.',
      createdAt: pin.last_inbound_at || createdAt,
      lat: pin.lat,
      lng: pin.lng,
      targetType: 'seller',
      targetId: pin.conversation_id,
      actionLabel: 'Open Deal',
      badgeLabel: 'Positive',
      scoreLabel: Number.isFinite(pin.motivation_score ?? NaN) ? `Motivation ${Math.round(pin.motivation_score as number)}` : undefined,
    })
  }

  if (pin.unread || pin.activity_state === 'new_replies' || pin.activity_state === 'replied') {
    return normalizeLiveActivityEvent({
      id: `reply-${pin.conversation_id}-${createdAt}`,
      type: 'new_reply',
      priority: 'hot',
      title: sellerName,
      subtitle: market,
      address,
      detail: latestMessage || 'New seller reply received.',
      createdAt: pin.last_inbound_at || createdAt,
      lat: pin.lat,
      lng: pin.lng,
      targetType: 'seller',
      targetId: pin.conversation_id,
      actionLabel: 'Open',
      badgeLabel: 'New Reply',
    })
  }

  if ((pin.priority_score ?? 0) >= 92) {
    return normalizeLiveActivityEvent({
      id: `hot-${pin.conversation_id}-${createdAt}`,
      type: 'hot_lead',
      priority: 'hot',
      title: sellerName,
      subtitle: market,
      address,
      detail: pin.next_action || latestMessage || 'High priority seller signal.',
      createdAt,
      lat: pin.lat,
      lng: pin.lng,
      targetType: 'seller',
      targetId: pin.conversation_id,
      actionLabel: 'Open Deal',
      badgeLabel: 'Hot Lead',
      scoreLabel: `Priority ${Math.round(pin.priority_score)}`,
      valueLabel: Number.isFinite(pin.final_acquisition_score ?? NaN) ? `Acq ${Math.round(pin.final_acquisition_score as number)}` : undefined,
    })
  }

  return null
}

type LiveActivityFeedArgs = {
  pins: CommandMapActivityPinSource[]
  threadsById: Map<string, InboxWorkflowThread>
  buyerPurchases?: BuyerRecentPurchase[]
  soldComps?: RecentSoldComp[]
  settings: CommandMapLiveActivitySettings
  selectedMarket?: string | null
  bounds?: CommandMapBounds | null
  selectedThread?: InboxWorkflowThread | null
}

export const loadLiveActivityFeed = ({
  pins,
  threadsById,
  buyerPurchases = [],
  soldComps = [],
  settings,
  selectedMarket,
  bounds,
  selectedThread,
}: LiveActivityFeedArgs): CommandMapActivityEvent[] => {
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
    .map((pin) => maybeBuildPinEvent(pin, threadsById.get(pin.conversation_id) || null))
    .filter((event): event is CommandMapActivityEvent => Boolean(event))

  const buyerEvents = buyerPurchases.slice(0, 8).map((purchase) =>
    normalizeLiveActivityEvent({
      id: `buyer-${purchase.buyerKey}-${purchase.propertyId}-${purchase.saleDate || ''}`,
      type: 'buyer_activity',
      priority: 'info',
      title: purchase.buyerName || 'Buyer Activity',
      subtitle: purchase.market || 'Market Unknown',
      address: purchase.propertyAddressFull || 'Property Unknown',
      detail: `Recent purchase${purchase.saleDate ? ` • ${formatRelative(purchase.saleDate)}` : ''}`,
      market: purchase.market || undefined,
      createdAt: purchase.saleDate || new Date().toISOString(),
      lat: purchase.latitude,
      lng: purchase.longitude,
      targetType: 'buyer',
      targetId: purchase.buyerKey,
      actionLabel: 'View Trail',
      badgeLabel: 'Buyer Active',
      valueLabel: formatCompactCurrency(purchase.salePrice ?? null),
      scoreLabel: Number.isFinite(purchase.investorFitScore ?? NaN) ? `Fit ${Math.round(purchase.investorFitScore as number)}` : undefined,
    }),
  )

  const subjectLat = Number((selectedThread as any)?.lat ?? (selectedThread as any)?.latitude ?? NaN)
  const subjectLng = Number((selectedThread as any)?.lng ?? (selectedThread as any)?.longitude ?? NaN)
  const soldCompEvents = soldComps.slice(0, 10).map((comp) => {
    const distance =
      Number.isFinite(subjectLat) && Number.isFinite(subjectLng)
        ? haversineMiles(subjectLat, subjectLng, comp.latitude, comp.longitude)
        : null
    return normalizeLiveActivityEvent({
      id: `sold-comp-${comp.property_id}-${comp.sale_date || comp.mls_sold_date || ''}`,
      type: 'sold_comp',
      priority: 'info',
      title: comp.property_address_full || 'Sold Comp',
      subtitle: `${comp.property_address_city || ''}${comp.property_address_state ? `, ${comp.property_address_state}` : ''}`.trim() || 'Market Unknown',
      address: comp.property_address_full || 'Property Unknown',
      detail: distance != null ? `${distance.toFixed(distance < 1 ? 2 : 1)} mi from selected property` : (comp.sale_source || 'Recent sold comp'),
      market: `${comp.property_address_city || ''}${comp.property_address_state ? `, ${comp.property_address_state}` : ''}`.trim() || undefined,
      createdAt: comp.sale_date || comp.mls_sold_date || new Date().toISOString(),
      lat: comp.latitude,
      lng: comp.longitude,
      targetType: 'sold_comp',
      targetId: comp.property_id,
      actionLabel: 'Open Comp',
      badgeLabel: 'Sold Comp',
      valueLabel: formatCompactCurrency(comp.sale_price ?? comp.mls_sold_price ?? null),
      scoreLabel: Number.isFinite(comp.comp_confidence_score ?? NaN) ? `Conf ${Math.round(comp.comp_confidence_score as number)}` : undefined,
    })
  })

  return [...pinEvents, ...buyerEvents, ...soldCompEvents]
    .filter((event) => settings.eventTypes[event.type])
    .filter((event) => !settings.onlyHotCritical || event.priority === 'hot' || event.priority === 'critical')
    .filter((event) => !settings.onlySelectedMarket || !selectedMarket || event.market === selectedMarket || event.subtitle === selectedMarket)
    .filter((event) => !settings.onlyCurrentBounds || isWithinBounds(event.lat, event.lng, bounds))
    .sort((left, right) => {
      const priorityWeight: Record<CommandMapActivityPriority, number> = { critical: 5, hot: 4, normal: 3, info: 2, muted: 1 }
      const weightDelta = priorityWeight[right.priority] - priorityWeight[left.priority]
      if (weightDelta !== 0) return weightDelta
      return new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime()
    })
    .slice(0, Math.min(100, Math.max(8, settings.maxCardsVisible)))
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
