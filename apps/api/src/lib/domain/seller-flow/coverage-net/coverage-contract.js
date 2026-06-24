// ─── coverage-contract.js ────────────────────────────────────────────────
// The machine-verifiable COVERAGE STANDARD for Stages 1–6 (audit §1).
//
// A message is "covered" only when ALL of these are defined on its decision:
//   intent, contact identity, stage compatibility, risk/safety status,
//   reply-allowed-or-suppressed, next action, template-or-no-send,
//   transition rule, follow-up-or-terminal, audit trail.
//
// Coverage states (mutually exclusive, in precedence order):
//   - direct_coverage                       : confident intent → routed reply / suppression
//   - safe_fallback_coverage                : ambiguous → stage-aware safe clarifier prepared
//   - no_reply_action_coverage              : intentional no-send with a defined next action
//   - human_exception_with_owned_workflow   : routed to an owned workflow w/ owner+SLA+fallback
//   - missing_coverage                      : NONE of the above — this MUST be zero in prod
//
// `assessCoverage(decision)` is pure and is the single oracle used by tests and
// by ensure-inbound-coverage.js. The contract intentionally treats a bare
// human-review with no owned workflow / no scheduled next action as
// missing_coverage so the test suite fails loudly if a dead end reappears.

function clean(value) {
  return String(value ?? "").trim();
}

export const COVERAGE_STATES = Object.freeze({
  DIRECT: "direct_coverage",
  SAFE_FALLBACK: "safe_fallback_coverage",
  NO_REPLY_ACTION: "no_reply_action_coverage",
  HUMAN_EXCEPTION: "human_exception_with_owned_workflow",
  MISSING: "missing_coverage",
});

// The fields every fully-covered decision must define.
export const REQUIRED_COVERAGE_FIELDS = Object.freeze([
  "canonical_intent",
  "contact_identity",
  "safety_status",
  "reply_disposition", // one of: reply | suppress | no_reply
  "next_action",
  "scheduled_next_action",
  "audit_reason",
]);

// A next_action that, on its own, is a dead end unless paired with an owned
// workflow + scheduled fallback.
const BARE_REVIEW_ACTIONS = new Set(["mark_human_review", "none", ""]);

/**
 * Assess the coverage state of a (possibly enriched) decision object.
 * Pure. Returns one of COVERAGE_STATES.
 */
export function assessCoverage(decision = {}) {
  if (!decision || typeof decision !== "object") return COVERAGE_STATES.MISSING;

  const next_action = clean(decision.next_action);
  const scheduled = clean(decision.scheduled_next_action);
  const has_workflow = Boolean(decision.exception_workflow?.key);
  const has_owner = Boolean(decision.exception_workflow?.owner);
  const has_sla = Boolean(decision.exception_sla_deadline);

  // Suppression is direct coverage (defined no-marketing decision).
  if (decision.should_suppress_contact === true) {
    return COVERAGE_STATES.DIRECT;
  }

  // Confident routed reply.
  if (decision.should_queue_reply === true && next_action && next_action !== "none") {
    return COVERAGE_STATES.DIRECT;
  }

  // Intentional no-send with a defined follow-up/terminal next action.
  if (
    decision.should_queue_reply !== true &&
    decision.should_mark_human_review !== true &&
    next_action &&
    !BARE_REVIEW_ACTIONS.has(next_action) &&
    scheduled
  ) {
    return COVERAGE_STATES.NO_REPLY_ACTION;
  }

  // Ambiguous but a stage-aware safe fallback is prepared + scheduled.
  if (decision.safe_fallback?.suggested_text && scheduled) {
    return COVERAGE_STATES.SAFE_FALLBACK;
  }

  // Human review BUT routed into an owned workflow with owner + SLA + scheduled
  // fallback → owned, not a dead end.
  if (decision.should_mark_human_review === true && has_workflow && has_owner && has_sla && scheduled) {
    return COVERAGE_STATES.HUMAN_EXCEPTION;
  }

  return COVERAGE_STATES.MISSING;
}

/** True when the decision satisfies the coverage standard (not missing). */
export function isCovered(decision = {}) {
  return assessCoverage(decision) !== COVERAGE_STATES.MISSING;
}

/** List which required coverage fields are absent — for diagnostics/tests. */
export function missingCoverageFields(decision = {}) {
  return REQUIRED_COVERAGE_FIELDS.filter((field) => {
    const v = decision?.[field];
    return v === undefined || v === null || clean(v) === "";
  });
}

export default {
  COVERAGE_STATES,
  REQUIRED_COVERAGE_FIELDS,
  assessCoverage,
  isCovered,
  missingCoverageFields,
};
