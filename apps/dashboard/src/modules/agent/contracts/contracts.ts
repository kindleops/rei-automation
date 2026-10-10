/**
 * AGENT CONTRACTS — the dashboard mirror of the S1 shared contracts in
 * apps/api/src/lib/agent/contracts/{events,states,evidence}.js.
 *
 * The API files are pure ESM written to be copied verbatim by the UI; the
 * dashboard's tsconfig only includes src/, so the values are mirrored here
 * as typed constants. contracts-drift.test.ts imports the API files and
 * fails when a value below no longer matches — a mirror can lag, but it can
 * never silently disagree.
 *
 * Rules the UI keeps (from the contract headers):
 *   · the UI renders only states it receives in events; it never advances a
 *     state on its own and never invents a step or a progress tick;
 *   · `blocked` / `unavailable` are never evidence of absence;
 *   · `decision` is a ≤ 240-char user-facing summary, never chain-of-thought;
 *   · fixture events carry `fixture: true` — production events never do.
 */

/* ── events (events.js) ─────────────────────────────────────────────── */

export interface AgentEvent<P = Record<string, unknown>> {
  event_id: number
  run_id: string
  seq: number
  type: AgentEventType
  at: string
  attempt: number
  visibility: 'operator' | 'internal'
  property_id: string | null
  task_id: string | null
  tool_call_id: string | null
  payload: P
  /** present (true) only on fixture events */
  fixture?: true
  /** fixture only: recorded offset from the scenario start, for the player */
  fixture_t_ms?: number
}

export const EVENT_SUMMARY_MAX_CHARS = 240

export const EVENT_TYPES = [
  'run.created', 'run.state', 'run.completed', 'run.failed', 'run.cancel_requested', 'run.cancelled', 'run.budget_exhausted',
  'message.operator', 'message.delta', 'message.completed', 'decision',
  'context.attached', 'context.detached',
  'plan.proposed', 'plan.approved', 'plan.rejected', 'plan.step_state', 'plan.task_added', 'plan.skipped_fresh',
  'tool.proposed', 'tool.started', 'tool.completed', 'tool.refused', 'tool.failed', 'tool.outcome_unknown',
  'approval.requested', 'approval.granted', 'approval.denied', 'approval.expired', 'approval.invalidated', 'approval.consumed',
  'artifact.created', 'artifact.updated', 'artifact.applied', 'artifact.superseded',
  'ui.intent',
  'undo.available', 'undo.executed', 'undo.refused',
  'usage.reserved', 'usage.settled', 'budget.stopped',
  'job.created', 'job.confirmed', 'job.phase', 'job.paused', 'job.resumed', 'job.cancel_requested', 'job.cancelled', 'job.budget_exhausted', 'job.completed', 'job.failed', 'job.property_state',
  'task.started', 'task.completed', 'task.blocked', 'task.failed', 'task.unavailable', 'task.needs_input', 'task.cancelled',
  'source.searched', 'source.opened', 'source.retrieved', 'source.blocked', 'source.failed',
  'observation.extracted', 'finding.upserted', 'finding.conflict',
  'brief.section', 'brief.completed',
] as const
export type AgentEventType = typeof EVENT_TYPES[number]

/** Every label on task.started / tool.started / plan.task_added re-renders from one of these. */
export const OPERATION_LABEL_TEMPLATES = {
  'research.check': 'Checking {jurisdiction} {finding_label} ({source_name})',
  'research.match_parcel': 'Matching parcel in {source_name}',
  'research.extract': 'Extracting {finding_label} from {source_name}',
  'research.cross_check': 'Cross-checking {finding_label}: {source_name} vs {other_source_name}',
  'research.manual_link': 'Manual check needed: {source_name}',
  'research.synthesize_section': 'Writing brief section: {section_label}',
  'research.reuse_fresh': 'Reusing fresh {finding_label} ({source_name})',
  'tool.invoke': '{tool_label}',
} as const
export type OperationId = keyof typeof OPERATION_LABEL_TEMPLATES

export const LABELLED_EVENT_TYPES = ['task.started', 'tool.started', 'plan.task_added'] as const

/** Render an operation label; throws on an unknown operation or a missing variable (labels are never free text). */
export function renderOperationLabel(operation: string, vars: Record<string, string | number> = {}): string {
  const template = (OPERATION_LABEL_TEMPLATES as Record<string, string>)[operation]
  if (!template) throw new Error(`UNKNOWN_OPERATION:${operation}`)
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const value = vars[key]
    if (value === undefined || value === null || String(value).trim() === '') throw new Error(`OPERATION_LABEL_MISSING_VAR:${operation}:${key}`)
    return String(value)
  })
}

export const SANITIZE_FORBIDDEN_KEYS = ['thinking', 'thinking_text', 'reasoning', 'chain_of_thought', 'raw_text', 'raw_html', 'stack', 'stack_trace', 'api_key', 'apikey', 'token', 'secret', 'password', 'authorization', 'cookie', 'approval_token'] as const

/* ── states (states.js) ─────────────────────────────────────────────── */

export type RunKind = 'conversation' | 'task' | 'research'
export const RUN_STATES = ['created', 'planning', 'awaiting_plan_approval', 'running', 'waiting_tool', 'awaiting_approval', 'needs_input', 'paused', 'completed', 'completed_partial', 'budget_exhausted', 'cancelled', 'failed', 'failed_retryable', 'expired'] as const
export type RunState = typeof RUN_STATES[number]
export const RUN_TERMINAL_STATES: readonly RunState[] = ['completed', 'completed_partial', 'budget_exhausted', 'cancelled', 'failed', 'expired']

export const TOOL_CALL_STATES = ['proposed', 'authorized', 'approval_requested', 'approved', 'denied', 'expired', 'invalidated', 'executing', 'succeeded', 'refused', 'failed', 'outcome_unknown', 'undone'] as const
export type ToolCallState = typeof TOOL_CALL_STATES[number]

export const RESEARCH_JOB_STATES = ['draft', 'queued', 'running', 'paused', 'synthesizing', 'completed', 'completed_partial', 'budget_exhausted', 'cancelled', 'failed', 'expired'] as const
export type ResearchJobState = typeof RESEARCH_JOB_STATES[number]
export const RESEARCH_JOB_TERMINAL_STATES: readonly ResearchJobState[] = ['completed', 'completed_partial', 'budget_exhausted', 'cancelled', 'failed', 'expired']

export const RESEARCH_TASK_STATES = ['planned', 'skipped_fresh', 'queued', 'running', 'succeeded', 'blocked', 'unavailable', 'needs_input', 'failed', 'cancelled', 'budget_stopped'] as const
export type ResearchTaskState = typeof RESEARCH_TASK_STATES[number]

export const RESEARCH_PHASES = ['planning', 'researching', 'analyzing', 'cross_checking', 'synthesizing', 'complete'] as const
export type ResearchPhase = typeof RESEARCH_PHASES[number]
export const RESEARCH_PHASE_LABELS: Record<ResearchPhase, string> = {
  planning: 'Planning', researching: 'Researching', analyzing: 'Analyzing', cross_checking: 'Cross-checking', synthesizing: 'Synthesizing', complete: 'Complete',
}

export const RESEARCH_DEPTHS = ['quick', 'deep', 'diligence'] as const
export type ResearchDepth = typeof RESEARCH_DEPTHS[number]
export const RESEARCH_DEPTH_LABELS: Record<ResearchDepth, string> = { quick: 'Quick Scan', deep: 'Deep Research', diligence: 'Acquisition Diligence' }

export const JOB_PROPERTY_STATES = ['queued', 'running', 'completed', 'completed_partial', 'budget_stopped', 'cancelled', 'failed', 'skipped_fresh'] as const
export type JobPropertyState = typeof JOB_PROPERTY_STATES[number]

/** T4 is deliberately not representable. */
export type Tier = 'T0' | 'T1' | 'T2' | 'T3'
export const TIER_LABELS: Record<Tier, string> = { T0: 'Read', T1: 'Draft', T2: 'Reversible change', T3: 'Needs your approval' }

/* ── evidence (evidence.js) ─────────────────────────────────────────── */

export const EVIDENCE_STATUSES = ['county_confirmed', 'recorded', 'vendor_reported', 'licensed_provider', 'model_inference', 'unverified', 'stale', 'unavailable', 'blocked'] as const
export type EvidenceStatus = typeof EVIDENCE_STATUSES[number]

export const EVIDENCE_STATUS_META: Record<EvidenceStatus, { label: string; description: string; has_value: boolean; is_absence: false }> = {
  county_confirmed: { label: 'County-confirmed', description: 'Official county/city system of record, matched by parcel, fresh.', has_value: true, is_absence: false },
  recorded: { label: 'Recorded', description: 'A recorded instrument (deed, lien, lis pendens) from the recorder or recorded-document data.', has_value: true, is_absence: false },
  vendor_reported: { label: 'Vendor-reported', description: 'A vendor data snapshot. Not independently verified.', has_value: true, is_absence: false },
  licensed_provider: { label: 'Licensed provider', description: 'A licensed data API under contract.', has_value: true, is_absence: false },
  model_inference: { label: 'Model inference', description: 'Derived by a model from cited observations. Always shown as "(inference)". Confidence capped at 0.6.', has_value: true, is_absence: false },
  unverified: { label: 'Unverified', description: 'No adequate source yet, or needs operator review.', has_value: true, is_absence: false },
  stale: { label: 'Stale', description: 'Was sourced, but is past its freshness window.', has_value: true, is_absence: false },
  unavailable: { label: 'Unavailable', description: 'No supported source, source down, or timed out. Not evidence of absence.', has_value: false, is_absence: false },
  blocked: { label: 'Blocked', description: 'The source refused automated access. Not evidence of absence.', has_value: false, is_absence: false },
}
export const NO_VALUE_EVIDENCE_STATUSES: readonly EvidenceStatus[] = ['unavailable', 'blocked']

/* S3 (2026-10-09, additive — contracts/CHANGELOG.md): live Quick Scan statuses + the five P4 source classes */
export const EXTENDED_EVIDENCE_STATUSES = [...EVIDENCE_STATUSES, 'internal_record', 'derived'] as const
export type ExtendedEvidenceStatus = typeof EXTENDED_EVIDENCE_STATUSES[number]
export const EXTENDED_EVIDENCE_STATUS_META: Record<ExtendedEvidenceStatus, { label: string; description: string; has_value: boolean; is_absence: false }> = {
  ...EVIDENCE_STATUS_META,
  internal_record: { label: 'LeadCommand record', description: "LeadCommand's own record of an internal fact (eligibility, outreach, market rollups). Authoritative for that fact only.", has_value: true, is_absence: false },
  derived: { label: 'Derived', description: 'Computed by a named deterministic rule from the cited inputs. No model. Never stronger than its weakest input.', has_value: true, is_absence: false },
}
export const EVIDENCE_SOURCE_CLASSES = ['official_public_record', 'internal_record', 'third_party_vendor', 'derived_inferred', 'unavailable_blocked'] as const
export type EvidenceSourceClass = typeof EVIDENCE_SOURCE_CLASSES[number]
export const QUICK_SCAN_FINDING_TYPES = {
  property_facts: { label: 'Property facts', section: 'property_ownership', inspector_panel: 'ownership' },
  transfer_history: { label: 'Sales & transfers', section: 'property_ownership', inspector_panel: 'ownership' },
  equity: { label: 'Equity', section: 'taxes_liens', inspector_panel: 'financial_risk' },
  valuation: { label: 'Valuation reference', section: 'comparable_sales', inspector_panel: 'comps' },
  outreach_state: { label: 'Outreach state', section: 'next_investigation', inspector_panel: 'contact' },
  sms_eligibility: { label: 'SMS eligibility', section: 'next_investigation', inspector_panel: 'contact' },
  market_context: { label: 'ZIP market context', section: 'investor_demand', inspector_panel: 'buyers' },
  street_view: { label: 'Street View availability', section: 'physical_condition', inspector_panel: 'distress' },
} as const
export type QuickScanFindingType = keyof typeof QUICK_SCAN_FINDING_TYPES
/** FINDING_TYPES first, then the S3 Quick Scan types (CHANGELOG). */
export function findingTypeMeta(t: string): { label: string; section: string; inspector_panel: string } | null {
  return (FINDING_TYPES as Record<string, { label: string; section: string; inspector_panel: string }>)[t] ?? (QUICK_SCAN_FINDING_TYPES as Record<string, { label: string; section: string; inspector_panel: string }>)[t] ?? null
}
export const MODEL_INFERENCE_CONFIDENCE_CAP = 0.6

export type FreshnessState = 'fresh' | 'aging' | 'stale' | 'never'

export const SOURCE_AUTHORITY_CLASSES = ['official', 'licensed', 'commercial', 'search', 'internal'] as const
export type SourceAuthorityClass = typeof SOURCE_AUTHORITY_CLASSES[number]
export const SOURCE_AUTHORITY_LABELS: Record<SourceAuthorityClass, string> = { official: 'Official', licensed: 'Licensed', commercial: 'Commercial', search: 'Search', internal: 'Internal' }

export type SourceAccessMode = 'supabase' | 'open_api' | 'bulk_file' | 'licensed_api' | 'official_lookup' | 'manual_link' | 'blocked'

export const SOURCE_OPERATION_STATUSES = ['planned', 'searched', 'opened', 'retrieved', 'blocked', 'failed', 'skipped_fresh'] as const
export type SourceOperationStatus = typeof SOURCE_OPERATION_STATUSES[number]

export const SOURCE_FAILURE_REASONS = ['http_403', 'captcha_detected', 'login_required', 'robots_disallow', 'tos_restricted', 'not_in_registry', 'timeout', 'http_5xx', 'parse_error', 'no_supported_source_for_jurisdiction'] as const
export type SourceFailureReason = typeof SOURCE_FAILURE_REASONS[number]
export const BLOCKED_REASONS: readonly SourceFailureReason[] = ['http_403', 'captcha_detected', 'login_required', 'robots_disallow', 'tos_restricted', 'not_in_registry']

export const FINDING_TYPES = {
  ownership: { label: 'Ownership', section: 'property_ownership', inspector_panel: 'ownership' },
  parcel: { label: 'Parcel', section: 'property_ownership', inspector_panel: 'ownership' },
  physical_condition: { label: 'Physical condition', section: 'physical_condition', inspector_panel: 'distress' },
  code_violation: { label: 'Code violations', section: 'physical_condition', inspector_panel: 'distress' },
  condemnation: { label: 'Condemnation', section: 'physical_condition', inspector_panel: 'distress' },
  tax_status: { label: 'Tax status', section: 'taxes_liens', inspector_panel: 'taxes_liens' },
  tax_delinquency: { label: 'Tax delinquency', section: 'taxes_liens', inspector_panel: 'taxes_liens' },
  lien: { label: 'Recorded liens', section: 'taxes_liens', inspector_panel: 'taxes_liens' },
  mortgage: { label: 'Mortgage', section: 'taxes_liens', inspector_panel: 'financial_risk' },
  foreclosure: { label: 'Foreclosure', section: 'foreclosure_legal', inspector_panel: 'financial_risk' },
  probate: { label: 'Probate', section: 'foreclosure_legal', inspector_panel: 'financial_risk' },
  listing_status: { label: 'Listing status', section: 'listing_history', inspector_panel: 'listing' },
  comparable_sales: { label: 'Comparable sales', section: 'comparable_sales', inspector_panel: 'comps' },
  investor_demand: { label: 'Investor demand', section: 'investor_demand', inspector_panel: 'buyers' },
  acquisition_economics: { label: 'Acquisition economics', section: 'acquisition_economics', inspector_panel: 'economics' },
} as const
export type FindingType = keyof typeof FINDING_TYPES
export type InspectorPanel = typeof FINDING_TYPES[FindingType]['inspector_panel']

export const BRIEF_SECTIONS = [
  { key: 'property_ownership', label: 'Property & ownership' },
  { key: 'physical_condition', label: 'Physical condition' },
  { key: 'taxes_liens', label: 'Taxes & liens' },
  { key: 'foreclosure_legal', label: 'Foreclosure & legal filings' },
  { key: 'listing_history', label: 'Listing history' },
  { key: 'comparable_sales', label: 'Comparable sales' },
  { key: 'investor_demand', label: 'Investor demand' },
  { key: 'acquisition_economics', label: 'Acquisition economics', diligence_only: true },
  { key: 'risks_unresolved', label: 'Risks & unresolved evidence' },
  { key: 'next_investigation', label: 'Recommended next investigation' },
] as const
export type BriefSectionKey = typeof BRIEF_SECTIONS[number]['key']

export const OPPORTUNITY_CLASSES = ['priority', 'strong', 'standard', 'weak', 'excluded', 'unknown'] as const
export type OpportunityClass = typeof OPPORTUNITY_CLASSES[number]
export const CONTACT_READINESS_CLASSES = ['ready', 'held', 'ineligible', 'unknown'] as const
export type ContactReadinessClass = typeof CONTACT_READINESS_CLASSES[number]
export const CONFLICT_RESOLUTION_STATES = ['open', 'resolved_by_rule', 'resolved_by_operator'] as const
export type ConflictResolutionState = typeof CONFLICT_RESOLUTION_STATES[number]

export interface SourceDescriptor {
  source_id: string
  adapter_id: string
  adapter_version: number
  name: string
  authority_class: SourceAuthorityClass
  access_mode: SourceAccessMode
  host: string
  jurisdiction: string | null
  finding_types: FindingType[]
  supports_negative: boolean
  billable: boolean
  /** true for every fixture source */
  test_data?: boolean
}

export interface Finding {
  finding_id: string
  property_id: string
  finding_type: FindingType | QuickScanFindingType
  key: string
  value: unknown
  display_value: string | null
  evidence_status: ExtendedEvidenceStatus
  confidence: number
  confidence_band: 'high' | 'medium' | 'low'
  is_inference: boolean
  is_discovery: boolean
  is_negative_claim: boolean
  freshness_state: FreshnessState
  observed_at: string | null
  retrieved_at: string | null
  fresh_until: string | null
  source_id: string | null
  citation: string | null
  supersedes_id: string | null
  contradicted_by: string | null
  conflict_group_id: string | null
  /* S3 live superset (CHANGELOG): present on live findings */
  source_class?: EvidenceSourceClass
  source_name?: string | null
  evidence_label?: string | null
  provenance?: string | null
  limitations?: string[]
  basis_finding_ids?: string[]
  unavailable_reason?: string | null
  live?: true
}

export function confidenceBand(score: number): 'high' | 'medium' | 'low' {
  const n = Number(score)
  if (!Number.isFinite(n)) return 'low'
  if (n >= 0.8) return 'high'
  if (n >= 0.5) return 'medium'
  return 'low'
}

/** The shared evidence invariants (empty list = valid). */
export function findingViolations(finding: Partial<Finding>, sourceContext: { supports_negative?: boolean; query_succeeded?: boolean } = {}): string[] {
  const violations: string[] = []
  const status = finding?.evidence_status as EvidenceStatus
  if (!(EXTENDED_EVIDENCE_STATUSES as readonly string[]).includes(status)) violations.push('UNKNOWN_EVIDENCE_STATUS')
  if (NO_VALUE_EVIDENCE_STATUSES.includes(status)) {
    if (finding.value !== null && finding.value !== undefined) violations.push('NO_VALUE_STATUS_HAS_VALUE')
    if (finding.is_negative_claim) violations.push('BLOCKED_OR_UNAVAILABLE_IS_NOT_ABSENCE')
  }
  if (finding?.is_negative_claim && !NO_VALUE_EVIDENCE_STATUSES.includes(status)) {
    if (!sourceContext.supports_negative || !sourceContext.query_succeeded) violations.push('NEGATIVE_CLAIM_WITHOUT_COVERING_SOURCE')
  }
  if (status === 'model_inference') {
    if (!finding.is_inference) violations.push('INFERENCE_NOT_LABELLED')
    if (Number(finding.confidence) > MODEL_INFERENCE_CONFIDENCE_CAP) violations.push('INFERENCE_CONFIDENCE_OVER_CAP')
  }
  return violations
}

/* ── UI-side payload shapes (S1 whitelists name the fields; shapes per the designs) ── */

/** One brief claim (DR §1K): claim · source · evidence status · confidence · freshness. */
export interface BriefClaim {
  text: string
  finding_ids: string[]
  evidence_status: ExtendedEvidenceStatus
  source_class?: EvidenceSourceClass
  confidence: number
  freshness_state: FreshnessState
  source_name: string | null
  is_inference: boolean
}

/* ── approval (approval.js) ─────────────────────────────────────────── */

export const APPROVAL_STATES = ['requested', 'granted', 'denied', 'expired', 'invalidated', 'consumed'] as const
export type ApprovalState = typeof APPROVAL_STATES[number]
export const PAYLOAD_HASH_PREFIX_LEN = 12
/** Refusal copy the card must show (S1 approval.js). Until named-user identity exists (S7), every grant is IDENTITY_REQUIRED. */
export const APPROVAL_REFUSAL_COPY = {
  IDENTITY_REQUIRED: 'Approval unavailable: named-user sign-in is required before any consequential action.',
} as const

export interface ApprovalEffect { summary: string; kind: 'contact' | 'money_stage' | 'materialize' | 'schedule' | 'protective' | 'budget' | 'other'; reversible: boolean; undo_note: string | null }

/** Approval card payload (S1 approval.js ApprovalRequest; arch §3.6). The UI approves exactly what it showed. */
export interface ApprovalRequest {
  approval_id: string
  run_id?: string
  tool_call_id?: string
  tool: string
  tool_version?: number
  tier: 'T3'
  payload_hash_prefix: string
  payload_hash?: string
  effects: ApprovalEffect[]
  precondition_summary: string[]
  target_scope_summary: string
  required_role: 'operator' | 'lead' | 'owner'
  fresh_auth_required: boolean
  owner_only: boolean
  requested_at?: string
  expires_at: string
  state?: ApprovalState
  provenance: { basis: 'turn' | 'plan' | 'untrusted_content'; label: string }
  batch_id: string | null
  identity_available: boolean
  /** UI-side (S2): an operating brake shown up-front; S1 carries this inside precondition_summary */
  title?: string
  brake?: string | null
}

export interface PlanStep { label: string; tool_family: string; tier: Tier; estimate_usd: number | null }

/** Cost shape (arch §5.8): estimate and actual are never collapsed into one number. */
export const ESTIMATE_BASES = ['measured_p50_p90', 'worst_case', 'structural_zero'] as const
export interface CostEstimate { low_usd: number; high_usd: number; basis: typeof ESTIMATE_BASES[number]; worst_case_usd: number }
