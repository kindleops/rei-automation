export type QueueItemStatus =
  | 'ready'
  | 'scheduled'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'held'
  | 'approval'
  | 'retry'
  | 'queued'
  | 'sending'
  | 'blocked'
  | 'cancelled'
  | 'replied_before_send'
  | 'paused_name_missing'
  | 'paused_duplicate'
  | 'paused_invalid_queue_row'
  | 'paused_global_lock'
  | 'paused_max_retries'
export type QueueItemPriority = 'P0' | 'P1' | 'P2' | 'P3'
export type DeliveryStatus = 'pending' | 'sent' | 'delivered' | 'failed' | 'bounced' | 'rejected'
export type FailureReason =
  | 'carrier_error'
  | 'textgrid_error'
  | 'invalid_phone'
  | 'dnc_conflict'
  | 'outside_contact_window'
  | 'template_missing'
  | 'retry_exhausted'
  | 'sync_error'
  | 'unknown'
export type RiskLevel = 'low' | 'medium' | 'high'
export type QueueBucket = 'ready' | 'scheduled' | 'approval' | 'failed' | 'retry' | 'held' | 'sent' | 'delivered' | 'paused_invalid_queue_row'
export type QueueView = 'today' | 'week' | 'month' | 'list' | 'approval' | 'failed'

export interface QueueItem {
  id: string
  queueId: string
  sellerName: string
  sellerDisplayName: string
  propertyAddress: string
  market: string
  phone: string
  toPhoneNumber: string
  fromPhoneNumber: string
  agent: string
  templateName: string
  templateId: string | null
  selectedTemplateId: string | null
  templateSource: 'system' | 'custom' | 'ai'
  useCase: string
  stage: string
  stageBefore: string | null
  stageAfter: string | null
  messageText: string
  scheduledForLocal: string // ISO string in local tz
  scheduledForUtc: string // ISO string in UTC
  timezone: string
  contactWindow: 'morning' | 'afternoon' | 'evening' | 'flexible'
  status: QueueItemStatus
  statusLabel: string
  priority: QueueItemPriority
  touchNumber: number
  language: 'en' | 'es'
  retryCount: number
  maxRetries: number
  failureReason: FailureReason | null
  failedReason: string | null
  pausedReason: string | null
  blockedReason: string | null
  deliveryStatus: DeliveryStatus
  createdAt: string
  updatedAt: string
  sentAt: string | null
  deliveredAt: string | null
  approvedByOperator: string | null
  requiresApproval: boolean
  riskLevel: RiskLevel
  aiConfidence: number // 0-100
  estimatedCost: number
  textgridNumber: string
  linkedInboxThreadId: string | null
  linkedPropertyId: string | null
  linkedOwnerId: string | null
  propertyType: string | null
  safetyStatus: string | null
  routingAllowed: boolean | null
  smsEligible: boolean | null
  providerMessageId: string | null
  textgridMessageId: string | null
  messageEventId: string | null
  missingMessageEvent: boolean
  missingProviderMessageId: boolean
  overdue: boolean
  metadata?: Record<string, any>

  // Tactical Intelligence Fields
  sellerTemperature: 'cold' | 'warm' | 'hot' | 'dnc' | 'unknown'
  currentStage: string
  nextBestAction: string | null
  memoryStatus: 'none' | 'partial' | 'rich'
  urgencyScore: number // 0-100
  extractedIntent: string | null
  routingReason: string | null
  failureGroup: 'Carrier' | 'Compliance' | 'Routing' | 'Template' | 'Webhook' | 'Contact Window' | 'Duplicate' | 'Payload' | 'Unknown' | null
  retryEligible: boolean
  approvalReason: string | null
  priorThreadSummary: string | null

  // New Hydration Fields
  campaignId: string | null
  campaignName: string | null
  campaignTargetId: string | null
  campaignTargetStatus: string | null
  
  sellerFirstName: string | null
  sellerFullName: string | null
  
  propertyCity: string | null
  propertyState: string | null
  propertyZip: string | null
  
  routingTier: number | null
  routingRuleName: string | null
  
  lastEventType: string | null
  lastEventAt: string | null
  lastEventStatus: string | null
  
  failureCategory: string | null
  diagnosticFlags: string[]
  rowSource: 'campaign' | 'feeder' | 'manual' | 'auto_reply' | 'unknown'
  guardReason: string | null
}

export interface QueueModel {
  items: QueueItem[]
  readyCount: number
  scheduledCount: number
  approvalCount: number
  failedCount: number
  retryCount: number
  heldCount: number
  sentTodayCount: number
  deliveredTodayCount: number
  safeCapacityRemaining: number
  optOutRiskCount: number
  apiPressureLevel: 'low' | 'medium' | 'high'
  sendEngine: string
  engineMode: 'proxy' | 'disabled' | 'dry-run only'
}

export interface QueueFilters {
  markets: string[]
  statuses: QueueItemStatus[]
  agents: string[]
  priorities: QueueItemPriority[]
  templates: string[]
  useCases: string[]
  languages: ('en' | 'es')[]
  contactWindows: ('morning' | 'afternoon' | 'evening' | 'flexible')[]
  riskLevels: RiskLevel[]
  searchQuery: string
}
