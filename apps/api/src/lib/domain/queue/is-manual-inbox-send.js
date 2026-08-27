function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function metadataValue(row = null, key = "") {
  const metadata =
    row && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata
      : {};
  return metadata[key];
}

export function isManualInboxSend(queue_item = null) {
  const queue_key = clean(
    queue_item?.queue_key ||
      queue_item?.queue_id ||
      metadataValue(queue_item, "queue_key") ||
      metadataValue(queue_item, "queue_id")
  );
  const message_type = lower(
    queue_item?.message_type || metadataValue(queue_item, "message_type")
  );
  const use_case_template = lower(
    queue_item?.use_case_template ||
      metadataValue(queue_item, "use_case_template") ||
      metadataValue(queue_item, "selected_use_case")
  );
  const action = lower(metadataValue(queue_item, "action"));
  const source = lower(metadataValue(queue_item, "source"));
  const created_from = lower(metadataValue(queue_item, "created_from"));

  return (
    queue_key.startsWith("inbox:send_now:") ||
    message_type === "manual_reply" ||
    use_case_template === "inbox_manual_send_now" ||
    action === "send_now" ||
    source === "inbox" ||
    source === "manual_inbox" ||
    created_from === "leadcommand_inbox"
  );
}

export function isUnknownAutoReply(queue_item = null) {
  const message_type = lower(
    queue_item?.message_type || metadataValue(queue_item, "message_type")
  );
  const use_case_template = lower(
    queue_item?.use_case_template ||
      metadataValue(queue_item, "use_case_template")
  );
  const source = lower(metadataValue(queue_item, "source"));
  const unknown_inbound = metadataValue(queue_item, "unknown_inbound") === true;

  const type = lower(queue_item?.type || metadataValue(queue_item, "type"));

  return (
    type === "auto_reply" ||
    use_case_template === "unknown_inbound_auto_reply" ||
    message_type === "unknown inbound auto reply" ||
    source === "textgrid_inbound_unknown_router" ||
    unknown_inbound === true
  );
}

// Shape check: identifies an autonomous reply generated in direct response to a
// consumer-initiated inbound message (the seller just texted us). The ONLY live
// producer that emits this shape is the seller-flow immediate reply
// (apply-inbound-automation-decision: queue_key "inbound_auto_reply:<...>",
// type "auto_reply", metadata.source "auto_reply"). Other auto_reply producers
// use different keys/sources and do NOT match: the acquisition inbound
// dispatcher uses "acq-inbound:" + source "default_acquisition_inbound_dispatcher",
// seller stage replies route through queue_message.js (sha256 key + source
// "queue_message"), and the no-reply follow-up scheduler uses type "followup" +
// "acq-followup:". Outbound campaigns/nurture/manual sends never match. This is
// a shape predicate only; quiet-hours exemption additionally requires freshness
// (see isImmediateInboundAutoReply).
export function isInboundAutoReply(queue_item = null) {
  const queue_key = clean(
    queue_item?.queue_key ||
      queue_item?.queue_id ||
      metadataValue(queue_item, "queue_key") ||
      metadataValue(queue_item, "queue_id")
  );
  const type = lower(queue_item?.type || metadataValue(queue_item, "type"));
  const source = lower(metadataValue(queue_item, "source"));

  return (
    queue_key.startsWith("inbound_auto_reply:") ||
    (type === "auto_reply" &&
      (source === "auto_reply" ||
        source === "textgrid_inbound_unknown_router"))
  );
}

// Max age for an inbound auto-reply to still count as IMMEDIATE (and thus
// quiet-hours exempt). A shape-matched reply that has aged out — paused queue,
// deep retry backoff — is no longer a prompt response to a just-received
// message, so it must respect the outbound quiet-hours window and defer to the
// next open window instead of firing arbitrarily deep in the night.
export const IMMEDIATE_INBOUND_REPLY_MAX_AGE_MS = 60 * 60 * 1000; // 60 minutes

// Quiet-hours exemption predicate: an inbound auto-reply is exempt ONLY when it
// is both the right shape AND fresh (dispatched close to when the consumer
// texted). Anchored on the row's created_at (DB-default populated at insert,
// ~60s after the inbound). Fails CLOSED (not exempt) if no parseable timestamp,
// so a malformed row defers rather than sends outside the window.
export function isImmediateInboundAutoReply(
  queue_item = null,
  now = null,
  maxAgeMs = IMMEDIATE_INBOUND_REPLY_MAX_AGE_MS
) {
  if (!isInboundAutoReply(queue_item)) return false;

  const anchor = clean(
    queue_item?.created_at ||
      metadataValue(queue_item, "created_at") ||
      metadataValue(queue_item, "inbound_received_at") ||
      metadataValue(queue_item, "authorized_received_at")
  );
  const created_ms = Date.parse(anchor);
  const now_ms = now ? Date.parse(clean(now)) : Date.now();
  if (!Number.isFinite(created_ms) || !Number.isFinite(now_ms)) return false;

  const age_ms = now_ms - created_ms;
  return age_ms >= 0 && age_ms <= maxAgeMs;
}

export default isManualInboxSend;
