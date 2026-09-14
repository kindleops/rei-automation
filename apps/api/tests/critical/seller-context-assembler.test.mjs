/**
 * seller-context-assembler.test.mjs
 *
 * Context is the most dangerous input in the system: it is the one place where
 * data about other properties, other sellers and other conversations can leak
 * into a prompt. It is also what makes "I could do 180" legible — a counteroffer
 * if we asked about 165 last week, an opening price if we did not.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  assembleExtractionContext,
  hashContext,
  CONTEXT_LIMITS,
  FORBIDDEN_CONTEXT_FIELDS,
} from "../../src/lib/domain/seller-intelligence/context-assembler.js";

const BASE = {
  current_message: { channel: "email", text: "I could do 180.", received_at: "2026-09-14T10:00:00Z" },
  conversation: { opportunity_id: "opp-1", property_id: "prop-1", master_owner_id: "own-1", acquisition_stage: "asking_price" },
  prior_messages: [
    { direction: "outbound", channel: "sms", text: "Would you consider $165k?", sent_at: "2026-09-13T10:00:00Z" },
  ],
};

// ── it makes a short reply legible ────────────────────────────────────────

test("our last question is carried, because it is what makes '180' mean something", () => {
  const result = assembleExtractionContext(BASE);
  assert.equal(result.ok, true);
  assert.match(result.context.last_outbound_text, /165k/);
});

test("direction and order survive, because the same numbers reversed mean something else", () => {
  const result = assembleExtractionContext(BASE);
  assert.equal(result.context.prior_messages[0].direction, "outbound");
});

test("what we currently believe is included, so a new statement can be read against it", () => {
  const result = assembleExtractionContext({
    ...BASE,
    current_assertions: [{ type: "seller_price_expectation", basis: "explicit", value: { amount: 205000 } }],
  });
  assert.equal(result.context.current_assertions[0].type, "seller_price_expectation");
});

// ── bounded ───────────────────────────────────────────────────────────────

test("prior messages are bounded, and the drop is RECORDED", () => {
  // "The model did not see the message where they first named a price" is a
  // real explanation for a wrong answer, and it has to be reconstructable.
  const result = assembleExtractionContext({
    ...BASE,
    prior_messages: Array.from({ length: 50 }, (_, i) => ({ direction: "inbound", text: `msg ${i}` })),
  });
  assert.equal(result.context.prior_messages.length, CONTEXT_LIMITS.MAX_PRIOR_MESSAGES);
  const dropped = result.excluded.find((e) => e.what === "prior_messages");
  assert.equal(dropped.dropped, 50 - CONTEXT_LIMITS.MAX_PRIOR_MESSAGES);
});

test("an enormous message is truncated rather than sent whole", () => {
  const result = assembleExtractionContext({
    ...BASE,
    current_message: { ...BASE.current_message, text: "x".repeat(100_000) },
  });
  assert.ok(result.context.current_message.text.length <= CONTEXT_LIMITS.MAX_CURRENT_MESSAGE_CHARS);
});

test("prior message text is bounded separately and more tightly", () => {
  const result = assembleExtractionContext({
    ...BASE,
    prior_messages: [{ direction: "inbound", text: "y".repeat(50_000) }],
  });
  assert.ok(result.context.prior_messages[0].text.length <= CONTEXT_LIMITS.MAX_MESSAGE_CHARS);
});

// ── allowlisted, never spread ─────────────────────────────────────────────

test("a conversation row's extra columns do NOT reach the context", () => {
  // A row gains columns, and a spread gains them silently -- which is how a
  // prompt acquires an internal note nobody decided to include.
  const result = assembleExtractionContext({
    ...BASE,
    conversation: {
      ...BASE.conversation,
      internal_note: "seller was rude to the last rep",
      owner_phone: "+15550000001",
      recommended_cash_offer: 142000,
      api_key: "sk-live-do-not-leak",
    },
  });

  const serialized = JSON.stringify(result.context);
  assert.equal(serialized.includes("rude to the last rep"), false);
  assert.equal(serialized.includes("+15550000001"), false);
  assert.equal(serialized.includes("142000"), false);
  assert.equal(serialized.includes("sk-live"), false);
});

test("no forbidden field name appears anywhere in an assembled context", () => {
  const result = assembleExtractionContext({
    ...BASE,
    conversation: Object.fromEntries(FORBIDDEN_CONTEXT_FIELDS.map((f) => [f, "LEAKED"])),
  });
  const serialized = JSON.stringify(result.context);
  assert.equal(serialized.includes("LEAKED"), false);
  for (const field of FORBIDDEN_CONTEXT_FIELDS) {
    assert.equal(serialized.includes(`"${field}"`), false, `${field} reached the context`);
  }
});

test("our own economics never reach the extractor", () => {
  // Its job is to read the seller. Knowing our floor can only bias that.
  const result = assembleExtractionContext({
    ...BASE,
    economics: { recommended_cash_offer: 142000, minimum_acceptable_offer: 120000, arv: 260000 },
  });
  const serialized = JSON.stringify(result.context);
  for (const value of ["142000", "120000", "260000"]) {
    assert.equal(serialized.includes(value), false, `${value} leaked into the prompt context`);
  }
});

test("other properties belonging to this owner are not included", () => {
  // A landlord with six houses must not have six addresses in a prompt about
  // one of them.
  const result = assembleExtractionContext({
    ...BASE,
    other_properties: [{ property_id: "prop-2", address: "123 Elm St" }],
  });
  assert.equal(JSON.stringify(result.context).includes("prop-2"), false);
  assert.equal(JSON.stringify(result.context).includes("Elm St"), false);
});

// ── channel independence, by construction ─────────────────────────────────

test("SMS and email produce BYTE-IDENTICAL semantic context", () => {
  // This is the mechanism behind the channel-independence proof, not a hope
  // about it.
  const sms = assembleExtractionContext({
    ...BASE,
    current_message: { channel: "sms", text: "I could do 180.", received_at: "2026-09-14T10:00:00Z" },
  });
  const email = assembleExtractionContext({
    ...BASE,
    current_message: { channel: "email", text: "I could do 180.", received_at: "2026-09-14T11:30:00Z" },
  });

  assert.equal(sms.context_hash, email.context_hash);
});

test("channel appears only as provenance, never as meaning", () => {
  const result = assembleExtractionContext(BASE);
  // Exactly one channel field in what the model reads about the current message.
  assert.equal(result.context.current_message.channel, "email");
  // And the hash ignores it.
  const other = assembleExtractionContext({
    ...BASE,
    current_message: { ...BASE.current_message, channel: "voice" },
  });
  assert.equal(result.context_hash, other.context_hash);
});

test("DIFFERENT words produce a different hash", () => {
  // Otherwise the hash would prove nothing at all.
  const a = assembleExtractionContext(BASE);
  const b = assembleExtractionContext({
    ...BASE,
    current_message: { ...BASE.current_message, text: "I could do 190." },
  });
  assert.notEqual(a.context_hash, b.context_hash);
});

test("a different conversation produces a different hash", () => {
  const a = assembleExtractionContext(BASE);
  const b = assembleExtractionContext({
    ...BASE,
    conversation: { ...BASE.conversation, property_id: "prop-999" },
  });
  assert.notEqual(a.context_hash, b.context_hash);
});

// ── deterministic ─────────────────────────────────────────────────────────

test("the same inputs produce the same context and hash, every time", () => {
  // Which is the entire reason a stored context_hash is worth anything.
  const runs = Array.from({ length: 5 }, () => assembleExtractionContext(BASE));
  const hashes = new Set(runs.map((r) => r.context_hash));
  assert.equal(hashes.size, 1);
  assert.equal(
    new Set(runs.map((r) => JSON.stringify(r.context))).size,
    1
  );
});

test("the hash is a full sha256, not a truncation", () => {
  assert.match(assembleExtractionContext(BASE).context_hash, /^[0-9a-f]{64}$/);
});

// ── refusal and hostile input ─────────────────────────────────────────────

test("no current message text is a refusal, not an empty context", () => {
  for (const current_message of [{}, { text: "" }, { text: "   " }, null]) {
    const result = assembleExtractionContext({ ...BASE, current_message });
    assert.equal(result.ok, false, JSON.stringify(current_message));
    assert.equal(result.reason, "no_current_message_text");
    assert.equal(result.context, null);
  }
});

test("assembly never throws on hostile input", () => {
  const nasty = [
    null, undefined, "", 0, [], "string",
    { current_message: "nope" }, { current_message: { text: "hi" }, prior_messages: "nope" },
    { current_message: { text: "hi" }, prior_messages: [null, 0, "x"] },
    { current_message: { text: "hi" }, current_assertions: "nope" },
    { current_message: { text: "hi" }, conversation: [] },
  ];
  for (const value of nasty) {
    assert.doesNotThrow(() => assembleExtractionContext(value), JSON.stringify(value));
  }
});

test("hashing never throws", () => {
  for (const value of [null, undefined, "", 0, [], { prior_messages: "nope" }]) {
    assert.doesNotThrow(() => hashContext(value), String(value));
  }
});

test("a malformed prior message is normalized rather than dropped silently", () => {
  const result = assembleExtractionContext({ ...BASE, prior_messages: [{ direction: "sideways" }] });
  // An unknown direction becomes `inbound` rather than propagating a value
  // nothing downstream understands.
  assert.equal(result.context.prior_messages[0].direction, "inbound");
});
