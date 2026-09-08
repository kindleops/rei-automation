/**
 * reconcile-email-provider-event.js
 *
 * THE one place a Brevo webhook may change what we believe about an email.
 *
 * The SMS twin is domain/communications/reconcile-provider-callback.js, and the
 * asymmetry that drives both designs is the same:
 *
 *   Outbound evidence is OURS. We know whether we called the provider, because
 *   we wrote provider_request_started before doing it.
 *
 *   Inbound evidence is THEIRS. It arrives out of order, may be duplicated
 *   arbitrarily, and cannot be proven authentic from repository configuration
 *   alone. So an event is recorded as a CLAIM, then authorised as a TRANSITION,
 *   and never executed as an instruction.
 *
 * WHAT AN EVENT MAY DO
 *   Increase certainty about an attempt that ALREADY EXISTS. Add a seller to the
 *   suppression list.
 *
 * WHAT AN EVENT MAY NEVER DO
 *   Create a logical communication. Create an attempt. Mint retry authority.
 *   Regress a delivered message. Resolve ambiguity downward into "definitely not
 *   sent". Advance anything at all without an authenticated receipt.
 *
 * SUPPRESSION IS NOT GATED ON RESOLUTION -- AND THAT IS DELIBERATE.
 *   Delivery state needs an attempt to attach to; suppression does not. If a
 *   seller unsubscribes and we cannot work out which send they were replying to,
 *   the correct outcome is still to stop emailing them. Refusing to suppress
 *   because our own bookkeeping failed would turn an internal problem into a
 *   compliance one. It still requires an authenticated receipt: the alternative
 *   is letting a stranger suppress arbitrary addresses.
 *
 * IDEMPOTENCY IS THE DATABASE'S JOB.
 *   email_events.event_key is UNIQUE. A duplicate delivery races into the same
 *   row rather than being detected by a read-then-write that another worker can
 *   interleave with. The lattice then makes a second application harmless even
 *   if the insert somehow succeeded twice.
 */

import crypto from "node:crypto";

import { child } from "@/lib/logging/logger.js";
import {
  TRUST_CLASS,
  mayAdvanceCanonicalTruthWithTrust,
  CALLBACK_TRUST_POLICY_VERSION,
} from "@/lib/domain/communications/callback-trust-policy.js";
import {
  normalizeEmailProviderEvent,
  advanceEmailProviderOutcome,
  deliveryPossibilityFor,
  EMAIL_EVENT_KIND,
  PROVIDER_OUTCOME,
  EMAIL_PROVIDER_STATUS_POLICY_VERSION,
} from "@/lib/domain/email/email-provider-outcome-lattice.js";
import { normalizeEmailAddress } from "@/lib/domain/email/normalize-email-address.js";

const logger = child({ module: "domain.email.event_reconcile" });

export const EMAIL_EVENT_RECONCILE_POLICY_VERSION = "email_event_reconcile_v1";

/** Verdicts, matching the email_events.processing_status CHECK exactly. */
export const PROCESSING_STATUS = Object.freeze({
  APPLIED: "applied",
  IDEMPOTENT: "idempotent",
  STALE: "stale",
  CONFLICT: "conflict",
  INERT: "inert",
  UNRESOLVED: "unresolved",
  UNTRUSTED: "untrusted",
});

function clean(value) {
  return String(value ?? "").trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = clean(value);
    if (normalized) return normalized;
  }
  return "";
}

/**
 * A stable identity for an event, so a redelivery collides with the original.
 *
 * The provider's own id is preferred when present. The fallback deliberately
 * hashes the SEMANTIC content -- message, address, type, instant -- and not the
 * whole payload: Brevo varies incidental fields between redeliveries of the same
 * event, and hashing those would make every duplicate look new, which is exactly
 * the failure the key exists to prevent.
 */
export function buildEmailEventKey(payload = {}, normalized = {}) {
  const provider_id = firstNonEmpty(payload.id, payload.event_id, payload.uuid);
  if (provider_id) return `brevo:${provider_id}`;

  const parts = [
    "brevo",
    clean(normalized.provider_message_id),
    clean(normalized.email_address),
    clean(normalized.event_type),
    clean(normalized.event_at),
  ];
  return `brevo:${crypto.createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 40)}`;
}

function eventInstant(payload = {}) {
  const raw = firstNonEmpty(payload.date, payload.ts_event, payload.ts, payload.event_at, payload.timestamp);
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const number = Number(raw);
    // Brevo sends seconds in some payloads and milliseconds in others. Ten digits
    // is seconds until the year 2286; anything longer is already milliseconds.
    return new Date(number > 9_999_999_999 ? number : number * 1000).toISOString();
  }
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/**
 * Payload -> a shape this module can reason about. No IO, no decisions.
 */
export function normalizeBrevoWebhookPayload(payload = {}, options = {}) {
  const body = payload && typeof payload === "object" ? payload : {};
  const event = normalizeEmailProviderEvent(body.event ?? body.event_type ?? body.type);
  const address = normalizeEmailAddress(body.email ?? body.recipient ?? body.to);

  const normalized = {
    provider: "brevo",
    provider_event_id: firstNonEmpty(body.id, body.event_id, body.uuid) || null,
    provider_message_id: firstNonEmpty(
      body["message-id"], body.messageId, body.message_id, body.brevo_message_id
    ) || null,
    email_address: address.ok ? address.normalized : null,
    mailbox_identity: address.ok ? address.mailbox_identity : null,
    event_type: event.event_type,
    event_kind: event.kind,
    provider_outcome: event.outcome,
    rank_bearing: event.rank_bearing,
    suppression_reason: event.suppression_reason,
    recognised: event.recognised,
    event_at: eventInstant(body) || options.received_at || new Date().toISOString(),
    subject: clean(body.subject) || null,
    tags: Array.isArray(body.tags) ? body.tags : [],
    reason: clean(body.reason || body.error || body.message) || null,
    link: clean(body.link || body.url) || null,
    raw_payload: body,
  };

  normalized.event_key = buildEmailEventKey(body, normalized);
  return normalized;
}

/**
 * @param {object} input
 * @param {object} input.payload      one Brevo webhook event
 * @param {string} input.trust_class  from verifyBrevoWebhook()
 * @param {object} deps               store collaborators, all injectable
 */
export async function reconcileEmailProviderEvent(input = {}, deps = {}) {
  const trust_class = clean(input.trust_class) || TRUST_CLASS.UNAUTHENTICATED;
  const normalized = normalizeBrevoWebhookPayload(input.payload, { received_at: input.received_at });
  const now = input.now || new Date().toISOString();

  const record = async (verdict, extra = {}) => {
    // The event is stored on EVERY path, including refusals. An event we would
    // not act on is still the only evidence that it arrived, and the questions
    // an operator asks later ("did Brevo tell us?", "why did nothing happen?")
    // are unanswerable without it.
    if (typeof deps.recordEvent === "function") {
      await deps.recordEvent({
        ...normalized,
        trust_class,
        processing_status: verdict.processing_status,
        processing_reason: verdict.processing_reason,
        logical_communication_id: extra.logical_communication_id || null,
        attempt_id: extra.attempt_id || null,
        recorded_at: now,
      });
    }
    return {
      ok: verdict.ok !== false,
      event_key: normalized.event_key,
      event_type: normalized.event_type,
      event_kind: normalized.event_kind,
      trust_class,
      policy_version: EMAIL_EVENT_RECONCILE_POLICY_VERSION,
      status_policy_version: EMAIL_PROVIDER_STATUS_POLICY_VERSION,
      trust_policy_version: CALLBACK_TRUST_POLICY_VERSION,
      ...verdict,
      ...extra,
    };
  };

  // ── 1. trust ─────────────────────────────────────────────────────────────
  // Recorded either way; allowed to act only if authenticated.
  if (!mayAdvanceCanonicalTruthWithTrust(trust_class)) {
    logger.warn("email_event.untrusted", {
      event_key: normalized.event_key, event_type: normalized.event_type, trust_class,
    });
    return record({
      ok: false,
      processing_status: PROCESSING_STATUS.UNTRUSTED,
      processing_reason: `untrusted_receipt:${trust_class}`,
      suppressed: false,
      advanced: false,
    });
  }

  // ── 2. suppression, BEFORE resolution ────────────────────────────────────
  // A seller who opted out must stop receiving email whether or not we can work
  // out which send they were reacting to.
  let suppressed = false;
  if (normalized.suppression_reason && normalized.email_address) {
    if (typeof deps.applySuppression === "function") {
      const result = await deps.applySuppression({
        email_address: normalized.email_address,
        mailbox_identity: normalized.mailbox_identity,
        reason: normalized.suppression_reason,
        source: "brevo_webhook",
        provider_message_id: normalized.provider_message_id,
        event_key: normalized.event_key,
        event_at: normalized.event_at,
        raw_payload: normalized.raw_payload,
      });
      suppressed = result?.ok !== false;
    }
  }

  // ── 3. telemetry and unrecognised events stop here ───────────────────────
  // They are real, they are stored, and they carry no delivery meaning. An open
  // is a resource fetch that scanners and privacy proxies perform without a
  // human involved; letting it move delivery state would let a scanner mark a
  // message delivered.
  if (normalized.event_kind === EMAIL_EVENT_KIND.TELEMETRY
    || normalized.event_kind === EMAIL_EVENT_KIND.UNKNOWN
    || !normalized.rank_bearing) {
    if (normalized.event_kind === EMAIL_EVENT_KIND.TELEMETRY
      && typeof deps.recordTelemetry === "function") {
      await deps.recordTelemetry({
        provider_message_id: normalized.provider_message_id,
        event_type: normalized.event_type,
        event_at: normalized.event_at,
        link: normalized.link,
      });
    }
    return record({
      ok: true,
      processing_status: PROCESSING_STATUS.INERT,
      processing_reason: normalized.recognised
        ? `${normalized.event_kind}_carries_no_delivery_meaning`
        : "unrecognised_provider_event",
      suppressed,
      advanced: false,
    });
  }

  // ── 4. resolve the event to an attempt that ALREADY EXISTS ───────────────
  if (!normalized.provider_message_id) {
    return record({
      ok: true,
      processing_status: PROCESSING_STATUS.UNRESOLVED,
      processing_reason: "event_carries_no_provider_message_id",
      suppressed,
      advanced: false,
    });
  }

  const resolved = typeof deps.resolveAttempt === "function"
    ? await deps.resolveAttempt({ provider_message_id: normalized.provider_message_id })
    : null;

  if (!resolved?.ok) {
    // No attempt matched. An event is NEVER permission to create one: a callback
    // that could mint an attempt could mint a send that never happened.
    logger.warn("email_event.unresolved", {
      event_key: normalized.event_key,
      provider_message_id: normalized.provider_message_id,
      reason: resolved?.reason || "attempt_not_found",
    });
    return record({
      ok: true,
      processing_status: PROCESSING_STATUS.UNRESOLVED,
      processing_reason: resolved?.reason || "no_attempt_for_provider_message_id",
      suppressed,
      advanced: false,
    });
  }

  // ── 5. the monotonic gate ────────────────────────────────────────────────
  const current_outcome = clean(resolved.provider_outcome) || PROVIDER_OUTCOME.UNKNOWN;
  const gate = advanceEmailProviderOutcome(current_outcome, normalized.provider_outcome);

  const shared = {
    logical_communication_id: resolved.logical_communication_id || null,
    attempt_id: resolved.attempt_id || null,
  };

  if (gate.action !== "advance") {
    // idempotent | stale | conflict | inert. All are RECORDED and none applied.
    // `stale` is the out-of-order case: a late `sent` after a `delivered` is
    // older, weaker evidence, and applying it would silently downgrade a
    // delivered message.
    logger.info("email_event.not_applied", {
      event_key: normalized.event_key,
      action: gate.action,
      from: current_outcome,
      to: normalized.provider_outcome,
    });
    return record({
      ok: true,
      processing_status: PROCESSING_STATUS[gate.action.toUpperCase()] || PROCESSING_STATUS.INERT,
      processing_reason: gate.reason,
      suppressed,
      advanced: false,
      from_outcome: current_outcome,
      to_outcome: normalized.provider_outcome,
    }, shared);
  }

  const delivery_possibility = deliveryPossibilityFor(normalized.provider_outcome);
  if (typeof deps.applyOutcome === "function") {
    await deps.applyOutcome({
      logical_communication_id: resolved.logical_communication_id,
      attempt_id: resolved.attempt_id,
      provider_outcome: normalized.provider_outcome,
      delivery_possibility,
      event_type: normalized.event_type,
      event_at: normalized.event_at,
      at: now,
    });
  }

  logger.info("email_event.applied", {
    event_key: normalized.event_key,
    logical_communication_id: resolved.logical_communication_id,
    from: current_outcome,
    to: normalized.provider_outcome,
  });

  return record({
    ok: true,
    processing_status: PROCESSING_STATUS.APPLIED,
    processing_reason: gate.reason,
    suppressed,
    advanced: true,
    from_outcome: current_outcome,
    to_outcome: normalized.provider_outcome,
    delivery_possibility,
  }, shared);
}

export default reconcileEmailProviderEvent;
