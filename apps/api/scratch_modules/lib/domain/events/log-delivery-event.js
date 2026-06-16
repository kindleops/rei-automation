import { mapTextgridFailureBucket } from "../lib/providers/textgrid.js";
import { updateMessageEventStatus } from "../lib/domain/events/update-message-event-status.js";
import { normalizeTextGridFailure } from "../lib/domain/messaging/textgrid-failure-normalization.js";

const defaultDeps = {
  mapTextgridFailureBucket,
  updateMessageEventStatus,
};

let runtimeDeps = { ...defaultDeps };

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function normalizeDeliveryStatus(value) {
  const raw = lower(value);

  if (["delivered", "delivery_confirmed", "confirmed"].includes(raw)) {
    return "Delivered";
  }

  if (["failed", "undelivered", "delivery_failed", "error"].includes(raw)) {
    return "Failed";
  }

  if (["received"].includes(raw)) {
    return "Received";
  }

  if (["sent"].includes(raw)) {
    return "Sent";
  }

  if (["queued", "accepted", "pending"].includes(raw)) {
    return "Pending";
  }

  return "Sent";
}

export function __setLogDeliveryEventTestDeps(overrides = {}) {
  runtimeDeps = { ...runtimeDeps, ...overrides };
}

export function __resetLogDeliveryEventTestDeps() {
  runtimeDeps = { ...defaultDeps };
}

function failureBucketForNormalized(normalized_failure, fallback) {
  if (normalized_failure.failure_class === "content_filter_blocked") return "Spam";
  if (normalized_failure.failure_class === "recipient_opted_out") return "DNC";
  if (normalized_failure.failure_class === "invalid_to_number") return "Hard Bounce";
  if (normalized_failure.failure_class === "recipient_out_of_credit") return "Soft Bounce";
  return runtimeDeps.mapTextgridFailureBucket(fallback) || "Other";
}

export async function logDeliveryEvent({
  provider_message_id = null,
  delivery_status = null,
  raw_carrier_status = null,
  error_message = null,
  error_status = null,
  event_item_id = null,
  occurred_at = null,
} = {}) {
  const normalized_status = normalizeDeliveryStatus(
    delivery_status || raw_carrier_status
  );
  const is_failed = normalized_status === "Failed";
  const normalized_failure = normalizeTextGridFailure({
    status: delivery_status || raw_carrier_status,
    error_message,
    error_status,
  });
  const failure_bucket = is_failed
    ? failureBucketForNormalized(normalized_failure, {
        ok: false,
        error_message,
        error_status,
      })
    : null;
  const normalized_failure_fields = normalized_failure.failure_class
    ? {
        failure_class: normalized_failure.failure_class,
        provider_failure_reason: normalized_failure.provider_failure_reason,
        normalized_reason: normalized_failure.normalized_reason,
        retry_allowed: normalized_failure.retry_allowed,
        is_terminal: normalized_failure.is_terminal,
      }
    : {};

  const result = await runtimeDeps.updateMessageEventStatus({
    event_item_id,
    provider_message_id,
    delivery_status: normalized_status,
    provider_delivery_status: raw_carrier_status || delivery_status || normalized_status,
    raw_carrier_status: String(
      error_status || raw_carrier_status || normalized_status || ""
    ),
    failure_bucket,
    is_final_failure: is_failed,
    occurred_at,
    delivered_at: normalized_status === "Delivered" ? occurred_at : null,
    failed_at: normalized_status === "Failed" ? occurred_at : null,
    failure_code: error_status,
    failure_reason: error_message,
    ...normalized_failure_fields,
  });

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason || "message_event_not_found",
      provider_message_id: clean(provider_message_id),
    };
  }

  return {
    ok: true,
    updated: true,
    event_item_id: result.event_item_id,
    provider_message_id: clean(provider_message_id),
    delivery_status: normalized_status,
    failure_bucket,
  };
}

export default logDeliveryEvent;
