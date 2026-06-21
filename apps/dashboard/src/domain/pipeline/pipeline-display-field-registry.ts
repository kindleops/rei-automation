import type { PipelineFieldDefinition } from './pipeline-card-design.types'

export type PipelineFieldGroup =
  | 'seller_owner'
  | 'property'
  | 'conversation'
  | 'pipeline'
  | 'deal_intelligence'
  | 'contract_closing'

const TEXT_OPS = ['equals', 'contains', 'starts_with', 'is_known', 'is_unknown']
const NUMBER_OPS = ['gt', 'gte', 'lt', 'lte', 'between', 'is_known', 'is_unknown']
const DATE_OPS = ['before', 'after', 'between', 'today', 'overdue', 'within_next_days', 'within_last_days', 'is_known', 'is_unknown']
const SELECT_OPS = ['is', 'is_not', 'is_any_of', 'is_none_of']

function def(
  key: string,
  label: string,
  group: PipelineFieldGroup,
  dataType: PipelineFieldDefinition['dataType'],
  opts: Partial<PipelineFieldDefinition> = {},
): PipelineFieldDefinition {
  const operators =
    dataType === 'number' || dataType === 'currency' || dataType === 'score' || dataType === 'percent'
      ? NUMBER_OPS
      : dataType === 'datetime' || dataType === 'date'
        ? DATE_OPS
        : dataType === 'select'
          ? SELECT_OPS
          : TEXT_OPS

  return {
    key,
    label,
    description: opts.description ?? label,
    group,
    dataType,
    emptyLabel: opts.emptyLabel ?? 'Unknown',
    sortable: opts.sortable ?? false,
    filterable: opts.filterable ?? false,
    groupable: opts.groupable ?? false,
    cardCompatible: opts.cardCompatible ?? true,
    detailPanelCompatible: opts.detailPanelCompatible ?? true,
    stageApplicability: opts.stageApplicability ?? 'all',
    visibilityCondition: opts.visibilityCondition ?? null,
    editable: opts.editable ?? false,
    calculated: opts.calculated ?? false,
    canBeStale: opts.canBeStale ?? false,
    operators,
  }
}

export const PIPELINE_FIELD_REGISTRY: PipelineFieldDefinition[] = [
  def('seller_display_name', 'Seller / Owner Name', 'seller_owner', 'text', {
    description: 'Display name from opportunity record or owner enrichment.',
    emptyLabel: 'Unknown Seller',
    sortable: true,
    filterable: true,
  }),
  def('property_address_full', 'Property Address', 'property', 'text', {
    description: 'Primary property address from opportunity or hydrated property join.',
    emptyLabel: 'Property Unknown',
    sortable: true,
    filterable: true,
  }),
  def('property_type_market', 'Property Type · Market', 'property', 'text', {
    description: 'Combined eyebrow showing normalized type and market.',
    calculated: true,
    detailPanelCompatible: false,
  }),
  def('market', 'Market', 'property', 'select', {
    description: 'Market region assigned to the opportunity.',
    emptyLabel: 'Market Unknown',
    sortable: true,
    filterable: true,
    groupable: true,
  }),
  def('property_type', 'Property Type', 'property', 'select', {
    description: 'Normalized property type from hydrated properties table.',
    filterable: true,
    groupable: true,
  }),
  def('property_state', 'State', 'property', 'select', {
    description: 'Property state from hydrated property record.',
    filterable: true,
    groupable: true,
  }),
  def('units_count', 'Units', 'property', 'number', {
    description: 'Unit count from hydrated property.',
    sortable: true,
    filterable: true,
  }),
  def('portfolio_property_count', 'Portfolio Property Count', 'seller_owner', 'number', {
    description: 'Number of matched properties in owner portfolio.',
    sortable: true,
    filterable: true,
  }),
  def('latest_message_preview', 'Latest Message', 'conversation', 'text', {
    description: 'Preview of the most recent conversation message.',
    emptyLabel: 'No recent message',
    filterable: true,
  }),
  def('latest_intent', 'Intent', 'conversation', 'select', {
    description: 'Latest classified seller intent.',
    filterable: true,
  }),
  def('reply_attention_state', 'Reply Attention', 'conversation', 'select', {
    description: 'Precise reply state: New Inbound, Needs Reply, Seller Replied, Awaiting Seller. Never use ambiguous "Reply".',
    calculated: true,
    filterable: true,
  }),
  def('last_activity_at', 'Last Activity', 'conversation', 'datetime', {
    description: 'Most recent activity timestamp.',
    emptyLabel: 'No activity',
    sortable: true,
    filterable: true,
  }),
  def('last_contact_at', 'Last Contact', 'conversation', 'datetime', {
    description: 'Last outbound or inbound contact timestamp.',
    sortable: true,
    filterable: true,
  }),
  def('pipeline_stage', 'Stage', 'pipeline', 'select', {
    description: 'Universal acquisition pipeline stage.',
    sortable: true,
    filterable: true,
    groupable: true,
  }),
  def('universal_status', 'Status', 'pipeline', 'select', {
    description: 'Universal seller attention status.',
    filterable: true,
    groupable: true,
  }),
  def('temperature', 'Temperature', 'pipeline', 'select', {
    description: 'Deal temperature — hot, warming, engaged, cold, dead.',
    sortable: true,
    filterable: true,
    groupable: true,
  }),
  def('stage_age', 'Stage Age', 'pipeline', 'number', {
    description: 'Days since entering current stage.',
    calculated: true,
    sortable: true,
  }),
  def('priority', 'Priority', 'pipeline', 'select', {
    sortable: true,
    filterable: true,
  }),
  def('next_action', 'Next Action', 'pipeline', 'text', {
    emptyLabel: 'Review',
    filterable: true,
  }),
  def('next_action_due', 'Next Action Due', 'pipeline', 'datetime', {
    sortable: true,
    filterable: true,
  }),
  def('follow_up_due', 'Follow-Up Due', 'pipeline', 'datetime', {
    description: 'Workflow follow-up scheduled time.',
    sortable: true,
    filterable: true,
  }),
  def('follow_up_reason', 'Follow-Up Reason', 'pipeline', 'text', {
    filterable: true,
  }),
  def('blocker', 'Blocker', 'pipeline', 'text', {
    emptyLabel: 'None',
    filterable: true,
  }),
  def('automation_state', 'Automation State', 'pipeline', 'select', {
    filterable: true,
  }),
  def('workflow_state', 'Workflow State', 'pipeline', 'select', {
    filterable: true,
    groupable: true,
  }),
  def('queue_state', 'Queue State', 'pipeline', 'select', {
    filterable: true,
    groupable: true,
  }),
  def('asking_price', 'Asking Price', 'deal_intelligence', 'currency', {
    description: 'Seller-provided asking price when known.',
    sortable: true,
    filterable: true,
  }),
  def('recommended_offer', 'Recommended Offer', 'deal_intelligence', 'currency', {
    description: 'Engine-recommended offer after successful run.',
    emptyLabel: 'Not calculated',
    sortable: true,
    filterable: true,
    stageApplicability: 'offer_plus',
    visibilityCondition: 'engine_run_success',
    canBeStale: true,
  }),
  def('current_offer', 'Current Offer', 'deal_intelligence', 'currency', {
    sortable: true,
    filterable: true,
  }),
  def('seller_counter', 'Seller Counter', 'deal_intelligence', 'currency', {
    sortable: true,
    filterable: true,
  }),
  def('offer_to_ask_gap', 'Offer Gap', 'deal_intelligence', 'currency', {
    sortable: true,
    filterable: true,
  }),
  def('motivation_score', 'Motivation', 'deal_intelligence', 'number', {
    emptyLabel: 'Not calculated',
    sortable: true,
    filterable: true,
  }),
  def('cooperation_score', 'Cooperation', 'deal_intelligence', 'number', {
    emptyLabel: 'Not calculated',
    sortable: true,
    filterable: true,
  }),
  def('strategy', 'Strategy', 'deal_intelligence', 'select', {
    emptyLabel: 'Not determined',
    filterable: true,
    stageApplicability: 'offer_plus',
    visibilityCondition: 'engine_run_success',
    canBeStale: true,
  }),
  def('aos', 'Acquisition Opportunity Score', 'deal_intelligence', 'score', {
    description: 'Calculated by Acquisition Decision Engine after sufficient property, seller and valuation inputs exist. Not available on most early-stage opportunities.',
    emptyLabel: 'Not Run',
    sortable: true,
    filterable: true,
    stageApplicability: 'offer_plus',
    visibilityCondition: 'engine_run_success',
    calculated: true,
    canBeStale: true,
  }),
  def('aos_confidence', 'AOS Confidence', 'deal_intelligence', 'percent', {
    emptyLabel: 'Not calculated',
    stageApplicability: 'offer_plus',
    visibilityCondition: 'engine_run_success',
    canBeStale: true,
  }),
  def('engine_run_state', 'Engine Run State', 'deal_intelligence', 'select', {
    description: 'Whether acquisition engine has completed successfully.',
    emptyLabel: 'Not Run',
    filterable: true,
  }),
  def('estimated_value', 'Estimated Value', 'deal_intelligence', 'currency', {
    sortable: true,
    filterable: true,
  }),
  def('arv', 'ARV', 'deal_intelligence', 'currency', {
    stageApplicability: 'offer_plus',
    visibilityCondition: 'engine_run_success',
    sortable: true,
    filterable: true,
    canBeStale: true,
  }),
  def('equity_amount', 'Equity', 'property', 'currency', {
    description: 'Estimated equity from hydrated property.',
  }),
  def('opportunity_status', 'Opportunity Status', 'pipeline', 'select', {
    filterable: true,
  }),
]

export const PIPELINE_FIELD_REGISTRY_MAP = Object.fromEntries(
  PIPELINE_FIELD_REGISTRY.map((f) => [f.key, f]),
)

export function getPipelineField(key: string): PipelineFieldDefinition | undefined {
  return PIPELINE_FIELD_REGISTRY_MAP[key]
}

export function getCardCompatibleFields(): PipelineFieldDefinition[] {
  return PIPELINE_FIELD_REGISTRY.filter((f) => f.cardCompatible)
}

export function getSortableFields(): PipelineFieldDefinition[] {
  return PIPELINE_FIELD_REGISTRY.filter((f) => f.sortable)
}

export function getFilterableFields(): PipelineFieldDefinition[] {
  return PIPELINE_FIELD_REGISTRY.filter((f) => f.filterable)
}

export const PIPELINE_FIELD_GROUP_LABELS: Record<PipelineFieldGroup, string> = {
  seller_owner: 'Seller / Owner',
  property: 'Property',
  conversation: 'Conversation',
  pipeline: 'Pipeline',
  deal_intelligence: 'Deal Intelligence',
  contract_closing: 'Contract / Closing',
}