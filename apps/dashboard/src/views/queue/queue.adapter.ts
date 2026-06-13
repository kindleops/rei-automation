import type { QueueModel, QueueItem, QueueItemStatus, QueueItemPriority, DeliveryStatus, FailureReason, RiskLevel } from '../../domain/queue/queue.types'
import { fetchQueueModel } from '../../lib/data/queueData'
import { isDev, shouldUseSupabase } from '../../lib/data/shared'

const MARKETS = ['Dallas', 'Austin', 'Houston', 'San Antonio', 'Minneapolis', 'Denver']
const AGENTS = ['Sarah Johnson', 'Mike Chen', 'Elena Rodriguez', 'James Wilson', 'Lisa Park']
const TEMPLATES = ['Initial Outreach', 'Follow-up', 'Urgency', 'Closing Push', 'Property Update']
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
  duplicate_blocked: 0,
  incident_quarantine: 0,
  expired: 0,
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

const generateQueueItem = (index: number): QueueItem => {
  const status: QueueItemStatus = Object.keys(STATUS_DISTRIBUTION)[
    Math.floor(Math.random() * Object.keys(STATUS_DISTRIBUTION).length)
  ] as QueueItemStatus

  const now = new Date()
  const scheduledTime = new Date(now.getTime() + (Math.random() * 7 * 24 * 60 * 60 * 1000))
  const createdTime = new Date(now.getTime() - (Math.random() * 30 * 24 * 60 * 60 * 1000))

  const retryCount = Math.floor(Math.random() * 4)
  const priority: QueueItemPriority = ['P0', 'P1', 'P2', 'P3'][Math.floor(Math.random() * 4)] as QueueItemPriority
  const riskLevel: RiskLevel = ['low', 'medium', 'high'][Math.floor(Math.random() * 3)] as RiskLevel
  const aiConfidence = Math.floor(Math.random() * 40) + 60

  return {
    id: `queue-${index}`,
    queueId: `q-${Math.random().toString(36).substring(7)}`,
    sellerName: SELLERS[Math.floor(Math.random() * SELLERS.length)],
    sellerDisplayName: SELLERS[Math.floor(Math.random() * SELLERS.length)],
    propertyAddress: `${Math.floor(Math.random() * 10000) + 1} Main St`,
    market: MARKETS[Math.floor(Math.random() * MARKETS.length)],
    phone: `+1${Math.floor(Math.random() * 9000000000 + 2000000000)}`,
    toPhoneNumber: `+1${Math.floor(Math.random() * 9000000000 + 2000000000)}`,
    fromPhoneNumber: `+1${Math.floor(Math.random() * 9000000000 + 2000000000)}`,
    agent: AGENTS[Math.floor(Math.random() * AGENTS.length)],
    templateName: TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)],
    templateId: `tpl-${index}`,
    selectedTemplateId: `tpl-${index}`,
    templateSource: ['system', 'custom', 'ai'][Math.floor(Math.random() * 3)] as 'system' | 'custom' | 'ai',
    useCase: USE_CASES[Math.floor(Math.random() * USE_CASES.length)],
    stage: ['lead', 'follow-up', 'negotiation', 'closing'][Math.floor(Math.random() * 4)],
    stageBefore: 'ownership_check',
    stageAfter: null,
    messageText: `Hi there! I wanted to follow up on the property at ${Math.floor(Math.random() * 10000) + 1} Main St. We have a qualified buyer interested. Would you like to discuss further?`,
    scheduledForLocal: scheduledTime.toISOString(),
    scheduledForUtc: scheduledTime.toISOString(),
    timezone: 'America/Chicago',
    contactWindow: ['morning', 'afternoon', 'evening', 'flexible'][Math.floor(Math.random() * 4)] as any,
    status,
    statusLabel: status.replace(/_/g, ' '),
    priority,
    touchNumber: Math.floor(Math.random() * 5) + 1,
    language: Math.random() > 0.8 ? 'es' : 'en',
    retryCount,
    maxRetries: 3,
    failureReason: status === 'failed' || status === 'retry' ? FAILURE_REASONS[Math.floor(Math.random() * FAILURE_REASONS.length)] : null,
    failedReason: status === 'failed' ? 'carrier_error' : null,
    pausedReason: status.startsWith('paused_') ? status : null,
    blockedReason: status === 'blocked' ? 'routing_blocked' : null,
    deliveryStatus: (['pending', 'sent', 'delivered', 'failed', 'bounced'] as DeliveryStatus[])[status === 'delivered' ? 2 : status === 'sent' ? 1 : 0],
    createdAt: createdTime.toISOString(),
    updatedAt: now.toISOString(),
    sentAt: status === 'sent' || status === 'delivered' ? new Date(now.getTime() - Math.random() * 24 * 60 * 60 * 1000).toISOString() : null,
    deliveredAt: status === 'delivered' ? new Date(now.getTime() - Math.random() * 12 * 60 * 60 * 1000).toISOString() : null,
    approvedByOperator: status === 'sent' || status === 'delivered' ? 'ops-team' : null,
    requiresApproval: status === 'approval' || (riskLevel === 'high' && Math.random() > 0.7),
    riskLevel,
    aiConfidence,
    estimatedCost: Math.random() * 0.025 + 0.01,
    textgridNumber: `+1${Math.floor(Math.random() * 9000000000 + 2000000000)}`,
    linkedInboxThreadId: Math.random() > 0.4 ? `thread-${Math.random().toString(36).substring(7)}` : null,
    linkedPropertyId: `prop-${Math.random().toString(36).substring(7)}`,
    linkedOwnerId: `owner-${Math.random().toString(36).substring(7)}`,
    propertyType: ['Single Family', 'Multifamily', 'Land'][Math.floor(Math.random() * 3)],
    safetyStatus: 'ok',
    routingAllowed: true,
    smsEligible: true,
    providerMessageId: status === 'sent' || status === 'delivered' ? `provider-${index}` : null,
    textgridMessageId: status === 'sent' || status === 'delivered' ? `tg-${index}` : null,
    messageEventId: status === 'sent' || status === 'delivered' ? `evt-${index}` : null,
    missingMessageEvent: false,
    missingProviderMessageId: false,
    overdue: status === 'scheduled' && scheduledTime.getTime() < now.getTime(),
    sellerTemperature: ['cold', 'warm', 'hot', 'dnc', 'unknown'][Math.floor(Math.random() * 5)] as any,
    currentStage: ['Lead', 'Nurture', 'Negotiation', 'Follow-up'][Math.floor(Math.random() * 4)],
    nextBestAction: ['Call seller', 'Send offer', 'Review comps', 'Wait'][Math.floor(Math.random() * 4)],
    memoryStatus: ['none', 'partial', 'rich'][Math.floor(Math.random() * 3)] as any,
    urgencyScore: Math.floor(Math.random() * 100),
    extractedIntent: ['Wants higher price', 'Needs to sell fast', 'Not interested right now', null][Math.floor(Math.random() * 4)],
    routingReason: ['High confidence', 'Matches filter', 'Operator requested', null][Math.floor(Math.random() * 4)],
    failureGroup: ['Carrier', 'Compliance', 'Routing', 'Template', 'Webhook', 'Contact Window', 'Duplicate', 'Payload', 'Unknown', null][Math.floor(Math.random() * 10)] as any,
    retryEligible: Math.random() > 0.5,
    approvalReason: status === 'approval' ? 'High risk message' : null,
    priorThreadSummary: 'Discussed pricing and timeline last week.',
    campaignId: `camp-${index}`,
    campaignName: 'Mock Campaign',
    campaignTargetId: `target-${index}`,
    campaignTargetStatus: 'active',
    sellerFirstName: 'Mock',
    sellerFullName: 'Mock Seller',
    propertyCity: 'Mock City',
    propertyState: 'TX',
    propertyZip: '75001',
    routingTier: 1,
    routingRuleName: 'Default',
    lastEventType: 'delivery',
    lastEventAt: now.toISOString(),
    lastEventStatus: 'delivered',
    failureCategory: 'unknown',
    diagnosticFlags: [],
    rowSource: 'campaign',
    guardReason: null,
    queueKey: `campaign:mock-${index}`,
    workflowId: null,
    workflowExecutionId: null,
    automationSource: 'Campaign',
  }
}

export const adaptQueueModel = (): QueueModel => {
  // Generate ~600 items distributed across statuses
  let items: QueueItem[] = []
  let id = 0

  for (const [status, count] of Object.entries(STATUS_DISTRIBUTION)) {
    for (let i = 0; i < count; i++) {
      const item = generateQueueItem(id)
      item.status = status as QueueItemStatus
      items.push(item)
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
    totalCount: items.length,
    currentPage: 0,
    pageSize: items.length,
    totalPages: 1,
    hasMore: false,
    fetchOptions: {},
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
