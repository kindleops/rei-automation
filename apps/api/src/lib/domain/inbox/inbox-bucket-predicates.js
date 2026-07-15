import {
  WAITING_REPLY_WINDOW_MS,
  isFailedDeliveryStatus,
  isOutboundLastWithoutReply,
  parseTimestampMs,
} from "@/lib/domain/inbox/resolve-waiting-cold-state.js";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function normalizeDirection(value) {
  const normalized = lower(value);
  if (normalized === "in" || normalized === "incoming") return "inbound";
  if (normalized === "out" || normalized === "outgoing") return "outbound";
  return normalized;
}

const CANCELLED_DELIVERY_STATUSES = new Set(["cancelled", "canceled", "cancelled_send", "send_cancelled"]);
const VALID_WAITING_DELIVERY_STATUSES = new Set([
  "",
  "sent",
  "delivered",
  "accepted",
  "queued",
  "pending",
  "sending",
  "submitted",
  "delivery_unknown",
]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function isArchivedThread(row = {}) {
  return row.is_archived === true;
}

export function isSuppressedContact(row = {}) {
  if (row.is_suppressed === true || row.opt_out === true) return true;
  const disposition = lower(row.disposition);
  if (disposition === "not_interested") return true;
  return lower(row.suppression_status) === "suppressed" || lower(row.inbox_bucket) === "suppressed";
}

export function isWrongNumberContact(row = {}) {
  if (row.wrong_number === true) return true;
  const disposition = lower(row.disposition);
  return disposition === "wrong_number" || disposition === "wrong_person";
}

export function isTerminalNoContactThread(row = {}) {
  const bucket = lower(row.inbox_bucket);
  if (["dead", "suppressed"].includes(bucket)) return true;
  return isWrongNumberContact(row) || isSuppressedContact(row);
}

export function isCancelledDeliveryStatus(status = "") {
  const normalized = lower(status);
  return CANCELLED_DELIVERY_STATUSES.has(normalized) || normalized.includes("cancel");
}

export function isValidWaitingDeliveryStatus(status = "") {
  const normalized = lower(status);
  if (!normalized) return true;
  if (isFailedDeliveryStatus(normalized) || isCancelledDeliveryStatus(normalized)) return false;
  if (VALID_WAITING_DELIVERY_STATUSES.has(normalized)) return true;
  return !normalized.includes("fail") && !normalized.includes("undeliver");
}

export function threadMatchesWaitingFacts(thread = {}, nowMs = Date.now()) {
  if (isArchivedThread(thread)) return false;
  if (isTerminalNoContactThread(thread)) return false;

  const direction = normalizeDirection(
    thread.latest_message_direction || thread.latest_direction || thread.direction,
  );
  if (direction !== "outbound") return false;

  const lastOut = thread.last_outbound_at || thread.lastOutboundAt || thread.latest_message_at;
  const lastIn = thread.last_inbound_at || thread.lastInboundAt;
  if (!isOutboundLastWithoutReply({ lastOutboundAt: lastOut, lastInboundAt: lastIn })) return false;

  const outMs = parseTimestampMs(lastOut);
  if (!outMs) return false;
  // Inclusive 24h boundary: sent_at >= now() - 24h  =>  (now - sent) <= 24h
  if ((nowMs - outMs) > WAITING_REPLY_WINDOW_MS) return false;

  const deliveryStatus = thread.latest_delivery_status
    || thread.latestDeliveryStatus
    || thread.delivery_status
    || thread.deliveryStatus
    || "";
  if (!isValidWaitingDeliveryStatus(deliveryStatus)) return false;

  const metadata = object(thread.metadata);
  if (metadata.terminal_no_contact === true || metadata.do_not_contact === true) return false;

  return true;
}

export function threadMatchesAllMessagesFacts(thread = {}, nowMs = Date.now()) {
  if (isArchivedThread(thread)) return false;
  return !threadMatchesWaitingFacts(thread, nowMs);
}

export function threadMatchesNewRepliesFacts(thread = {}, nowMs = Date.now()) {
  if (isArchivedThread(thread)) return false;
  if (isTerminalNoContactThread(thread)) return false;

  const bucket = lower(thread.inbox_bucket);
  if (["priority", "needs_review", "waiting", "cold"].includes(bucket)) return false;

  if (bucket === "new_replies" && !isStaleExplicitInboxBucket(thread, "new_replies", nowMs)) {
    return true;
  }

  const direction = normalizeDirection(
    thread.latest_message_direction || thread.latest_direction || thread.direction,
  );
  if (direction !== "inbound") return false;
  if (Number(thread.pending_queue_count || 0) > 0) return false;

  const lastOut = thread.last_outbound_at || thread.lastOutboundAt;
  const lastIn = thread.last_inbound_at || thread.lastInboundAt || thread.latest_message_at;
  const inMs = parseTimestampMs(lastIn);
  const outMs = parseTimestampMs(lastOut);
  if (!inMs) return false;
  if (outMs > 0 && inMs < outMs) return false;

  if (thread.needs_review === true || bucket === "needs_review") return false;
  return true;
}

export function isStaleExplicitInboxBucket(row = {}, explicitBucket = "", nowMs = Date.now()) {
  const explicit = lower(explicitBucket || row.inbox_bucket);
  if (!explicit) return false;

  const direction = normalizeDirection(
    row.latest_message_direction || row.latest_direction || row.direction,
  );
  const lastOut = row.last_outbound_at || row.lastOutboundAt;
  const lastIn = row.last_inbound_at || row.lastInboundAt || row.latest_message_at;

  if (explicit === "new_replies") {
    if (direction !== "inbound") return true;
    const inMs = parseTimestampMs(lastIn);
    const outMs = parseTimestampMs(lastOut);
    if (!inMs) return true;
    if (outMs > 0 && inMs < outMs) return true;
    if (isTerminalNoContactThread(row)) return true;
  }

  if (explicit === "waiting") {
    return !threadMatchesWaitingFacts(row, nowMs);
  }

  return false;
}

export function threadMatchesBucketFilter(thread = {}, filter = "all", nowMs = Date.now()) {
  const bucket = lower(thread.inbox_bucket);
  const direction = normalizeDirection(thread.latest_message_direction || thread.latest_direction || thread.direction);

  switch (filter) {
    case "all":
    case "all_messages":
      return threadMatchesAllMessagesFacts(thread, nowMs);
    case "priority":
      if (isArchivedThread(thread) || isTerminalNoContactThread(thread)) return false;
      return bucket === "priority";
    case "new_replies":
      return threadMatchesNewRepliesFacts(thread, nowMs);
    case "needs_review":
      if (isArchivedThread(thread)) return false;
      if (bucket === "needs_review") return true;
      return thread.needs_review === true;
    case "follow_up":
      if (isArchivedThread(thread)) return false;
      return bucket === "follow_up";
    case "cold":
      if (isArchivedThread(thread) || isTerminalNoContactThread(thread)) return false;
      if (bucket === "cold" || lower(thread.automation_lane) === "cold_reactivation") return true;
      {
        const lastOut = thread.last_outbound_at || thread.lastOutboundAt;
        const lastIn = thread.last_inbound_at || thread.lastInboundAt;
        if (!isOutboundLastWithoutReply({ lastOutboundAt: lastOut, lastInboundAt: lastIn })) return false;
        const outMs = parseTimestampMs(lastOut);
        if (!outMs) return false;
        return (nowMs - outMs) > WAITING_REPLY_WINDOW_MS;
      }
    case "dead":
      return bucket === "dead" || isWrongNumberContact(thread) || lower(thread.disposition) === "not_interested" || thread.not_interested === true;
    case "suppressed":
      return bucket === "suppressed" || isSuppressedContact(thread);
    case "active":
      if (isArchivedThread(thread) || isTerminalNoContactThread(thread)) return false;
      return ["priority", "new_replies", "needs_review", "follow_up"].includes(bucket);
    case "waiting":
      return threadMatchesWaitingFacts(thread, nowMs);
    case "unlinked":
      return !thread.property_id;
    default:
      return true;
  }
}