import test from "node:test";
import assert from "node:assert/strict";

import {
  buildColdTransitionPatch,
  resolveOutboundReplyState,
  shouldTransitionWaitingToCold,
} from "../../src/lib/domain/inbox/resolve-waiting-cold-state.js";
import { reconcileStaleInboxBuckets } from "../../src/lib/domain/inbox/reconcile-inbox-thread-state.js";

const NOW = Date.parse("2026-06-24T12:00:00.000Z");
const hoursAgo = (hours) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();

const ALLOWED_INBOX_BUCKETS = new Set([null, "priority", "new_replies", "needs_review", "waiting"]);

test("stale waiting resolves to null inbox_bucket with cold_reactivation lane", () => {
  const state = resolveOutboundReplyState({
    lastOutboundAt: hoursAgo(30),
    lastInboundAt: null,
    now: NOW,
  });
  assert.equal(state.inbox_bucket, null);
  assert.equal(state.automation_lane, "cold_reactivation");
});

test("buildColdTransitionPatch never writes inbox_bucket=cold", () => {
  const patch = buildColdTransitionPatch({
    inbox_bucket: "waiting",
    lastOutboundAt: hoursAgo(30),
    lastInboundAt: null,
    now: NOW,
  });
  assert.ok(patch);
  assert.notEqual(patch.inbox_bucket, "cold");
  assert.equal(ALLOWED_INBOX_BUCKETS.has(patch.inbox_bucket), true);
  assert.equal(patch.automation_lane, "cold_reactivation");
});

test("shouldTransitionWaitingToCold requires null bucket + cold_reactivation lane", () => {
  assert.equal(shouldTransitionWaitingToCold({
    inbox_bucket: "waiting",
    lastOutboundAt: hoursAgo(30),
    lastInboundAt: null,
    now: NOW,
  }), true);
  assert.equal(shouldTransitionWaitingToCold({
    inbox_bucket: "waiting",
    lastOutboundAt: hoursAgo(2),
    lastInboundAt: null,
    now: NOW,
  }), false);
});

test("reconcileStaleInboxBuckets is bounded and idempotent", async () => {
  const updates = [];
  const supabase = {
    from(table) {
      const state = { table, filters: [] };
      const api = {
        select() { return api; },
        eq(column, value) {
          state.filters.push({ column, value });
          return api;
        },
        lt() { return api; },
        limit() { return api; },
        update(patch) {
          // Per-row path (.eq('thread_key', key)) and the bulk compare-and-set
          // path (.in('thread_key', keys).eq('inbox_bucket','waiting').select()).
          const bulk = { keys: null };
          const builder = {
            in(_column, keys) {
              bulk.keys = keys;
              return builder;
            },
            eq(column, value) {
              if (bulk.keys) return builder;
              updates.push({ table, threadKey: value, patch, column });
              return Promise.resolve({ error: null });
            },
            select() {
              for (const threadKey of bulk.keys || []) updates.push({ table, threadKey, patch });
              return Promise.resolve({ data: (bulk.keys || []).map((thread_key) => ({ thread_key })), error: null });
            },
          };
          return builder;
        },
        async then(resolve) {
          if (table === "inbox_thread_state" && state.filters.some((f) => f.column === "inbox_bucket" && f.value === "waiting")) {
            resolve({
              data: [{
                thread_key: "phone:+15550001111",
                inbox_bucket: "waiting",
                last_outbound_at: hoursAgo(30),
                last_inbound_at: null,
              }],
              error: null,
            });
            return;
          }
          if (table === "inbox_thread_state" && state.filters.some((f) => f.column === "inbox_bucket" && f.value === "new_replies")) {
            resolve({
              data: [{
                thread_key: "phone:+15550002222",
                inbox_bucket: "new_replies",
                latest_direction: "outbound",
                last_outbound_at: hoursAgo(1),
                last_inbound_at: hoursAgo(2),
              }],
              error: null,
            });
            return;
          }
          resolve({ data: [], error: null });
        },
      };
      return api;
    },
  };

  const result = await reconcileStaleInboxBuckets(supabase, { batchSize: 100, now: NOW });
  assert.equal(result.waiting_transitioned, 1);
  assert.ok(result.updated >= 2);
  assert.ok(updates.every((entry) => entry.patch.inbox_bucket !== "cold"));
});
// ── 2026-09-30 stampede ──────────────────────────────────────────────────────
// ~445 threads crossed the reply window together; every concurrent inbox poll
// re-patched all of them one request at a time (~38k PATCHes in 20 minutes)
// and starved the API pool. These pin the fix.

import { transitionStaleWaitingThreads } from "../../src/lib/domain/inbox/reconcile-inbox-thread-state.js";

function staleWaitingClient({ keys, selectDelayMs = 0 }) {
  const calls = { selects: 0, bulkUpdates: [], rowUpdates: 0 };
  const client = {
    calls,
    from() {
      const api = {
        select() { return api; },
        eq() { return api; },
        lt() { return api; },
        limit() { return api; },
        update(patch) {
          const bulk = { keys: null, filters: [] };
          const builder = {
            in(_column, inKeys) { bulk.keys = inKeys; return builder; },
            eq(column, value) {
              if (!bulk.keys) { calls.rowUpdates += 1; return Promise.resolve({ error: null }); }
              bulk.filters.push([column, value]);
              return builder;
            },
            select() {
              calls.bulkUpdates.push({ keys: bulk.keys, filters: bulk.filters, patch });
              return Promise.resolve({ data: bulk.keys.map((thread_key) => ({ thread_key })), error: null });
            },
          };
          return builder;
        },
        then(resolve) {
          calls.selects += 1;
          const rows = keys.map((thread_key) => ({
            thread_key, inbox_bucket: "waiting", last_outbound_at: hoursAgo(30), last_inbound_at: null,
          }));
          setTimeout(() => resolve({ data: rows, error: null }), selectDelayMs);
        },
      };
      return api;
    },
  };
  return client;
}

test("stale waiting threads move in bulk compare-and-set updates, not one request per row", async () => {
  const keys = Array.from({ length: 250 }, (_, i) => `+1555000${String(i).padStart(4, "0")}`);
  const client = staleWaitingClient({ keys });
  const moved = await transitionStaleWaitingThreads(client, NOW);
  assert.equal(moved, 250);
  assert.equal(client.calls.rowUpdates, 0, "no per-row PATCH");
  assert.equal(client.calls.bulkUpdates.length, 3, "250 rows in chunks of 100");
  for (const update of client.calls.bulkUpdates) {
    assert.deepEqual(update.filters, [["inbox_bucket", "waiting"]], "compare-and-set: only rows still waiting");
    assert.equal(update.patch.inbox_bucket, null);
    assert.equal(update.patch.automation_lane, "cold_reactivation");
  }
});

test("concurrent polls share one transition run", async () => {
  const client = staleWaitingClient({ keys: ["+15550001111", "+15550002222"], selectDelayMs: 20 });
  const results = await Promise.all(Array.from({ length: 25 }, () => transitionStaleWaitingThreads(client, NOW)));
  assert.equal(client.calls.selects, 1, "25 concurrent polls -> 1 select");
  assert.equal(client.calls.bulkUpdates.length, 1, "25 concurrent polls -> 1 update");
  assert.ok(results.every((n) => n === 2));
});

test("a poll within a minute of the last run does nothing; the maintenance route can force", async () => {
  const client = staleWaitingClient({ keys: ["+15550003333"] });
  assert.equal(await transitionStaleWaitingThreads(client, NOW), 1);
  assert.equal(await transitionStaleWaitingThreads(client, NOW), 0);
  assert.equal(client.calls.selects, 1, "throttled poll touched nothing");
  assert.equal(await transitionStaleWaitingThreads(client, NOW, { force: true }), 1);
  assert.equal(client.calls.selects, 2);
});
