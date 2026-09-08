/**
 * ingest-inbound-email.js
 *
 * THE one place an inbound provider callback becomes a seller message.
 *
 * ORDER IS THE DESIGN. Each step below can only run because the previous one
 * succeeded, and the sequence is chosen so that the failure modes this phase
 * exists to prevent are impossible rather than merely unlikely:
 *
 *   1. AUTHENTICATE   an unauthenticated caller changes nothing
 *   2. NORMALIZE      Brevo's vocabulary stops here
 *   3. RECORD         the durable receipt, BEFORE any resolution or mutation
 *   4. RESOLVE        which conversation, or an honest refusal
 *   5. PERSIST        exactly one canonical message
 *   6. ATTACH         files, digested and quarantined
 *   7. EMIT           evidence for EMAIL-4, and nothing more
 *
 * WHY RECORDING COMES BEFORE RESOLVING.
 *   If resolution throws, the seller's message must still exist. Recording first
 *   means the worst outcome of any later bug is an unresolved row an operator can
 *   see and repair -- never a message that arrived and vanished. SILENT LOSS is
 *   the failure this ordering is aimed at.
 *
 * WHY "DISABLED" DOES NOT MEAN "DISCARD".
 *   Brevo retries on a non-2xx, so returning an error to pause ingestion would
 *   have it hammer us and eventually give up, losing replies. So the hold is
 *   applied AFTER the receipt is durable: the event is stored with
 *   processing_status = 'held', we answer 200, and nothing further happens. When
 *   the hold lifts, those events are reprocessed from storage. Nothing is thrown
 *   away to achieve a quiet system.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO.
 *   It does not decide whether the seller is interested, set a lead status,
 *   change a negotiation stage, price an offer, or send anything. EMAIL-3 ends at
 *   trustworthy evidence. The one thing it emits is a communication event; the
 *   acquisition domain is not touched.
 */

import crypto from "node:crypto";

import { child } from "@/lib/logging/logger.js";
import { TRUST_CLASS, mayAdvanceCanonicalTruthWithTrust } from "@/lib/domain/communications/callback-trust-policy.js";
import { normalizeInboundBody } from "@/lib/domain/email/inbound/inbound-body-normalization.js";
import { sanitizeInboundHtml } from "@/lib/domain/email/inbound/inbound-html-sanitizer.js";
import { findReplyTokenInRecipients, replyTokenFingerprint } from "@/lib/domain/email/reply-address.js";
import {
  resolveInboundThread,
  RESOLUTION_STATUS,
} from "@/lib/domain/email/inbound/resolve-inbound-thread.js";
import { INBOUND_MESSAGE_CLASS } from "@/lib/domain/email/inbound/inbound-message-classification.js";

const logger = child({ module: "domain.email.inbound_ingest" });

export const INBOUND_INGEST_POLICY_VERSION = "inbound_ingest_v1";

/** The flag that pauses ingestion WITHOUT discarding anything. */
export const INBOUND_KILL_SWITCH_KEY = "email_inbound_enabled";

export const PROCESSING_STATUS = Object.freeze({
  RECEIVED: "received",
  PROCESSED: "processed",
  DUPLICATE: "duplicate",
  HELD: "held",
  QUARANTINED: "quarantined",
  REJECTED: "rejected",
});

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * The idempotency key.
 *
 * Prefers the provider's own id. The fallback is a digest of STABLE message
 * properties -- the RFC Message-ID, sender, envelope recipient and instant --
 * and never a random value or a hash of the whole payload: Brevo varies
 * incidental fields between redeliveries, so hashing everything would make each
 * duplicate look new, which is precisely what this key exists to prevent.
 *
 * The RFC Message-ID alone is not enough: it is chosen by the SENDER's mail
 * client, so a hostile or broken client could reuse one and collide two genuinely
 * different messages into one.
 */
export function buildInboundEventKey(normalized = {}) {
  const provider_event_id = clean(normalized.provider_event_id);
  if (provider_event_id) return `brevo_in:${provider_event_id}`;

  const parts = [
    "brevo_in",
    clean(normalized.rfc_message_id),
    clean(normalized.from?.email),
    clean(normalized.envelope_to),
    clean(normalized.subject),
    clean(normalized.received_at),
  ];
  return `brevo_in:${crypto.createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 40)}`;
}

/**
 * @param {object} input
 * @param {object} input.normalized   a NormalizedInboundEmail
 * @param {string} input.trust_class
 * @param {object} deps              store collaborators, all injectable
 */
export async function ingestInboundEmail(input = {}, deps = {}) {
  const trust_class = clean(input.trust_class) || TRUST_CLASS.UNAUTHENTICATED;
  const normalized = input.normalized || {};
  const now = input.now || new Date().toISOString();
  const event_key = buildInboundEventKey(normalized);

  const token_match = findReplyTokenInRecipients({
    envelope_to: normalized.envelope_to,
    to: normalized.to,
    cc: normalized.cc,
  });
  const presented_token = token_match.ok ? token_match.token : null;

  // Everything logged about an alias is a FINGERPRINT. The alias is a bearer
  // credential: logging it whole would let anyone with log access inject messages
  // into a seller's conversation.
  const log_context = {
    event_key,
    from_domain: clean(normalized.from?.email).split("@")[1] || null,
    reply_token: replyTokenFingerprint(presented_token),
    message_class: normalized.message_class || null,
  };

  // ── 1. authenticate ──────────────────────────────────────────────────────
  if (!mayAdvanceCanonicalTruthWithTrust(trust_class)) {
    logger.warn("inbound_email.untrusted", { ...log_context, trust_class });
    // Recorded anyway when the store allows it: an unauthenticated POST is
    // evidence that someone is probing the endpoint.
    await safeRecord(deps, {
      normalized, event_key, trust_class, presented_token,
      resolution_status: "rejected",
      processing_status: PROCESSING_STATUS.REJECTED,
      processing_reason: `untrusted_receipt:${trust_class}`,
      received_at: now,
    });
    return outcome({ ok: false, event_key, trust_class, processing_status: PROCESSING_STATUS.REJECTED,
      reason: "untrusted_inbound_receipt" });
  }

  // ── 2. the receipt, before anything else can fail ────────────────────────
  const recorded = await deps.recordInboundEvent?.({
    normalized,
    event_key,
    trust_class,
    presented_token,
    reply_token_source: token_match.ok ? token_match.source : null,
    resolution_status: "pending",
    processing_status: PROCESSING_STATUS.RECEIVED,
    received_at: now,
  });

  if (!recorded?.ok) {
    // We could not durably record it. Answering 200 here would tell Brevo the
    // message was accepted and stop it retrying -- losing the reply. So this is
    // the ONE path that asks the caller to fail the request.
    logger.error("inbound_email.record_failed", { ...log_context, reason: recorded?.reason });
    return outcome({ ok: false, event_key, trust_class, retryable: true,
      processing_status: null, reason: recorded?.reason || "inbound_event_record_failed" });
  }

  if (recorded.duplicate) {
    // A redelivery. The first receipt already did the work; doing it again would
    // create a second seller message.
    logger.info("inbound_email.duplicate", log_context);
    return outcome({ ok: true, event_key, trust_class, duplicate: true,
      processing_status: PROCESSING_STATUS.DUPLICATE, reason: "duplicate_provider_callback",
      inbound_event_id: recorded.inbound_event_id || null });
  }

  const inbound_event_id = recorded.inbound_event_id;

  // ── 3. the hold, AFTER the receipt is durable ────────────────────────────
  const ingestion_enabled = deps.getSystemFlag
    ? await deps.getSystemFlag(INBOUND_KILL_SWITCH_KEY)
    : true;
  if (!ingestion_enabled) {
    await deps.updateInboundEvent?.({
      inbound_event_id,
      processing_status: PROCESSING_STATUS.HELD,
      processing_reason: "inbound_ingestion_disabled",
    });
    logger.warn("inbound_email.held", log_context);
    // ok:true so Brevo stops retrying. The event is KEPT and reprocessable.
    return outcome({ ok: true, event_key, trust_class, inbound_event_id, held: true,
      processing_status: PROCESSING_STATUS.HELD, reason: "inbound_ingestion_disabled" });
  }

  // ── 4. resolve ───────────────────────────────────────────────────────────
  const alias = presented_token
    ? await deps.findReplyAlias?.(presented_token)
    : null;

  const header_matches = await deps.findCommunicationsByMessageIds?.({
    in_reply_to: normalized.in_reply_to,
    references: normalized.references,
  }) ?? [];

  const sender_candidates = await deps.findConversationsForSender?.({
    from_email: normalized.from?.email,
  }) ?? [];

  const resolution = resolveInboundThread({
    alias: alias ?? null,
    presented_token,
    header_matches,
    sender_candidates,
    from_email: normalized.from?.email,
  });

  await deps.updateInboundEvent?.({
    inbound_event_id,
    resolution_status: resolution.status,
    resolution_tier: resolution.tier,
    resolution_reason: resolution.reason,
    reply_alias_id: resolution.alias_id || alias?.id || null,
    ...(resolution.conversation || {}),
  });

  if (resolution.status !== RESOLUTION_STATUS.RESOLVED) {
    // Authentic, stored, and deliberately not attached. These are the rows an
    // operator reviews. Forcing them onto a plausible conversation is the
    // wrong-property failure this phase is built to avoid.
    logger.info("inbound_email.unresolved", {
      ...log_context, status: resolution.status, reason: resolution.reason,
    });
    return outcome({ ok: true, event_key, trust_class, inbound_event_id,
      processing_status: PROCESSING_STATUS.RECEIVED,
      resolution_status: resolution.status, resolution_reason: resolution.reason,
      needs_review: true });
  }

  // ── 5. the canonical message ─────────────────────────────────────────────
  const body = normalizeInboundBody({
    text_body: normalized.text_body,
    html_body: normalized.html_body,
    provider_reply_text: normalized.provider_reply_text,
  });

  const sanitized = sanitizeInboundHtml(normalized.html_body);

  const persisted = await deps.createInboundMessage?.({
    inbound_event_id,
    conversation: resolution.conversation,
    reply_alias_id: resolution.alias_id || alias?.id || null,
    in_reply_to_communication_id: header_matches[0]?.logical_communication_id || null,
    normalized,
    body,
    // Both forms are stored. The raw is evidence; only the sanitized form may
    // ever reach a browser, and html_is_sanitized says whether that is true.
    html_raw: normalized.html_body || null,
    html_sanitized: sanitized.html,
    message_class: normalized.message_class || INBOUND_MESSAGE_CLASS.HUMAN_REPLY,
    received_at: normalized.received_at || now,
  });

  if (!persisted?.ok) {
    logger.error("inbound_email.persist_failed", { ...log_context, reason: persisted?.reason });
    return outcome({ ok: false, event_key, trust_class, inbound_event_id, retryable: true,
      reason: persisted?.reason || "inbound_message_persist_failed" });
  }

  // ── 6. attachments ───────────────────────────────────────────────────────
  let attachments = { stored: 0, quarantined: 0, failed: 0 };
  if (Array.isArray(normalized.attachments) && normalized.attachments.length && deps.ingestAttachments) {
    attachments = await deps.ingestAttachments({
      inbound_event_id,
      inbound_message_id: persisted.inbound_message_id,
      descriptors: normalized.attachments,
    }) || attachments;
  }

  await deps.updateInboundEvent?.({
    inbound_event_id,
    processing_status: PROCESSING_STATUS.PROCESSED,
    inbound_message_id: persisted.inbound_message_id,
    attachment_count: attachments.stored + attachments.quarantined,
  });

  // ── 7. evidence for EMAIL-4, and nothing more ────────────────────────────
  // A communication event. NOT a lead status, a stage, an offer or a reply.
  await deps.emitCommunicationEvent?.({
    type: "communication.email.received",
    inbound_message_id: persisted.inbound_message_id,
    inbound_event_id,
    conversation: resolution.conversation,
    message_class: normalized.message_class,
    received_at: normalized.received_at || now,
  });

  logger.info("inbound_email.processed", {
    ...log_context,
    resolution_tier: resolution.tier,
    attachment_count: attachments.stored + attachments.quarantined,
  });

  return outcome({
    ok: true, event_key, trust_class, inbound_event_id,
    inbound_message_id: persisted.inbound_message_id,
    processing_status: PROCESSING_STATUS.PROCESSED,
    resolution_status: resolution.status,
    resolution_tier: resolution.tier,
    conversation: resolution.conversation,
    attachments,
  });
}

async function safeRecord(deps, payload) {
  try {
    return await deps.recordInboundEvent?.(payload);
  } catch {
    // A refusal path must not throw on its way out.
    return { ok: false };
  }
}

function outcome(fields) {
  return { policy_version: INBOUND_INGEST_POLICY_VERSION, ...fields };
}

export default ingestInboundEmail;
