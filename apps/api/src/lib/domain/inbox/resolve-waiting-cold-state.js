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

export function resolveOutboundReplyState({
  lastOutboundAt,
  lastInboundAt,
  latestDeliveryStatus,
  now = Date.now(),
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
  const ageMs = now - outboundMs;
  if (ageMs <= WAITING_REPLY_WINDOW_MS) {
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
  return coldState.automation_lane === "cold_reactivation";
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