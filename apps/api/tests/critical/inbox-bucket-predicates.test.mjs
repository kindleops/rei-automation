import assert from "node:assert/strict";
import { threadMatchesBucketFilter } from "../../src/lib/domain/inbox/inbox-bucket-predicates.js";

const NOW = Date.parse("2026-06-24T12:00:00.000Z");
const hoursAgo = (hours) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();

assert.equal(threadMatchesBucketFilter({
  inbox_bucket: "follow_up",
  latest_message_direction: "outbound",
  last_outbound_at: hoursAgo(2),
  last_inbound_at: hoursAgo(5),
}, "waiting", NOW), true);

assert.equal(threadMatchesBucketFilter({
  inbox_bucket: "follow_up",
  latest_message_direction: "outbound",
  last_outbound_at: hoursAgo(30),
}, "waiting", NOW), false);

assert.equal(threadMatchesBucketFilter({
  inbox_bucket: "follow_up",
  latest_message_direction: "inbound",
  last_inbound_at: hoursAgo(1),
  is_read: false,
}, "new_replies", NOW), true);

console.log("PASS inbox-bucket-predicates.test.mjs");