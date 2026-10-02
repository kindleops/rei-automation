/**
 * IC8 REASON CODES -- a closed registry (architecture §5.1).
 *
 * Journal rows explain decisions with structured codes, never free-text
 * rationale or chain-of-thought. A code that is not registered here fails the
 * tests; at runtime the fail-open journal drops it and records
 * JOURNAL_REASON_CODE_UNREGISTERED instead of throwing into a production path.
 */

const define = (category, description) => Object.freeze({ category, description });

export const REASON_CODES = Object.freeze({
  // ── deterministic guardrails (adapters calling the existing authorities) ──
  GUARDRAIL_SUPPRESSED_DNC: define("guardrail", "Recipient is on a DNC / suppression list."),
  GUARDRAIL_OPTED_OUT: define("guardrail", "Recipient opted out (STOP)."),
  GUARDRAIL_WRONG_PERSON: define("guardrail", "Relationship-scoped wrong person / wrong number."),
  GUARDRAIL_CONTACT_WINDOW_CLOSED: define("guardrail", "Outside the recipient's contact window."),
  GUARDRAIL_CONTACT_WINDOW_ZONE_UNKNOWN: define("guardrail", "Recipient time zone blank or unresolved: blocked."),
  GUARDRAIL_SENDER_UNHEALTHY: define("guardrail", "Sender number health below threshold."),
  GUARDRAIL_PROVIDER_INELIGIBLE: define("guardrail", "Provider / runtime send authority refuses."),
  GUARDRAIL_CAP_REACHED: define("guardrail", "A daily or campaign cap is reached."),
  GUARDRAIL_TEMPLATE_NOT_APPROVED: define("guardrail", "Template governance refuses the template."),
  GUARDRAIL_STAGE_AUTHORITY: define("guardrail", "Stage authority refuses the move."),
  GUARDRAIL_OFFER_AUTHORITY: define("guardrail", "Offer authorisation limits refuse the action."),
  GUARDRAIL_ADAPTER_MISSING: define("guardrail", "A required guardrail adapter was not provided: fail closed."),
  GUARDRAIL_ADAPTER_ERROR: define("guardrail", "A guardrail adapter threw: fail closed."),
  GUARDRAIL_ADAPTER_TIMEOUT: define("guardrail", "A guardrail adapter did not answer in time: fail closed."),
  GUARDRAIL_ADAPTER_MALFORMED: define("guardrail", "A guardrail adapter answered without a registered verdict: fail closed."),
  GUARDRAIL_DISAGREES_WITH_PRODUCTION: define("guardrail", "Production's own choice is blocked by an IC8 guardrail adapter (observed disagreement)."),
  // ── scorer fallbacks (deterministic default instead of a model) ──
  FALLBACK_NO_CHAMPION: define("fallback", "No champion/challenger scorer available."),
  FALLBACK_MODEL_UNAVAILABLE: define("fallback", "The scorer could not load its model."),
  FALLBACK_MODEL_INELIGIBLE: define("fallback", "The model's feature set cannot be verified or its artifact carries a prohibited column: refused."),
  FALLBACK_STALE_FEATURES: define("fallback", "Input features are older than their freshness SLA."),
  FALLBACK_FEATURES_MISSING: define("fallback", "The scorer returned no score for an allowed candidate."),
  FALLBACK_OUT_OF_DISTRIBUTION: define("fallback", "The input is out of the model's training distribution."),
  FALLBACK_LOW_CONFIDENCE: define("fallback", "Model confidence below the policy threshold."),
  FALLBACK_SCORER_ERROR: define("fallback", "The scorer threw."),
  FALLBACK_SCORER_TIMEOUT: define("fallback", "The scorer did not answer in time."),
  FALLBACK_NO_ALLOWED_CANDIDATES: define("fallback", "Every candidate was blocked by a guardrail."),
  FALLBACK_OBSERVE_MODE: define("fallback", "Observe mode never scores."),
  // ── choice ──
  CHOICE_DETERMINISTIC_DEFAULT: define("choice", "The deterministic default (today's production choice) was chosen."),
  CHOICE_MODEL_RANKED: define("choice", "The highest-scored allowed candidate was chosen (shadow)."),
  CHOICE_EXPLORATION_DISABLED: define("choice", "Exploration share is 0 in this phase."),
  CHOICE_NONE: define("choice", "No action was chosen."),
  // ── mode ──
  MODE_OBSERVE: define("mode", "Observation only."),
  MODE_SHADOW: define("mode", "Shadow decision; production is unaffected."),
  POLICY_MODE_NOT_PERMITTED: define("mode", "assist/act requested; not permitted in this phase."),
  POLICY_INVALID_REQUEST: define("mode", "The decision request was malformed."),
  // ── strategy intent ──
  STRATEGY_LAYER_NEGOTIATION_ROUTER: define("strategy", "Negotiation strategy router chose the outbound."),
  STRATEGY_LAYER_V2_RESPONSE_STRATEGY: define("strategy", "V2 response strategy chose the outbound."),
  STRATEGY_LAYER_LIFECYCLE_RESOLVER: define("strategy", "Lifecycle resolver directive chose the outbound."),
  STRATEGY_LAYER_INTENT_PROFILE: define("strategy", "Intent-profile route chose the outbound."),
  STRATEGY_LAYER_CLARIFIER: define("strategy", "Safe-fallback clarifier chose the outbound."),
  STRATEGY_LAYER_CAMPAIGN_OBJECTIVE: define("strategy", "Campaign objective / first-touch pool chose the outbound."),
  STRATEGY_LAYER_FOLLOWUP_POLICY: define("strategy", "Follow-up policy chose the outbound."),
  STRATEGY_LAYER_OPERATOR: define("strategy", "An operator chose the outbound."),
  STRATEGY_LAYER_UNKNOWN: define("strategy", "The deciding layer could not be identified from the record."),
  STRATEGY_LABEL_UNMAPPED: define("strategy", "No mapping from the recorded value to the strategy taxonomy (never guessed)."),
  STRATEGY_OPERATOR_UNSPECIFIED: define("strategy", "Operator send without a recorded strategy."),
  STRATEGY_HAND_OFF: define("strategy", "The turn was handed to a human."),
  STRATEGY_NO_OUTBOUND: define("strategy", "The turn queued no outbound."),
  STRATEGY_RECONSTRUCTED: define("strategy", "Reconstructed offline from stored metadata (not logged at decision time)."),
  STRATEGY_TEMPLATE_ROTATION_LOGGED: define("strategy", "Template drawn from a logged rotation pool (propensity known)."),
  // ── campaign feed / scale bounds (resolveFeedLimit / buildRollingPlan) ──
  FEED_BOUND_BUFFER: define("campaign", "Feed limited by the buffer target."),
  FEED_BOUND_COHORT_EXHAUSTED: define("campaign", "Feed limited: cohort exhausted."),
  FEED_BOUND_TOTAL_CAP_REACHED: define("campaign", "Feed limited: total cap reached."),
  FEED_BOUND_DAILY_CAP_REACHED: define("campaign", "Feed limited: daily cap reached."),
  FEED_BOUND_BUFFER_FULL: define("campaign", "Feed limited: buffer full."),
  FEED_BOUND_CAMPAIGN_CAP_ZERO: define("campaign", "Feed limited: a per-sender or per-market cap is 0."),
  FEED_BOUND_UNKNOWN: define("campaign", "Feed bound not recognised by the journal (recorded as unknown, never guessed)."),
  SCALE_BINDING_DAILY_CAP: define("campaign", "Rolling plan bound by the daily cap."),
  SCALE_BINDING_CONTACT_WINDOW: define("campaign", "Rolling plan bound by contact windows."),
  SCALE_BINDING_SENDER_CAPACITY: define("campaign", "Rolling plan bound by sender capacity."),
  // ── journal ──
  JOURNAL_REASON_CODE_UNREGISTERED: define("journal", "An unregistered reason code was dropped from this row."),
});

export const REASON_CODE_CATEGORIES = Object.freeze([...new Set(Object.values(REASON_CODES).map((c) => c.category))]);

export class UnknownReasonCodeError extends Error {
  constructor(codes) {
    super(`unregistered reason codes: ${codes.join(", ")}`);
    this.name = "UnknownReasonCodeError";
    this.code = "UNKNOWN_REASON_CODE";
    this.codes = codes;
  }
}

export function isRegisteredReasonCode(code) {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(REASON_CODES, code);
}

/** Split codes into registered and unregistered (deduplicated, order kept). */
export function partitionReasonCodes(codes = []) {
  const known = [];
  const unknown = [];
  for (const code of Array.isArray(codes) ? codes : [codes]) {
    const list = isRegisteredReasonCode(code) ? known : unknown;
    if (!list.includes(code)) list.push(code);
  }
  return { known, unknown };
}

/** Throws when any code is unregistered (tests and offline code paths). */
export function assertReasonCodes(codes = []) {
  const { unknown } = partitionReasonCodes(codes);
  if (unknown.length) throw new UnknownReasonCodeError(unknown);
  return true;
}
