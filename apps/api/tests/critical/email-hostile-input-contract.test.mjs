/**
 * email-hostile-input-contract.test.mjs
 *
 * ONE DEFECT CLASS, COVERED ONCE.
 *
 * `function f(input = {})` defaults an UNDEFINED argument and does nothing at
 * all for a NULL one. That single omission has now been a live defect six times
 * in this codebase -- the SMS queue identity resolver (which threw in
 * production), the email queue identity resolver, the inbound thread resolver,
 * the reply-alias store, the body normalizer and the message classifier.
 *
 * Fixing each as it surfaced was fixing instances of a class. This file covers
 * the class: every public entry point in the email domain is called with the
 * full set of hostile shapes, and none of them may throw.
 *
 * WHY THROWING IS THE WRONG FAILURE HERE.
 *   These functions sit on paths that decide whether a seller gets contacted or
 *   whether their reply is filed. A TypeError escaping one of them can be caught
 *   by a caller and mistaken for a transport error -- which is precisely the
 *   reading that justifies a RETRY. So a null argument that throws does not
 *   merely fail; it can turn into a duplicate send or a swallowed reply.
 *
 * A REFUSAL IS THE CORRECT ANSWER, not an exception and not a cheerful default.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolveEmailQueueRowIdentity } from "../../src/lib/domain/email/email-queue-row-identity.js";
import { evaluateEmailSenderReadiness } from "../../src/lib/domain/email/email-sender-readiness.js";
import { evaluateEmailOutreachEligibility } from "../../src/lib/domain/email/email-outreach-eligibility.js";
import { verifyBrevoWebhook } from "../../src/lib/domain/email/brevo-webhook-verification.js";
import { normalizeEmailAddress } from "../../src/lib/domain/email/normalize-email-address.js";
import { buildReplyAddress, extractReplyToken, findReplyTokenInRecipients } from "../../src/lib/domain/email/reply-address.js";
import {
  buildEmailEventKey,
  normalizeBrevoWebhookPayload,
} from "../../src/lib/domain/email/reconcile-email-provider-event.js";
import { classifyInboundMessage } from "../../src/lib/domain/email/inbound/inbound-message-classification.js";
import { normalizeInboundBody, htmlToText } from "../../src/lib/domain/email/inbound/inbound-body-normalization.js";
import { sanitizeInboundHtml } from "../../src/lib/domain/email/inbound/inbound-html-sanitizer.js";
import { resolveInboundThread } from "../../src/lib/domain/email/inbound/resolve-inbound-thread.js";
import { buildInboundEventKey } from "../../src/lib/domain/email/inbound/ingest-inbound-email.js";
import { createBrevoInboundProvider } from "../../src/lib/domain/email/inbound/brevo-inbound-adapter.js";
import { buildLogicalCommunicationKey } from "../../src/lib/domain/communications/logical-communication-key.js";
import { resolveQueueRowIdentity } from "../../src/lib/domain/communications/queue-row-identity.js";

/**
 * The shapes a caller can actually produce. `null` leads, because it is the one
 * that `= {}` does not catch and the one every instance of this defect was.
 */
const HOSTILE = [
  ["null", null],
  ["undefined", undefined],
  ["empty string", ""],
  ["non-empty string", "not an object"],
  ["zero", 0],
  ["number", 42],
  ["false", false],
  ["true", true],
  ["array", []],
  ["populated array", [1, 2, 3]],
  ["empty object", {}],
  ["object of nulls", { headers: null, from: null, to: null, metadata: null }],
  ["object of wrong types", { headers: "x", from: 7, to: "y", metadata: [] }],
];

const inbound_provider = createBrevoInboundProvider();

/**
 * Every PURE entry point, as (name, fn). Async and IO-bearing entry points are
 * covered in their own suites where their collaborators can be injected.
 */
const ENTRY_POINTS = [
  ["resolveEmailQueueRowIdentity", (v) => resolveEmailQueueRowIdentity(v)],
  ["resolveQueueRowIdentity (sms)", (v) => resolveQueueRowIdentity(v)],
  ["evaluateEmailSenderReadiness", (v) => evaluateEmailSenderReadiness(v)],
  ["evaluateEmailOutreachEligibility", (v) => evaluateEmailOutreachEligibility(v)],
  ["verifyBrevoWebhook", (v) => verifyBrevoWebhook(v)],
  ["normalizeEmailAddress", (v) => normalizeEmailAddress(v)],
  ["buildReplyAddress", (v) => buildReplyAddress(v)],
  ["extractReplyToken", (v) => extractReplyToken(v)],
  ["findReplyTokenInRecipients", (v) => findReplyTokenInRecipients(v)],
  ["buildEmailEventKey", (v) => buildEmailEventKey(v, v)],
  ["normalizeBrevoWebhookPayload", (v) => normalizeBrevoWebhookPayload(v)],
  ["classifyInboundMessage", (v) => classifyInboundMessage(v)],
  ["normalizeInboundBody", (v) => normalizeInboundBody(v)],
  ["htmlToText", (v) => htmlToText(v)],
  ["sanitizeInboundHtml", (v) => sanitizeInboundHtml(v)],
  ["resolveInboundThread", (v) => resolveInboundThread(v)],
  ["buildInboundEventKey", (v) => buildInboundEventKey(v)],
  ["buildLogicalCommunicationKey", (v) => buildLogicalCommunicationKey(v)],
  ["brevoInbound.normalizeInbound", (v) => inbound_provider.normalizeInbound(v)],
  ["brevoInbound.verify", (v) => inbound_provider.verify(v)],
  ["brevoInbound.splitBatch", (v) => inbound_provider.splitBatch(v)],
];

for (const [name, call] of ENTRY_POINTS) {
  test(`${name} refuses hostile input instead of throwing`, () => {
    for (const [shape, value] of HOSTILE) {
      assert.doesNotThrow(
        () => call(value),
        `${name} threw on ${shape}`
      );
    }
  });
}

test("every entry point returns SOMETHING for every hostile shape", () => {
  // A function that returns undefined has told the caller nothing, and a caller
  // that reads `.ok` off undefined throws one frame later -- which is the same
  // defect wearing a different hat.
  for (const [name, call] of ENTRY_POINTS) {
    for (const [shape, value] of HOSTILE) {
      const result = call(value);
      assert.notEqual(result, undefined, `${name} returned undefined for ${shape}`);
    }
  }
});

test("no entry point reports SUCCESS on a null argument", () => {
  // The dangerous inverse of throwing: a cheerful default that lets a caller
  // proceed as though a decision was made. Anything with an `ok` field must say
  // false; anything else must not fabricate an identity.
  const permissive = new Set([
    // These legitimately succeed on empty input: an empty batch is a valid
    // batch, empty HTML sanitizes to nothing, and an empty body is a real
    // outcome a seller can produce by replying with only an attachment.
    "brevoInbound.splitBatch",
    "sanitizeInboundHtml",
    "normalizeInboundBody",
    "htmlToText",
  ]);

  // Two modules in this domain spell `ok` as "the evaluation completed" and put
  // the actual verdict in a different field -- `ready` and `eligible`. Both
  // callers in the dispatch path read the right one; this map records which,
  // because asserting the wrong field would either fail spuriously or, worse,
  // pass while the real verdict said the opposite.
  const VERDICT_FIELD = {
    evaluateEmailSenderReadiness: "ready",
    evaluateEmailOutreachEligibility: "eligible",
  };

  for (const [name, call] of ENTRY_POINTS) {
    if (permissive.has(name)) continue;
    const result = call(null);
    const field = VERDICT_FIELD[name] || "ok";
    if (result && typeof result === "object" && field in result) {
      assert.equal(result[field], false, `${name} reported ${field}:true for null`);
    }
  }
});

test("a null sender is NOT ready, and a null recipient is NOT eligible", () => {
  // Pinned separately because the two-meanings-of-ok shape is exactly the kind
  // of thing a later refactor collapses by accident -- and collapsing it the
  // wrong way turns "we could not evaluate" into "go ahead and send".
  const readiness = evaluateEmailSenderReadiness(null);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.reason, "a refusal must name its reason");

  const eligibility = evaluateEmailOutreachEligibility(null);
  assert.equal(eligibility.eligible, false);
  assert.ok(eligibility.reason, "a refusal must name its reason");
});

// ── the same class, on the async and IO-bearing entry points ────────────────
//
// The pure functions above are the easy half. These take collaborators, so a
// null argument reaches further before it is read -- which is exactly why the
// defect kept surviving here: the throw happens inside a promise, and a caller's
// try/catch turns it into a generic failure that reads like a transport error.

import { createInboundEmailStore } from "../../src/lib/domain/email/inbound/inbound-email-store.js";
import { ingestInboundEmail } from "../../src/lib/domain/email/inbound/ingest-inbound-email.js";
import { resolveConversationReplyAddress } from "../../src/lib/domain/email/reply-alias-store.js";
import { dispatchEmailQueueRow } from "../../src/lib/domain/email/dispatch-email-queue-row.js";

/** A Supabase stand-in that answers everything without a network call. */
const inert_supabase = {
  from() {
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      limit: async () => ({ data: [], error: null }),
      insert: () => chain,
      update: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
    };
    return chain;
  },
};

const ASYNC_ENTRY_POINTS = (() => {
  const store = createInboundEmailStore({ supabase: inert_supabase, fetch_impl: async () => null });
  return [
    ["store.recordInboundEvent", (v) => store.recordInboundEvent(v)],
    ["store.updateInboundEvent", (v) => store.updateInboundEvent(v)],
    ["store.recordMalformed", (v) => store.recordMalformed(v)],
    ["store.createInboundMessage", (v) => store.createInboundMessage(v)],
    ["store.ingestAttachments", (v) => store.ingestAttachments(v)],
    ["store.emitCommunicationEvent", (v) => store.emitCommunicationEvent(v)],
    // `deps` IS the store: ingestInboundEmail calls its methods directly. An
    // earlier version of this line wrapped it as `{ store }`, which made every
    // optional call a silent no-op and proved far less than it looked like.
    ["ingestInboundEmail", (v) => ingestInboundEmail(v, store)],
    [
      "resolveConversationReplyAddress",
      (v) => resolveConversationReplyAddress(v, {
        supabase: inert_supabase, reply_domain: "reply.example.net", getSystemFlag: async () => true,
      }),
    ],
    [
      "dispatchEmailQueueRow",
      (v) => dispatchEmailQueueRow(v, {
        supabase: inert_supabase,
        getSystemFlag: async () => true,
        resolveEligibility: async () => ({ eligible: false, reason: "test" }),
        loadSender: async () => null,
        resolveReplyAddress: async () => ({ ok: false, degrade: true, reason: "test" }),
        store: { getOrCreateLogicalCommunication: async () => ({ ok: false }), allocateAttempt: async () => ({ ok: false }) },
      }),
    ],
  ];
})();

for (const [name, call] of ASYNC_ENTRY_POINTS) {
  test(`${name} refuses hostile input instead of rejecting`, async () => {
    for (const [shape, value] of HOSTILE) {
      await assert.doesNotReject(() => call(value), `${name} rejected on ${shape}`);
    }
  });
}

test("no async entry point reports a SEND or a STORE on a null argument", async () => {
  // The dangerous inverse of throwing. `dispatchEmailQueueRow(null)` reporting
  // sent:true would be a fabricated send; an ingest reporting ok:true would be a
  // seller reply recorded as filed when nothing was written.
  const dispatch = await dispatchEmailQueueRow(null, {
    supabase: inert_supabase,
    getSystemFlag: async () => true,
    resolveEligibility: async () => ({ eligible: true }),
    loadSender: async () => null,
    resolveReplyAddress: async () => ({ ok: false, degrade: true, reason: "test" }),
    store: { getOrCreateLogicalCommunication: async () => ({ ok: false }), allocateAttempt: async () => ({ ok: false }) },
  });
  assert.equal(dispatch.ok, false);
  assert.equal(dispatch.sent, false);
  assert.equal(dispatch.provider_invoked, false);

  const ingest = await ingestInboundEmail(null, createInboundEmailStore({ supabase: inert_supabase }));
  assert.equal(ingest?.ok, false);
});
