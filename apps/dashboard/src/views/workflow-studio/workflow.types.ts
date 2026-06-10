export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived'
export type WorkflowChannel = 'sms' | 'email' | 'rvm' | 'direct_mail' | 'multichannel'

export interface Workflow {
  id: string
  workflow_key: string
  name: string
  description?: string | null
  channel: WorkflowChannel
  workflow_type: string
  status: WorkflowStatus
  live_send_enabled: boolean
  market_scope?: string[]
  state_scope?: string[]
  property_type_scope?: string[]
  language_scope?: string[]
  owner_type_scope?: string[]
  asset_type_scope?: string[]
  daily_cap?: number | null
  hourly_cap?: number | null
  timezone?: string | null
  step_count?: number
  send_node_count?: number
  created_at?: string
  updated_at?: string
}

export interface WorkflowStep {
  id: string
  workflow_id: string
  step_key: string
  step_order: number
  node_type: string
  label: string
  config: Record<string, unknown>
  conditions: Record<string, unknown>
  actions: Array<Record<string, unknown>>
  stop_conditions: Record<string, unknown>
  delay_amount?: number | null
  delay_unit?: string | null
  is_active: boolean
}

export interface WorkflowTemplateTranslation {
  id: string
  source_variant_id: string
  language: string
  translated_subject?: string | null
  translated_body: string
  translation_status: 'pending' | 'approved' | 'rejected'
}

export interface WorkflowTemplateVariant {
  id: string
  template_set_id: string
  variant_key: string
  language: string
  subject?: string | null
  body: string
  weight: number
  spin_syntax_enabled: boolean
  personalization_tokens?: string[]
  status: string
  translations?: WorkflowTemplateTranslation[]
}

export interface WorkflowTemplateSet {
  id: string
  workflow_id: string
  name: string
  channel: WorkflowChannel
  language: string
  use_case?: string | null
  stage_code?: string | null
  rotation_mode: string
  is_active: boolean
  variants?: WorkflowTemplateVariant[]
}

export interface WorkflowSenderPoolMember {
  id: string
  sender_pool_id: string
  textgrid_number_id?: string | null
  email_sender_id?: string | null
  sender_value: string
  sender_label?: string | null
  weight: number
  daily_cap?: number | null
  hourly_cap?: number | null
  status: string
}

export interface WorkflowSenderPool {
  id: string
  workflow_id: string
  pool_key: string
  name: string
  channel: WorkflowChannel
  market_scope?: string[]
  state_scope?: string[]
  language_scope?: string[]
  routing_mode: string
  daily_cap?: number | null
  hourly_cap?: number | null
  health_thresholds?: Record<string, unknown>
  is_active: boolean
  members?: WorkflowSenderPoolMember[]
}

export interface WorkflowDryRunStep {
  step_id?: string
  step_key?: string
  step_order?: number
  node_type: string
  label: string
  status: string
  dry_run: boolean
  live_send_blocked: boolean
  rendered_template?: {
    body: string
    subject?: string | null
    sms?: { character_count: number; segment_count: number; encoding: string }
    spin_substitutions?: Array<Record<string, unknown>>
    missing_tokens?: string[]
  } | null
  sender_route?: Record<string, unknown>
  wait?: Record<string, unknown>
  conditions?: Record<string, unknown>
  actions?: Array<Record<string, unknown>>
  approval_gate?: boolean
}

export interface WorkflowDryRunResult {
  ok: boolean
  workflow?: Workflow
  dry_run: boolean
  live_send_enabled: boolean
  live_send_blocked: boolean
  no_outbound_messages_sent: boolean
  selected_sample_context: Record<string, unknown>
  steps: WorkflowDryRunStep[]
  warnings: string[]
  errors: string[]
}

export interface WorkflowDetail {
  ok: boolean
  workflow: Workflow
  steps: WorkflowStep[]
  template_sets: WorkflowTemplateSet[]
  sender_pools: WorkflowSenderPool[]
  runs?: Array<Record<string, unknown>>
  audit?: Array<Record<string, unknown>>
  validation?: { ok: boolean; errors: string[]; warnings: string[] }
  translation_languages?: Array<{ code: string; label: string }>
  personalization_tokens?: string[]
}

export interface WorkflowModel {
  workflows: Workflow[]
  selected?: WorkflowDetail | null
}
