function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

export const WAITING_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

const FAILED_DELIVERY_STATUSES = new Set([
  "failed",
  "undelivered",
  "delivery_failed",
  "failed_transport",
  "blocked",
  "carrier_blocked",
  "invalid_number",
]);

export function parseTimestampMs(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function isOutboundLastWithoutReply({ lastOutboundAt, lastInboundAt } = {}) {
  const outboundMs = parseTimestampMs(lastOutboundAt);
  if (!outboundMs) return false;
  const inboundMs = parseTimestampMs(lastInboundAt);
  return !inboundMs || inboundMs < outboundMs;
}

export function isFailedDeliveryStatus(status = "") {
  const normalized = lower(status);
  if (!normalized) return false;
  if (FAILED_DELIVERY_STATUSES.has(normalized)) return true;
  return normalized.includes("fail") || normalized.includes("undeliver");
}

const PENDING_WORKFLOW_STAGES = new Set([
  "awaiting_response",
  "waiting",
  "pending",
  "probate",
  "title",
  "closing",
  "document_pending",
  "buyer_pending",
  "paused",
]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function resolveWorkflowWaitingState(row = {}, now = Date.now()) {
  const followUpMs = parseTimestampMs(row.follow_up_at);
  if (followUpMs > now) {
    return { is_waiting: true, reason: "follow_up_scheduled" };
  }

  const nextScheduledMs = parseTimestampMs(row.next_scheduled_for);
  if (nextScheduledMs > now) {
    return { is_waiting: true, reason: "next_scheduled_for" };
  }

  const nextActionMs = parseTimestampMs(row.next_action_at);
  if (nextActionMs > now) {
    return { is_waiting: true, reason: "next_action_at" };
  }

  const nextAction = lower(row.next_action);
  if (nextAction && !["none", "closed", "complete", "completed", "dead"].includes(nextAction)) {
    return { is_waiting: true, reason: "next_action_pending" };
  }

  const stage = lower(row.stage || row.status || row.automation_status || "");
  if (PENDING_WORKFLOW_STAGES.has(stage) || stage.includes("pending") || stage.includes("awaiting")) {
    return { is_waiting: true, reason: "workflow_stage_pending" };
  }

  const metadata = object(row.metadata);
  if (metadata.awaiting_external_event === true || metadata.workflow_paused === true) {
    return { is_waiting: true, reason: "workflow_paused" };
  }

  if (isOutboundLastWithoutReply({
    lastOutboundAt: row.last_outbound_at || row.lastOutboundAt,
    lastInboundAt: row.last_inbound_at || row.lastInboundAt,
  })) {
    const automationStatus = lower(row.automation_status || row.automation_state || "");
    if (
      automationStatus.includes("await")
      || automationStatus.includes("pending")
      || Number(row.pending_queue_count || 0) > 0
    ) {
      return { is_waiting: true, reason: "awaiting_seller_response" };
    }

    const outboundMs = parseTimestampMs(row.last_outbound_at || row.lastOutboundAt);
    const ageMs = now - outboundMs;
    if (outboundMs && ageMs <= WAITING_REPLY_WINDOW_MS) {
      return { is_waiting: true, reason: "recent_outbound_grace" };
    }
  }

  return { is_waiting: false, reason: null };
}

export function resolveOutboundReplyState({
  lastOutboundAt,
  lastInboundAt,
  latestDeliveryStatus,
  now = Date.now(),
  workflowRow: _workflowRow = {},
} = {}) {
  if (!isOutboundLastWithoutReply({ lastOutboundAt, lastInboundAt })) {
    return {
      inbox_bucket: null,
      automation_lane: null,
      disposition: null,
    };
  }

  if (isFailedDeliveryStatus(latestDeliveryStatus)) {
    return {
      inbox_bucket: null,
      automation_lane: "delivery_recovery",
      disposition: null,
    };
  }

  const outboundMs = parseTimestampMs(lastOutboundAt);
  if (!outboundMs) {
    return {
      inbox_bucket: null,
      automation_lane: null,
      disposition: null,
    };
  }

  if ((now - outboundMs) <= WAITING_REPLY_WINDOW_MS) {
    return {
      inbox_bucket: "waiting",
      automation_lane: null,
      disposition: null,
    };
  }

  return {
    inbox_bucket: null,
    automation_lane: "cold_reactivation",
    disposition: null,
  };
}

export function shouldTransitionWaitingToCold({
  inbox_bucket,
  lastOutboundAt,
  lastInboundAt,
  now = Date.now(),
} = {}) {
  if (lower(inbox_bucket) !== "waiting") return false;
  const coldState = resolveOutboundReplyState({
    lastOutboundAt,
    lastInboundAt,
    now,
  });
  return coldState.inbox_bucket == null && coldState.automation_lane === "cold_reactivation";
}

export function buildColdTransitionPatch({
  inbox_bucket,
  lastOutboundAt,
  lastInboundAt,
  now = Date.now(),
} = {}) {
  if (!shouldTransitionWaitingToCold({ inbox_bucket, lastOutboundAt, lastInboundAt, now })) {
    return null;
  }

  return {
    inbox_bucket: null,
    automation_lane: "cold_reactivation",
    updated_at: new Date(now).toISOString(),
  };
}