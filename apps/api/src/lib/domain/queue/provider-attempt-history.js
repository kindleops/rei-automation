// ─── provider-attempt-history.js ─────────────────────────────────────────────
// Aggregate transport state for a queue row that may have multiple provider
// attempts. Historical failures (e.g. 21610) stay immutable; aggregate status
// follows the latest authoritative successful delivery.

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Derive aggregate attempt counters and final status from ordered attempts.
 * Each attempt: { outcome: 'accepted'|'failed'|'delivered', provider_sid?,
 *   provider_code?, http_status?, authorized_retry? }
 */
export function reconcileProviderAttemptHistory(attempts = []) {
  const list = Array.isArray(attempts) ? attempts : [];
  const provider_attempt_count = list.length;
  const successful_provider_attempt_count = list.filter(
    (a) => a?.outcome === "accepted" || a?.outcome === "delivered"
  ).length;
  const delivered_count = list.filter((a) => a?.outcome === "delivered").length;
  const sids = [
    ...new Set(list.map((a) => clean(a?.provider_sid)).filter(Boolean)),
  ];
  const authorized_retries = list.filter((a) => a?.authorized_retry === true).length;
  // retry_count = total attempts after the first
  const retry_count = Math.max(0, provider_attempt_count - 1);

  let aggregate_queue_status = "unknown";
  const last = list[list.length - 1] || null;
  if (delivered_count > 0) {
    aggregate_queue_status = "delivered";
  } else if (last?.outcome === "accepted" && last?.provider_sid) {
    aggregate_queue_status = "sent";
  } else if (last?.outcome === "failed") {
    aggregate_queue_status =
      last.provider_code === "21610" || /21610/i.test(String(last.provider_code || ""))
        ? "failed"
        : "failed_transport";
  }

  return {
    provider_attempt_count,
    successful_provider_attempt_count,
    delivered_count,
    retry_count,
    authorized_retry_count: authorized_retries,
    provider_sid_count: sids.length,
    provider_sids: sids,
    aggregate_queue_status,
    historical_failures_preserved: list.some((a) => a?.outcome === "failed"),
    latest_attempt: last,
  };
}

/**
 * Build proposed reconciliation patch for a queue row after a later success
 * supersedes an earlier terminal failure on the same row. Never deletes history.
 */
export function buildSuccessfulRetryAggregatePatch({
  previous_status = null,
  previous_failed_reason = null,
  previous_metadata = {},
  success_sid = null,
  success_at = null,
  authorized_retry_at = null,
} = {}) {
  const meta =
    previous_metadata && typeof previous_metadata === "object"
      ? { ...previous_metadata }
      : {};
  const attempts = Array.isArray(meta.provider_attempts) ? [...meta.provider_attempts] : [];

  if (previous_status === "failed" || previous_failed_reason || meta.provider_error) {
    attempts.push({
      outcome: "failed",
      provider_code: meta.provider_error?.code || null,
      provider_sid: null,
      recorded_at: meta.provider_error?.recorded_at || null,
      failed_reason: previous_failed_reason || meta.provider_failure_reason || null,
      preserved: true,
    });
  }

  attempts.push({
    outcome: "delivered",
    provider_sid: success_sid,
    authorized_retry: true,
    authorized_retry_at: authorized_retry_at || success_at,
    recorded_at: success_at,
  });

  const aggregate = reconcileProviderAttemptHistory(attempts);

  return {
    queue_status: "delivered",
    provider_message_id: success_sid,
    failed_reason: null,
    delivered_at: success_at,
    metadata_patch: {
      ...meta,
      provider_attempts: attempts,
      aggregate_transport: aggregate,
      historical_failure_preserved: true,
      // Keep original failure payload under audit key; do not delete
      prior_terminal_failure_audit: meta.provider_error
        ? {
            preserved: true,
            provider_error: meta.provider_error,
            failure_class: meta.failure_class || null,
            failure_bucket: meta.failure_bucket || null,
          }
        : meta.prior_terminal_failure_audit || null,
      is_terminal: false,
      final_failure: false,
    },
  };
}

export default {
  reconcileProviderAttemptHistory,
  buildSuccessfulRetryAggregatePatch,
};
