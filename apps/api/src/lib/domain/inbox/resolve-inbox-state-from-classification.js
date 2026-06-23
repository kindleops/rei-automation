import {
  isFailedDeliveryStatus,
  resolveOutboundReplyState,
} from "@/lib/domain/inbox/resolve-waiting-cold-state.js";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

export function resolveThreadFlagsFromClassification(classification = {}) {
  const primary = clean(classification.primary_intent);
  const objection = clean(classification.objection);
  const compliance = clean(classification.compliance_flag);
  const disposition = lower(classification.disposition);

  const opt_out =
    classification.opt_out === true ||
    classification.is_suppressed === true ||
    compliance === "stop_texting" ||
    primary === "opt_out" ||
    disposition === "suppressed" ||
    disposition === "opt_out";
  const wrong_number =
    classification.wrong_number === true ||
    primary === "wrong_number" ||
    objection === "wrong_number" ||
    disposition === "wrong_number";
  const not_interested =
    primary === "property_correction"
      ? false
      : (
        classification.not_interested === true ||
        primary === "not_interested" ||
        objection === "not_interested" ||
        disposition === "not_interested"
      );

  return {
    opt_out,
    wrong_number,
    not_interested,
  };
}

export function resolveUniversalStatusFromClassification(classification = {}, messageEvent = {}, existingState = {}) {
  const flags = resolveThreadFlagsFromClassification(classification);
  const primary = clean(classification.primary_intent);
  const objection = clean(classification.objection);
  const direction = clean(messageEvent.direction).toLowerCase();
  const existingStatus = existingState.universal_status || existingState.status || "";

  // Enforce terminal states persistently on outbound
  if (direction === "outbound") {
    if (existingStatus === "dead" || existingState.wrong_number || existingState.not_interested) {
      return { universal_status: "dead", universal_stage: existingState.universal_stage || "dead" };
    }
    if (existingStatus === "suppressed" || existingState.opt_out) {
      return { universal_status: "suppressed", universal_stage: existingState.universal_stage || "suppressed" };
    }
    return {
      universal_status: "awaiting_response",
      universal_stage: "awaiting_response"
    };
  }

  // Suppression logic
  if (flags.opt_out) {
    return {
      universal_status: "suppressed",
      universal_stage: "suppressed"
    };
  }

  if (flags.wrong_number) {
    return {
      universal_status: "dead",
      universal_stage: "wrong_number"
    };
  }

  if (flags.not_interested) {
    return {
      universal_status: "dead",
      universal_stage: "not_interested"
    };
  }

  // Active intents
  const priority_intents = [
    "seller_interested",
    "asking_price_provided",
    "asks_offer",
    "callback_requested",
    "latent_interest"
  ];
  const priority_objections = [
    "send_offer_first",
    "need_more_money",
    "needs_call",
    "wants_written_offer",
    "wants_proof_of_funds"
  ];

  if (priority_intents.includes(primary) || priority_objections.includes(objection)) {
    return {
      universal_status: "active",
      universal_stage: classification.stage_hint || "active"
    };
  }

  if (primary === "who_is_this") {
    return {
      universal_status: "active",
      universal_stage: "identity_question"
    };
  }

  if (primary === "need_time") {
    return {
      universal_status: "follow_up",
      universal_stage: "follow_up"
    };
  }

  if (primary === "tenant_occupied" || primary === "condition_disclosed") {
    return {
      universal_status: "active",
      universal_stage: classification.stage_hint || "Q/A"
    };
  }

  if (primary === "property_correction") {
    return {
      universal_status: "needs_review",
      universal_stage: "property_correction"
    };
  }

  // Unclear inbound replies stay in the automation lane until a true exception is detected.
  return {
    universal_status: "active",
    universal_stage: classification.stage_hint || "new_reply"
  };
}

const PRIORITY_INTENTS = [
  "seller_interested",
  "asking_price_provided",
  "asks_offer",
  "callback_requested",
  "latent_interest",
  "ownership_confirmed",
];

const PRIORITY_OBJECTIONS = [
  "send_offer_first",
  "need_more_money",
  "needs_call",
  "wants_written_offer",
  "wants_proof_of_funds",
];

const OPERATOR_EXCEPTION_INTENTS = new Set([
  "property_correction",
  "hostile_or_legal",
  "identity_conflict",
  "legal_exception",
  "compliance_exception",
]);

const NEW_REPLY_INTENTS = [
  "who_is_this",
  "condition_disclosed",
  "tenant_occupied",
  "need_time",
];

function isOperatorEscalation(classification = {}) {
  const decision = classification.automation_decision || {};
  return (
    decision.human_review_required === true &&
    (decision.operator_escalation === true || decision.escalation_policy === "operator_exception")
  );
}

function isSystemFailureException(classification = {}) {
  const decision = classification.automation_decision || {};
  const reasonCodes = Array.isArray(decision.reason_codes)
    ? decision.reason_codes.map((code) => lower(code))
    : [];
  return (
    decision.system_failure === true ||
    decision.retry_exhausted === true ||
    reasonCodes.includes("retry_exhausted") ||
    reasonCodes.includes("system_failure")
  );
}

function normalizeLegacyBucket(bucket = "") {
  const normalized = clean(bucket).toLowerCase();
  if (normalized === "waiting_on_seller") return "waiting";
  return normalized;
}

function shouldRouteToNeedsReview(classification = {}) {
  const primary = clean(classification.primary_intent);
  const compliance = clean(classification.compliance_flag);

  if (OPERATOR_EXCEPTION_INTENTS.has(primary)) return true;
  if (classification.needs_review === true && (OPERATOR_EXCEPTION_INTENTS.has(primary) || isOperatorEscalation(classification))) {
    return true;
  }
  if (compliance === "legal_hold" || compliance === "compliance_exception") return true;
  if (isOperatorEscalation(classification)) return true;
  if (isSystemFailureException(classification)) return true;

  return false;
}

export function deriveInboxBucketFromThreadState(row = {}) {
  const explicit = normalizeLegacyBucket(row.inbox_bucket || row.inbox_category || "");
  if (explicit) return explicit;

  if (row.is_suppressed === true || lower(row.disposition) === "suppressed") return "suppressed";
  if (lower(row.disposition) === "wrong_number") return "dead";
  if (lower(row.disposition) === "not_interested") return "dead";

  const classification = {
    primary_intent: row.last_intent || row.primary_intent || row.detected_intent || null,
    objection: row.objection || null,
    compliance_flag: row.compliance_flag || null,
    confidence: row.confidence ?? null,
    needs_review: row.needs_review === true,
    automation_decision: row.metadata?.automation_decision || row.automation_decision || null,
  };

  const messageEvent = {
    direction: row.latest_direction || row.latest_message_direction || null,
    sent_at: row.last_outbound_at || null,
    received_at: row.last_inbound_at || null,
    delivery_status: row.latest_delivery_status || null,
    provider_delivery_status: row.latest_provider_delivery_status || null,
  };

  const bucket = resolveInboxBucketFromClassification(classification, messageEvent, row);
  if (bucket) return bucket;
  if (hasExplicitColdEvidence(row)) return "cold";
  return null;
}

function hasExplicitColdEvidence(row = {}) {
  if (lower(row.automation_lane) !== "cold_reactivation") return false;
  const stage = lower(row.stage || row.status || "");
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return (
    stage.includes("cold")
    || stage === "nurture"
    || metadata.cold_campaign === true
    || metadata.automation_lane === "cold_reactivation"
  );
}

export function resolveInboxBucketFromClassification(classification = {}, messageEvent = {}, existingState = {}) {
  const direction = clean(messageEvent.direction).toLowerCase();
  const is_outbound = direction === "outbound";
  const inboundFlags = resolveThreadFlagsFromClassification(classification);
  const existingFlags = resolveThreadFlagsFromClassification(existingState);
  const flags = {
    opt_out: inboundFlags.opt_out || existingFlags.opt_out,
    wrong_number: inboundFlags.wrong_number || existingFlags.wrong_number,
    not_interested: inboundFlags.not_interested || existingFlags.not_interested,
  };
  const primary = is_outbound
    ? clean(existingState.primary_intent || classification.primary_intent)
    : clean(classification.primary_intent || existingState.primary_intent);
  const objection = is_outbound
    ? clean(existingState.objection || classification.objection)
    : clean(classification.objection || existingState.objection);

  const existingStatus = existingState.universal_status || existingState.status || "";
  const existingBucket = normalizeLegacyBucket(existingState.inbox_bucket || existingState.inbox_category || "");
  const disposition = lower(existingState.disposition || "");
  const reasonCodes = Array.isArray(existingState.reason_codes)
    ? existingState.reason_codes.map((code) => lower(code))
    : [];

  if (
    flags.opt_out ||
    existingStatus === "suppressed" ||
    existingBucket === "suppressed" ||
    disposition === "suppressed" ||
    disposition === "opt_out" ||
    disposition === "off" ||
    reasonCodes.includes("opt_out")
  ) {
    return "suppressed";
  }
  if (
    flags.wrong_number ||
    disposition === "wrong_number" ||
    reasonCodes.includes("wrong_number")
  ) {
    return null;
  }

  if (
    flags.not_interested ||
    existingStatus === "dead" ||
    existingBucket === "dead" ||
    disposition === "dead" ||
    disposition === "not_interested" ||
    reasonCodes.includes("not_interested")
  ) {
    return null;
  }

  if (is_outbound) {
    const outboundState = resolveOutboundReplyState({
      lastOutboundAt:
        messageEvent.sent_at ||
        messageEvent.received_at ||
        existingState.last_outbound_at ||
        existingState.latest_message_at,
      lastInboundAt: existingState.last_inbound_at,
      latestDeliveryStatus:
        messageEvent.delivery_status ||
        messageEvent.provider_delivery_status ||
        existingState.latest_delivery_status,
      workflowRow: existingState,
    });
    return outboundState.inbox_bucket;
  }

  if (PRIORITY_INTENTS.includes(primary) || PRIORITY_OBJECTIONS.includes(objection)) {
    return "priority";
  }

  if (shouldRouteToNeedsReview(classification)) {
    return "needs_review";
  }

  if (NEW_REPLY_INTENTS.includes(primary)) {
    return "new_replies";
  }

  return "new_replies";
}

export function resolveAutomationLaneFromClassification(
  classification = {},
  messageEvent = {},
  existingState = {},
  inbox_bucket = null,
) {
  const direction = clean(messageEvent.direction).toLowerCase();
  const inboundFlags = resolveThreadFlagsFromClassification(classification);
  const existingFlags = resolveThreadFlagsFromClassification(existingState);
  const flags = {
    opt_out: inboundFlags.opt_out || existingFlags.opt_out,
    wrong_number: inboundFlags.wrong_number || existingFlags.wrong_number,
    not_interested: inboundFlags.not_interested || existingFlags.not_interested,
  };

  if (flags.opt_out || lower(inbox_bucket) === "suppressed") return null;

  if (flags.wrong_number || flags.not_interested) return "disqualified";

  const deliveryStatus = clean(
    messageEvent.delivery_status ||
    messageEvent.provider_delivery_status ||
    existingState.latest_delivery_status,
  );
  if (direction === "outbound" && isFailedDeliveryStatus(deliveryStatus)) {
    return "delivery_recovery";
  }

  if (direction === "outbound") {
    const outboundState = resolveOutboundReplyState({
      lastOutboundAt:
        messageEvent.sent_at ||
        messageEvent.received_at ||
        existingState.last_outbound_at ||
        existingState.latest_message_at,
      lastInboundAt: existingState.last_inbound_at,
      latestDeliveryStatus: deliveryStatus,
    });
    return outboundState.automation_lane;
  }

  if (["priority", "new_replies"].includes(lower(inbox_bucket))) {
    return "active_conversation";
  }

  if (lower(inbox_bucket) === "needs_review") return "manual_review";

  return existingState.automation_lane || null;
}

export function resolveDispositionFromClassification(
  classification = {},
  messageEvent = {},
  existingState = {},
  inbox_bucket = null,
) {
  const inboundFlags = resolveThreadFlagsFromClassification(classification);
  const existingFlags = resolveThreadFlagsFromClassification(existingState);
  const flags = {
    opt_out: inboundFlags.opt_out || existingFlags.opt_out,
    wrong_number: inboundFlags.wrong_number || existingFlags.wrong_number,
    not_interested: inboundFlags.not_interested || existingFlags.not_interested,
  };

  if (flags.opt_out || lower(inbox_bucket) === "suppressed") return "suppressed";
  if (flags.wrong_number) return "wrong_number";
  if (flags.not_interested) return "not_interested";
  if (["priority", "new_replies", "needs_review", "waiting"].includes(lower(inbox_bucket))) {
    return null;
  }
  return existingState.disposition || null;
}

export function buildThreadStatePatchFromClassification({ messageEvent = {}, classification = {}, existingState = {} }) {
  const direction = clean(messageEvent.direction).toLowerCase();
  const is_inbound = direction === "inbound";
  
  // Use the new single-source-of-truth resolvers
  const flags = is_inbound ? resolveThreadFlagsFromClassification(classification) : resolveThreadFlagsFromClassification(existingState);
  const statuses = resolveUniversalStatusFromClassification(is_inbound ? classification : {}, messageEvent, existingState);
  const bucket = resolveInboxBucketFromClassification(is_inbound ? classification : {}, messageEvent, existingState);

  const patch = {
    latest_message_id: messageEvent.id || messageEvent.provider_message_sid,
    latest_message_at: messageEvent.received_at || messageEvent.sent_at || messageEvent.event_timestamp || new Date().toISOString(),
    latest_message_body: messageEvent.message_body || messageEvent.message,
    latest_message_direction: direction,
    latest_direction: direction,
    latest_delivery_status: clean(
      messageEvent.delivery_status ||
      messageEvent.provider_delivery_status ||
      messageEvent.raw_carrier_status ||
      (direction === "inbound" ? "delivered" : "")
    ) || null,
    latest_provider_delivery_status: clean(messageEvent.provider_delivery_status) || null,
    latest_failed_at: messageEvent.failed_at || null,
    latest_failure_reason: clean(messageEvent.failure_reason) || null,
    updated_at: new Date().toISOString(),
  };

  // Only overlay classification results if it was an inbound message and we have classification
  if (is_inbound && classification && Object.keys(classification).length > 0) {
    patch.primary_intent = classification.primary_intent || null;
    patch.detected_intent = classification.detected_intent || classification.primary_intent || null;
    patch.objection = classification.objection || null;
    patch.emotion = classification.emotion || null;
    patch.language = classification.language || null;
    patch.compliance_flag = classification.compliance_flag || null;
    patch.positive_signals = classification.positive_signals || null;
    patch.motivation_score = classification.motivation_score || null;
    
    // Explicit flags
    patch.opt_out = flags.opt_out;
    patch.wrong_number = flags.wrong_number;
    patch.not_interested = flags.not_interested;
    patch.needs_review = statuses.universal_status === "needs_review" || patch.primary_intent === "property_correction";
  }

  // Canonical states
  patch.universal_status = statuses.universal_status;
  patch.universal_stage = statuses.universal_stage;
  patch.inbox_bucket = bucket;
  patch.inbox_category = bucket;
  patch.resolved_inbox_bucket = bucket;
  patch.automation_lane = resolveAutomationLaneFromClassification(
    is_inbound ? classification : existingState,
    messageEvent,
    existingState,
    bucket,
  );
  patch.disposition = resolveDispositionFromClassification(
    is_inbound ? classification : existingState,
    messageEvent,
    existingState,
    bucket,
  );

  if (is_inbound && classification?.seller_state?.lead_temperature) {
    patch.lead_temperature = classification.seller_state.lead_temperature;
  }

  return patch;
}
