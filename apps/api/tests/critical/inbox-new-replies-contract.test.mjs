import test from "node:test";
import assert from "node:assert/strict";

import {
  threadMatchesBucketFilter,
  threadMatchesNewRepliesFacts,
  isStaleExplicitInboxBucket,
} from "../../src/lib/domain/inbox/inbox-bucket-predicates.js";
import {
  buildColdTransitionPatch,
  resolveOutboundReplyState,
} from "../../src/lib/domain/inbox/resolve-waiting-cold-state.js";
import { getLiveCounts } from "../../src/lib/domain/inbox/live-inbox-service.js";

const NOW = Date.parse("2026-06-24T12:00:00.000Z");
const hoursAgo = (hours) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();

const FIXTURES = [
  {
    name: "inbound_unread_clean",
    row: {
      latest_direction: "inbound",
      last_inbound_at: hoursAgo(1),
      last_outbound_at: hoursAgo(5),
      is_read: false,
    },
    buckets: { new_replies: true, priority: false, needs_review: false },
  },
  {
    name: "priority_overlay",
    row: {
      inbox_bucket: "priority",
      latest_direction: "inbound",
      last_inbound_at: hoursAgo(1),
      last_outbound_at: hoursAgo(5),
    },
    buckets: { new_replies: false, priority: true, needs_review: false },
  },
  {
    name: "needs_review_overlay",
    row: {
      inbox_bucket: "needs_review",
      needs_review: true,
      latest_direction: "inbound",
      last_inbound_at: hoursAgo(1),
      last_outbound_at: hoursAgo(5),
    },
    buckets: { new_replies: false, priority: false, needs_review: true },
  },
  {
    name: "stale_new_replies_bucket",
    row: {
      inbox_bucket: "new_replies",
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(1),
      last_inbound_at: hoursAgo(5),
    },
    buckets: { new_replies: false },
  },
  {
    name: "read_inbound",
    row: {
      latest_direction: "inbound",
      last_inbound_at: hoursAgo(1),
      last_outbound_at: hoursAgo(5),
      is_read: true,
    },
    buckets: { new_replies: true },
  },
  {
    name: "suppressed_inbound",
    row: {
      latest_direction: "inbound",
      last_inbound_at: hoursAgo(1),
      last_outbound_at: hoursAgo(5),
      is_suppressed: true,
      opt_out: true,
    },
    buckets: { new_replies: false },
  },
  {
    name: "wrong_number_inbound",
    row: {
      latest_direction: "inbound",
      last_inbound_at: hoursAgo(1),
      last_outbound_at: hoursAgo(5),
      disposition: "wrong_number",
      wrong_number: true,
    },
    buckets: { new_replies: false },
  },
  {
    name: "archived_inbound",
    row: {
      is_archived: true,
      latest_direction: "inbound",
      last_inbound_at: hoursAgo(1),
      last_outbound_at: hoursAgo(5),
    },
    buckets: { new_replies: false },
  },
  {
    name: "waiting_outbound_30h",
    row: {
      inbox_bucket: "waiting",
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(30),
      last_inbound_at: null,
      latest_delivery_status: "delivered",
    },
    buckets: { waiting: false, new_replies: false },
    cold: { inbox_bucket: null, automation_lane: "cold_reactivation" },
  },
];

test("A: inbound newer than outbound, unread, no overlays → New Replies", () => {
  const row = FIXTURES.find((fixture) => fixture.name === "inbound_unread_clean").row;
  assert.equal(threadMatchesNewRepliesFacts(row, NOW), true);
  assert.equal(threadMatchesBucketFilter(row, "new_replies", NOW), true);
});

test("B: inbound thread with Priority overlay → Priority, not New Replies", () => {
  const row = FIXTURES.find((fixture) => fixture.name === "priority_overlay").row;
  assert.equal(threadMatchesBucketFilter(row, "priority", NOW), true);
  assert.equal(threadMatchesBucketFilter(row, "new_replies", NOW), false);
});

test("C: inbound thread with Needs Review overlay → Needs Review, not New Replies", () => {
  const row = FIXTURES.find((fixture) => fixture.name === "needs_review_overlay").row;
  assert.equal(threadMatchesBucketFilter(row, "needs_review", NOW), true);
  assert.equal(threadMatchesBucketFilter(row, "new_replies", NOW), false);
});

test("D: stale persisted new_replies bucket but outbound is latest → not New Replies", () => {
  const row = FIXTURES.find((fixture) => fixture.name === "stale_new_replies_bucket").row;
  assert.equal(isStaleExplicitInboxBucket(row, "new_replies", NOW), true);
  assert.equal(threadMatchesBucketFilter(row, "new_replies", NOW), false);
});

test("E: read/handled inbound → still New Replies under current API policy", () => {
  const row = FIXTURES.find((fixture) => fixture.name === "read_inbound").row;
  assert.equal(threadMatchesBucketFilter(row, "new_replies", NOW), true);
});

test("F: suppressed inbound → not New Replies", () => {
  const row = FIXTURES.find((fixture) => fixture.name === "suppressed_inbound").row;
  assert.equal(threadMatchesBucketFilter(row, "new_replies", NOW), false);
});

test("G: wrong-number inbound → not New Replies", () => {
  const row = FIXTURES.find((fixture) => fixture.name === "wrong_number_inbound").row;
  assert.equal(threadMatchesBucketFilter(row, "new_replies", NOW), false);
});

test("H: archived inbound → not New Replies", () => {
  const row = FIXTURES.find((fixture) => fixture.name === "archived_inbound").row;
  assert.equal(threadMatchesBucketFilter(row, "new_replies", NOW), false);
});

test("I: Waiting outbound crosses 24h → inbox_bucket NULL + automation_lane cold_reactivation", () => {
  const row = FIXTURES.find((fixture) => fixture.name === "waiting_outbound_30h").row;
  const state = resolveOutboundReplyState({
    lastOutboundAt: row.last_outbound_at,
    lastInboundAt: row.last_inbound_at,
    now: NOW,
  });
  assert.equal(state.inbox_bucket, null);
  assert.equal(state.automation_lane, "cold_reactivation");
  assert.equal(threadMatchesBucketFilter(row, "waiting", NOW), false);
});

test("J: cold transition patch passes DB constraint contract", () => {
  const patch = buildColdTransitionPatch({
    inbox_bucket: "waiting",
    lastOutboundAt: hoursAgo(30),
    lastInboundAt: null,
    now: NOW,
  });
  assert.ok(patch);
  assert.equal(patch.inbox_bucket, null);
  assert.equal(patch.automation_lane, "cold_reactivation");
  const allowed = new Set(["priority", "new_replies", "needs_review", "waiting", null]);
  assert.equal(allowed.has(patch.inbox_bucket), true);
});

test("K: counts endpoint does not scan all thread rows", async () => {
  const calls = [];
  const supabase = {
    from(table) {
      calls.push(table);
      const api = {
        select() { return api; },
        eq() { return api; },
        is() { return api; },
        lt() { return api; },
        limit() { return api; },
        order() { return api; },
        range() { return api; },
        async then(resolve) {
          if (table === "v_inbox_thread_counts_live_v2") {
            resolve({
              data: [{
                all: 100,
                all_messages: 95,
                priority: 10,
                new_replies: 20,
                needs_review: 5,
                follow_up: 3,
                cold: 2,
                dead: 1,
                suppressed: 4,
                active: 38,
                waiting: 5,
                unlinked: 7,
              }],
              error: null,
            });
            return;
          }
          resolve({ data: [], error: null, count: 0 });
        },
      };
      return api;
    },
  };

  const counts = await getLiveCounts({}, { supabase });
  assert.equal(counts.new_replies, 20);
  assert.equal(calls.includes("inbox_thread_state"), false);
});

test("L: SQL-equivalent fixtures and JS predicates return identical bucket counts", () => {
  const sqlEquivalent = (row) => {
    const archived = row.is_archived === true;
    const terminal = row.opt_out === true || row.wrong_number === true || row.is_suppressed === true;
    const bucket = String(row.inbox_bucket || "").toLowerCase();
    const direction = String(row.latest_direction || "").toLowerCase();
    const inMs = Date.parse(row.last_inbound_at || 0);
    const outMs = Date.parse(row.last_outbound_at || 0);
    const inboundNewer = inMs > 0 && (outMs <= 0 || inMs >= outMs);

    const priority = bucket === "priority";
    const needsReview = bucket === "needs_review" || row.needs_review === true;
    const newReplies = !archived
      && !terminal
      && !["dead", "suppressed", "priority", "needs_review", "waiting", "cold"].includes(bucket)
      && row.needs_review !== true
      && direction === "inbound"
      && inboundNewer;
    const waiting = direction === "outbound"
      && (NOW - Date.parse(row.last_outbound_at || 0)) <= 24 * 60 * 60 * 1000
      && inboundNewer === false
      && !terminal;
    const allMessages = !archived && !waiting;

    return { priority, needs_review: needsReview, new_replies: newReplies, waiting, all_messages: allMessages };
  };

  for (const fixture of FIXTURES) {
    const sqlCounts = sqlEquivalent(fixture.row);
    for (const [bucket, expected] of Object.entries(fixture.buckets || {})) {
      const js = threadMatchesBucketFilter(fixture.row, bucket, NOW);
      if (expected != null) {
        assert.equal(js, expected, `${fixture.name}:${bucket}:js`);
        assert.equal(sqlCounts[bucket], expected, `${fixture.name}:${bucket}:sql`);
      }
    }
  }
});

test("M: category precedence is exclusive", () => {
  const row = {
    inbox_bucket: "priority",
    latest_direction: "inbound",
    last_inbound_at: hoursAgo(1),
    last_outbound_at: hoursAgo(5),
    needs_review: true,
  };
  assert.equal(threadMatchesBucketFilter(row, "priority", NOW), true);
  assert.equal(threadMatchesBucketFilter(row, "needs_review", NOW), true);
  assert.equal(threadMatchesBucketFilter(row, "new_replies", NOW), false);
});

test("N: All Threads excludes Waiting according to canonical contract", () => {
  const waiting = {
    latest_direction: "outbound",
    last_outbound_at: hoursAgo(2),
    last_inbound_at: null,
    latest_delivery_status: "delivered",
  };
  const inbound = {
    latest_direction: "inbound",
    last_outbound_at: hoursAgo(5),
    last_inbound_at: hoursAgo(1),
  };
  assert.equal(threadMatchesBucketFilter(waiting, "all_messages", NOW), false);
  assert.equal(threadMatchesBucketFilter(inbound, "all_messages", NOW), true);
});