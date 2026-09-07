/**
 * inbox-scheduled-bucket-coherence.test.mjs
 *
 * End-to-end through getLiveInbox: a conversation with a real future
 * send_queue row must LEAVE the actionable buckets and APPEAR in Scheduled,
 * without its lead truth being rewritten.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { makeLiveInboxThreadSupabase } from "../helpers/chainable-supabase.mjs";
import { getLiveInbox } from "../../src/lib/domain/inbox/live-inbox-service.js";

const SCHEDULED_THREAD = "+15551230001";
const ACTIONABLE_THREAD = "+15551230002";

const future = (hours) => new Date(Date.now() + hours * 3600_000).toISOString();
const past = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();

function stateRow(threadKey, bucket, over = {}) {
  return {
    thread_key: threadKey,
    seller_phone: threadKey,
    canonical_e164: threadKey,
    inbox_bucket: bucket,
    latest_message_body: "Yes I still own it",
    latest_message_at: past(30),
    latest_direction: "inbound",
    latest_message_direction: "inbound",
    last_inbound_at: past(30),
    is_read: false,
    is_suppressed: false,
    message_count: 2,
    inbound_count: 1,
    outbound_count: 1,
    ...over,
  };
}

function queueRow(threadKey, over = {}) {
  return {
    id: `q-${threadKey}`,
    thread_key: threadKey,
    queue_status: "scheduled",
    scheduled_for: future(20),
    scheduled_for_utc: future(20),
    scheduled_for_local: future(20),
    timezone: "America/Chicago",
    local_send_hour: 8,
    created_at: past(1),
    ...over,
  };
}

const listArgs = (filter) => [
  // manual_bucket_switch is the mode that reads inbox_thread_state as the
  // authority, which is what the fixtures below describe.
  { filter, timeout_mode: "manual_bucket_switch", limit: 20, skip_counts: "1", skip_delivery: "1" },
  { listOnly: true, skipCounts: true, skipDelivery: true },
];

async function run(filter, { stateRows, sendQueueRows }) {
  const supabase = makeLiveInboxThreadSupabase(stateRows, { stateRows, sendQueueRows });
  const [params, options] = listArgs(filter);
  return getLiveInbox(params, options, { supabase });
}

const keys = (result) => result.threads.map((t) => t.thread_key).sort();

test("a future queue row removes the thread from New Replies", async () => {
  const fixture = {
    stateRows: [stateRow(SCHEDULED_THREAD, "new_replies"), stateRow(ACTIONABLE_THREAD, "new_replies")],
    sendQueueRows: [queueRow(SCHEDULED_THREAD)],
  };
  assert.deepEqual(keys(await run("new_replies", fixture)), [ACTIONABLE_THREAD]);
});

test("the same thread appears in Scheduled, with the effective time", async () => {
  const fixture = {
    stateRows: [stateRow(SCHEDULED_THREAD, "new_replies"), stateRow(ACTIONABLE_THREAD, "new_replies")],
    sendQueueRows: [queueRow(SCHEDULED_THREAD)],
  };
  const result = await run("scheduled", fixture);
  assert.deepEqual(keys(result), [SCHEDULED_THREAD]);

  const row = result.threads[0];
  assert.equal(row.is_schedule_suppressed, true);
  assert.equal(row.next_scheduled_timezone, "America/Chicago");
  assert.ok(row.next_scheduled_send_at_utc, "the effective instant must travel to the client");
  assert.ok(Date.parse(row.next_scheduled_send_at_utc) > Date.now());
});

test("Priority loses the thread too, but the thread is still a priority lead", async () => {
  const fixture = {
    stateRows: [stateRow(SCHEDULED_THREAD, "priority"), stateRow(ACTIONABLE_THREAD, "priority")],
    sendQueueRows: [queueRow(SCHEDULED_THREAD)],
  };
  assert.deepEqual(keys(await run("priority", fixture)), [ACTIONABLE_THREAD]);

  // Attention changed; lead truth did not.
  const scheduled = (await run("scheduled", fixture)).threads[0];
  assert.equal(scheduled.inbox_bucket, "priority");
});

test("a seller reply AFTER scheduling returns the thread to the actionable bucket", async () => {
  const fixture = {
    stateRows: [
      // Seller spoke 10 minutes ago; the follow-up was booked an hour ago.
      stateRow(SCHEDULED_THREAD, "new_replies", { last_inbound_at: new Date(Date.now() - 600_000).toISOString() }),
    ],
    sendQueueRows: [queueRow(SCHEDULED_THREAD, { created_at: past(1) })],
  };
  assert.deepEqual(keys(await run("new_replies", fixture)), [SCHEDULED_THREAD]);
  assert.deepEqual(keys(await run("scheduled", fixture)), []);
});

test("a cancelled row leaves Scheduled and restores the actionable bucket", async () => {
  const fixture = {
    stateRows: [stateRow(SCHEDULED_THREAD, "new_replies")],
    sendQueueRows: [queueRow(SCHEDULED_THREAD, { queue_status: "cancelled" })],
  };
  assert.deepEqual(keys(await run("scheduled", fixture)), []);
  assert.deepEqual(keys(await run("new_replies", fixture)), [SCHEDULED_THREAD]);
});

test("a sent row does not keep the thread Scheduled", async () => {
  const fixture = {
    stateRows: [stateRow(SCHEDULED_THREAD, "new_replies")],
    sendQueueRows: [queueRow(SCHEDULED_THREAD, { queue_status: "sent" })],
  };
  assert.deepEqual(keys(await run("scheduled", fixture)), []);
  assert.deepEqual(keys(await run("new_replies", fixture)), [SCHEDULED_THREAD]);
});

test("two future rows produce ONE Scheduled entry at the nearest send", async () => {
  const near = future(4);
  const fixture = {
    stateRows: [stateRow(SCHEDULED_THREAD, "new_replies")],
    sendQueueRows: [
      queueRow(SCHEDULED_THREAD, { id: "far", scheduled_for: future(40), scheduled_for_utc: future(40) }),
      queueRow(SCHEDULED_THREAD, { id: "near", scheduled_for: near, scheduled_for_utc: near }),
    ],
  };
  const result = await run("scheduled", fixture);
  assert.equal(result.threads.length, 1, "one conversation, one row");
  assert.equal(result.threads[0].scheduled_pending_count, 2);
  assert.equal(
    new Date(result.threads[0].next_scheduled_send_at_utc).toISOString(),
    new Date(near).toISOString(),
  );
});

test("Scheduled is ordered by nearest effective send, not by activity", async () => {
  // Deliberately inverted: the thread with the LATER send is the more recently
  // active one, so activity ordering would put it first.
  const a = "+15551230010";
  const b = "+15551230011";
  const fixture = {
    stateRows: [
      stateRow(a, "new_replies", { latest_message_at: past(1) }),
      stateRow(b, "new_replies", { latest_message_at: past(50) }),
    ],
    sendQueueRows: [
      queueRow(a, { scheduled_for: future(40), scheduled_for_utc: future(40) }),
      queueRow(b, { scheduled_for: future(3), scheduled_for_utc: future(3) }),
    ],
  };
  const result = await run("scheduled", fixture);
  assert.deepEqual(result.threads.map((t) => t.thread_key), [b, a]);
});

test("a past-due pending row is the queue runner's, and keeps the thread actionable", async () => {
  const fixture = {
    stateRows: [stateRow(SCHEDULED_THREAD, "new_replies")],
    sendQueueRows: [queueRow(SCHEDULED_THREAD, { scheduled_for: past(2), scheduled_for_utc: past(2) })],
  };
  assert.deepEqual(keys(await run("scheduled", fixture)), []);
  assert.deepEqual(keys(await run("new_replies", fixture)), [SCHEDULED_THREAD]);
});

test("All still shows a scheduled conversation -- it is hidden from attention, not from history", async () => {
  const fixture = {
    stateRows: [stateRow(SCHEDULED_THREAD, "new_replies"), stateRow(ACTIONABLE_THREAD, "new_replies")],
    sendQueueRows: [queueRow(SCHEDULED_THREAD)],
  };
  assert.deepEqual(keys(await run("all", fixture)), [SCHEDULED_THREAD, ACTIONABLE_THREAD].sort());
});

/**
 * Counts are the other half of the contract: a chip that still advertises work
 * the operator has already dealt with is the same bug as a list that does, and
 * the counts come from a different code path than the list.
 */
import { getLiveCounts } from "../../src/lib/domain/inbox/live-inbox-service.js";

test("counts move a scheduled thread out of the actionable chips and into scheduled", async () => {
  const stateRows = [stateRow(SCHEDULED_THREAD, "priority"), stateRow(ACTIONABLE_THREAD, "priority")];
  const supabase = makeLiveInboxThreadSupabase(stateRows, {
    stateRows,
    sendQueueRows: [queueRow(SCHEDULED_THREAD)],
  });

  const counts = await getLiveCounts({}, { supabase });

  assert.equal(counts.scheduled, 1, "the scheduled conversation is counted once, under scheduled");
  assert.equal(counts.priority, 1, "and is no longer counted as priority work");
  // The legacy alias must not contradict the key it mirrors.
  assert.equal(counts.hot_leads, counts.priority);
});

test("counts report scheduled as 0 -- not unknown -- when the queue is genuinely empty", async () => {
  const stateRows = [stateRow(ACTIONABLE_THREAD, "priority")];
  const supabase = makeLiveInboxThreadSupabase(stateRows, { stateRows, sendQueueRows: [] });

  const counts = await getLiveCounts({}, { supabase });
  assert.equal(counts.scheduled, 0);
  assert.equal(counts.priority, 1, "nothing is decremented when nothing is scheduled");
});

test("a seller reply after scheduling keeps the thread in the actionable count", async () => {
  const stateRows = [
    stateRow(SCHEDULED_THREAD, "priority", { last_inbound_at: new Date(Date.now() - 600_000).toISOString() }),
  ];
  const supabase = makeLiveInboxThreadSupabase(stateRows, {
    stateRows,
    sendQueueRows: [queueRow(SCHEDULED_THREAD, { created_at: past(1) })],
  });

  const counts = await getLiveCounts({}, { supabase });
  assert.equal(counts.scheduled, 0);
  assert.equal(counts.priority, 1);
});

test("the LIST response carries scheduled counts -- the chips are rendered from it, not from /counts", async () => {
  // Caught on staging: /api/cockpit/inbox/counts correctly returned
  // scheduled:1 while the sidebar still showed "-", because the client reads
  // its chips from the list response and several of that endpoint's count
  // paths rebuild counts from CANONICAL_COUNT_KEYS, which omits scheduled.
  const stateRows = [stateRow(SCHEDULED_THREAD, "priority"), stateRow(ACTIONABLE_THREAD, "priority")];
  const supabase = makeLiveInboxThreadSupabase(stateRows, {
    stateRows,
    sendQueueRows: [queueRow(SCHEDULED_THREAD)],
  });

  // Deliberately NOT manual_bucket_switch: that mode sets fastBucketMode,
  // which forces skipCounts, and a response that returns no counts at all
  // cannot demonstrate anything about this one.
  const result = await getLiveInbox(
    { filter: "all", limit: 20 },
    { listOnly: true },
    { supabase },
  );

  assert.equal(
    Number.isFinite(Number(result.counts?.scheduled)),
    true,
    'scheduled must be a number in the list response, or the chip renders "-"',
  );
  assert.equal(Number(result.counts.scheduled), 1);
});

test("Scheduled finds its thread even when it is NOT in the first page by activity", async () => {
  // The bug this pins: the Scheduled query was issued UNFILTERED, so it got
  // the most recently active threads and the in-memory pass found none of them
  // scheduled. The view rendered empty while the chip correctly said 1. The
  // scheduled conversation here is deliberately the LEAST recently active, so
  // an unfiltered page would miss it.
  const noisy = Array.from({ length: 25 }, (_, i) =>
    stateRow(`+1555999${String(i).padStart(4, "0")}`, "priority", { latest_message_at: past(1) }));
  const stale = stateRow(SCHEDULED_THREAD, "priority", { latest_message_at: past(2000) });

  const fixture = {
    stateRows: [...noisy, stale],
    sendQueueRows: [queueRow(SCHEDULED_THREAD)],
  };

  const result = await run("scheduled", fixture);
  assert.deepEqual(keys(result), [SCHEDULED_THREAD]);
  assert.equal(result.threads[0].is_schedule_suppressed, true);
  assert.ok(result.threads[0].next_scheduled_send_at_utc);
});
