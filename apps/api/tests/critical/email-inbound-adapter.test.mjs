/**
 * email-inbound-adapter.test.mjs
 *
 * The one file that knows what a Brevo payload looks like.
 *
 * Brevo's field spellings differ across their API revisions, so the adapter
 * reads several per field rather than betting on one. That tolerance is only
 * safe if it is exercised: a reader that silently accepts nothing looks
 * identical to a reader that works, right up until a seller's reply arrives with
 * the other spelling and is discarded as malformed.
 *
 * Everything here is a pure shape test. No IO, no store, no decisions.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createBrevoInboundProvider } from "../../src/lib/domain/email/inbound/brevo-inbound-adapter.js";

const provider = createBrevoInboundProvider();

function ok(payload) {
  const result = provider.normalizeInbound(payload);
  assert.equal(result.ok, true, `refused: ${result.reason}`);
  return result.normalized;
}

// ── the batch envelope ──────────────────────────────────────────────────────

test("an array of items is a batch", () => {
  assert.equal(provider.splitBatch([{ a: 1 }, { b: 2 }]).length, 2);
});

test("an object with `items` is a batch", () => {
  assert.equal(provider.splitBatch({ items: [{ a: 1 }] }).length, 1);
});

test("a single object is a batch of one, because their test button sends one", () => {
  assert.equal(provider.splitBatch({ From: "a@example.net" }).length, 1);
});

test("anything else is an empty batch, never a crash", () => {
  for (const value of [null, undefined, "", 0, "string", true]) {
    assert.deepEqual(provider.splitBatch(value), [], String(value));
  }
});

// ── sender addresses, in every shape they arrive in ────────────────────────

test("a sender is read from a bare string", () => {
  assert.equal(ok({ From: "seller@example.net" }).from.email, "seller@example.net");
});

test("a sender is read from a display-name string", () => {
  const normalized = ok({ From: '"Sam Seller" <seller@example.net>' });
  assert.equal(normalized.from.email, "seller@example.net");
  assert.equal(normalized.from.name, "Sam Seller");
});

test("a sender is read from either object casing", () => {
  assert.equal(ok({ From: { Address: "a@example.net", Name: "A" } }).from.email, "a@example.net");
  assert.equal(ok({ from: { address: "b@example.net", name: "B" } }).from.email, "b@example.net");
  assert.equal(ok({ From: { Email: "c@example.net" } }).from.email, "c@example.net");
});

test("a sender is read from the headers when no field carries it", () => {
  assert.equal(ok({ Headers: { From: "d@example.net" } }).from.email, "d@example.net");
});

test("an address is lowercased, because a mailbox is not case-sensitive to us", () => {
  assert.equal(ok({ From: "Seller@Example.NET" }).from.email, "seller@example.net");
});

test("NO sender at all is a refusal, not a message with a blank field", () => {
  // A message that cannot be attributed, replied to or explained is not a
  // message we can hold; it is a payload to quarantine.
  for (const payload of [{}, { Subject: "hi" }, { From: "" }, { From: { Address: "" } }]) {
    const result = provider.normalizeInbound(payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(result.reason, "inbound_payload_missing_sender");
  }
});

// ── the envelope recipient is the only field that proves delivery ──────────

test("the envelope recipient is read from any of its spellings", () => {
  for (const payload of [
    { From: "a@example.net", RecipientAddress: "r@reply.example.net" },
    { From: "a@example.net", recipient: "r@reply.example.net" },
    { From: "a@example.net", DeliveredTo: "r@reply.example.net" },
    { From: "a@example.net", Headers: { "Delivered-To": "r@reply.example.net" } },
    { From: "a@example.net", Headers: { "X-Envelope-To": "r@reply.example.net" } },
  ]) {
    assert.equal(ok(payload).envelope_to, "r@reply.example.net", JSON.stringify(payload));
  }
});

test("To and Cc are kept but are NOT the envelope, because a seller controls them", () => {
  const normalized = ok({
    From: "a@example.net",
    To: [{ Address: "forged@reply.example.net" }],
    Cc: ["cc@example.net"],
  });
  assert.equal(normalized.envelope_to, null, "seller-controlled To must not become the envelope");
  assert.equal(normalized.to[0].email, "forged@reply.example.net");
  assert.equal(normalized.cc[0].email, "cc@example.net");
});

// ── headers ─────────────────────────────────────────────────────────────────

test("headers are read from an object map and lowercased", () => {
  const normalized = ok({ From: "a@example.net", Headers: { "Auto-Submitted": "auto-replied" } });
  assert.equal(normalized.headers["auto-submitted"], "auto-replied");
});

test("headers are read from an array of name/value pairs", () => {
  const normalized = ok({
    From: "a@example.net",
    Headers: [{ Name: "List-Id", Value: "<news.example.org>" }],
  });
  assert.equal(normalized.headers["list-id"], "<news.example.org>");
});

test("a repeated header keeps the LAST value, which is the one closest to us", () => {
  const normalized = ok({
    From: "a@example.net",
    Headers: { Received: ["from far away", "from our own edge"] },
  });
  assert.equal(normalized.headers.received, "from our own edge");
});

test("References is split on whitespace and commas, keeping only Message-ID shapes", () => {
  const normalized = ok({
    From: "a@example.net",
    References: "<a@x.example.net> <b@x.example.net>,\n<c@x.example.net> not-an-id",
  });
  assert.deepEqual(normalized.references, ["<a@x.example.net>", "<b@x.example.net>", "<c@x.example.net>"]);
});

test("an absent References is an empty list, never null", () => {
  assert.deepEqual(ok({ From: "a@example.net" }).references, []);
});

// ── the provider event id excludes the sender's Message-ID ─────────────────

test("a provider id is read from Brevo's own field", () => {
  assert.equal(ok({ From: "a@example.net", Uuid: "brevo-1" }).provider_event_id, "brevo-1");
  assert.equal(ok({ From: "a@example.net", uuid: "brevo-2" }).provider_event_id, "brevo-2");
  assert.equal(ok({ From: "a@example.net", id: "brevo-3" }).provider_event_id, "brevo-3");
});

test("the RFC Message-ID is NEVER used as a provider event id", () => {
  // It is chosen by the SENDER's mail client. A hostile sender could pin it to a
  // value already ingested and suppress their own reply, or vary it per retry
  // and defeat de-duplication entirely.
  const normalized = ok({ From: "a@example.net", MessageId: "<sender-chosen@example.org>" });
  assert.equal(normalized.provider_event_id, null);
  // It is still RECORDED, because RFC threading needs it.
  assert.equal(normalized.rfc_message_id, "<sender-chosen@example.org>");
});

// ── bodies ──────────────────────────────────────────────────────────────────

test("text and html parts are read from every spelling", () => {
  assert.equal(ok({ From: "a@example.net", RawTextBody: "t" }).text_body, "t");
  assert.equal(ok({ From: "a@example.net", TextBody: "t" }).text_body, "t");
  assert.equal(ok({ From: "a@example.net", text: "t" }).text_body, "t");
  assert.equal(ok({ From: "a@example.net", RawHtmlBody: "<p>h</p>" }).html_body, "<p>h</p>");
  assert.equal(ok({ From: "a@example.net", HtmlBody: "<p>h</p>" }).html_body, "<p>h</p>");
});

test("the provider's own reply extraction is kept SEPARATE from the body", () => {
  // It is the provider's opinion. The original body remains the record.
  const normalized = ok({
    From: "a@example.net",
    RawTextBody: "Yes.\n\nOn Mon someone wrote:\n> ping",
    ExtractedMarkdownMessage: "Yes.",
  });
  assert.equal(normalized.provider_reply_text, "Yes.");
  assert.match(normalized.text_body, /ping/);
});

// ── timestamps ──────────────────────────────────────────────────────────────

test("an ISO timestamp is preserved", () => {
  assert.equal(ok({ From: "a@example.net", ReceivedAt: "2026-09-08T18:05:00Z" }).received_at,
    "2026-09-08T18:05:00.000Z");
});

test("a unix timestamp in seconds is recognised", () => {
  assert.equal(ok({ From: "a@example.net", ReceivedAt: "1789000000" }).received_at,
    new Date(1789000000 * 1000).toISOString());
});

test("a unix timestamp in milliseconds is recognised", () => {
  assert.equal(ok({ From: "a@example.net", ReceivedAt: "1789000000000" }).received_at,
    new Date(1789000000000).toISOString());
});

test("an unparseable timestamp does not become an Invalid Date", () => {
  const normalized = ok({ From: "a@example.net", ReceivedAt: "some time last tuesday" });
  assert.ok(!Number.isNaN(Date.parse(normalized.received_at)), normalized.received_at);
});

// ── attachments ─────────────────────────────────────────────────────────────

test("attachment descriptors are read from every spelling", () => {
  const normalized = ok({
    From: "a@example.net",
    Attachments: [
      { Name: "a.pdf", ContentType: "application/pdf", ContentLength: 10 },
      { filename: "b.jpg", content_type: "image/jpeg", size: 20 },
    ],
  });
  assert.equal(normalized.attachments[0].filename, "a.pdf");
  assert.equal(normalized.attachments[0].byte_size, 10);
  assert.equal(normalized.attachments[1].filename, "b.jpg");
  assert.equal(normalized.attachments[1].content_type, "image/jpeg");
});

test("a non-array Attachments field yields an empty list, not a crash", () => {
  for (const value of [null, "nope", {}, 0]) {
    assert.deepEqual(ok({ From: "a@example.net", Attachments: value }).attachments, [], String(value));
  }
});

// ── the classification runs, and is transport-level only ───────────────────

test("normalization attaches a transport classification and its evidence", () => {
  const normalized = ok({
    From: "a@example.net",
    Headers: { "Auto-Submitted": "auto-replied" },
  });
  assert.equal(normalized.message_class, "auto_reply");
  assert.ok(normalized.classification_reason);
});

// ── the adapter carries no opinions about the seller ───────────────────────

test("normalization decides nothing about a conversation", () => {
  // The adapter's whole job is shape. Anything resembling attribution here
  // would be a decision made where it cannot be tested against candidates.
  const normalized = ok({ From: "a@example.net", Subject: "Re: your offer" });
  for (const forbidden of ["opportunity_id", "master_owner_id", "property_id", "conversation"]) {
    assert.equal(forbidden in normalized, false, `the adapter leaked ${forbidden}`);
  }
});
