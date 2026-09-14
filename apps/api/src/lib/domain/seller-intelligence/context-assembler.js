/**
 * context-assembler.js
 *
 * WHAT THE EXTRACTOR IS ALLOWED TO KNOW.
 *
 * Seller language is not self-contained. "I could do 180" means nothing on its
 * own; it means a counteroffer if we asked about 165 last week, and an opening
 * price if we did not. So the extractor needs context -- and context is the
 * most dangerous input in the system, because it is the one place where data
 * about OTHER properties, OTHER sellers and OTHER conversations can leak into a
 * prompt.
 *
 * ── FOUR PROPERTIES, ALL LOAD-BEARING ─────────────────────────────────────
 *
 *   BOUNDED       a fixed, small number of prior messages. Not "the
 *                 conversation", which grows without limit and eventually costs
 *                 more than it informs.
 *   ALLOWLISTED   named fields, copied one at a time. Never a spread of a
 *                 database row, because a row gains columns and a spread gains
 *                 them silently.
 *   DETERMINISTIC same inputs, same context, every time -- which is what makes
 *                 a recorded context_hash worth anything.
 *   AUDITABLE     the hash is stored with the extraction, so a wrong answer can
 *                 be re-derived from exactly what the model was shown.
 *
 * ── CHANNEL-INDEPENDENT BY CONSTRUCTION ───────────────────────────────────
 *
 * The assembled context has no channel-shaped fields. An SMS and an email
 * carrying the same words, in the same conversation, produce byte-identical
 * context -- which is the mechanism behind the channel-independence proof, not
 * merely a hope about it. Channel appears once, as provenance on the message
 * itself, because "who said what in what order" is meaningful and "which wire
 * it came down" is not.
 *
 * ── WHAT IS DELIBERATELY EXCLUDED ─────────────────────────────────────────
 *
 *   Other properties belonging to this owner. A landlord with six houses must
 *   not have six addresses in a prompt about one of them.
 *   Anything about other sellers, ever.
 *   Internal identifiers beyond what is needed to anchor the conversation.
 *   Our own economics -- MAO, ceilings, assignment fees. The extractor's job is
 *   to read the seller, and knowing our floor can only bias that reading.
 */

import crypto from "node:crypto";
import { asObject } from "@/lib/hostile-input.js";

export const CONTEXT_ASSEMBLER_VERSION = "seller_context_v1";

/** Bounds. Chosen so a long conversation informs without dominating. */
export const CONTEXT_LIMITS = Object.freeze({
  MAX_PRIOR_MESSAGES: 6,
  MAX_MESSAGE_CHARS: 600,
  MAX_CURRENT_MESSAGE_CHARS: 4_000,
  MAX_CURRENT_ASSERTIONS: 12,
});

function clean(value, limit = CONTEXT_LIMITS.MAX_MESSAGE_CHARS) {
  return String(value ?? "").trim().slice(0, limit);
}

/**
 * One prior message, reduced to what helps read the next one.
 *
 * Direction and order are the whole point: "we asked about 165, they said 180"
 * is a counteroffer, and the same two numbers in the other order is not.
 */
function priorMessage(raw) {
  const message = asObject(raw);
  const direction = clean(message.direction, 16).toLowerCase();
  return {
    direction: direction === "outbound" ? "outbound" : "inbound",
    // Channel is provenance, not content. It is recorded so an auditor can see
    // where a message came from, and it is NOT part of what the model reads
    // about meaning.
    channel: clean(message.channel, 16) || null,
    sent_at: clean(message.sent_at ?? message.received_at, 40) || null,
    text: clean(message.text ?? message.body ?? message.newest_reply),
  };
}

/**
 * Assemble the context for one extraction.
 *
 * PURE. Every input is supplied by the caller, so the same conversation always
 * produces the same context and the hash means something.
 *
 * @returns {{ok, context, context_hash, excluded, version}}
 */
export function assembleExtractionContext(raw_input) {
  const input = asObject(raw_input);
  const excluded = [];

  const current = asObject(input.current_message);
  const text = clean(current.text ?? current.newest_reply ?? current.body, CONTEXT_LIMITS.MAX_CURRENT_MESSAGE_CHARS);
  if (!text) {
    return {
      ok: false, reason: "no_current_message_text",
      context: null, context_hash: null, version: CONTEXT_ASSEMBLER_VERSION,
    };
  }

  // ── prior messages, newest first, bounded ────────────────────────────────
  const all_prior = Array.isArray(input.prior_messages) ? input.prior_messages : [];
  if (all_prior.length > CONTEXT_LIMITS.MAX_PRIOR_MESSAGES) {
    // Recorded rather than silently dropped: "the model did not see the message
    // where they first named a price" is a real explanation for a wrong answer.
    excluded.push({ what: "prior_messages", dropped: all_prior.length - CONTEXT_LIMITS.MAX_PRIOR_MESSAGES });
  }
  const prior_messages = all_prior.slice(0, CONTEXT_LIMITS.MAX_PRIOR_MESSAGES).map(priorMessage);

  // ── the conversation, allowlisted field by field ─────────────────────────
  // Never a spread. A row gains columns, and a spread gains them silently --
  // which is how a prompt acquires an internal note or a phone number nobody
  // decided to include.
  const conversation_source = asObject(input.conversation);
  const conversation = {
    opportunity_id: clean(conversation_source.opportunity_id, 64) || null,
    property_id: clean(conversation_source.property_id, 64) || null,
    master_owner_id: clean(conversation_source.master_owner_id, 64) || null,
    acquisition_stage: clean(conversation_source.acquisition_stage, 64) || null,
  };

  // ── what we currently believe, so a new statement can be read against it ─
  const current_assertions = (Array.isArray(input.current_assertions) ? input.current_assertions : [])
    .slice(0, CONTEXT_LIMITS.MAX_CURRENT_ASSERTIONS)
    .map((raw) => {
      const assertion = asObject(raw);
      return {
        type: clean(assertion.type, 64),
        basis: clean(assertion.basis, 32),
        value: assertion.value ?? null,
        asserted_at: clean(assertion.asserted_at, 40) || null,
      };
    })
    .filter((assertion) => assertion.type);

  // ── our last question, which is what makes a short reply legible ─────────
  // "180" answers whatever we last asked. Without this the same word is an
  // opening price, a counteroffer or a house number.
  const last_outbound = prior_messages.find((message) => message.direction === "outbound") || null;

  const context = {
    version: CONTEXT_ASSEMBLER_VERSION,
    conversation,
    current_message: {
      // The channel of the CURRENT message is recorded for provenance and is
      // deliberately the only place a channel appears in what the model reads.
      channel: clean(current.channel, 16) || null,
      received_at: clean(current.received_at ?? current.sent_at, 40) || null,
      text,
    },
    prior_messages,
    last_outbound_text: last_outbound ? last_outbound.text : null,
    current_assertions,
  };

  return {
    ok: true,
    context,
    // Hashed over the SEMANTIC context, with channel provenance removed. Two
    // channels carrying the same conversation hash identically, which is what
    // makes the channel-independence proof a proof rather than an assertion.
    context_hash: hashContext(context),
    excluded,
    version: CONTEXT_ASSEMBLER_VERSION,
  };
}

/**
 * A stable digest of the MEANING of a context.
 *
 * Channel and timestamps are excluded deliberately. Including them would make
 * an SMS and an email hash differently for a conversation that is, to the
 * extractor, identical -- and would make the hash useless for detecting that
 * the same question was asked twice.
 */
export function hashContext(raw_context) {
  const context = asObject(raw_context);
  const semantic = {
    version: context.version,
    conversation: context.conversation,
    current_text: asObject(context.current_message).text,
    prior: (Array.isArray(context.prior_messages) ? context.prior_messages : [])
      .map((message) => `${asObject(message).direction}:${asObject(message).text}`),
    assertions: (Array.isArray(context.current_assertions) ? context.current_assertions : [])
      .map((assertion) => `${asObject(assertion).type}=${JSON.stringify(asObject(assertion).value ?? null)}`),
  };
  return crypto.createHash("sha256").update(JSON.stringify(semantic), "utf8").digest("hex");
}

/**
 * Fields that must NEVER appear in an assembled context.
 *
 * Asserted by a test rather than merely intended. Our own economics are on this
 * list because the extractor's job is to read the seller, and knowing our floor
 * can only bias that reading.
 */
export const FORBIDDEN_CONTEXT_FIELDS = Object.freeze([
  "recommended_cash_offer", "minimum_acceptable_offer", "investor_ceiling_low",
  "investor_ceiling_mid", "investor_ceiling_high", "expected_assignment_fee",
  "mao", "arv", "estimated_repairs", "profit", "spread",
  "other_properties", "other_sellers", "api_key", "secret", "token", "password",
]);

export default assembleExtractionContext;
