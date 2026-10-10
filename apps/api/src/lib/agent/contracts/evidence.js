// LeadCommand Global AI Agent — source + evidence contracts (S1).
//
// Pure ESM, no imports. Source of truth: entity-graph-deep-research-design.md
// §4.1 (tables), §4.2 (evidence status — exact vocabulary), §1F (source
// explorer), §1K (brief sections), §6.1 (adapter contract).
//
// HARD RULE (DR §4.2): `blocked` and `unavailable` are NEVER evidence of
// absence. Such a finding has value === null and may not carry a negative
// ("none found") claim. A negative claim requires a successful, covering query
// against a source whose registry entry declares supports_negative=true.

/**
 * @typedef {'county_confirmed'|'recorded'|'vendor_reported'|'licensed_provider'|'model_inference'|'unverified'|'stale'|'unavailable'|'blocked'} EvidenceStatus
 */
export const EVIDENCE_STATUSES = Object.freeze([
  'county_confirmed',
  'recorded',
  'vendor_reported',
  'licensed_provider',
  'model_inference',
  'unverified',
  'stale',
  'unavailable',
  'blocked',
])

/** Display copy for each status. UI must use these labels, not invent new ones. */
export const EVIDENCE_STATUS_META = Object.freeze({
  county_confirmed: {
    label: 'County-confirmed',
    description: 'Official county/city system of record, matched by parcel, fresh.',
    has_value: true,
    is_absence: false,
  },
  recorded: {
    label: 'Recorded',
    description: 'A recorded instrument (deed, lien, lis pendens) from the recorder or recorded-document data.',
    has_value: true,
    is_absence: false,
  },
  vendor_reported: {
    label: 'Vendor-reported',
    description: 'A vendor data snapshot. Not independently verified.',
    has_value: true,
    is_absence: false,
  },
  licensed_provider: {
    label: 'Licensed provider',
    description: 'A licensed data API under contract.',
    has_value: true,
    is_absence: false,
  },
  model_inference: {
    label: 'Model inference',
    description: 'Derived by a model from cited observations. Always shown as "(inference)". Confidence capped at 0.6.',
    has_value: true,
    is_absence: false,
  },
  unverified: {
    label: 'Unverified',
    description: 'No adequate source yet, or needs operator review.',
    has_value: true,
    is_absence: false,
  },
  stale: {
    label: 'Stale',
    description: 'Was sourced, but is past its freshness window.',
    has_value: true,
    is_absence: false,
  },
  unavailable: {
    label: 'Unavailable',
    description: 'No supported source, source down, or timed out. Not evidence of absence.',
    has_value: false,
    is_absence: false,
  },
  blocked: {
    label: 'Blocked',
    description: 'The source refused automated access. Not evidence of absence.',
    has_value: false,
    is_absence: false,
  },
})

/**
 * S3 (2026-10-09) ADDITIVE statuses for live Quick Scan evidence. They are NOT
 * in EVIDENCE_STATUSES (the DR §4.2 external-evidence vocabulary stays exact,
 * so existing mirrors keep matching); a live finding may carry any status in
 * EXTENDED_EVIDENCE_STATUSES. See contracts/CHANGELOG.md.
 *   internal_record  LeadCommand's own system of record for an internal fact
 *                    (campaign target graph eligibility, outreach state, MI rollups)
 *   derived          computed by a deterministic, named rule from cited inputs
 *                    (e.g. equity_known_v1) — never a model; never above its weakest input
 */
export const EXTENDED_EVIDENCE_STATUSES = Object.freeze([...EVIDENCE_STATUSES, 'internal_record', 'derived'])

export const EXTENDED_EVIDENCE_STATUS_META = Object.freeze({
  ...EVIDENCE_STATUS_META,
  internal_record: {
    label: 'LeadCommand record',
    description: "LeadCommand's own record of an internal fact (eligibility, outreach, market rollups). Authoritative for that fact only.",
    has_value: true,
    is_absence: false,
  },
  derived: {
    label: 'Derived',
    description: 'Computed by a named deterministic rule from the cited inputs. No model. Never stronger than its weakest input.',
    has_value: true,
    is_absence: false,
  },
})

/**
 * P4 evidence SOURCE CLASSES (owner directive 10-09): the five visual classes.
 * Every live finding carries exactly one `source_class`, and its
 * `evidence_status` must be one this class allows.
 * @typedef {'official_public_record'|'internal_record'|'third_party_vendor'|'derived_inferred'|'unavailable_blocked'} EvidenceSourceClass
 */
export const EVIDENCE_SOURCE_CLASSES = Object.freeze([
  'official_public_record',
  'internal_record',
  'third_party_vendor',
  'derived_inferred',
  'unavailable_blocked',
])

export const EVIDENCE_SOURCE_CLASS_META = Object.freeze({
  official_public_record: {
    label: 'Official public record',
    description: 'A county-recorded instrument or official system of record. Shown with how it reached us (direct or vendor-transcribed).',
    statuses: ['county_confirmed', 'recorded'],
  },
  internal_record: {
    label: 'LeadCommand record',
    description: "LeadCommand's own operational record (campaign graph, inbox, pipeline, market rollups).",
    statuses: ['internal_record'],
  },
  third_party_vendor: {
    label: 'Third-party vendor',
    description: 'A data-vendor snapshot (flags, estimates, parcel attributes). Not independently verified.',
    statuses: ['vendor_reported', 'licensed_provider', 'stale'],
  },
  derived_inferred: {
    label: 'Derived / inferred',
    description: 'Computed from cited inputs by a named rule (or, in later phases, a labelled model inference).',
    statuses: ['derived', 'model_inference', 'unverified'],
  },
  unavailable_blocked: {
    label: 'Unavailable / blocked',
    description: 'Could not be read. No value. Never evidence that something is absent.',
    statuses: ['unavailable', 'blocked'],
  },
})

/**
 * Validate a live finding's source class. Returns violation codes (empty = valid).
 * @param {{ source_class?: string, evidence_status?: string, value?: unknown }} finding
 */
export function sourceClassViolations(finding) {
  const v = []
  const meta = EVIDENCE_SOURCE_CLASS_META[finding?.source_class]
  if (!meta) return ['UNKNOWN_SOURCE_CLASS']
  if (!meta.statuses.includes(finding.evidence_status)) v.push('SOURCE_CLASS_STATUS_MISMATCH')
  if (finding.source_class === 'unavailable_blocked' && finding.value !== null && finding.value !== undefined) v.push('NO_VALUE_STATUS_HAS_VALUE')
  return v
}

/**
 * Quick Scan finding types that have no DR §4.1 equivalent (S3, additive).
 * FINDING_TYPES is unchanged; the UI should look up FINDING_TYPES first, then these.
 */
export const QUICK_SCAN_FINDING_TYPES = Object.freeze({
  property_facts: { label: 'Property facts', section: 'property_ownership', inspector_panel: 'ownership' },
  transfer_history: { label: 'Sales & transfers', section: 'property_ownership', inspector_panel: 'ownership' },
  equity: { label: 'Equity', section: 'taxes_liens', inspector_panel: 'financial_risk' },
  valuation: { label: 'Valuation reference', section: 'comparable_sales', inspector_panel: 'comps' },
  outreach_state: { label: 'Outreach state', section: 'next_investigation', inspector_panel: 'contact' },
  sms_eligibility: { label: 'SMS eligibility', section: 'next_investigation', inspector_panel: 'contact' },
  market_context: { label: 'ZIP market context', section: 'investor_demand', inspector_panel: 'buyers' },
  street_view: { label: 'Street View availability', section: 'physical_condition', inspector_panel: 'distress' },
})

/** Statuses whose findings carry no value and can never support a negative claim. */
export const NO_VALUE_EVIDENCE_STATUSES = Object.freeze(['unavailable', 'blocked'])

/** Authority weight used by the confidence rule (DR §4.2). Rule output, not model self-report. */
export const EVIDENCE_AUTHORITY_WEIGHT = Object.freeze({
  county_confirmed: 1.0,
  recorded: 0.95,
  licensed_provider: 0.85,
  vendor_reported: 0.6,
  model_inference: 0.6,
  unverified: 0.3,
  stale: 0.4,
  unavailable: 0,
  blocked: 0,
  internal_record: 0.9, // S3 additive
  derived: 0.7, // S3 additive; also capped by the weakest input (quick-scan/evidence.js)
})

export const MODEL_INFERENCE_CONFIDENCE_CAP = 0.6

/** @typedef {'fresh'|'aging'|'stale'|'never'} FreshnessState */
export const FRESHNESS_STATES = Object.freeze(['fresh', 'aging', 'stale', 'never'])

/** Source authority class shown in the source explorer (DR §1F). */
/** @typedef {'official'|'licensed'|'commercial'|'search'|'internal'} SourceAuthorityClass */
export const SOURCE_AUTHORITY_CLASSES = Object.freeze(['official', 'licensed', 'commercial', 'search', 'internal'])

export const SOURCE_AUTHORITY_LABELS = Object.freeze({
  official: 'Official',
  licensed: 'Licensed',
  commercial: 'Commercial',
  search: 'Search',
  internal: 'Internal',
})

/** @typedef {'supabase'|'open_api'|'bulk_file'|'licensed_api'|'official_lookup'|'manual_link'|'blocked'} SourceAccessMode */
export const SOURCE_ACCESS_MODES = Object.freeze([
  'supabase',
  'open_api',
  'bulk_file',
  'licensed_api',
  'official_lookup',
  'manual_link',
  'blocked',
])

/** Per-source-operation status in the source explorer (one row per source operation target). */
/** @typedef {'planned'|'searched'|'opened'|'retrieved'|'blocked'|'failed'|'skipped_fresh'} SourceOperationStatus */
export const SOURCE_OPERATION_STATUSES = Object.freeze([
  'planned',
  'searched',
  'opened',
  'retrieved',
  'blocked',
  'failed',
  'skipped_fresh',
])

/** Reason codes for blocked/failed sources (DR §4.3). No stack traces, ever. */
export const SOURCE_FAILURE_REASONS = Object.freeze([
  'http_403',
  'captcha_detected',
  'login_required',
  'robots_disallow',
  'tos_restricted',
  'not_in_registry',
  'timeout',
  'http_5xx',
  'parse_error',
  'no_supported_source_for_jurisdiction',
])

export const BLOCKED_REASONS = Object.freeze([
  'http_403',
  'captcha_detected',
  'login_required',
  'robots_disallow',
  'tos_restricted',
  'not_in_registry',
])

/** @typedef {'deterministic'|'manual'|string} ExtractionMethod  // or 'model:<id>@<ver>' */

/** Finding types used by Deep Research (extensible; UI groups them into brief sections). */
export const FINDING_TYPES = Object.freeze({
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
})

/** Brief sections, fixed order (DR §1K). */
export const BRIEF_SECTIONS = Object.freeze([
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
])

/** Opportunity class (property quality) — NEVER merged with contact readiness (DR §8.2). */
export const OPPORTUNITY_CLASSES = Object.freeze(['priority', 'strong', 'standard', 'weak', 'excluded', 'unknown'])
/** Contact readiness — separate classification, separate visual vocabulary. */
export const CONTACT_READINESS_CLASSES = Object.freeze(['ready', 'held', 'ineligible', 'unknown'])

/** Conflict resolution state (`research.finding_conflict`). */
export const CONFLICT_RESOLUTION_STATES = Object.freeze(['open', 'resolved_by_rule', 'resolved_by_operator'])

/**
 * A registered source (subset of `research.source` the UI needs).
 * @typedef {Object} SourceDescriptor
 * @property {string} source_id
 * @property {string} adapter_id
 * @property {number} adapter_version
 * @property {string} name                 display name
 * @property {SourceAuthorityClass} authority_class
 * @property {SourceAccessMode} access_mode
 * @property {string} host                 registry host (favicon from static map; never fetched live)
 * @property {string|null} jurisdiction    e.g. 'Cuyahoga County, OH'
 * @property {string[]} finding_types
 * @property {boolean} supports_negative
 * @property {boolean} billable
 * @property {boolean} [test_data]         true for every fixture source
 */

/**
 * One row in the source explorer (per source operation target).
 * @typedef {Object} SourceOperation
 * @property {string} task_id
 * @property {string} source_id
 * @property {string|null} property_id
 * @property {string} purpose              e.g. 'tax status'
 * @property {SourceOperationStatus} status
 * @property {string|null} retrieved_at
 * @property {number} finding_count
 * @property {string|null} reason          failure/blocked reason code
 * @property {string[]} alternatives       alternatives offered on a blocked card (source names / manual links)
 */

/**
 * A governed finding (`research.finding`).
 * @typedef {Object} Finding
 * @property {string} finding_id
 * @property {string} property_id
 * @property {string} finding_type
 * @property {string} key
 * @property {*} value                     null when status is unavailable/blocked
 * @property {string|null} display_value   short user-facing value ('Delinquent $1,804')
 * @property {EvidenceStatus} evidence_status
 * @property {number} confidence           0..1, rule output
 * @property {'high'|'medium'|'low'} confidence_band
 * @property {boolean} is_inference
 * @property {boolean} is_discovery        classification-changing (gold reveal)
 * @property {boolean} is_negative_claim   "none found" — requires supports_negative source + success
 * @property {FreshnessState} freshness_state
 * @property {string|null} observed_at
 * @property {string|null} retrieved_at
 * @property {string|null} fresh_until
 * @property {string|null} source_id
 * @property {string|null} citation        field path or text span
 * @property {string|null} supersedes_id
 * @property {string|null} contradicted_by finding id that downgraded this one
 * @property {string|null} conflict_group_id
 */

/** Confidence band from a 0..1 score. */
export function confidenceBand(score) {
  const n = Number(score)
  if (!Number.isFinite(n)) return 'low'
  if (n >= 0.8) return 'high'
  if (n >= 0.5) return 'medium'
  return 'low'
}

/**
 * Validate the evidence invariants of a finding. Returns a list of violation
 * codes (empty = valid). Shared by the server evidence service and fixtures.
 * @param {Partial<Finding>} finding
 * @param {{ supports_negative?: boolean, query_succeeded?: boolean }} [sourceContext]
 * @returns {string[]}
 */
export function findingViolations(finding, sourceContext = {}) {
  const violations = []
  const status = finding?.evidence_status
  if (!EXTENDED_EVIDENCE_STATUSES.includes(status)) violations.push('UNKNOWN_EVIDENCE_STATUS')
  if (NO_VALUE_EVIDENCE_STATUSES.includes(status)) {
    if (finding.value !== null && finding.value !== undefined) violations.push('NO_VALUE_STATUS_HAS_VALUE')
    if (finding.is_negative_claim) violations.push('BLOCKED_OR_UNAVAILABLE_IS_NOT_ABSENCE')
  }
  if (finding?.is_negative_claim && !NO_VALUE_EVIDENCE_STATUSES.includes(status)) {
    if (!sourceContext.supports_negative || !sourceContext.query_succeeded) {
      violations.push('NEGATIVE_CLAIM_WITHOUT_COVERING_SOURCE')
    }
  }
  if (status === 'model_inference') {
    if (!finding.is_inference) violations.push('INFERENCE_NOT_LABELLED')
    if (Number(finding.confidence) > MODEL_INFERENCE_CONFIDENCE_CAP) violations.push('INFERENCE_CONFIDENCE_OVER_CAP')
  }
  return violations
}
