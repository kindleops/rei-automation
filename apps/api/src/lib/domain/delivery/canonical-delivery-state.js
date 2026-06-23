const DEFAULT_MAX_RETRY_COUNT = 2;
const DEFAULT_TRANSIENT_RETRY_AFTER_SECONDS = 15 * 60;

const FINAL_FAILED_STATUSES = new Set([
  "failed",
  "undelivered",
  "delivery_failed",
  "error",
  "rejected",
]);

const DELIVERED_STATUSES = new Set([
  "delivered",
  "delivery_confirmed",
  "confirmed",
]);

const PENDING_STATUSES = new Set([
  "queued",
  "pending",
  "approved",
  "ready",
  "scheduled",
  "sending",
  "processing",
  "sent",
  "accepted",
  "sending_to_carrier",
  "pending_delivered_to_carrier",
  "awaiting_response",
]);

const TRANSIENT_FAILURE_CLASSES = new Set([
  "provider_timeout",
  "network_timeout",
  "provider_5xx",
  "temporary_unavailable",
  "unknown_provider_timeout",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function stringify(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function pushText(parts, value) {
  const text = clean(value);
  if (text) parts.push(text);
}

function collectDeliveryText(input = {}) {
  const parts = [];
  for (const key of [
    "queue_status",
    "provider_status",
    "delivery_status",
    "raw_carrier_status",
    "provider_failure_reason",
    "failure_reason",
    "failed_reason",
    "error_code",
    "error_message",
    "reason",
    "message",
    "failure_class",
  ]) {
    pushText(parts, input[key]);
  }

  if (isObject(input.metadata)) {
    for (const key of [
      "failure_class",
      "normalized_reason",
      "provider_failure_reason",
      "failure_reason",
      "failed_reason",
      "error_message",
      "reason",
      "message",
      "blocked_reason",
      "guard_reason",
    ]) {
      pushText(parts, input.metadata[key]);
    }
    if (isObject(input.metadata.provider_error)) {
      parts.push(collectDeliveryText(input.metadata.provider_error));
    }
    if (isObject(input.metadata.send_result)) {
      parts.push(collectDeliveryText(input.metadata.send_result));
    }
  }

  pushText(parts, stringify(input.raw));
  return lower(parts.filter(Boolean).join(" | "));
}

function normalizeStatus(value) {
  const normalized = lower(value).replace(/\s+/g, "_");
  if (!normalized) return "";
  return normalized;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function classifyFailure(input = {}) {
  const text = collectDeliveryText(input);
  const error_code = lower(input.error_code || input.metadata?.error_code || input.metadata?.provider_error?.status);
  const failure_class = lower(input.failure_class || input.metadata?.failure_class);

  if (failure_class && failure_class !== "unknown_failure") {
    if (failure_class.includes("opt") || failure_class.includes("blacklist")) {
      return {
        failure_class: failure_class.includes("blacklist") ? "blacklist_violation" : "recipient_opted_out",
        terminal: true,
        retryable: false,
        suppression_required: true,
        reason: failure_class,
      };
    }
    if (failure_class.includes("wrong")) {
      return {
        failure_class: "wrong_number",
        terminal: true,
        retryable: false,
        suppression_required: true,
        reason: failure_class,
      };
    }
    if (failure_class.includes("invalid") || failure_class.includes("deactivated")) {
      return {
        failure_class: "invalid_number",
        terminal: true,
        retryable: false,
        suppression_required: true,
        reason: failure_class,
      };
    }
    if (TRANSIENT_FAILURE_CLASSES.has(failure_class)) {
      return {
        failure_class,
        terminal: false,
        retryable: true,
        suppression_required: false,
        reason: failure_class,
      };
    }
  }

  if (error_code === "21610" || text.includes("21610") || text.includes("blacklist")) {
    return {
      failure_class: "blacklist_violation",
      terminal: true,
      retryable: false,
      suppression_required: true,
      reason: "provider_blacklist_21610",
    };
  }

  if (
    text.includes("recipient opted out") ||
    text.includes("opted out") ||
    text.includes("opt out") ||
    text.includes("opt-out") ||
    text.includes("unsubscribe") ||
    /\bstop\b/.test(text)
  ) {
    return {
      failure_class: "recipient_opted_out",
      terminal: true,
      retryable: false,
      suppression_required: true,
      reason: "recipient_opted_out",
    };
  }

  if (
    text.includes("wrong number") ||
    text.includes("wrong person") ||
    text.includes("not my number") ||
    text.includes("not the owner")
  ) {
    return {
      failure_class: "wrong_number",
      terminal: true,
      retryable: false,
      suppression_required: true,
      reason: "wrong_number",
    };
  }

  if (
    text.includes("invalid number") ||
    text.includes("invalid to") ||
    text.includes("to number invalid") ||
    text.includes("'to' number invalid") ||
    text.includes("\"to\" number invalid") ||
    text.includes("not a valid phone") ||
    text.includes("deactivated") ||
    text.includes("disconnected") ||
    text.includes("unreachable permanent")
  ) {
    return {
      failure_class: text.includes("deactivated") || text.includes("disconnected")
        ? "deactivated_number"
        : "invalid_number",
      terminal: true,
      retryable: false,
      suppression_required: true,
      reason: "invalid_or_deactivated_number",
    };
  }

  if (
    text.includes("content filter") ||
    text.includes("carrier block") ||
    text.includes("blocked by carrier") ||
    text.includes("spam")
  ) {
    return {
      failure_class: "carrier_permanent_failure",
      terminal: true,
      retryable: false,
      suppression_required: false,
      reason: "carrier_or_content_filter_block",
    };
  }

  if (text.includes("network timeout") || text.includes("connection timed out")) {
    return {
      failure_class: "network_timeout",
      terminal: false,
      retryable: true,
      suppression_required: false,
      retry_after_seconds: DEFAULT_TRANSIENT_RETRY_AFTER_SECONDS,
      reason: "network_timeout",
    };
  }

  if (text.includes("provider timeout") || text.includes("gateway timeout") || text.includes("timeout")) {
    return {
      failure_class: "provider_timeout",
      terminal: false,
      retryable: true,
      suppression_required: false,
      retry_after_seconds: DEFAULT_TRANSIENT_RETRY_AFTER_SECONDS,
      reason: "provider_timeout",
    };
  }

  if (
    error_code.startsWith("5") ||
    text.includes("http 5") ||
    text.includes("status 5") ||
    text.includes("internal server error") ||
    text.includes("bad gateway")
  ) {
    return {
      failure_class: "provider_5xx",
      terminal: false,
      retryable: true,
      suppression_required: false,
      retry_after_seconds: 30 * 60,
      reason: "provider_5xx",
    };
  }

  if (
    text.includes("temporary unavailable") ||
    text.includes("temporarily unavailable") ||
    text.includes("daily limit") ||
    text.includes("rate limit") ||
    text.includes("out of credit")
  ) {
    return {
      failure_class: "temporary_unavailable",
      terminal: false,
      retryable: true,
      suppression_required: false,
      retry_after_seconds: 60 * 60,
      reason: "temporary_unavailable",
    };
  }

  if (text.includes("delivery_failed") || text.includes("failed") || text.includes("undelivered")) {
    return {
      failure_class: "unknown_delivery_failed",
      terminal: false,
      retryable: false,
      suppression_required: false,
      reason: "unclassified_delivery_failed",
    };
  }

  return {
    failure_class: null,
    terminal: false,
    retryable: false,
    suppression_required: false,
    reason: "no_failure_detected",
  };
}

export function resolveCanonicalDeliveryState({
  queue_status = null,
  provider_status = null,
  delivery_status = null,
  raw_carrier_status = null,
  provider_failure_reason = null,
  failure_reason = null,
  failed_reason = null,
  error_code = null,
  error_message = null,
  retry_count = 0,
  max_retry_count = DEFAULT_MAX_RETRY_COUNT,
  metadata = null,
  raw = null,
} = {}) {
  const queue = normalizeStatus(queue_status);
  const provider = normalizeStatus(provider_status || raw_carrier_status);
  const delivery = normalizeStatus(delivery_status);
  const retry_count_number = positiveInt(retry_count, 0);
  const max_retry_count_number = Math.max(0, positiveInt(max_retry_count, DEFAULT_MAX_RETRY_COUNT));
  const input = {
    queue_status: queue,
    provider_status: provider,
    delivery_status: delivery,
    raw_carrier_status,
    provider_failure_reason,
    failure_reason,
    failed_reason,
    error_code,
    error_message,
    retry_count: retry_count_number,
    metadata: isObject(metadata) ? metadata : {},
    raw,
  };

  const failure = classifyFailure(input);
  const provider_failed = FINAL_FAILED_STATUSES.has(provider) || Boolean(failure.failure_class);
  const delivery_failed = FINAL_FAILED_STATUSES.has(delivery);
  const queue_failed = FINAL_FAILED_STATUSES.has(queue) || queue === "failed";

  if (DELIVERED_STATUSES.has(delivery) || DELIVERED_STATUSES.has(provider) || queue === "delivered") {
    return {
      canonical_status: "delivered",
      finalized: true,
      retryable: false,
      terminal: true,
      failure_class: null,
      suppression_required: false,
      retry_after_seconds: null,
      reason: "delivered",
    };
  }

  if (provider_failed || delivery_failed || queue_failed) {
    const exhausted = failure.retryable && retry_count_number >= max_retry_count_number;
    const retryable = Boolean(failure.retryable && !failure.suppression_required && !failure.terminal && !exhausted);
    return {
      canonical_status: "failed",
      finalized: true,
      retryable,
      terminal: Boolean(failure.terminal || failure.suppression_required || exhausted),
      failure_class: exhausted ? "max_retries_exhausted" : failure.failure_class,
      suppression_required: Boolean(failure.suppression_required),
      retry_after_seconds: retryable
        ? Number(failure.retry_after_seconds || DEFAULT_TRANSIENT_RETRY_AFTER_SECONDS)
        : null,
      reason: exhausted ? "max_retries_exhausted" : failure.reason,
    };
  }

  if (PENDING_STATUSES.has(queue) || PENDING_STATUSES.has(provider) || PENDING_STATUSES.has(delivery)) {
    return {
      canonical_status: queue === "sent" || provider === "sent" || delivery === "sent" ? "sent" : "pending",
      finalized: false,
      retryable: false,
      terminal: false,
      failure_class: null,
      suppression_required: false,
      retry_after_seconds: null,
      reason: "not_final",
    };
  }

  return {
    canonical_status: "unknown",
    finalized: false,
    retryable: false,
    terminal: false,
    failure_class: null,
    suppression_required: false,
    retry_after_seconds: null,
    reason: "unknown_delivery_state",
  };
}

export function isCanonicalRetryableFailure(state = {}) {
  return Boolean(state?.retryable && !state?.suppression_required && !state?.terminal);
}

export default resolveCanonicalDeliveryState;
