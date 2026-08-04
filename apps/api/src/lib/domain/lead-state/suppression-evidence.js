// Canonical suppression-evidence contract.
//
// Production audit 2026-08-04: 293 threads were in a binding suppressed state.
// 114 had NO durable evidence of any kind, and 292 were internally
// contradictory — 291 of them carrying `is_suppressed=true` +
// `disposition=suppressed` + `contactability_status=contactable` at the same
// time. The proximate cause was a stage transition writing a compliance field:
// `S1_TO_S4_CONDITION_DISCLOSED` and even `S1_TO_S2_OWNERSHIP_CONFIRMED` set
// contactability_status='do_not_text', which the state writer then escalated
// into is_suppressed=true. No opt-out existed anywhere.
//
// Binding suppression is a claim about what the SELLER told us. It must be
// backed by evidence, and a lifecycle milestone is not evidence.

/** Contactability values that block sending. */
export const BLOCKING_CONTACTABILITY_VALUES = Object.freeze([
  "do_not_text",
  "opted_out",
  "wrong_number",
]);

export const SUPPRESSION_EVIDENCE_TYPES = Object.freeze({
  EXPLICIT_OPT_OUT: "explicit_opt_out",
  CONFIRMED_WRONG_NUMBER: "confirmed_wrong_number",
  LEGAL_PROHIBITION: "legal_prohibition",
  MANUAL_OPERATOR: "manual_operator_suppression",
  SUPPRESSION_RECORD: "active_suppression_record",
});

const VALID_EVIDENCE_TYPES = new Set(Object.values(SUPPRESSION_EVIDENCE_TYPES));

/**
 * Reasons that are explicitly NOT evidence, kept as a named list so the
 * rejection is self-documenting in audits.
 */
export const NON_EVIDENCE_REASONS = Object.freeze([
  "condition_disclosed",
  "asking_price_disclosed",
  "lifecycle_stage",
  "stage_transition",
  "low_confidence",
  "unclear",
  "human_review",
  "automation_review_required",
  "negative_sentiment",
  "not_interested",
  "temperature",
]);

/**
 * Contactability values that ARE their own evidence: they can only be produced
 * by an explicit opt-out or a confirmed wrong number, and they name the reason
 * in the value itself. `do_not_text` is deliberately NOT here — that is the
 * manufactured catch-all the 2026-08-03/04 incident was made of.
 */
export const SELF_EVIDENCING_CONTACTABILITY = Object.freeze(["opted_out", "wrong_number"]);

/** True when a patch attempts to establish a binding suppression state. */
export function patchAssertsBindingSuppression(patch = {}) {
  if (!patch || typeof patch !== "object") return false;
  // A compliance-terminal contactability carries its own reason, so it does not
  // require a separately supplied evidence object.
  if (SELF_EVIDENCING_CONTACTABILITY.includes(String(patch.contactability_status ?? "").trim())) {
    return false;
  }
  if (patch.is_suppressed === true) return true;
  if (String(patch.disposition ?? "").trim().toLowerCase() === "suppressed") return true;
  if (BLOCKING_CONTACTABILITY_VALUES.includes(String(patch.contactability_status ?? "").trim())) {
    return true;
  }
  if (String(patch.inbox_bucket ?? "").trim().toLowerCase() === "suppressed") return true;
  return false;
}

/**
 * Validates a suppression-evidence object.
 * @returns {{ok: boolean, reason?: string, evidence?: object}}
 */
export function validateSuppressionEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") {
    return { ok: false, reason: "missing_suppression_evidence" };
  }

  const type = String(evidence.type ?? "").trim();
  if (!VALID_EVIDENCE_TYPES.has(type)) {
    return { ok: false, reason: "unrecognized_suppression_evidence_type" };
  }

  // Each type must carry the provenance that makes it checkable later.
  if (type === SUPPRESSION_EVIDENCE_TYPES.MANUAL_OPERATOR) {
    if (!String(evidence.actor ?? "").trim()) {
      return { ok: false, reason: "manual_suppression_requires_actor" };
    }
  } else if (type === SUPPRESSION_EVIDENCE_TYPES.SUPPRESSION_RECORD) {
    if (!String(evidence.suppression_record_id ?? "").trim()) {
      return { ok: false, reason: "suppression_record_requires_id" };
    }
  } else if (!String(evidence.source_event_id ?? "").trim()) {
    // Classifier-derived evidence must point at the inbound that produced it.
    return { ok: false, reason: "suppression_evidence_requires_source_event" };
  }

  if (evidence.binding === false) {
    return { ok: false, reason: "non_binding_evidence_cannot_suppress" };
  }

  return {
    ok: true,
    evidence: {
      type,
      source_authority: String(evidence.source_authority ?? "").trim() || null,
      source_event_id: String(evidence.source_event_id ?? "").trim() || null,
      suppression_record_id: String(evidence.suppression_record_id ?? "").trim() || null,
      actor: String(evidence.actor ?? "").trim() || null,
      // The smallest matched span only — never the whole seller message.
      matched_phrase: normalizeMatchedPhrase(evidence.matched_phrase),
      rule_version: String(evidence.rule_version ?? "").trim() || null,
      recorded_at: String(evidence.recorded_at ?? "").trim() || new Date().toISOString(),
      binding: true,
    },
  };
}

/**
 * Keeps the matched span short. Suppression evidence must be auditable without
 * turning the state table into a message archive.
 */
function normalizeMatchedPhrase(value) {
  const phrase = String(value ?? "").trim();
  if (!phrase) return null;
  return phrase.length > 64 ? `${phrase.slice(0, 64)}…` : phrase;
}

/**
 * Gate: may this patch establish binding suppression?
 * @returns {{allowed: boolean, reason?: string, evidence?: object}}
 */
export function authorizeSuppressionMutation({ patch = {}, evidence = null } = {}) {
  if (!patchAssertsBindingSuppression(patch)) {
    return { allowed: true, reason: "no_binding_suppression_asserted" };
  }
  const validated = validateSuppressionEvidence(evidence);
  if (!validated.ok) return { allowed: false, reason: validated.reason };
  return { allowed: true, evidence: validated.evidence };
}

/** The binding fields to strip when suppression is rejected. */
export const BINDING_SUPPRESSION_FIELDS = Object.freeze([
  "is_suppressed",
  "contactability_status",
  "suppressed_at",
]);

/**
 * Detects states that cannot both be true. Returns [] when consistent.
 */
export function detectSuppressionContradictions(row = {}) {
  const contradictions = [];
  const contactability = String(row.contactability_status ?? "").trim();
  const binding =
    row.is_suppressed === true ||
    String(row.disposition ?? "").trim().toLowerCase() === "suppressed";

  if (binding && contactability === "contactable") {
    contradictions.push("contactable_while_binding_suppressed");
  }
  if (BLOCKING_CONTACTABILITY_VALUES.includes(contactability) && row.is_suppressed === false) {
    contradictions.push("blocking_contactability_without_suppression");
  }
  const automation = String(row.automation_state ?? row.automation_status ?? "").trim().toLowerCase();
  if (binding && (automation === "running" || automation === "active")) {
    contradictions.push("automation_running_while_binding_suppressed");
  }
  return contradictions;
}

export default authorizeSuppressionMutation;
