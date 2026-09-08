/**
 * email-queue-row-identity.test.mjs
 *
 * WHICH seller communication does this email_queue row schedule?
 *
 * The rule this file protects is the same one the SMS resolver obeys: the answer
 * may be "I do not know", and that is a REFUSAL. `queue_status = 'queued'` is a
 * scheduling fact, not evidence that a seller should receive a message.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveEmailQueueRowIdentity } from "@/lib/domain/email/email-queue-row-identity.js";
import { resolveQueueRowIdentity } from "@/lib/domain/communications/queue-row-identity.js";
import { buildLogicalCommunicationKey } from "@/lib/domain/communications/logical-communication-key.js";

const TARGET = "11111111-1111-4111-8111-111111111111";

const row = (over = {}) => ({
  id: "eq-1",
  to_email: "Seller@Example.COM",
  master_owner_id: "own-1",
  property_id: "prop-1",
  ...over,
});

// ── every resolver states the channel it speaks for ────────────────────────

test("every derivable action is stamped channel=email", () => {
  const rows = [
    row({ campaign_target_id: TARGET, touch_number: 2 }),
    row({ decision_id: "d-1" }),
    row({ follow_up_id: "f-1" }),
    row({ operator_action_id: "op-1" }),
    row({ message_event_id: "me-1" }),
    row({ use_case: "initial_offer", seller_offer_id: "offer:o:v1", seller_offer_version: 1 }),
  ];
  for (const input of rows) {
    const identity = resolveEmailQueueRowIdentity(input);
    assert.equal(identity.ok, true, `refused ${JSON.stringify(input)}`);
    assert.equal(identity.anchors.channel, "email");
    assert.equal(identity.lineage.channel, "email");
  }
});

test("the email resolver and the SMS resolver disagree about channel, deliberately", () => {
  // Each names the queue it reads. A shared resolver taking a channel argument
  // would have to guess which shape it was looking at, and a resolver that
  // guesses is what lck_v2 exists to remove.
  const email = resolveEmailQueueRowIdentity(row({ campaign_target_id: TARGET, touch_number: 2 }));
  const sms = resolveQueueRowIdentity({ campaign_target_id: TARGET, touch_number: 2 });
  assert.equal(email.anchors.channel, "email");
  assert.equal(sms.anchors.channel, "sms");

  const emailKey = buildLogicalCommunicationKey({ communication_type: email.communication_type, ...email.anchors });
  const smsKey = buildLogicalCommunicationKey({ communication_type: sms.communication_type, ...sms.anchors });
  assert.notEqual(emailKey.key, smsKey.key, "the same touch on two channels must not collide");
});

// ── anchors come from columns, and fall back to metadata ───────────────────

test("a column anchor is preferred, and metadata is the fallback", () => {
  const fromColumn = resolveEmailQueueRowIdentity(row({ decision_id: "d-column" }));
  assert.equal(fromColumn.anchors.decision_id, "d-column");

  // Rows written by an older enqueuer carry their anchors in metadata.
  const fromMetadata = resolveEmailQueueRowIdentity(row({ metadata: { decision_id: "d-meta" } }));
  assert.equal(fromMetadata.anchors.decision_id, "d-meta");

  const both = resolveEmailQueueRowIdentity(row({ decision_id: "d-column", metadata: { decision_id: "d-meta" } }));
  assert.equal(both.anchors.decision_id, "d-column", "a column is a fact; metadata is a hope");
});

// ── precedence ─────────────────────────────────────────────────────────────

test("a priced message is a MONETARY communication even inside a campaign", () => {
  // Binding it to the touch would let a retry deliver a different authorised
  // amount under the same identity.
  const identity = resolveEmailQueueRowIdentity(row({
    campaign_target_id: TARGET, touch_number: 4,
    use_case: "counter_offer", seller_offer_id: "offer:opp-1:v3", seller_offer_version: 3,
  }));
  assert.equal(identity.communication_type, "monetary_offer");
  assert.equal(identity.anchors.offer_id, "offer:opp-1:v3");
  assert.equal(identity.anchors.offer_version, "3");
});

test("a priced message with NO offer authority is refused, never sent", () => {
  const identity = resolveEmailQueueRowIdentity(row({ use_case: "final_offer" }));
  assert.equal(identity.ok, false);
  assert.equal(identity.reason, "monetary_communication_without_offer_authority");
});

test("the offer version is parsed from the offer id when not supplied separately", () => {
  const identity = resolveEmailQueueRowIdentity(row({
    use_case: "initial_offer", seller_offer_id: "offer:opp-9:v7",
  }));
  assert.equal(identity.anchors.offer_version, "7");
});

test("a bound row short-circuits and re-derives nothing", () => {
  const identity = resolveEmailQueueRowIdentity(row({
    logical_communication_id: "lc-42", campaign_target_id: TARGET, touch_number: 1,
  }));
  assert.equal(identity.bound, true);
  assert.equal(identity.logical_communication_id, "lc-42");
  assert.equal(identity.communication_type, undefined, "a bound row's type is a stored fact, not a guess");
});

test("a bound MONETARY row still surfaces its offer, so terms drift can be caught", () => {
  const identity = resolveEmailQueueRowIdentity(row({
    logical_communication_id: "lc-42",
    use_case: "counter_offer", seller_offer_id: "offer:opp-1:v3",
  }));
  assert.equal(identity.bound, true);
  assert.equal(identity.monetary.seller_offer_id, "offer:opp-1:v3");
});

// ── refusals ───────────────────────────────────────────────────────────────

test("a row with no derivable action is REFUSED, not sent because it is queued", () => {
  const identity = resolveEmailQueueRowIdentity(row({ queue_status: "queued" }));
  assert.equal(identity.ok, false);
  assert.equal(identity.reason, "email_queue_row_identity_underivable");
});

test("a campaign touch needs BOTH a target and a positive touch number", () => {
  for (const over of [
    { campaign_target_id: TARGET },
    { touch_number: 3 },
    { campaign_target_id: TARGET, touch_number: 0 },
    { campaign_target_id: TARGET, touch_number: -1 },
    { campaign_target_id: TARGET, touch_number: "not a number" },
    { campaign_target_id: "", touch_number: 3 },
  ]) {
    assert.equal(resolveEmailQueueRowIdentity(row(over)).ok, false,
      `accepted an incomplete campaign anchor: ${JSON.stringify(over)}`);
  }
});

test("resolution never throws, whatever the row looks like", () => {
  for (const value of [undefined, null, {}, { metadata: "not an object" }, { metadata: [] }]) {
    assert.doesNotThrow(() => resolveEmailQueueRowIdentity(value));
  }
});

// ── lineage ────────────────────────────────────────────────────────────────

test("the recipient travels in lineage, normalized to lower case", () => {
  const identity = resolveEmailQueueRowIdentity(row({ decision_id: "d-1" }));
  assert.equal(identity.lineage.to_email, "seller@example.com");
});

test("lineage carries the owner and property, so a send can be explained later", () => {
  const identity = resolveEmailQueueRowIdentity(row({ decision_id: "d-1" }));
  assert.equal(identity.lineage.master_owner_id, "own-1");
  assert.equal(identity.lineage.property_id, "prop-1");
});

test("every identity the resolver returns produces a buildable key", () => {
  const rows = [
    row({ campaign_target_id: TARGET, touch_number: 2 }),
    row({ decision_id: "d-1" }),
    row({ follow_up_id: "f-1" }),
    row({ operator_action_id: "op-1" }),
    row({ message_event_id: "me-1" }),
    row({ use_case: "initial_offer", seller_offer_id: "offer:o:v1" }),
  ];
  for (const input of rows) {
    const identity = resolveEmailQueueRowIdentity(input);
    const key = buildLogicalCommunicationKey({
      communication_type: identity.communication_type,
      ...identity.anchors,
    });
    assert.equal(key.ok, true, `unbuildable key for ${identity.communication_type}: ${key.reason}`);
    assert.equal(key.channel, "email");
  }
});
