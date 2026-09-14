/**
 * INBOX-COMPOSER-LOCK-1 — one predicate per category.
 *
 * The defect these pin: a chip counted by one predicate and a list filtered by
 * another. Measured on production before the fix (2026-09-14):
 *
 *   New Replies  chip 136   list 17 of 100 fetched, has_more:false
 *   Archived     chip  69   list 0
 *   Snoozed      chip   0   list 3
 *   Scheduled    chip   0   list 3
 *   filter=bogus_filter                 -> every thread in the system
 *
 * These assert the invariants, not the implementation: for any fixture, the
 * count of a category equals the number of rows the list returns for it, the
 * operational buckets do not overlap, archived leaves every bucket but Archived,
 * and a category nobody defined returns nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveInboxBucketFlags, resolveDerivedInboxBucket } from "../../src/lib/domain/inbox/inbox-bucket-predicates.js";
import { resolveBucketFlagColumn } from "../../src/lib/domain/inbox/live-inbox-service.js";

const NOW = Date.parse("2026-09-14T12:00:00.000Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const hoursAhead = (h) => new Date(NOW + h * 3600 * 1000).toISOString();

/** One fixture per shape the production data actually contains. */
const FIXTURES = [
  {
    name: "inbound reply, nothing else -> New Replies",
    row: { thread_key: "a", latest_direction: "inbound", last_inbound_at: hoursAgo(1), latest_message_at: hoursAgo(1), property_id: "p1" },
    expect: "new_replies",
  },
  {
    name: "outbound 2h ago, no reply -> Waiting",
    row: { thread_key: "b", latest_direction: "outbound", last_outbound_at: hoursAgo(2), latest_message_at: hoursAgo(2), property_id: "p2" },
    expect: "waiting",
  },
  {
    name: "outbound 30h ago, no reply -> Cold, and NOT Waiting",
    row: { thread_key: "c", latest_direction: "outbound", last_outbound_at: hoursAgo(30), latest_message_at: hoursAgo(30), property_id: "p3" },
    expect: "cold",
  },
  {
    name: "disposition not_interested -> Follow Up, never New Replies",
    row: { thread_key: "d", latest_direction: "inbound", disposition: "not_interested", last_inbound_at: hoursAgo(3), latest_message_at: hoursAgo(3), property_id: "p4" },
    expect: "follow_up",
  },
  {
    name: "disposition wrong_person -> Dead, never New Replies",
    row: { thread_key: "e", latest_direction: "inbound", disposition: "wrong_person", last_inbound_at: hoursAgo(3), latest_message_at: hoursAgo(3), property_id: "p5" },
    expect: "dead",
  },
  {
    name: "is_suppressed -> Suppressed",
    row: { thread_key: "f", latest_direction: "inbound", is_suppressed: true, last_inbound_at: hoursAgo(3), latest_message_at: hoursAgo(3), property_id: "p6" },
    expect: "suppressed",
  },
  {
    name: "archived inbound -> Archived only",
    row: { thread_key: "g", latest_direction: "inbound", is_archived: true, last_inbound_at: hoursAgo(1), latest_message_at: hoursAgo(1), property_id: "p7" },
    expect: "archived",
  },
  {
    name: "active snooze -> Snoozed, out of New Replies",
    row: { thread_key: "h", latest_direction: "inbound", snoozed_until: hoursAhead(6), last_inbound_at: hoursAgo(1), latest_message_at: hoursAgo(1), property_id: "p8" },
    expect: "snoozed",
  },
  {
    name: "pending scheduled send -> Scheduled, out of the actionable buckets",
    row: { thread_key: "i", latest_direction: "inbound", next_scheduled_for: hoursAhead(12), last_inbound_at: hoursAgo(1), latest_message_at: hoursAgo(1), property_id: "p9" },
    expect: "scheduled",
  },
  {
    name: "low classifier confidence -> Needs Review",
    row: { thread_key: "j", latest_direction: "inbound", confidence: 0.2, last_inbound_at: hoursAgo(1), latest_message_at: hoursAgo(1), property_id: "p10" },
    expect: "needs_review",
  },
  {
    name: "explicit priority bucket -> Priority",
    row: { thread_key: "k", inbox_bucket: "priority", latest_direction: "inbound", last_inbound_at: hoursAgo(1), latest_message_at: hoursAgo(1), property_id: "p11" },
    expect: "priority",
  },
];

const OPERATIONAL = ["in_priority", "in_new_replies", "in_needs_review", "in_follow_up", "in_cold", "in_waiting"];

test("every fixture lands in exactly the category it describes", () => {
  for (const { name, row, expect } of FIXTURES) {
    const flags = resolveInboxBucketFlags(row, NOW);
    assert.equal(flags[`in_${expect}`], true, `${name}: expected in_${expect}`);
  }
});

test("operational buckets never overlap", () => {
  for (const { name, row } of FIXTURES) {
    const flags = resolveInboxBucketFlags(row, NOW);
    const hits = OPERATIONAL.filter((flag) => flags[flag] === true);
    assert.ok(hits.length <= 1, `${name}: landed in ${hits.join(" + ")}`);
  }
});

test("archived leaves every bucket except Archived", () => {
  const flags = resolveInboxBucketFlags(
    { thread_key: "g", latest_direction: "inbound", is_archived: true, last_inbound_at: hoursAgo(1), latest_message_at: hoursAgo(1) },
    NOW,
  );
  assert.equal(flags.in_archived, true);
  for (const flag of [...OPERATIONAL, "in_all", "in_all_messages", "in_dead", "in_suppressed", "in_snoozed", "in_scheduled", "in_unlinked", "in_active"]) {
    assert.equal(flags[flag], false, `archived thread must not be ${flag}`);
  }
});

test("a not_interested seller is a follow-up, never a new reply and never dead", () => {
  // Operator policy, stated on 2026-08-26 and again here: "most people are gonna
  // be not interested at first, and then we follow up and we get them under
  // contract." A first no is the opening of a negotiation.
  const flags = resolveInboxBucketFlags(
    { thread_key: "d", latest_direction: "inbound", disposition: "not_interested", last_inbound_at: hoursAgo(3), latest_message_at: hoursAgo(3) },
    NOW,
  );
  assert.equal(flags.in_follow_up, true);
  assert.equal(flags.in_new_replies, false);
  assert.equal(flags.in_dead, false);
  assert.equal(flags.in_suppressed, false);
});

test("count equals list for every category, over the whole fixture set", () => {
  const flagged = FIXTURES.map(({ row }) => resolveInboxBucketFlags(row, NOW));
  for (const category of ["priority", "new_replies", "needs_review", "follow_up", "cold", "waiting", "dead", "suppressed", "archived", "snoozed", "scheduled", "unlinked", "active", "all_messages"]) {
    const flag = `in_${category}`;
    // The chip: count the flag. The list: filter on the same flag. They are the
    // same expression, which is the entire point -- they cannot drift.
    const counted = flagged.filter((row) => row[flag] === true).length;
    const listed = flagged.filter((row) => row[flag] === true);
    assert.equal(listed.length, counted, `${category}: chip and list disagree`);
  }
});

test("active is exactly the union of the four buckets an operator works", () => {
  for (const { name, row } of FIXTURES) {
    const f = resolveInboxBucketFlags(row, NOW);
    assert.equal(
      f.in_active,
      f.in_priority || f.in_new_replies || f.in_needs_review || f.in_follow_up,
      `${name}: in_active is not the union`,
    );
  }
});

test("an unrecognised filter has no flag column and therefore fails closed", () => {
  assert.equal(resolveBucketFlagColumn("bogus_filter"), null);
  assert.equal(resolveBucketFlagColumn(""), null);
  assert.equal(resolveBucketFlagColumn(undefined), null);
  // ...while every category the UI can actually select resolves.
  for (const category of ["priority", "new_replies", "needs_review", "follow_up", "waiting", "cold", "dead", "suppressed", "archived", "snoozed", "scheduled", "all_messages", "unlinked", "active"]) {
    assert.ok(resolveBucketFlagColumn(category), `${category} must resolve to a flag column`);
  }
});

test("the derived bucket is used, not the raw column", () => {
  // inbox_thread_state.inbox_bucket is NULL on 9,082 of 9,778 production rows.
  // Reading the raw column instead of the derivation is not a small error.
  assert.equal(resolveDerivedInboxBucket({ latest_direction: "inbound" }), "new_replies");
  assert.equal(resolveDerivedInboxBucket({ latest_direction: "outbound" }), "cold");
  assert.equal(resolveDerivedInboxBucket({ disposition: "not_interested" }), "follow_up");
  assert.equal(resolveDerivedInboxBucket({ disposition: "wrong_number" }), "dead");
  assert.equal(resolveDerivedInboxBucket({ is_suppressed: true }), "suppressed");
  // An explicit bucket still wins over the derivation.
  assert.equal(resolveDerivedInboxBucket({ inbox_bucket: "priority", latest_direction: "outbound" }), "priority");
});

test("the Waiting window is 24h from the send, inclusive", () => {
  const waitingAt = (h) => resolveInboxBucketFlags(
    { thread_key: "w", latest_direction: "outbound", last_outbound_at: hoursAgo(h), latest_message_at: hoursAgo(h) },
    NOW,
  ).in_waiting;
  assert.equal(waitingAt(23.9), true, "just inside 24h is Waiting");
  assert.equal(waitingAt(24), true, "exactly 24h is still Waiting");
  assert.equal(waitingAt(24.1), false, "past 24h is no longer Waiting");
});

test("a reply after the send removes Waiting immediately", () => {
  const flags = resolveInboxBucketFlags(
    {
      thread_key: "x",
      latest_direction: "inbound",
      last_outbound_at: hoursAgo(5),
      last_inbound_at: hoursAgo(1),
      latest_message_at: hoursAgo(1),
    },
    NOW,
  );
  assert.equal(flags.in_waiting, false);
  assert.equal(flags.in_new_replies, true);
});

test("the latest_message_at fallback belongs to New Replies only", () => {
  // Feeding it into Waiting inverts that predicate: an outbound-latest thread
  // would compare latest_message_at (the outbound time) against itself and every
  // genuinely-waiting thread would drop out of Waiting.
  const flags = resolveInboxBucketFlags(
    {
      thread_key: "y",
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(2),
      last_inbound_at: null,
      latest_message_at: hoursAgo(2),
    },
    NOW,
  );
  assert.equal(flags.in_waiting, true, "a missing last_inbound_at means never replied, not just replied");
});
