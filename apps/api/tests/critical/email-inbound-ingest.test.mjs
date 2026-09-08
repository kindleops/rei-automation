/**
 * email-inbound-ingest.test.mjs
 *
 * The full inbound pipeline, driven by realistic Brevo fixtures.
 *
 * THE SIX DANGEROUS FAILURE MODES, each with tests here:
 *   silent loss              a seller replies and nothing records it
 *   duplicate inbound        a provider retry creates two seller messages
 *   wrong-property           a reply lands on the wrong deal
 *   spoofed mutation         a forged callback creates seller communication
 *   channel fragmentation    email starts a second seller relationship
 *   unsafe content           seller markup or files reach the UI unguarded
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { ingestInboundEmail, buildInboundEventKey, PROCESSING_STATUS }
  from "@/lib/domain/email/inbound/ingest-inbound-email.js";
import { createBrevoInboundProvider } from "@/lib/domain/email/inbound/brevo-inbound-adapter.js";
import { TRUST_CLASS } from "@/lib/domain/communications/callback-trust-policy.js";
import * as fixtures from "../fixtures/brevo-inbound/index.mjs";

const provider = createBrevoInboundProvider();
const OPP = { opportunity_id: "opp-a", master_owner_id: "own-1", property_id: "prop-a", thread_key: "+13125550100" };

function normalize(fixture) {
  const result = provider.normalizeInbound(fixture);
  assert.equal(result.ok, true, `fixture failed to normalize: ${result.reason}`);
  return result.normalized;
}

/** A store double recording everything it was asked to do. */
function makeStore(over = {}) {
  const calls = { events: [], updates: [], messages: [], attachments: [], emitted: [], malformed: [] };
  const seen_keys = new Set();
  let event_seq = 0;

  return {
    calls,
    getSystemFlag: over.getSystemFlag || (async () => true),
    recordInboundEvent: over.recordInboundEvent || (async (payload) => {
      calls.events.push(payload);
      if (seen_keys.has(payload.event_key)) {
        return { ok: true, duplicate: true, inbound_event_id: `evt-${payload.event_key}` };
      }
      seen_keys.add(payload.event_key);
      event_seq += 1;
      return { ok: true, duplicate: false, inbound_event_id: `evt-${event_seq}` };
    }),
    updateInboundEvent: async (patch) => { calls.updates.push(patch); return { ok: true }; },
    recordMalformed: async (payload) => { calls.malformed.push(payload); return { ok: true }; },
    findReplyAlias: over.findReplyAlias || (async () => null),
    findCommunicationsByMessageIds: over.findCommunicationsByMessageIds || (async () => []),
    findConversationsForSender: over.findConversationsForSender || (async () => []),
    createInboundMessage: over.createInboundMessage || (async (payload) => {
      calls.messages.push(payload);
      return { ok: true, inbound_message_id: `msg-${calls.messages.length}` };
    }),
    ingestAttachments: async (payload) => {
      calls.attachments.push(payload);
      return { stored: 0, quarantined: payload.descriptors.length, failed: 0 };
    },
    emitCommunicationEvent: async (event) => { calls.emitted.push(event); return { ok: true }; },
  };
}

const ALIAS = { id: "alias-1", is_active: true, ...OPP };
const withAlias = (over = {}) => makeStore({ findReplyAlias: async () => ALIAS, ...over });

const run = (fixture, store, trust = TRUST_CLASS.AUTHENTICATED) =>
  ingestInboundEmail({ normalized: normalize(fixture), trust_class: trust }, store);

// ── spoofed mutation ───────────────────────────────────────────────────────

test("an UNAUTHENTICATED callback creates no message", async () => {
  const store = withAlias();
  const result = await run(fixtures.plainTextReply(), store, TRUST_CLASS.UNAUTHENTICATED);

  assert.equal(result.ok, false);
  assert.equal(result.processing_status, PROCESSING_STATUS.REJECTED);
  assert.equal(store.calls.messages.length, 0);
  assert.equal(store.calls.emitted.length, 0);
});

test("an unauthenticated callback is still RECORDED as evidence of probing", async () => {
  const store = withAlias();
  await run(fixtures.plainTextReply(), store, TRUST_CLASS.UNAUTHENTICATED);
  assert.equal(store.calls.events.length, 1);
  assert.equal(store.calls.events[0].processing_status, PROCESSING_STATUS.REJECTED);
});

// ── silent loss ────────────────────────────────────────────────────────────

test("the receipt is written BEFORE resolution is attempted", async () => {
  // If resolution throws, the seller's message must still exist.
  const order = [];
  const store = withAlias({
    recordInboundEvent: async () => { order.push("record"); return { ok: true, inbound_event_id: "evt-1" }; },
    findReplyAlias: async () => { order.push("resolve"); return ALIAS; },
  });
  await run(fixtures.plainTextReply(), store);
  assert.deepEqual(order, ["record", "resolve"]);
});

test("a receipt we cannot store asks the provider to RETRY, rather than claiming success", async () => {
  // Answering 200 here would tell Brevo the message was accepted and lose it.
  const store = withAlias({ recordInboundEvent: async () => ({ ok: false, reason: "db_down" }) });
  const result = await run(fixtures.plainTextReply(), store);

  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
});

test("an unresolvable message is KEPT for review, never discarded", async () => {
  const store = makeStore({ findReplyAlias: async () => null, findConversationsForSender: async () => [] });
  const result = await run(fixtures.replyToSenderAddressNotAlias(), store);

  assert.equal(result.ok, true);
  assert.equal(result.needs_review, true);
  assert.equal(result.resolution_status, "unmatched");
  assert.equal(store.calls.events.length, 1, "the receipt must still exist");
  // The message row IS written -- with a null conversation. Deciding where an
  // unmatched reply belongs means reading it, and an operator cannot read what
  // was never normalized. "Not attached" is the null anchors, not a missing row.
  assert.equal(store.calls.messages.length, 1, "the seller's words must be readable");
  assert.equal(store.calls.messages[0].conversation, null, "it must not be filed anywhere");
  assert.equal(store.calls.messages[0].needs_review, true);
});

test("a HELD channel keeps the event and answers ok, so the provider stops retrying", async () => {
  // "Disabled" must never mean "return 200 and throw the seller reply away".
  const store = withAlias({ getSystemFlag: async () => false });
  const result = await run(fixtures.plainTextReply(), store);

  assert.equal(result.ok, true, "answering non-2xx would make Brevo retry until it gave up");
  assert.equal(result.held, true);
  assert.equal(store.calls.events.length, 1, "the event is kept");
  assert.equal(store.calls.messages.length, 0, "and no message is created while held");
  assert.equal(
    store.calls.updates.find((u) => u.processing_status === PROCESSING_STATUS.HELD)?.processing_reason,
    "inbound_ingestion_disabled"
  );
});

test("the hold is applied AFTER the receipt, not before", async () => {
  const store = withAlias({ getSystemFlag: async () => false });
  await run(fixtures.plainTextReply(), store);
  assert.equal(store.calls.events.length, 1,
    "holding before recording would discard the reply");
});

// ── duplicate inbound ──────────────────────────────────────────────────────

test("a redelivered callback creates exactly ONE message", async () => {
  const store = withAlias();
  const first = await run(fixtures.plainTextReply(), store);
  const second = await run(fixtures.plainTextReply(), store);

  assert.equal(first.processing_status, PROCESSING_STATUS.PROCESSED);
  assert.equal(second.duplicate, true);
  assert.equal(second.processing_status, PROCESSING_STATUS.DUPLICATE);
  assert.equal(store.calls.messages.length, 1, "a provider retry created a second seller message");
});

test("the event key is deterministic across redeliveries", async () => {
  assert.equal(
    buildInboundEventKey(normalize(fixtures.plainTextReply())),
    buildInboundEventKey(normalize(fixtures.plainTextReply()))
  );
});

test("the provider's own id is preferred as the key", async () => {
  const key = buildInboundEventKey(normalize(fixtures.plainTextReply()));
  assert.match(key, /^brevo_in:11111111-1111-4111-8111-111111111111$/);
});

test("a payload with NO provider id still gets a stable key, never a random one", async () => {
  const a = buildInboundEventKey(normalize(fixtures.replyWithoutProviderId()));
  const b = buildInboundEventKey(normalize(fixtures.replyWithoutProviderId()));
  assert.equal(a, b);
  assert.match(a, /^brevo_in:[0-9a-f]{40}$/);
});

test("two DIFFERENT messages never share a key", async () => {
  const a = buildInboundEventKey(normalize(fixtures.plainTextReply()));
  const b = buildInboundEventKey(normalize(fixtures.htmlOnlyReply()));
  assert.notEqual(a, b);
});

// ── wrong-property attribution ─────────────────────────────────────────────

test("a reply on a valid alias resolves to that alias's conversation", async () => {
  const store = withAlias();
  const result = await run(fixtures.plainTextReply(), store);

  assert.equal(result.resolution_tier, "tier1_reply_alias");
  assert.equal(result.conversation.opportunity_id, "opp-a");
  assert.equal(store.calls.messages[0].conversation.property_id, "prop-a");
});

test("an UNKNOWN reply token is unmatched, not attached by sender fallback", async () => {
  const store = makeStore({
    findReplyAlias: async () => null,
    // Sender context would happily resolve. It must not be reached.
    findConversationsForSender: async () => [OPP],
  });
  const result = await run(fixtures.unknownReplyToken(), store);

  assert.equal(result.resolution_status, "unmatched");
  // Readable, and filed nowhere. Falling through to sender context here is the
  // exact wrong-property failure this whole path exists to prevent.
  assert.equal(store.calls.messages[0].conversation, null);
  assert.equal(store.calls.emitted?.length ?? 0, 0, "no conversation, so no evidence event");
});

test("ONE SELLER, TWO PROPERTIES is ambiguous and is filed against neither", async () => {
  const store = makeStore({
    findReplyAlias: async () => null,
    findConversationsForSender: async () => [
      { master_owner_id: "own-1", property_id: "prop-a" },
      { master_owner_id: "own-1", property_id: "prop-b" },
    ],
  });
  const result = await run(fixtures.replyToSenderAddressNotAlias(), store);

  assert.equal(result.resolution_status, "ambiguous");
  assert.equal(store.calls.messages[0].conversation, null, "neither property may be picked");
  assert.equal(
    store.calls.updates.find((u) => u.resolution_status === "ambiguous")?.resolution_reason,
    "sender_maps_to_multiple_conversations"
  );
});

// ── channel fragmentation ──────────────────────────────────────────────────

test("an email reply joins the EXISTING conversation rather than starting one", async () => {
  // The conversation is the opportunity. Channel belongs to the communication.
  const store = withAlias();
  const result = await run(fixtures.plainTextReply(), store);

  const persisted = store.calls.messages[0];
  assert.equal(persisted.conversation.opportunity_id, "opp-a");
  assert.equal(persisted.conversation.thread_key, "+13125550100",
    "the SMS thread key: one relationship, two channels");
  assert.equal(result.conversation.master_owner_id, "own-1");
});

// ── unsafe content ─────────────────────────────────────────────────────────

test("hostile HTML is sanitized before it is stored as renderable", async () => {
  const store = withAlias();
  await run(fixtures.maliciousHtmlReply(), store);

  const persisted = store.calls.messages[0];
  assert.match(persisted.html_raw, /<script>/, "the raw form is preserved as evidence");
  assert.doesNotMatch(persisted.html_sanitized || "", /<script|onerror|javascript:|<iframe/i);
  assert.match(persisted.html_sanitized, /Interested, call me/, "the prose survives");
});

test("the seller's words survive sanitization as plain text too", async () => {
  const store = withAlias();
  await run(fixtures.htmlOnlyReply(), store);
  assert.match(store.calls.messages[0].body.normalized_text, /call me at 5pm/);
});

test("attachments are ingested and reported", async () => {
  const store = withAlias();
  const result = await run(fixtures.replyWithAttachment(), store);
  assert.equal(store.calls.attachments.length, 1);
  assert.equal(result.attachments.quarantined, 1);
});

// ── transport classification is not intent ─────────────────────────────────

test("an out-of-office is marked auto_reply even though it QUOTES our offer", async () => {
  // The trap: the quoted text discusses an offer, so a naive intent classifier
  // would see an engaged seller.
  const store = withAlias();
  await run(fixtures.outOfOfficeReply(), store);
  assert.equal(store.calls.messages[0].message_class, "auto_reply");
});

test("a bounce is delivery_status, not auto_reply", async () => {
  const store = withAlias();
  await run(fixtures.deliveryStatusNotification(), store);
  assert.equal(store.calls.messages[0].message_class, "delivery_status");
});

test("list mail is system_or_list", async () => {
  const store = withAlias();
  await run(fixtures.listMail(), store);
  assert.equal(store.calls.messages[0].message_class, "system_or_list");
});

test("an ordinary reply is human_reply", async () => {
  const store = withAlias();
  await run(fixtures.plainTextReply(), store);
  assert.equal(store.calls.messages[0].message_class, "human_reply");
});

// ── no acquisition mutation ────────────────────────────────────────────────

test("ingestion emits communication evidence and NOTHING about acquisition state", async () => {
  const store = withAlias();
  await run(fixtures.plainTextReply(), store);

  assert.equal(store.calls.emitted.length, 1);
  assert.equal(store.calls.emitted[0].type, "communication.email.received");

  // Every field the store was asked to write, flattened. None may look like a
  // lead status, a stage, a temperature or an offer.
  const written = JSON.stringify([store.calls.messages, store.calls.updates, store.calls.emitted]);
  for (const forbidden of [
    "acquisition_stage", "lead_status", "opportunity_status", "temperature",
    "negotiation", "asking_price", "recommended_offer", "next_action", "latest_intent",
  ]) {
    assert.ok(!written.includes(forbidden), `inbound email wrote ${forbidden}`);
  }
});

test("no reply is sent, however interested the seller sounds", async () => {
  const store = withAlias();
  const result = await run(fixtures.plainTextReply(), store);
  assert.equal(result.reply_sent, undefined);
  assert.ok(!("outbound" in result));
});

// ── body handling ──────────────────────────────────────────────────────────

test("quoted history is separated from the newest reply, and both are kept", async () => {
  const store = withAlias();
  await run(fixtures.plainTextReply(), store);
  const body = store.calls.messages[0].body;

  assert.match(body.newest_reply, /Yes, I would consider an offer/);
  assert.doesNotMatch(body.newest_reply, /Would you consider selling/);
  assert.match(body.normalized_text, /Would you consider selling/,
    "the quoted history is still available");
});

test("a text part wins over HTML", async () => {
  const store = withAlias();
  await run(fixtures.textAndHtmlReply(), store);
  assert.match(store.calls.messages[0].body.normalized_text, /Plain text version/);
});

test("unicode survives intact", async () => {
  const store = withAlias();
  await run(fixtures.unicodeReply(), store);
  assert.match(store.calls.messages[0].body.normalized_text, /me interesa/);
});

test("an empty body is stored, not treated as an error", async () => {
  // A seller replying with only an attachment is a real thing.
  const store = withAlias();
  const result = await run(fixtures.emptyBodyReply(), store);
  assert.equal(result.processing_status, PROCESSING_STATUS.PROCESSED);
  assert.equal(store.calls.messages[0].body.is_empty, true);
});

// ── malformed ──────────────────────────────────────────────────────────────

test("a payload with no sender refuses at the adapter, before ingestion", async () => {
  const result = provider.normalizeInbound(fixtures.malformedNoSender());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "inbound_payload_missing_sender");
});

test("ingestion never throws on a hostile normalized payload", async () => {
  for (const normalized of [{}, { from: {} }, { from: { email: "a@b.com" }, attachments: "nope" }]) {
    const store = withAlias();
    await assert.doesNotReject(() =>
      ingestInboundEmail({ normalized, trust_class: TRUST_CLASS.AUTHENTICATED }, store));
  }
});
