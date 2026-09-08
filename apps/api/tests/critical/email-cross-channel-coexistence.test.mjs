/**
 * email-cross-channel-coexistence.test.mjs
 *
 * A SELLER WHO MOVES FROM SMS TO EMAIL IS ONE RELATIONSHIP, NOT TWO.
 *
 * This is the phase's central architectural claim, and it is the kind of claim
 * that is true on the day it is written and quietly false six months later. So
 * it is pinned here from both directions:
 *
 *   CHANNEL BELONGS TO A COMMUNICATION. It is a required component of the
 *   logical communication key, so an SMS and an email that are otherwise
 *   identical are two different communications and cannot collide.
 *
 *   CHANNEL DOES NOT BELONG TO THE CONVERSATION. The opportunity is the seller
 *   relationship, keyed on owner and property, and nothing about it mentions a
 *   channel. If channel ever climbs up into conversation identity, a seller who
 *   answers by email becomes a second lead and an operator negotiates against
 *   themselves.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLogicalCommunicationKey,
  LOGICAL_COMMUNICATION_KEY_VERSION,
  COMMUNICATION_CHANNELS,
} from "../../src/lib/domain/communications/logical-communication-key.js";
import { resolveInboundThread, RESOLUTION_STATUS } from "../../src/lib/domain/email/inbound/resolve-inbound-thread.js";

const OWNER = "owner-cross-1";
const PROPERTY = "prop-cross-1";

// ── channel is part of communication identity ──────────────────────────────

test("the key version is v2, which is the version that carries a channel", () => {
  assert.equal(LOGICAL_COMMUNICATION_KEY_VERSION, "lck_v2");
});

test("SMS and email are recognised channels", () => {
  const channels = Object.values(COMMUNICATION_CHANNELS);
  assert.ok(channels.includes("sms"), "sms missing");
  assert.ok(channels.includes("email"), "email missing");
});

test("the SAME action on two channels yields two DIFFERENT keys", () => {
  // Without this, an email follow-up would collide with the SMS follow-up that
  // preceded it, and one of them would be silently treated as already sent.
  const base = { communication_type: "follow_up", follow_up_id: "fu-1" };
  const sms = buildLogicalCommunicationKey({ ...base, channel: "sms" });
  const email = buildLogicalCommunicationKey({ ...base, channel: "email" });

  assert.equal(sms.ok, true, sms.reason);
  assert.equal(email.ok, true, email.reason);
  assert.notEqual(sms.key, email.key);
  // The channel is also carried on the verdict, so a reader never has to infer
  // it back out of the hash.
  assert.equal(sms.channel, "sms");
  assert.equal(email.channel, "email");
});

test("the same action on the same channel yields the SAME key, twice running", () => {
  const input = { communication_type: "follow_up", follow_up_id: "fu-1", channel: "email" };
  assert.equal(buildLogicalCommunicationKey(input).key, buildLogicalCommunicationKey(input).key);
});

test("a MISSING channel is refused, never defaulted", () => {
  // A default would be the whole defect: every pre-existing row would be read as
  // the defaulted channel, and a cross-channel duplicate guard built on it would
  // fail open exactly when it mattered.
  const result = buildLogicalCommunicationKey({ communication_type: "follow_up", follow_up_id: "fu-1" });
  assert.equal(result.ok, false);
  assert.ok(String(result.reason).includes("channel"), `reason was ${result.reason}`);
});

test("an UNKNOWN channel is refused rather than hashed as-is", () => {
  const result = buildLogicalCommunicationKey({
    communication_type: "follow_up", follow_up_id: "fu-1", channel: "carrier_pigeon",
  });
  assert.equal(result.ok, false);
});

test("channel is checked AFTER the anchors, so the first refusal names the real problem", () => {
  // An action missing both its anchor and its channel should be reported as
  // missing its anchor: that is the fault an operator can actually act on.
  const result = buildLogicalCommunicationKey({ communication_type: "follow_up" });
  assert.equal(result.ok, false);
  assert.equal(String(result.reason).includes("channel"), false, `reason was ${result.reason}`);
});

// ── channel is NOT part of conversation identity ───────────────────────────

test("an inbound email resolves to a conversation that names no channel at all", () => {
  const verdict = resolveInboundThread({
    alias: {
      id: "alias-1",
      is_active: true,
      opportunity_id: "opp-cross-1",
      master_owner_id: OWNER,
      property_id: PROPERTY,
    },
  });

  assert.equal(verdict.status, RESOLUTION_STATUS.RESOLVED);
  // The conversation is owner + property + opportunity. If a `channel` key ever
  // appears here, a seller who switches channel has become two relationships.
  assert.equal("channel" in verdict.conversation, false, "channel leaked into conversation identity");
  assert.deepEqual(Object.keys(verdict.conversation).sort(), [
    "master_owner_id", "opportunity_id", "property_id", "prospect_id", "thread_key",
  ]);
});

test("an SMS thread and an email reply on the same owner and property are ONE conversation", () => {
  // Two candidates that came from different channels but name the same owner and
  // property must NOT be counted as two, or every such seller would land in the
  // ambiguous queue forever.
  const verdict = resolveInboundThread({
    sender_candidates: [
      { opportunity_id: "opp-cross-1", master_owner_id: OWNER, property_id: PROPERTY, thread_key: "+15550000001" },
      { opportunity_id: "opp-cross-1", master_owner_id: OWNER, property_id: PROPERTY, thread_key: "email:seller@example.org" },
    ],
  });

  assert.equal(verdict.status, RESOLUTION_STATUS.RESOLVED);
  assert.equal(verdict.conversation.opportunity_id, "opp-cross-1");
  assert.equal(verdict.candidate_count, 1);
});

test("two DIFFERENT properties for one owner stay two conversations, and refuse", () => {
  // The opposite error. Collapsing these would attach a reply to whichever
  // property happened to sort first.
  const verdict = resolveInboundThread({
    sender_candidates: [
      { opportunity_id: "opp-a", master_owner_id: OWNER, property_id: "prop-a" },
      { opportunity_id: "opp-b", master_owner_id: OWNER, property_id: "prop-b" },
    ],
  });

  assert.equal(verdict.status, RESOLUTION_STATUS.AMBIGUOUS);
  assert.equal(verdict.candidate_count, 2);
  assert.equal(verdict.conversation, null);
});

test("candidates differing ONLY by thread key are the same conversation", () => {
  // related_thread_keys exists precisely so one relationship can carry several
  // threads. Treating a second thread key as a second conversation would make
  // that column meaningless.
  const verdict = resolveInboundThread({
    sender_candidates: [
      { master_owner_id: OWNER, property_id: PROPERTY, thread_key: "t-1" },
      { master_owner_id: OWNER, property_id: PROPERTY, thread_key: "t-2" },
    ],
  });
  assert.equal(verdict.status, RESOLUTION_STATUS.RESOLVED);
});

test("a seller's email reply never mentions which channel we last used", () => {
  // Nothing in a resolution verdict may depend on the channel of the previous
  // message. If it did, an SMS-first seller and an email-first seller would
  // resolve differently from identical evidence.
  //
  // The thread_key is EXPECTED to differ -- it is the candidate's own key, and
  // a phone number looks nothing like an email thread. What must not differ is
  // the verdict: same tier, same reason, same conversation anchors.
  const sms_first = resolveInboundThread({
    sender_candidates: [{ opportunity_id: "opp-1", master_owner_id: OWNER, property_id: PROPERTY, thread_key: "+15550000001" }],
  });
  const email_first = resolveInboundThread({
    sender_candidates: [{ opportunity_id: "opp-1", master_owner_id: OWNER, property_id: PROPERTY, thread_key: "email:x" }],
  });

  assert.equal(sms_first.tier, email_first.tier);
  assert.equal(sms_first.reason, email_first.reason);
  assert.equal(sms_first.status, email_first.status);
  for (const anchor of ["opportunity_id", "master_owner_id", "property_id"]) {
    assert.equal(sms_first.conversation[anchor], email_first.conversation[anchor], anchor);
  }
});
