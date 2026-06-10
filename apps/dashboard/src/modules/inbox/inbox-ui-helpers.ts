import {
  resolveInboxSellerName,
  resolveInboxPropertyAddress,
  type ThreadContext,
  type ThreadMessage,
} from '../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { IconName } from '../../shared/icons'
import { buildConversationDecision, isHotLeadDecision, type InboxBucket } from '../../domain/inbox/inbox-decisioning'
import {
  isActiveCanonicalBucket,
  isWaitingInboxState,
  resolveInboxThreadState,
} from './resolveInboxThreadState'

export type InboxStageSelectValue =
  | 'all_stages'
  | string

export type InboxViewSelectValue =
  | 'new_replies'
  | 'all'
  | 'priority'
  | 'negotiating'
  | 'follow_up_due'
  | 'waiting_on_seller'
  | 'automated'
  | 'needs_review'
  | 'cold_no_response'
  | 'dnc_opt_out'
  | 'all_conversations'
  | 'all_inbound'
  | 'hot_leads'
  | 'starred'
  | 'pinned'
  | 'unassigned'
  | 'archived'
  | 'spanish_language'
  | 'auto_replied'
  | 'needs_reply'
  | 'manual_review'
  | 'positive_hot'
  | 'missing_context'
  | 'new_inbound'
  | 'suppressed'
  | 'not_contacted'
  | 'outbound_only'
  | 'inbound'
  | 'outbound'
  | 'active'
  | 'waiting'
  | 'needs_response'
  | 'sent'
  | 'queued'
  | 'failed'
  | 'wrong_number'
  | 'opt_out'
  | 'offer_requested'
  | 'all_inbound'
  | 'inbound_all'
  | 'outbound_active'
  // canonical bucket views
  | 'follow_up'
  | 'cold'
  | 'dead'
  | 'all_messages'


export type InboxSavedFilterPreset =
  | 'my_priority'
  | 'new_inbounds'
  | 'offer_needed'
  | 'review_required'
  | 'wrong_numbers'
  | 'suppressed'
  | 'language_focus'
  | 'high_motivation'
  | 'starred'
  | 'pinned'
  | 'unassigned'
  | 'all_messages'
  | 'inbound_only'
  | 'outbound_only'
  | 'needs_reply'
  | 'auto_replied'
  | 'auto_reply_failed'
  | 'positive_hot'
  | 'offer_requested'
  | 'opt_out'
  | 'manual_review'
  | 'missing_context'
  | 'all_inbound'
  | 'inbound_all'

export interface InboxAdvancedFilters {
  // A) WORKFLOW
  inboxStatus?: string
  sellerStage?: string
  reviewStatus?: string
  leadTemperature?: string
  queueStatus?: string

  // B) CONVERSATION
  latestIntent?: string
  lastMessageDirection?: string
  lastMessageContains?: string
  hasSellerReply?: 'yes' | 'no'
  hasPositiveReply?: 'yes' | 'no'
  hasPriceMention?: 'yes' | 'no'
  hasQuestion?: 'yes' | 'no'
  conversationAge?: string

  // C) PROPERTY
  market?: string
  state?: string
  zip?: string
  propertyType?: string
  bedsMin?: number
  bedsMax?: number
  bathsMin?: number
  bathsMax?: number
  sqftMin?: number
  sqftMax?: number
  unitsMin?: number
  unitsMax?: number
  yearBuiltMin?: number
  yearBuiltMax?: number
  effectiveYearBuiltMin?: number
  effectiveYearBuiltMax?: number
  propertyCondition?: string
  occupancy?: string
  propertyTags?: string[]

  // D) OWNER
  ownerType?: string
  ownerOccupancy?: string
  mailingState?: string
  mailingCity?: string
  sellerAgeMin?: number
  sellerAgeMax?: number
  ownershipYearsMin?: number
  ownershipYearsMax?: number
  multiplePropertiesOwned?: 'yes' | 'no'
  corporateMatch?: 'yes' | 'no'
  ownerContactQuality?: string
  outOfStateOwner?: 'all' | 'yes' | 'no'

  // E) FINANCIALS
  estimatedValueMin?: number
  estimatedValueMax?: number
  equityAmountMin?: number
  equityAmountMax?: number
  equityPercentMin?: number
  equityPercentMax?: number
  mortgageBalanceMin?: number
  mortgageBalanceMax?: number
  lastSalePriceMin?: number
  lastSalePriceMax?: number
  lastSaleDateFrom?: string
  lastSaleDateTo?: string
  repairCostMin?: number
  repairCostMax?: number
  cashOfferMin?: number
  cashOfferMax?: number
  offerPercentValueMin?: number
  offerPercentValueMax?: number
  spreadPotentialMin?: number
  spreadPotentialMax?: number
  highEquity?: boolean
  freeAndClear?: boolean
  lowEquity?: boolean
  underwater?: boolean
  bigSpreadPotential?: boolean
  heavyRepairs?: boolean

  // F) MOTIVATION / DISTRESS
  motivationMin?: number
  motivationMax?: number
  distressScoreMin?: number
  distressScoreMax?: number
  urgencyScoreMin?: number
  urgencyScoreMax?: number
  finalAcquisitionScoreMin?: number
  finalAcquisitionScoreMax?: number
  motivationTags?: string[]
  persona?: string

  // G) AI INTELLIGENCE
  aiScoreMin?: number
  aiScoreMax?: number
  aiMotivationScoreMin?: number
  aiMotivationScoreMax?: number
  aiConfidenceMin?: number
  aiConfidenceMax?: number
  aiSellerPersona?: string
  aiRecommendedAction?: string
  aiRiskFlag?: string
  aiStage?: string
  aiConversationSummaryExists?: 'yes' | 'no'

  // H) CAMPAIGN / MESSAGING
  campaignName?: string
  templateUseCase?: string
  assignedAgent?: string
  agentPersona?: string
  messageLanguage?: string
  language?: string
  touchNumber?: string
  lastOutboundDateFrom?: string
  lastOutboundDateTo?: string
  lastInboundDateFrom?: string
  lastInboundDateTo?: string
  deliveryStatus?: string
  autoReplyStatus?: string
  suppressionReason?: string

  // I) MARKET / ROUTING
  county?: string
  city?: string
  timezone?: string
  selectedTextGridMarket?: string
  routingTier?: string
  routingRule?: string
  routingAllowed?: 'yes' | 'no'
  bestContactWindow?: string

  // J) TIMELINE
  createdDateFrom?: string
  createdDateTo?: string
  activityDateFrom?: string
  activityDateTo?: string
  nextFollowUpDateFrom?: string
  nextFollowUpDateTo?: string
  scheduledSendDateFrom?: string
  scheduledSendDateTo?: string
  daysSinceLastContactMin?: number
  daysSinceLastContactMax?: number
  touchCountMin?: number
  touchCountMax?: number

  // K) CUSTOM
  tagsInclude?: string[]
  tagsExclude?: string[]
  
  // L) DEAL INTELLIGENCE (NEW)
  arvConfidenceMin?: number
  estimatedSpreadMin?: number
  buyerDemandScoreMin?: number
  ppuBelowMarket?: boolean
  ppsfBelowMarket?: boolean
  largeApartmentPriorityScoreMin?: number
  valuationSnapshotExists?: 'yes' | 'no'

  // Legacy
  householdIncomeMin?: number
  householdIncomeMax?: number
  netAssetValueMin?: number
  netAssetValueMax?: number
  priority?: string
}

export interface InboxFilterState {
  search: string
  stage: InboxStageSelectValue
  view: InboxViewSelectValue
  advanced: InboxAdvancedFilters
}

export type ActivityEntityType =
  | 'sms'
  | 'queue'
  | 'ai'
  | 'stage'
  | 'property'
  | 'offer'
  | 'contract'
  | 'title'
  | 'buyer'
  | 'operator'

export type ActivitySource =
  | 'TextGrid'
  | 'Queue'
  | 'AI Router'
  | 'Operator'
  | 'Podio'
  | 'Supabase'
  | 'Offer Engine'
  | 'Title Engine'
  | 'Buyer Engine'
  | 'Context Engine'
  | 'Workflow Engine'

export type ActivitySeverity = 'positive' | 'neutral' | 'warning' | 'critical' | 'suppressed'

export interface ActivityEvent {
  id: string
  threadId: string
  entityType: ActivityEntityType
  eventType: string
  title: string
  summary: string
  timestamp: string
  source: ActivitySource
  severity: ActivitySeverity
  status?: string
  confidence?: number
  icon?: IconName
  relatedIds?: {
    messageId?: string
    queueRowId?: string
    propertyId?: string
    masterOwnerId?: string
    prospectId?: string
    phoneId?: string
    offerId?: string
    contractId?: string
    buyerMatchId?: string
    templateId?: string
  }
  metadata?: Record<string, unknown>
}

export type ActivityFilterCategory =
  | 'all'
  | 'messages'
  | 'ai'
  | 'queue'
  | 'stage'
  | 'property'
  | 'offer'
  | 'contract'
  | 'title'
  | 'buyer'
  | 'operator'
  | 'errors'

export interface ActivityFilters {
  category: ActivityFilterCategory
  search: string
  importantOnly: boolean
  showSuppressed: boolean
  showAutomationEvents: boolean
  showOperatorEvents: boolean
}

interface ActivityRawSources {
  thread: InboxWorkflowThread
  context: ThreadContext | null
  messages: ThreadMessage[]
}

export interface HeroStat {
  icon: string
  label: string
  value: string
}

export interface RightPanelSection {
  id: string
  title: string
  icon: IconName
  summary: string
  rows: Array<{ label: string; value: string }>
}

export const viewOptions: Array<{ value: InboxViewSelectValue; label: string }> = [
  { value: 'new_replies', label: 'New Replies' },
  { value: 'priority', label: 'Priority' },
  { value: 'negotiating', label: 'Negotiating' },
  { value: 'follow_up_due', label: 'Follow-Up Due' },
  { value: 'waiting_on_seller', label: 'Waiting On Seller' },
  { value: 'automated', label: 'Auto-Eligible' },
  { value: 'needs_review', label: 'Needs Review' },
  { value: 'cold_no_response', label: 'Cold / No Response' },
  { value: 'dead', label: 'Dead / Terminal' },
  { value: 'dnc_opt_out', label: 'DNC / Suppressed' },
  { value: 'all_conversations', label: 'All Conversations' },
  { value: 'all_inbound', label: 'All Inbound History' },
  { value: 'hot_leads', label: 'Hot Leads' },
  { value: 'spanish_language', label: 'Spanish Language' },
]

export const savedFilterOptions: Array<{ value: InboxSavedFilterPreset; label: string }> = [
  { value: 'my_priority', label: 'Priority' },
  { value: 'new_inbounds', label: 'New Replies' },
  { value: 'offer_needed', label: 'Follow-Up Due' },
  { value: 'review_required', label: 'Needs Review' },
  { value: 'positive_hot', label: 'Hot Filter' },
  { value: 'manual_review', label: 'Needs Review' },
  { value: 'needs_reply', label: 'New Replies' },
  { value: 'auto_replied', label: 'Auto-Eligible' },
  { value: 'outbound_only', label: 'Waiting On Seller' },
  { value: 'missing_context', label: 'Cold / No Response' },
  { value: 'suppressed', label: 'DNC / Suppressed' },
]

const toText = (value: unknown): string => String(value ?? '').trim()
const toLower = (value: unknown): string => toText(value).toLowerCase()
const getField = (thread: InboxWorkflowThread, key: string): unknown => {
  const row = thread as unknown as Record<string, unknown>
  return row[key] ?? row[key.charAt(0).toUpperCase() + key.slice(1)] ?? row[key.toLowerCase()]
}

export const resolveThreadPrimaryName = (thread: InboxWorkflowThread): string => {
  return resolveInboxSellerName(thread as unknown as Record<string, unknown>)
}

export const resolveThreadAddressLine = (thread: InboxWorkflowThread): string => {
  return resolveInboxPropertyAddress(thread as unknown as Record<string, unknown>)
}

export const resolveThreadMarketBadge = (thread: InboxWorkflowThread): string => {
  const row = thread as unknown as Record<string, unknown>
  // Prefer the enriched market fields (from v_inbox_enriched / properties.market)
  for (const key of ['displayMarket', 'filterMarket', 'market', 'marketId', 'marketName']) {
    const v = String(row[key] ?? '').trim()
    if (v && v !== 'unknown' && v !== 'Unknown' && v !== 'Unknown Market') return v
  }
  const city = String(row.property_city ?? row.property_address_city ?? '').trim()
  const st = String(row.property_state ?? row.property_address_state ?? row.state ?? '').trim()
  if (city && st) return `${city}, ${st}`
  if (st) return st
  return 'Unknown'
}

const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  const raw = String(value).replace(/[,$\s]/g, '')
  const num = Number(raw)
  return Number.isFinite(num) ? num : null
}

const containsAny = (haystack: string, terms: string[]): boolean => terms.some((term) => haystack.includes(term))

export const KEYWORD_GROUPS = {
  positive_hot: ['yes', 'interested', 'maybe', 'depends', 'i own it', 'make offer', 'call me'],
  offer_requested: ['how much', 'offer', 'price', 'what price'],
  opt_out: ['stop', 'remove', 'unsubscribe'],
  wrong_number: ['wrong number', 'not me', 'no soy', 'no es mio'],
  manual_review: ['attorney', 'lawyer', 'lawsuit', 'legal', 'harassment', 'angry', 'hostile'],
  tenant_rented: ['tenant', 'rented'],
  realtor_agent: ['realtor', 'agent'],
} as const

const searchableThreadText = (thread: InboxWorkflowThread): string => [
  thread.lastMessageBody, thread.preview, thread.latestMessageBody, thread.ownerName, thread.sellerName,
  thread.ownerDisplayName, thread.phoneNumber, thread.canonicalE164, thread.sellerPhone, thread.propertyAddress,
  thread.propertyAddressFull, thread.subject, thread.market, thread.marketId, thread.marketName,
  ...(((thread as unknown as Record<string, unknown>).matched_keywords as string[] | undefined) ?? []),
].filter(Boolean).join(' ').toLowerCase()

export const getThreadMatchedKeywords = (thread: InboxWorkflowThread, query?: string): string[] => {
  const backend = ((thread as unknown as Record<string, unknown>).matched_keywords as string[] | undefined)
    ?? ((thread as unknown as Record<string, unknown>).matchedKeywords as string[] | undefined)
    ?? []
  const words = new Set(backend.map(String).filter(Boolean))
  const q = String(query ?? '').trim().toLowerCase()
  if (q && searchableThreadText(thread).includes(q)) words.add(q)
  for (const group of Object.values(KEYWORD_GROUPS)) {
    for (const word of group) if (searchableThreadText(thread).includes(word)) words.add(word)
  }
  return Array.from(words).slice(0, 6)
}

export const isSuppressedThread = (thread: InboxWorkflowThread): boolean => {
  const priorityBucket = toLower(getField(thread, 'priorityBucket') || getField(thread, 'priority_bucket'))
  if (priorityBucket === 'suppressed') return true

  const blob = [
    thread.conversationStage,
    thread.inboxStatus,
    thread.preview,
    thread.lastMessageBody,
    thread.labels?.join(' '),
    getField(thread, 'opt_out_keyword'),
  ].map(toLower).join(' ')

  return Boolean(
    thread.isOptOut ||
    thread.inboxStatus === 'suppressed' ||
    containsAny(blob, ['opt_out', 'dnc', 'stop', 'unsubscribe', 'suppressed', 'remove me']),
  )
}

const isPriorityCandidate = (thread: InboxWorkflowThread): boolean => {
  return Boolean(getField(thread, 'showInPriorityInbox') ?? getField(thread, 'show_in_priority_inbox'))
}

const matchesStageSelection = (thread: InboxWorkflowThread, stage: InboxStageSelectValue): boolean => {
  if (stage === 'all_stages') return true
  if (stage === 'ownership_confirmation') return containsAny(toLower(thread.lastMessageBody || thread.preview), ['yes', 'mine', 'own'])
  if (stage === 'consider_selling') return containsAny(toLower(thread.lastMessageBody || thread.preview), ['consider', 'maybe', 'depends'])
  if (stage === 'asking_price') return containsAny(toLower(thread.lastMessageBody || thread.preview), ['price', 'offer', 'how much'])
  if (stage === 'condition_probe') return containsAny(toLower(thread.lastMessageBody || thread.preview), ['condition', 'repairs', 'tenant', 'vacant'])
  if (stage === 'offer_sent') return thread.conversationStage === 'offer_reveal' || thread.inboxStatus === 'waiting'
  if (stage === 'needs_response') return thread.inboxStatus === 'new_reply' || thread.inboxStatus === 'needs_review' || Boolean(thread.needsResponse)
  if (stage === 'qualified') return ['offer_reveal', 'negotiation', 'contract_path'].includes(thread.conversationStage)
  if (stage === 'suppressed') return isSuppressedThread(thread)
  if (stage === 'closed') return thread.isArchived || thread.inboxStatus === 'closed'
  return true
}

const bucketFromView = (view: InboxViewSelectValue): InboxBucket | null => {
  if (view === 'new_replies' || view === 'new_inbound' || view === 'needs_reply' || view === 'needs_response') return 'new_replies'
  if (view === 'priority') return 'priority'
  if (view === 'negotiating' || view === 'offer_requested') return 'negotiating'
  if (view === 'follow_up' || view === 'follow_up_due') return 'follow_up'
  if (view === 'cold' || view === 'cold_no_response' || view === 'missing_context' || view === 'not_contacted') return 'cold'
  if (view === 'dead' || view === 'wrong_number') return 'dead'
  if (view === 'waiting_on_seller' || view === 'waiting' || view === 'outbound_only' || view === 'outbound_active') return 'waiting_on_seller'
  if (view === 'automated' || view === 'auto_replied' || view === 'queued') return 'automated'
  if (view === 'needs_review' || view === 'manual_review') return 'needs_review'
  if (view === 'dnc_opt_out' || view === 'suppressed' || view === 'opt_out') return 'suppressed'
  if (view === 'all_conversations' || view === 'all' || view === 'all_messages') return 'all_conversations'
  return null
}

export const matchesViewSelection = (thread: InboxWorkflowThread, view: InboxViewSelectValue): boolean => {
  const decision = buildConversationDecision(thread)
  const canonical = resolveInboxThreadState(thread)
  const isArchived = Boolean(thread.isArchived || thread.inboxStatus === 'closed')

  let matches = true
  if (view === 'archived') matches = isArchived
  else if (view === 'starred') matches = Boolean(thread.isStarred)
  else if (view === 'pinned') matches = Boolean(thread.isPinned)
  else if (view === 'unassigned') {
    const assigned = getField(thread, 'assignedAgent') || getField(thread, 'sms_agent_id') || getField(thread, 'ownerId')
    matches = !assigned
  }
  else if (view === 'all_inbound' || view === 'inbound_all') matches = decision.has_inbound_history
  else if (view === 'hot_leads' || view === 'positive_hot') matches = isHotLeadDecision(decision)
  else if (view === 'spanish_language') matches = decision.language === 'spanish'
  else if (view === 'inbound') matches = canonical.flags.latest_direction === 'inbound' && !isArchived
  else if (view === 'outbound') matches = canonical.flags.latest_direction === 'outbound' && !isArchived
  else if (view === 'active') matches = isActiveCanonicalBucket(canonical.bucket) && decision.suppression_status === 'clear' && !isArchived
  else if (view === 'sent') matches = toLower(getField(thread, 'uiIntent') || getField(thread, 'ui_intent')) === 'sent' && !isArchived
  else if (view === 'failed') matches = toLower(getField(thread, 'uiIntent') || getField(thread, 'ui_intent')) === 'failed' && !isArchived
  else {
    const bucket = bucketFromView(view)
    matches = bucket ? (
      bucket === 'all_conversations'
        ? true
        : (
          bucket === 'waiting_on_seller'
            ? isWaitingInboxState(canonical) && !isArchived
            : bucket === 'follow_up_due'
              ? canonical.bucket === 'follow_up'
              : bucket === 'cold_no_response'
                ? canonical.bucket === 'cold'
                : bucket === 'dnc_suppressed'
                  ? canonical.bucket === 'suppressed'
                  : canonical.bucket === bucket
        )
    ) : true
  }

  return matches
}

const matchesAdvancedFilters = (thread: InboxWorkflowThread, filters: InboxAdvancedFilters): boolean => {
  const market = toLower(getField(thread, 'market') || thread.market || thread.marketId)
  const state = toLower(getField(thread, 'state'))
  const zip = toLower(getField(thread, 'zip') || getField(thread, 'postal_code'))
  const propertyType = toLower(getField(thread, 'propertyType'))
  const ownerType = toLower(getField(thread, 'ownerType'))
  const occupancy = toLower(getField(thread, 'occupancy'))
  const language = toLower(getField(thread, 'language'))
  const bestContactWindow = toLower(getField(thread, 'bestContactWindow'))
  const persona = toLower(getField(thread, 'sellerPersona'))
  const assignedAgent = toLower(getField(thread, 'assignedAgent') || getField(thread, 'sms_agent_id'))

  if (filters.market && !market.includes(toLower(filters.market))) return false
  if (filters.state && !state.includes(toLower(filters.state))) return false
  if (filters.zip && !zip.includes(toLower(filters.zip))) return false
  if (filters.propertyType && !propertyType.includes(toLower(filters.propertyType))) return false
  if (filters.ownerType && !ownerType.includes(toLower(filters.ownerType))) return false
  if (filters.occupancy && !occupancy.includes(toLower(filters.occupancy))) return false
  if (filters.language) {
    if (filters.language === 'non_english') {
      const lang = toLower(getField(thread, 'language') || getField(thread, 'detected_language') || getField(thread, 'sellerLanguage'))
      if (!lang || lang.includes('english') || lang.includes('en')) return false
    } else {
      if (!language.includes(toLower(filters.language))) return false
    }
  }
  if (filters.priority && toLower(thread.priority) !== toLower(filters.priority)) return false
  if (filters.bestContactWindow && !bestContactWindow.includes(toLower(filters.bestContactWindow))) return false
  if (filters.persona && !persona.includes(toLower(filters.persona))) return false
  if (filters.assignedAgent && !assignedAgent.includes(toLower(filters.assignedAgent))) return false

  if (filters.outOfStateOwner && filters.outOfStateOwner !== 'all') {
    const outOfState = Boolean(getField(thread, 'outOfStateOwner') || getField(thread, 'is_out_of_state_owner'))
    if (filters.outOfStateOwner === 'yes' && !outOfState) return false
    if (filters.outOfStateOwner === 'no' && outOfState) return false
  }

  const aiScore = numberOrNull(getField(thread, 'aiScore'))
  const motivation = numberOrNull(getField(thread, 'motivationScore'))
  const beds = numberOrNull(getField(thread, 'beds') || getField(thread, 'bedrooms'))
  const baths = numberOrNull(getField(thread, 'baths') || getField(thread, 'bathrooms'))
  const sellerAge = numberOrNull(getField(thread, 'sellerAge') || getField(thread, 'age'))
  const householdIncome = numberOrNull(getField(thread, 'householdIncome'))
  const netAssetValue = numberOrNull(getField(thread, 'netAssetValue'))
  const estimatedValue = numberOrNull(getField(thread, 'estimatedValue') || getField(thread, 'zestimate'))
  const repairCost = numberOrNull(getField(thread, 'estimatedRepairs') || getField(thread, 'estimatedRepairCost'))
  const cashOffer = numberOrNull(getField(thread, 'cashOffer') || getField(thread, 'mao'))

  if (filters.bedsMin !== undefined && (beds === null || beds < filters.bedsMin)) return false
  if (filters.bathsMin !== undefined && (baths === null || baths < filters.bathsMin)) return false
  if (filters.sellerAgeMin !== undefined && (sellerAge === null || sellerAge < filters.sellerAgeMin)) return false
  if (filters.householdIncomeMin !== undefined && (householdIncome === null || householdIncome < filters.householdIncomeMin)) return false
  if (filters.householdIncomeMax !== undefined && (householdIncome === null || householdIncome > filters.householdIncomeMax)) return false
  if (filters.netAssetValueMin !== undefined && (netAssetValue === null || netAssetValue < filters.netAssetValueMin)) return false
  if (filters.netAssetValueMax !== undefined && (netAssetValue === null || netAssetValue > filters.netAssetValueMax)) return false
  if (filters.aiScoreMin !== undefined && (aiScore === null || aiScore < filters.aiScoreMin)) return false
  if (filters.motivationMin !== undefined && (motivation === null || motivation < filters.motivationMin)) return false
  if (filters.estimatedValueMin !== undefined && (estimatedValue === null || estimatedValue < filters.estimatedValueMin)) return false
  if (filters.estimatedValueMax !== undefined && (estimatedValue === null || estimatedValue > filters.estimatedValueMax)) return false
  if (filters.repairCostMin !== undefined && (repairCost === null || repairCost < filters.repairCostMin)) return false
  if (filters.repairCostMax !== undefined && (repairCost === null || repairCost > filters.repairCostMax)) return false
  if (filters.cashOfferMin !== undefined && (cashOffer === null || cashOffer < filters.cashOfferMin)) return false
  if (filters.cashOfferMax !== undefined && (cashOffer === null || cashOffer > filters.cashOfferMax)) return false

  if (filters.activityDateFrom || filters.activityDateTo) {
    const ts = new Date(thread.lastMessageAt || thread.lastMessageIso || '').getTime()
    if (Number.isFinite(ts)) {
      if (filters.activityDateFrom) {
        const from = new Date(filters.activityDateFrom).getTime()
        if (Number.isFinite(from) && ts < from) return false
      }
      if (filters.activityDateTo) {
        const to = new Date(filters.activityDateTo).getTime()
        if (Number.isFinite(to) && ts > to + 86399999) return false
      }
    }
  }

  return true
}

const matchesSearchInternal = (thread: InboxWorkflowThread, query: string): boolean => {
  if (!query.trim()) return true
  const q = toLower(query)
  return [
    resolveThreadPrimaryName(thread),
    resolveThreadAddressLine(thread),
    getField(thread, 'prospect_name'),
    getField(thread, 'owner_full_name'),
    getField(thread, 'display_phone'),
    thread.ownerName,
    getField(thread, 'owner_display_name'),
    getField(thread, 'seller_name'),
    getField(thread, 'contact_name'),
    thread.phoneNumber,
    thread.canonicalE164,
    thread.propertyAddress,
    thread.subject,
    thread.preview,
    thread.lastMessageBody,
    getField(thread, 'latest_message_body'),
    thread.market,
    thread.marketId,
    getField(thread, 'property_type'),
    getField(thread, 'detected_intent'),
    getField(thread, 'thread_stage'),
    thread.conversationStage,
    thread.inboxStatus,
  ].some((value) => toLower(value).includes(q))
}

export interface ApplyInboxFiltersOptions {
  /** Supabase already filtered by the active view tab. */
  skipViewFilter?: boolean
  /** Supabase already filtered by `stage` when it maps to a persisted workflow stage. */
  skipStageFilter?: boolean
}

export const applyInboxFilters = (
  threads: InboxWorkflowThread[],
  state: InboxFilterState,
  options: ApplyInboxFiltersOptions = {},
): InboxWorkflowThread[] => {
  const skipView = options.skipViewFilter === true
  const skipStage = options.skipStageFilter === true
  return threads.filter((thread) => (
    matchesSearchInternal(thread, state.search) &&
    (skipStage || matchesStageSelection(thread, state.stage)) &&
    (skipView || matchesViewSelection(thread, state.view)) &&
    matchesAdvancedFilters(thread, state.advanced)
  ))
}

export const getPriorityInboxThreads = (threads: InboxWorkflowThread[]): InboxWorkflowThread[] =>
  threads.filter(isPriorityCandidate)

export const getInboxViewCounts = (threads: InboxWorkflowThread[]): Record<string, number> => {
  const canonical = {
    priority: 0,
    new_replies: 0,
    needs_review: 0,
    follow_up: 0,
    cold: 0,
    dead: 0,
    suppressed: 0,
    active: 0,
    waiting: 0,
  }

  for (const thread of threads) {
    const state = resolveInboxThreadState(thread)
    if (state.bucket in canonical) canonical[state.bucket as keyof typeof canonical] += 1
    if (isActiveCanonicalBucket(state.bucket)) canonical.active += 1
    if (isWaitingInboxState(state)) canonical.waiting += 1
  }

  return {
    all_messages: threads.length,
    new_replies: canonical.new_replies,
    needs_reply: canonical.new_replies,
    auto_replied: threads.filter((thread) => matchesViewSelection(thread, 'auto_replied')).length,
    positive_hot: threads.filter((thread) => matchesViewSelection(thread, 'positive_hot')).length,
    wrong_number: canonical.dead,
    opt_out: canonical.suppressed,
    missing_context: canonical.cold,
    manual_review: canonical.needs_review,
    priority: canonical.priority,
    negotiating: threads.filter((thread) => matchesViewSelection(thread, 'negotiating')).length,
    follow_up_due: canonical.follow_up,
    follow_up: canonical.follow_up,
    cold: canonical.cold,
    dead: canonical.dead,
    waiting_on_seller: canonical.waiting,
    automated: threads.filter((thread) => matchesViewSelection(thread, 'automated')).length,
    active: canonical.active,
    waiting: canonical.waiting,
    suppressed: canonical.suppressed,
    starred: threads.filter((thread) => matchesViewSelection(thread, 'starred')).length,
    pinned: threads.filter((thread) => matchesViewSelection(thread, 'pinned')).length,
    unassigned: threads.filter((thread) => matchesViewSelection(thread, 'unassigned')).length,
    needs_review: canonical.needs_review,
    archived: threads.filter((thread) => matchesViewSelection(thread, 'archived')).length,
    all_inbound: threads.filter((thread) => matchesViewSelection(thread, 'all_inbound')).length,
    hot_leads: canonical.priority,
    spanish_language: threads.filter((thread) => matchesViewSelection(thread, 'spanish_language')).length,
    sent: threads.filter((thread) => matchesViewSelection(thread, 'sent')).length,
    queued: threads.filter((thread) => matchesViewSelection(thread, 'queued')).length,
    failed: threads.filter((thread) => matchesViewSelection(thread, 'failed')).length,
    all: threads.length,
  }
}

export const getSavedPresetConfig = (preset: InboxSavedFilterPreset): Partial<InboxFilterState> => {
  if (preset === 'all_messages') return { view: 'all_conversations' }
  if (preset === 'inbound_only') return { view: 'inbound' }
  if (preset === 'outbound_only') return { view: 'outbound' }
  if (preset === 'needs_reply') return { view: 'new_replies' }
  if (preset === 'positive_hot') return { view: 'hot_leads' }
  if (preset === 'manual_review') return { view: 'needs_review' }
  if (preset === 'auto_replied') return { view: 'automated' }
  if (preset === 'missing_context') return { view: 'cold' }
  if (preset === 'all_inbound' || preset === 'inbound_all') return { view: 'all_inbound' }
  if (preset === 'my_priority') return { view: 'priority' }
  if (preset === 'new_inbounds') return { view: 'new_replies', stage: 'all_stages' }
  if (preset === 'high_motivation') return { view: 'active', advanced: { motivationMin: 70 } }
  if (preset === 'offer_needed') return { view: 'follow_up', stage: 'all_stages' }
  if (preset === 'review_required') return { view: 'needs_review', stage: 'all_stages' }
  if (preset === 'suppressed') return { view: 'suppressed' }
  if (preset === 'language_focus') return { view: 'spanish_language', advanced: { language: 'spanish' } }
  if (preset === 'wrong_numbers') return { view: 'wrong_number' }
  if (preset === 'starred') return { view: 'starred', stage: 'all_stages' }
  if (preset === 'pinned') return { view: 'pinned', stage: 'all_stages' }
  if (preset === 'unassigned') return { view: 'unassigned', stage: 'all_stages' }
  return {}
}

const formatCurrency = (value: unknown): string => {
  const n = numberOrNull(value)
  if (n === null) return 'Unknown'
  return `$${Math.round(n).toLocaleString()}`
}

export const buildPropertyHeroStats = (thread: InboxWorkflowThread, context: ThreadContext | null): HeroStat[] => {
  const beds = toText(getField(thread, 'beds') || getField(thread, 'bedrooms') || 'Unknown')
  const baths = toText(getField(thread, 'baths') || getField(thread, 'bathrooms') || 'Unknown')
  const sqft = toText(getField(thread, 'sqft') || getField(thread, 'livingAreaSqft') || 'Unknown')

  return [
    { icon: '🏠', label: 'Type', value: toText(getField(thread, 'propertyType') || 'Unknown') },
    { icon: '🛏', label: 'Beds', value: beds },
    { icon: '🛁', label: 'Baths', value: baths },
    { icon: '📐', label: 'Sqft', value: sqft },
    { icon: '🗓', label: 'Year Built', value: toText(getField(thread, 'yearBuilt') || 'Unknown') },
    { icon: '🗓', label: 'Effective Year', value: toText(getField(thread, 'effectiveYearBuilt') || 'Unknown') },
    { icon: '💰', label: 'Estimated Value', value: formatCurrency(getField(thread, 'estimatedValue') || getField(thread, 'zestimate')) },
    { icon: '🛠', label: 'Repair Cost', value: formatCurrency(getField(thread, 'estimatedRepairs') || getField(thread, 'estimatedRepairCost')) },
    { icon: '⚡', label: 'Cash Offer', value: formatCurrency(getField(thread, 'cashOffer') || getField(thread, 'mao')) },
    { icon: '📍', label: 'Market', value: toText(context?.property?.market || thread.market || thread.marketId || 'Unknown') },
  ]
}

const row = (label: string, value: unknown): { label: string; value: string } => ({
  label,
  value: toText(value) || 'Unknown',
})

export const buildRightPanelSections = (
  thread: InboxWorkflowThread,
  context: ThreadContext | null,
  isSuppressed: boolean,
): RightPanelSection[] => {
  const get = (key: string) => getField(thread, key)
  return [
    {
      id: 'property_details',
      title: 'Property Details',
      icon: 'map',
      summary: `${toText(get('propertyType') || 'Unknown')} • ${toText(get('sqft') || 'Unknown')} sqft`,
      rows: [
        row('APN', get('apn')),
        row('County', get('county')),
        row('Market', context?.property?.market || thread.market || thread.marketId),
        row('Beds / Baths', `${toText(get('beds') || get('bedrooms') || 'Unknown')} / ${toText(get('baths') || get('bathrooms') || 'Unknown')}`),
        row('Sqft', get('sqft') || get('livingAreaSqft')),
        row('Lot Size', get('lotSize') || get('lotSizeSqft') || get('lotSizeAcres')),
        row('Year Built', get('yearBuilt')),
        row('Effective Year Built', get('effectiveYearBuilt')),
        row('Construction Type', get('constructionType')),
        row('Exterior Walls', get('exteriorWalls')),
        row('Roof Type', get('roofType') || get('roofCover')),
        row('HVAC / Heating / AC', [get('hvac'), get('heatingType'), get('airConditioning')].filter(Boolean).join(' / ')),
        row('Occupancy', get('occupancy')),
        row('Ownership Years', get('ownershipYears')),
        row('Last Sale', `${toText(get('lastSaleDate'))} ${toText(get('lastSalePrice'))}`.trim()),
        row('Assessed Values', [get('totalValue'), get('landValue'), get('improvementValue')].filter(Boolean).join(' / ')),
        row('Loan Balance', get('totalLoanBalance')),
        row('Equity', get('equityAmount') || get('equityPercent')),
        row('Rehab Level', get('rehabLevel')),
        row('Condition', get('buildingCondition')),
        row('Valuation Context', get('valuationContext')),
      ],
    },
    {
      id: 'prospect',
      title: 'Prospect',
      icon: 'user',
      summary: `${toText(context?.seller?.name || thread.ownerName || 'Unknown')} • ${toText(context?.phone || thread.phoneNumber || 'No phone')}`,
      rows: [
        row('Name', context?.seller?.name || thread.ownerName),
        row('Age', get('sellerAge') || get('age')),
        row('Phone', context?.phone || thread.phoneNumber || thread.canonicalE164),
        row('Email', get('email')),
        row('Contact Tags', get('contactMatchingTags')),
        row('Household Income', get('householdIncome')),
        row('Net Asset Value', get('netAssetValue')),
        row('Buyer Power / Seller Power', `${toText(get('buyerPower'))} / ${toText(get('sellerPower'))}`.trim()),
        row('Seller Tags', get('sellerTags')),
        row('Communication Preference', get('communicationPreference')),
        row('Language', get('language')),
      ],
    },
    {
      id: 'owner',
      title: 'Owner',
      icon: 'users',
      summary: `${toText(get('ownerDisplayName') || thread.ownerName || 'Unknown')} • ${toText(get('ownerType') || 'Unknown')}`,
      rows: [
        row('Owner Display Name', get('ownerDisplayName') || thread.ownerName),
        row('Owner Type', get('ownerType')),
        row('Mailing Address', get('ownerAddress')),
        row('Out of State Owner', get('outOfStateOwner') || get('is_out_of_state_owner')),
        row('Portfolio Value', get('portfolioValue')),
        row('Property Count', get('portfolioPropertyCount')),
        row('Total Units', get('totalUnits')),
        row('Financial Pressure Score', get('financialPressureScore')),
        row('Priority Score', get('priorityScore') || thread.priority),
        row('Best Contact Window', get('bestContactWindow')),
        row('Timezone', get('timezone')),
      ],
    },
    {
      id: 'deal_intelligence',
      title: 'Deal Intelligence',
      icon: 'brain',
      summary: `${toText(get('aiScore') || 'Unknown')} AI • ${toText(thread.conversationStage)} stage`,
      rows: [
        row('AI Score', get('aiScore')),
        row('Sentiment', thread.sentiment),
        row('Priority', thread.priority),
        row('Stage', isSuppressed ? 'suppressed' : thread.conversationStage),
        row('Deal Status', thread.inboxStatus),
        row('Next Action', context?.dealContext?.nextAction || (isSuppressed ? 'No message needed' : 'Review thread')),
        row('Motivation Flags', get('motivationFlagsCount')),
        row('Seller Persona', get('sellerPersona')),
        row('Distress Count', get('distressCount')),
        row('Estimated Close Probability', get('closeProbability')),
        row('Negotiation Posture', get('negotiationPosture')),
        row('Confidence', get('confidenceBand') || get('confidence')),
      ],
    },
    {
      id: 'buyer_intelligence',
      title: 'Buyer Intelligence',
      icon: 'target',
      summary: `${toText(get('buyerMatchCount') || '0')} matches • ${toText(get('bestBuyerType') || 'Unknown')}`,
      rows: [
        row('Buyer Match Count', get('buyerMatchCount')),
        row('Best Buyer Type', get('bestBuyerType')),
        row('Likely Exit Strategy', get('likelyExitStrategy')),
        row('Dispo Fit', get('dispoFit')),
        row('Cash Buyer Demand', get('cashBuyerDemand')),
        row('Rent Estimate / ARV', `${toText(get('rentEstimate'))} / ${toText(get('arv'))}`.trim()),
        row('Investor Demand in ZIP', get('investorDemandZip')),
        row('Multifamily / SFR Fit', `${toText(get('multifamilyFit'))} / ${toText(get('sfrFit'))}`.trim()),
      ],
    },
    {
      id: 'underwriting_offer',
      title: 'Underwriting / Offer',
      icon: 'zap',
      summary: `${formatCurrency(get('cashOffer') || get('mao'))} MAO • ${toText(get('offerStrategy') || 'Unknown')}`,
      rows: [
        row('Estimated Value', formatCurrency(get('estimatedValue') || get('zestimate'))),
        row('Repair Cost', formatCurrency(get('estimatedRepairs') || get('estimatedRepairCost'))),
        row('MAO / Cash Offer', formatCurrency(get('cashOffer') || get('mao'))),
        row('Offer Strategy', get('offerStrategy')),
        row('Creative Options', get('creativeOptions')),
        row('Spread', get('spread')),
        row('Assignment Potential', get('assignmentPotential')),
        row('Terms Candidate', get('termsCandidate')),
        row('Confidence Band', get('confidenceBand')),
        row('Offer Verification', get('offerVerificationStatus')),
      ],
    },
    {
      id: 'links_tools',
      title: 'Links / Tools',
      icon: 'arrow-up-right',
      summary: 'External sources and workflow tools',
      rows: [
        row('Street View', get('streetViewUrl')),
        row('Zillow', get('zillowUrl')),
        row('Redfin', get('redfinUrl')),
        row('Realtor', get('realtorUrl')),
        row('County Records', get('countyRecordsUrl')),
        row('Map View', 'Open map drawer'),
        row('Comps', 'Open comps in dossier'),
        row('Title', 'Open title packet'),
        row('Contract', 'Generate contract'),
        row('Send Offer', 'Open offer workflow'),
      ],
    },
  ]
}

const buildBaseEvent = (
  threadId: string,
  partial: Omit<ActivityEvent, 'threadId' | 'icon' | 'severity'> & Pick<ActivityEvent, 'eventType'>,
): ActivityEvent => {
  const base: ActivityEvent = {
    ...partial,
    threadId,
    severity: 'neutral',
    icon: 'activity',
  }
  return {
    ...base,
    icon: getActivityEventIcon(base),
    severity: getActivitySeverity(base),
  }
}

export const summarizeActivityEvent = (event: ActivityEvent): string => {
  const text = toText(event.summary)
  if (!text) return 'No summary available.'
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}

export const formatActivityTimestamp = (timestamp: string): string => {
  const ms = new Date(timestamp).getTime()
  if (!Number.isFinite(ms)) return 'Unknown time'
  const now = Date.now()
  const delta = Math.max(0, now - ms)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return 'Just now'
  if (delta < hour) return `${Math.max(1, Math.floor(delta / minute))}m ago`
  if (delta < day) return `${Math.floor(delta / hour)}h ago`
  if (delta < 7 * day) return `${Math.floor(delta / day)}d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export const getActivityEventIcon = (event: ActivityEvent): IconName => {
  if (event.severity === 'critical' || event.entityType === 'queue' && event.eventType.includes('failed')) return 'alert'
  if (event.eventType.includes('opt_out') || event.severity === 'suppressed') return 'shield'
  if (event.entityType === 'sms') return 'message'
  if (event.entityType === 'queue') return 'clock'
  if (event.entityType === 'ai') return 'brain'
  if (event.entityType === 'stage') return 'layers'
  if (event.entityType === 'property') return 'map'
  if (event.entityType === 'offer') return 'zap'
  if (event.entityType === 'contract') return 'file-text'
  if (event.entityType === 'title') return 'briefing'
  if (event.entityType === 'buyer') return 'target'
  if (event.entityType === 'operator') return 'user'
  return 'activity'
}

export const getActivitySourceBadge = (event: ActivityEvent): string => event.source

export const getActivitySeverity = (event: ActivityEvent): ActivitySeverity => {
  const text = `${event.eventType} ${event.title} ${event.summary} ${event.status || ''}`.toLowerCase()
  if (containsAny(text, ['opt_out', 'suppressed', 'no message needed', 'wrong number', 'not interested'])) return 'suppressed'
  if (containsAny(text, ['failed', 'hostile', 'legal', 'max retries', 'compliance', 'missing context', 'context mismatch'])) return 'critical'
  if (containsAny(text, ['blocked', 'retry', 'warning', 'paused', 'pending'])) return 'warning'
  if (containsAny(text, ['positive', 'interested', 'offer', 'signed', 'clear to close', 'buyer interested', 'generated'])) return 'positive'
  return 'neutral'
}

export const buildSmsActivityEvents = (thread: InboxWorkflowThread, messageEvents: ThreadMessage[]): ActivityEvent[] => {
  const threadId = thread.id
  const events: ActivityEvent[] = []

  messageEvents.forEach((message) => {
    const outbound = message.direction === 'outbound'
    const source: ActivitySource = outbound ? 'TextGrid' : 'Supabase'
    const status = toLower(message.deliveryStatus)
    const body = toText(message.body) || 'No message body'
    const trimmedBody = body.length > 140 ? `${body.slice(0, 137)}...` : body

    events.push(buildBaseEvent(threadId, {
      id: `sms-${message.id}`,
      entityType: 'sms',
      eventType: outbound ? 'outbound_sent' : 'inbound_received',
      title: outbound ? 'Outbound Sent' : 'Inbound Received',
      summary: outbound
        ? `"${trimmedBody}" sent to ${toText(message.toNumber) || 'recipient'}.`
        : `"${trimmedBody}" received from ${toText(message.fromNumber) || 'seller'}.`,
      timestamp: message.createdAt,
      source,
      status: outbound ? 'Sent' : 'Received',
      relatedIds: {
        messageId: message.id,
        propertyId: message.propertyId || undefined,
        masterOwnerId: message.ownerId || undefined,
        prospectId: message.prospectId || undefined,
        templateId: message.templateId || undefined,
      },
      metadata: {
        fromNumber: message.fromNumber,
        toNumber: message.toNumber,
        deliveryStatus: message.deliveryStatus,
        rawStatus: message.rawStatus,
      },
    }))

    if (!outbound) {
      const inboundText = body.toLowerCase()
      if (containsAny(inboundText, ['stop', 'unsubscribe', 'do not text'])) {
        events.push(buildBaseEvent(threadId, {
          id: `sms-optout-${message.id}`,
          entityType: 'sms',
          eventType: 'opt_out_detected',
          title: 'Opt-Out Logged',
          summary: 'Seller requested no further messages. Thread suppressed. No reply queued.',
          timestamp: message.createdAt,
          source: 'AI Router',
          status: 'Suppressed',
          relatedIds: { messageId: message.id, masterOwnerId: message.ownerId || undefined },
          metadata: { optOutKeyword: 'stop' },
        }))
      }

      if (containsAny(inboundText, ['wrong number', 'wrong person'])) {
        events.push(buildBaseEvent(threadId, {
          id: `sms-wrong-${message.id}`,
          entityType: 'sms',
          eventType: 'wrong_number_detected',
          title: 'Wrong Number Detected',
          summary: 'Thread marked wrong person. Follow-up suppressed unless manually reopened.',
          timestamp: message.createdAt,
          source: 'AI Router',
          status: 'Suppressed',
          relatedIds: { messageId: message.id },
        }))
      }

      if (containsAny(inboundText, ['not interested', 'not selling', 'not for sale'])) {
        events.push(buildBaseEvent(threadId, {
          id: `sms-not-interested-${message.id}`,
          entityType: 'sms',
          eventType: 'not_interested_detected',
          title: 'Not Interested',
          summary: 'Seller declined. Thread hidden from Priority Inbox.',
          timestamp: message.createdAt,
          source: 'AI Router',
          status: 'Suppressed',
          relatedIds: { messageId: message.id },
        }))
      }

      if (containsAny(inboundText, ['yes', 'interested', 'how much', 'offer'])) {
        events.push(buildBaseEvent(threadId, {
          id: `sms-positive-${message.id}`,
          entityType: 'sms',
          eventType: 'positive_interested_detected',
          title: 'Positive Reply',
          summary: 'Seller may be open to selling. Review or continue seller flow.',
          timestamp: message.createdAt,
          source: 'AI Router',
          status: 'Actionable',
          relatedIds: { messageId: message.id },
        }))
      }
    }

    if (outbound) {
      if (status === 'delivered') {
        events.push(buildBaseEvent(threadId, {
          id: `sms-delivered-${message.id}`,
          entityType: 'sms',
          eventType: 'outbound_delivered',
          title: 'Message Delivered',
          summary: `Outbound SMS delivered to ${toText(message.toNumber) || 'seller'}.`,
          timestamp: message.deliveredAt || message.createdAt,
          source: 'TextGrid',
          status: 'Delivered',
          relatedIds: { messageId: message.id },
        }))
      }

      if (status === 'pending' || status === 'queued' || status === 'scheduled') {
        events.push(buildBaseEvent(threadId, {
          id: `sms-pending-${message.id}`,
          entityType: 'sms',
          eventType: 'outbound_pending',
          title: 'Outbound Pending',
          summary: 'Message is queued for delivery reconciliation.',
          timestamp: message.createdAt,
          source: 'TextGrid',
          status: message.deliveryStatus,
          relatedIds: { messageId: message.id },
        }))
      }

      if (status === 'failed' || message.error) {
        events.push(buildBaseEvent(threadId, {
          id: `sms-failed-${message.id}`,
          entityType: 'sms',
          eventType: 'outbound_failed',
          title: 'Send Failed',
          summary: message.error || 'Provider failed to deliver outbound SMS.',
          timestamp: message.deliveredAt || message.createdAt,
          source: 'TextGrid',
          status: 'Failed',
          relatedIds: { messageId: message.id },
          metadata: {
            rawStatus: message.rawStatus,
            error: message.error,
          },
        }))
      }
    }
  })

  return events
}

export const buildQueueActivityEvents = (thread: InboxWorkflowThread, context: ThreadContext | null): ActivityEvent[] => {
  const threadId = thread.id
  const events: ActivityEvent[] = []
  const ts = thread.updatedAt || thread.lastMessageAt

  if (thread.queueStatus) {
    const normalized = toLower(thread.queueStatus)
    const title = normalized === 'queued'
      ? 'Reply Queued'
      : normalized === 'scheduled'
        ? 'Scheduled Message Created'
        : normalized === 'failed'
          ? 'Queue Send Failed'
          : 'Queue Updated'

    events.push(buildBaseEvent(threadId, {
      id: `queue-${normalized}`,
      entityType: 'queue',
      eventType: normalized === 'failed' ? 'send_failed' : 'queued_reply_created',
      title,
      summary: `Queue status is ${thread.queueStatus}.`,
      timestamp: ts,
      source: 'Queue',
      status: thread.queueStatus,
    }))
  }

  context?.queueContext?.items?.forEach((item) => {
    const status = toLower(item.status)
    events.push(buildBaseEvent(threadId, {
      id: `queue-item-${item.id}`,
      entityType: 'queue',
      eventType: status === 'blocked' ? 'queue_item_blocked' : status === 'suppressed' ? 'queue_item_suppressed' : 'queue_item_sent',
      title: status === 'blocked' ? 'Queue Item Blocked' : status === 'suppressed' ? 'Reply Suppressed' : 'Queue Item Sent',
      summary: `Queue item ${item.id.slice(0, 8)} status ${item.status}.`,
      timestamp: item.scheduleAt || ts,
      source: 'Queue',
      status: item.status,
      relatedIds: { queueRowId: item.id },
    }))
  })

  return events
}

export const buildBrainActivityEvents = (thread: InboxWorkflowThread, context: ThreadContext | null): ActivityEvent[] => {
  const ts = thread.updatedAt || thread.lastMessageAt
  const events: ActivityEvent[] = [
    buildBaseEvent(thread.id, {
      id: 'brain-stage-inferred',
      entityType: 'ai',
      eventType: 'stage_inferred',
      title: 'Stage Inferred',
      summary: `Workflow stage inferred as ${thread.conversationStage}.`,
      timestamp: ts,
      source: 'AI Router',
      confidence: numberOrNull(getField(thread, 'confidence')) ?? undefined,
    }),
  ]

  if (thread.aiDraft) {
    events.push(buildBaseEvent(thread.id, {
      id: 'brain-ai-reply',
      entityType: 'ai',
      eventType: 'ai_reply_generated',
      title: 'AI Reply Generated',
      summary: `${thread.aiDraft.slice(0, 130)}${thread.aiDraft.length > 130 ? '...' : ''}`,
      timestamp: ts,
      source: 'AI Router',
      confidence: numberOrNull(getField(thread, 'confidence')) ?? undefined,
      metadata: {
        aiSummary: context?.aiContext?.summary,
        aiIntent: context?.aiContext?.intent,
        aiSentiment: context?.aiContext?.sentiment,
      },
    }))
  }

  if (context?.contextMatchQuality === 'missing' || context?.contextMatchQuality === 'low') {
    events.push(buildBaseEvent(thread.id, {
      id: 'brain-context-failed',
      entityType: 'ai',
      eventType: 'context_verification_failed',
      title: 'Context Verification Failed',
      summary: 'Missing property/owner context. Fallback context used.',
      timestamp: ts,
      source: 'Context Engine',
      status: context.contextMatchQuality,
      metadata: context.contextDebug as unknown as Record<string, unknown>,
    }))
  } else {
    events.push(buildBaseEvent(thread.id, {
      id: 'brain-context-matched',
      entityType: 'ai',
      eventType: 'context_matched',
      title: 'Context Matched',
      summary: 'Matched inbound to last valid sent queue row.',
      timestamp: ts,
      source: 'Context Engine',
      status: 'Verified',
    }))
  }

  return events
}

export const buildPropertyActivityEvents = (thread: InboxWorkflowThread, context: ThreadContext | null): ActivityEvent[] => {
  const ts = thread.updatedAt || thread.lastMessageAt
  const events: ActivityEvent[] = []

  if (thread.propertyId || context?.property?.id) {
    events.push(buildBaseEvent(thread.id, {
      id: 'property-linked',
      entityType: 'property',
      eventType: 'property_linked',
      title: 'Property Linked',
      summary: `${toText(context?.property?.address || thread.propertyAddress || 'Property record linked')}.`,
      timestamp: ts,
      source: 'Supabase',
      relatedIds: { propertyId: thread.propertyId || context?.property?.id || undefined },
    }))
  }

  if (thread.ownerId || context?.seller?.id) {
    events.push(buildBaseEvent(thread.id, {
      id: 'owner-linked',
      entityType: 'property',
      eventType: 'owner_linked',
      title: 'Owner Linked',
      summary: `${toText(context?.seller?.name || thread.ownerName || 'Owner profile linked')}.`,
      timestamp: ts,
      source: 'Supabase',
      relatedIds: {
        masterOwnerId: thread.ownerId || context?.seller?.id || undefined,
        prospectId: thread.prospectId || undefined,
      },
    }))
  }

  if (!(thread.ownerId || context?.seller?.id) || !(thread.propertyId || context?.property?.id)) {
    events.push(buildBaseEvent(thread.id, {
      id: 'property-missing-context',
      entityType: 'property',
      eventType: 'missing_context_detected',
      title: 'Missing Context Detected',
      summary: 'Property/owner linkage is incomplete. Verify before sending offer.',
      timestamp: ts,
      source: 'Context Engine',
      status: 'Needs review',
    }))
  }

  return events
}

export const buildOfferActivityEvents = (thread: InboxWorkflowThread): ActivityEvent[] => {
  const ts = thread.updatedAt || thread.lastMessageAt
  const offerValue = numberOrNull(getField(thread, 'cashOffer') || getField(thread, 'mao'))
  const estimatedValue = numberOrNull(getField(thread, 'estimatedValue') || getField(thread, 'zestimate'))
  const repairValue = numberOrNull(getField(thread, 'estimatedRepairs') || getField(thread, 'estimatedRepairCost'))
  const events: ActivityEvent[] = []

  if (offerValue !== null) {
    events.push(buildBaseEvent(thread.id, {
      id: 'offer-generated',
      entityType: 'offer',
      eventType: 'cash_offer_generated',
      title: 'Offer Generated',
      summary: `Offer amount ${formatCurrency(offerValue)} ready for review.`,
      timestamp: ts,
      source: 'Offer Engine',
      status: 'Generated',
      relatedIds: { offerId: toText(getField(thread, 'offerId')) || undefined, propertyId: thread.propertyId || undefined },
    }))
  }

  if (estimatedValue !== null || repairValue !== null) {
    events.push(buildBaseEvent(thread.id, {
      id: 'offer-underwriting-updated',
      entityType: 'offer',
      eventType: 'underwriting_updated',
      title: 'Underwriting Updated',
      summary: `ARV ${formatCurrency(estimatedValue)} • Repairs ${formatCurrency(repairValue)} • MAO ${formatCurrency(offerValue)}.`,
      timestamp: ts,
      source: 'Offer Engine',
      status: 'Verified',
      metadata: {
        arv: estimatedValue,
        repairs: repairValue,
        mao: offerValue,
      },
    }))
  }

  return events
}

export const buildContractActivityEvents = (thread: InboxWorkflowThread): ActivityEvent[] => {
  const stage = toLower(thread.conversationStage)
  const ts = thread.updatedAt || thread.lastMessageAt
  const events: ActivityEvent[] = []

  if (containsAny(stage, ['contract'])) {
    events.push(buildBaseEvent(thread.id, {
      id: 'contract-created',
      entityType: 'contract',
      eventType: 'contract_generated',
      title: 'Contract Created',
      summary: 'Contract packet prepared for seller execution.',
      timestamp: ts,
      source: 'Workflow Engine',
      status: 'Created',
      relatedIds: { contractId: toText(getField(thread, 'contractId')) || undefined },
    }))
  }

  return events
}

export const buildBuyerActivityEvents = (thread: InboxWorkflowThread): ActivityEvent[] => {
  const count = numberOrNull(getField(thread, 'buyerMatchCount'))
  if (count === null) return []
  return [
    buildBaseEvent(thread.id, {
      id: 'buyer-match-updated',
      entityType: 'buyer',
      eventType: 'buyer_match_count_updated',
      title: 'Buyer Match Updated',
      summary: `${count} buyer match${count === 1 ? '' : 'es'} available for dispo review.`,
      timestamp: thread.updatedAt || thread.lastMessageAt,
      source: 'Buyer Engine',
      status: count > 0 ? 'Matched' : 'No match',
      relatedIds: { buyerMatchId: toText(getField(thread, 'buyerMatchId')) || undefined },
    }),
  ]
}

export const buildTitleActivityEvents = (thread: InboxWorkflowThread): ActivityEvent[] => {
  const stage = toLower(thread.conversationStage)
  if (!containsAny(stage, ['title', 'closing'])) return []
  return [
    buildBaseEvent(thread.id, {
      id: 'title-progress',
      entityType: 'title',
      eventType: 'sent_to_title',
      title: 'Sent to Title',
      summary: 'Title workflow opened. Waiting for title clearance updates.',
      timestamp: thread.updatedAt || thread.lastMessageAt,
      source: 'Title Engine',
      status: 'In progress',
    }),
  ]
}

const buildStageActivityEvents = (thread: InboxWorkflowThread): ActivityEvent[] => {
  const events: ActivityEvent[] = [
    buildBaseEvent(thread.id, {
      id: 'stage-changed',
      entityType: 'stage',
      eventType: 'stage_changed',
      title: 'Stage Advanced',
      summary: `Lead is currently in ${thread.conversationStage.replace(/_/g, ' ')}.`,
      timestamp: thread.updatedAt || thread.lastMessageAt,
      source: 'Workflow Engine',
      status: thread.conversationStage,
    }),
  ]

  if (thread.needsResponse) {
    events.push(buildBaseEvent(thread.id, {
      id: 'stage-needs-response',
      entityType: 'stage',
      eventType: 'lead_marked_needs_response',
      title: 'Lead Marked Needs Response',
      summary: 'Inbound requires operator or automation follow-up.',
      timestamp: thread.lastMessageAt,
      source: 'Workflow Engine',
      status: 'Needs response',
    }))
  }

  return events
}

const buildOperatorActivityEvents = (thread: InboxWorkflowThread): ActivityEvent[] => [
  buildBaseEvent(thread.id, {
    id: 'operator-priority',
    entityType: 'operator',
    eventType: 'priority_changed',
    title: 'Priority Changed',
    summary: `Priority set to ${thread.priority}.`,
    timestamp: thread.updatedAt || thread.lastMessageAt,
    source: 'Operator',
    status: thread.priority,
  }),
]

export const normalizeActivityEvents = (rawSources: ActivityRawSources): ActivityEvent[] => {
  const { thread, context, messages } = rawSources
  const all = [
    ...buildSmsActivityEvents(thread, messages),
    ...buildQueueActivityEvents(thread, context),
    ...buildBrainActivityEvents(thread, context),
    ...buildStageActivityEvents(thread),
    ...buildPropertyActivityEvents(thread, context),
    ...buildOfferActivityEvents(thread),
    ...buildContractActivityEvents(thread),
    ...buildBuyerActivityEvents(thread),
    ...buildTitleActivityEvents(thread),
    ...buildOperatorActivityEvents(thread),
  ]

  return all
    .filter((event) => Boolean(event.timestamp))
    .map((event) => ({ ...event, summary: summarizeActivityEvent(event) }))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
}

const startOfDay = (ms: number): number => {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export const groupActivityEventsByTime = (events: ActivityEvent[]): Array<{ label: string; events: ActivityEvent[] }> => {
  const now = Date.now()
  const todayStart = startOfDay(now)
  const yesterdayStart = todayStart - 86_400_000
  const weekStart = todayStart - (6 * 86_400_000)

  const groups: Array<{ label: string; events: ActivityEvent[] }> = [
    { label: 'Just now', events: [] },
    { label: 'Today', events: [] },
    { label: 'Yesterday', events: [] },
    { label: 'This week', events: [] },
    { label: 'Older', events: [] },
  ]

  events.forEach((event) => {
    const ms = new Date(event.timestamp).getTime()
    if (!Number.isFinite(ms)) {
      groups[4].events.push(event)
      return
    }

    if (now - ms <= 15 * 60_000) {
      groups[0].events.push(event)
      return
    }
    if (ms >= todayStart) {
      groups[1].events.push(event)
      return
    }
    if (ms >= yesterdayStart) {
      groups[2].events.push(event)
      return
    }
    if (ms >= weekStart) {
      groups[3].events.push(event)
      return
    }
    groups[4].events.push(event)
  })

  return groups.filter((group) => group.events.length > 0)
}

const categoryMatches = (event: ActivityEvent, category: ActivityFilterCategory): boolean => {
  if (category === 'all') return true
  if (category === 'messages') return event.entityType === 'sms'
  if (category === 'ai') return event.entityType === 'ai'
  if (category === 'queue') return event.entityType === 'queue'
  if (category === 'stage') return event.entityType === 'stage'
  if (category === 'property') return event.entityType === 'property'
  if (category === 'offer') return event.entityType === 'offer'
  if (category === 'contract') return event.entityType === 'contract'
  if (category === 'title') return event.entityType === 'title'
  if (category === 'buyer') return event.entityType === 'buyer'
  if (category === 'operator') return event.entityType === 'operator'
  if (category === 'errors') return event.severity === 'critical' || event.severity === 'warning'
  return true
}

export const filterActivityEvents = (events: ActivityEvent[], filters: ActivityFilters): ActivityEvent[] => {
  const search = toLower(filters.search)

  return events.filter((event) => {
    if (!categoryMatches(event, filters.category)) return false
    if (!filters.showSuppressed && event.severity === 'suppressed') return false

    const isOperator = event.entityType === 'operator'
    const isAutomation = !isOperator
    if (!filters.showOperatorEvents && isOperator) return false
    if (!filters.showAutomationEvents && isAutomation) return false

    if (filters.importantOnly && !(event.severity === 'critical' || event.severity === 'warning' || event.severity === 'positive' || event.severity === 'suppressed')) {
      return false
    }

    if (!search) return true
    const blob = `${event.title} ${event.summary} ${event.eventType} ${event.source} ${event.status || ''}`.toLowerCase()
    return blob.includes(search)
  })
}

export const getThreadActivityFeed = (
  thread: InboxWorkflowThread,
  context: ThreadContext | null,
  messages: ThreadMessage[],
): ActivityEvent[] => normalizeActivityEvents({ thread, context, messages })

export const getAdvancedFilterOptions = (threads: InboxWorkflowThread[]) => {
  const collect = (key: string): string[] => {
    const set = new Set<string>()
    threads.forEach((thread) => {
      const value = toText(getField(thread, key))
      if (value) set.add(value)
    })
    return Array.from(set).sort((a, b) => a.localeCompare(b)).slice(0, 100)
  }

  const marketSet = new Set<string>()
  threads.forEach((thread) => {
    const market = toText(thread.market || thread.marketId)
    if (market) marketSet.add(market)
  })

  return {
    markets: Array.from(marketSet).sort((a, b) => a.localeCompare(b)),
    states: collect('state'),
    zips: collect('zip'),
    propertyTypes: collect('propertyType'),
    ownerTypes: collect('ownerType'),
    occupancies: collect('occupancy'),
    languages: collect('language'),
    personas: collect('sellerPersona'),
    assignedAgents: collect('assignedAgent'),
  }
}
