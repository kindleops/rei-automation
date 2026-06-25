/**
 * Monotonic delivery receipt reconciliation — shared precedence rules for RPC and tests.
 *
 * Canonical precedence:
 *   delivered > failed/undelivered > sent > queued/pending/accepted/sending
 */

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

const FINAL_FAILED = new Set([
  "failed",
  "undelivered",
  "error",
  "delivery_failed",
  "failed_transport",
  "blocked",
  "carrier_blocked",
]);

const INTERMEDIATE = new Set([
  "queued",
  "accepted",
  "pending",
  "sending",
  "sending_to_carrier",
  "pending_delivered_to_carrier",
  "awaiting_response",
]);

export function deliveryStatusRank(status) {
  const normalized = lower(status);
  if (normalized === "delivered") return 100;
  if (FINAL_FAILED.has(normalized) || normalized.includes("fail") || normalized.includes("undeliver")) {
    return 90;
  }
  if (normalized === "sent") return 50;
  if (INTERMEDIATE.has(normalized)) return 10;
  return normalized ? 20 : 0;
}

export function providerStatusRank(status) {
  const normalized = lower(status);
  if (normalized === "delivered") return 100;
  if (FINAL_FAILED.has(normalized)) return 90;
  if (normalized === "sent") return 60;
  if (normalized === "sending") return 40;
  if (normalized === "pending") return 30;
  if (normalized === "queued" || normalized === "accepted") return 20;
  return normalized ? 10 : 0;
}

export function normalizeIncomingDeliveryStatus({
  provider_status,
  failure_class = null,
} = {}) {
  const status = lower(provider_status);
  if (failure_class) return "failed";
  if (status === "delivered") return "delivered";
  if (FINAL_FAILED.has(status)) return "failed";
  return "sent";
}

export function mergeDeliveryReceiptState(current = {}, incoming = {}) {
  const current_delivery = lower(current.delivery_status);
  const current_has_delivered_at = Boolean(current.delivered_at);
  const current_rank = Math.max(
    deliveryStatusRank(current_delivery),
    current_has_delivered_at ? 100 : 0,
  );
  const incoming_rank = deliveryStatusRank(incoming.delivery_status);

  const final_rank = Math.max(current_rank, incoming_rank);
  const final_delivery_status =
    final_rank >= 100 ? "delivered" : final_rank >= 90 ? "failed" : "sent";

  const is_terminal_delivered =
    current_delivery === "delivered" || current_has_delivered_at;
  const current_provider_rank = providerStatusRank(current.provider_delivery_status);
  const incoming_provider_rank = providerStatusRank(incoming.provider_delivery_status);

  let final_provider_delivery_status = current.provider_delivery_status || null;
  if (incoming.provider_delivery_status) {
    if (is_terminal_delivered) {
      if (incoming_provider_rank >= Math.max(current_provider_rank, 100)) {
        final_provider_delivery_status = incoming.provider_delivery_status;
      }
    } else {
      final_provider_delivery_status = incoming.provider_delivery_status;
    }
  }

  let final_raw_carrier_status = current.raw_carrier_status || null;
  if (incoming.raw_carrier_status) {
    const incoming_raw_rank = providerStatusRank(incoming.raw_carrier_status);
    const current_raw_rank = providerStatusRank(final_raw_carrier_status);
    if (is_terminal_delivered) {
      if (incoming_raw_rank >= Math.max(current_raw_rank, 100)) {
        final_raw_carrier_status = incoming.raw_carrier_status;
      }
    } else {
      final_raw_carrier_status = incoming.raw_carrier_status;
    }
  }

  const merged_sent_at = current.sent_at || incoming.sent_at || null;
  let merged_delivered_at =
    final_delivery_status === "delivered"
      ? (current.delivered_at || incoming.delivered_at || null)
      : current.delivered_at || null;

  if (merged_delivered_at && merged_sent_at) {
    const delivered_ms = new Date(merged_delivered_at).getTime();
    const sent_ms = new Date(merged_sent_at).getTime();
    if (Number.isFinite(delivered_ms) && Number.isFinite(sent_ms) && delivered_ms < sent_ms) {
      merged_delivered_at = merged_sent_at;
    }
  }

  const patch = {
    delivery_status: final_delivery_status,
    provider_delivery_status: final_provider_delivery_status,
    raw_carrier_status: final_raw_carrier_status,
    sent_at: merged_sent_at,
    delivered_at: merged_delivered_at,
    failed_at: null,
    error_message: null,
    failure_reason: null,
    failure_bucket: null,
  };

  if (final_delivery_status === "failed") {
    patch.failed_at = current.failed_at || incoming.failed_at || incoming.updated_at || null;
    patch.error_message = incoming.error_message || current.error_message || null;
    patch.failure_reason = incoming.failure_reason || current.failure_reason || null;
    patch.failure_bucket = incoming.failure_bucket || current.failure_bucket || null;
  }

  return patch;
}

export function mergeQueueDeliveryState(current = {}, incoming = {}) {
  const event_patch = mergeDeliveryReceiptState(
    {
      delivery_status: current.queue_status,
      provider_delivery_status: current.queue_status,
      delivered_at: current.delivered_at,
      sent_at: current.sent_at,
      failed_at: current.failed_at,
    },
    {
      delivery_status: incoming.delivery_status,
      provider_delivery_status: incoming.provider_delivery_status,
      delivered_at: incoming.delivered_at,
      sent_at: incoming.sent_at,
      failed_at: incoming.failed_at,
      error_message: incoming.failed_reason,
      failure_reason: incoming.failed_reason,
      updated_at: incoming.updated_at,
    },
  );

  const patch = {
    queue_status:
      event_patch.delivery_status === "delivered"
        ? "delivered"
        : event_patch.delivery_status === "failed"
          ? (incoming.queue_status_terminal || "failed")
          : event_patch.delivery_status === "sent"
            ? "sent"
            : current.queue_status,
    sent_at: event_patch.sent_at || current.sent_at || null,
    delivered_at: event_patch.delivered_at || null,
    failed_reason: event_patch.failure_reason || null,
    delivery_confirmed:
      event_patch.delivery_status === "delivered"
        ? "confirmed"
        : event_patch.delivery_status === "failed"
          ? "failed"
          : current.delivery_confirmed || null,
    updated_at: incoming.updated_at || current.updated_at || null,
  };

  if (event_patch.delivery_status === "delivered") {
    patch.failed_reason = null;
  }

  return patch;
}

export function shouldPromoteThreadDelivery({
  latest_direction,
  latest_message_event_id,
  reconciled_event_id,
} = {}) {
  const direction = lower(latest_direction);
  if (direction !== "outbound") return false;
  if (!reconciled_event_id) return false;
  if (!latest_message_event_id) return true;
  return String(latest_message_event_id) === String(reconciled_event_id);
}