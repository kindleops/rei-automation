import { createHash } from "node:crypto";

import { normalizeTextGridFailure } from "./textgrid-failure-normalization.js";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function safeRate(numerator, denominator) {
  return Number(((numerator / Math.max(denominator, 1)) * 100).toFixed(1));
}

function isDeliveredStatus(value) {
  return lower(value) === "delivered";
}

function isFailedStatus(value) {
  return ["failed", "undelivered", "rejected", "error", "delivery_failed"].includes(lower(value));
}

function isAcceptedOutbound(row) {
  if (lower(row.direction) !== "outbound") return false;
  const provider = lower(row.provider_delivery_status);
  const delivery = lower(row.delivery_status);
  if (isDeliveredStatus(provider) || isDeliveredStatus(delivery)) return true;
  if (isFailedStatus(provider) || isFailedStatus(delivery)) return true;
  return ["sent", "accepted", "queued", "sending"].includes(provider) ||
    ["sent", "queued", "sending", "accepted"].includes(delivery);
}

function isOutboundFailure(row) {
  const normalized = normalizeTextGridFailure(row);
  return Boolean(
    normalized.failure_class ||
      isFailedStatus(row.provider_delivery_status) ||
      isFailedStatus(row.delivery_status) ||
      row.is_final_failure === true
  );
}

function senderFromMessage(row = {}) {
  if (lower(row.direction) === "inbound") return clean(row.to_phone_number);
  return clean(row.from_phone_number) ||
    clean(row.metadata?.from_phone_number) ||
    clean(row.metadata?.textgrid_number) ||
    clean(row.textgrid_number_id) ||
    "unknown";
}

function senderFromQueue(row = {}) {
  return clean(row.from_phone_number) ||
    clean(row.textgrid_number) ||
    clean(row.metadata?.from_phone_number) ||
    clean(row.metadata?.selected_textgrid_number) ||
    clean(row.textgrid_number_id) ||
    "unknown";
}

function marketFrom(row = {}) {
  return clean(row.market || row.metadata?.market);
}

function bodyFrom(row = {}) {
  return clean(row.message_body || row.message_text || row.rendered_message);
}

function hashBody(body) {
  const normalized = clean(body).replace(/\s+/g, " ");
  if (!normalized) return null;
  return createHash("sha256").update(normalized).digest("hex");
}

function ensure(map, sender) {
  const key = clean(sender) || "unknown";
  if (!map.has(key)) {
    map.set(key, {
      sender: key,
      sent_count: 0,
      delivered_count: 0,
      failed_count: 0,
      inbound_reply_count: 0,
      opt_out_count: 0,
      content_filter_count: 0,
      invalid_to_count: 0,
      recipient_out_of_credit_count: 0,
      last_delivered_at: null,
      last_failed_at: null,
      markets_used: new Set(),
      top_blocked_body_hashes: new Map(),
    });
  }
  return map.get(key);
}

function addBlockedBodyHash(entry, row, failure_class) {
  const hash = hashBody(bodyFrom(row));
  if (!hash) return;
  const current = entry.top_blocked_body_hashes.get(hash) || {
    hash,
    failure_class,
    count: 0,
  };
  current.count += 1;
  entry.top_blocked_body_hashes.set(hash, current);
}

function newerTimestamp(current, candidate) {
  const currentTime = current ? new Date(current).getTime() : 0;
  const candidateText = clean(candidate);
  const candidateTime = candidateText ? new Date(candidateText).getTime() : 0;
  if (!Number.isFinite(candidateTime) || candidateTime <= currentTime) return current;
  return candidateText;
}

function applyFailureClass(entry, row, failure_class) {
  if (failure_class === "content_filter_blocked") entry.content_filter_count += 1;
  if (failure_class === "recipient_opted_out") entry.opt_out_count += 1;
  if (failure_class === "invalid_to_number") entry.invalid_to_count += 1;
  if (failure_class === "recipient_out_of_credit") entry.recipient_out_of_credit_count += 1;
  if (failure_class === "content_filter_blocked") addBlockedBodyHash(entry, row, failure_class);
}

export function buildTextGridSenderHealth(messageRows = [], queueRows = []) {
  const bySender = new Map();
  const eventQueueIds = new Set();

  for (const row of messageRows) {
    const direction = lower(row.direction);
    if (direction === "outbound") {
      const sender = senderFromMessage(row);
      const entry = ensure(bySender, sender);
      const normalizedFailure = normalizeTextGridFailure(row);
      const failed = isOutboundFailure(row);
      const accepted = isAcceptedOutbound(row);

      if (clean(row.queue_id || row.metadata?.queue_id)) {
        eventQueueIds.add(clean(row.queue_id || row.metadata?.queue_id));
      }

      if (accepted || failed) entry.sent_count += 1;
      if (isDeliveredStatus(row.provider_delivery_status) || isDeliveredStatus(row.delivery_status)) {
        entry.delivered_count += 1;
        entry.last_delivered_at = newerTimestamp(
          entry.last_delivered_at,
          row.delivered_at || row.updated_at || row.created_at
        );
      }
      if (failed) {
        entry.failed_count += 1;
        entry.last_failed_at = newerTimestamp(
          entry.last_failed_at,
          row.failed_at || row.updated_at || row.created_at
        );
      }
      applyFailureClass(entry, row, normalizedFailure.failure_class);

      const market = marketFrom(row);
      if (market) entry.markets_used.add(market);
      continue;
    }

    if (direction === "inbound") {
      const sender = senderFromMessage(row);
      if (!sender || !bySender.has(sender)) continue;
      const entry = bySender.get(sender);
      entry.inbound_reply_count += 1;
      if (row.is_opt_out === true || lower(row.detected_intent) === "opt_out") {
        entry.opt_out_count += 1;
      }
    }
  }

  for (const row of queueRows) {
    const rowId = clean(row.id);
    if (rowId && eventQueueIds.has(rowId)) continue;

    const normalizedFailure = normalizeTextGridFailure(row);
    if (!normalizedFailure.failure_class || normalizedFailure.failure_class === "unknown_failure") continue;

    const entry = ensure(bySender, senderFromQueue(row));
    entry.sent_count += 1;
    entry.failed_count += 1;
    entry.last_failed_at = newerTimestamp(
      entry.last_failed_at,
      row.failed_at || row.updated_at || row.created_at
    );
    applyFailureClass(entry, row, normalizedFailure.failure_class);

    const market = marketFrom(row);
    if (market) entry.markets_used.add(market);
  }

  return [...bySender.values()]
    .map((entry) => ({
      ...entry,
      markets_used: [...entry.markets_used].sort(),
      top_blocked_body_hashes: [...entry.top_blocked_body_hashes.values()]
        .sort((a, b) => b.count - a.count || a.hash.localeCompare(b.hash))
        .slice(0, 5),
      delivery_rate: safeRate(entry.delivered_count, entry.sent_count),
      failure_rate: safeRate(entry.failed_count, entry.sent_count),
      reply_rate: safeRate(entry.inbound_reply_count, entry.delivered_count),
      opt_out_rate: safeRate(entry.opt_out_count, entry.delivered_count),
      content_filter_rate: safeRate(entry.content_filter_count, entry.sent_count),
    }))
    .filter((entry) => entry.sent_count > 0)
    .sort((a, b) => b.sent_count - a.sent_count);
}

export default buildTextGridSenderHealth;
