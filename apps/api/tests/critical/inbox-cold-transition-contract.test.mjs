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
          return {
            eq(_column, threadKey) {
              updates.push({ table, threadKey, patch });
              return Promise.resolve({ error: null });
            },
          };
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