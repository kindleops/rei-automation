/**
 * logical-communication-key.js
 *
 * THE canonical identity of a seller-visible communication ACTION.
 *
 * A logical communication is the thing that is meant to happen ONCE. It is not a
 * queue row, not an HTTP request, not a provider message, and not a rendered
 * body. A transport retry, a template rotation, a different sender number and a
 * second worker must all resolve to the SAME key.
 *
 * WHY THIS EXISTS RATHER THAN REUSING queue_key/dedupe_key.
 *   buildSendQueueInsertPayload does:
 *     queue_key: clean(normalized.queue_key) || crypto.randomUUID()      (sms-engine.js:4241)
 *     dedupe_key: clean(... || normalized.queue_key) || null             (sms-engine.js:4294)
 *   so a caller that supplies neither key gets a RANDOM queue_key, and dedupe_key
 *   inherits that randomness. UNIQUE(queue_key) and the partial UNIQUE(dedupe_key)
 *   are then satisfied by randomness rather than by identity, which makes them
 *   vacuous for exactly the callers that most need them. Several live sources take
 *   that path today.
 *
 *   Other existing keys are disqualified for identity because they move when the
 *   MESSAGE does: campaign launch hashes templateId + scheduledIso, the canonical
 *   writer's idempotency_key embeds template_id, and the legacy Podio queue_id is a
 *   hash of the rendered body. Rotating a template would mint a new identity and
 *   authorise a second seller message -- the precise failure Slice 0 closed.
 *
 * THE ONE RULE THAT MAKES THIS SAFE: THERE IS NO FALLBACK.
 *   If the durable anchors for a communication type are absent, this REFUSES and
 *   returns a reason. It never invents an identity, never hashes a timestamp, and
 *   never generates a UUID. A caller that cannot name its domain action has not
 *   earned the right to send, and failing closed is the only correct answer.
 */

import crypto from "node:crypto";

/**
 * Version the SEMANTICS, not the value. If the components of a key ever change,
 * bump this so old and new keys cannot silently collide or be compared.
 */
export const LOGICAL_COMMUNICATION_KEY_VERSION = "lck_v1";

/** Every seller-visible communication source, from the domain-action map. */
export const COMMUNICATION_TYPES = Object.freeze({
  AUTONOMOUS_REPLY: "autonomous_reply",
  CLARIFICATION_REPLY: "clarification_reply",
  NEGOTIATION_REPLY: "negotiation_reply",
  MONETARY_OFFER: "monetary_offer",
  CAMPAIGN_TOUCH: "campaign_touch",
  FOLLOW_UP: "follow_up",
  REFERRAL_OUTREACH: "referral_outreach",
  UNKNOWN_INBOUND_REPLY: "unknown_inbound_reply",
  MANUAL_OPERATOR_SEND: "manual_operator_send",
  INTERNAL_CANARY: "internal_canary",
});

/**
 * Required durable anchors per type.
 *
 * Every entry names columns that already exist and are written BEFORE the send:
 *   decision_id            seller_automation_decisions.decision_id (UNIQUE)
 *   offer_id/offer_version seller_offers, immutable per version
 *   campaign_target_id     campaign_targets.id, with touch_number
 *   follow_up_id           follow_up_queue.id
 *   message_event_id       message_events.id of the inbound that triggered it
 *   operator_action_id     the operator's client_send_id
 *   canary_run_id          queue_canary_authorizations.canary_run_id
 *
 * `action_sequence` distinguishes genuinely different communications authorised
 * by the SAME anchor (e.g. two negotiation turns on one decision). It defaults
 * to "1" and must be supplied deliberately, never derived from a clock.
 */
const REQUIRED_ANCHORS = Object.freeze({
  [COMMUNICATION_TYPES.AUTONOMOUS_REPLY]: ["decision_id"],
  [COMMUNICATION_TYPES.CLARIFICATION_REPLY]: ["decision_id"],
  [COMMUNICATION_TYPES.NEGOTIATION_REPLY]: ["decision_id"],
  [COMMUNICATION_TYPES.MONETARY_OFFER]: ["offer_id", "offer_version"],
  [COMMUNICATION_TYPES.CAMPAIGN_TOUCH]: ["campaign_target_id", "touch_number"],
  [COMMUNICATION_TYPES.FOLLOW_UP]: ["follow_up_id"],
  [COMMUNICATION_TYPES.REFERRAL_OUTREACH]: ["referral_id", "source_event_id"],
  [COMMUNICATION_TYPES.UNKNOWN_INBOUND_REPLY]: ["message_event_id"],
  [COMMUNICATION_TYPES.MANUAL_OPERATOR_SEND]: ["operator_action_id"],
  [COMMUNICATION_TYPES.INTERNAL_CANARY]: ["canary_run_id", "canary_leg"],
});

/**
 * Fields that must NEVER contribute to identity. Listed explicitly so the
 * prohibition is testable rather than a convention someone can forget.
 *
 * A body fingerprint may exist separately on the ATTEMPT, where it is evidence
 * of what was transmitted -- it is simply not identity.
 */
export const FORBIDDEN_IDENTITY_FIELDS = Object.freeze([
  "message_body",
  "rendered_message",
  "message_text",
  "body",
  "template_id",
  "selected_template_id",
  "template_key",
  "transport_fingerprint",
  "queue_row_id",
  "queue_key",
  "provider_message_id",
  "provider_message_sid",
  "attempt_number",
  "scheduled_for",
  "created_at",
  "now",
  "timestamp",
  "from_phone_number",
  "textgrid_number_id",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function stableHash(parts) {
  return crypto
    .createHash("sha256")
    .update(parts.map((p) => String(p ?? "")).join("|"), "utf8")
    .digest("hex");
}

/**
 * Build the canonical logical communication key.
 *
 * @returns {{ok:true, key:string, version:string, type:string, anchors:object}}
 *        | {ok:false, reason:string, missing?:string[]}
 *
 * Never throws, never falls back. A refusal is a legitimate, expected outcome.
 */
export function buildLogicalCommunicationKey(input = {}) {
  const type = clean(input.communication_type);
  if (!type) return { ok: false, reason: "missing_communication_type" };

  const required = REQUIRED_ANCHORS[type];
  if (!required) return { ok: false, reason: "unknown_communication_type", type };

  // Anchors must be present AND non-empty. A blank anchor is a missing anchor:
  // hashing "" would produce a stable-looking key that actually identifies
  // nothing, and every caller with the same gap would collide onto it.
  const anchors = {};
  const missing = [];
  for (const field of required) {
    const value = clean(input[field]);
    if (!value) missing.push(field);
    else anchors[field] = value;
  }
  if (missing.length) {
    return { ok: false, reason: "missing_required_anchors", type, missing };
  }

  // Deliberate, caller-supplied ordinal. Defaults to "1"; never a clock.
  // BOUNDED on purpose. A real ordinal is small; a clock value is enormous.
  // Without the bound, String(Date.now()) is all digits and would pass, minting
  // a fresh identity on every call -- exactly the failure this module exists to
  // prevent. 999 is far above any legitimate turn count.
  const action_sequence = clean(input.action_sequence) || "1";
  if (!/^[0-9]{1,3}$/.test(action_sequence) || Number(action_sequence) < 1) {
    return { ok: false, reason: "invalid_action_sequence", type, action_sequence };
  }

  const parts = [
    LOGICAL_COMMUNICATION_KEY_VERSION,
    type,
    ...required.map((field) => anchors[field]),
    action_sequence,
  ];

  return {
    ok: true,
    key: `${LOGICAL_COMMUNICATION_KEY_VERSION}:${type}:${stableHash(parts)}`,
    version: LOGICAL_COMMUNICATION_KEY_VERSION,
    type,
    anchors: { ...anchors, action_sequence },
  };
}

/**
 * True when a value looks like a key this module produced. Used by the database
 * adapter and invariants to reject hand-made or legacy identifiers.
 */
export function isLogicalCommunicationKey(value) {
  return /^lck_v[0-9]+:[a-z_]+:[0-9a-f]{64}$/.test(clean(value));
}

export default buildLogicalCommunicationKey;
