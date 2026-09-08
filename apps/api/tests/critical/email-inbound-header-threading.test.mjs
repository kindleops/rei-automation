/**
 * email-inbound-header-threading.test.mjs
 *
 * TIER 2 MUST ACTUALLY BE ABLE TO MATCH.
 *
 * This file exists because it could not. The lookup read
 * `email_queue.rfc_message_id` -- a column that does not exist and that nothing
 * writes. Every query would have errored, been logged, and returned an empty
 * list, so tier 2 would have failed to match forever while looking like it
 * worked. It is the same defect EMAIL-0 found twice in the pre-existing code:
 * a code path targeting a table shape nobody built.
 *
 * A silently-inert tier is worse than an absent one. An absent tier is a known
 * gap; an inert one is a documented control that is not there.
 *
 * The outbound message id lives on the ATTEMPT, recorded by the canonical store
 * at the moment the provider accepted the send. Brevo's transactional messageId
 * is the RFC Message-ID stamped on the outgoing mail, which is what a replying
 * client puts in In-Reply-To -- so the two genuinely meet, and only there.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createInboundEmailStore } from "../../src/lib/domain/email/inbound/inbound-email-store.js";
import { resolveInboundThread, RESOLUTION_TIER, RESOLUTION_STATUS } from "../../src/lib/domain/email/inbound/resolve-inbound-thread.js";

const OUTBOUND_ID = "<outbound-42@smtp-relay.example.net>";
const OTHER_ID = "<outbound-99@smtp-relay.example.net>";

const CONVERSATION = {
  id: "lc-42",
  opportunity_id: "11111111-1111-4111-8111-111111111111",
  master_owner_id: "owner-1",
  property_id: "prop-1",
  thread_key: "thread-1",
};

/** A canonical store stand-in that records what it was asked. */
function canonicalStore({ attempts = { [OUTBOUND_ID]: "lc-42" }, conversations = { "lc-42": CONVERSATION } } = {}) {
  const asked = { message_ids: [], communication_ids: [] };
  return {
    asked,
    async findAttemptByProviderMessageId(id) {
      asked.message_ids.push(id);
      const logical_communication_id = attempts[id];
      return logical_communication_id
        ? { ok: true, logical_communication_id }
        : { ok: false, reason: "no_attempt_for_provider_message_id" };
    },
    async getConversationForLogicalCommunication(id) {
      asked.communication_ids.push(id);
      return conversations[id] || null;
    },
  };
}

const storeWith = (canonical) => createInboundEmailStore({ supabase: { from: () => { throw new Error("no direct table access"); } }, canonical_store: canonical });

// ── the lookup reaches the ledger, and reaches nothing else ────────────────

test("an In-Reply-To naming a message we sent resolves to its conversation", () => {
  const canonical = canonicalStore();
  return storeWith(canonical)
    .findCommunicationsByMessageIds({ in_reply_to: OUTBOUND_ID })
    .then((matches) => {
      assert.equal(matches.length, 1);
      assert.equal(matches[0].opportunity_id, CONVERSATION.opportunity_id);
      assert.equal(matches[0].master_owner_id, "owner-1");
      assert.equal(matches[0].property_id, "prop-1");
      assert.deepEqual(canonical.asked.message_ids, [OUTBOUND_ID]);
    });
});

test("the lookup goes through the canonical store, never at a table directly", async () => {
  // The supabase stand-in throws on any direct access. If this test passes,
  // nothing in the path reached a table itself -- which is the ownership rule
  // direct-callback-state-contract enforces.
  const matches = await storeWith(canonicalStore()).findCommunicationsByMessageIds({ in_reply_to: OUTBOUND_ID });
  assert.equal(matches.length, 1);
});

test("References is searched too, not just In-Reply-To", async () => {
  const canonical = canonicalStore();
  const matches = await storeWith(canonical).findCommunicationsByMessageIds({
    references: ["<someone-elses@example.org>", OUTBOUND_ID],
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].logical_communication_id, "lc-42");
});

test("an id we never sent matches nothing, and is not an error", async () => {
  const matches = await storeWith(canonicalStore()).findCommunicationsByMessageIds({
    in_reply_to: "<never-sent@example.org>",
  });
  assert.deepEqual(matches, []);
});

test("no ids at all short-circuits without touching the ledger", async () => {
  const canonical = canonicalStore();
  const matches = await storeWith(canonical).findCommunicationsByMessageIds({});
  assert.deepEqual(matches, []);
  assert.equal(canonical.asked.message_ids.length, 0);
});

test("duplicate ids across In-Reply-To and References are looked up once", async () => {
  const canonical = canonicalStore();
  await storeWith(canonical).findCommunicationsByMessageIds({
    in_reply_to: OUTBOUND_ID,
    references: [OUTBOUND_ID, OUTBOUND_ID],
  });
  assert.equal(canonical.asked.message_ids.length, 1);
});

test("a long References chain is BOUNDED before any lookup happens", async () => {
  // Each id is a separate ledger read. A hostile References header carrying
  // thousands would otherwise be thousands of queries per inbound message.
  const canonical = canonicalStore();
  const references = Array.from({ length: 500 }, (_, i) => `<flood-${i}@example.org>`);
  await storeWith(canonical).findCommunicationsByMessageIds({ references });
  assert.ok(canonical.asked.message_ids.length <= 25, `made ${canonical.asked.message_ids.length} lookups`);
});

test("an attempt whose conversation cannot be loaded yields no candidate", async () => {
  // A half-populated conversation would let a reply be attributed on partial
  // anchors, which is the wrong-property failure wearing a different hat.
  const canonical = canonicalStore({ conversations: {} });
  const matches = await storeWith(canonical).findCommunicationsByMessageIds({ in_reply_to: OUTBOUND_ID });
  assert.deepEqual(matches, []);
});

test("the lookup never throws on hostile input", async () => {
  const store = storeWith(canonicalStore());
  for (const input of [null, undefined, "", 0, [], { references: "not an array" }, { in_reply_to: {} }]) {
    await assert.doesNotReject(() => store.findCommunicationsByMessageIds(input), String(input));
  }
});

// ── and the resolver then does the right thing with what it gets ───────────

test("one matched conversation resolves at tier 2", () => {
  const verdict = resolveInboundThread({
    header_matches: [CONVERSATION],
  });
  assert.equal(verdict.status, RESOLUTION_STATUS.RESOLVED);
  assert.equal(verdict.tier, RESOLUTION_TIER.RFC_HEADERS);
  assert.equal(verdict.conversation.opportunity_id, CONVERSATION.opportunity_id);
});

test("headers spanning TWO conversations refuse, because a forward has no correct pick", () => {
  const verdict = resolveInboundThread({
    header_matches: [
      CONVERSATION,
      { id: "lc-99", opportunity_id: "22222222-2222-4222-8222-222222222222", master_owner_id: "owner-2", property_id: "prop-2" },
    ],
  });
  assert.equal(verdict.status, RESOLUTION_STATUS.AMBIGUOUS);
  assert.equal(verdict.candidate_count, 2);
});

test("several matched messages from ONE conversation still resolve", () => {
  // A long thread names many of our Message-IDs. That is one conversation
  // mentioned repeatedly, not several conversations.
  const verdict = resolveInboundThread({
    header_matches: [CONVERSATION, { ...CONVERSATION, id: "lc-43" }],
  });
  assert.equal(verdict.status, RESOLUTION_STATUS.RESOLVED);
  assert.equal(verdict.matched_message_count, 2);
});

test("a reply alias still beats RFC headers when both are present", () => {
  // Tier order is by strength of evidence. 128 random bits that only appeared in
  // mail we sent beat a header a client can rewrite.
  const verdict = resolveInboundThread({
    alias: { id: "alias-1", is_active: true, opportunity_id: "alias-opp", master_owner_id: "owner-a" },
    header_matches: [CONVERSATION],
  });
  assert.equal(verdict.tier, RESOLUTION_TIER.REPLY_ALIAS);
  assert.equal(verdict.conversation.opportunity_id, "alias-opp");
});
