/**
 * INBOX-COMPOSER-LOCK-1 — Scheduled is a lens over the canonical send queue.
 *
 * The operator contract is arithmetic: schedule 20, watch 20 drain one at a
 * time. That only works if Scheduled counts the same canonical send_queue rows
 * the Queue / Outbound Command Center works from, at MESSAGE grain.
 *
 * Two defects these pin, both measured 2026-09-14:
 *   - the list required `scheduled_for > now()`, so a follow-up that came due
 *     while the processor was paused vanished from Scheduled while still being
 *     a message that had not sent and was still expected to;
 *   - `count` was `items.length`, capped at the page size (max 200), so 500
 *     pending follow-ups reported 200 -- a badge computed from whatever happened
 *     to be loaded.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  listScheduledFollowups,
  presentScheduledRow,
  PENDING_QUEUE_STATUSES,
} from "../../src/lib/domain/inbox/list-scheduled-followups.js";

const NOW = Date.parse("2026-09-14T12:00:00.000Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const hoursAhead = (h) => new Date(NOW + h * 3600 * 1000).toISOString();

function makeSupabase(rows, { total = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const state = { table, statuses: null, head: false };
      const api = {
        select(_cols, opts = {}) { state.head = opts.head === true; return api; },
        in(column, values) { state.statuses = { column, values }; return api; },
        eq() { return api; },
        gt(column, value) { state.gt = { column, value }; return api; },
        order() { return api; },
        limit(n) { state.limit = n; return api; },
        then(resolve) {
          calls.push(state);
          const matched = rows.filter((row) => state.statuses.values.includes(row.queue_status));
          if (state.head) {
            return Promise.resolve().then(() => resolve({
              data: null, error: null, count: total ?? matched.length,
            }));
          }
          return Promise.resolve().then(() => resolve({
            data: matched.slice(0, state.limit ?? matched.length), error: null,
          }));
        },
      };
      return api;
    },
  };
}

const ROWS = [
  { id: "q1", thread_key: "+15550000001", queue_status: "scheduled", scheduled_for: hoursAhead(20), message_body: "Still open to an offer?" },
  { id: "q2", thread_key: "+15550000002", queue_status: "queued", scheduled_for: hoursAhead(1), message_body: "Following up" },
  // Came due while the processor was paused. Has not sent. Still expected to.
  { id: "q3", thread_key: "+15550000003", queue_status: "queued", scheduled_for: hoursAgo(3), message_body: "Overdue but unsent" },
  // Retry-waiting: the worker returned it to `queued` with another attempt due.
  { id: "q4", thread_key: "+15550000004", queue_status: "queued", scheduled_for: hoursAgo(1), retry_count: 1, max_retries: 3, next_retry_at: hoursAhead(0.1), failed_reason: "provider_timeout" },
  // In flight: claimed by a worker, not yet accepted by the provider.
  { id: "q5", thread_key: "+15550000005", queue_status: "processing", scheduled_for: hoursAgo(0.1) },
  // History. None of these is still expected to send.
  { id: "q6", thread_key: "+15550000006", queue_status: "sent", scheduled_for: hoursAgo(5) },
  { id: "q7", thread_key: "+15550000007", queue_status: "delivered", scheduled_for: hoursAgo(6) },
  { id: "q8", thread_key: "+15550000008", queue_status: "cancelled", scheduled_for: hoursAhead(4) },
  { id: "q9", thread_key: "+15550000009", queue_status: "failed", scheduled_for: hoursAgo(2) },
  { id: "q10", thread_key: "+15550000010", queue_status: "failed_transport", scheduled_for: hoursAgo(2) },
  { id: "q11", thread_key: "+15550000011", queue_status: "blocked", scheduled_for: hoursAgo(2) },
  { id: "q12", thread_key: "+15550000012", queue_status: "expired", scheduled_for: hoursAgo(9) },
  { id: "q13", thread_key: "+15550000013", queue_status: "duplicate_blocked", scheduled_for: hoursAgo(2) },
  { id: "q14", thread_key: "+15550000014", queue_status: "paused_operator_review", scheduled_for: hoursAgo(2) },
];

test("Scheduled holds exactly the messages still expected to send", async () => {
  const supabase = makeSupabase(ROWS);
  const result = await listScheduledFollowups({ limit: 100, nowMs: NOW }, { supabase });

  assert.equal(result.ok, true);
  const ids = result.items.map((item) => item.id).sort();
  assert.deepEqual(ids, ["q1", "q2", "q3", "q4", "q5"]);
});

test("a successful send leaves Scheduled; so does a cancellation and a terminal failure", async () => {
  const supabase = makeSupabase(ROWS);
  const { items } = await listScheduledFollowups({ limit: 100, nowMs: NOW }, { supabase });
  const present = new Set(items.map((item) => item.id));
  for (const [id, why] of [
    ["q6", "sent"], ["q7", "delivered"], ["q8", "cancelled"],
    ["q9", "terminally failed"], ["q10", "failed transport"],
    ["q11", "blocked"], ["q12", "expired"], ["q13", "duplicate blocked"],
    ["q14", "paused for operator review"],
  ]) {
    assert.equal(present.has(id), false, `${why} must not be in Scheduled`);
  }
});

test("a due-but-unsent message stays in Scheduled and is flagged due", async () => {
  const supabase = makeSupabase(ROWS);
  const { items } = await listScheduledFollowups({ limit: 100, nowMs: NOW }, { supabase });
  const overdue = items.find((item) => item.id === "q3");
  assert.ok(overdue, "a message that came due while the processor was paused has not sent");
  assert.equal(overdue.is_due, true);
  assert.equal(overdue.schedule_state, "due");
});

test("a retry-waiting message stays, and says so", async () => {
  const supabase = makeSupabase(ROWS);
  const { items } = await listScheduledFollowups({ limit: 100, nowMs: NOW }, { supabase });
  const retry = items.find((item) => item.id === "q4");
  assert.ok(retry, "another attempt is expected, so the message is still scheduled");
  assert.equal(retry.schedule_state, "retry_scheduled");
  assert.equal(retry.retry_count, 1);
  assert.equal(retry.last_failure_reason, "provider_timeout");
});

test("the count is the population, not the page", async () => {
  // 500 pending rows, a 50-row page. The badge must read 500.
  const many = Array.from({ length: 500 }, (_, i) => ({
    id: `m${i}`, thread_key: `+1555000${String(i).padStart(4, "0")}`,
    queue_status: "scheduled", scheduled_for: hoursAhead(1 + i / 100),
  }));
  const supabase = makeSupabase(many);
  const result = await listScheduledFollowups({ limit: 50, nowMs: NOW }, { supabase });

  assert.equal(result.returned, 50, "one page of rows");
  assert.equal(result.count, 500, "the chip counts every pending message");
  assert.equal(result.total, 500);
  assert.equal(result.has_more, true);
});

test("nothing in the list ever implies the message was delivered", async () => {
  const supabase = makeSupabase(ROWS);
  const { items } = await listScheduledFollowups({ limit: 100, nowMs: NOW }, { supabase });
  for (const item of items) {
    assert.ok(
      ["scheduled", "due", "pending", "sending", "retry_scheduled"].includes(item.schedule_state),
      `schedule_state "${item.schedule_state}" must not read as sent`,
    );
    assert.equal(PENDING_QUEUE_STATUSES.includes(item.queue_status), true);
  }
});

test("presentation reports queue_status verbatim", () => {
  const row = presentScheduledRow({ queue_status: "queued", scheduled_for: hoursAhead(2) }, NOW);
  assert.equal(row.queue_status, "queued");
  assert.equal(row.schedule_state, "scheduled");
  assert.equal(row.is_due, false);
  assert.equal(row.channel, "sms");
});

test("the pending-status set is the one the Scheduled chip counts", () => {
  // v_inbox_bucket_counts.scheduled filters send_queue on exactly this list.
  // If they drift, the chip and the list drift with them.
  assert.deepEqual(
    [...PENDING_QUEUE_STATUSES].sort(),
    ["approved", "pending", "processing", "queued", "ready", "scheduled", "sending"],
  );
});
