/**
 * inbound-message-classification.js
 *
 * IS THIS A PERSON, OR A MACHINE?
 *
 * That is the ONLY question this file answers, and it answers it from RFC
 * headers rather than from what the message says.
 *
 * WHY THIS IS TRANSPORT AND NOT INTELLIGENCE.
 *   EMAIL-4 decides whether a seller is interested. This decides whether a human
 *   typed anything at all. The distinction is load-bearing: an out-of-office
 *   auto-reply quotes the message it is replying to, so a naive intent
 *   classifier reading
 *
 *     "I am out of the office until Monday.
 *      > Would you consider an offer on 123 Main St?"
 *
 *   sees an engaged seller discussing an offer. Marking it `auto_reply` here is
 *   what stops EMAIL-4 from ever forming that opinion.
 *
 * HEADERS, NOT KEYWORDS.
 *   Auto-submitted (RFC 3834), Auto-Response-Suppress, X-Autoreply and the
 *   List-* family are STANDARDS. A subject line beginning "Out of Office" is a
 *   convention, in one language, that a seller could also type by hand.
 *
 *   Subject heuristics are therefore used only as a LAST resort, only for the
 *   patterns that are near-universal, and they are recorded as weaker evidence
 *   so a wrong call is visible rather than indistinguishable from a header match.
 *
 * FAIL TOWARDS HUMAN.
 *   An unclassifiable message is `human_reply`. Misfiling a real seller reply as
 *   machine noise means nobody ever reads it, which is the silent loss this
 *   phase exists to prevent. Misfiling an auto-reply as human costs an operator
 *   ten seconds. The asymmetry is not close.
 */

export const INBOUND_CLASSIFICATION_POLICY_VERSION = "inbound_class_v1";

export const INBOUND_MESSAGE_CLASS = Object.freeze({
  HUMAN_REPLY: "human_reply",
  AUTO_REPLY: "auto_reply",
  DELIVERY_STATUS: "delivery_status",
  SYSTEM_OR_LIST: "system_or_list",
  MALFORMED: "malformed",
});

/** RFC 3834 values that mean "a machine generated this". */
const AUTO_SUBMITTED_MACHINE_VALUES = ["auto-replied", "auto-generated", "auto-notified"];

/**
 * Envelope senders that are, by convention and by RFC 3834, never a person.
 * A DSN comes from the null sender or from a daemon mailbox.
 */
const DAEMON_LOCAL_PARTS = new Set([
  "mailer-daemon", "postmaster", "mail-daemon", "bounce", "bounces", "no-reply", "noreply",
]);

const DELIVERY_STATUS_CONTENT_TYPES = [
  "multipart/report",
  "message/delivery-status",
  "message/disposition-notification",
];

/** Near-universal, and only ever consulted after every header has been checked. */
const SUBJECT_AUTO_REPLY_PATTERNS = [
  /^\s*(re\s*:\s*)?out of (the )?office\b/i,
  /^\s*(re\s*:\s*)?automatic(al)? reply\b/i,
  /^\s*(re\s*:\s*)?auto(matic)?[- ]?response\b/i,
  /^\s*(re\s*:\s*)?away from (the )?office\b/i,
  /^\s*(re\s*:\s*)?vacation reply\b/i,
];

const SUBJECT_DELIVERY_STATUS_PATTERNS = [
  /^\s*(mail )?delivery (status notification|failure|failed)\b/i,
  /^\s*undeliverable\s*:/i,
  /^\s*returned mail\b/i,
  /^\s*failure notice\b/i,
];

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function header(headers, name) {
  return lower(headers?.[name]);
}

/**
 * @param {object} normalized  a NormalizedInboundEmail
 * @returns {{message_class, reason, evidence, confidence, policy_version}}
 */
export function classifyInboundMessage(normalized = {}) {
  const headers = normalized.headers && typeof normalized.headers === "object" ? normalized.headers : {};
  const from_email = lower(normalized.from?.email);
  const subject = clean(normalized.subject);
  const evidence = [];

  const verdict = (message_class, reason, confidence) => ({
    message_class,
    reason,
    evidence,
    confidence,
    policy_version: INBOUND_CLASSIFICATION_POLICY_VERSION,
  });

  // ── malformed ────────────────────────────────────────────────────────────
  if (!from_email) {
    evidence.push("no_sender");
    return verdict(INBOUND_MESSAGE_CLASS.MALFORMED, "missing_sender", "certain");
  }

  // ── delivery status: checked FIRST ───────────────────────────────────────
  // A DSN is also auto-submitted, so testing auto-reply first would swallow it
  // into the wrong bucket and lose the fact that a message bounced.
  const content_type = header(headers, "content-type");
  if (DELIVERY_STATUS_CONTENT_TYPES.some((type) => content_type.includes(type))) {
    evidence.push(`content-type:${content_type.split(";")[0]}`);
    return verdict(INBOUND_MESSAGE_CLASS.DELIVERY_STATUS, "delivery_status_content_type", "high");
  }

  // RFC 3464: the null return-path is the canonical marker of a bounce.
  const return_path = header(headers, "return-path");
  if (return_path === "<>" || clean(normalized.envelope_from) === "<>") {
    evidence.push("null_return_path");
    return verdict(INBOUND_MESSAGE_CLASS.DELIVERY_STATUS, "null_return_path", "high");
  }

  const local_part = from_email.split("@")[0];
  if (DAEMON_LOCAL_PARTS.has(local_part)) {
    evidence.push(`daemon_sender:${local_part}`);
    const is_bounce = /daemon|bounce|postmaster/.test(local_part);
    return verdict(
      is_bounce ? INBOUND_MESSAGE_CLASS.DELIVERY_STATUS : INBOUND_MESSAGE_CLASS.SYSTEM_OR_LIST,
      `sender_is_${local_part}`,
      "high"
    );
  }

  // ── auto-reply, by standard header ───────────────────────────────────────
  const auto_submitted = header(headers, "auto-submitted");
  if (auto_submitted && auto_submitted !== "no") {
    evidence.push(`auto-submitted:${auto_submitted}`);
    if (AUTO_SUBMITTED_MACHINE_VALUES.some((value) => auto_submitted.startsWith(value))) {
      return verdict(INBOUND_MESSAGE_CLASS.AUTO_REPLY, "rfc3834_auto_submitted", "certain");
    }
    return verdict(INBOUND_MESSAGE_CLASS.AUTO_REPLY, "auto_submitted_present", "high");
  }

  for (const name of ["x-autoreply", "x-autorespond", "x-auto-response-suppress"]) {
    if (clean(headers[name])) {
      evidence.push(`${name}:present`);
      return verdict(INBOUND_MESSAGE_CLASS.AUTO_REPLY, `vendor_header_${name}`, "high");
    }
  }

  // Microsoft Exchange and Google mark vacation replies this way.
  const precedence = header(headers, "precedence");
  if (["auto_reply", "bulk", "junk", "list"].includes(precedence)) {
    evidence.push(`precedence:${precedence}`);
    return verdict(
      precedence === "auto_reply" ? INBOUND_MESSAGE_CLASS.AUTO_REPLY : INBOUND_MESSAGE_CLASS.SYSTEM_OR_LIST,
      `precedence_${precedence}`,
      "high"
    );
  }

  // ── list and system mail, by standard header ─────────────────────────────
  for (const name of ["list-id", "list-unsubscribe", "list-post", "x-mailing-list"]) {
    if (clean(headers[name])) {
      evidence.push(`${name}:present`);
      return verdict(INBOUND_MESSAGE_CLASS.SYSTEM_OR_LIST, `list_header_${name}`, "high");
    }
  }

  // ── subject heuristics: LAST, and recorded as weaker ─────────────────────
  if (SUBJECT_DELIVERY_STATUS_PATTERNS.some((pattern) => pattern.test(subject))) {
    evidence.push("subject_heuristic");
    return verdict(INBOUND_MESSAGE_CLASS.DELIVERY_STATUS, "subject_looks_like_dsn", "low");
  }
  if (SUBJECT_AUTO_REPLY_PATTERNS.some((pattern) => pattern.test(subject))) {
    evidence.push("subject_heuristic");
    return verdict(INBOUND_MESSAGE_CLASS.AUTO_REPLY, "subject_looks_like_auto_reply", "low");
  }

  // ── fail towards human ───────────────────────────────────────────────────
  return verdict(INBOUND_MESSAGE_CLASS.HUMAN_REPLY, "no_machine_markers", "default");
}

/**
 * True when a class means "no human wrote this".
 *
 * EMAIL-4 should consult this rather than testing classes itself, so adding a
 * class later cannot silently change what counts as a seller message.
 */
export function isMachineGenerated(message_class) {
  return message_class === INBOUND_MESSAGE_CLASS.AUTO_REPLY
    || message_class === INBOUND_MESSAGE_CLASS.DELIVERY_STATUS
    || message_class === INBOUND_MESSAGE_CLASS.SYSTEM_OR_LIST;
}

export default classifyInboundMessage;
