export type CampaignStatus = 'live' | 'warning' | 'paused'
export type AlertSeverity = 'critical' | 'warning' | 'info'
export type MarketHeat = 'hot' | 'warm' | 'steady'
export type PropertyType =
  | 'SFR'
  | 'Multi-Family'
  | 'Duplex'
  | 'Mobile Home'
  | 'Vacant Land'
export type Sentiment = 'hot' | 'warm' | 'neutral' | 'cold'
export type PipelineStage =
  | 'new'
  | 'contacted'
  | 'responding'
  | 'negotiating'
  | 'under-contract'
export type OwnerType =
  | 'absentee'
  | 'estate'
  | 'corporate'
  | 'tax-delinquent'
  | 'owner-occupied'
export type AgentStatus = 'active' | 'watching' | 'queued'
export type ActivityKind = 'system' | 'alert' | 'ai' | 'deal' | 'conversation' | 'autopilot'
export type MessageDirection = 'outbound' | 'inbound'
export type SystemHealthStatus = 'healthy' | 'warning' | 'degraded' | 'critical'
export type MapMode = 'leads' | 'distress' | 'heat' | 'stage' | 'pressure' | 'closings'
export type StageMomentum = 'stalling' | 'steady' | 'accelerating'

// ─── New surface types ────────────────────────────────────────────────────

export type InboxThreadStatus = 'unread' | 'read' | 'replied' | 'archived'
export type InboxThreadPriority = 'urgent' | 'high' | 'normal' | 'low'
export type BuyerIntent = 'active' | 'passive' | 'watching' | 'dormant'
export type TitleStatus = 'clear' | 'review' | 'issue' | 'pending' | 'closed'
export type ClosingPhase = 'title-ordered' | 'title-clear' | 'closing-scheduled' | 'closed' | 'post-close'
export type AutopilotAction = 'escalate' | 'send' | 'pause' | 'match' | 'alert' | 'schedule'
export type NotificationKind = 'autopilot' | 'alert' | 'deal' | 'system' | 'inbox'
export type WatchlistType = 'market' | 'lead' | 'agent' | 'zip'

export interface SystemHealthRecord {
  id: string
  label: string
  status: SystemHealthStatus
  value?: string
  detail?: string
  lastUpdatedIso: string
}

export interface TopZipRecord {
  zip: string
  outbound: number
  trend: '+' | '−'
}

export interface PipelineDistributionRecord {
  new: number
  contacted: number
  responding: number
  negotiating: number
  underContract: number
}

export type OperationalRisk = 'elevated' | 'moderate' | 'nominal'
export type AlertPriority = 'P0' | 'P1' | 'P2' | 'P3'

export interface MarketRecord {
  id: string
  slug: string
  name: string
  stateCode: string
  label: string
  lat: number
  lng: number
  heat: MarketHeat
  campaignStatus: CampaignStatus
  scanLabel: string
  activeProperties: number
  totalOutbound: number
  outboundToday: number
  repliesToday: number
  hotLeads: number
  pipelineValue: number
  deliverability: number
  healthScore: number
  activeCampaigns: number
  replyRate: number
  positiveRate: number
  optOutRate: number
  pendingFollowUps: number
  hourlyOutbound: number[]
  recentReplyRate: number[]
  topZips: TopZipRecord[]
  pipelineDistribution: PipelineDistributionRecord
  lastSweepIso: string
  operationalRisk: OperationalRisk
  capacityStrain: number
}

export interface LeadMessageRecord {
  id: string
  direction: MessageDirection
  message: string
  timestampIso: string
  aiGenerated?: boolean
}

export interface PropertyLeadRecord {
  id: string
  marketId: string
  address: string
  city: string
  stateCode: string
  zip: string
  lat: number
  lng: number
  ownerName: string
  ownerType: OwnerType
  propertyType: PropertyType
  sentiment: Sentiment
  pipelineStage: PipelineStage
  currentIntent: string
  estimatedValue: number
  offerAmount: number
  pipelineDays: number
  outboundAttempts: number
  lastOutboundIso: string
  lastInboundIso: string | null
  aiSummary: string
  heatFactors: string[]
  urgencyScore: number
  opportunityScore: number
  actionConfidence: number
  conversationTemperature: number
  stageMomentum: StageMomentum
  riskSummary: string
  riskFlags: string[]
  objectionsDetected: string[]
  recommendedAction: string
  messages: LeadMessageRecord[]
}

export interface AgentRecord {
  id: string
  name: string
  specialty: string
  status: AgentStatus
  handledToday: number
  avgResponseMinutes: number
  successRate: number
  load: number
  marketId: string
  focusLeadId: string
  activityLabel: string
  aiSummary: string
}

export interface AlertRecord {
  id: string
  marketId: string
  severity: AlertSeverity
  priority: AlertPriority
  title: string
  detail: string
  metricLabel: string
  metricValue: string
  timestampIso: string
}

export interface ActivityRecord {
  id: string
  marketId: string
  kind: ActivityKind
  severity: AlertSeverity
  title: string
  detail: string
  timestampIso: string
}

export interface MapLinkRecord {
  id: string
  fromMarketId: string
  toMarketId: string
  volume: number
}

export interface CommandCenterReferenceDataset {
  markets: MarketRecord[]
  properties: PropertyLeadRecord[]
  agents: AgentRecord[]
  alerts: AlertRecord[]
  activities: ActivityRecord[]
  mapLinks: MapLinkRecord[]
  systemHealth: SystemHealthRecord[]
  inboxThreads: InboxThreadRecord[]
  buyerProfiles: BuyerProfileRecord[]
  titleRecords: TitleRecord[]
  autopilotEvents: AutopilotEventRecord[]
  notifications: NotificationRecord[]
  watchlists: WatchlistRecord[]
}

export interface InboxThreadRecord {
  id: string
  leadId: string
  marketId: string
  ownerName: string
  subject: string
  preview: string
  status: InboxThreadStatus
  priority: InboxThreadPriority
  sentiment: Sentiment
  messageCount: number
  lastMessageIso: string
  unreadCount: number
  aiDraft: string | null
  labels: string[]
}

export interface BuyerProfileRecord {
  id: string
  name: string
  marketIds: string[]
  intent: BuyerIntent
  budget: number
  targetPropertyTypes: PropertyType[]
  targetZips: string[]
  matchScore: number
  lastActivityIso: string
  acquisitionsYTD: number
  avgDaysToClose: number
  preApproved: boolean
  notes: string
}

export interface TitleRecord {
  id: string
  leadId: string
  marketId: string
  address: string
  ownerName: string
  status: TitleStatus
  closingPhase: ClosingPhase
  titleCompany: string
  scheduledCloseIso: string | null
  daysInPhase: number
  earnestDeposit: number
  purchasePrice: number
  issues: string[]
  lastUpdatedIso: string
}

export interface AutopilotEventRecord {
  id: string
  action: AutopilotAction
  marketId: string
  leadId: string | null
  title: string
  detail: string
  confidence: number
  approved: boolean
  timestampIso: string
}

export interface NotificationRecord {
  id: string
  kind: NotificationKind
  severity: AlertSeverity
  title: string
  detail: string
  read: boolean
  actionLabel: string | null
  actionRoute: string | null
  timestampIso: string
}

export interface WatchlistRecord {
  id: string
  type: WatchlistType
  targetId: string
  label: string
  notes: string
  addedIso: string
  alertOnChange: boolean
}

export interface CommandCenterStore {
  marketsById: Record<string, MarketRecord>
  marketIds: string[]
  propertiesById: Record<string, PropertyLeadRecord>
  propertyIds: string[]
  propertyIdsByMarketId: Record<string, string[]>
  agentsById: Record<string, AgentRecord>
  agentIds: string[]
  alertsById: Record<string, AlertRecord>
  alertIds: string[]
  alertIdsByMarketId: Record<string, string[]>
  activitiesById: Record<string, ActivityRecord>
  activityIds: string[]
  activityIdsByMarketId: Record<string, string[]>
  mapLinks: MapLinkRecord[]
  systemHealth: SystemHealthRecord[]
  inboxThreadsById: Record<string, InboxThreadRecord>
  inboxThreadIds: string[]
  buyerProfilesById: Record<string, BuyerProfileRecord>
  buyerProfileIds: string[]
  titleRecordsById: Record<string, TitleRecord>
  titleRecordIds: string[]
  autopilotEventsById: Record<string, AutopilotEventRecord>
  autopilotEventIds: string[]
  notificationsById: Record<string, NotificationRecord>
  notificationIds: string[]
  watchlistsById: Record<string, WatchlistRecord>
  watchlistIds: string[]
}
