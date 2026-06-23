// ── Email Module Types ────────────────────────────────────────────────────────

export type EmailTab =
  | 'overview'
  | 'inbox'
  | 'records'
  | 'composer'
  | 'campaigns'
  | 'templates'
  | 'suppression'
  | 'brevo-health'

export type EmailEligibility = 'eligible' | 'ineligible' | 'unknown'
export type EmailVerifiedStatus = 'verified' | 'unverified' | 'risky' | 'invalid'
export type BrevoContactStatus = 'active' | 'blacklisted' | 'unsubscribed' | 'blocked' | 'unknown'
export type SuppressionReason = 'bounced' | 'unsubscribed' | 'complaint' | 'manual' | 'none'
export type InboxFolder = 'new_replies' | 'needs_review' | 'interested' | 'follow_up' | 'bounced' | 'suppressed' | 'unsubscribed' | 'all'
export type EmailConfidence = 'high' | 'medium' | 'low' | 'unknown'

// ── Overview ──────────────────────────────────────────────────────────────────

export interface EmailOverview {
  total_emails: number
  email_eligible: number
  high_confidence: number
  suppressed: number
  bounced: number
  unsubscribed: number
  sent_today: number
  replies_today: number
  ready_for_campaign: number
  brevo_status: 'connected' | 'degraded' | 'disconnected'
  last_updated: string
}

// ── Records ───────────────────────────────────────────────────────────────────

export interface EmailRecord {
  id: string
  prospect_name: string
  owner_name: string | null
  email_address: string
  email_rank: number
  email_score: number
  match_confidence: EmailConfidence
  verified_status: EmailVerifiedStatus
  brevo_contact_status: BrevoContactStatus
  suppression_status: SuppressionReason
  linked_property: string | null
  property_address: string | null
  market: string | null
  language: string
  last_email_sent: string | null
  last_reply: string | null
  eligibility: EmailEligibility
}

// ── Inbox / Threads ───────────────────────────────────────────────────────────

export interface EmailMessage {
  id: string
  direction: 'inbound' | 'outbound'
  from_address: string
  to_address: string
  subject: string
  body_preview: string
  body_html: string | null
  sent_at: string
  opened: boolean
  clicked: boolean
  bounced: boolean
}

export interface EmailThread {
  id: string
  folder: InboxFolder
  prospect_name: string
  email_address: string
  subject: string
  last_message_preview: string
  last_message_at: string
  message_count: number
  unread: boolean
  property_address: string | null
  market: string | null
  has_sms_thread: boolean
  sentiment: 'positive' | 'neutral' | 'negative' | 'unknown'
}

export interface EmailThreadDetail extends EmailThread {
  messages: EmailMessage[]
  property_context: {
    address: string
    estimated_value: string
    owner_name: string
    market: string
  } | null
  prospect_context: {
    name: string
    email: string
    phone: string | null
    language: string
    campaigns: string[]
  } | null
  ai_summary: string | null
  sms_thread_id: string | null
}

// ── Composer ──────────────────────────────────────────────────────────────────

export interface ComposerPayload {
  to: string
  from_identity: string
  subject: string
  body: string
  template_id: string | null
  prospect_id: string | null
  property_id: string | null
  is_draft: boolean
}

export interface SaveDraftResult {
  ok: boolean
  draft_id?: string
  message?: string
}

export interface MockSendResult {
  ok: boolean
  message_id?: string
  message?: string
  backend_ready: false
}

// ── Templates ─────────────────────────────────────────────────────────────────

export type TemplateCategory =
  | 'first_touch'
  | 'follow_up'
  | 'offer'
  | 'appointment'
  | 'wrong_contact'
  | 'long_form_inquiry'

export interface EmailTemplate {
  id: string
  name: string
  category: TemplateCategory
  subject: string
  body_preview: string
  body: string
  merge_fields: string[]
  last_used: string | null
  usage_count: number
}

// ── Campaigns ─────────────────────────────────────────────────────────────────

export type EmailCampaignStatus = 'draft' | 'scheduled' | 'active' | 'completed' | 'paused'

export interface EmailCampaignDraft {
  id: string
  name: string
  status: EmailCampaignStatus
  target_count: number
  eligible_count: number
  template_id: string | null
  template_name: string | null
  created_at: string
  scheduled_at: string | null
  sequence_steps: number
}

// ── Suppression ───────────────────────────────────────────────────────────────

export interface SuppressionEntry {
  id: string
  email_address: string
  prospect_name: string
  reason: SuppressionReason
  suppressed_at: string
  source: 'brevo' | 'manual' | 'complaint'
  can_remove: boolean
}

// ── Brevo Health ──────────────────────────────────────────────────────────────

export interface SenderIdentity {
  name: string
  email: string
  active: boolean
  domain_verified: boolean
}

export interface BrevoHealth {
  connected: boolean
  api_key_valid: boolean
  sender_identities: SenderIdentity[]
  domain_auth_status: 'verified' | 'pending' | 'failed' | 'unknown' | string
  bounce_rate_7d: number | null
  send_failure_rate_7d: number | null
  api_latency_ms: number | null
  webhook_configured: boolean
  last_checked: string
  send_enabled?: boolean
  dry_run_default?: boolean
  missing?: string[]
}

// ── Filter States ─────────────────────────────────────────────────────────────

export interface RecordFilters {
  search: string
  eligibility: EmailEligibility | 'all'
  confidence: EmailConfidence | 'all'
  suppression: SuppressionReason | 'all'
  market: string | 'all'
}

export interface InboxFilters {
  folder: InboxFolder
  search: string
}
