/**
 * queue-batch-dedup.test.mjs
 *
 * Guards within-batch duplicate suppression in runSendQueue for Supabase rows.
 * Dedup grain: master_owner_id + phone_id/to_phone + touch_number.
 * Only the earliest-scheduled row per grain is dispatched; later duplicates are
 * suppressed with queue.run_batch_duplicates_suppressed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runSendQueue } from "@/lib/domain/queue/run-send-queue.js";

const NOW = "2026-01-01T12:00:00.000Z";

function makeRow(id, {
  master_owner_id,
  phone_id,
  touch_number,
  scheduled_for = "2026-01-01T00:00:00.000Z",
} = {}) {
  return {
    id,
    queue_status: "queued",
    message_body: "Test message body",
    to_phone_number: "+15550001111",
    is_locked: false,
    scheduled_for,
    ...(master_owner_id ? { master_owner_id } : {}),
    ...(phone_id ? { phone_id } : {}),
    ...(touch_number !== undefined ? { touch_number } : {}),
  };
}

function makeRunnerDeps(rows, dispatched_log, warn_log = []) {
  const noopChain = () => ({
    eq: () => noopChain(),
    lt: () => noopChain(),
    or: () => noopChain(),
    in: () => noopChain(),
    not: () => noopChain(),
    order: () => noopChain(),
    limit: async () => ({ data: [], error: null }),
    select: async () => ({ data: [], error: null }),
    update: () => noopChain(),
  });

  return {
    loadRunnableSendQueueRows: async () => ({
      rows,
      raw_rows: rows,
      skipped: [],
      due_rows: rows.length,
      eligible_claim_count: rows.length,
    }),
    reconcileCanonicalQueueLifecycle: async () => ({ ok: true }),
    getSystemFlag: async () => true,
    getSystemValue: async () => null,
    supabaseClient: { from: () => noopChain() },
    processSendQueueItem: async (row) => {
      dispatched_log.push(row.id);
      return { ok: true, sent: true };
    },
    info: () => {},
    warn: (event, meta) => warn_log.push([event, meta]),
  };
}

test("runSendQueue: duplicate owner+phone+touch in batch — only first item is sent", async () => {
  const dispatched = [];
  const warns = [];

  const rows = [
    makeRow("1001", { master_owner_id: "201", phone_id: "401", touch_number: 1, scheduled_for: "2026-01-01T06:00:00.000Z" }),
    makeRow("1002", { master_owner_id: "201", phone_id: "401", touch_number: 1, scheduled_for: "2026-01-01T07:00:00.000Z" }),
  ];

  const result = await runSendQueue({ limit: 50, now: NOW }, makeRunnerDeps(rows, dispatched, warns));

  assert.equal(dispatched.length, 1, "Only one item should be dispatched");
  assert.equal(dispatched[0], "1001", "Earlier-scheduled item 1001 should be dispatched");
  assert.equal(result.batch_duplicate_suppressed_count, 1);

  const dedup_warn = warns.find(([code]) => code === "queue.run_batch_duplicates_suppressed");
  assert.ok(dedup_warn, "A dedup warning must be emitted");
  assert.equal(dedup_warn[1].duplicate_count, 1);
});

test("runSendQueue: same owner+phone but different touch numbers — both dispatched", async () => {
  const dispatched = [];

  const rows = [
    makeRow("2001", { master_owner_id: "201", phone_id: "401", touch_number: 1 }),
    makeRow("2002", { master_owner_id: "201", phone_id: "401", touch_number: 2 }),
  ];

  await runSendQueue({ limit: 50, now: NOW }, makeRunnerDeps(rows, dispatched));

  assert.equal(dispatched.length, 2, "Different touch numbers must not suppress each other");
  assert.ok(dispatched.includes("2001"));
  assert.ok(dispatched.includes("2002"));
});

test("runSendQueue: different owners sharing a phone+touch — both dispatched", async () => {
  const dispatched = [];

  const rows = [
    makeRow("3001", { master_owner_id: "201", phone_id: "401", touch_number: 1 }),
    makeRow("3002", { master_owner_id: "202", phone_id: "401", touch_number: 1 }),
  ];

  await runSendQueue({ limit: 50, now: NOW }, makeRunnerDeps(rows, dispatched));

  assert.equal(dispatched.length, 2, "Different owners must not suppress each other");
});

test("runSendQueue: item missing owner/phone ids is not filtered by dedup", async () => {
  const dispatched = [];

  const rows = [makeRow("4001", { scheduled_for: "2026-01-01T00:00:00.000Z" })];

  await runSendQueue({ limit: 50, now: NOW }, makeRunnerDeps(rows, dispatched));

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0], "4001");
});

test("runSendQueue: three identical touch duplicates — first sent, two suppressed", async () => {
  const dispatched = [];
  const warns = [];

  const rows = [
    makeRow("5001", { master_owner_id: "201", phone_id: "401", touch_number: 1, scheduled_for: "2026-01-01T06:00:00.000Z" }),
    makeRow("5002", { master_owner_id: "201", phone_id: "401", touch_number: 1, scheduled_for: "2026-01-01T07:00:00.000Z" }),
    makeRow("5003", { master_owner_id: "201", phone_id: "401", touch_number: 1, scheduled_for: "2026-01-01T08:00:00.000Z" }),
  ];

  const result = await runSendQueue({ limit: 50, now: NOW }, makeRunnerDeps(rows, dispatched, warns));

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0], "5001");
  assert.equal(result.batch_duplicate_suppressed_count, 2);

  const dedup_warn = warns.find(([code]) => code === "queue.run_batch_duplicates_suppressed");
  assert.ok(dedup_warn);
  assert.equal(dedup_warn[1].duplicate_count, 2);
});