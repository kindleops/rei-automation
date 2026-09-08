/**
 * reply-address.js
 *
 * THE REPLY IDENTITY: how a seller's reply finds its way back to the right
 * conversation, and to no other one.
 *
 * SHAPE
 *   r1.<32 hex chars>@reply.<domain>          e.g. r1.9f3c...@reply.example.com
 *
 * WHY A DURABLE RANDOM ALIAS RATHER THAN A SIGNED TOKEN.
 *
 *   A signed token (HMAC over the conversation context) is stateless and
 *   tempting. It was rejected for three reasons, each of which is a stated
 *   requirement of this phase:
 *
 *   1. "Old valid outbound emails should remain replyable." A signing secret
 *      that is ever rotated -- after an incident, a staff change, a scheduled
 *      rotation -- silently invalidates every email already sitting in every
 *      seller's inbox. A stored alias survives rotation because it does not
 *      depend on a secret at all.
 *   2. "Token lifecycle is auditable." Revoking one signed token requires a
 *      denylist, which is a table -- so the stateless design ends up storing
 *      state anyway, just the awkward half of it. A row per alias makes
 *      creation, last use and revocation first-class and queryable.
 *   3. "Do not expose raw internal database IDs if avoidable." A signed token
 *      either carries the ids in plaintext or needs encryption on top of the
 *      signature. Random bytes carry nothing at all.
 *
 *   The cost is one row per conversation and one indexed lookup per inbound
 *   message. Inbound reply volume is a rounding error next to outbound, so this
 *   is the cheap side of the trade.
 *
 * ONE ALIAS PER CONVERSATION, NOT PER MESSAGE.
 *   This is what makes thread fragmentation impossible BY CONSTRUCTION rather
 *   than by care. A transport retry, a template rotation, a second touch and a
 *   follow-up three weeks later all carry the SAME Reply-To, so a seller who
 *   replies to any of them lands in one place. A per-message token would have to
 *   be threaded correctly through every retry path to achieve the same thing,
 *   and would fail quietly the first time one of them forgot.
 *
 * 128 BITS OF RANDOMNESS, and the reason it has to be that many.
 *   The alias is a bearer credential: presenting it attributes a message to a
 *   conversation. It is visible to the seller, may pass through their mail
 *   provider, and appears in headers. It cannot be secret from the recipient --
 *   what it must be is UNGUESSABLE by anyone else, because guessing one would
 *   let an outsider inject a message into a real seller's conversation.
 *
 * WHAT AN ALIAS DOES NOT DO.
 *   It does not authenticate the SENDER. Anyone who learns an alias can send to
 *   it. So a valid alias is strong evidence of WHICH CONVERSATION a message
 *   belongs to, and no evidence at all about WHO wrote it. Nothing downstream
 *   may treat "arrived on a known alias" as proof of seller identity.
 */

import crypto from "node:crypto";
import { asObject } from "@/lib/hostile-input.js";

export const REPLY_ADDRESS_POLICY_VERSION = "reply_alias_v1";

/**
 * Versioned prefix. A future format (a signed token, a longer alias) gets `r2.`
 * and both resolve side by side, so a format change never strands mail already
 * in seller inboxes.
 */
export const REPLY_TOKEN_VERSION = "r1";

/** 16 bytes = 128 bits, rendered as 32 lowercase hex characters. */
const TOKEN_BYTES = 16;
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The full local part, anchored. Deliberately strict: a local part that merely
 * CONTAINS something token-shaped is not a token, because `bob.r1.deadbeef@` is
 * a different mailbox belonging to a different person.
 */
const LOCAL_PART_PATTERN = /^r1\.([0-9a-f]{32})$/;

function clean(value) {
  return String(value ?? "").trim();
}

/** Mint a new alias. Never derived from conversation data -- see the header. */
export function generateReplyToken() {
  return `${REPLY_TOKEN_VERSION}.${crypto.randomBytes(TOKEN_BYTES).toString("hex")}`;
}

/**
 * Build the address a seller replies to.
 *
 * The domain is passed in rather than read from the environment here, so the
 * caller that knows which brand is sending also decides which reply domain the
 * seller sees. A mismatched pair (a Reivesti sender with a Prominent reply
 * address) is a deliverability and trust problem, and it is the sender's
 * business to keep them aligned.
 */
export function buildReplyAddress(raw_input) {
  const { token, reply_domain } = asObject(raw_input);
  const normalized_token = clean(token);
  const domain = clean(reply_domain).toLowerCase().replace(/^@/, "");

  if (!isReplyToken(normalized_token)) {
    return { ok: false, reason: "invalid_reply_token" };
  }
  if (!domain || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    return { ok: false, reason: "invalid_reply_domain" };
  }

  return { ok: true, address: `${normalized_token}@${domain}`, token: normalized_token, domain };
}

/** True when a value is a well-formed token of a version we understand. */
export function isReplyToken(value) {
  const raw = clean(value);
  if (!raw.startsWith(`${REPLY_TOKEN_VERSION}.`)) return false;
  return TOKEN_PATTERN.test(raw.slice(REPLY_TOKEN_VERSION.length + 1));
}

/**
 * Pull a reply token out of an inbound recipient address.
 *
 * TAKES THE RAW ADDRESS, NEVER A NORMALIZED ONE. normalizeEmailAddress() folds
 * plus-tags away to build a mailbox identity, which is exactly right for
 * suppression and exactly wrong here -- folding would erase the token. The two
 * uses are separated so neither can quietly become the other.
 *
 * Accepts `Display Name <r1.x@reply.d>` because inbound `to`/`envelope` fields
 * arrive in both shapes.
 *
 * @returns {{ok:true, token, domain}|{ok:false, reason}}
 */
export function extractReplyToken(raw_recipient) {
  const raw = clean(raw_recipient);
  if (!raw) return { ok: false, reason: "missing_recipient" };

  const angle = raw.match(/<([^>]*)>/);
  const address = clean(angle ? angle[1] : raw);

  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return { ok: false, reason: "recipient_not_an_address" };

  const local_part = address.slice(0, at).toLowerCase();
  const domain = address.slice(at + 1).toLowerCase().replace(/\.$/, "");

  const match = LOCAL_PART_PATTERN.exec(local_part);
  if (!match) return { ok: false, reason: "recipient_carries_no_reply_token" };

  return { ok: true, token: `${REPLY_TOKEN_VERSION}.${match[1]}`, domain };
}

/**
 * Find a reply token among ALL the recipients an inbound message carries.
 *
 * The envelope recipient is checked first and is the only one that proves where
 * the mail was actually DELIVERED. To and Cc are seller-controlled text: a
 * seller can put anything in them, including another seller's alias they were
 * once copied on. Checking them at all is a concession to mail clients that
 * populate the envelope poorly, and the result says which field it came from so
 * the resolver can weigh it accordingly.
 *
 * Two DIFFERENT tokens across the recipients is a refusal, not a preference.
 * Picking one would be choosing which seller's conversation to attribute a
 * message to on the strength of field ordering.
 */
export function findReplyTokenInRecipients(raw_input) {
  const { envelope_to = null, to = [], cc = [] } = asObject(raw_input);
  const envelope = extractReplyToken(envelope_to);
  if (envelope.ok) return { ...envelope, source: "envelope_to" };

  const listed = [];
  for (const [source, values] of [["to", to], ["cc", cc]]) {
    for (const value of Array.isArray(values) ? values : [values]) {
      const found = extractReplyToken(typeof value === "object" ? value?.address ?? value?.email : value);
      if (found.ok) listed.push({ ...found, source });
    }
  }

  if (!listed.length) return { ok: false, reason: "no_reply_token_in_recipients" };

  const distinct = new Set(listed.map((entry) => entry.token));
  if (distinct.size > 1) {
    return {
      ok: false,
      reason: "multiple_distinct_reply_tokens",
      tokens: [...distinct],
    };
  }

  return listed[0];
}

/**
 * A stable, non-reversible fingerprint of an alias, safe to put in a log line.
 *
 * The alias is a bearer credential: logging it in full would let anyone with log
 * access inject messages into a seller's conversation. The fingerprint is enough
 * to correlate two log lines about the same alias without being usable as one.
 */
export function replyTokenFingerprint(token) {
  const raw = clean(token);
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
}

export default { generateReplyToken, buildReplyAddress, extractReplyToken, findReplyTokenInRecipients };
