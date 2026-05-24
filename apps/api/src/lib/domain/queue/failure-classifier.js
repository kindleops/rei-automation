function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

export function classifyQueueBusinessOutcome(input = {}) {
  const message = lower(input?.message || input?.error_message || input?.error || "");
  const reason = lower(input?.reason || "");
  const code = lower(input?.code || input?.error_code || "");

  const joined = `${message} ${reason} ${code}`.trim();
  if (!joined) return null;

  if (joined.includes("21610") || joined.includes("blacklist")) {
    return { handled: true, reason: "provider_blacklist_pair", retryable: false, failure_bucket: "provider_blacklist_pair" };
  }
  if (joined.includes("invalid 'to'") || joined.includes("invalid_to") || joined.includes("invalid destination") || joined.includes("invalid_phone_number")) {
    return { handled: true, reason: "invalid_to_number", retryable: false, failure_bucket: "invalid_to_number" };
  }
  if (joined.includes("content filter") || joined.includes("spam")) {
    return { handled: true, reason: "provider_content_filter", retryable: false, failure_bucket: "provider_content_filter" };
  }
  if (joined.includes("duplicate")) {
    return { handled: true, reason: "duplicate_queue_row", retryable: false, failure_bucket: "duplicate_queue_row" };
  }
  if (joined.includes("dnc") || joined.includes("opt out") || joined.includes("opt_out") || joined.includes("suppression")) {
    return { handled: true, reason: "dnc_opt_out_suppressed", retryable: false, failure_bucket: "dnc_opt_out_suppressed" };
  }
  if (joined.includes("outside_contact_window") || joined.includes("outside_local_send_window")) {
    return { handled: true, reason: "outside_contact_window", retryable: true, failure_bucket: "outside_contact_window" };
  }
  if (joined.includes("missing_message_body") || joined.includes("blank_greeting") || joined.includes("message body is empty")) {
    return { handled: true, reason: "blank_body", retryable: false, failure_bucket: "blank_body" };
  }
  if (joined.includes("missing_from_phone_number") || joined.includes("invalid 'from'")) {
    return { handled: true, reason: "missing_from_number", retryable: false, failure_bucket: "missing_from_number" };
  }
  if (joined.includes("missing_seller_first_name") || joined.includes("seller_first_name")) {
    return { handled: true, reason: "missing_seller_name", retryable: false, failure_bucket: "missing_seller_name" };
  }
  return null;
}

export function isHandledBusinessOutcome(input = {}) {
  return Boolean(classifyQueueBusinessOutcome(input)?.handled);
}

