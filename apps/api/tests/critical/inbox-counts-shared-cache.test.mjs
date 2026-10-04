/**
 * RC 8.3.2 — counts are read ONCE per window per process.
 *
 * 2026-10-04 07:45-08:09Z every /inbox/live and /inbox/counts call ran the two
 * aggregate count views uncached (~55/min each); 863 of them hit statement
 * timeouts and the whole database queued behind them. Concurrent callers must
 * share one computation, a good result must serve the next window, and a view
 * failure must serve the last good counts (approximate) instead of falling
 * through to the expensive fallbacks.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { getLiveCounts, COUNTS_SHARED_TTL_MS } from "@/lib/domain/inbox/live-inbox-service.js";

const ROW = { priority: 5, new_replies: 3, needs_review: 2, follow_up: 1, waiting: 4, cold: 10, dead: 0, suppressed: 1, archived: 7, all: 30, all_messages: 30 };

function viewClient() {
  const state = { failing: false, calls: {}, delayMs: 0 };
  const client = {
    state,
    from(table) {
      state.calls[table] = (state.calls[table] || 0) + 1;
      const result = () => {
        if (state.failing) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
        if (table === "v_inbox_bucket_counts") return { data: [{ ...ROW }], error: null };
        if (table === "v_inbox_thread_counts_live_v2") return { data: [{ ...ROW }], error: null };
        return { data: [], error: null };
      };
      const api = {
        select() { return api; },
        eq() { return api; },
        is() { return api; },
        in() { return api; },
        not() { return api; },
        neq() { return api; },
        or() { return api; },
        order() { return api; },
        update() { return api; },
        range() { return Promise.resolve(result()); },
        limit() {
          return state.delayMs
            ? new Promise((resolve) => setTimeout(() => resolve(result()), state.delayMs))
            : Promise.resolve(result());
        },
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
      };
      return api;
    },
  };
  return client;
}

test("concurrent callers share ONE count-view read", async () => {
  const client = viewClient();
  client.state.delayMs = 20;
  const results = await Promise.all(Array.from({ length: 8 }, () => getLiveCounts({}, { supabase: client })));
  assert.equal(client.state.calls.v_inbox_bucket_counts, 1, "8 concurrent polls → 1 aggregate read");
  for (const counts of results) assert.equal(counts.priority, 5);
});

test("a good result serves the next window without touching the views", async () => {
  const client = viewClient();
  await getLiveCounts({}, { supabase: client });
  await getLiveCounts({}, { supabase: client });
  await getLiveCounts({}, { supabase: client });
  assert.equal(client.state.calls.v_inbox_bucket_counts, 1);
  assert.ok(COUNTS_SHARED_TTL_MS >= 5_000 && COUNTS_SHARED_TTL_MS <= 30_000, "window is seconds, not minutes");
});

test("callers mutating their copy never corrupt the shared counts", async () => {
  const client = viewClient();
  const first = await getLiveCounts({}, { supabase: client });
  first.priority = 999;
  const second = await getLiveCounts({}, { supabase: client });
  assert.equal(second.priority, 5);
});

test("when the views time out, the last good counts are served (approximate) — not a full scan", async (t) => {
  const client = viewClient();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  await getLiveCounts({}, { supabase: client });
  now += COUNTS_SHARED_TTL_MS + 1;
  client.state.failing = true;
  client.state.calls = {};
  const counts = await getLiveCounts({}, { supabase: client });
  assert.equal(counts.priority, 5, "last good counts, not zeros");
  assert.equal(client.state.calls.v_inbox_bucket_counts, 1, "the view was retried once, then the last good copy served");
});

test("disableCountsCache bypasses the shared slot (diagnostics)", async () => {
  const client = viewClient();
  await getLiveCounts({}, { supabase: client, disableCountsCache: true });
  await getLiveCounts({}, { supabase: client, disableCountsCache: true });
  assert.equal(client.state.calls.v_inbox_bucket_counts, 2);
});
