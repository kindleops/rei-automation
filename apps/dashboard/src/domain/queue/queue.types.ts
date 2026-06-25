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
  sellerFullNameResolved?: string
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
  // Normalized ownership/reply stage (Phase 3)
  stageCode: StageCode | null
  stageLabel: string | null
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
  activeProspectFullName?: string | null
  masterOwnerDisplayName?: string | null

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
  dispatchCategory?: 'runnable' | 'proof' | 'future_window' | 'paused_campaign' | 'globally_blocked' | 'expired' | 'non_runnable'
  dispatchLabel?: string
  dispatchBlocker?: string | null
  nextEligibleSendAt?: string | null

  // Origin / routing identifiers surfaced in the inspector
  automationSource: string | null
  workflowId: string | null
  queueKey: string | null
}

// ── Stage taxonomy (Phase 3) ────────────────────────────────────────────────
export type StageCode =
  | 'S1'
  | 'S1F'
  | 'S2'
  | 'S3'
  | 'S4'
  | 'S5'
  | 'S6'
  | 'manual_reply'
  | 'auto_reply'
  | 'other'

export const STAGE_LABELS: Record<StageCode, string> = {
  S1: 'Ownership Confirmation',
  S1F: 'Ownership Follow-Up',
  S2: 'Selling Interest',
  S3: 'Asking Price',
  S4: 'Condition & Underwriting',
  S5: 'Offer & Negotiation',
  S6: 'Contract to Close',
  manual_reply: 'Manual Reply',
  auto_reply: 'Auto Reply',
  other: 'Other',
}

// ── Server-backed fetch options + paginated model (Phase 1/2) ────────────────
export type QueueDateBasis = 'created_at' | 'scheduled_for' | 'updated_at'

export interface QueueFetchOptions {
  dateFrom?: string
  dateTo?: string
  dateBasis?: QueueDateBasis
  page?: number
  pageSize?: number
  status?: string
  market?: string
  template?: string
  sender?: string
  search?: string
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

  // Server-side pagination metadata (Phase 1). Optional so legacy/mock
  // producers remain valid; the page falls back to items.length when absent.
  totalCount?: number
  currentPage?: number
  pageSize?: number
  totalPages?: number
  hasMore?: boolean
  fetchOptions?: QueueFetchOptions
  // Range-accurate status counts across the whole filtered date range
  // (independent of the visible page) so the KPI strip reflects the range.
  rangeCounts?: QueueRangeCounts
  // Every configured market (from textgrid_numbers), independent of whether the
  // current page has rows for it — so Market Health can show zero-row markets.
  marketDirectory?: ConfiguredMarket[]
}

export interface ConfiguredMarket {
  market: string
  senderCount: number
  active: boolean
}

export interface QueueRangeCounts {
  scheduled: number
  queued: number
  sending: number
  sent: number
  delivered: number
  failed: number
  blocked: number
  approval: number
  optOuts: number
  total: number
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
