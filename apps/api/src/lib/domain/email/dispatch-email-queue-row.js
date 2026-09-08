/**
 * dispatch-email-queue-row.js
 *
 * The bridge from the email queue runner to the canonical dispatch seam.
 *
 * This is the email twin of domain/communications/dispatch-seller-queue-row.js,
 * and it deliberately grants no privilege that one lacks. Everything that makes
 * an SMS send safe applies here unchanged, because it lives in the seam rather
 * than in the caller:
 *
 *   which action is this?        email-queue-row-identity (refuses if unknown)
 *   may another attempt happen?  seller_communication_attempt_allocate (SQL)
 *   are we allowed to send now?  evaluateCanonicalSendAuthority
 *   what did the provider do?    the Brevo classifier + the transition authority
 *
 * WHAT THIS FILE ADDS THAT THE SMS BRIDGE DOES NOT, and why each is here rather
 * than inside the seam:
 *
 *   RECIPIENT ELIGIBILITY   suppression, opt-outs, the cross-channel duplicate
 *                           window. It is channel-shaped (an email opt-out is
 *                           not an SMS opt-out), so it belongs to the channel's
 *                           bridge, not to the shared seam.
 *   SENDER READINESS        caps, warm-up, suspension. SMS has an equivalent in
 *                           number selection; email's lives here.
 *   THE EMAIL KILL SWITCH   system_control.email_enabled, which exists so email
 *                           can be stopped without stopping SMS.
 *
 * ORDER MATTERS, AND IT IS CHEAPEST-AND-MOST-ABSOLUTE FIRST.
 *   The kill switch is read before anything else, because when it is off the
 *   answer cannot change and no other question is worth asking. Identity comes
 *   next because a row we cannot name must never be evaluated as if it were
 *   sendable. Recipient and sender checks precede attempt allocation so a
 *   refused send never consumes an attempt number -- an attempt is a durable
 *   claim that a provider request was about to happen, and spending one on a
 *   message we were never going to send corrupts the ledger it protects.
 *
 * DRY RUN STOPS BEFORE THE ATTEMPT, NOT BEFORE THE NETWORK.
 *   A dry run that allocated an attempt and then skipped the wire would leave a
 *   numbered attempt with no provider request behind it, which is precisely the
 *   shape the crash-recovery logic reads as "a request may have gone out". So a
 *   dry run returns before the seam is entered at all, and says so.
 */

import { child } from "@/lib/logging/logger.js";
import { executeSellerCommunicationAttempt } from "@/lib/domain/communications/canonical-communication-dispatch.js";
import { createSellerCommunicationStore } from "@/lib/domain/communications/seller-communication-store.js";
import { buildLogicalCommunicationKey } from "@/lib/domain/communications/logical-communication-key.js";
import { evaluateCanonicalSendAuthority } from "@/lib/domain/queue/canonical-send-authority.js";
import { assertNoEmDash } from "@/lib/domain/messaging/outbound-content-guard.js";
import { resolveEmailQueueRowIdentity } from "@/lib/domain/email/email-queue-row-identity.js";
import { resolveEmailOutreachEligibility } from "@/lib/domain/email/email-eligibility-store.js";
import { evaluateEmailSenderReadiness } from "@/lib/domain/email/email-sender-readiness.js";
import { createBrevoEmailTransport } from "@/lib/domain/email/transport/brevo-email-transport.js";
import { classifyBrevoProviderError } from "@/lib/domain/email/transport/brevo-error-classifier.js";
import { normalizeEmailAddress } from "@/lib/domain/email/normalize-email-address.js";
import { getSystemFlag } from "@/lib/system-control.js";

const logger = child({ module: "domain.email.queue_dispatch" });

export const EMAIL_DISPATCH_POLICY_VERSION = "email_dispatch_v1";

/** The flag that stops email without stopping SMS. */
export const EMAIL_KILL_SWITCH_KEY = "email_enabled";

function clean(value) {
  return String(value ?? "").trim();
}

/** Every refusal has the same shape, so no caller has to guess. */
function denied(stage, reason, extra = {}) {
  return {
    ok: false,
    sent: false,
    provider_invoked: false,
    stage,
    reason,
    policy_version: EMAIL_DISPATCH_POLICY_VERSION,
    ...extra,
  };
}

/**
 * Execute one email_queue row through the canonical seam.
 *
 * @param {object} queue_row      an email_queue row
 * @param {object} deps           every collaborator is injectable so the ordering
 *                                guarantees are testable with a network spy
 */
export async function dispatchEmailQueueRow(queue_row = {}, deps = {}) {
  const queue_row_id = clean(queue_row.id) || null;
  const store = deps.store || createSellerCommunicationStore({ supabase: deps.supabase });
  const transport = deps.transport || createBrevoEmailTransport();
  const getFlag = deps.getSystemFlag || getSystemFlag;
  const resolveEligibility = deps.resolveEligibility || resolveEmailOutreachEligibility;
  const loadSender = deps.loadSender;

  // ── 0. the kill switch, before anything else ─────────────────────────────
  // A disabled channel cannot be argued out of by any later check, so asking
  // anything else first would only produce a more expensive refusal.
  const email_enabled = await getFlag(EMAIL_KILL_SWITCH_KEY);
  if (!email_enabled) {
    logger.info("email_dispatch.kill_switch_denied", { queue_row_id });
    return denied("kill_switch", "email_channel_disabled", { flag_key: EMAIL_KILL_SWITCH_KEY });
  }

  if (typeof store?.getOrCreateLogicalCommunication !== "function"
    || typeof store?.allocateAttempt !== "function") {
    // A store that cannot answer is not permission to send, and it must REFUSE
    // rather than throw: a TypeError escaping here could be caught by a caller
    // and mistaken for a transport failure, which is the one reading that could
    // justify a retry.
    logger.error("email_dispatch.store_unavailable", { queue_row_id });
    return denied("store", "logical_communication_store_unavailable");
  }

  // ── 1. which action does this row schedule? ──────────────────────────────
  const identity = resolveEmailQueueRowIdentity(queue_row);
  if (!identity.ok) {
    logger.warn("email_dispatch.identity_refused", { queue_row_id, reason: identity.reason });
    return denied("identity", identity.reason);
  }

  // ── 2. the recipient ─────────────────────────────────────────────────────
  const recipient = normalizeEmailAddress(queue_row.to_email);
  if (!recipient.ok) {
    return denied("recipient", "recipient_address_unusable", { detail: recipient.reason });
  }

  const eligibility = await resolveEligibility(
    {
      email_address: queue_row.to_email,
      master_owner_id: queue_row.master_owner_id || null,
      property_id: queue_row.property_id || null,
    },
    { supabase: deps.supabase }
  );
  if (!eligibility?.eligible) {
    logger.info("email_dispatch.recipient_ineligible", {
      queue_row_id,
      reason: eligibility?.reason,
      blocking_reasons: eligibility?.blocking_reasons,
      next_eligible_at: eligibility?.next_eligible_at,
    });
    return denied("eligibility", eligibility?.reason || "recipient_not_eligible", {
      blocking_reasons: eligibility?.blocking_reasons || [],
      next_eligible_at: eligibility?.next_eligible_at || null,
    });
  }

  // ── 3. the sender ────────────────────────────────────────────────────────
  // `undefined` from the loader means "could not look", which the readiness
  // policy treats as a refusal for the same reason the eligibility engine does.
  const sender_row = typeof loadSender === "function"
    ? await loadSender(queue_row)
    : deps.sender;
  const readiness = evaluateEmailSenderReadiness({ sender: sender_row });
  if (!readiness.ready) {
    logger.info("email_dispatch.sender_not_ready", {
      queue_row_id, reason: readiness.reason, detail: readiness.reason_detail,
    });
    return denied("sender", readiness.reason, {
      blocking_reasons: readiness.blocking_reasons,
      sender: readiness.sender,
    });
  }

  // ── 4. the message ───────────────────────────────────────────────────────
  const message = {
    to: recipient.normalized,
    from: { email: readiness.sender.from_email, name: readiness.sender.sender_name },
    ...(readiness.sender.reply_to_email ? { reply_to: { email: readiness.sender.reply_to_email } } : {}),
    subject: clean(queue_row.subject_rendered) || clean(queue_row.subject),
    html: clean(queue_row.email_body),
    text: clean(queue_row.text_body) || undefined,
    brand_key: clean(queue_row?.metadata?.brand_key) || undefined,
    tags: [clean(queue_row.template_id), clean(queue_row.use_case)].filter(Boolean),
    // The content guard reads `body`; give it the text a human would read rather
    // than the HTML wrapper, so a rule about prose is applied to prose.
    body: clean(queue_row.text_body) || clean(queue_row.email_body),
  };

  if (!message.subject || !message.html) {
    return denied("content", "email_payload_incomplete", {
      detail: !message.subject ? "missing_subject" : "missing_body",
    });
  }

  // ── 5. dry run stops HERE, before an attempt is ever allocated ───────────
  if (deps.dry_run === true) {
    logger.info("email_dispatch.dry_run", {
      queue_row_id,
      communication_type: identity.communication_type || null,
      to: recipient.mailbox_identity,
    });
    return {
      ok: true,
      sent: false,
      dry_run: true,
      provider_invoked: false,
      stage: "dry_run",
      reason: "dry_run_no_dispatch",
      policy_version: EMAIL_DISPATCH_POLICY_VERSION,
      would_send: {
        communication_type: identity.communication_type || null,
        bound: identity.bound === true,
        to: recipient.normalized,
        from: readiness.sender.from_email,
        subject: message.subject,
        sender_remaining_today: readiness.sender.remaining_today,
      },
    };
  }

  // ── 6. into the seam ─────────────────────────────────────────────────────
  const dispatch_input = identity.bound
    ? {
        communication_type: identity.communication_type || null,
        preresolved_logical_communication_id: identity.logical_communication_id,
        queue_row_id,
        message,
      }
    : {
        communication_type: identity.communication_type,
        anchors: identity.anchors,
        lineage: identity.lineage,
        queue_row_id,
        message,
      };

  // A bound row carries no anchors, so its key is a fact to read rather than to
  // re-derive; the seam handles that path itself.
  //
  // For an unbound row the seam derives the key again from the same anchors, so
  // this is not the authoritative construction -- it is an early refusal, so a
  // row with unusable anchors is reported as an `identity` failure with the
  // reason the key builder gave, rather than as a generic seam denial three
  // steps later.
  if (!identity.bound) {
    const key = buildLogicalCommunicationKey({
      communication_type: identity.communication_type,
      ...identity.anchors,
    });
    if (!key.ok) {
      logger.warn("email_dispatch.key_refused", { queue_row_id, reason: key.reason });
      return denied("identity", key.reason, { missing: key.missing });
    }
  }

  const outcome = await executeSellerCommunicationAttempt(dispatch_input, {
    store,
    sendProvider: (args) => transport.send(args),
    classifyProviderError: deps.classifyProviderError || classifyBrevoProviderError,
    assertOutboundContent: deps.assertOutboundContent || assertNoEmDash,
    now: deps.now || new Date().toISOString(),
    logger,
    // Re-evaluated on EVERY attempt, never inherited from the checks above. A
    // seller can opt out, or an operator can hit the brake, between attempt 1
    // and attempt 2, and transport safety says nothing about either.
    evaluateRuntimeAuthority: async () => {
      const authority = await evaluateCanonicalSendAuthority({
        getSystemValue: deps.getSystemValue,
        action: "email_queue_send",
        scopedCanary: deps.scoped_canary === true,
      });
      return authority.ok ? { ok: true } : { ok: false, reason: authority.reason };
    },
  });

  return {
    ...outcome,
    policy_version: EMAIL_DISPATCH_POLICY_VERSION,
    channel: "email",
    sender: readiness.sender,
  };
}

export default dispatchEmailQueueRow;
