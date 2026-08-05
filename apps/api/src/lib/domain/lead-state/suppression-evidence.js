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
//
// This module owns FOUR things, and they must stay consistent with each other:
//   1. what counts as "binding suppression"      (ONE predicate, used everywhere)
//   2. what counts as evidence for it            (validate + server-side builders)
//   3. what a complete suppression tuple is      (resolveSuppressionWrite)
//   4. which states can never coexist            (detectSuppressionContradictions)

import {
  BLOCKING_CONTACTABILITY,
  CONTACTABILITY_CODES,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Values a caller may pass BEFORE registry normalization that mean a blocking
 * contactability, mapped to the canonical code they stand for.
 *
 * `wrong_number` is the important one: it is NOT a canonical contactability
 * code, so `normalizeContactability("wrong_number")` returns **contactable**.
 * Left unmapped, a confirmed wrong number is written as contactable.
 */
const PRE_CANONICAL_BLOCKING_ALIASES = Object.freeze({
  wrong_number: CONTACTABILITY_CODES.INVALID_NUMBER,
  do_not_contact: CONTACTABILITY_CODES.DNC,
  suppressed: CONTACTABILITY_CODES.OPTED_OUT,
});

/**
 * Contactability values that block sending.
 *
 * Derived from the registry (`CONTACTABILITY_META[*].blocksSend`) so there is
 * ONE source of truth. Before this was a hand-maintained list that omitted
 * `dnc`, `provider_blacklisted` and `invalid_number` — all three of which
 * `buildRowPatch` escalates to `is_suppressed=true`. The gate never saw them,
 * so they wrote binding suppression with zero evidence.
 */
export const BLOCKING_CONTACTABILITY_VALUES = Object.freeze([
  ...BLOCKING_CONTACTABILITY,
  ...Object.keys(PRE_CANONICAL_BLOCKING_ALIASES),
]);

/** The canonical blocking code for a value, or null when it does not block. */
export function canonicalBlockingContactability(value) {
  const key = lower(value);
  if (!key) return null;
  if (BLOCKING_CONTACTABILITY.has(key)) return key;
  return PRE_CANONICAL_BLOCKING_ALIASES[key] || null;
}

export const SUPPRESSION_EVIDENCE_TYPES = Object.freeze({
  EXPLICIT_OPT_OUT: "explicit_opt_out",
  CONFIRMED_WRONG_NUMBER: "confirmed_wrong_number",
  // The seller says they are not that person / do not own that property. That
  // is durable seller-sourced evidence in its own right; folding it under
  // "legal_prohibition" would be a lie in the audit trail.
  CONFIRMED_WRONG_PARTY: "confirmed_wrong_party",
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
 * manufactured catch-all the 2026-08-03/04 incident was made of, and neither
 * are `dnc` / `provider_blacklisted`.
 *
 * `invalid_number` is the CANONICAL code the transition resolver emits for a
 * confirmed wrong number (resolve-seller-stage-transition.js BLOCKING_INTENTS
 * .wrong_number); `wrong_number` is retained as its pre-canonical alias.
 */
export const SELF_EVIDENCING_CONTACTABILITY = Object.freeze([
  CONTACTABILITY_CODES.OPTED_OUT,
  CONTACTABILITY_CODES.INVALID_NUMBER,
  "wrong_number",
]);

/**
 * The ONE normalized view of the suppression-bearing fields. Authorization and
 * contradiction detection both read this, so they can never drift apart.
 */
export function normalizeSuppressionShape(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    is_suppressed:
      source.is_suppressed === true ? true : source.is_suppressed === false ? false : null,
    disposition: lower(source.disposition),
    contactability: lower(source.contactability_status),
    inbox_bucket: lower(source.inbox_bucket),
    automation: lower(source.automation_state ?? source.automation_status),
  };
}

/** The ONE binding-suppression predicate. Takes a normalized shape. */
export function isBindingSuppressionShape(shape = {}) {
  if (!shape || typeof shape !== "object") return false;
  return (
    shape.is_suppressed === true ||
    shape.disposition === "suppressed" ||
    BLOCKING_CONTACTABILITY_VALUES.includes(shape.contactability) ||
    shape.inbox_bucket === "suppressed"
  );
}

/** True when a patch attempts to establish a binding suppression state. */
export function patchAssertsBindingSuppression(patch = {}) {
  if (!patch || typeof patch !== "object") return false;
  const shape = normalizeSuppressionShape(patch);
  // A compliance-terminal contactability carries its own reason, so it does not
  // require a separately supplied evidence object.
  if (SELF_EVIDENCING_CONTACTABILITY.includes(shape.contactability)) return false;
  return isBindingSuppressionShape(shape);
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

export const OPERATOR_SUPPRESSION_RULE_VERSION = "operator_suppression_v1";
export const INBOUND_SUPPRESSION_RULE_VERSION = "inbound_suppression_v1";

/**
 * SERVER-SIDE evidence for an operator-initiated suppression.
 *
 * The actor MUST come from the server's own auth context. A request body can
 * never supply evidence — that would let any caller mint its own authority.
 * Returns null when no server-verified actor exists, which makes the gate
 * reject the write (fail closed).
 */
export function buildOperatorSuppressionEvidence({
  actor = null,
  reason = null,
  source_authority = null,
} = {}) {
  const trimmedActor = String(actor ?? "").trim();
  if (!trimmedActor) return null;
  const validated = validateSuppressionEvidence({
    type: SUPPRESSION_EVIDENCE_TYPES.MANUAL_OPERATOR,
    actor: trimmedActor,
    source_authority: source_authority || "operator_console",
    matched_phrase: reason,
    rule_version: OPERATOR_SUPPRESSION_RULE_VERSION,
    recorded_at: new Date().toISOString(),
    binding: true,
  });
  return validated.ok ? validated.evidence : null;
}

/**
 * The CLOSED set of inbound intents that constitute durable suppression
 * evidence, mapped to the evidence type each produces.
 *
 * This map is keyed on the classified INTENT, never on the contactability
 * value being written. That is the whole safety property: a caller cannot get
 * evidence minted for it just because it asked for `do_not_text`. A stage
 * transition (`condition_disclosed`, `ownership_confirmed`, …) is absent here,
 * so it still gets null and is still rejected — the 2026-08-04 incident fix
 * survives by construction.
 */
const INBOUND_EVIDENCE_BY_INTENT = Object.freeze({
  opt_out: SUPPRESSION_EVIDENCE_TYPES.EXPLICIT_OPT_OUT,
  stop: SUPPRESSION_EVIDENCE_TYPES.EXPLICIT_OPT_OUT,
  unsubscribe: SUPPRESSION_EVIDENCE_TYPES.EXPLICIT_OPT_OUT,
  do_not_contact: SUPPRESSION_EVIDENCE_TYPES.EXPLICIT_OPT_OUT,
  wrong_number: SUPPRESSION_EVIDENCE_TYPES.CONFIRMED_WRONG_NUMBER,
  invalid_number: SUPPRESSION_EVIDENCE_TYPES.CONFIRMED_WRONG_NUMBER,
  hostile_or_legal: SUPPRESSION_EVIDENCE_TYPES.LEGAL_PROHIBITION,
  legal_threat: SUPPRESSION_EVIDENCE_TYPES.LEGAL_PROHIBITION,
  wrong_person: SUPPRESSION_EVIDENCE_TYPES.CONFIRMED_WRONG_PARTY,
  property_specific_non_owner: SUPPRESSION_EVIDENCE_TYPES.CONFIRMED_WRONG_PARTY,
  former_owner_respondent: SUPPRESSION_EVIDENCE_TYPES.CONFIRMED_WRONG_PARTY,
});

/**
 * SERVER-SIDE evidence for a classifier-derived inbound suppression.
 * Returns null for every intent outside the durable set, and for any inbound
 * that cannot cite the message event that produced it.
 */
export function buildInboundSuppressionEvidence({
  intent = null,
  source_event_id = null,
  rule_version = null,
  matched_phrase = null,
  source_authority = null,
} = {}) {
  const type = INBOUND_EVIDENCE_BY_INTENT[lower(intent)];
  if (!type) return null;
  if (!String(source_event_id ?? "").trim()) return null;
  const validated = validateSuppressionEvidence({
    type,
    source_event_id,
    source_authority: source_authority || "seller_inbound_classifier",
    matched_phrase,
    rule_version: rule_version || INBOUND_SUPPRESSION_RULE_VERSION,
    recorded_at: new Date().toISOString(),
    binding: true,
  });
  return validated.ok ? validated.evidence : null;
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

const CLEARANCE_TYPES = Object.freeze(["operator_release", "soft_suppression_release"]);

/**
 * Validates an explicit clearance token. Only an operator (or a named release
 * process) may lift a binding suppression — never an automated turn.
 */
export function validateSuppressionClearance(clearance) {
  if (!clearance || typeof clearance !== "object") {
    return { ok: false, reason: "missing_suppression_clearance" };
  }
  if (!CLEARANCE_TYPES.includes(lower(clearance.type))) {
    return { ok: false, reason: "unrecognized_suppression_clearance_type" };
  }
  const actor = String(clearance.actor ?? "").trim();
  const sourceEvent = String(clearance.source_event_id ?? "").trim();
  if (!actor && !sourceEvent) {
    return { ok: false, reason: "suppression_clearance_requires_provenance" };
  }
  return { ok: true, clearance: { type: lower(clearance.type), actor: actor || null, source_event_id: sourceEvent || null } };
}

/**
 * Contradictions the WRITER is responsible for and must refuse. The automation
 * contradiction is advisory only: `automation_state` is not a field this
 * writer owns or patches, so refusing a lawful opt-out because the thread's
 * automation column still reads "running" would be a compliance regression.
 */
export const TUPLE_INVARIANT_CONTRADICTIONS = Object.freeze([
  "contactable_while_binding_suppressed",
  "blocking_contactability_without_suppression",
]);

/**
 * Decide what the suppression tuple must look like after this patch.
 *
 * You cannot half-suppress and you cannot half-unsuppress:
 *   * a suppression writes is_suppressed + a blocking contactability +
 *     suppressed_at together, or not at all;
 *   * a clear writes is_suppressed=false + contactable + suppressed_at=null
 *     together, and only with operator authority;
 *   * a patch that touches neither leaves the row exactly as it is. Rows that
 *     are ALREADY contradictory are not repaired here — that is a data
 *     migration, not a write-path decision.
 *
 * @returns {{action:'suppress'|'clear'|'hold'|'none', fields:object, strip:string[], guards:string[]}}
 */
export function resolveSuppressionWrite({
  previous = null,
  patch = {},
  change_source = null,
  operator = null,
  clearance = null,
  now = new Date().toISOString(),
} = {}) {
  const none = { action: "none", fields: {}, strip: [], guards: [] };
  if (!patch || typeof patch !== "object") return none;

  const previousShape = normalizeSuppressionShape(previous || {});
  const patchShape = normalizeSuppressionShape(patch);
  const previousBinding = isBindingSuppressionShape(previousShape);
  const patchBinding = isBindingSuppressionShape(patchShape);
  const touchesContactability = Object.prototype.hasOwnProperty.call(patch, "contactability_status");

  // ── establishing suppression ───────────────────────────────────────────────
  if (patchBinding) {
    const contactability =
      canonicalBlockingContactability(patchShape.contactability) ||
      canonicalBlockingContactability(previousShape.contactability) ||
      CONTACTABILITY_CODES.DO_NOT_TEXT;
    return {
      action: "suppress",
      fields: {
        contactability_status: contactability,
        is_suppressed: true,
        suppressed_at: previousShape.is_suppressed === true && previous?.suppressed_at
          ? previous.suppressed_at
          : now,
      },
      strip: [],
      guards: [],
    };
  }

  // ── clearing suppression ───────────────────────────────────────────────────
  // The only clearing gesture the canonical patch surface allows is writing a
  // non-blocking contactability. `is_suppressed` is not a patchable field.
  if (previousBinding && touchesContactability) {
    const guards = [];
    let allowed = true;

    const manualOperator =
      lower(change_source) === "manual" && Boolean(String(operator ?? "").trim());
    const clearanceCheck = clearance ? validateSuppressionClearance(clearance) : { ok: false };
    if (!manualOperator && !clearanceCheck.ok) {
      guards.push("suppression_clear_requires_operator_authority");
      allowed = false;
    }

    // Would the row still be binding after a complete clear? Then this patch
    // cannot express the clear (e.g. a legacy disposition='suppressed' remains)
    // and half-clearing it would produce exactly the contradiction we are here
    // to prevent.
    const projectedAfterClear = normalizeSuppressionShape({
      ...(previous || {}),
      ...patch,
      is_suppressed: false,
    });
    if (isBindingSuppressionShape(projectedAfterClear)) {
      guards.push("partial_suppression_clear_blocked");
      allowed = false;
    }

    if (!allowed) {
      return { action: "hold", fields: {}, strip: ["contactability_status"], guards };
    }

    return {
      action: "clear",
      fields: {
        contactability_status: patchShape.contactability || CONTACTABILITY_CODES.CONTACTABLE,
        is_suppressed: false,
        suppressed_at: null,
      },
      strip: [],
      guards,
    };
  }

  return none;
}

/**
 * Detects states that cannot both be true. Returns [] when consistent.
 * Uses the SAME binding predicate as the authorization gate.
 */
export function detectSuppressionContradictions(row = {}) {
  const contradictions = [];
  const shape = normalizeSuppressionShape(row);
  const binding = isBindingSuppressionShape(shape);

  if (binding && shape.contactability === CONTACTABILITY_CODES.CONTACTABLE) {
    contradictions.push("contactable_while_binding_suppressed");
  }
  // `!== true` and not `=== false`: an absent/null is_suppressed alongside a
  // blocking contactability is the same unfinished write.
  if (BLOCKING_CONTACTABILITY_VALUES.includes(shape.contactability) && shape.is_suppressed !== true) {
    contradictions.push("blocking_contactability_without_suppression");
  }
  if (binding && (shape.automation === "running" || shape.automation === "active")) {
    contradictions.push("automation_running_while_binding_suppressed");
  }
  return contradictions;
}

export default authorizeSuppressionMutation;
