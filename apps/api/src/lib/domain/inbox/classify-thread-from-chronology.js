import { classify } from "@/lib/domain/classification/classify.js";
import { buildThreadStatePatchFromClassification } from "@/lib/domain/inbox/resolve-inbox-state-from-classification.js";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function eventTime(event = {}) {
  const raw = event.received_at || event.sent_at || event.event_timestamp || event.created_at || 0;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function isRealMessageEvent(event = {}) {
  const from = clean(event.from_phone_number);
  const to = clean(event.to_phone_number);
  if (from && to && from === to) return false;

  const direction = lower(event.direction);
  if (direction !== "inbound" && direction !== "outbound") return false;

  return true;
}

export function sortMessageEventsChronologically(messages = []) {
  return [...messages].sort((a, b) => eventTime(b) - eventTime(a));
}

export function findPrecedingOutbound(sortedDesc = [], anchorEvent = null) {
  if (!anchorEvent) return null;
  const anchorTime = eventTime(anchorEvent);

  for (const message of sortedDesc) {
    if (lower(message.direction) !== "outbound") continue;
    if (eventTime(message) <= anchorTime) return message;
  }

  return null;
}

export function resolveDeliveryStatus(event = {}) {
  return clean(
    event.delivery_status ||
    event.provider_delivery_status ||
    event.raw_carrier_status ||
    (lower(event.direction) === "inbound" ? "delivered" : "")
  ) || null;
}

export function normalizeExistingInboxState(existingState = {}) {
  const disposition = lower(existingState.disposition);
  const reasonCodes = Array.isArray(existingState.reason_codes)
    ? existingState.reason_codes.map((code) => lower(code))
    : [];

  return {
    ...existingState,
    primary_intent: existingState.primary_intent || existingState.last_intent || null,
    wrong_number:
      existingState.wrong_number === true ||
      disposition === "wrong_number" ||
      reasonCodes.includes("wrong_number"),
    not_interested:
      existingState.not_interested === true ||
      disposition === "not_interested" ||
      reasonCodes.includes("not_interested"),
    opt_out:
      existingState.opt_out === true ||
      existingState.is_suppressed === true ||
      disposition === "suppressed" ||
      disposition === "opt_out" ||
      disposition === "off" ||
      reasonCodes.includes("opt_out"),
  };
}

function resolveDisposition(patch = {}, existingState = {}) {
  if (patch.inbox_bucket === "suppressed" || patch.opt_out) return "suppressed";
  if (patch.inbox_bucket === "dead" || patch.wrong_number || patch.not_interested) {
    if (patch.wrong_number || lower(existingState.disposition) === "wrong_number") return "wrong_number";
    return "not_interested";
  }
  if (["priority", "new_replies", "needs_review", "waiting", "cold", "follow_up"].includes(patch.inbox_bucket)) {
    return null;
  }
  return existingState.disposition || null;
}

function buildBrainItemFromContext({ precedingOutbound = null, conversationStage = null } = {}) {
  const fields = [];

  if (conversationStage) {
    fields.push({
      external_id: "conversation-stage",
      values: [{ value: conversationStage }],
    });
  }

  if (precedingOutbound?.stage_after || precedingOutbound?.stage_before) {
    fields.push({
      external_id: "conversation-stage",
      values: [{ value: precedingOutbound.stage_after || precedingOutbound.stage_before }],
    });
  }

  return fields.length ? { fields } : null;
}

function normalizeMessageEvent(event = {}) {
  return {
    id: event.id || event.provider_message_sid || event.message_id || null,
    provider_message_sid: event.provider_message_sid || event.message_id || null,
    direction: lower(event.direction),
    message_body: event.message_body || event.message || null,
    received_at: event.received_at || event.event_timestamp || event.created_at || null,
    sent_at: event.sent_at || event.created_at || null,
    delivery_status: resolveDeliveryStatus(event),
    provider_delivery_status: clean(event.provider_delivery_status) || null,
    failed_at: event.failed_at || null,
    failure_reason: event.failure_reason || null,
    from_phone_number: event.from_phone_number || null,
    to_phone_number: event.to_phone_number || null,
    stage_before: event.stage_before || null,
    stage_after: event.stage_after || null,
  };
}

export async function classifyThreadFromChronology(messages = [], options = {}) {
  const realMessages = (messages || []).filter(isRealMessageEvent);
  if (!realMessages.length) return null;

  const sortedDesc = sortMessageEventsChronologically(realMessages);
  const latest = normalizeMessageEvent(sortedDesc[0]);
  const inboundMsgs = sortedDesc
    .filter((message) => lower(message.direction) === "inbound")
    .map(normalizeMessageEvent);
  const outboundMsgs = sortedDesc
    .filter((message) => lower(message.direction) === "outbound")
    .map(normalizeMessageEvent);
  const latestInbound = inboundMsgs[0] || null;

  const existingState = normalizeExistingInboxState(options.existingState || {});
  let classification = {};
  let classifiedState = existingState;

  if (latestInbound) {
    const precedingOutbound = findPrecedingOutbound(sortedDesc, latestInbound);
    const brain_item = buildBrainItemFromContext({
      precedingOutbound,
      conversationStage: options.conversationStage || null,
    });

    classification = await classify(
      latestInbound.message_body || "",
      brain_item,
      { heuristicOnly: options.heuristicOnly === true },
    );
    classifiedState = buildThreadStatePatchFromClassification({
      messageEvent: latestInbound,
      classification,
      existingState,
    });
  }

  const patch = latest.direction === "outbound"
    ? buildThreadStatePatchFromClassification({
      messageEvent: latest,
      classification: {},
      existingState: classifiedState,
    })
    : classifiedState;

  const disposition = resolveDisposition(patch, existingState);

  const seller_phone = latest.direction === "inbound"
    ? latest.from_phone_number
    : latest.to_phone_number;
  const our_number = latest.direction === "inbound"
    ? latest.to_phone_number
    : latest.from_phone_number;

  return {
    ...patch,
    seller_phone,
    our_number,
    canonical_e164: seller_phone,
    message_count: realMessages.length,
    inbound_count: inboundMsgs.length,
    outbound_count: outboundMsgs.length,
    latest_message_event_id: latest.id,
    latest_message_body: latest.message_body,
    latest_message_at: latest.received_at || latest.sent_at || new Date().toISOString(),
    latest_message_direction: latest.direction,
    latest_direction: latest.direction,
    latest_delivery_status: latest.delivery_status,
    latest_provider_delivery_status: latest.provider_delivery_status,
    latest_failed_at: latest.failed_at,
    latest_failure_reason: latest.failure_reason,
    last_inbound_at: inboundMsgs[0]?.received_at || inboundMsgs[0]?.sent_at || null,
    last_outbound_at: outboundMsgs[0]?.sent_at || outboundMsgs[0]?.received_at || null,
    inbox_category: patch.inbox_bucket || null,
    detected_intent: patch.detected_intent || patch.primary_intent || null,
    reply_intent: patch.primary_intent || null,
    classification_confidence: classification.confidence ?? null,
    disposition,
    updated_at: new Date().toISOString(),
  };
}

export function patchToInboxThreadState(patch = {}, overrides = {}) {
  if (!patch || typeof patch !== "object") return {};

  const row = {
    thread_key: overrides.thread_key,
    seller_phone: patch.seller_phone || overrides.seller_phone,
    canonical_e164: patch.canonical_e164 || patch.seller_phone || overrides.canonical_e164,
    our_number: patch.our_number || overrides.our_number,
    master_owner_id: overrides.master_owner_id,
    prospect_id: overrides.prospect_id,
    property_id: overrides.property_id,
    market: overrides.market,
    message_count: patch.message_count,
    inbound_count: patch.inbound_count,
    outbound_count: patch.outbound_count,
    latest_message_event_id: patch.latest_message_event_id || patch.latest_message_id,
    latest_message_body: patch.latest_message_body,
    latest_message_at: patch.latest_message_at,
    latest_direction: patch.latest_direction || patch.latest_message_direction,
    latest_delivery_status: patch.latest_delivery_status,
    last_inbound_at: patch.last_inbound_at,
    last_outbound_at: patch.last_outbound_at,
    inbox_bucket: patch.inbox_bucket,
    last_intent: patch.detected_intent || patch.reply_intent || patch.primary_intent || overrides.last_intent,
    is_suppressed: patch.inbox_bucket === "suppressed" || patch.opt_out === true || overrides.is_suppressed,
    disposition: patch.disposition ?? overrides.disposition ?? null,
    updated_at: patch.updated_at || new Date().toISOString(),
  };

  if (overrides.is_read !== undefined) row.is_read = overrides.is_read;
  if (overrides.status !== undefined) row.status = overrides.status;
  if (overrides.stage !== undefined) row.stage = overrides.stage;
  if (overrides.priority !== undefined) row.priority = overrides.priority;
  if (overrides.automation_state !== undefined) row.automation_state = overrides.automation_state;
  if (overrides.increment_direction !== undefined) {
    row._increment_direction = overrides.increment_direction;
  }

  return row;
}