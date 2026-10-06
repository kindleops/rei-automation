// ─── seller-autopilot-v2-redelivery.js ──────────────────────────────────────
// Seller Autopilot v2 — ONE safe re-delivery of an auto-reply the carrier did
// not deliver (flag SELLER_AUTOPILOT_V2; PURE, not yet wired to a caller).
//
// What exists today (traced 2026-10-06):
//   • Send-time failures are already retried by finalizeSendQueueFailure
//     (sms-engine.js): only `provider_unreachable_before_request` requeues;
//     `content_filter_blocked` at send time rotates to an alternate approved
//     body (resolveRotationTemplate). Ambiguous / timeout / no-SID outcomes are
//     `may_have_been_sent` and canAllocateAttempt refuses any new attempt on
//     that lck_v1 logical communication (ambiguous_outcome_absorbing).
//   • Nothing retries an auto-reply AFTER the provider accepted it and a
//     delivery callback later said failed. All 4 failed_transport auto-replies
//     in the 14 days to 2026-10-06 are exactly that: provider SID present,
//     failure_class content_filter_blocked, retry_allowed=false, terminal.
//
// What this adds: the decision for ONE re-delivery of such a row, as a NEW
// logical communication (the original is provider_accepted → terminal, so it
// is never re-attempted), with an alternate approved body and the sender left
// to the normal per-attempt selection (Sender Routing 2.0 / sticky-thread
// rules decide whether a different number is allowed). It never re-delivers
// when the outcome is unknown, when the seller has written again, when any
// suppression or opt-out exists, or after the reply has gone stale.

function clean(value) {
  return String(value ?? "").trim();
}
function lower(value) {
  return clean(value).toLowerCase();
}

export const REDELIVERY_VERSION = "seller_autopilot_v2_redelivery_v1";
export const REDELIVERY_MAX_AGE_MS = 60 * 60 * 1000; // the inbound-reply quiet-hours exemption window
/** Definitive post-acceptance delivery failures that a resend can fix. */
export const REDELIVERABLE_FAILURE_CLASSES = Object.freeze(new Set([
  "content_filter_blocked", // carrier filter on THIS body/sender → alternate body + normal sender selection
  "handset_unreachable", // 30003-class: phone off / out of coverage
  "carrier_queue_overflow",
]));
/** Never resend: the number or the person says no. */
const NEVER_REDELIVER = Object.freeze(new Set([
  "opt_out", "opted_out", "invalid_number", "landline", "unknown_destination", "blocked_by_recipient", "carrier_blocked", "duplicate_blocked",
]));

/**
 * @param {object} p
 * @param {object} p.row                    the failed send_queue row
 * @param {boolean} p.newer_inbound_exists  seller wrote again after the inbound this row answered
 * @param {boolean} p.active_suppression    any active suppression for the phone
 * @param {object}  p.inbound_classification re-classification of the inbound text at HEAD
 * @param {Array}   p.alternate_templates   active+safe rows of the SAME use case and language
 * @returns {{ eligible: boolean, reason: string, row?: object }}
 */
export function resolveAutoReplyRedelivery({
  row = null,
  now = Date.now(),
  newer_inbound_exists = false,
  active_suppression = false,
  inbound_classification = null,
  alternate_templates = [],
} = {}) {
  const meta = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const deny = (reason) => ({ eligible: false, reason, version: REDELIVERY_VERSION });
  if (!row) return deny("no_row");
  if (lower(row.type) !== "auto_reply" && lower(meta.source) !== "auto_reply") return deny("not_an_auto_reply");
  if (meta.v2_redelivery_of) return deny("already_a_redelivery"); // exactly one retry
  if (!clean(row.provider_message_id)) return deny("no_provider_sid_outcome_unknown"); // never resend an unknown outcome
  if (row.delivered_at) return deny("was_delivered");
  if (lower(row.queue_status) !== "failed_transport" && lower(row.queue_status) !== "failed") return deny(`status_${lower(row.queue_status) || "unknown"}`);
  const failure_class = lower(meta.failure_class || row.failed_reason);
  if (NEVER_REDELIVER.has(failure_class)) return deny(`never_redeliver_${failure_class}`);
  if (!REDELIVERABLE_FAILURE_CLASSES.has(failure_class)) return deny(`failure_class_not_redeliverable_${failure_class || "unknown"}`);
  if (active_suppression) return deny("active_suppression");
  if (newer_inbound_exists) return deny("seller_wrote_again");
  const intent = lower(inbound_classification?.primary_intent);
  if (!inbound_classification) return deny("inbound_not_reclassified");
  if (clean(inbound_classification?.compliance_flag) || ["opt_out", "wrong_number", "wrong_person", "hostile_or_legal"].includes(intent)) {
    return deny(`inbound_is_${intent || "compliance"}`);
  }
  const sent = Date.parse(row.sent_at || row.created_at || "");
  if (!Number.isFinite(sent) || now - sent > REDELIVERY_MAX_AGE_MS) return deny("reply_too_old");
  const original_template = clean(row.template_id);
  const alternate = (Array.isArray(alternate_templates) ? alternate_templates : []).find(
    (t) => t?.is_active && t?.safe_for_auto_reply && clean(t.template_id) && clean(t.template_id) !== original_template
  );
  // A content filter flagged THIS body: resending it verbatim is pointless.
  if (failure_class === "content_filter_blocked" && !alternate) return deny("no_alternate_approved_body");
  const decision_id = `${clean(meta.decision_id) || clean(row.id)}:redelivery:1`;
  return {
    eligible: true,
    reason: "redeliver_once",
    version: REDELIVERY_VERSION,
    row: {
      // New logical communication: lck_v1 AUTONOMOUS_REPLY keys on decision_id.
      queue_key: `v2-redelivery:${clean(row.id)}`,
      template_id: alternate ? clean(alternate.template_id) : original_template,
      use_case_template: row.use_case_template,
      template_body_source: alternate ? "alternate_approved_template" : "original_template",
      to_phone_number: row.to_phone_number,
      // Left empty so the normal per-attempt sender selection runs; whether a
      // DIFFERENT number is allowed is the routing rules' decision, not ours.
      from_phone_number: null,
      thread_key: row.thread_key,
      retry_count: 0,
      max_retries: 1,
      metadata: {
        source: "auto_reply",
        action_type: "autopilot_inbound_reply",
        decision_id,
        v2_redelivery_of: clean(row.id),
        v2_redelivery_failure_class: failure_class,
        inbound_message_event_id: meta.inbound_message_event_id || null,
      },
    },
  };
}

export default resolveAutoReplyRedelivery;
