export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface BaseSupabaseRow {
  id?: string | number | null
  created_at?: string | null
  updated_at?: string | null
  [key: string]: Json | undefined
}

export interface MasterOwnerRow extends BaseSupabaseRow {
  master_owner_id?: string | number | null
  owner_id?: string | number | null
  full_name?: string | null
  first_name?: string | null
  last_name?: string | null
  motivation_score?: number | string | null
  priority?: string | null
  status?: string | null
}

export interface OwnerRow extends BaseSupabaseRow {
  owner_id?: string | number | null
  master_owner_id?: string | number | null
  prospect_id?: string | number | null
  podio_item_id?: string | number | null
  first_name?: string | null
  last_name?: string | null
  full_name?: string | null
  entity_name?: string | null
  owner_type?: string | null
  market?: string | null
  city?: string | null
  state?: string | null
  motivation_score?: number | string | null
  ai_score?: number | string | null
  risk_score?: number | string | null
  status?: string | null
  priority?: string | null
}

export interface ProspectRow extends BaseSupabaseRow {
  prospect_id?: string | number | null
  owner_id?: string | number | null
  master_owner_id?: string | number | null
  lead_stage?: string | null
  seller_stage?: string | null
  market?: string | null
  status?: string | null
  priority?: string | null
  ai_score?: number | string | null
}

export interface PropertyRow extends BaseSupabaseRow {
  property_id?: string | number | null
  owner_id?: string | number | null
  master_owner_id?: string | number | null
  prospect_id?: string | number | null
  seller_id?: string | number | null
  market_id?: string | number | null
  market?: string | null
  property_address?: string | null
  property_address_city?: string | null
  property_address_state?: string | null
  zip?: string | null
  zipcode?: string | null
  latitude?: number | string | null
  lat?: number | string | null
  longitude?: number | string | null
  lng?: number | string | null
  lon?: number | string | null
  estimated_value?: number | string | null
  equity?: number | string | null
  motivation_score?: number | string | null
  priority_score?: number | string | null
  ai_score?: number | string | null
  status?: string | null
}

export interface PhoneNumberRow extends BaseSupabaseRow {
  phone_id?: string | number | null
  owner_id?: string | number | null
  master_owner_id?: string | number | null
  prospect_id?: string | number | null
  seller_id?: string | number | null
  phone?: string | null
  phone_number?: string | null
  type?: string | null
  status?: string | null
}

export interface EmailRow extends BaseSupabaseRow {
  email_id?: string | number | null
  owner_id?: string | number | null
  master_owner_id?: string | number | null
  prospect_id?: string | number | null
  seller_id?: string | number | null
  email?: string | null
  status?: string | null
}

export interface SendQueueRow extends BaseSupabaseRow {
  queue_id?: string | number | null
  owner_id?: string | number | null
  master_owner_id?: string | number | null
  prospect_id?: string | number | null
  property_id?: string | number | null
  market_id?: string | number | null
  market?: string | null
  seller_name?: string | null
  property_address?: string | null
  phone?: string | null
  template_name?: string | null
  message_text?: string | null
  status?: string | null
  priority?: string | null
  risk_level?: string | null
  retry_count?: number | string | null
  max_retries?: number | string | null
  scheduled_at?: string | null
  scheduled_for?: string | null
  send_at?: string | null
  sent_at?: string | null
  approved_at?: string | null
  held_at?: string | null
}

export interface MessageEventRow extends BaseSupabaseRow {
  event_id?: string | number | null
  thread_id?: string | number | null
  conversation_id?: string | number | null
  owner_id?: string | number | null
  master_owner_id?: string | number | null
  prospect_id?: string | number | null
  property_id?: string | number | null
  queue_id?: string | number | null
  market_id?: string | number | null
  market?: string | null
  phone?: string | null
  direction?: string | null
  inbound?: boolean | null
  outbound?: boolean | null
  body?: string | null
  message?: string | null
  message_text?: string | null
  requires_response?: boolean | null
  unread?: boolean | null
  status?: string | null
  sentiment?: string | null
  created_at?: string | null
  timestamp?: string | null
}

export interface MarketRow extends BaseSupabaseRow {
  market_id?: string | number | null
  slug?: string | null
  name?: string | null
  label?: string | null
  city?: string | null
  state?: string | null
  state_code?: string | null
  latitude?: number | string | null
  lat?: number | string | null
  longitude?: number | string | null
  lng?: number | string | null
  status?: string | null
}

export interface ZipCodeRow extends BaseSupabaseRow {
  zip_id?: string | number | null
  zip?: string | null
  zipcode?: string | null
  market_id?: string | number | null
  city?: string | null
  state?: string | null
  latitude?: number | string | null
  lat?: number | string | null
  longitude?: number | string | null
  lng?: number | string | null
}

export interface SmsTemplateRow extends BaseSupabaseRow {
  template_id?: string | number | null
  name?: string | null
  body?: string | null
  status?: string | null
  language?: string | null
}

export interface AgentRow extends BaseSupabaseRow {
  agent_id?: string | number | null
  owner_id?: string | number | null
  market_id?: string | number | null
  name?: string | null
  type?: string | null
  status?: string | null
}

export interface OfferRow extends BaseSupabaseRow {
  offer_id?: string | number | null
  owner_id?: string | number | null
  master_owner_id?: string | number | null
  prospect_id?: string | number | null
  property_id?: string | number | null
  status?: string | null
  amount?: number | string | null
  offer_amount?: number | string | null
  created_by?: string | null
}

export interface ContractRow extends BaseSupabaseRow {
  contract_id?: string | number | null
  owner_id?: string | number | null
  property_id?: string | number | null
  offer_id?: string | number | null
  status?: string | null
  blocker?: string | null
  issue?: string | null
}

export interface ClosingRow extends BaseSupabaseRow {
  closing_id?: string | number | null
  contract_id?: string | number | null
  owner_id?: string | number | null
  property_id?: string | number | null
  status?: string | null
  blocker?: string | null
}

export interface BuyerMatchRow extends BaseSupabaseRow {
  buyer_match_id?: string | number | null
  owner_id?: string | number | null
  property_id?: string | number | null
  status?: string | null
}

export interface TitleCompanyRow extends BaseSupabaseRow {
  title_company_id?: string | number | null
  name?: string | null
  status?: string | null
}

export interface TitleRoutingClosingEngineRow extends BaseSupabaseRow {
  routing_id?: string | number | null
  contract_id?: string | number | null
  closing_id?: string | number | null
  title_company_id?: string | number | null
  status?: string | null
  blocker?: string | null
}

export interface DealRevenueRow extends BaseSupabaseRow {
  revenue_id?: string | number | null
  owner_id?: string | number | null
  property_id?: string | number | null
  contract_id?: string | number | null
  amount?: number | string | null
  assignment_fee?: number | string | null
  status?: string | null
}

export interface WebhookLogRow extends BaseSupabaseRow {
  webhook_id?: string | number | null
  source?: string | null
  status?: string | null
  error?: string | null
  message?: string | null
}

export interface EmailQueueRow extends BaseSupabaseRow {
  email_queue_id?: string | number | null
  owner_id?: string | number | null
  status?: string | null
  scheduled_at?: string | null
}

export interface EmailEventRow extends BaseSupabaseRow {
  email_event_id?: string | number | null
  owner_id?: string | number | null
  event_type?: string | null
  status?: string | null
  message?: string | null
}

export interface EmailTemplateRow extends BaseSupabaseRow {
  email_template_id?: string | number | null
  name?: string | null
  subject?: string | null
  body?: string | null
}

export interface EmailSenderRow extends BaseSupabaseRow {
  email_sender_id?: string | number | null
  sender?: string | null
  status?: string | null
}
