import test from "node:test";
import assert from "node:assert/strict";

import { runSendQueue } from "@/lib/domain/queue/run-send-queue.js";
import {
  acquireRunLock,
  forceReleaseStaleLock,
  __resetRunLockTestDeps,
} from "@/lib/domain/runs/run-locks.js";
import {
  buildSupabaseQueueRow,
  makeLiveQueueSystemValue,
  makeRunSendQueueDeps,
} from "../helpers/queue-run-test-harness.js";

const NOW = "2026-04-04T15:00:00.000Z";

test("runSendQueue blocks when runtime emergency stop is active", async () => {
  const row = buildSupabaseQueueRow(3001, {
    scheduled_for: "2026-04-04T12:00:00.000Z",
    scheduled_for_utc: "2026-04-04T12:00:00.000Z",
  });
  const { deps } = makeRunSendQueueDeps({ rows: [row], now: NOW });
  deps.getSystemFlag = async () => true;
  deps.getSystemValue = async (key) => {
    if (key === "queue_emergency_stop_at") return "2099-01-01T00:00:00.000Z";
    return makeLiveQueueSystemValue()(key);
  };

  const result = await runSendQueue({ limit: 10, now: NOW }, deps);

  assert.equal(result.ok, false);
  assert.equal(result.status, 423);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "queue_emergency_stop_active");
});

test("runSendQueue enters processing and emits queue.run_started when brakes are open", async () => {
  const info_calls = [];
  const row = buildSupabaseQueueRow(3002, {
    scheduled_for: "2026-04-04T12:00:00.000Z",
    scheduled_for_utc: "2026-04-04T12:00:00.000Z",
  });
  const { deps, processed } = makeRunSendQueueDeps({ rows: [row], now: NOW });
  deps.getSystemFlag = async () => true;
  deps.getSystemValue = makeLiveQueueSystemValue();
  deps.info = (event, meta) => info_calls.push({ event, meta });

  const result = await runSendQueue({ limit: 10, now: NOW }, deps);

  assert.equal(result.ok, true);
  assert.equal(result.skipped, undefined);
  assert.equal(result.sent_count, 1);
  assert.deepEqual(processed.map((row) => row.id), [3002]);
  assert.ok(info_calls.some((entry) => entry.event === "queue.run_started"));
  assert.ok(info_calls.some((entry) => entry.event === "queue_run_completed"));
});

test("runSendQueue dry_run bypasses runtime brakes and reports diagnostics without sending", async () => {
  const row = buildSupabaseQueueRow(3003, {
    scheduled_for: "2026-04-04T12:00:00.000Z",
    scheduled_for_utc: "2026-04-04T12:00:00.000Z",
  });
  const { deps, processed } = makeRunSendQueueDeps({ rows: [row], now: NOW });
  deps.getSystemValue = async (key) => {
    if (key === "queue_emergency_stop_at") return "2099-01-01T00:00:00.000Z";
    return makeLiveQueueSystemValue()(key);
  };

  const result = await runSendQueue({ limit: 10, now: NOW, dry_run: true }, deps);

  assert.equal(result.ok, true);
  assert.equal(result.processed_count, 1);
  assert.equal(processed.length, 0);
  assert.equal(result.results[0].dry_run, true);
});

test("runSendQueue blocks when queue_runner_enabled is false", async () => {
  const row = buildSupabaseQueueRow(3004, {
    scheduled_for: "2026-04-04T12:00:00.000Z",
    scheduled_for_utc: "2026-04-04T12:00:00.000Z",
  });
  const { deps } = makeRunSendQueueDeps({ rows: [row], now: NOW });
  deps.getSystemFlag = async (flag) => flag !== "queue_runner_enabled";
  deps.getSystemValue = makeLiveQueueSystemValue();

  const result = await runSendQueue({ limit: 10, now: NOW }, deps);

  assert.equal(result.ok, false);
  assert.equal(result.status, 423);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "system_control_disabled");
});

test("forceReleaseStaleLock releases a stuck lock record", async () => {
  // Run locks are durable now, so the lock is seeded by genuinely acquiring it
  // rather than by stubbing readRuntimeState/writeRuntimeState, which no longer
  // exist. The assertions describe observable behaviour instead of file writes.
  __resetRunLockTestDeps();

  const held = await acquireRunLock({
    scope: "queue-run",
    owner: "queue_runner",
    lease_ms: 10 * 60_000,
  });
  assert.equal(held.acquired, true);

  const result = await forceReleaseStaleLock({
    scope: "queue-run",
    reason: "test_manual_recovery",
  });

  assert.equal(result.ok, true);
  assert.equal(result.released, true);
  assert.equal(result.reason, "test_manual_recovery");
  assert.equal(result.scope, "queue-run");
  assert.equal(result.record_item_id, "run-locks:queue-run");
  assert.equal(result.was_active, true);
  assert.equal(result.previous_owner, "queue_runner");
  assert.equal(result.previous_expires_at, held.meta.expires_at);

  // The lock is genuinely free afterwards, not merely flagged: the next
  // acquirer gets a clean acquisition rather than a stale reclaim.
  const next = await acquireRunLock({ scope: "queue-run", owner: "next_runner" });
  assert.equal(next.acquired, true);
  assert.equal(next.reason, "lock_acquired");
});

test("forceReleaseStaleLock returns ok=true with released=false when no lock record exists", async () => {
  __resetRunLockTestDeps();

  const result = await forceReleaseStaleLock({ scope: "queue-run:999" });

  assert.equal(result.ok, true);
  assert.equal(result.released, false);
  assert.equal(result.reason, "no_lock_record_found");
  assert.equal(result.scope, "queue-run:999");
});
