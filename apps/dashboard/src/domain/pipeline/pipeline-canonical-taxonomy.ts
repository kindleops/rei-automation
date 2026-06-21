/**
 * Dashboard mirror of apps/api/src/lib/domain/opportunity/universal-pipeline-registry.js
 * Do not invent values here — keep aligned with acquisition/classification source of truth.
 */

export const UNIVERSAL_STAGE_ORDER = [
  'ownership_confirmation',
  'offer_interest',
  'asking_price',
  'property_condition',
  'offer',
  'formal_contract',
  'under_contract',
  'disposition',
  'prepared_to_close',
  'closed',
] as const

export const UNIVERSAL_STAGE_LABELS: Record<string, string> = {
  ownership_confirmation: 'Ownership Confirmation',
  offer_interest: 'Offer Interest',
  asking_price: 'Asking Price',
  property_condition: 'Property Condition',
  offer: 'Offer',
  formal_contract: 'Formal Contract',
  under_contract: 'Under Contract',
  disposition: 'Disposition',
  prepared_to_close: 'Prepared to Close',
  closed: 'Closed',
}

export const UNIVERSAL_STATUS_ORDER = [
  'priority',
  'waiting',
  'cold',
  'follow_up',
  'needs_review',
  'unknown',
] as const

export const UNIVERSAL_STATUS_LABELS: Record<string, string> = {
  priority: 'Priority',
  waiting: 'Waiting',
  cold: 'Cold',
  follow_up: 'Follow Up',
  needs_review: 'Needs Review',
  unknown: 'Unknown',
}

export const UNIVERSAL_TEMPERATURE_ORDER = [
  'hot',
  'warming',
  'engaged',
  'cold',
  'dead',
  'unknown',
] as const

export const UNIVERSAL_TEMPERATURE_LABELS: Record<string, string> = {
  hot: 'Hot',
  warming: 'Warming',
  engaged: 'Engaged',
  cold: 'Cold',
  dead: 'Dead',
  unknown: 'Unclassified',
}

export type PipelineScopePredicate = {
  scope: string
  label: string
  sqlPredicate: string
}

export const PIPELINE_SCOPE_PREDICATES: PipelineScopePredicate[] = [
  { scope: 'active', label: 'Active', sqlPredicate: "opportunity_status IN ('active','waiting','paused','nurture')" },
  { scope: 'needs_attention', label: 'Needs Attention', sqlPredicate: "universal_status IN ('priority','needs_review','follow_up') OR conversation_state = 'needs_reply'" },
  { scope: 'all', label: 'All', sqlPredicate: 'no terminal exclusion' },
  { scope: 'dead', label: 'Dead', sqlPredicate: "opportunity_status = 'dead'" },
  { scope: 'suppressed', label: 'Suppressed', sqlPredicate: "opportunity_status = 'suppressed'" },
  { scope: 'closed', label: 'Closed / Archived', sqlPredicate: "acquisition_stage = 'closed' OR opportunity_status IN ('archived','won','lost')" },
]