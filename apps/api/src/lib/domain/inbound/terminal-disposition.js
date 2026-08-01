// ─── terminal-disposition.js ─────────────────────────────────────────────────
// Canonical terminal dispositions for inbound processing. Launch invariant:
// EVERY inbound event reaches exactly one of these — there is no other legal
// way for inbound processing to end. The resolver maps the structured result
// of handleTextgridInboundWebhook (every exit path returns an object; thrown
// errors are handled by the recorder) onto this contract.

export const TERMINAL_DISPOSITIONS = Object.freeze({
  REPLY_SENT: "reply_sent",
  REPLY_DEFERRED_COMPLIANCE: "reply_deferred_compliance",
  SUPPRESSED_OPT_OUT: "suppressed_opt_out",
  SUPPRESSED_WRONG_NUMBER: "suppressed_wrong_number",
  SUPPRESSED_POLICY: "suppressed_policy",
  HUMAN_REVIEW_REQUIRED: "human_review_required",
  DUPLICATE_IGNORED: "duplicate_ignored",
  NO_REPLY_REQUIRED: "no_reply_required",
  FAILED_RETRIABLE: "failed_retriable",
  FAILED_TERMINAL: "failed_terminal",
});

export const TERMINAL_DISPOSITION_SET = Object.freeze(
  new Set(Object.values(TERMINAL_DISPOSITIONS))
);

export function isTerminalDisposition(value) {
  return TERMINAL_DISPOSITION_SET.has(String(value ?? "").trim());
}

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

// Failure reasons that will not succeed on provider retry: re-delivery of the
// same malformed payload can never progress, so it must not stay open.
const TERMINAL_FAILURE_REASONS = new Set([
  "missing_inbound_from",
  "invalid_textgrid_inbound_payload",
  "invalid_textgrid_signature",
]);

/**
 * Map a handleTextgridInboundWebhook result object to a terminal disposition.
 * Deny-nothing contract: this ALWAYS returns a disposition — an unmappable
 * result is itself routed to human review rather than dropped.
 *
 * @returns {{ disposition: string, detail: object }}
 */
export function resolveInboundTerminalDisposition(result, context = {}) {
  const detail = {
    handler_reason: clean(result?.reason) || null,
    handler_stage: clean(result?.stage) || null,
    resolver: "resolveInboundTerminalDisposition_v1",
  };

  if (!result || typeof result !== "object") {
    return {
      disposition: TERMINAL_DISPOSITIONS.HUMAN_REVIEW_REQUIRED,
      detail: { ...detail, unmapped: "handler_returned_non_object" },
    };
  }

  // Debug-stage short circuits are test/diagnostic traffic, never seller
  // traffic: the inbound was intentionally not processed.
  if (clean(result.stage)) {
    return {
      disposition: TERMINAL_DISPOSITIONS.NO_REPLY_REQUIRED,
      detail: { ...detail, debug_stage_short_circuit: true },
    };
  }

  const reason = lower(result.reason);

  if (result.duplicate === true || reason === "duplicate_reply_prevented" || reason.includes("duplicate")) {
    return { disposition: TERMINAL_DISPOSITIONS.DUPLICATE_IGNORED, detail };
  }

  // Structured failures: retriable unless the payload itself can never parse.
  if (result.ok === false) {
    if (TERMINAL_FAILURE_REASONS.has(reason)) {
      return { disposition: TERMINAL_DISPOSITIONS.FAILED_TERMINAL, detail };
    }
    if (reason === "empty_inbound_body") {
      // Empty or media-only inbound: a human must look — media may be photos
      // of the property, and silence would be a silent drop.
      return {
        disposition: TERMINAL_DISPOSITIONS.HUMAN_REVIEW_REQUIRED,
        detail: { ...detail, empty_or_media_only: true },
      };
    }
    return { disposition: TERMINAL_DISPOSITIONS.FAILED_RETRIABLE, detail };
  }

  const classification = result.classification || {};
  const compliance_flag = lower(classification.compliance_flag);
  const primary_intent = lower(
    classification.primary_intent || classification.detected_intent
  );
  detail.detected_intent = primary_intent || null;

  if (compliance_flag.includes("opt_out") || compliance_flag.includes("stop") || primary_intent === "opt_out") {
    return { disposition: TERMINAL_DISPOSITIONS.SUPPRESSED_OPT_OUT, detail };
  }
  if (compliance_flag.includes("wrong_number") || primary_intent === "wrong_number") {
    return { disposition: TERMINAL_DISPOSITIONS.SUPPRESSED_WRONG_NUMBER, detail };
  }

  const seller_stage_reply = result.seller_stage_reply || {};
  const reply_reason = lower(seller_stage_reply.reason);
  detail.seller_stage_reply_reason = reply_reason || null;

  if (seller_stage_reply.queued === true || clean(seller_stage_reply.queue_row_id)) {
    detail.reply_queue_row_id = clean(seller_stage_reply.queue_row_id) || null;
    // The reply is durably queued; transport (and any contact-window deferral)
    // is tracked on the send_queue row itself.
    return { disposition: TERMINAL_DISPOSITIONS.REPLY_SENT, detail };
  }

  if (reply_reason.includes("contact_window") || reply_reason.includes("deferred")) {
    return { disposition: TERMINAL_DISPOSITIONS.REPLY_DEFERRED_COMPLIANCE, detail };
  }
  if (
    reply_reason.includes("manual_review") ||
    reply_reason.includes("human_review") ||
    seller_stage_reply.human_review_required === true ||
    result.human_review_required === true
  ) {
    return { disposition: TERMINAL_DISPOSITIONS.HUMAN_REVIEW_REQUIRED, detail };
  }
  if (reply_reason.includes("suppress")) {
    return { disposition: TERMINAL_DISPOSITIONS.SUPPRESSED_POLICY, detail };
  }
  if (primary_intent === "hostile_or_legal") {
    return { disposition: TERMINAL_DISPOSITIONS.HUMAN_REVIEW_REQUIRED, detail };
  }

  // Processed with an explicit no-reply decision (automation disabled, intent
  // needs no answer, burst deferred to flush, etc.).
  return {
    disposition: TERMINAL_DISPOSITIONS.NO_REPLY_REQUIRED,
    detail,
  };
}

export default resolveInboundTerminalDisposition;
