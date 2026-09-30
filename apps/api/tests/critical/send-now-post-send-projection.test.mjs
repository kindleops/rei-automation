/**
 * THE OPERATOR IS ANSWERED WHEN THE SEND IS DURABLE, NOT WHEN THE PROJECTIONS ARE.
 *
 * 2026-09-30 14:51Z: send_queue fc39b22b was provider-accepted and finalized
 * `sent` (PATCH ... lock_token=eq.manual_send:... at 14:51:28.19), but the
 * request kept awaiting message_events + a classified thread-state resync
 * (unbounded message_events read, LLM re-classification of the latest inbound)
 * + first-contact promotion. The phone reported "Load failed" for a message the
 * seller received.
 *
 * Contract pinned here:
 *   - finalizeSendQueueSuccess (the durable record) is ALWAYS awaited;
 *   - message_events / thread state / first-contact promotion never hold the
 *     response past the post-send budget, and still run, in the same order,
 *     exactly once;
 *   - inside the budget nothing changes (message_event_id is returned);
 *   - a projection failure after the response is contained (no unhandled
 *     rejection) and a failure inside the budget is reported exactly as before;
 *   - the provider is called exactly once either way.
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { executeManualInboxSendNow } from "@/lib/domain/inbox/send-now-service.js";
import {
  DEFAULT_POST_SEND_BUDGET_MS,
  drainPostSendProjections,
  pendingPostSendProjectionCount,
  resolvePostSendBudgetMs,
  runPostSendProjection,
} from "@/lib/domain/inbox/post-send-projection.js";
import { s11ManualSendDeps } from "../helpers/s11-memory-store.mjs";

const THREAD = "+15005550006";
const FROM = "+15005550001";

const BASE_PAYLOAD = {
  thread_key: THREAD,
  to_phone_number: THREAD,
  from_phone_number: FROM,
  message_body: "Operator reply from the composer",
  queue_key: "inbox:post-send-projection-proof",
  source: "manual_inbox",
  action: "send_now",
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Claimable send_queue + a healthy (non-suppressed) world for the final guard. */
function makeClaimableSupabase(queue_row) {
  const rows = new Map([[String(queue_row.id), { ...queue_row }]]);
  return {
    rows,
    from(table) {
      if (table === "send_queue") {
        return {
          select() {
            return {
              eq(_col, val) {
                return {
                  maybeSingle: async () => ({ data: rows.get(String(val)) || null, error: null }),
                };
              },
            };
          },
          update(patch) {
            const apply = async (id) => {
              const row = rows.get(String(id));
              if (!row) return { data: null, error: null };
              Object.assign(row, patch);
              if (patch.metadata) row.metadata = { ...(row.metadata || {}), ...patch.metadata };
              return { data: row, error: null };
            };
            return {
              eq(_col, val) {
                return {
                  in(_col2, statuses) {
                    return {
                      select() {
                        return {
                          maybeSingle: async () => {
                            const row = rows.get(String(val));
                            if (!row || !statuses.includes(row.queue_status)) return { data: null, error: null };
                            return { data: (await apply(val)).data, error: null };
                          },
                        };
                      },
                    };
                  },
                  then(resolve, reject) {
                    return apply(val).then(resolve, reject);
                  },
                };
              },
            };
          },
        };
      }
      if (table === "sms_suppression_list") {
        const empty = { limit: async () => ({ data: [], error: null, count: 0 }) };
        return {
          select: () => ({
            eq: () => ({ or: () => ({ eq: () => empty }) }),
            or: () => ({ eq: () => empty }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
            or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
          }),
          or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
        }),
      };
    },
  };
}

function makeHarness({ queue_row_id = "post-send-row", overrides = {} } = {}) {
  const events = [];
  let provider_calls = 0;
  const supabase = makeClaimableSupabase({
    id: queue_row_id,
    thread_key: THREAD,
    to_phone_number: THREAD,
    from_phone_number: FROM,
    queue_status: "queued",
    message_body: BASE_PAYLOAD.message_body,
    metadata: { source: "manual_inbox", manual_operator_send: true },
  });

  const deps = {
    ...s11ManualSendDeps(),
    supabase,
    getSystemValue: async (key) => {
      if (key === "queue_processor_mode") return "live";
      if (key === "queue_execution_mode") return "normal";
      return null;
    },
    createQueueRowImpl: async (input) => ({
      ok: true,
      queue_row_id,
      queue_id: queue_row_id,
      queue_key: input.queue_key,
      result: { raw: { metadata: input.metadata } },
    }),
    sendTextgridImpl: async () => {
      provider_calls += 1;
      events.push("provider");
      return { ok: true, sid: "SMpostsend1" };
    },
    finalizeSendQueueSuccessImpl: async (row) => {
      events.push("finalize");
      return { ...row, queue_status: "sent", provider_message_id: "SMpostsend1" };
    },
    writeOutboundSuccessMessageEventImpl: async () => {
      events.push("message_event");
      return { id: "evt-post-send-1" };
    },
    promoteFirstContactOnProviderAcceptance: async ({ outbound_event }) => {
      events.push(`promote:${outbound_event?.id ?? "none"}`);
      return { ok: true, promoted: false, reason: "already_engaged:waiting_on_seller" };
    },
    finalizeSendQueueFailureImpl: async (row) => {
      events.push("finalize_failure");
      return { ...row, queue_status: "failed" };
    },
    writeOutboundFailureMessageEventImpl: async () => {
      events.push("failure_event");
      return null;
    },
    ...overrides,
  };

  return { deps, events, supabase, provider_calls: () => provider_calls };
}

afterEach(async () => {
  await drainPostSendProjections();
});

// ── executeManualInboxSendNow ────────────────────────────────────────────────

test("slow projections no longer hold the response: answered once the send is durable", async () => {
  const gate = deferred();
  const harness = makeHarness({
    overrides: {
      post_send_budget_ms: 40,
      writeOutboundSuccessMessageEventImpl: async () => {
        harness.events.push("message_event:start");
        await gate.promise; // stands in for the 2026-09-30 DB saturation
        harness.events.push("message_event");
        return { id: "evt-slow-1" };
      },
    },
  });

  const started = Date.now();
  const result = await executeManualInboxSendNow(BASE_PAYLOAD, harness.deps);
  const elapsed = Date.now() - started;

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.queue_status, "sent");
  assert.equal(result.provider_message_id, "SMpostsend1");
  assert.equal(result.delivery_status_display, "sent");
  assert.equal(result.message_event_id, null, "the projection has not written yet");
  assert.equal(result.diagnostics.post_send_projection.state, "deferred");
  assert.equal(result.diagnostics.post_send_projection.budget_ms, 40);
  assert.equal(result.diagnostics.bookkeeping_error, null);
  assert.ok(elapsed < 2000, `response must not wait for the projection (took ${elapsed}ms)`);

  // The durable record was written BEFORE the response; the projection had
  // started but not finished; the provider was called exactly once.
  assert.deepEqual(harness.events, ["provider", "finalize", "message_event:start"]);
  assert.equal(harness.provider_calls(), 1);
  assert.equal(pendingPostSendProjectionCount(), 1);

  gate.resolve();
  await drainPostSendProjections();

  // Same work, same order, exactly once -- just after the response.
  assert.deepEqual(harness.events, [
    "provider",
    "finalize",
    "message_event:start",
    "message_event",
    "promote:evt-slow-1",
  ]);
  assert.equal(harness.provider_calls(), 1);
  assert.equal(pendingPostSendProjectionCount(), 0);
});

test("fast projections are unchanged: message_event_id returned, promotion ran before the response", async () => {
  const harness = makeHarness();
  const result = await executeManualInboxSendNow(BASE_PAYLOAD, harness.deps);

  assert.equal(result.ok, true);
  assert.equal(result.message_event_id, "evt-post-send-1");
  assert.equal(result.diagnostics.post_send_projection.state, "completed");
  assert.equal(result.diagnostics.post_send_projection.budget_ms, DEFAULT_POST_SEND_BUDGET_MS);
  assert.deepEqual(harness.events, ["provider", "finalize", "message_event", "promote:evt-post-send-1"]);
  assert.equal(pendingPostSendProjectionCount(), 0);
});

test("a projection that fails inside the budget is reported exactly as before (sent, bookkeeping_error)", async () => {
  const harness = makeHarness({
    overrides: {
      writeOutboundSuccessMessageEventImpl: async () => {
        harness.events.push("message_event:throw");
        throw new Error("message_events upsert failed");
      },
    },
  });
  const result = await executeManualInboxSendNow(BASE_PAYLOAD, harness.deps);

  assert.equal(result.ok, true, "the SMS was sent; bookkeeping failure never turns it into a failure");
  assert.equal(result.queue_status, "sent");
  assert.equal(result.diagnostics.bookkeeping_error, "message_events upsert failed");
  assert.equal(result.diagnostics.post_send_projection.state, "failed");
  assert.deepEqual(harness.events, ["provider", "finalize", "message_event:throw"], "promotion is skipped, as before");
});

test("a projection that fails AFTER the response is contained: no unhandled rejection, send stays sent", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const gate = deferred();
    const harness = makeHarness({
      overrides: {
        post_send_budget_ms: 20,
        writeOutboundSuccessMessageEventImpl: async () => {
          await gate.promise;
          throw new Error("late projection failure");
        },
      },
    });

    const result = await executeManualInboxSendNow(BASE_PAYLOAD, harness.deps);
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.post_send_projection.state, "deferred");

    gate.resolve();
    await drainPostSendProjections();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, []);
    assert.equal(harness.provider_calls(), 1);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("finalize failure still skips the projections and still reports the send as sent", async () => {
  const harness = makeHarness({
    overrides: {
      finalizeSendQueueSuccessImpl: async () => {
        harness.events.push("finalize:throw");
        throw new Error("queue_row_lock_mismatch_after_send");
      },
    },
  });
  const result = await executeManualInboxSendNow(BASE_PAYLOAD, harness.deps);

  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.bookkeeping_error, "queue_row_lock_mismatch_after_send");
  assert.equal(result.diagnostics.post_send_projection, null);
  assert.deepEqual(harness.events, ["provider", "finalize:throw"]);
  assert.equal(pendingPostSendProjectionCount(), 0);
});

test("provider failure path is untouched: failure bookkeeping runs inline, no projection is started", async () => {
  const harness = makeHarness({
    overrides: {
      sendTextgridImpl: async () => {
        harness.events.push("provider:reject");
        const error = new Error("TextGrid 400 invalid 'To' number");
        error.status = 400;
        throw error;
      },
    },
  });
  const result = await executeManualInboxSendNow(BASE_PAYLOAD, harness.deps);

  assert.equal(result.ok, false);
  assert.equal(result.delivery_status_display, "failed");
  assert.deepEqual(harness.events, ["provider:reject", "finalize_failure", "failure_event"]);
  assert.equal(pendingPostSendProjectionCount(), 0);
});

// ── post-send-projection primitives ──────────────────────────────────────────

test("runPostSendProjection: inside the budget it is a plain await", async () => {
  const outcome = await runPostSendProjection({ task: async () => "done", budget_ms: 1000 });
  assert.equal(outcome.state, "completed");
  assert.equal(outcome.value, "done");

  const failed = await runPostSendProjection({
    task: async () => {
      throw new Error("boom");
    },
    budget_ms: 1000,
  });
  assert.equal(failed.state, "failed");
  assert.equal(failed.error.message, "boom");
});

test("runPostSendProjection: past the budget it defers and reports the late outcome once", async () => {
  const gate = deferred();
  const late = [];
  const outcome = await runPostSendProjection({
    task: async () => {
      await gate.promise;
      return "late-value";
    },
    budget_ms: 10,
    on_background_settled: (settled) => late.push(settled),
  });
  assert.equal(outcome.state, "deferred");
  assert.equal(late.length, 0);

  gate.resolve();
  await drainPostSendProjections();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(late.length, 1);
  assert.equal(late[0].state, "completed");
  assert.equal(late[0].value, "late-value");
});

test("runPostSendProjection: one thread's projections never interleave; other threads are not blocked", async () => {
  const order = [];
  const first_gate = deferred();

  const first = await runPostSendProjection({
    key: "+15005550100",
    budget_ms: 5,
    task: async () => {
      order.push("A1:start");
      await first_gate.promise;
      order.push("A1:end");
    },
  });
  assert.equal(first.state, "deferred");

  const second = await runPostSendProjection({
    key: "+15005550100",
    budget_ms: 5,
    task: async () => {
      order.push("A2:start");
    },
  });
  assert.equal(second.state, "deferred", "chained behind A1, so still pending");

  const other = await runPostSendProjection({
    key: "+15005550199",
    budget_ms: 1000,
    task: async () => {
      order.push("B1");
    },
  });
  assert.equal(other.state, "completed", "a different thread is not queued behind A1");

  first_gate.resolve();
  await drainPostSendProjections();
  assert.deepEqual(order, ["A1:start", "B1", "A1:end", "A2:start"]);
});

test("runPostSendProjection: a hung projection cannot stall the thread's next one past the cap", async () => {
  const never = new Promise(() => {});
  const order = [];
  await runPostSendProjection({
    key: "+15005550111",
    budget_ms: 1,
    task: async () => {
      order.push("hung:start");
      await Promise.race([never, new Promise((resolve) => setTimeout(resolve, 300))]);
    },
  });
  const next = await runPostSendProjection({
    key: "+15005550111",
    budget_ms: 1000,
    same_thread_wait_cap_ms: 20,
    task: async () => {
      order.push("next");
      return "ran";
    },
  });
  assert.equal(next.state, "completed");
  assert.equal(next.value, "ran");
  assert.deepEqual(order, ["hung:start", "next"]);
  await drainPostSendProjections();
});

test("resolvePostSendBudgetMs: explicit > serverless (fully awaited) > env > default", () => {
  assert.equal(resolvePostSendBudgetMs({ budget_ms: 0, env: {} }), 0);
  assert.equal(resolvePostSendBudgetMs({ budget_ms: 250, env: { VERCEL: "1" } }), 250);
  assert.equal(resolvePostSendBudgetMs({ env: { VERCEL: "1" } }), Infinity);
  assert.equal(resolvePostSendBudgetMs({ env: { AWS_LAMBDA_FUNCTION_NAME: "fn" } }), Infinity);
  assert.equal(resolvePostSendBudgetMs({ env: { INBOX_SEND_POST_SEND_BUDGET_MS: "800" } }), 800);
  assert.equal(resolvePostSendBudgetMs({ env: { INBOX_SEND_POST_SEND_BUDGET_MS: "nope" } }), DEFAULT_POST_SEND_BUDGET_MS);
  assert.equal(resolvePostSendBudgetMs({ env: {} }), DEFAULT_POST_SEND_BUDGET_MS);
  assert.equal(resolvePostSendBudgetMs({ budget_ms: -5, env: {} }), 0);
});
