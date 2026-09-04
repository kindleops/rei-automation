import { normalizeTextGridFailure } from "@/lib/domain/messaging/textgrid-failure-normalization.js";
import { classifyNetworkFailurePhase } from "@/lib/domain/messaging/transport-failure-phase.js";

export const TEXTGRID_BLACKLIST_CODE = "21610";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseEmbeddedJson(text = "") {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export function extractTextGridProviderCode(error = {}) {
  const direct = clean(error.code ?? error.error_code ?? error.provider_code);
  if (direct) return direct;

  const data = ensureObject(error.data);
  if (clean(data.code)) return clean(data.code);

  const parsed = parseEmbeddedJson(error.message);
  if (parsed && clean(parsed.code)) return clean(parsed.code);

  const msg = lower(error.message);
  if (msg.includes("21610")) return TEXTGRID_BLACKLIST_CODE;
  return null;
}

export function extractTextGridProviderMessage(error = {}) {
  const data = ensureObject(error.data);
  if (clean(data.message)) return clean(data.message);
  const parsed = parseEmbeddedJson(error.message);
  if (parsed && clean(parsed.message)) return clean(parsed.message);
  return clean(error.message) || null;
}

/**
 * Canonical TextGrid/provider error classification for queue disposition,
 * retry policy, suppression, and observability.
 */
/**
 * Does this error look like a TRANSPORT failure rather than a provider verdict?
 *
 * A response with an HTTP status means the provider answered, so it is a
 * provider outcome and must be classified by code/message, not by wire phase.
 */
function isLikelyTransportFailure(error = {}) {
  if (error?.status) return false;
  if (error?.network_phase) return true;
  const code = clean(error?.cause?.code || error?.code).toUpperCase();
  if (code) return true;
  const name = clean(error?.name);
  if (name === "TimeoutError" || name === "AbortError") return true;
  const message = lower(error?.message);
  return (
    /\b(econnrefused|econnreset|enotfound|eai_again|etimedout|ehostunreach|enetunreach|epipe)\b/.test(message) ||
    /getaddrinfo|socket hang up|fetch failed|network error|timed out|timeout|aborted/.test(message)
  );
}

export function classifyTextGridProviderError(error = {}, context = {}) {
  const provider_code = extractTextGridProviderCode(error);
  const provider_message = extractTextGridProviderMessage(error);
  const normalized = normalizeTextGridFailure({
    ...error,
    error_message: provider_message || error?.message,
    metadata: ensureObject(error.metadata),
    raw: ensureObject(error.data),
  });

  // ── TRANSPORT OUTCOME ────────────────────────────────────────────────────
  // A network failure is NOT automatically retry-safe. What matters is whether
  // the request could already have reached the provider.
  //
  //   network_phase "connect"  -> the socket never opened, so no SMS exists.
  //                               Another attempt is PROVABLY safe.
  //   network_phase "inflight" -> a timeout or reset after the request was
  //                               written. TextGrid may have accepted and sent
  //                               it; we just never heard the answer. Retrying
  //                               would put a SECOND message in front of the
  //                               seller, so this is AMBIGUOUS and terminal.
  //
  // TextGrid offers no caller idempotency key and no verified message lookup,
  // so a sid-less timeout cannot be queried away. Absence of a sid means the
  // provider identity is UNKNOWN -- never that the provider declined.
  // The adapter stamps network_phase when it wraps a fetch failure. Errors that
  // reach us another way (constructed directly, re-thrown, or surfaced by a
  // different caller) carry no stamp, so derive it here. Classification must not
  // depend on which code path happened to build the error object.
  const derived_phase =
    clean(error?.network_phase) ||
    (isLikelyTransportFailure(error) ? classifyNetworkFailurePhase(error).phase : "");
  // A 5xx means the provider answered with a server error. We cannot prove from
  // a 500/502/503/504 that the message was NOT created before the error
  // surfaced, so it is ambiguous rather than a clean rejection.
  const server_error_status = Number(error?.status) >= 500;
  const network_phase = derived_phase || (server_error_status ? "inflight" : "");
  if (network_phase) {
    const may_have_transmitted =
      error?.may_have_transmitted !== undefined && error?.may_have_transmitted !== null
        ? error.may_have_transmitted !== false
        : server_error_status
          ? true
          : classifyNetworkFailurePhase(error).may_have_transmitted !== false;

    if (!may_have_transmitted) {
      return {
        provider_code,
        provider_message: provider_message || clean(error?.message) || "Provider connection failed",
        provider_payload: ensureObject(error.data) || null,
        failure_class: "provider_unreachable_before_request",
        // A refused connection is exactly what "Soft Bounce" means: transient,
        // and provably not delivered.
        failure_bucket: "Soft Bounce",
        normalized_reason: "provider_connect_failed_before_request",
        non_retryable_reason: null,
        retryable: true,
        is_terminal: false,
        compliance_related: false,
        queue_disposition: "queued",
        suppression_action: null,
        sentry_level: "info",
        operator_reason:
          "Could not reach the provider; the request never left, so no message was sent",
        no_sender_rotation: false,
        no_alternate_number_retry: false,
        no_campaign_reenqueue: false,
        transport_phase: network_phase,
        may_have_transmitted: false,
        metrics: {
          event: "queue.send.transport_connect_failed",
          reason: "provider_connect_failed_before_request",
          campaign_id: context.campaign_id || null,
          market: context.market || null,
        },
      };
    }

    return {
      provider_code,
      provider_message: provider_message || clean(error?.message) || "Provider transport failure",
      provider_payload: ensureObject(error.data) || null,
      failure_class: "provider_ambiguous_transport",
      // Deliberately NOT "Soft Bounce". That bucket maps to the retry-flavoured
      // reason "Network Error" and tells an operator the message did not
      // arrive -- the one thing we cannot say here.
      failure_bucket: "Unknown Outcome",
      normalized_reason: "provider_outcome_unknown_after_request",
      non_retryable_reason: "provider_outcome_unknown_manual_review",
      retryable: false,
      is_terminal: true,
      compliance_related: false,
      queue_disposition: "failed",
      suppression_action: null,
      sentry_level: "warning",
      operator_reason:
        "Provider outcome unknown. The request may have been delivered, so this will not be resent automatically.",
      // Every automatic re-entry into provider execution is closed.
      no_sender_rotation: true,
      no_alternate_number_retry: true,
      no_campaign_reenqueue: true,
      transport_phase: network_phase,
      may_have_transmitted: true,
      metrics: {
        event: "queue.send.ambiguous_transport",
        reason: "provider_outcome_unknown_after_request",
        campaign_id: context.campaign_id || null,
        market: context.market || null,
      },
    };
  }

  const is_blacklist =
    provider_code === TEXTGRID_BLACKLIST_CODE ||
    lower(provider_message).includes("blacklist") ||
    lower(error?.message).includes("21610");

  if (is_blacklist) {
    return {
      provider_code: provider_code || TEXTGRID_BLACKLIST_CODE,
      provider_message: provider_message || "The message From/To pair violates a blacklist rule.",
      provider_payload: ensureObject(error.data) || parseEmbeddedJson(error?.message) || null,
      failure_class: "recipient_opted_out",
      failure_bucket: "provider_blacklist_pair",
      normalized_reason: "provider_blacklist",
      non_retryable_reason: "textgrid_21610_blacklist",
      retryable: false,
      is_terminal: true,
      compliance_related: true,
      queue_disposition: "failed",
      suppression_action: "pair_and_recipient_sms",
      sentry_level: "warning",
      operator_reason: "Provider blacklist (21610): From/To pair prohibited",
      no_sender_rotation: true,
      no_alternate_number_retry: true,
      no_campaign_reenqueue: true,
      metrics: {
        event: "queue.send.suppressed",
        reason: "provider_blacklist",
        provider_code: TEXTGRID_BLACKLIST_CODE,
        campaign_id: context.campaign_id || null,
        market: context.market || null,
        sender_hash: context.sender_hash || null,
        destination_hash: context.destination_hash || null,
      },
    };
  }

  // Ambiguous accept: the provider responded without a message SID. The SMS
  // may have been delivered anyway, so a retry risks a DUPLICATE seller
  // message. Terminal + manual review — never the 5-minute retry loop.
  const is_ambiguous_no_sid =
    error?.no_sid_ambiguous_send === true ||
    lower(error?.message).includes("send failed - no sid");
  if (is_ambiguous_no_sid) {
    return {
      provider_code,
      provider_message: provider_message || "Provider response carried no message SID",
      provider_payload: ensureObject(error.data) || null,
      failure_class: "provider_ambiguous_accept",
      failure_bucket: "provider_no_sid",
      normalized_reason: "provider_response_missing_sid",
      non_retryable_reason: "provider_response_missing_sid_manual_review",
      retryable: false,
      is_terminal: true,
      compliance_related: false,
      queue_disposition: "failed",
      suppression_action: null,
      sentry_level: "warning",
      operator_reason:
        "Provider accepted the request but returned no SID — possible duplicate on retry; verify delivery manually",
      no_sender_rotation: true,
      no_alternate_number_retry: true,
      no_campaign_reenqueue: true,
      metrics: {
        event: "queue.send.ambiguous_no_sid",
        reason: "provider_response_missing_sid",
        campaign_id: context.campaign_id || null,
        market: context.market || null,
        sender_hash: context.sender_hash || null,
        destination_hash: context.destination_hash || null,
      },
    };
  }

  if (normalized.failure_class === "recipient_opted_out") {
    return {
      provider_code,
      provider_message,
      provider_payload: ensureObject(error.data) || null,
      failure_class: normalized.failure_class,
      failure_bucket: "DNC",
      normalized_reason: normalized.normalized_reason,
      non_retryable_reason: normalized.normalized_reason || "recipient_opted_out",
      retryable: false,
      is_terminal: true,
      compliance_related: true,
      queue_disposition: "opted_out",
      suppression_action: "recipient_sms",
      sentry_level: "warning",
      operator_reason: "Recipient opted out",
      no_sender_rotation: true,
      no_alternate_number_retry: true,
      no_campaign_reenqueue: true,
      metrics: null,
    };
  }

  if (normalized.failure_class === "invalid_to_number") {
    return {
      provider_code,
      provider_message,
      provider_payload: ensureObject(error.data) || null,
      failure_class: normalized.failure_class,
      failure_bucket: "Hard Bounce",
      normalized_reason: normalized.normalized_reason,
      non_retryable_reason: "invalid_to_number",
      retryable: false,
      is_terminal: true,
      compliance_related: false,
      queue_disposition: "invalid_number",
      suppression_action: null,
      sentry_level: "warning",
      operator_reason: "Invalid destination number",
      no_sender_rotation: false,
      no_alternate_number_retry: false,
      no_campaign_reenqueue: false,
      metrics: null,
    };
  }

  // ── UNKNOWN FAILURE: FAIL CLOSED ─────────────────────────────────────────
  // This branch previously read `normalized.retry_allowed !== false && ...`,
  // which is `undefined !== false` for an unrecognised error -- so every
  // unknown failure defaulted to RETRYABLE, and retryable fed rotation. An
  // unclassified failure is by definition one whose provider outcome we do not
  // understand, so it must never grant an automatic second attempt.
  // `normalizeTextgridFailure` seeds its result with `retry_allowed: true` as a
  // base default, so an UNRECOGNISED failure inherits permission nobody granted.
  // Only trust that flag when the failure was actually classified; otherwise the
  // outcome is by definition not understood and must not authorise a retry.
  // "unknown_failure" is the normalizer's way of saying it did NOT recognise the
  // failure, so it must not count as recognition.
  const failure_recognised =
    Boolean(normalized.failure_class) && normalized.failure_class !== "unknown_failure";

  // DID THE PROVIDER ANSWER?
  //
  // An HTTP status means TextGrid replied, so the request completed a round
  // trip. A 4xx is a definitive REJECTION: the message was not created, so
  // another attempt cannot duplicate anything and the normalizer's retry
  // guidance can be trusted.
  //
  // A 5xx is deliberately NOT treated as safe. We cannot prove from a 500/502/
  // 503/504 that the message was not created before the error surfaced, and the
  // mission rule is that unproven means unsafe. It falls through to fail-closed.
  const status = Number(error?.status) || 0;
  const provider_rejected_definitively = status >= 400 && status < 500;

  const retryable =
    error?.retryable === true ||
    (provider_rejected_definitively && normalized.retry_allowed !== false) ||
    (failure_recognised && normalized.retry_allowed === true);
  return {
    provider_code,
    provider_message,
    provider_payload: ensureObject(error.data) || null,
    failure_class: normalized.failure_class || "unknown_failure",
    failure_bucket: null,
    normalized_reason: normalized.normalized_reason || "unknown_failure",
    non_retryable_reason: retryable ? null : normalized.normalized_reason || "provider_outcome_unclassified",
    retryable,
    is_terminal: normalized.is_terminal === true || !retryable,
    compliance_related: false,
    queue_disposition: retryable ? "queued" : "failed",
    suppression_action: null,
    sentry_level: retryable ? "info" : "error",
    operator_reason: provider_message || clean(error?.message) || "Provider send failed",
    no_sender_rotation: !retryable,
    no_alternate_number_retry: !retryable,
    no_campaign_reenqueue: false,
    metrics: null,
  };
}

export function isTextGridBlacklistError(error = {}) {
  return classifyTextGridProviderError(error).compliance_related &&
    classifyTextGridProviderError(error).provider_code === TEXTGRID_BLACKLIST_CODE;
}