// ─── exception-workflows.js ──────────────────────────────────────────────
// Owned exception workflows for Stages 1–6 (audit §8).
//
// Goal: ZERO normal seller messages sit indefinitely in a generic "Needs
// Review" pile. Every message that cannot be auto-handled is routed into an
// OWNED workflow that has: owner, reason, allowed next actions, an automatic
// retry/reclassification rule, an SLA deadline, a fallback action, and a
// terminal resolution. A human may still be required, but the item is tracked,
// not dropped.
//
// This registry is consulted by ensure-inbound-coverage.js, which attaches the
// matching workflow to every human-review decision so the decision can never be
// a dead end.

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// owner roles (logical, map to Discord routing / queues downstream)
export const EXCEPTION_OWNERS = Object.freeze({
  ACQUISITION_REP: "acquisition_rep",
  COMPLIANCE: "compliance_officer",
  SAFETY: "safety_officer",
  OPS: "ops_triage",
  ENGINEERING: "engineering_oncall",
});

/**
 * Each workflow:
 *  - key:               stable identifier
 *  - owner:             responsible role
 *  - sla_ms:            deadline within which the item must be actioned
 *  - allowed_actions:   the explicit, finite set of next actions a human may take
 *  - auto_reclassify:   whether the next inbound message should be re-run through
 *                       the classifier with conversation context (vs frozen)
 *  - fallback_action:   what the system does automatically if the SLA elapses
 *  - terminal:          terminal resolution if fallback also fails / not eligible
 *  - blocks_outreach:   if true, no automated outreach may fire while open
 *  - suppresses_number: if true, the phone number is suppressed on entry
 */
export const EXCEPTION_WORKFLOWS = Object.freeze({
  identity_clarification: {
    key: "identity_clarification",
    label: "Identity Clarification",
    owner: EXCEPTION_OWNERS.ACQUISITION_REP,
    sla_ms: 24 * HOUR,
    allowed_actions: ["confirm_owner", "mark_renter", "mark_wrong_person", "send_identity_clarifier"],
    auto_reclassify: true,
    fallback_action: "send_identity_clarifier",
    terminal: "suppress_unverified_after_2_attempts",
    blocks_outreach: false,
    suppresses_number: false,
  },
  ambiguous_context: {
    key: "ambiguous_context",
    label: "Ambiguous Intent / Context",
    owner: EXCEPTION_OWNERS.ACQUISITION_REP,
    sla_ms: 12 * HOUR,
    allowed_actions: ["send_safe_clarifier", "reclassify_with_context", "manual_reply", "mark_not_interested"],
    auto_reclassify: true,
    fallback_action: "send_safe_clarifier",
    terminal: "nurture_then_close_after_no_response",
    blocks_outreach: false,
    suppresses_number: false,
  },
  legal_compliance_hold: {
    key: "legal_compliance_hold",
    label: "Legal / Compliance Hold",
    owner: EXCEPTION_OWNERS.COMPLIANCE,
    sla_ms: 4 * HOUR,
    allowed_actions: ["review_legal", "escalate_counsel", "suppress_contact"],
    auto_reclassify: false,
    fallback_action: "hold_no_automated_reply",
    terminal: "suppress_contact",
    blocks_outreach: true,
    suppresses_number: false,
  },
  safety_hold: {
    key: "safety_hold",
    label: "Safety / Hostility Hold",
    owner: EXCEPTION_OWNERS.SAFETY,
    sla_ms: 4 * HOUR,
    allowed_actions: ["review_safety", "escalate", "suppress_contact"],
    auto_reclassify: false,
    fallback_action: "hold_no_automated_reply",
    terminal: "suppress_contact",
    blocks_outreach: true,
    suppresses_number: false,
  },
  language_unsupported: {
    key: "language_unsupported",
    label: "Unsupported Language",
    owner: EXCEPTION_OWNERS.OPS,
    sla_ms: 24 * HOUR,
    allowed_actions: ["assign_bilingual_rep", "send_language_clarifier", "manual_reply"],
    auto_reclassify: true,
    fallback_action: "send_language_clarifier",
    terminal: "nurture_then_close_after_no_response",
    blocks_outreach: false,
    suppresses_number: false,
  },
  attachment_manual_processing: {
    key: "attachment_manual_processing",
    label: "Attachment / Document Manual Processing",
    owner: EXCEPTION_OWNERS.OPS,
    sla_ms: 24 * HOUR,
    allowed_actions: ["review_attachment", "acknowledge_receipt", "manual_reply"],
    auto_reclassify: false,
    fallback_action: "acknowledge_receipt_clarifier",
    terminal: "close_after_acknowledged",
    blocks_outreach: false,
    suppresses_number: false,
  },
  conflicting_property_identity: {
    key: "conflicting_property_identity",
    label: "Conflicting Property Identity",
    owner: EXCEPTION_OWNERS.ACQUISITION_REP,
    sla_ms: 24 * HOUR,
    allowed_actions: ["resolve_property", "send_property_clarifier", "merge_records"],
    auto_reclassify: true,
    fallback_action: "send_property_clarifier",
    terminal: "suppress_unverified_after_2_attempts",
    blocks_outreach: false,
    suppresses_number: false,
  },
  technical_classification_failure: {
    key: "technical_classification_failure",
    label: "Technical Classification Failure",
    owner: EXCEPTION_OWNERS.ENGINEERING,
    sla_ms: 2 * HOUR,
    allowed_actions: ["replay_classification", "manual_reply", "escalate_engineering"],
    auto_reclassify: true,
    fallback_action: "replay_classification",
    terminal: "route_to_ambiguous_context",
    blocks_outreach: false,
    suppresses_number: false,
  },
  duplicate_out_of_order: {
    key: "duplicate_out_of_order",
    label: "Duplicate / Out-of-Order Message",
    owner: EXCEPTION_OWNERS.OPS,
    sla_ms: 6 * HOUR,
    allowed_actions: ["dedupe", "reorder_and_reclassify", "ignore_duplicate"],
    auto_reclassify: true,
    fallback_action: "ignore_duplicate",
    terminal: "auto_resolved_duplicate",
    blocks_outreach: false,
    suppresses_number: false,
  },
  suppression_confirmed: {
    key: "suppression_confirmed",
    label: "Suppression Confirmed (opt-out / wrong-number)",
    owner: EXCEPTION_OWNERS.COMPLIANCE,
    sla_ms: 1 * HOUR,
    allowed_actions: ["confirm_suppression", "audit_targeting_source"],
    auto_reclassify: false,
    fallback_action: "confirm_suppression",
    terminal: "suppress_contact",
    blocks_outreach: true,
    suppresses_number: true,
  },
});

// Map a decision's human_review_reason / audit_reason / suppression_reason onto
// the owning exception workflow. This is the bridge from the live decision
// engine's reason strings to an owned, SLA-bound workflow.
const REASON_TO_WORKFLOW = Object.freeze({
  // suppression
  opt_out: "suppression_confirmed",
  wrong_number: "suppression_confirmed",
  wrong_person: "suppression_confirmed",
  // legal / safety
  hostile_or_legal: "safety_hold",
  legal: "legal_compliance_hold",
  legal_sensitive: "legal_compliance_hold",
  timing_complaint_manual_review: "legal_compliance_hold",
  // legal / authority DISCLOSURE tier (§5). These canonical intents previously
  // had no entry and fell to ambiguous_context, whose SLA fallback is
  // send_safe_clarifier with blocks_outreach:false — a seller disclosing a
  // lien or bankruptcy could be sent an automated clarifier. They are a legal
  // hold: outreach blocked until a human looks.
  title_issue: "legal_compliance_hold",
  lien_tax_issue: "legal_compliance_hold",
  bankruptcy_disclosed: "legal_compliance_hold",
  trust_ownership: "legal_compliance_hold",
  llc_corporation: "legal_compliance_hold",
  legal_authority_disclosure: "legal_compliance_hold",
  // respondent / identity classes (§5): the contact is not (or not solely)
  // the owner. Identity clarification, never the generic clarifier.
  tenant_respondent: "identity_clarification",
  property_manager_respondent: "identity_clarification",
  family_member_respondent: "identity_clarification",
  agent_representative_respondent: "identity_clarification",
  executor_heir_respondent: "identity_clarification",
  entity_representative_respondent: "identity_clarification",
  co_owner_respondent: "identity_clarification",
  non_owner_referral: "identity_clarification",
  respondent_identity_review: "identity_clarification",
  // identity
  missing_context: "identity_clarification",
  identity_unclear: "identity_clarification",
  property_correction: "conflicting_property_identity",
  conflicting_property: "conflicting_property_identity",
  // compound second-clause opportunities: a negative first clause plus a new
  // property/seller signal — a human resolves the property identity and
  // continues the conversation; nothing is suppressed.
  new_property_opportunity: "conflicting_property_identity",
  sold_with_new_opportunity: "conflicting_property_identity",
  wrong_person_with_seller_signal: "identity_clarification",
  declined_but_asks_offer: "ambiguous_context",
  // ambiguous
  unclear: "ambiguous_context",
  unclear_low_confidence: "ambiguous_context",
  ambiguous_intent: "ambiguous_context",
  reaction_only: "ambiguous_context",
  acknowledgement: "ambiguous_context",
  confidence_or_policy_block: "ambiguous_context",
  unhandled_classification: "ambiguous_context",
  automation_review_required: "ambiguous_context",
  // objection review
  wants_proof_of_funds: "ambiguous_context",
  financial_distress: "ambiguous_context",
  probate: "ambiguous_context",
  divorce: "ambiguous_context",
  // language
  language_unsupported: "language_unsupported",
  // attachment
  attachment: "attachment_manual_processing",
  mms: "attachment_manual_processing",
  // technical
  missing_classification: "technical_classification_failure",
  conversation_resolution_failed: "technical_classification_failure",
  // duplicate
  duplicate: "duplicate_out_of_order",
  out_of_order: "duplicate_out_of_order",
});

/**
 * Resolve the owned exception workflow for a given reason string.
 * Always returns a workflow (never null) so coverage can never be a dead end —
 * unmapped reasons fall back to ambiguous_context (which itself has an owner,
 * SLA, fallback and terminal resolution).
 */
export function resolveExceptionWorkflow(reason = null) {
  const key = lower(reason).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const workflow_key =
    REASON_TO_WORKFLOW[key] ||
    // prefix tolerance e.g. "probate_low_confidence" → probate
    REASON_TO_WORKFLOW[key.replace(/_low_confidence$/, "")] ||
    "ambiguous_context";
  return EXCEPTION_WORKFLOWS[workflow_key];
}

/**
 * Decision-aware workflow resolution with explicit PRECEDENCE (§5).
 *
 * The executor labels every respondent-class turn with the generic
 * human_review_reason "unhandled_classification", and ensureInboundCoverage
 * prefers the reason over the canonical intent -- so the specific per-intent
 * workflow (identity_clarification / legal_compliance_hold) was never
 * consulted and the turn fell to the generic ambiguous_context clarifier.
 *
 * Rule: a SPECIFIC per-intent owned workflow beats the generic bucket, and
 * only the generic bucket. A specific reason is never downgraded:
 *   1. reason resolves to something other than ambiguous_context -> use it;
 *   2. else, if the canonical intent resolves to something specific -> use it;
 *   3. else ambiguous_context (unchanged behaviour).
 */
export function resolveExceptionWorkflowForDecision({ reason = null, canonical_intent = null } = {}) {
  const byReason = resolveExceptionWorkflow(reason);
  if (byReason?.key !== "ambiguous_context") return byReason;
  const byIntent = resolveExceptionWorkflow(canonical_intent);
  if (byIntent?.key && byIntent.key !== "ambiguous_context") return byIntent;
  return byReason;
}

/** Compute the absolute SLA deadline ISO string from a workflow + now. */
export function exceptionSlaDeadline(workflow, now = new Date()) {
  const base = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const ms = Number(workflow?.sla_ms) || 12 * HOUR;
  return new Date(base + ms).toISOString();
}

export default {
  EXCEPTION_OWNERS,
  EXCEPTION_WORKFLOWS,
  resolveExceptionWorkflow,
  resolveExceptionWorkflowForDecision,
  exceptionSlaDeadline,
};
