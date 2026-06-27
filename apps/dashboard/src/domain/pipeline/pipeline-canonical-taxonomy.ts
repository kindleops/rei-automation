/**
 * Dashboard mirror of apps/api/src/lib/domain/opportunity/universal-pipeline-registry.js
 * Do not invent values here — keep aligned with acquisition/classification source of truth.
 */

export {
  LIFECYCLE_STAGE_ORDER as UNIVERSAL_STAGE_ORDER,
  LIFECYCLE_STAGE_META,
  OPERATIONAL_STATUS_ORDER as UNIVERSAL_STATUS_ORDER,
  OPERATIONAL_STATUS_META as UNIVERSAL_STATUS_LABELS,
  LEAD_TEMPERATURE_ORDER as UNIVERSAL_TEMPERATURE_ORDER,
  LEAD_TEMPERATURE_META as UNIVERSAL_TEMPERATURE_LABELS,
  DISPOSITION_ORDER,
  DISPOSITION_META,
  CONTACTABILITY_ORDER,
  CONTACTABILITY_META,
  normalizeLifecycleStage,
  normalizeOperationalStatus,
  normalizeLeadTemperature,
} from '../lead-state/universal-lead-state-registry'

export const UNIVERSAL_STAGE_LABELS = Object.fromEntries(
  Object.entries({
    ownership_confirmation: 'S1 Ownership Check',
    offer_interest: 'S2 Interest Probe',
    asking_price: 'S3 Asking Price',
    property_condition: 'S4 Property Condition',
    offer: 'S5 Offer',
    formal_contract: 'S6 Formal Contract',
    under_contract: 'S7 Under Contract',
    disposition: 'S8 Disposition',
    prepared_to_close: 'S9 Prepared to Close',
    closed: 'S10 Closed',
  }),
)

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