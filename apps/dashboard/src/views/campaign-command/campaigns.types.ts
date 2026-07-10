export type CampaignStatus =
  | 'active'
  | 'ready'
  | 'built'
  | 'queued'
  | 'live_limited'
  | 'paused'
  | 'scheduled'
  | 'draft'
  | 'previewed'
  | 'activating'
  | 'failed'
  | 'completed'
  | 'archived'

export type LaunchReadinessLevel = 'ready' | 'warnings' | 'blocked' | 'unknown'

export interface CampaignExecutionProof {
  campaign_state: string
  hydrated_rows: number
  live_send_rows: number
  proof_no_send_rows: number
  sms_eligible: number
  routing_allowed: number
  transmission_enabled: boolean
  next_scheduled_proof_row: string | null
  no_messages_will_transmit: boolean
  proof_mode: boolean
}

export interface CampaignRecipientMetrics {
  matched_property_count?: number | null
  target_row_count?: number
  distinct_master_owner_count?: number
  unique_phone_count?: number
  unique_e164_count?: number
  compliant_recipient_count?: number
  routable_recipient_count?: number
  launch_ready_recipient_count?: number
  ready_recipient_count?: number
  planned_count?: number
  queued_count?: number
  duplicate_owner_groups?: number
  duplicate_phone_groups?: number
}

export interface CampaignSummary {
  id: string
  campaign_name: string
  status: CampaignStatus
  operator_state?: string
  operator_state_label?: string
  mode?: 'live' | 'test'
  mode_label?: string
  total_targets: number
  ready_targets: number
  planned_targets?: number
  scheduled_targets: number
  scheduled_queue_rows?: number
  queued_targets: number
  failed_target_rows?: number
  failed_execution_rows?: number
  readiness_label?: string
  canonical_queued_count?: number
  launch_readiness?: LaunchReadinessLevel
  launch_blockers?: string[]
  launch_blocker_codes?: string[]
  routable_recipient_count?: number
  launch_ready_recipient_count?: number
  recipient_metrics?: CampaignRecipientMetrics | null
  execution_proof?: CampaignExecutionProof | null
  sent_count: number
  delivered_count: number
  failed_count: number
  reply_count: number
  positive_reply_count: number
  negative_reply_count: number
  opt_out_count: number
  delivery_rate: number
  reply_rate: number
  positive_rate: number
  opt_out_rate: number
  failure_rate: number
  next_send_at: string | null
  last_send_at: string | null
  send_interval_seconds: number
  send_window_start: string | null
  send_window_end: string | null
  auto_send_enabled: boolean
  auto_queue_enabled?: boolean
  blocked_reason_counts?: Record<string, number>
  health_score: number
  health_status: 'healthy' | 'caution' | 'dangerous'
}

export interface CampaignTarget {
  id: string
  campaign_id: string
  target_status: string
  master_owner_id: string | null
  property_id: string | null
  phone_id: string | null
  canonical_e164: string | null
  seller_first_name: string | null
  seller_full_name: string | null
  property_address_full: string | null
  property_address_city: string | null
  property_address_state: string | null
  property_address_zip: string | null
  market: string | null
  language: string | null
  final_acquisition_score: number | null
  last_contact_at: string | null
  suppression_status: string | null
  suppression_reason: string | null
  template_id: string | null
  template_name: string | null
  scheduled_for: string | null
  sent_at: string | null
  delivered_at: string | null
  failed_at: string | null
  replied_at: string | null
}

export interface CampaignQueueRow {
  id: string
  campaign_id: string
  campaign_target_id: string | null
  queue_row_id: string | null
  seller_full_name: string | null
  property_address_full: string | null
  market: string | null
  template_id: string | null
  template_name: string | null
  from_phone_number: string | null
  to_phone_number: string | null
  scheduled_for: string | null
  queue_status: 'scheduled' | 'queued' | 'sending' | 'paused' | 'held'
  delivery_status: string | null
  failure_category: string | null
  failed_reason: string | null
  last_event_at: string | null
}

export interface CampaignReply {
  id: string
  campaign_id: string
  campaign_target_id: string | null
  seller_full_name: string | null
  property_address_full: string | null
  inbound_message: string
  detected_intent: string | null
  sentiment: 'hot' | 'warm' | 'cold' | 'dnc'
  reply_type: 'positive' | 'negative' | 'neutral' | 'opt_out' | 'question'
  next_action: string | null
  created_at: string
}

export interface CampaignFailureGroup {
  campaign_id: string
  failure_category: string
  count: number
  severity: 'critical' | 'warning' | 'info'
  sample_numbers: string[]
  sample_reasons: string[]
}

export interface CampaignTemplateStats {
  template_id: string
  template_name: string
  language: string
  use_count: number
  delivered_count: number
  failed_count: number
  reply_count: number
  opt_out_count: number
  delivery_rate: number
  reply_rate: number
  opt_out_rate: number
  last_used_at: string | null
}

export interface CampaignLogEvent {
  id: string
  campaign_id: string
  event_type: string
  severity: 'info' | 'success' | 'warning' | 'error'
  title: string
  description: string
  created_at: string
  metadata: any
}

export type CampaignLaunchMode = 'dry_run' | 'no_send' | 'live'

export interface CampaignLaunchDistributionEntry {
  value: string
  label: string
  count: number
}

export interface CampaignLaunchPayload {
  dry_run: boolean
  no_send: boolean
  confirm_live: boolean
  create_send_queue_rows: boolean
  explicit_operator_action: boolean
  pacing?: 'conservative' | 'normal' | 'aggressive' | 'custom'
  max_targets: number
  daily_cap: number
  per_sender_cap?: number
  per_market_cap?: number
  first_scheduled_at?: string
  spread_interval_seconds?: number
  contact_window_start?: string
  contact_window_end?: string
}

export interface CampaignLaunchResult {
  ok?: boolean
  success?: boolean
  dry_run?: boolean
  no_send?: boolean
  campaign_id?: string
  status?: string
  targets_created?: number
  queue_rows_created?: number
  send_queue_rows_created?: number
  skipped_count?: number
  blocked_count?: number
  sender_distribution?: CampaignLaunchDistributionEntry[]
  template_distribution?: CampaignLaunchDistributionEntry[]
  first_scheduled_at?: string | null
  last_scheduled_at?: string | null
  blockers?: string[]
  exact_blockers?: string[]
  skipped_counts_by_reason?: Record<string, number>
  sample_skips?: Array<Record<string, unknown>>
  planned_target_count?: number
  total_ready_targets?: number
  send_windows_created?: number
  planned_windows?: Array<Record<string, unknown>>
  launch_summary?: {
    targets_created?: number
    queue_rows_created?: number
    skipped_count?: number
    blocked_count?: number
    sender_distribution?: CampaignLaunchDistributionEntry[]
    template_distribution?: CampaignLaunchDistributionEntry[]
    first_scheduled_at?: string | null
    last_scheduled_at?: string | null
    status?: string
  }
  target_build?: {
    built_count?: number
    no_send_queue_rows_created?: boolean
    preview?: Record<string, unknown>
  } | null
  message?: string
}

// ── Shared Types from Before ──────────────────────────────────────────────

export interface CampaignMarketMetric {
  campaign_id: string
  market: string
  total_targets: number
  sent_count: number
  delivered_count: number
  reply_count: number
  positive_reply_count: number
  opted_out_count: number
  delivery_rate_percent: number
  reply_rate_percent: number
}

export interface CampaignGeographyEntry {
  label: string
  type: 'state' | 'county' | 'market' | 'city' | 'zip'
  targets: number
  ready: number
  queued: number
  fresh_targets: number
  sent: number
  delivered: number
  replies: number
  positive_replies: number
  opt_outs: number
  failures: number
  reply_rate: number
  optout_rate: number
  delivery_rate: number
  performance: 'excellent' | 'good' | 'average' | 'poor'
}

export interface SuppressionCheck {
  label: string
  key: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
}

export interface CampaignKpis {
  activeCampaigns: number
  totalTargets: number
  readyTargets: number
  scheduledQueueRows: number
  plannedTargets: number
  sentToday: number
  deliveredToday: number
  replyRate: number
  positiveReplies: number
  optOutRate: number
  failureRate: number
}

export type CampaignLoadErrorType =
  | 'auth_error'
  | 'backend_unavailable'
  | 'missing_view'
  | 'query_failed'
  | 'no_campaigns'

export interface CampaignModel {
  campaigns: CampaignSummary[]
  kpis: CampaignKpis
  ok?: boolean
  errorType?: CampaignLoadErrorType
  errorMessage?: string
  degraded?: boolean
  retryable?: boolean
  source?: string
}

export type CampaignDetailTab =
  | 'overview'
  | 'execution'
  | 'targets'
  | 'queue'
  | 'replies'
  | 'failures'
  | 'geography'
  | 'templates'
  | 'logs'

// ── State Types ─────────────────────────────────────────────────────────

export type CampaignCommandState = {
  activeCampaignId: string | null
  activeCampaignContext: {
    selectedThreadId?: string | null
    selectedPropertyId?: string | null
    selectedCampaignTargetId?: string | null
    selectedQueueRowId?: string | null
    source: 'sidebar' | 'thread' | 'property' | 'queue' | 'reply' | 'url'
  } | null
  displayScope: 'campaign' | 'property' | 'target' | 'thread' | 'queue_row'
}

export interface CreateCampaignPayload {
  name: string
  description: string
  status: 'draft'
  campaign_type: string
  template_use_case: string
  stage_code: string
  
  // Phase 1 stores targeting settings in the campaign metadata target_filters JSON.
  target_filters: {
    // 2. Geography
    states: string[]
    markets: string[]
    counties: string[]
    cities: string[]
    zip_codes: string[]
    zip_clusters: string[]
    timezones: string[]
    sender_coverage_required: boolean
    healthy_senders_only: boolean

    // 3. Audience
    owner_types: string[]
    exclude_banks: boolean
    exclude_government: boolean
    exclude_hedge_funds: boolean
    likely_owner_required: boolean
    family_associated_allowed: boolean
    primary_decision_maker_required: boolean

    // 4. Property Filters
    tags_include_any: string[]
    tags_include_all: string[]
    tags_exclude: string[]
    
    min_motivation_layers: number | null
    min_final_acquisition_score: number | null
    min_structured_motivation_score: number | null
    min_deal_strength_score: number | null
    min_tag_distress_score: number | null
    min_equity_percent: number | null
    equity_amount_min: number | null
    equity_amount_max: number | null
    estimated_value_min: number | null
    estimated_value_max: number | null
    cash_offer_min: number | null
    cash_offer_max: number | null
    repair_cost_min: number | null
    repair_cost_max: number | null
    year_built_min: number | null
    year_built_max: number | null
    effective_year_built_min: number | null
    effective_year_built_max: number | null
    sqft_min: number | null
    sqft_max: number | null
    lot_size_min: number | null
    lot_size_max: number | null
    beds_min: number | null
    beds_max: number | null
    baths_min: number | null
    baths_max: number | null
    units_min: number | null
    units_max: number | null
    building_condition: string
    building_quality: string
    rehab_level: string
    property_type: string
    property_class: string
    market_status: string
    mls_status: string

    // 5. Contact Safety
    sms_eligible_required: boolean
    valid_e164_required: boolean
    wireless_only: boolean
    min_phone_score: number | null
    active_12mo_only: boolean
    exclude_opt_outs: boolean
    exclude_wrong_numbers: boolean
    exclude_blacklist_pairs: boolean
    exclude_not_interested: boolean
    exclude_no_reply: boolean
    exclude_active_queue: boolean
    dedupe_same_phone: boolean
    dedupe_same_owner: boolean
    exclude_contacted_days: number | null
    exclude_delivered_days: number | null
    never_contacted_only: boolean
    require_linked_property: boolean
    require_linked_master_owner: boolean
    require_campaign_target_row: boolean
    require_seller_first_name: boolean

    // 6. Message Strategy
    language: string
    agent_family: string
    agent_persona: string
    template_category: string
    message_tone: string
    gender_variant: string
    market_specific_required: boolean
    language_matched_required: boolean
    fallback_template_allowed: boolean

    // 7. Schedule
    send_window_policy: string
    custom_window_start: string
    custom_window_end: string
    interval_seconds: number
    daily_cap: number | null
    total_cap: number | null
    batch_max?: number | null
    market_cap?: number | null
    per_sender_cap?: number | null
    auto_queue_enabled?: boolean
    auto_send_enabled: boolean
    routing_safe_only: boolean
    start_paused: boolean
    pause_on_optout_rate: number | null
    pause_on_failure_rate: number | null
  }
}
