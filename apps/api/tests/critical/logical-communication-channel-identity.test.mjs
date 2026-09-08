/**
 * logical-communication-channel-identity.test.mjs
 *
 * CHANNEL IS PART OF A COMMUNICATION'S IDENTITY (lck_v2).
 *
 * THE DEFECT THIS CLOSES.
 *   Every anchor set in the logical key is channel-blind. campaign_target_id +
 *   touch_number, decision_id, follow_up_id and offer_id + offer_version all
 *   describe a domain action without saying how it travels. Under lck_v1,
 *   "touch 3 of target T by SMS" and "touch 3 of target T by email" hashed to
 *   the SAME key and resolved to ONE logical communication.
 *
 *   That has two possible outcomes and both are unrecoverable:
 *     the email is REFUSED as a duplicate attempt on the SMS communication, or
 *     the email ADOPTS the SMS attempt's provider evidence and delivery state.
 *
 *   Neither can be detected after the fact, because by then there is a single
 *   row that looks perfectly consistent.
 *
 * These tests are written as PROPERTIES rather than fixtures: a future anchor
 * type added without a channel component would fail the sweep at the bottom.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLogicalCommunicationKey,
  isLogicalCommunicationKey,
  COMMUNICATION_TYPES,
  COMMUNICATION_CHANNELS,
  LOGICAL_COMMUNICATION_KEY_VERSION,
} from "@/lib/domain/communications/logical-communication-key.js";
import { resolveQueueRowIdentity } from "@/lib/domain/communications/queue-row-identity.js";

const campaignTouch = (over = {}) => ({
  communication_type: COMMUNICATION_TYPES.CAMPAIGN_TOUCH,
  campaign_target_id: "11111111-1111-4111-8111-111111111111",
  touch_number: "3",
  ...over,
});

// ── the collision, closed ───────────────────────────────────────────────────

test("the SAME campaign touch on SMS and on email are DIFFERENT communications", () => {
  const sms = buildLogicalCommunicationKey(campaignTouch({ channel: "sms" }));
  const email = buildLogicalCommunicationKey(campaignTouch({ channel: "email" }));
  assert.equal(sms.ok, true);
  assert.equal(email.ok, true);
  assert.notEqual(sms.key, email.key,
    "one key for two channels means the second channel is refused as a duplicate");
});

test("the collision is closed for EVERY anchor type, not just campaign touches", () => {
  const cases = [
    { communication_type: COMMUNICATION_TYPES.AUTONOMOUS_REPLY, decision_id: "d-1" },
    { communication_type: COMMUNICATION_TYPES.CLARIFICATION_REPLY, decision_id: "d-1" },
    { communication_type: COMMUNICATION_TYPES.NEGOTIATION_REPLY, decision_id: "d-1" },
    { communication_type: COMMUNICATION_TYPES.MONETARY_OFFER, offer_id: "offer:o1:v2", offer_version: "2" },
    { communication_type: COMMUNICATION_TYPES.CAMPAIGN_TOUCH, campaign_target_id: "t-1", touch_number: "1" },
    { communication_type: COMMUNICATION_TYPES.FOLLOW_UP, follow_up_id: "f-1" },
    { communication_type: COMMUNICATION_TYPES.REFERRAL_OUTREACH, referral_id: "r-1", source_event_id: "e-1" },
    { communication_type: COMMUNICATION_TYPES.UNKNOWN_INBOUND_REPLY, message_event_id: "m-1" },
    { communication_type: COMMUNICATION_TYPES.MANUAL_OPERATOR_SEND, operator_action_id: "op-1" },
    { communication_type: COMMUNICATION_TYPES.INTERNAL_CANARY, canary_run_id: "c-1", canary_leg: "s1" },
  ];

  for (const base of cases) {
    const sms = buildLogicalCommunicationKey({ ...base, channel: "sms" });
    const email = buildLogicalCommunicationKey({ ...base, channel: "email" });
    assert.equal(sms.ok, true, `sms key refused for ${base.communication_type}`);
    assert.equal(email.ok, true, `email key refused for ${base.communication_type}`);
    assert.notEqual(sms.key, email.key,
      `${base.communication_type} still collides across channels`);
  }
});

// ── channel is required, never defaulted ────────────────────────────────────

test("a caller that does not name its channel is REFUSED, not defaulted to SMS", () => {
  // Defaulting would file an email caller's action as SMS and re-open the
  // collision silently, which is worse than the original bug because it looks
  // like it works.
  const result = buildLogicalCommunicationKey(campaignTouch());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_communication_channel");
});

test("an unknown channel is refused rather than minting a new namespace", () => {
  for (const channel of ["e-mail", "emails", "voice", "whatsapp", " "]) {
    const result = buildLogicalCommunicationKey(campaignTouch({ channel }));
    assert.equal(result.ok, false, `accepted bogus channel ${JSON.stringify(channel)}`);
  }
});

test("channel is case-insensitive but canonicalised in the result", () => {
  const upper = buildLogicalCommunicationKey(campaignTouch({ channel: "EMAIL" }));
  const lower = buildLogicalCommunicationKey(campaignTouch({ channel: "email" }));
  assert.equal(upper.key, lower.key);
  assert.equal(upper.channel, COMMUNICATION_CHANNELS.EMAIL);
});

// ── the version bump is real, and the shape still holds ─────────────────────

test("the key version is bumped, so v1 and v2 keys can never be compared", () => {
  assert.equal(LOGICAL_COMMUNICATION_KEY_VERSION, "lck_v2");
  const result = buildLogicalCommunicationKey(campaignTouch({ channel: "sms" }));
  assert.ok(result.key.startsWith("lck_v2:"));
  assert.equal(result.version, "lck_v2");
});

test("the key still satisfies the database's shape constraint", () => {
  for (const channel of Object.values(COMMUNICATION_CHANNELS)) {
    const result = buildLogicalCommunicationKey(campaignTouch({ channel }));
    assert.ok(isLogicalCommunicationKey(result.key), `bad shape for ${channel}`);
    assert.match(result.key, /^lck_v[0-9]+:[a-z_]+:[0-9a-f]{64}$/);
  }
});

test("the channel appears in the returned anchors, so the store can persist it", () => {
  const result = buildLogicalCommunicationKey(campaignTouch({ channel: "email" }));
  assert.equal(result.anchors.channel, "email");
});

// ── everything lck_v1 guaranteed is still guaranteed ────────────────────────

test("a retry still produces the same key", () => {
  const a = buildLogicalCommunicationKey(campaignTouch({ channel: "email", attempt_number: 1 }));
  const b = buildLogicalCommunicationKey(campaignTouch({ channel: "email", attempt_number: 9 }));
  assert.equal(a.key, b.key);
});

test("a template rotation still produces the same key", () => {
  const a = buildLogicalCommunicationKey(campaignTouch({
    channel: "email", template_id: "tpl-A", subject: "Offer on your house",
  }));
  const b = buildLogicalCommunicationKey(campaignTouch({
    channel: "email", template_id: "tpl-B", subject: "Totally different subject",
  }));
  assert.equal(a.key, b.key, "rewording a touch must not authorise a second email");
});

test("rotating the SENDER does not create a new communication", () => {
  // The email twin of "a different TextGrid number is the same message".
  const a = buildLogicalCommunicationKey(campaignTouch({
    channel: "email", from_email: "ryan@a.com", sender_key: "a",
  }));
  const b = buildLogicalCommunicationKey(campaignTouch({
    channel: "email", from_email: "ryan@b.com", sender_key: "b",
  }));
  assert.equal(a.key, b.key);
});

test("a missing anchor still refuses", () => {
  const result = buildLogicalCommunicationKey({
    communication_type: COMMUNICATION_TYPES.CAMPAIGN_TOUCH, channel: "email",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_required_anchors");
});

// ── the SMS queue resolver states its channel rather than leaving it implicit ─

test("the send_queue resolver stamps channel=sms on every derivable action", () => {
  const rows = [
    { campaign_target_id: "t-1", touch_number: 2 },
    { metadata: { decision_id: "d-1" } },
    { metadata: { follow_up_id: "f-1" } },
    { metadata: { operator_action_id: "op-1" } },
    { metadata: { canary_run_id: "c-1", canary_leg: "s1" } },
    { message_type: "initial_offer", metadata: { use_case: "initial_offer", offer_id: "offer:o:v1", offer_version: "1" } },
  ];
  for (const row of rows) {
    const identity = resolveQueueRowIdentity(row);
    assert.equal(identity.ok, true, `resolver refused ${JSON.stringify(row)}`);
    assert.equal(identity.anchors.channel, "sms");
    assert.equal(identity.lineage.channel, "sms");
  }
});

test("a send_queue row still produces a buildable key end to end", () => {
  const identity = resolveQueueRowIdentity({ campaign_target_id: "t-9", touch_number: 4 });
  const key = buildLogicalCommunicationKey({
    communication_type: identity.communication_type,
    ...identity.anchors,
  });
  assert.equal(key.ok, true, `key refused: ${key.reason}`);
  assert.equal(key.channel, "sms");
});

test("a bound row still short-circuits without needing a channel", () => {
  const identity = resolveQueueRowIdentity({ logical_communication_id: "abc" });
  assert.equal(identity.bound, true);
  assert.equal(identity.logical_communication_id, "abc");
});
