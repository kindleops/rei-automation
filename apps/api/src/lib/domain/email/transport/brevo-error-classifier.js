/**
 * brevo-error-classifier.js
 *
 * Brevo's error surface, translated into the platform's existing transport
 * vocabulary. This is the ONLY file that knows what a Brevo error code means.
 *
 * THE RULE IT OBEYS.
 *   Every returned `failure_class` is one mapTransportOutcome() already
 *   understands. Nothing here invents an outcome, a retry policy, or a delay.
 *   The classifier says what the provider did; the transition authority decides
 *   what may happen next.
 *
 * THE DISTINCTION THAT MATTERS MOST.
 *   "The provider refused" and "we never heard back" are completely different
 *   facts, and only one of them is safe to repeat:
 *
 *     an HTTP status of any kind   the provider ANSWERED. Classify by code.
 *     no status, connect phase     the socket never opened. Provably unsent.
 *     no status, inflight phase    the request left and the answer did not come
 *                                  back. Brevo may have queued the email. This
 *                                  is ambiguous, and ambiguity is never retried.
 *
 *   Brevo's transactional endpoint accepts no caller-supplied idempotency key,
 *   so a timed-out send cannot be de-duplicated by asking again. Absence of a
 *   messageId means the provider identity is UNKNOWN, never that it declined.
 *
 * 429 IS DELIBERATELY LEFT UNMAPPED.
 *   Brevo documents 429 as a rejected request, which would make it provably
 *   unsent and safe to repeat after a delay. This repository has not PROVEN that
 *   against the live API, and the existing SMS mapping refuses to assume the
 *   same thing about TextGrid for exactly that reason. So `provider_rate_limited`
 *   is returned as a named, greppable class and is intentionally absent from
 *   every set in transport-outcome-mapping.js, which lands it in the fail-closed
 *   ambiguous branch.
 *
 *   That is the conservative answer, and it has a real cost: a rate-limited send
 *   is held rather than retried. Upgrading it is an EMAIL-2 task and requires
 *   evidence from a live probe, not a reading of the documentation.
 *
 * NOTHING HERE MAY LEAK A CREDENTIAL.
 *   Provider messages are passed through only from known-safe fields, and the
 *   API key is never part of an error object this module builds.
 */

import { classifyNetworkFailurePhase } from "@/lib/domain/messaging/transport-failure-phase.js";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Brevo error codes on POST /v3/smtp/email that identify a DEFINITIVE refusal.
 * Anything not listed is classified from the HTTP status instead, never guessed
 * into a terminal class.
 */
const BREVO_CODE_CLASSES = new Map([
  // credentials and account posture: nothing was sent, a human must act
  ["unauthorized", "provider_auth_failed"],
  ["account_under_validation", "provider_configuration_error"],
  ["not_enough_credits", "provider_configuration_error"],
  ["permission_denied", "provider_auth_failed"],
  ["reseller_permission_denied", "provider_auth_failed"],
  // request shape: nothing was sent, and repeating it identically cannot help
  ["missing_parameter", "provider_configuration_error"],
  ["out_of_range", "provider_configuration_error"],
  ["document_not_found", "provider_configuration_error"],
  ["method_not_allowed", "provider_configuration_error"],
  ["not_acceptable", "provider_configuration_error"],
]);

/**
 * Sender-identity refusals. Brevo reports these as invalid_parameter with a
 * message about the sender, which is why the message text is consulted only
 * AFTER the code has failed to settle the question.
 */
const SENDER_PHRASES = [
  "sender",
  "from address",
  "not a valid sender",
  "sender not valid",
  "domain is not authorized",
  "not authorised to send",
  "not authorized to send",
];

const RECIPIENT_PHRASES = [
  "invalid email address",
  "email address is invalid",
  "invalid recipient",
  "recipient is invalid",
  "to.email",
  "\"to\" is invalid",
];

const BLOCKLIST_PHRASES = [
  "blocked",
  "blacklisted",
  "unsubscribed",
  "in the blocklist",
  "contact is blacklisted",
];

const CONTENT_PHRASES = [
  "spam",
  "content rejected",
  "message content",
];

function includesAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

/** Read Brevo's `{ code, message }` body without trusting its shape. */
export function extractBrevoProviderError(error = {}) {
  const data = ensureObject(error.data ?? error.body ?? error.response_body);
  return {
    code: clean(data.code) || clean(error.provider_code) || clean(error.code) || null,
    message: clean(data.message) || clean(error.provider_message) || clean(error.message) || null,
  };
}

/**
 * @param {object} error  an error from the Brevo adapter, or a success
 *                        descriptor `{ ok: true, provider_message_id }`
 * @returns {{ok?:true, provider_message_id?:string}
 *          |{failure_class:string, may_have_transmitted:boolean,
 *            provider_code:string|null, provider_message:string|null,
 *            transport_phase:string|null, operator_reason:string,
 *            suppression_action:string|null}}
 */
export function classifyBrevoProviderError(error = {}) {
  // Success passes through untouched so a single call site can hand either a
  // result or an error to mapTransportOutcome().
  if (error?.ok === true && clean(error.provider_message_id)) {
    return { ok: true, provider_message_id: clean(error.provider_message_id) };
  }

  const { code, message } = extractBrevoProviderError(error);
  const status = Number(error?.status);
  const has_status = Number.isFinite(status) && status > 0;

  // ── no HTTP status: this never became a provider verdict ─────────────────
  if (!has_status) {
    const stamped = clean(error?.network_phase);
    const derived = stamped
      ? { phase: stamped, may_have_transmitted: error?.may_have_transmitted !== false }
      : classifyNetworkFailurePhase(error);

    if (derived.phase === "connect" && derived.may_have_transmitted === false) {
      return failure({
        failure_class: "provider_unreachable_before_request",
        may_have_transmitted: false,
        provider_code: code,
        provider_message: message || "Could not reach the email provider",
        transport_phase: "connect",
        operator_reason:
          "The connection to the email provider never opened, so no email was sent. Safe to retry.",
      });
    }

    // Includes phase "unknown". An outcome we cannot place is treated as
    // possibly-delivered, because the alternative sends a duplicate.
    return failure({
      failure_class: "provider_ambiguous_transport",
      may_have_transmitted: true,
      provider_code: code,
      provider_message: message || "Email provider transport failure",
      transport_phase: derived.phase || "unknown",
      operator_reason:
        "The provider outcome is unknown. The email may already have been accepted, so it will not be resent automatically.",
    });
  }

  // ── 5xx: the provider answered, but not with a verdict ───────────────────
  // A 502/503/504 cannot prove the message was not created before the error
  // surfaced, so it is ambiguous rather than a clean rejection.
  if (status >= 500) {
    return failure({
      failure_class: "provider_ambiguous_transport",
      may_have_transmitted: true,
      provider_code: code,
      provider_message: message || "Email provider is temporarily unavailable",
      transport_phase: "inflight",
      operator_reason:
        "The provider returned a server error. Acceptance cannot be excluded, so this will not be resent automatically.",
    });
  }

  if (status === 429) {
    // See the header. Named, not mapped, until the semantics are proven.
    return failure({
      failure_class: "provider_rate_limited",
      may_have_transmitted: true,
      provider_code: code,
      provider_message: message || "Email provider rate limit reached",
      transport_phase: "inflight",
      operator_reason:
        "The provider rate-limited this send. Brevo's acceptance semantics for 429 are unverified in this repository, so the send is held rather than retried.",
    });
  }

  if (status === 401 || status === 403) {
    return failure({
      failure_class: "provider_auth_failed",
      may_have_transmitted: false,
      provider_code: code,
      provider_message: "Email provider authorization failed",
      transport_phase: "response",
      operator_reason:
        "The provider rejected our credentials. Nothing was sent, and it will keep failing until the API key or account is fixed.",
    });
  }

  if (status === 402) {
    return failure({
      failure_class: "provider_configuration_error",
      may_have_transmitted: false,
      provider_code: code,
      provider_message: message || "Email provider account requires attention",
      transport_phase: "response",
      operator_reason: "The provider account cannot send (credits or plan). Nothing was sent.",
    });
  }

  // ── 4xx: a definitive refusal. Which kind is the question. ───────────────
  const mapped_by_code = code ? BREVO_CODE_CLASSES.get(lower(code)) : null;
  const text = `${lower(code)} ${lower(message)}`;

  // Message text is consulted only where the code is genuinely ambiguous:
  // Brevo reports bad senders, bad recipients and blocked contacts all as
  // `invalid_parameter`, so the code alone cannot separate "fix the config"
  // from "never contact this person again".
  if (includesAny(text, BLOCKLIST_PHRASES)) {
    return failure({
      failure_class: "recipient_opted_out",
      may_have_transmitted: false,
      provider_code: code,
      provider_message: message || "Recipient is blocked at the provider",
      transport_phase: "response",
      operator_reason:
        "The provider refused because this recipient is blocked or unsubscribed. Nothing was sent and it must not be retried.",
      suppression_action: "unsubscribed",
    });
  }

  if (includesAny(text, SENDER_PHRASES)) {
    return failure({
      failure_class: "sender_not_provisioned",
      may_have_transmitted: false,
      provider_code: code,
      provider_message: message || "Sender identity is not usable",
      transport_phase: "response",
      operator_reason:
        "The provider rejected the sender identity. Nothing was sent; a human must verify the sender or its domain.",
    });
  }

  if (includesAny(text, RECIPIENT_PHRASES)) {
    return failure({
      failure_class: "invalid_to_address",
      may_have_transmitted: false,
      provider_code: code,
      provider_message: message || "Recipient address is invalid",
      transport_phase: "response",
      operator_reason:
        "The provider rejected the recipient address. Nothing was sent and repeating it cannot help.",
      suppression_action: "invalid_address",
    });
  }

  if (includesAny(text, CONTENT_PHRASES)) {
    return failure({
      failure_class: "content_filter_blocked",
      may_have_transmitted: false,
      provider_code: code,
      provider_message: message || "Message content was rejected",
      transport_phase: "response",
      operator_reason:
        "The provider rejected the message content. Nothing was sent; the template needs changing, not retrying.",
    });
  }

  if (mapped_by_code) {
    return failure({
      failure_class: mapped_by_code,
      may_have_transmitted: false,
      provider_code: code,
      provider_message: message || "Email provider rejected the request",
      transport_phase: "response",
      operator_reason:
        "The provider refused the request outright. Nothing was sent, and an identical retry would fail identically.",
    });
  }

  // A 4xx we do not recognise. The provider ANSWERED and refused, so nothing
  // was sent -- but we cannot say whether a human needs to act, so we assume
  // one does rather than looping an automatic retry against a wall.
  return failure({
    failure_class: "provider_configuration_error",
    may_have_transmitted: false,
    provider_code: code,
    provider_message: message || "Email provider rejected the request",
    transport_phase: "response",
    operator_reason:
      `The provider refused the request with an unrecognised ${status} response. Nothing was sent; this needs a look.`,
  });
}

function failure(fields) {
  return {
    provider: "brevo",
    suppression_action: null,
    ...fields,
  };
}

export default classifyBrevoProviderError;
