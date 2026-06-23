import { normalizeTextGridFailure } from "@/lib/domain/messaging/textgrid-failure-normalization.js";

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
export function classifyTextGridProviderError(error = {}, context = {}) {
  const provider_code = extractTextGridProviderCode(error);
  const provider_message = extractTextGridProviderMessage(error);
  const normalized = normalizeTextGridFailure({
    ...error,
    error_message: provider_message || error?.message,
    metadata: ensureObject(error.metadata),
    raw: ensureObject(error.data),
  });

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

  const retryable = normalized.retry_allowed !== false && error?.retryable !== false;
  return {
    provider_code,
    provider_message,
    provider_payload: ensureObject(error.data) || null,
    failure_class: normalized.failure_class || "unknown_failure",
    failure_bucket: null,
    normalized_reason: normalized.normalized_reason || "unknown_failure",
    non_retryable_reason: retryable ? null : normalized.normalized_reason || "provider_terminal",
    retryable,
    is_terminal: normalized.is_terminal === true,
    compliance_related: false,
    queue_disposition: retryable ? "queued" : "failed",
    suppression_action: null,
    sentry_level: retryable ? "info" : "error",
    operator_reason: provider_message || clean(error?.message) || "Provider send failed",
    no_sender_rotation: false,
    no_alternate_number_retry: false,
    no_campaign_reenqueue: false,
    metrics: null,
  };
}

export function isTextGridBlacklistError(error = {}) {
  return classifyTextGridProviderError(error).compliance_related &&
    classifyTextGridProviderError(error).provider_code === TEXTGRID_BLACKLIST_CODE;
}