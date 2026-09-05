/**
 * transport-outcome-mapping.js
 *
 * Translates a Slice 0 transport classification into the durable three-axis
 * model. This is the ONLY place that mapping exists, so a provider outcome
 * cannot mean one thing to the queue and another to the ledger.
 *
 * The mapping is deliberately NOT a `retryable` boolean. Each outcome yields
 * three separate facts, because "the seller received nothing" and "we may try
 * again" are different claims and some outcomes assert one without the other:
 *
 *   invalid recipient  definitely_not_sent + terminal
 *                      (proven undelivered, yet retrying is pointless forever)
 *   auth/config error  definitely_not_sent + operator_hold
 *                      (proven undelivered, and a human must fix something)
 *   timeout / 5xx      may_have_been_sent  + retry_denied
 *                      (nothing proven, so nothing may be retried)
 *   refused connection definitely_not_sent + retry_allowed
 *                      (proven undelivered and genuinely safe to repeat)
 */

import {
  LOGICAL_STATES,
  DELIVERY_POSSIBILITY,
  RETRY_AUTHORITY,
  ATTEMPT_STATES,
  TRANSITION_CAUSES,
  TRANSPORT_OUTCOME_MAPPING_POLICY_VERSION,
} from "@/lib/domain/communications/communication-transition-authority.js";

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * @param {object} classified  output of classifyTextGridProviderError, or a
 *                             success descriptor { ok:true, provider_message_id }
 * @returns {{logical_state, delivery_possibility, retry_authority, attempt_state,
 *            cause, policy_version, reason}}
 */
export function mapTransportOutcome(classified = {}) {
  const policy_version = TRANSPORT_OUTCOME_MAPPING_POLICY_VERSION;

  // ── success: the provider returned an authoritative message id ───────────
  if (classified.ok === true && clean(classified.provider_message_id)) {
    return {
      logical_state: LOGICAL_STATES.PROVIDER_ACCEPTED,
      delivery_possibility: DELIVERY_POSSIBILITY.PROVIDER_ACCEPTED,
      retry_authority: RETRY_AUTHORITY.TERMINAL,
      attempt_state: ATTEMPT_STATES.PROVIDER_ACCEPTED,
      cause: TRANSITION_CAUSES.PROVIDER_SID_OBSERVED,
      policy_version,
      reason: "provider_accepted_with_sid",
    };
  }

  const failure_class = clean(classified.failure_class);
  const may_have_transmitted = classified.may_have_transmitted === true;

  // ── AMBIGUOUS: acceptance cannot be excluded ─────────────────────────────
  // Covers timeout/abort/reset/socket-hangup/body+headers-timeout/malformed
  // response/5xx, plus the sid-less accept. Absence of a sid means the provider
  // IDENTITY is unknown -- never that the provider declined.
  if (
    failure_class === "provider_ambiguous_transport" ||
    failure_class === "provider_ambiguous_accept" ||
    may_have_transmitted
  ) {
    return {
      logical_state: LOGICAL_STATES.AMBIGUOUS,
      delivery_possibility: DELIVERY_POSSIBILITY.MAY_HAVE_BEEN_SENT,
      retry_authority: RETRY_AUTHORITY.RETRY_DENIED,
      attempt_state: ATTEMPT_STATES.AMBIGUOUS,
      cause: TRANSITION_CAUSES.PROVIDER_TRANSPORT_AMBIGUOUS,
      policy_version,
      reason: failure_class || "transport_outcome_unknown",
    };
  }

  // ── PROVABLY UNSENT: the socket never opened ─────────────────────────────
  // The one outcome that is both proven-undelivered AND genuinely safe to
  // repeat: no request left this process, so a retry cannot duplicate anything.
  if (failure_class === "provider_unreachable_before_request") {
    return {
      logical_state: LOGICAL_STATES.FAILED_RETRY_ALLOWED,
      delivery_possibility: DELIVERY_POSSIBILITY.DEFINITELY_NOT_SENT,
      retry_authority: RETRY_AUTHORITY.RETRY_ALLOWED,
      attempt_state: ATTEMPT_STATES.FAILED_PROVABLY_UNSENT,
      cause: TRANSITION_CAUSES.PROVIDER_DEFINITIVE_REJECTION,
      policy_version,
      reason: "connect_failed_before_request",
    };
  }

  // ── PROVABLY UNSENT, BUT NEVER RETRY ─────────────────────────────────────
  // The provider answered and definitively refused. The seller received
  // nothing, and repeating the identical request cannot change that.
  const TERMINAL_REJECTIONS = new Set([
    "invalid_to_number",
    "recipient_opted_out",
    "provider_blacklist_pair",
    "content_filter_blocked",
  ]);
  if (TERMINAL_REJECTIONS.has(failure_class)) {
    return {
      logical_state: LOGICAL_STATES.FAILED_TERMINAL,
      delivery_possibility: DELIVERY_POSSIBILITY.DEFINITELY_NOT_SENT,
      retry_authority: RETRY_AUTHORITY.TERMINAL,
      attempt_state: ATTEMPT_STATES.FAILED_TERMINAL,
      cause: TRANSITION_CAUSES.PROVIDER_DEFINITIVE_REJECTION,
      policy_version,
      reason: failure_class,
    };
  }

  // ── PROVABLY UNSENT, HUMAN MUST ACT ──────────────────────────────────────
  // Credentials or configuration are wrong. Nothing was delivered, and an
  // automatic retry would just fail identically until someone intervenes.
  const CONFIG_REJECTIONS = new Set([
    "provider_auth_failed",
    "provider_configuration_error",
    "sender_not_provisioned",
  ]);
  if (CONFIG_REJECTIONS.has(failure_class)) {
    return {
      logical_state: LOGICAL_STATES.FAILED_TERMINAL,
      delivery_possibility: DELIVERY_POSSIBILITY.DEFINITELY_NOT_SENT,
      retry_authority: RETRY_AUTHORITY.OPERATOR_HOLD,
      attempt_state: ATTEMPT_STATES.FAILED_TERMINAL,
      // The CAUSE describes the EVIDENCE, not the consequence. An auth or
      // configuration failure is evidentially a definitive provider rejection
      // (the request was refused, so nothing reached the seller). That it also
      // needs a human is expressed by retry_authority = operator_hold above.
      // CONFIGURATION_HOLD is reserved as the REMEDIATION cause that later
      // RELEASES such a hold.
      cause: TRANSITION_CAUSES.PROVIDER_DEFINITIVE_REJECTION,
      policy_version,
      reason: failure_class,
    };
  }

  // ── UNKNOWN: FAIL CLOSED ─────────────────────────────────────────────────
  // An outcome we do not understand is treated as possibly-delivered. Guessing
  // "probably fine, retry it" is precisely how a duplicate reaches a seller.
  //
  // NOTE ON 429: it is deliberately NOT special-cased. TextGrid's rate-limit
  // acceptance semantics are unverified in this repo, and inventing a
  // retry_after from an unproven assumption is exactly the guess this model
  // forbids. It therefore lands here, held, until provider semantics are proven.
  return {
    logical_state: LOGICAL_STATES.AMBIGUOUS,
    delivery_possibility: DELIVERY_POSSIBILITY.MAY_HAVE_BEEN_SENT,
    retry_authority: RETRY_AUTHORITY.RETRY_DENIED,
    attempt_state: ATTEMPT_STATES.AMBIGUOUS,
    cause: TRANSITION_CAUSES.PROVIDER_TRANSPORT_AMBIGUOUS,
    policy_version,
    reason: failure_class || "unclassified_outcome_failed_closed",
  };
}

export default mapTransportOutcome;
