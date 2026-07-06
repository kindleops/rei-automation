export type InboxRealtimeStatus = 'connected' | 'connecting' | 'disconnected' | 'error' | 'disabled'

export type InboxConnectionState = 'live' | 'offline' | 'reconnecting' | 'degraded_polling' | string
export type InboxMapPin = any
export type InboxPagination = any
export type InboxDiagnostics = any

export interface InboxThread {
  id: string
  leadId: string
  marketId: string
  ownerName: string
  sellerName?: string
  subject: string
  preview: string
  status: 'unread' | 'read' | 'replied' | 'archived'
  priority: 'urgent' | 'high' | 'normal' | 'low'
  sentiment: 'hot' | 'warm' | 'neutral' | 'cold'
  messageCount: number
  lastMessageLabel: string
  lastMessageIso: string
  unreadCount: number
  aiDraft: string | null
  labels: string[]
  threadKey?: string
  conversationThreadId?: string
  conversation_thread_id?: string
  legacyThreadKey?: string
  legacy_thread_key?: string
  normalizedPhone?: string
  normalized_phone?: string
  ownerId?: string
  prospectId?: string
  propertyId?: string
  phoneNumber?: string
  phoneNumberId?: string
  textgridNumberId?: string
  canonicalE164?: string
  sellerPhone?: string
  ourNumber?: string
  latestDirection?: string
  directionUsed?: string
  autoReplyStatus?: string
  deliveryStatus?: string
  providerDeliveryStatus?: string
  latestDeliveryStatus?: string
  latestProviderDeliveryStatus?: string
  latestDeliveredAt?: string | null
  latestFailedAt?: string | null
  latestFailureReason?: string | null
  latestSentAt?: string | null
  latestProviderSid?: string
  lastDeliveredAt?: string | null
  failureReason?: string
  propertyAddress?: string
  propertyAddressFull?: string
  propertyCity?: string
  market?: string
  marketName?: string
  city?: string
  state?: string
  zip?: string
  lastInboundAt?: string | null
  lastOutboundAt?: string | null
  needsResponse?: boolean
  unread?: boolean
  uiIntent?: string
  priorityBucket?: string
  workflowStatus?: string
  workflowStage?: string
  threadWorkflowStatus?: string
  threadWorkflowStage?: string
  ownerDisplayName?: string
  latestMessageBody?: string
  latestMessageAt?: string
  lat?: number
  lng?: number
  ownerType?: string
  propertyType?: string
  propertyClass?: string
  finalAcquisitionScore?: number
  priorityScore?: number
  inboxCategory?: string
  matchedKeywords?: string[]
  groupingMethod?: string
  hydrationSource?: string
  queueId?: string
  needsReply?: boolean
  showInPriorityInbox?: boolean
  inbound_count?: number
  outbound_count?: number
  hydrationConfidence?: string
  groupingConfidence?: string
  latest_message_body?: string
  latest_message_direction?: string
  latest_activity_at?: string
  isStarred?: boolean
  isPinned?: boolean
  isHidden?: boolean
  isArchived?: boolean
  isSuppressed?: boolean
  threadIsPinned?: boolean
  threadIsStarred?: boolean
  threadIsHidden?: boolean
  threadIsSuppressed?: boolean
  isOptOut?: boolean
  thread_id?: string
  threadIsArchived?: boolean
  threadIsRead?: boolean
  latestMessage?: string
  display_phone?: string
  bestPhone?: string
  isRead?: boolean
  isDnc?: boolean
  beds?: string | number
  baths?: string | number
  sqft?: string | number
  yearBuilt?: string | number
  equityAmount?: number
  equityPercent?: number
  equity_percent?: number
  motivationScore?: number
  estimatedRepairCost?: number
  estimatedValue?: number | null
  contactLanguage?: string
  
  // DealContext nested objects
  property_data?: any
  master_owner_data?: any
  prospect_data?: any
  phone_data?: any
  email_data?: any
  thread_state_data?: any
  campaign_data?: any
  queue_data?: any
  suppression_data?: any
  valuation_data?: any
  buyer_match_data?: any
  contact_stack_json?: any

  // UNIVERSAL SELLER WORK ITEM FIELDS
  is_uncontacted?: boolean
  has_conversation?: boolean
  has_queue?: boolean
  has_message_event?: boolean
  seller_state?: string
  seller_status?: string
  execution_state?: string
  pipeline_stage?: string

  // PROSPECT
  canonical_prospect_id?: string
  cnam?: string
  gender?: string
  marital_status?: string
  education_model?: string
  occupation_group?: string
  occupation?: string
  est_household_income?: string
  net_asset_value?: string
  buying_power?: string
  likely_owner?: boolean
  likely_renting?: boolean
  matching_flags?: string
  person_flags_text?: string
  person_flags_json?: any
  prospect_contact_score?: number
  prospect_phone_score?: number
  prospect_best_phone?: string
  prospect_best_email?: string
  sms_eligible?: boolean
  email_eligible?: boolean

  // DealContext flat fields
  deal_context_id?: string
  context_type?: string
  seller_phone?: string
  sender_phone?: string
  owner_name?: string
  display_name?: string
  property_address_full?: string
  market_name?: string
  universal_status?: string
  universal_stage?: string
  inbox_bucket?: string
  reply_intent?: string
  lead_temperature?: string
  delivery_status?: string
  latest_delivery_status?: string
  provider_delivery_status?: string
  latest_provider_delivery_status?: string
  latest_delivered_at?: string | null
  latest_failed_at?: string | null
  latest_failure_reason?: string | null
  prospect_name?: string
  full_name?: string
  first_name?: string
  latitude?: number
  longitude?: number
  property_type?: string
  property_class?: string
  estimated_value?: number
  estimated_arv?: number
  cash_offer?: number
  final_acquisition_score?: number
  priority_score?: number
  campaign_name?: string
  queueStatus?: string | null
  queue_status?: string | null

  // OWNER
  primary_owner_address?: string
  owner_type_guess?: string
  routing_market?: string
  routing_timezone?: string
  best_channel?: string
  best_contact_window?: string
  best_language?: string
  contactability_score?: number
  financial_pressure_score?: number
  urgency_score?: number
  owner_priority_tier?: string
  follow_up_cadence?: string
  best_phone_1?: string
  best_phone_2?: string
  best_phone_3?: string
  best_email_1?: string
  best_email_2?: string
  portfolio_total_value?: number
  portfolio_total_equity?: number
  portfolio_total_loan_balance?: number
  portfolio_total_units?: number
  seller_tags_text?: string
  seller_tags_json?: any
  agent_persona?: string
  agent_family?: string
  joined_property_ids_json?: any
  property_count?: number
  tax_delinquent_count?: number
  oldest_tax_delinquent_year?: number
  active_lien_count?: number

  // PROPERTY
  property_address_city?: string
  property_address_state?: string
  property_address_zip?: string
  property_county_name?: string
  market_region?: string
  estimated_repair_cost?: number
  estimated_repair_cost_per_sqft?: number
  deal_strength_score?: number
  equity_amount?: number
  total_loan_amt?: number
  total_loan_balance?: number
  total_loan_payment?: number
  property_tax_delinquent?: boolean
  property_tax_delinquent_year?: number
  tax_amt?: number
  tax_year?: number
  property_active_lien?: boolean
  ownership_years?: number
  units_count?: number
  building_square_feet?: number
  total_bedrooms?: number
  total_baths?: number
  year_built?: number
  effective_year_built?: number
  lot_acreage?: number
  lot_square_feet?: number
  lot_size_depth_feet?: number
  lot_size_frontage_feet?: number
  building_condition?: string
  building_quality?: string
  rehab_level?: string
  podio_tags?: string
  property_flags_text?: string
  property_flags_json?: any
  streetview_image?: string
  satellite_image?: string
  map_image?: string
  style?: string
  stories?: number
  sum_buildings_nbr?: number
  avg_sqft_per_unit?: number
  beds_per_unit?: number
  sqft_range?: string
  construction_type?: string
  exterior_walls?: string
  floor_cover?: string
  basement?: string
  other_rooms?: string
  num_of_fireplaces?: number
  patio?: string
  porch?: string
  deck?: string
  driveway?: string
  garage?: string
  sum_garage_sqft?: number
  air_conditioning?: string
  heating_type?: string
  heating_fuel_type?: string
  interior_walls?: string
  roof_cover?: string
  roof_type?: string
  pool?: string
  sewer?: string
  water?: string
  zoning?: string
  flood_zone?: string
  legal_description?: string
  subdivision_name?: string
  school_district_name?: string
  assd_total_value?: number
  assd_land_value?: number
  assd_improvement_value?: number
  calculated_total_value?: number
  calculated_land_value?: number
  calculated_improvement_value?: number
  sale_price?: number
  sale_date?: string
  recording_date?: string
  last_sale_doc_type?: string
  past_due_amount?: number
  ai_score?: number

  // DISPLAY
  displayName?: string
  displayAddress?: string
  displayPhone?: string
  displayMarket?: string
  displayStatus?: string
  displayScore?: number

  // FILTERS
  filterState?: string
  filterCity?: string
  filterZip?: string
  filterMarket?: string
  filterPropertyType?: string
  filterOwnerType?: string
  filterLanguage?: string
  filterAgentPersona?: string
  filterPriorityTier?: string
}
export interface InboxModel {
  threads: InboxThread[]
  /** Non-archived threads where `is_read` is false (notification bell). */
  unreadCount: number
  urgentCount: number
  totalCount: number
  aiDraftCount: number
  dataMode: 'live' | 'mock_preview' | 'fallback_error' | 'auth_error' | 'backend_unavailable' | 'degraded_timeout'
  liveFetchStatus: 'active' | 'error' | 'disabled' | 'fallback_error'
  countsFetchWarning?: string | null
  liveFetchError: string | null
  /** Internal: tracks which filter was used to load these threads — prevents stale rows bleeding across filter switches */
  _requestedFilter?: string
  messageEventsCount: number | null
  messageEventsRawCount: number | null
  groupedThreadCount: number | null
  priorityInboxCount: number | null
  activeInboxCount: number | null
  waitingInboxCount: number | null
  allInboxCount: number | null
  unreadThreadsCount: number | null
  sendQueueCount: number | null
  archivedThreadsCount: number | null
  hiddenThreadsCount: number | null
  suppressedThreadsCount: number | null
  deadThreadsCount?: number | null
  lastLiveFetchAt: string | null

  counts?: Record<string, number | null | undefined>
  mapPins?: InboxMapPin[]
  pagination?: InboxPagination | null
  loadedCount?: number
  fullyHydratedCount?: number
  partiallyHydratedCount?: number
  orphanCount?: number
  latestFetchMs?: number
  realtimeConnected?: boolean
  realtimeStatus?: InboxRealtimeStatus
  connectionState?: InboxConnectionState
  realtimeDegraded?: boolean
  refreshMode?: 'realtime' | 'polling' | 'disabled'
  countsDegraded?: boolean
  countsApproximate?: boolean
  countsSource?: string | null
  countPreservedReason?: string | null
  liveDiagnostics?: InboxDiagnostics
  liveDataSource?: string | null
  fallbackUsed?: boolean
}
