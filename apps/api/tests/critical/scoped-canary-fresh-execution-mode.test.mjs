// ─── scoped-canary-fresh-execution-mode.test.mjs ─────────────────────────────
// Regression lock for the 2026-08-06 live-proof failure.
//
// getSystemValue() memoizes system_control for 30 seconds. The proof preflight
// read queue_execution_mode while it was still `paused`; the operator then set
// `scoped_canary_only` and dispatched within the TTL. runScopedCampaignCanary
// read the CACHED `paused`, failed evaluateScopedCanaryDispatchGate, and
// returned 423 queue_execution_mode_not_scoped_canary_only. The request never
// reached queue_atomic_claim_send_row — there was no queue_claim_audit row.
//
// The fix reads the execution mode fresh on the scoped-canary path only.

import assert from "node:assert/strict";
import test from "node:test";

import {
  getSystemValue,
  getSystemValueFresh,
  clearSystemControlCache,
} from "@/lib/system-control.js";
import {
  evaluateScopedCanaryDispatchGate,
  evaluateUnrestrictedDispatchGate,
  getQueueExecutionMode,
  normalizeQueueExecutionMode,
} from "@/lib/domain/queue/queue-execution-mode.js";

// Minimal system_control double whose backing value can change between reads.
function makeSystemControl(initial) {
  const state = { value: initial, reads: 0, rpcCalls: [] };
  const supabase = {
    // The claim RPC is stubbed to a deterministic failure: this test proves the
    // execution-mode read is fresh, not that a claim succeeds. Returning an
    // error (rather than being absent) lets the run fail closed gracefully so
    // the assertions below are reached.
    async rpc(name, args) {
      state.rpcCalls.push({ name, args });
      return { data: null, error: { message: "stubbed_rpc_not_available_in_test" } };
    },
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  state.reads += 1;
                  return { data: { value: state.value }, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  return { state, supabase };
}

test("fresh reader observes a mid-TTL system_control change that the cached reader still hides", async () => {
  clearSystemControlCache();
  const { state, supabase } = makeSystemControl("paused");

  // 1. Preflight warms the cache while the mode is still paused.
  const warmed = await getSystemValue("queue_execution_mode", { supabase });
  assert.equal(warmed, "paused", "precondition: cache warmed with paused");

  // 2. Operator flips the backing row to scoped_canary_only.
  state.value = "scoped_canary_only";

  // 3. The cached reader still reports the stale value — this is the bug.
  const stale = await getSystemValue("queue_execution_mode", { supabase });
  assert.equal(stale, "paused", "cached reader serves the stale value inside the TTL");

  // 4. The fresh reader observes the change immediately.
  const fresh = await getSystemValueFresh("queue_execution_mode", { supabase });
  assert.equal(fresh, "scoped_canary_only", "fresh reader must see the operator's change");
});

test("scoped-canary gate ADMITS via the fresh reader while the cached reader would deny", async () => {
  clearSystemControlCache();
  const { state, supabase } = makeSystemControl("paused");

  await getSystemValue("queue_execution_mode", { supabase }); // warm as paused
  state.value = "scoped_canary_only";

  // Cached path — reproduces the observed 423.
  const cachedMode = await getQueueExecutionMode({
    getSystemValue: (key, opts) => getSystemValue(key, { ...opts, supabase }),
  });
  const cachedGate = evaluateScopedCanaryDispatchGate(cachedMode, { action: "runScopedCampaignCanary" });
  assert.equal(cachedMode, "stopped", "paused normalizes to stopped");
  assert.equal(cachedGate.ok, false, "cached read denies the scoped canary");
  assert.equal(cachedGate.reason, "queue_execution_mode_not_scoped_canary_only");

  // Fresh path — what runScopedCampaignCanary now does.
  const freshMode = await getQueueExecutionMode({
    getSystemValue: (key, opts) => getSystemValueFresh(key, { ...opts, supabase }),
  });
  const freshGate = evaluateScopedCanaryDispatchGate(freshMode, { action: "runScopedCampaignCanary" });
  assert.equal(freshMode, "scoped_canary_only");
  assert.equal(freshGate.ok, true, "fresh read admits the scoped canary");

  // Containment is unchanged: unrestricted dispatch stays blocked.
  const unrestricted = evaluateUnrestrictedDispatchGate(freshMode, { action: "queue_run" });
  assert.equal(unrestricted.ok, false, "unrestricted dispatch must remain blocked");
  assert.equal(unrestricted.reason, "queue_execution_mode_scoped_canary_only");
});

test("runScopedCampaignCanary reads the mode fresh and never from the warmed cache", async () => {
  clearSystemControlCache();
  const { state, supabase } = makeSystemControl("paused");
  await getSystemValue("queue_execution_mode", { supabase }); // warm as paused
  state.value = "scoped_canary_only";

  const { runScopedCampaignCanary } = await import("@/lib/domain/queue/run-scoped-campaign-canary.js");

  let sends = 0;
  const observed = [];
  const result = await runScopedCampaignCanary(
    {
      campaign_id: "b7c9a000-7ad3-468b-9b9b-4647dbefc35f",
      canary_run_id: "test-run",
      queue_row_ids: ["11111111-1111-4111-8111-111111111111"],
      max_rows: 1,
    },
    {
      authorization_validated: true,
      // Cached reader — what the old code used. Any mode read through this
      // returns the stale `paused`.
      getSystemValue: async (key, opts) => {
        observed.push(`cached:${key}`);
        return getSystemValue(key, { ...opts, supabase });
      },
      // Fresh reader — the new execution-mode authority.
      getSystemValueFresh: async (key, opts) => {
        observed.push(`fresh:${key}`);
        return getSystemValueFresh(key, { ...opts, supabase });
      },
      supabase,
      sendSms: async () => {
        sends += 1;
        return { ok: true };
      },
    }
  );

  assert.equal(sends, 0, "no SMS may be sent by this test");
  assert.ok(
    observed.includes("fresh:queue_execution_mode"),
    "queue_execution_mode must be read through the FRESH reader"
  );
  assert.ok(
    !observed.includes("cached:queue_execution_mode"),
    "queue_execution_mode must NOT be read through the cached reader"
  );
  // The run still fails closed further down (no real row / no DB), but it must
  // NOT fail with the stale-mode reason that caused the incident.
  assert.notEqual(
    result?.reason,
    "queue_execution_mode_not_scoped_canary_only",
    "the stale-cache denial must no longer occur"
  );
});

test("getSystemValueFresh fails closed and does not populate the cache", async () => {
  clearSystemControlCache();
  const throwing = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  throw new Error("connection reset");
                },
              };
            },
          };
        },
      };
    },
  };
  assert.equal(await getSystemValueFresh("queue_execution_mode", { supabase: throwing }), null);
  assert.equal(
    normalizeQueueExecutionMode(await getSystemValueFresh("queue_execution_mode", { supabase: throwing })),
    "stopped",
    "a failed fresh read normalizes to the fail-closed posture"
  );

  const errorReturning = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return { data: null, error: { message: "boom" } };
                },
              };
            },
          };
        },
      };
    },
  };
  assert.equal(await getSystemValueFresh("queue_execution_mode", { supabase: errorReturning }), null);

  // A fresh read must never seed the cached path.
  const { state, supabase } = makeSystemControl("scoped_canary_only");
  await getSystemValueFresh("queue_execution_mode", { supabase });
  state.value = "paused";
  assert.equal(
    await getSystemValue("queue_execution_mode", { supabase }),
    "paused",
    "the cached reader must resolve from the table, not from a fresh-read side effect"
  );
});
