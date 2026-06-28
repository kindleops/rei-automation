export type SellerExecutionStatus =
  | 'waiting'
  | 'running'
  | 'succeeded'
  | 'blocked'
  | 'needs_review'
  | 'failed'
  | 'retrying'
  | 'skipped'

export interface SellerAutomationRegistryNode {
  action_key: string
  node_type: string
  display_name: string
  description: string
  lifecycle_stage?: string | null
  trigger?: string | null
  required_inputs?: string[]
  produced_outputs?: string[]
  eligibility_rules?: string[]
  contactability_requirements?: string | null
  template_key?: string | null
  retry_behavior?: { max_retries: number; backoff_ms: number }
  timeout_behavior?: { timeout_ms: number }
  next_possible_actions?: string[]
  enabled: boolean
  icon?: string
  color?: string
  category?: string
  backend_handler?: string | null
}

export interface SellerAutomationRegistryEdge {
  from_action_key: string
  to_action_key: string
  edge_type: string
}

export interface SellerAutomationRegistryResponse {
  workflow_id: string
  registry_version: string
  source: string
  counts: { total: number; enabled: number; categories: number }
  nodes: SellerAutomationRegistryNode[]
  categories: Record<string, SellerAutomationRegistryNode[]>
  edges: SellerAutomationRegistryEdge[]
}

export interface SellerAutomationExecution {
  id: string
  workflow_id: string
  property_id?: string | null
  participant_id?: string | null
  thread_id: string
  source_message_id?: string | null
  lifecycle_stage?: string | null
  status: string
  started_at: string
  completed_at?: string | null
  duration_ms?: number | null
  metadata?: Record<string, unknown>
}

export interface SellerAutomationExecutionStep {
  id: string
  execution_id: string
  action_key: string
  node_id: string
  property_id?: string | null
  participant_id?: string | null
  thread_id?: string | null
  source_message_id?: string | null
  lifecycle_stage?: string | null
  execution_status: SellerExecutionStatus
  started_at: string
  completed_at?: string | null
  duration_ms?: number | null
  input_summary?: Record<string, unknown>
  output_summary?: Record<string, unknown>
  selected_template?: string | null
  rendered_response_preview?: string | null
  queue_id?: string | null
  provider_status?: string | null
  block_reason?: string | null
  retry_count?: number
  error_details?: Record<string, unknown> | null
  next_action?: string | null
  manual?: boolean
}

export interface SellerAutomationLiveState {
  workflow_id: string
  execution: SellerAutomationExecution | null
  steps: SellerAutomationExecutionStep[]
  node_states: Record<string, {
    action_key: string
    node_id: string
    status: SellerExecutionStatus
    started_at?: string
    completed_at?: string | null
    duration_ms?: number | null
    block_reason?: string | null
    next_action?: string | null
  }>
  registry_nodes?: SellerAutomationRegistryNode[]
  registry_edges?: SellerAutomationRegistryEdge[]
  updated_at: string
  replay_only?: boolean
}

export interface SellerAutomationExecutionDetail {
  execution: SellerAutomationExecution
  steps: SellerAutomationExecutionStep[]
  registry_nodes: SellerAutomationRegistryNode[]
  registry_edges: SellerAutomationRegistryEdge[]
}

export const SELLER_AUTOMATION_WORKFLOW_ID = 'seller-inbound-v1'