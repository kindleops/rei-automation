import {
  WAITING_REPLY_WINDOW_MS,
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
    if (row.opt_out || row.wrong_number || row.not_interested || row.is_suppressed === true) {
      return true;
    }
  }

  if (explicit === "waiting") {
    if (!isOutboundLastWithoutReply({ lastOutboundAt: lastOut, lastInboundAt: lastIn })) return true;
    const outMs = parseTimestampMs(lastOut);
    if (!outMs) return true;
    if ((nowMs - outMs) > WAITING_REPLY_WINDOW_MS) return true;
  }

  return false;
}

export function threadMatchesBucketFilter(thread = {}, filter = "all", nowMs = Date.now()) {
  const bucket = lower(thread.inbox_bucket);
  const direction = normalizeDirection(thread.latest_message_direction || thread.direction);

  switch (filter) {
    case "all":
      return true;
    case "priority":
      return bucket === "priority";
    case "new_replies":
      if (["dead", "suppressed"].includes(bucket)) return false;
      if (normalizeDirection(thread.latest_message_direction || thread.direction) !== "inbound") return false;
      if (Number(thread.pending_queue_count || 0) > 0) return false;
      {
        const lastOut = thread.last_outbound_at || thread.lastOutboundAt;
        const lastIn = thread.last_inbound_at || thread.lastInboundAt || thread.latest_message_at;
        const inMs = parseTimestampMs(lastIn);
        const outMs = parseTimestampMs(lastOut);
        if (!inMs) return false;
        if (outMs > 0 && inMs < outMs) return false;
      }
      {
        const notReadOrActioned = thread.is_read !== true && !thread.is_actioned;
        const notTerminal = !thread.opt_out && !thread.wrong_number && !thread.not_interested && thread.is_suppressed !== true;
        return notReadOrActioned && notTerminal;
      }
    case "needs_review":
      return bucket === "needs_review" || thread.needs_review === true;
    case "follow_up":
      return bucket === "follow_up";
    case "cold":
      if (["dead", "suppressed"].includes(bucket)) return false;
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
      return bucket === "dead" || thread.wrong_number === true || thread.not_interested === true;
    case "suppressed":
      return bucket === "suppressed" || thread.opt_out === true || lower(thread.suppression_status) === "suppressed";
    case "active":
      return ["priority", "new_replies", "needs_review", "follow_up"].includes(bucket);
    case "waiting":
      if (["dead", "suppressed"].includes(bucket)) return false;
      {
        const lastOut = thread.last_outbound_at || thread.lastOutboundAt || thread.latest_message_at;
        const lastIn = thread.last_inbound_at || thread.lastInboundAt;
        if (!isOutboundLastWithoutReply({ lastOutboundAt: lastOut, lastInboundAt: lastIn })) return false;
        const outMs = parseTimestampMs(lastOut);
        if (!outMs) return false;
        return (nowMs - outMs) <= WAITING_REPLY_WINDOW_MS;
      }
    case "unlinked":
      return !thread.property_id;
    default:
      return true;
  }
}