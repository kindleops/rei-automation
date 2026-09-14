/**
 * inbound-attention.js
 *
 * A SELLER REPLY THAT NEEDS A HUMAN CANNOT SIT IN A DATABASE UNNOTICED.
 *
 * EMAIL-3 stores unmatched, ambiguous and quarantined inbound mail correctly
 * and completely. What it does not do is TELL ANYONE. The documented fallback
 * was "query resolution_status on a cadence until EMAIL-8", which is a person
 * remembering to run a query -- fine for a phase with no production MX behind
 * it, and not fine for a real seller who answered and is waiting.
 *
 * So this is the narrowest possible bridge from EMAIL-3's durable rows to the
 * attention system this platform already has.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ──────────────────────────────────────────
 *
 * It is not a new inbox, a new alert framework, or an email-shaped twin of the
 * notification system. notification_events, the event catalog and
 * emitNotificationFromBusinessEvent already exist, are already used by the SMS
 * inbound path, and their vocabulary is already channel-neutral -- the `inbox`
 * domain says `inbox_message_received`, not `sms_message_received`. A second
 * vocabulary is how a platform ends up with two places to look and operators
 * who trust neither.
 *
 * ── DEDUPLICATION IS THE POINT, NOT A DETAIL ───────────────────────────────
 *
 * Brevo retries. A retried callback is the SAME seller reply arriving again,
 * and it must not become a second alert -- an operator who sees the same
 * unmatched reply five times learns to ignore unmatched replies.
 *
 * The dedup key is derived from EMAIL-3's `event_key`, which is already stable
 * across retries by construction (that is what it exists for) and already
 * refuses to be a random UUID. It deliberately does NOT use the platform's
 * default buildDedupKey(), because that one appends today's date: a retry that
 * crosses midnight would produce a second notification, which is exactly the
 * duplicate this is meant to prevent.
 *
 * ── EMISSION IS NOT PROOF OF VISIBILITY ────────────────────────────────────
 *
 * emitNotificationFromBusinessEvent is deliberately non-blocking and swallows
 * every error, which is right for a notification and wrong as the only
 * guarantee. A failed emit is silent, and silence is the exact failure mode.
 *
 * So this module is HALF the answer. The other half is the sweep in
 * inbound-attention-scan.js, which re-derives attention from the durable rows
 * and catches anything an emit dropped. Neither alone satisfies the invariant.
 *
 * ── PRIVACY ────────────────────────────────────────────────────────────────
 *
 * No message body reaches a notification. An operator needs to know a reply is
 * waiting and where to find it; they read the reply in the message row, behind
 * the same access control as the rest of the seller record. Copying seller
 * prose into a second table widens exposure for no operational gain.
 */

import { child } from "@/lib/logging/logger.js";
import { asObject } from "@/lib/hostile-input.js";
import { emitNotificationFromBusinessEvent } from "@/lib/domain/notifications/notification-emitter.js";

const logger = child({ module: "domain.email.inbound_attention" });

export const INBOUND_ATTENTION_POLICY_VERSION = "inbound_attention_v1";

/**
 * Why a reply needs a human, mapped to the catalog event that says so.
 *
 * `ambiguous` reuses the existing `inbox_multi_property_match`: one seller
 * matching several properties is precisely what that event already means, and
 * it predates this phase.
 */
export const INBOUND_ATTENTION_REASON = Object.freeze({
  UNMATCHED: "unmatched",
  AMBIGUOUS: "ambiguous",
  QUARANTINED: "quarantined",
  PROCESSING_FAILED: "processing_failed",
  ATTACHMENT_QUARANTINED: "attachment_quarantined",
});

const EVENT_TYPE = Object.freeze({
  [INBOUND_ATTENTION_REASON.UNMATCHED]: "inbox_unmatched_reply",
  [INBOUND_ATTENTION_REASON.AMBIGUOUS]: "inbox_multi_property_match",
  [INBOUND_ATTENTION_REASON.QUARANTINED]: "inbox_inbound_quarantined",
  [INBOUND_ATTENTION_REASON.PROCESSING_FAILED]: "inbox_inbound_processing_failed",
  [INBOUND_ATTENTION_REASON.ATTACHMENT_QUARANTINED]: "inbox_attachment_quarantined",
});

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * A dedup key that is stable for the LIFE of an inbound event, not for a day.
 *
 * Scoped by reason as well as event: one message can legitimately be both
 * quarantined for an attachment and unmatched for a thread, and collapsing
 * those would hide one of them.
 */
export function buildInboundAttentionKey(event_key, reason) {
  const key = clean(event_key);
  const scope = clean(reason);
  if (!key || !scope) return null;
  return `inbound_email:${scope}:${key}`;
}

/**
 * Decide whether an ingest outcome needs a human, and say why.
 *
 * PURE. The decision is separated from the emission so the rules can be tested
 * without a notification system, and so the sweep can apply the same rules to a
 * stored row that it applies to a live outcome -- one definition of "needs a
 * human", used by both paths.
 *
 * @returns {{needed:boolean, reason:string|null, event_type:string|null}}
 */
export function classifyInboundAttention(raw_outcome) {
  const outcome = asObject(raw_outcome);

  // A retryable failure is the loudest case: the receipt could not be made
  // durable, the provider has been asked to try again, and if that ask is not
  // honoured the seller's reply is gone with nothing recording that it existed.
  if (outcome.retryable === true || outcome.reason === "inbound_message_persist_failed") {
    return attention(INBOUND_ATTENTION_REASON.PROCESSING_FAILED);
  }

  // A duplicate has already been handled once; its first delivery raised
  // whatever attention it warranted. Raising it again is the duplicate alert
  // this module exists to prevent.
  if (outcome.duplicate === true) return none();

  if (outcome.processing_status === "quarantined" || outcome.quarantined === true) {
    return attention(INBOUND_ATTENTION_REASON.QUARANTINED);
  }

  if (outcome.needs_review === true) {
    const status = clean(outcome.resolution_status);
    if (status === "ambiguous") return attention(INBOUND_ATTENTION_REASON.AMBIGUOUS);
    return attention(INBOUND_ATTENTION_REASON.UNMATCHED);
  }

  // A held reply is a deliberate operator decision (the kill switch is off).
  // Alerting on something they switched off themselves is noise, and the rows
  // stay reprocessable.
  return none();
}

function attention(reason) {
  return { needed: true, reason, event_type: EVENT_TYPE[reason] || null };
}

function none() {
  return { needed: false, reason: null, event_type: null };
}

/**
 * Raise attention for one inbound outcome.
 *
 * NEVER THROWS AND NEVER BLOCKS THE INGEST RESULT. A notification problem must
 * not turn a successfully stored seller reply into a 503 that asks Brevo to
 * send it again -- that would trade a missing alert for a duplicated message.
 * The sweep is what makes that safe.
 */
export async function emitInboundAttention(raw_input, deps = {}) {
  const input = asObject(raw_input);
  const emit = deps.emitNotification || emitNotificationFromBusinessEvent;

  const verdict = deps.verdict || classifyInboundAttention(input.outcome);
  if (!verdict.needed) return { ok: true, emitted: false, reason: "no_attention_required" };

  const event_key = clean(input.event_key) || clean(asObject(input.outcome).event_key);
  const deduplication_key = buildInboundAttentionKey(event_key, verdict.reason);
  if (!deduplication_key) {
    // Without a stable key this would alert again on every retry. A missing
    // alert is recoverable by the sweep; an un-deduplicated one trains
    // operators to ignore the whole category.
    logger.warn("inbound_attention.no_dedup_key", { reason: verdict.reason });
    return { ok: false, emitted: false, reason: "missing_event_key" };
  }

  const conversation = asObject(input.conversation);
  const from_email = clean(input.from_email).toLowerCase() || null;

  try {
    const result = await emit({
      eventType: verdict.event_type,
      deduplicationKey: deduplication_key,
      sourceEntityType: "inbound_email",
      sourceEntityId: event_key,
      propertyId: conversation.property_id || null,
      participantId: conversation.opportunity_id || null,
      titleVars: {
        from_email: from_email || "unknown sender",
        reason: clean(input.outcome?.reason) || verdict.reason,
        candidate_count: input.candidate_count ?? "several",
        filename: clean(input.filename) || "attachment",
        thread_key: conversation.thread_key || from_email || "unknown",
      },
      // Pointers, not content. An operator follows these to the message; the
      // seller's words stay in the one table that already holds them.
      metrics: {
        channel: "email",
        attention_reason: verdict.reason,
        inbound_event_id: input.inbound_event_id || null,
        inbound_message_id: input.inbound_message_id || null,
        resolution_status: clean(input.outcome?.resolution_status) || null,
        resolution_reason: clean(input.outcome?.resolution_reason) || null,
        policy_version: INBOUND_ATTENTION_POLICY_VERSION,
      },
      // Never grouped. Each unmatched reply is a different seller waiting, and
      // collapsing them into "3 occurrences" is how the third one is missed.
      group: false,
    });

    return {
      ok: result?.ok !== false,
      emitted: result?.ok !== false,
      reason: verdict.reason,
      event_type: verdict.event_type,
      deduplication_key,
      skipped: result?.skipped === true ? result.reason : null,
    };
  } catch (error) {
    // Reached only if the emitter's own guard is bypassed by an injected double.
    logger.error("inbound_attention.emit_failed", {
      reason: verdict.reason, error: clean(error?.message),
    });
    return { ok: false, emitted: false, reason: "emit_failed" };
  }
}

export default emitInboundAttention;
