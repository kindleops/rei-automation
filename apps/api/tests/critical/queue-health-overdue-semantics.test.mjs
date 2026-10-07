/**
 * queue-health-overdue-semantics.test.mjs
 *
 * 2026-10-07: the desktop machine badge read "Degraded" permanently. The queue
 * health counted every future-scheduled row as stale (85 rows due later that
 * morning, untouched since they were scheduled) and every queued row created
 * >15 min ago as lag. Health is about OVERDUE rows nothing is moving, and a row
 * the dispatcher keeps refusing is attention, not degradation.
 *
 * Also: a row whose identity the seam can never derive is terminalized after N
 * refusals instead of being refused every tick forever (send_queue 51c8ae5c…,
 * 62 refusals).
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  deriveStatus,
  dueAtOf,
  summarizeOverdue,
  REFUSAL_ATTENTION_THRESHOLD,
} from "@/lib/cockpit/queue-processor-health-service.js";
import {
  buildDispatchRefusalBackoff,
  buildTerminalRefusalUpdate,
  DEFAULT_TERMINAL_REFUSAL_LIMIT,
  resolveTerminalRefusalLimit,
  shouldTerminalizeRefusal,
} from "@/lib/domain/queue/dispatch-refusal-backoff.js";

const NOW = Date.parse("2026-10-07T08:40:00.000Z");
const minAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const minAhead = (m) => new Date(NOW + m * 60_000).toISOString();

test("future-scheduled rows are never stale or lagging, however old their updated_at", () => {
  const rows = Array.from({ length: 85 }, (_, i) => ({
    id: `s${i}`, queue_status: "scheduled", created_at: minAgo(600), updated_at: minAgo(600), scheduled_for_utc: minAhead(28 + i),
  }));
  const s = summarizeOverdue(rows, NOW);
  assert.deepEqual(
    { overdue: s.overdue_active, lag: s.lag_active, stale: s.stale_active, refused: s.refused_repeatedly },
    { overdue: 0, lag: 0, stale: 0, refused: 0 },
  );
  assert.equal(deriveStatus({ scheduled: 85, ...s }), "healthy");
});

test("a queued row created long ago but due in the future is not lag", () => {
  const s = summarizeOverdue([{ queue_status: "queued", created_at: minAgo(300), updated_at: minAgo(1), scheduled_for_utc: minAhead(10) }], NOW);
  assert.equal(s.lag_active, 0);
});

test("overdue rows are counted; lag is queued/pending/processing, stale also needs no recent touch", () => {
  const rows = [
    { queue_status: "queued", created_at: minAgo(90), updated_at: minAgo(60), scheduled_for_utc: minAgo(42) },     // overdue, lag, stale
    { queue_status: "processing", created_at: minAgo(30), updated_at: minAgo(2), scheduled_for_utc: minAgo(20) },  // overdue, lag, recently touched
    { queue_status: "scheduled", created_at: minAgo(100), updated_at: minAgo(100), scheduled_for_utc: minAgo(16) },// overdue, stale, not lag
    { queue_status: "queued", created_at: minAgo(10), updated_at: minAgo(10), scheduled_for_utc: minAgo(10) },     // inside the 15-min grace
    { queue_status: "pending", created_at: minAgo(50), updated_at: minAgo(50), scheduled_for_utc: null },           // due = created_at
  ];
  const s = summarizeOverdue(rows, NOW);
  assert.equal(s.overdue_active, 4);
  assert.equal(s.lag_active, 3);
  assert.equal(s.stale_active, 3);
  assert.equal(s.oldest_overdue_due_at, minAgo(50));
  assert.equal(deriveStatus({ queued: 2, ...s }), "degraded");
  assert.equal(dueAtOf({ created_at: minAgo(5) }), NOW - 5 * 60_000);
});

test("approval rows are held for a person: never overdue, never stale", () => {
  const s = summarizeOverdue([{ queue_status: "approval", created_at: minAgo(5000), updated_at: minAgo(5000), scheduled_for_utc: minAgo(5000) }], NOW);
  assert.equal(s.overdue_active + s.lag_active + s.stale_active, 0);
  assert.equal(deriveStatus({ approval: 1, ...s }), "healthy");
});

test("a row refused repeatedly is attention with a sample, not degraded", () => {
  const stuck = {
    id: "51c8ae5c-b74b-4514-8d81-b457d9a01e83", queue_status: "queued", market: "Indianapolis, IN", source: "classifier_cleanup_20261001",
    created_at: "2026-10-02T20:16:45.151Z", updated_at: "2026-10-07T00:09:24.346Z", scheduled_for_utc: "2026-10-07T01:09:21.903Z",
    metadata: { dispatch_refusal_count: 62, skip_reason: "queue_row_identity_underivable" },
  };
  const s = summarizeOverdue([stuck], NOW);
  assert.equal(s.refused_repeatedly, 1);
  assert.equal(s.overdue_active, 0);
  assert.equal(s.stale_active, 0);
  assert.equal(s.refused_sample[0].id, stuck.id);
  assert.equal(s.refused_sample[0].skip_reason, "queue_row_identity_underivable");
  assert.equal(deriveStatus({ queued: 1, ...s }), "attention");
  // below the threshold it is still an ordinary overdue row
  const few = summarizeOverdue([{ ...stuck, metadata: { dispatch_refusal_count: REFUSAL_ATTENTION_THRESHOLD - 1 } }], NOW);
  assert.equal(few.refused_repeatedly, 0);
  assert.equal(few.stale_active, 1);
});

test("refusal terminalization: only for reasons that cannot clear, only at the limit", () => {
  assert.equal(DEFAULT_TERMINAL_REFUSAL_LIMIT, 10);
  assert.equal(resolveTerminalRefusalLimit(null), 10);
  assert.equal(resolveTerminalRefusalLimit("0"), 10);
  assert.equal(resolveTerminalRefusalLimit("4"), 4);
  assert.equal(shouldTerminalizeRefusal("queue_row_identity_underivable", 9, 10), false);
  assert.equal(shouldTerminalizeRefusal("queue_row_identity_underivable", 10, 10), true);
  assert.equal(shouldTerminalizeRefusal("queue_row_identity_underivable", 62, 10), true);
  // a transient refusal (attempt in flight, sibling unresolved) keeps backing off
  assert.equal(shouldTerminalizeRefusal("attempt_in_flight", 500, 10), false);
});

test("the terminal update blocks the row with the reason and keeps the refusal history", () => {
  const row = { id: "r1", queue_status: "queued", metadata: { dispatch_refusal_count: 9, dispatch_refusal_first_at: "2026-10-02T20:18:00.000Z", body_kind: "x" } };
  const backoff = buildDispatchRefusalBackoff(row, "2026-10-07T13:00:00.000Z");
  assert.equal(backoff.metadata.dispatch_refusal_count, 10);
  const u = buildTerminalRefusalUpdate(row, "queue_row_identity_underivable", backoff.metadata, "2026-10-07T13:00:00.000Z");
  assert.equal(u.queue_status, "blocked");
  assert.equal(u.blocked_reason, "queue_row_identity_underivable");
  assert.equal(u.is_locked, false);
  assert.equal(u.lock_token, null);
  assert.equal(u.metadata.final_queue_status, "blocked");
  assert.equal(u.metadata.body_kind, "x");
  assert.equal(u.metadata.terminal_refusal.refusal_count, 10);
  assert.equal(u.metadata.terminal_refusal.first_refused_at, "2026-10-02T20:18:00.000Z");
});

test("the processor terminalizes before releasing, and alerts once per row", async () => {
  const src = await readFile(new URL("../../src/lib/domain/queue/process-send-queue.js", import.meta.url), "utf8");
  const branch = src.slice(src.indexOf("if (dispatch.provider_invoked === false)"));
  const terminal = branch.indexOf("shouldTerminalizeRefusal(");
  const release = branch.indexOf("releaseSkippedQueueRow(");
  assert.ok(terminal > 0 && release > terminal, "terminal check must run before the row is released back to queued");
  assert.match(branch.slice(terminal, release), /dedupe_key: `queue:refusal_terminalized:\$\{queue_row_id\}`/);
});
