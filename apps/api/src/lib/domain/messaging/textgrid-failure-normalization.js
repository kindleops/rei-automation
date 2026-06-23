function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function safeStringify(value) {
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

function pushKnownFields(parts, source = {}) {
  if (!isPlainObject(source)) return;

  for (const key of [
    "status",
    "message",
    "reason",
    "error",
    "error_message",
    "failure_reason",
    "failure_class",
    "normalized_reason",
    "provider_failure_reason",
    "provider_delivery_status",
    "raw_carrier_status",
    "failed_reason",
    "blocked_reason",
    "guard_reason",
  ]) {
    const value = source[key];
    if (isPlainObject(value)) {
      pushKnownFields(parts, value);
      pushText(parts, value.message);
      pushText(parts, value.reason);
      pushText(parts, value.error_message);
    } else {
      pushText(parts, value);
    }
  }
}

function collectFailureText(input = {}) {
  const parts = [];
  pushKnownFields(parts, input);

  if (isPlainObject(input.metadata)) {
    pushKnownFields(parts, input.metadata);
    pushKnownFields(parts, input.metadata.provider_error);
    pushKnownFields(parts, input.metadata.send_result);
    pushText(parts, input.metadata.failure_class);
    pushText(parts, input.metadata.normalized_reason);
  }

  if (isPlainObject(input.raw)) {
    pushKnownFields(parts, input.raw);
    pushText(parts, safeStringify(input.raw));
  }

  pushText(parts, safeStringify(input));
  return parts.join(" | ");
}

function firstProviderReason(input = {}) {
  const sources = [
    input.provider_failure_reason,
    input.failure_reason,
    input.error_message,
    input.reason,
    input.message,
    input.error?.message,
    input.error?.reason,
    input.failed_reason,
    input.blocked_reason,
    input.guard_reason,
    input.metadata?.provider_failure_reason,
    input.metadata?.failure_reason,
    input.metadata?.reason,
    input.metadata?.message,
    input.metadata?.error_message,
    input.metadata?.provider_error?.provider_failure_reason,
    input.metadata?.provider_error?.failure_reason,
    input.metadata?.provider_error?.error_message,
    input.metadata?.provider_error?.message,
    input.metadata?.send_result?.provider_failure_reason,
    input.metadata?.send_result?.failure_reason,
    input.metadata?.send_result?.reason,
    input.metadata?.send_result?.error_message,
    input.metadata?.send_result?.message,
    input.raw?.provider_failure_reason,
    input.raw?.failure_reason,
    input.raw?.reason,
    input.raw?.message,
    input.raw?.error_message,
    input.raw?.ErrorMessage,
  ];

  for (const value of sources) {
    const text = clean(value);
    if (text) return text;
  }

  return "";
}

function normalizedDeliveryStatus(input = {}, hasFailure = false) {
  if (hasFailure) return "failed";

  const status = lower(
    input.delivery_status ||
      input.status ||
      input.provider_delivery_status ||
      input.metadata?.status ||
      input.raw?.status
  );

  if (["delivered", "delivery_confirmed", "confirmed"].includes(status)) return "delivered";
  if (["failed", "undelivered", "rejected", "error", "delivery_failed"].includes(status)) return "failed";
  if (["sent", "queued", "accepted", "pending", "sending", "sending_to_carrier"].includes(status)) return "sent";
  return null;
}

function hasFailedStatus(input = {}) {
  const status = lower(
    input.delivery_status ||
      input.status ||
      input.provider_delivery_status ||
      input.metadata?.status ||
      input.raw?.status
  );
  return ["failed", "undelivered", "rejected", "error", "delivery_failed"].includes(status);
}

function canonicalFailureClass(value) {
  const text = lower(value).replace(/[-\s]+/g, "_");
  if (!text) return null;
  if (["content_filter_blocked", "blocked_by_textgrid_content_filter"].includes(text)) {
    return "content_filter_blocked";
  }
  if (["recipient_opted_out", "provider_blacklist", "opted_out"].includes(text)) {
    return "recipient_opted_out";
  }
  if (["invalid_to_number", "invalid_number"].includes(text)) {
    return "invalid_to_number";
  }
  if (text === "recipient_out_of_credit") return "recipient_out_of_credit";
  if (text === "unknown_failure") return "unknown_failure";
  return null;
}

function classResult(result, failure_class) {
  if (failure_class === "content_filter_blocked") {
    return {
      ...result,
      delivery_status: "failed",
      failure_class,
      normalized_reason: "blocked_by_textgrid_content_filter",
      is_terminal: true,
      retry_allowed: false,
    };
  }
  if (failure_class === "recipient_opted_out") {
    return {
      ...result,
      delivery_status: "failed",
      failure_class,
      normalized_reason: "recipient_opted_out",
      is_terminal: true,
      retry_allowed: false,
    };
  }
  if (failure_class === "invalid_to_number") {
    return {
      ...result,
      delivery_status: "failed",
      failure_class,
      normalized_reason: "invalid_to_number",
      is_terminal: true,
      retry_allowed: false,
    };
  }
  if (failure_class === "recipient_out_of_credit") {
    return {
      ...result,
      delivery_status: "failed",
      failure_class,
      normalized_reason: "recipient_out_of_credit",
      is_terminal: false,
      retry_allowed: true,
    };
  }
  if (failure_class === "unknown_failure") {
    return {
      ...result,
      delivery_status: "failed",
      failure_class,
      normalized_reason: "unknown_failure",
      is_terminal: true,
      retry_allowed: false,
    };
  }
  return null;
}

export function normalizeTextGridFailure(input = {}) {
  const text = lower(collectFailureText(input));
  const provider_failure_reason = firstProviderReason(input);
  const providerText = lower(provider_failure_reason);

  const result = {
    delivery_status: normalizedDeliveryStatus(input, false),
    failure_class: null,
    provider_failure_reason: provider_failure_reason || null,
    normalized_reason: null,
    is_terminal: false,
    retry_allowed: true,
  };

  const existing_failure_class = canonicalFailureClass(
    input.failure_class ||
      input.metadata?.failure_class ||
      input.raw?.failure_class ||
      input.normalized_reason ||
      input.metadata?.normalized_reason ||
      input.raw?.normalized_reason
  );
  const existing_failure_result = classResult(result, existing_failure_class);
  if (existing_failure_result) return existing_failure_result;

  if (text.includes("blocked by textgrid content filter") || text.includes("content filter")) {
    return classResult(result, "content_filter_blocked");
  }

  if (
    text.includes("recipient opted out") ||
    text.includes("blacklist") ||
    text.includes("opted out") ||
    text.includes("opt out") ||
    text.includes("opt-out")
  ) {
    return {
      ...classResult(result, "recipient_opted_out"),
      normalized_reason: text.includes("blacklist") ? "provider_blacklist" : "recipient_opted_out",
    };
  }

  if (
    text.includes("'to' number invalid") ||
    text.includes("\"to\" number invalid") ||
    text.includes("to number invalid") ||
    text.includes("invalid destination") ||
    text.includes("invalid number") ||
    text.includes("not a valid phone") ||
    text.includes("invalid") ||
    providerText === "invalid"
  ) {
    return classResult(result, "invalid_to_number");
  }

  if (text.includes("end user out of credit")) {
    return classResult(result, "recipient_out_of_credit");
  }

  if (hasFailedStatus(input)) {
    return classResult(result, "unknown_failure");
  }

  if (
    provider_failure_reason ||
    clean(input.error_message) ||
    clean(input.failure_reason) ||
    clean(input.failed_reason) ||
    clean(input.blocked_reason)
  ) {
    return {
      ...result,
      delivery_status: "failed",
      failure_class: "unknown_failure",
      normalized_reason: "unknown_failure",
      is_terminal: false,
      retry_allowed: true,
    };
  }

  return result;
}

export function textGridFailureMetadata(normalized = {}) {
  const metadata = {};
  if (clean(normalized.failure_class)) metadata.failure_class = clean(normalized.failure_class);
  if (clean(normalized.provider_failure_reason)) metadata.provider_failure_reason = clean(normalized.provider_failure_reason);
  if (clean(normalized.normalized_reason)) metadata.normalized_reason = clean(normalized.normalized_reason);
  if (typeof normalized.retry_allowed === "boolean") metadata.retry_allowed = normalized.retry_allowed;
  if (typeof normalized.is_terminal === "boolean") metadata.is_terminal = normalized.is_terminal;
  return metadata;
}

export default normalizeTextGridFailure;
