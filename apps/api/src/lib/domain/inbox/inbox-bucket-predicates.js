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
      if (!isOutboundLastWithoutReply({
        lastOutboundAt: thread.last_outbound_at || thread.lastOutboundAt,
        lastInboundAt: thread.last_inbound_at || thread.lastInboundAt || thread.latest_message_at,
      })) return false;
      if (bucket === "new_replies") return true;
      {
        const inMs = parseTimestampMs(thread.last_inbound_at || thread.latest_message_at);
        if (!inMs) return false;
        const notReadOrActioned = thread.is_read !== true && !thread.is_actioned;
        const notTerminal = !thread.opt_out && !thread.wrong_number && !thread.not_interested && thread.is_suppressed !== true;
        return notReadOrActioned && notTerminal;
      }
    case "needs_review":
      return bucket === "needs_review" || thread.needs_review === true;
    case "follow_up":
      return bucket === "follow_up";
    case "cold":
      return bucket === "cold" || lower(thread.automation_lane) === "cold_reactivation";
    case "dead":
      return bucket === "dead" || thread.wrong_number === true || thread.not_interested === true;
    case "suppressed":
      return bucket === "suppressed" || thread.opt_out === true || lower(thread.suppression_status) === "suppressed";
    case "active":
      return ["priority", "new_replies", "needs_review", "follow_up"].includes(bucket);
    case "waiting":
      if (["dead", "suppressed"].includes(bucket)) return false;
      if (bucket === "waiting") return true;
      {
        const lastOut = thread.last_outbound_at || thread.lastOutboundAt || thread.latest_message_at;
        const lastIn = thread.last_inbound_at || thread.lastInboundAt;
        const outMs = parseTimestampMs(lastOut);
        if (!outMs) return false;
        const ageOk = (nowMs - outMs) <= WAITING_REPLY_WINDOW_MS;
        const noNewerInbound = isOutboundLastWithoutReply({ lastOutboundAt: lastOut, lastInboundAt: lastIn });
        return (direction === "outbound" || noNewerInbound) && ageOk;
      }
    case "unlinked":
      return !thread.property_id;
    default:
      return true;
  }
}