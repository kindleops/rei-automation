import assert from "node:assert/strict";
import { threadMatchesBucketFilter } from "../../src/lib/domain/inbox/inbox-bucket-predicates.js";
import { resolveOutboundReplyState } from "../../src/lib/domain/inbox/resolve-waiting-cold-state.js";

const NOW = Date.parse("2026-06-24T12:00:00.000Z");
const hoursAgo = (hours) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();

assert.equal(threadMatchesBucketFilter({
  inbox_bucket: "follow_up",
  latest_message_direction: "outbound",
  last_outbound_at: hoursAgo(2),
  last_inbound_at: hoursAgo(5),
}, "waiting", NOW), true);

assert.equal(threadMatchesBucketFilter({
  inbox_bucket: "waiting",
  latest_message_direction: "outbound",
  last_outbound_at: hoursAgo(30),
  last_inbound_at: null,
}, "waiting", NOW), false, "stale waiting bucket must not match without reply inside 24h");

assert.equal(threadMatchesBucketFilter({
  inbox_bucket: "follow_up",
  latest_message_direction: "outbound",
  last_outbound_at: hoursAgo(30),
  last_inbound_at: null,
}, "waiting", NOW), false);

assert.equal(threadMatchesBucketFilter({
  inbox_bucket: "waiting",
  latest_message_direction: "inbound",
  last_inbound_at: hoursAgo(1),
  last_outbound_at: hoursAgo(5),
}, "waiting", NOW), false, "inbound reply removes thread from waiting");

assert.equal(threadMatchesBucketFilter({
  inbox_bucket: "follow_up",
  latest_message_direction: "outbound",
  last_outbound_at: hoursAgo(30),
  last_inbound_at: null,
}, "cold", NOW), true);

assert.equal(threadMatchesBucketFilter({
  inbox_bucket: "cold",
  automation_lane: "cold_reactivation",
  latest_message_direction: "outbound",
  last_outbound_at: hoursAgo(30),
}, "cold", NOW), true);

assert.equal(threadMatchesBucketFilter({
  inbox_bucket: "waiting",
  latest_message_direction: "outbound",
  last_outbound_at: hoursAgo(2),
  last_inbound_at: null,
}, "cold", NOW), false, "recent outbound belongs in waiting not cold");

assert.equal(threadMatchesBucketFilter({
  inbox_bucket: "follow_up",
  latest_message_direction: "inbound",
  last_inbound_at: hoursAgo(1),
  last_outbound_at: hoursAgo(5),
  is_read: false,
}, "new_replies", NOW), true);

assert.equal(threadMatchesBucketFilter({
  inbox_bucket: "new_replies",
  latest_message_direction: "outbound",
  last_outbound_at: hoursAgo(1),
  last_inbound_at: hoursAgo(5),
}, "new_replies", NOW), false, "stale new_replies bucket with outbound latest must not match");

assert.equal(threadMatchesBucketFilter({
  inbox_bucket: "new_replies",
  latest_message_direction: "inbound",
  last_inbound_at: hoursAgo(1),
  last_outbound_at: hoursAgo(5),
  wrong_number: true,
}, "new_replies", NOW), false, "wrong_number inbound must not match new_replies");

const recentOutboundState = resolveOutboundReplyState({
  lastOutboundAt: hoursAgo(2),
  lastInboundAt: null,
  now: NOW,
});
assert.equal(recentOutboundState.inbox_bucket, "waiting");
assert.equal(recentOutboundState.automation_lane, null);

const staleOutboundState = resolveOutboundReplyState({
  lastOutboundAt: hoursAgo(30),
  lastInboundAt: null,
  now: NOW,
});
assert.equal(staleOutboundState.inbox_bucket, "cold");
assert.equal(staleOutboundState.automation_lane, "cold_reactivation");

console.log("PASS inbox-bucket-predicates.test.mjs");