/**
 * inbox-scheduled-thread-state.test.mjs
 *
 * The Scheduled bucket is the one Inbox category whose truth lives in another
 * table, so these tests pin the derivation rather than a stored flag: a thread
 * is Scheduled because a real send_queue row for it will still run.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildScheduledThreadIndex,
  isScheduleSuppressed,
  applyScheduledThreadFields,
  resolveEffectiveSendAtMs,
  isPendingQueueStatus,
} from "../../src/lib/domain/inbox/resolve-scheduled-thread-state.js";

const NOW = Date.parse("2026-09-06T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const inHours = (h) => iso(NOW + h * 3600_000);
const agoHours = (h) => iso(NOW - h * 3600_000);

const row = (over = {}) => ({
  id: "row-1",
  thread_key: "+15551110001",
  queue_status: "scheduled",
  scheduled_for: inHours(20),
  scheduled_for_utc: inHours(20),
  scheduled_for_local: inHours(20),
  timezone: "America/Chicago",
  created_at: agoHours(1),
  ...over,
});

test("1. a pending future queue row makes the thread Scheduled", () => {
  const index = buildScheduledThreadIndex([row()], NOW);
  const entry = index.get("+15551110001");
  assert.ok(entry, "thread must be indexed");
  assert.equal(entry.next_send_at_utc, inHours(20));
  assert.equal(entry.pending_count, 1);
  assert.equal(isScheduleSuppressed({}, entry, NOW), true);
});

test("5+6. the EFFECTIVE persisted time is used, never a requested one", () => {
  // The operator asked for 07:15 local; canonical scheduling shifted it to
  // 08:00. Only the persisted effective instant may ever reach the Inbox.
  const requested = inHours(19);
  const effective = inHours(20);
  const index = buildScheduledThreadIndex(
    [row({ scheduled_for: effective, scheduled_for_utc: effective, requested_scheduled_for: requested })],
    NOW,
  );
  assert.equal(index.get("+15551110001").next_send_at_utc, effective);
  assert.notEqual(index.get("+15551110001").next_send_at_utc, requested);
});

test("resolveEffectiveSendAtMs follows the dispatcher's own fallback chain", () => {
  assert.equal(resolveEffectiveSendAtMs({ scheduled_for: inHours(3) }), NOW + 3 * 3600_000);
  assert.equal(resolveEffectiveSendAtMs({ scheduled_for_utc: inHours(4) }), NOW + 4 * 3600_000);
  assert.equal(resolveEffectiveSendAtMs({ scheduled_for_local: inHours(5) }), NOW + 5 * 3600_000);
  assert.equal(resolveEffectiveSendAtMs({}), null);
});

test("7+8. many future rows collapse to ONE thread at the NEAREST action", () => {
  const index = buildScheduledThreadIndex(
    [
      row({ id: "far", scheduled_for: inHours(50), scheduled_for_utc: inHours(50), created_at: agoHours(3) }),
      row({ id: "near", scheduled_for: inHours(6), scheduled_for_utc: inHours(6), created_at: agoHours(2) }),
      row({ id: "mid", scheduled_for: inHours(30), scheduled_for_utc: inHours(30), created_at: agoHours(1) }),
    ],
    NOW,
  );
  assert.equal(index.size, 1, "one conversation, one entry -- never duplicate rows");
  const entry = index.get("+15551110001");
  assert.equal(entry.next_send_at_utc, inHours(6));
  assert.equal(entry.next_queue_row_id, "near");
  assert.equal(entry.pending_count, 3);
  // The newest scheduling decision governs the seller-reply comparison, not
  // the nearest row's own created_at.
  assert.equal(entry.latest_scheduled_created_at_ms, Date.parse(agoHours(1)));
});

test("9. a cancelled row does not qualify the thread", () => {
  for (const status of ["cancelled", "canceled", "failed", "expired", "blocked", "suppressed"]) {
    const index = buildScheduledThreadIndex([row({ queue_status: status })], NOW);
    assert.equal(index.size, 0, `${status} must not qualify`);
    assert.equal(isPendingQueueStatus(status), false);
  }
});

test("13. a sent or delivered row alone does not keep the thread Scheduled", () => {
  for (const status of ["sent", "delivered", "processing"]) {
    assert.equal(buildScheduledThreadIndex([row({ queue_status: status })], NOW).size, 0);
  }
});

test("a past-due pending row belongs to the queue runner, not to Scheduled", () => {
  const index = buildScheduledThreadIndex(
    [row({ scheduled_for: agoHours(2), scheduled_for_utc: agoHours(2) })],
    NOW,
  );
  assert.equal(index.size, 0);
});

test("a pending row with no resolvable time is not Scheduled", () => {
  const index = buildScheduledThreadIndex(
    [row({ scheduled_for: null, scheduled_for_utc: null, scheduled_for_local: null })],
    NOW,
  );
  assert.equal(index.size, 0, "we will not hide a thread behind a time we cannot show");
});

test("10+11. a seller reply AFTER scheduling returns the thread to actionable", () => {
  const index = buildScheduledThreadIndex([row({ created_at: agoHours(5) })], NOW);
  const entry = index.get("+15551110001");

  // Seller spoke after we booked the follow-up -> assumption void.
  assert.equal(isScheduleSuppressed({ last_inbound_at: agoHours(1) }, entry, NOW), false);
  // Seller's last word predates the booking -> the schedule still stands.
  assert.equal(isScheduleSuppressed({ last_inbound_at: agoHours(9) }, entry, NOW), true);
  // No inbound at all -> still scheduled.
  assert.equal(isScheduleSuppressed({}, entry, NOW), true);
});

test("outbound activity after scheduling does NOT void the schedule", () => {
  const index = buildScheduledThreadIndex([row({ created_at: agoHours(5) })], NOW);
  const entry = index.get("+15551110001");
  assert.equal(
    isScheduleSuppressed({ last_outbound_at: agoHours(1), last_inbound_at: agoHours(9) }, entry, NOW),
    true,
    "our own message is not new information from the seller",
  );
});

test("applyScheduledThreadFields exposes one derived truth and preserves lead state", () => {
  const index = buildScheduledThreadIndex([row()], NOW);
  const thread = {
    thread_key: "+15551110001",
    inbox_bucket: "priority",
    is_hot_lead: true,
    priority_score: 94,
    last_inbound_at: agoHours(9),
  };
  const out = applyScheduledThreadFields(thread, index.get("+15551110001"), NOW);

  assert.equal(out.is_schedule_suppressed, true);
  assert.equal(out.next_scheduled_send_at_utc, inHours(20));
  assert.equal(out.next_scheduled_timezone, "America/Chicago");
  assert.equal(out.scheduled_pending_count, 1);

  // Lead truth is untouched: this is an attention change, not a rewrite.
  assert.equal(out.inbox_bucket, "priority");
  assert.equal(out.is_hot_lead, true);
  assert.equal(out.priority_score, 94);
});

test("a thread with no queue row is never schedule-suppressed", () => {
  const out = applyScheduledThreadFields({ inbox_bucket: "new_replies" }, null, NOW);
  assert.equal(out.is_schedule_suppressed, false);
  assert.equal(out.next_scheduled_send_at_utc, null);
  assert.equal(out.scheduled_pending_count, 0);
});
