/** Universal pipeline dimensions — aligned with v_inbox_enriched / deal_thread_state. */

export type PipelineStageCode =
  | 'ownership_check'
  | 'interest_probe'
  | 'active_communication'
  | 'price_discovery'
  | 'condition_details'
  | 'underwriting'
  | 'offer_sent'
  | 'contract_sent'
  | 'title_closing'
  | 'dead_suppressed'

export type SellerStatusCode =
  | 'new'
  | 'not_contacted'
  | 'ownership_check_sent'
  | 'message_sent'
  | 'awaiting_response'
  | 'seller_replied'
  | 'positive_intent'
  | 'asking_price_provided'
  | 'needs_follow_up'
  | 'negotiating'
  | 'offer_sent'
  | 'contract_sent'
  | 'review_required'
  | 'auto_blocked'
  | 'suppressed'
  | 'wrong_number'
  | 'failed'

export type TemperatureCode = 'hot' | 'warm' | 'cold' | 'dead'

export type QueueStateCode =
  | 'scheduled'
  | 'queued'
  | 'ready'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'paused'
  | 'not_queued'

export type WorkflowStateCode =
  | 'not_enrolled'
  | 'active'
  | 'waiting'
  | 'approval_required'
  | 'blocked'
  | 'paused'
  | 'completed'
  | 'failed'

export type FollowUpStateCode = 'due_now' | 'scheduled' | 'none'

export type PipelineGroupByMode =
  | 'stage'
  | 'status'
  | 'temperature'
  | 'market'
  | 'state'
  | 'property_type'
  | 'queue_status'
  | 'workflow_status'
  | 'follow_up_state'

export interface PipelineOpportunity {
  id: string
  dedupe_key: string
  master_owner_id: string | null
  primary_property_id: string | null
  primary_thread_key: string | null
  portfolio_property_count: number
  portfolio_property_ids?: string[]
  /** Universal pipeline stage (canonical). */
  pipeline_stage?: string | null
  /** Universal seller status (canonical). */
  seller_status?: string | null
  opportunity_status: string
  conversation_state: string | null
  queue_state: QueueStateCode | string
  workflow_state: WorkflowStateCode | string
  priority: string
  temperature: string | null
  strategy: string | null
  aos: number | null
  confidence: number | null
  estimated_value: number | null
  arv: number | null
  asking_price: number | null
  recommended_offer: number | null
  current_offer: number | null
  seller_counter: number | null
  offer_to_ask_gap: number | null
  motivation_score: number | null
  cooperation_score: number | null
  assigned_operator: string | null
  automation_state: string
  next_action: string | null
  next_action_due: string | null
  next_follow_up_at?: string | null
  follow_up_reason?: string | null
  blocker: string | null
  approval_state: string | null
  latest_intent: string | null
  latest_message_preview: string | null
  asset_class: string | null
  property_type: string | null
  property_state: string | null
  market: string | null
  property_address_full: string | null
  seller_display_name: string | null
  stage_entered_at: string
  last_activity_at: string | null
  last_contact_at: string | null
  last_updated_source: string
  acquisition_engine_run_id?: string | null
  workflow_enrollment_id?: string | null
  workflow_definition_id?: string | null
  metadata?: Record<string, unknown>
  history?: PipelineOpportunityHistoryEvent[]
  /** @deprecated Legacy acquisition taxonomy — do not use for UI grouping. */
  acquisition_stage?: string
}

export interface PipelineOpportunityHistoryEvent {
  id: string
  event_type: string
  field_name: string | null
  previous_value: string | null
  new_value: string | null
  reason: string | null
  actor: string | null
  source: string
  created_at: string
}

export interface PipelineMetrics {
  active_opportunities: number
  new_replies: number
  qualified: number
  offer_ready: number
  negotiating: number
  contract_sent: number
  under_contract: number
  closing: number
  follow_ups_due: number
  blocked: number
  nurture: number
  won: number
  lost: number
  intent_positive_pct: number
  average_stage_age_days: number
  total: number
  by_pipeline_stage?: Record<string, number>
  by_seller_status?: Record<string, number>
  by_opportunity_status?: Record<string, number>
  by_conversation_state?: Record<string, number>
  by_workflow_state?: Record<string, number>
}

export interface PipelineSavedView {
  id: string
  view_key: string
  label: string
  description: string | null
  filters: Record<string, unknown>
  group_by: PipelineGroupByMode | string
  is_default: boolean
  is_pinned: boolean
  is_shared: boolean
}

export interface PipelineListResult {
  rows: PipelineOpportunity[]
  total: number
  pagination: { limit: number; offset: number; has_more: boolean }
}