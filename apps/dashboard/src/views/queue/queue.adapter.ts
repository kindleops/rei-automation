import type { QueueModel, QueueItem, QueueItemStatus, QueueItemPriority, DeliveryStatus, FailureReason, RiskLevel } from '../../domain/queue/queue.types'
import { PRODUCTION_TEXTGRID_FLEET } from '../../lib/data/textgridFleet'
import { fetchQueueModel } from '../../lib/data/queueData'
import { isDev, shouldUseSupabase } from '../../lib/data/shared'

const MARKETS = ['Dallas', 'Austin', 'Houston', 'San Antonio', 'Minneapolis', 'Denver']

const MOCK_TEXTGRID_FLEET = PRODUCTION_TEXTGRID_FLEET
const AGENTS = ['Sarah Johnson', 'Mike Chen', 'Elena Rodriguez', 'James Wilson', 'Lisa Park']
const USE_CASES = ['listing', 'foreclosure', 'probate', 'distressed', 'investment']
const SELLERS = [
  'John Smith Realty',
  'Elite Properties LLC',
  'Urban Homes',
  'Midwest Equity',
  'Century Estates',
  'Portfolio Advisors',
]

const STATUS_DISTRIBUTION: Record<QueueItemStatus, number> = {
  ready: 24,
  scheduled: 156,
  sent: 342,
  delivered: 319,
  failed: 18,
  held: 7,
  approval: 12,
  retry: 9,
  queued: 10,
  sending: 5,
  blocked: 3,
  cancelled: 2,
  replied_before_send: 4,
  paused_name_missing: 2,
  paused_duplicate: 2,
  paused_invalid_queue_row: 2,
  paused_global_lock: 1,
  paused_max_retries: 2,
}

const FAILURE_REASONS: FailureReason[] = [
  'carrier_error',
  'textgrid_error',
  'invalid_phone',
  'dnc_conflict',
  'outside_contact_window',
  'template_missing',
  'retry_exhausted',
  'sync_error',
]

// Market → city/state, so a mock row never claims a Dallas market with a
// Minneapolis city. Visual-proof screenshots must not look like cross-lead
// corruption.
const MARKET_GEO: Record<string, { city: string; state: string; zip: string }> = {
  Dallas: { city: 'Dallas', state: 'TX', zip: '75201' },
  Austin: { city: 'Austin', state: 'TX', zip: '78701' },
  Houston: { city: 'Houston', state: 'TX', zip: '77002' },
  'San Antonio': { city: 'San Antonio', state: 'TX', zip: '78205' },
  Minneapolis: { city: 'Minneapolis', state: 'MN', zip: '55401' },
  Denver: { city: 'Denver', state: 'CO', zip: '80202' },
}

const STREETS = ['Hoefner Ave', 'Bellaire Dr', 'Cedar Springs Rd', 'Loma Vista Ln', 'Grandview St', 'Winnetka Ave']
const FIRST_NAMES = ['Rodolfo', 'Marisol', 'Dwayne', 'Priya', 'Hector', 'Alanna']
const LAST_NAMES = ['Nunez', 'Alvarez', 'Whitfield', 'Raman', 'Delgado', 'Boone']

const STAGE_CONTEXT = {
  S1: { label: 'Ownership Confirmation', canonical: 'ownership_check', template: 'Ownership Check' },
  S2: { label: 'Selling Interest', canonical: 'selling_interest', template: 'Interest Follow-Up' },
  S3: { label: 'Asking Price', canonical: 'asking_price_received', template: 'Asking Price Follow-Up' },
  S4: { label: 'Condition & Underwriting', canonical: 'condition_disclosed', template: 'Condition Questions' },
  S5: { label: 'Offer & Negotiation', canonical: 'offer_presented', template: 'Offer Presentation' },
} as const

type MockStage = keyof typeof STAGE_CONTEXT

// Status → what the provider actually reported. The generator previously
// hardcoded lastEventStatus:'delivered' on every row, which made canonical
// delivery truth (correctly) render every row as Delivered.
const LAST_EVENT_STATUS: Partial<Record<QueueItemStatus, string>> = {
  delivered: 'delivered',
  sent: 'sent',
  failed: 'failed',
  retry: 'failed',
  sending: 'sent',
}

// The status is an input, not a second random draw. adaptQueueModel used to
// overwrite `item.status` after generation, so every status-derived field
// (failure category, sentAt, provider ids, last event) described a different
// row than the one that was rendered.
const generateQueueItem = (index: number, status: QueueItemStatus): QueueItem => {
  const now = new Date()
  const createdTime = new Date(now.getTime() - (Math.random() * 30 * 24 * 60 * 60 * 1000))

  const retryCount = Math.floor(Math.random() * 4)
  const priority: QueueItemPriority = ['P0', 'P1', 'P2', 'P3'][Math.floor(Math.random() * 4)] as QueueItemPriority
  const riskLevel: RiskLevel = ['low', 'medium', 'high'][Math.floor(Math.random() * 3)] as RiskLevel
  const aiConfidence = Math.floor(Math.random() * 40) + 60

  // ── One coherent lead per row ──────────────────────────────────────────────
  // Every downstream field derives from these, so the seller, the property, the
  // market, the rendered message and the stage always describe the same deal.
  const market = MARKETS[index % MARKETS.length]
  const geo = MARKET_GEO[market]
  const streetNumber = 100 + ((index * 37) % 9800)
  const street = STREETS[index % STREETS.length]
  const propertyAddress = `${streetNumber} ${street}`
  const firstName = FIRST_NAMES[index % FIRST_NAMES.length]
  const lastName = LAST_NAMES[(index * 3) % LAST_NAMES.length]
  const sellerFullName = `${firstName} ${lastName}`
  const entity = SELLERS[index % SELLERS.length]
  const stageCode: MockStage = (['S1', 'S2', 'S3', 'S4', 'S5'] as const)[index % 5]
  const stage = STAGE_CONTEXT[stageCode]
  const toPhone = `+1214${String(5550000 + (index % 9999)).padStart(7, '0')}`
  // Route from a sender that actually serves this market where one exists.
  const marketSenders = MOCK_TEXTGRID_FLEET.filter((n) => n.market === market)
  const sender = (marketSenders.length > 0 ? marketSenders : MOCK_TEXTGRID_FLEET)[index % Math.max(marketSenders.length || MOCK_TEXTGRID_FLEET.length, 1)]

  const failedRow = status === 'failed' || status === 'retry'
  const blockedRow = status === 'blocked' || status.startsWith('paused_')
  const sentAt = status === 'sent' || status === 'delivered' || status === 'sending'
    ? new Date(now.getTime() - Math.random() * 24 * 60 * 60 * 1000).toISOString()
    : null
  // Delivery implies dispatch — never emit deliveredAt without sentAt.
  const deliveredAt = status === 'delivered'
    ? new Date(new Date(sentAt!).getTime() + 45_000).toISOString()
    : null
  // A dispatched row was scheduled *before* it sent; only pending work is in the
  // future. The generator previously always scheduled forward, so a delivered
  // row read "Scheduled just now · Sent 16h ago".
  const scheduledTime = sentAt
    ? new Date(new Date(sentAt).getTime() - 5 * 60_000)
    : new Date(now.getTime() + (Math.random() * 7 * 24 * 60 * 60 * 1000))

  return {
    id: `queue-${index}`,
    queueId: `q-${Math.random().toString(36).substring(7)}`,
    sellerName: sellerFullName,
    sellerDisplayName: sellerFullName,
    propertyAddress,
    market,
    phone: toPhone,
    toPhoneNumber: toPhone,
    fromPhoneNumber: sender.phone,
    agent: AGENTS[Math.floor(Math.random() * AGENTS.length)],
    templateName: stage.template,
    templateId: `tpl-${index}`,
    selectedTemplateId: `tpl-${index}`,
    templateSource: ['system', 'custom', 'ai'][Math.floor(Math.random() * 3)] as 'system' | 'custom' | 'ai',
    useCase: USE_CASES[index % USE_CASES.length],
    stage: stage.canonical,
    stageBefore: null,
    stageAfter: null,
    // The rendered message must reference this row's own property.
    messageText: `Hi ${firstName}, following up on ${propertyAddress} in ${geo.city}. We have a qualified buyer interested — is there a number you'd take for it?`,
    scheduledForLocal: scheduledTime.toISOString(),
    scheduledForUtc: scheduledTime.toISOString(),
    timezone: 'America/Chicago',
    contactWindow: ['morning', 'afternoon', 'evening', 'flexible'][Math.floor(Math.random() * 4)] as any,
    status,
    statusLabel: status.replace(/_/g, ' '),
    priority,
    touchNumber: (index % 5) + 1,
    language: 'en',
    retryCount,
    maxRetries: 3,
    failureReason: status === 'failed' || status === 'retry' ? FAILURE_REASONS[Math.floor(Math.random() * FAILURE_REASONS.length)] : null,
    failedReason: failedRow ? 'Carrier rejected the message (30007)' : null,
    pausedReason: status.startsWith('paused_') ? status : null,
    blockedReason: blockedRow ? 'No active sender configured for this market' : null,
    deliveryStatus: (['pending', 'sent', 'delivered', 'failed', 'bounced'] as DeliveryStatus[])[status === 'delivered' ? 2 : status === 'sent' ? 1 : 0],
    createdAt: createdTime.toISOString(),
    updatedAt: now.toISOString(),
    sentAt,
    deliveredAt,
    approvedByOperator: status === 'sent' || status === 'delivered' ? 'ops-team' : null,
    requiresApproval: status === 'approval' || (riskLevel === 'high' && Math.random() > 0.7),
    riskLevel,
    aiConfidence,
    estimatedCost: Math.random() * 0.025 + 0.01,
    textgridNumber: sender.phone,
    linkedInboxThreadId: Math.random() > 0.4 ? `thread-${Math.random().toString(36).substring(7)}` : null,
    linkedPropertyId: `prop-${Math.random().toString(36).substring(7)}`,
    linkedOwnerId: `owner-${Math.random().toString(36).substring(7)}`,
    propertyType: ['Single Family', 'Multifamily', 'Land'][Math.floor(Math.random() * 3)],
    safetyStatus: 'clear',
    routingAllowed: true,
    smsEligible: true,
    providerMessageId: status === 'sent' || status === 'delivered' ? `provider-${index}` : null,
    textgridMessageId: status === 'sent' || status === 'delivered' ? `tg-${index}` : null,
    messageEventId: status === 'sent' || status === 'delivered' ? `evt-${index}` : null,
    missingMessageEvent: false,
    missingProviderMessageId: false,
    overdue: status === 'scheduled' && scheduledTime.getTime() < now.getTime(),
    sellerTemperature: ['cold', 'warm', 'hot', 'dnc', 'unknown'][Math.floor(Math.random() * 5)] as any,
    currentStage: stage.canonical,
    nextBestAction: ['Call seller', 'Send offer', 'Review comps', 'Wait'][Math.floor(Math.random() * 4)],
    memoryStatus: ['none', 'partial', 'rich'][Math.floor(Math.random() * 3)] as any,
    urgencyScore: Math.floor(Math.random() * 100),
    extractedIntent: ['Wants higher price', 'Needs to sell fast', 'Not interested right now', null][Math.floor(Math.random() * 4)],
    routingReason: ['High confidence', 'Matches filter', 'Operator requested', null][Math.floor(Math.random() * 4)],
    failureGroup: failedRow ? 'Carrier' : blockedRow ? 'Routing' : null,
    retryEligible: failedRow ? retryCount < 3 : false,
    approvalReason: status === 'approval' ? 'High risk message' : null,
    priorThreadSummary: 'Discussed pricing and timeline last week.',
    campaignId: `camp-${index}`,
    campaignName: `${market} Q3 Acquisition`,
    campaignTargetId: `target-${index}`,
    campaignTargetStatus: 'active',
    sellerFirstName: firstName,
    sellerFullName,
    propertyCity: geo.city,
    propertyState: geo.state,
    propertyZip: geo.zip,
    routingTier: 1,
    routingRuleName: 'Default',
    lastEventType: failedRow ? 'delivery_failed' : blockedRow ? 'guard_block' : 'delivery',
    // Spread events across the range — a fixture where every row's last event
    // is "now" makes the 15-minute Live window read as the range total.
    lastEventAt: new Date(now.getTime() - ((index * 977) % (7 * 24 * 60)) * 60_000).toISOString(),
    lastEventStatus: LAST_EVENT_STATUS[status] ?? null,
    // `failure_category` only belongs on a row that actually failed or blocked.
    failureCategory: failedRow ? 'carrier_failure' : blockedRow ? 'no_valid_sender' : null,
    diagnosticFlags: [],
    rowSource: 'campaign',
    guardReason: null,
    automationSource: 'campaign_launch_execution',
    workflowId: null,
    queueKey: `feed-${index}`,
    stageCode,
    stageLabel: stage.label,
    sellerFullNameResolved: sellerFullName,
    masterOwnerDisplayName: entity,
  }
}

export const adaptQueueModel = (): QueueModel => {
  // Generate ~600 items distributed across statuses
  let items: QueueItem[] = []
  let id = 0

  for (const [status, count] of Object.entries(STATUS_DISTRIBUTION)) {
    for (let i = 0; i < count; i++) {
      items.push(generateQueueItem(id, status as QueueItemStatus))
      id++
    }
  }

  const readyCount = items.filter((i) => i.status === 'ready').length
  const scheduledCount = items.filter((i) => i.status === 'scheduled').length
  const approvalCount = items.filter((i) => i.status === 'approval').length
  const failedCount = items.filter((i) => i.status === 'failed').length
  const retryCount = items.filter((i) => i.status === 'retry').length
  const heldCount = items.filter((i) => i.status === 'held').length
  const sentTodayCount = items.filter((i) => i.status === 'sent').length
  const deliveredTodayCount = items.filter((i) => i.status === 'delivered').length

  const marketDirectory = MOCK_TEXTGRID_FLEET.reduce<Array<{ market: string; senderCount: number; active: boolean }>>((acc, n) => {
    const existing = acc.find((m) => m.market === n.market)
    if (existing) {
      existing.senderCount++
      if (n.isActive) existing.active = true
    } else {
      acc.push({ market: n.market, senderCount: 1, active: n.isActive })
    }
    return acc
  }, [])

  return {
    items,
    readyCount,
    scheduledCount,
    approvalCount,
    failedCount,
    retryCount,
    heldCount,
    sentTodayCount,
    deliveredTodayCount,
    safeCapacityRemaining: Math.floor(Math.random() * 500) + 200,
    optOutRiskCount: Math.floor(Math.random() * 8) + 2,
    apiPressureLevel: ['low', 'medium', 'high'][Math.floor(Math.random() * 3)] as any,
    sendEngine: 'real-estate-automation',
    engineMode: 'proxy',
    marketDirectory,
    textgridFleet: MOCK_TEXTGRID_FLEET,
  }
}

export const loadQueue = async (): Promise<QueueModel> => {
  if (shouldUseSupabase()) {
    try {
      return await fetchQueueModel()
    } catch (error) {
      if (isDev) {
        console.warn('[NEXUS] Queue Supabase load failed, using generated model.', error)
      }
    }
  }

  // Simulate network delay
  await new Promise((resolve) => setTimeout(resolve, 200))
  return adaptQueueModel()
}
