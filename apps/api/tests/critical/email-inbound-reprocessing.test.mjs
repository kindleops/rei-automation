/**
 * email-inbound-reprocessing.test.mjs
 *
 * "DISABLED" MUST NOT MEAN "RETURN 200 AND THROW THE SELLER'S REPLY AWAY."
 *
 * The inbound kill switch exists so an operator can stop PROCESSING without
 * stopping RECEIVING. That distinction is the whole point: a switch that
 * discarded mail would make turning it on again a decision to lose everything
 * that arrived while it was off, which means nobody would ever turn it on.
 *
 * So the ordering is load-bearing and pinned here:
 *
 *   1. the receipt is written FIRST, before the switch is even read
 *   2. the switch then decides whether to go further
 *   3. a held event keeps its payload and its event key, so it can be replayed
 *   4. replaying a PROCESSED event does not create a second seller message
 *
 * Point 4 is what makes reprocessing safe to run bluntly: an operator draining a
 * backlog does not have to work out which events were already handled.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ingestInboundEmail,
  buildInboundEventKey,
  INBOUND_KILL_SWITCH_KEY,
} from "../../src/lib/domain/email/inbound/ingest-inbound-email.js";
import { createBrevoInboundProvider } from "../../src/lib/domain/email/inbound/brevo-inbound-adapter.js";
import { TRUST_CLASS } from "../../src/lib/domain/communications/callback-trust-policy.js";

const provider = createBrevoInboundProvider();

function normalize(payload) {
  const result = provider.normalizeInbound(payload);
  assert.equal(result.ok, true, result.reason);
  return result.normalized;
}

const REPLY = {
  Uuid: "reprocess-0001",
  From: { Address: "seller@example.org", Name: "J. Doe" },
  To: [{ Address: "r1.aaaaaaaabbbbbbbbccccccccdddddddd@reply.example.net" }],
  RecipientAddress: "r1.aaaaaaaabbbbbbbbccccccccdddddddd@reply.example.net",
  Subject: "Re: your offer",
  RawTextBody: "Yes, still interested.",
  MessageId: "<seller-reprocess-1@mail.example.org>",
};

/**
 * A recording store. Every method the ingest path may call is present, so a
 * missing method never silently no-ops a step this file claims to be testing.
 */
function recordingStore({ enabled = true, existing = new Map() } = {}) {
  const calls = { events: [], updates: [], messages: [], attachments: [], emitted: [], alias_lookups: [] };
  let next_id = 1;

  return {
    calls,
    async getSystemFlag(key) {
      assert.equal(key, INBOUND_KILL_SWITCH_KEY);
      return enabled;
    },
    async recordInboundEvent(input) {
      calls.events.push(input);
      if (existing.has(input.event_key)) {
        return { ok: true, duplicate: true, inbound_event_id: existing.get(input.event_key) };
      }
      const id = `evt-${next_id++}`;
      existing.set(input.event_key, id);
      return { ok: true, duplicate: false, inbound_event_id: id };
    },
    async updateInboundEvent(input) { calls.updates.push(input); return { ok: true }; },
    async recordMalformed(input) { calls.events.push({ malformed: true, ...input }); return { ok: true }; },
    // A resolving alias, so these tests exercise the PROCESSED path. The
    // unresolved path has its own file; mixing them here would let a test claim
    // "no second message was created" when in fact no first one was either.
    async findReplyAlias(token) {
      calls.alias_lookups.push(token);
      return {
        id: "alias-1",
        is_active: true,
        opportunity_id: "11111111-1111-4111-8111-111111111111",
        master_owner_id: "owner-1",
        property_id: "prop-1",
      };
    },
    async findCommunicationsByMessageIds() { return []; },
    async findConversationsForSender() { return []; },
    async createInboundMessage(input) {
      calls.messages.push(input);
      return { ok: true, inbound_message_id: `msg-${calls.messages.length}` };
    },
    async ingestAttachments(input) {
      calls.attachments.push(input);
      return { stored: 0, quarantined: 0, failed: 0 };
    },
    async emitCommunicationEvent(event) { calls.emitted.push(event); return { ok: true }; },
  };
}

const INPUT = () => ({
  normalized: normalize(REPLY),
  trust_class: TRUST_CLASS.AUTHENTICATED,
  now: "2026-09-08T12:00:00.000Z",
});

// ── the receipt comes first ─────────────────────────────────────────────────

test("with ingestion DISABLED the reply is still received and stored", async () => {
  const store = recordingStore({ enabled: false });
  const outcome = await ingestInboundEmail(INPUT(), store);

  assert.equal(store.calls.events.length, 1, "the receipt was not written");
  assert.equal(outcome.held, true);
  // ok:true so Brevo stops retrying. The reply is KEPT, not discarded.
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reason, "inbound_ingestion_disabled");
});

test("a HELD reply creates no seller message and emits no event", async () => {
  const store = recordingStore({ enabled: false });
  await ingestInboundEmail(INPUT(), store);

  assert.equal(store.calls.messages.length, 0);
  assert.equal(store.calls.emitted.length, 0);
});

test("the receipt is written BEFORE the kill switch is read", async () => {
  // If the switch were consulted first, turning it off would discard replies
  // rather than holding them -- and the held state would be a lie.
  const order = [];
  const store = recordingStore({ enabled: false });
  const wrapped = {
    ...store,
    async recordInboundEvent(input) { order.push("receipt"); return store.recordInboundEvent(input); },
    async getSystemFlag(key) { order.push("kill_switch"); return store.getSystemFlag(key); },
  };
  await ingestInboundEmail(INPUT(), wrapped);
  assert.deepEqual(order, ["receipt", "kill_switch"]);
});

test("a held event keeps a stable key, so the SAME reply replays to the same row", async () => {
  const key_a = buildInboundEventKey(normalize(REPLY));
  const key_b = buildInboundEventKey(normalize(REPLY));
  assert.equal(key_a, key_b);
  assert.match(key_a, /^brevo_in:/);
});

// ── reprocessing after the switch comes back on ─────────────────────────────

test("re-delivering a HELD reply once ingestion is enabled processes it", async () => {
  // The state an operator is actually in after a backlog: the event exists, it
  // was held, and the switch is now on.
  const existing = new Map();
  await ingestInboundEmail(INPUT(), recordingStore({ enabled: false, existing }));

  // A fresh store that does NOT know the key, standing in for a reprocessing
  // job that reads held rows and runs them through the pipeline again.
  const rerun = recordingStore({ enabled: true });
  const outcome = await ingestInboundEmail(INPUT(), rerun);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.held, undefined);
  assert.equal(rerun.calls.messages.length, 1, "the held reply was never turned into a message");
});

// ── replaying a processed event is harmless ────────────────────────────────

test("re-delivering an ALREADY PROCESSED reply creates no second seller message", async () => {
  // This is what makes a blunt reprocessing pass safe: an operator draining a
  // backlog need not work out which events were already handled.
  const existing = new Map();
  const store = recordingStore({ enabled: true, existing });

  const first = await ingestInboundEmail(INPUT(), store);
  assert.equal(first.ok, true);
  assert.equal(store.calls.messages.length, 1);

  const second = await ingestInboundEmail(INPUT(), store);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(store.calls.messages.length, 1, "a replay created a second seller message");
});

test("a duplicate reports the FIRST receipt's id, so the two are linkable", async () => {
  const existing = new Map();
  const store = recordingStore({ enabled: true, existing });
  const first = await ingestInboundEmail(INPUT(), store);
  const second = await ingestInboundEmail(INPUT(), store);
  assert.equal(second.inbound_event_id, first.inbound_event_id);
});

test("a DIFFERENT reply in the same conversation is not swallowed as a duplicate", async () => {
  // The failure mode on the other side of de-duplication: over-matching, which
  // silently drops a seller's second message.
  const existing = new Map();
  const store = recordingStore({ enabled: true, existing });

  await ingestInboundEmail(INPUT(), store);
  const second = await ingestInboundEmail({
    ...INPUT(),
    normalized: normalize({
      ...REPLY,
      Uuid: "reprocess-0002",
      RawTextBody: "Actually, make that Thursday.",
      MessageId: "<seller-reprocess-2@mail.example.org>",
    }),
  }, store);

  assert.equal(second.duplicate, undefined);
  assert.equal(store.calls.messages.length, 2);
});

// ── a receipt we cannot store is the one case that asks for a retry ─────────

test("a receipt that cannot be stored asks the caller to fail, never to accept", async () => {
  // Answering 200 here would tell Brevo the message was accepted and stop it
  // retrying, and the reply would be gone with nothing recording it existed.
  const store = {
    ...recordingStore(),
    async recordInboundEvent() { return { ok: false, reason: "database_unreachable" }; },
  };
  const outcome = await ingestInboundEmail(INPUT(), store);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.retryable, true);
});

test("a message that cannot be persisted also asks for a retry", async () => {
  const store = recordingStore({ enabled: true });
  const outcome = await ingestInboundEmail(INPUT(), {
    ...store,
    async createInboundMessage() { return { ok: false, reason: "persist_failed" }; },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.retryable, true);
});

test("an UNAUTHENTICATED receipt is rejected and never becomes a seller message", async () => {
  const store = recordingStore({ enabled: true });
  const outcome = await ingestInboundEmail(
    { ...INPUT(), trust_class: TRUST_CLASS.UNAUTHENTICATED },
    store
  );
  assert.equal(outcome.ok, false);
  assert.equal(store.calls.messages.length, 0);
  // Still RECORDED, though: an unauthenticated callback is evidence of an
  // attempt, and dropping it silently would erase the only trace of a probe.
  assert.ok(store.calls.events.length >= 1);
});

// ── an unmatched reply is HELD, not filed, and still readable ──────────────

function unresolvingStore() {
  const store = recordingStore({ enabled: true });
  return {
    ...store,
    calls: store.calls,
    // No alias, no header match, no sender candidate: the reply is authentic and
    // there is nothing to attach it to.
    async findReplyAlias() { return null; },
    async findCommunicationsByMessageIds() { return []; },
    async findConversationsForSender() { return []; },
  };
}

test("an UNMATCHED reply is stored as a readable message with no conversation", async () => {
  // Deciding which conversation an unmatched reply belongs to means READING it,
  // and an operator cannot read what was never normalized. So the message row is
  // written -- with null anchors, which is what "not filed" actually means.
  const store = unresolvingStore();
  const outcome = await ingestInboundEmail(INPUT(), store);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.needs_review, true);
  assert.equal(store.calls.messages.length, 1, "the seller's words were not kept in readable form");

  const message = store.calls.messages[0];
  assert.equal(message.conversation, null);
  assert.equal(message.needs_review, true);
  // The body was normalized, so a review UI reads a field rather than re-deriving
  // the rules -- two implementations of the same rules will drift.
  assert.match(message.body.newest_reply, /still interested/);
});

test("an unmatched reply is NOT marked processed, so it stays in the review queue", async () => {
  // "Processed" is a claim that the reply reached the conversation it belongs
  // to. Marking it processed would hide it from exactly the queue it needs to be
  // in.
  const store = unresolvingStore();
  await ingestInboundEmail(INPUT(), store);

  const final_update = store.calls.updates.at(-1);
  assert.equal(final_update.processing_status, "received");
  assert.notEqual(final_update.processing_status, "processed");
  assert.match(final_update.processing_reason, /awaiting_review/);
});

test("an unmatched reply emits NO communication event", async () => {
  // Evidence is evidence OF a conversation, and there is not one yet. Emitting
  // against a null conversation would put an unattributed reply into a stream
  // whose consumers reasonably assume every entry belongs somewhere.
  const store = unresolvingStore();
  await ingestInboundEmail(INPUT(), store);
  assert.equal(store.calls.emitted.length, 0);
});

test("the unmatched verdict and its reason are recorded on the receipt", async () => {
  const store = unresolvingStore();
  await ingestInboundEmail(INPUT(), store);

  const resolution_update = store.calls.updates.find((u) => "resolution_status" in u);
  assert.equal(resolution_update.resolution_status, "unmatched");
  // The reply named an alias we could not find, which is louder than naming no
  // alias at all and must be recorded as such.
  assert.equal(resolution_update.resolution_reason, "reply_token_unknown");
});

test("an unmatched reply is still de-duplicated on replay", async () => {
  const existing = new Map();
  const base = recordingStore({ enabled: true, existing });
  const store = {
    ...base,
    calls: base.calls,
    async findReplyAlias() { return null; },
    async findCommunicationsByMessageIds() { return []; },
    async findConversationsForSender() { return []; },
  };

  await ingestInboundEmail(INPUT(), store);
  const second = await ingestInboundEmail(INPUT(), store);
  assert.equal(second.duplicate, true);
  assert.equal(store.calls.messages.length, 1);
});
