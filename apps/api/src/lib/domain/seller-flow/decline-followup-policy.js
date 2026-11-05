// ─── decline-followup-policy.js ─────────────────────────────────────────────
// RC 8.5.15 (owner spec "LEADCOMMAND 8.5.15 — AUTONOMOUS AI ACTIVATION").
//
// A "No" means what it answers. This module owns the follow-up consequence of
// the context-bound declines that must NOT earn an automatic follow-up:
//
//  1. S1 OWNERSHIP DENIED / UNVERIFIED -- "No" to "Do you still own 1 Main St?"
//     (classification primary_intent property_specific_non_owner + label
//     ownership_unverified). No nurture, no further ownership question, no
//     property-specific outreach to this recipient for this property pending
//     verification. NEVER a phone suppression: other properties stay
//     contactable; only an explicit stop/opt-out suppresses.
//  2. S2 "No" is NOT here. OWNER DECISION 2026-10-14 (locked): a "No" to
//     selling / "not interested" / "not selling" is the EXISTING 30-day
//     nurture. There is no S2 toggle.
//  3. CONTACT PERMISSION DECLINED -- "No" to "Is it alright if I check back
//     down the road?" (rule ctx_no_after_contact_permission). Outreach in that
//     scope ends: no automatic check-in.
//
export const DECLINE_FOLLOWUP_POLICY_VERSION = "decline-followup-policy-2026-10-14";

export const OWNERSHIP_UNVERIFIED_LABEL = "ownership_unverified";
export const CONTACT_PERMISSION_DECLINE_RULE_ID = "ctx_no_after_contact_permission";

/** The terminal next_action for every decline this module covers. */
export const NO_FOLLOWUP_NEXT_ACTION = "end_outreach_in_scope";

function clean(value) {
  return String(value ?? "").trim();
}

function ruleIds(classification = {}) {
  const ids = Array.isArray(classification?.matched_rule_ids) ? classification.matched_rule_ids : [];
  const extra = clean(classification?.contextual_override?.rule_id);
  return extra ? [...ids, extra] : ids;
}

function labels(classification = {}) {
  const out = [];
  for (const key of ["secondary_intents", "labels"]) {
    if (Array.isArray(classification?.[key])) out.push(...classification[key]);
  }
  if (Array.isArray(classification?.contextual_override?.labels)) out.push(...classification.contextual_override.labels);
  return out.map((v) => clean(v).toLowerCase());
}

/** S1: the bare "No" to the ownership question (ownership denied / unverified). */
export function isOwnershipUnverified(classification = {}) {
  if (!classification || typeof classification !== "object") return false;
  return (
    clean(classification.primary_intent) === "property_specific_non_owner" &&
    labels(classification).includes(OWNERSHIP_UNVERIFIED_LABEL)
  );
}

/**
 * Which no-follow-up decline (if any) this classification is.
 * @returns {null | { kind: 'ownership_unverified'|'ownership_declined_unverified'|'contact_permission_declined', audit_reason: string, policy: string }}
 */
export function resolveDeclineFollowupPolicy(classification = {}) {
  if (!classification || typeof classification !== "object") return null;
  // Compliance always outranks: an opt-out is never re-labelled here.
  if (clean(classification.compliance_flag) === "stop_texting") return null;
  const primary = clean(classification.primary_intent);
  if (primary === "opt_out" || primary === "wrong_number") return null;

  // OWNER DECISION 2026-10-17: the polite decline to the ownership question (ownership UNVERIFIED)
  if (primary === "ownership_declined_unverified") {
    return {
      kind: "ownership_declined_unverified",
      audit_reason: "s1_ownership_declined_unverified_no_followup",
      policy: "property_contact_hold_ownership_unverified",
    };
  }
  if (isOwnershipUnverified(classification)) {
    return {
      kind: "ownership_unverified",
      audit_reason: "s1_ownership_denied_unverified_no_followup",
      policy: "property_scoped_hold_pending_verification",
    };
  }
  if (primary !== "not_interested") return null;
  if (ruleIds(classification).includes(CONTACT_PERMISSION_DECLINE_RULE_ID)) {
    return {
      kind: "contact_permission_declined",
      audit_reason: "contact_permission_declined_no_followup",
      policy: "end_outreach_in_scope",
    };
  }
  return null;
}

/** True when the classification must never schedule an automatic follow-up. */
export function suppressesAutomaticFollowup(classification = {}) {
  return resolveDeclineFollowupPolicy(classification) !== null;
}

export default resolveDeclineFollowupPolicy;
