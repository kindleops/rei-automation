/**
 * Canonical no-contact conditions — single registry of sources that must block
 * future outbound messaging. Do not introduce a parallel suppression model.
 */

import {
  BLOCKING_CONTACTABILITY,
  CONTACTABILITY_CODES,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";

/** Intents that trigger terminal compliance cancellation (all pending outbound). */
export const COMPLIANCE_TERMINAL_INTENTS = Object.freeze(
  new Set([
    "opt_out",
    "stop",
    "dnc",
    "do_not_contact",
    "wrong_number",
    "wrong_person",
    "hostile_or_legal",
    "legal_threat",
    "hostile_legal",
    "not_owner",
    "never_owned",
    "former_owner",
    "sold_it",
    "invalid_number",
  ])
);

/** Relationship claims that invalidate the phone globally (terminal suppression). */
export const TERMINAL_RELATIONSHIP_CLAIMS = Object.freeze(
  new Set(["actual_wrong_number", "never_been_owner"])
);

/** Non-terminal relationship lanes — scoped review, not global send blocks. */
export const NON_TERMINAL_RELATIONSHIP_CLAIMS = Object.freeze(
  new Set([
    "tenant",
    "family_member",
    "property_manager",
    "agent_representative",
    "co_owner",
    "spouse_co_owner",
  ])
);

/**
 * Queue statuses eligible for compliance cancellation (unsent / non-terminal).
 * Mirrors active runnable pool minus terminal delivery outcomes.
 */
export const CANCELLABLE_QUEUE_STATUSES = Object.freeze([
  "held",
  "queued",
  "scheduled",
  "pending",
  "approved",
  "ready",
  "processing",
  "sending",
]);

/** Terminal queue statuses — never mutate on compliance cancel. */
export const TERMINAL_QUEUE_OUTCOMES = Object.freeze(
  new Set([
    "sent",
    "delivered",
    "failed",
    "blocked",
    "cancelled",
    "canceled",
    "duplicate_blocked",
    "proof",
    "paused_name_missing",
    "paused_deferred_unresolved",
    "paused_invalid_queue_row",
    "paused_duplicate",
    "paused_global_lock",
    "paused_max_retries",
    "opted_out",
  ])
);

/** Deterministic send-time block reason codes surfaced to operators. */
export const SEND_TIME_BLOCK_REASONS = Object.freeze({
  SUPPRESSED: "suppressed_at_send_time",
  OPTED_OUT: "opted_out_at_send_time",
  WRONG_NUMBER: "wrong_number_at_send_time",
  INVALID_CONTACT: "invalid_contact_at_send_time",
  CANCELLED_AFTER_CLAIM: "cancelled_after_claim",
  NO_CONTACT_TERMINAL: "no_contact_terminal_state",
  SUPPRESSION_LOOKUP_FAILED: "suppression_lookup_failed_fail_closed",
});

/**
 * Source-of-truth inventory (read at send/cancel time):
 *
 * | Condition                         | Table / field                          | Resolver                          | Precedence |
 * |-----------------------------------|----------------------------------------|-----------------------------------|------------|
 * | Active suppression list           | sms_suppression_list (is_active)       | evaluateCanonicalContactability   | 1          |
 * | Opt-out / STOP inbound            | message_events.is_opt_out              | evaluateCanonicalContactability   | 2          |
 * | Wrong number flag                 | phones.phone_contact_status/wrong_number_at | lookupCanonicalPhoneRow      | 3          |
 * | Thread contactability             | inbox_thread_state.contactability_status | contactabilityBlocksSend        | 4          |
 * | Thread paused / quarantine        | inbox_thread_state.status, metadata    | evaluateCanonicalContactability   | 5 (manual bypass where policy allows) |
 * | Legacy thread suppression         | deal_thread_state.opt_out, inbox_bucket| evaluateCanonicalContactability   | 6          |
 * | Terminal reply intent             | inbox_thread_state.reply_intent, message_events.detected_intent, universal_stage | resolveTerminalThreadIntents | 7 |
 * | Provider 21610 pair blacklist     | send_queue failed_reason / suppression | checkBlacklistPriorFailure        | 8          |
 * | Phone activity not active         | phones.activity_status                 | evaluateCanonicalContactability   | 9          |
 * | Row cancelled after claim         | send_queue.queue_status                  | evaluateCanonicalContactability   | 0 (first)  |
 */
export { BLOCKING_CONTACTABILITY, CONTACTABILITY_CODES };