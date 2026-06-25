/**
 * Controlled concurrency tests for delivery receipt reconciliation.
 * Reproduces the production lost-update window: delivered then pending callbacks.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { syncDeliveryEvent } from "@/lib/supabase/sms-engine.js";
import {
  mergeDeliveryReceiptState,
  mergeQueueDeliveryState,
} from "@/lib/domain/delivery/delivery-receipt-reconcile.js";

const NOW = "2026-05-27T10:10:00.000Z";

function createBarrier() {
  const gates = new Map();
  const waiters = new Map();

  return {
    async wait(name) {
      if (!gates.get(name)) {
        await new Promise((resolve) => {
          const list = waiters.get(name) || [];
          list.push(resolve);
          waiters.set(name, list);
        });
      }
    },
    open(name) {
      gates.set(name, true);
      const list = waiters.get(name) || [];
      for (const resolve of list) resolve();
      waiters.set(name, []);
    },
  };
}

function makeConcurrentDeliveryStore(initial = {}) {
  const state = {
    message_events: {
      id: 9001,
      thread_key: "5551234567",
      queue_id: 42,
      provider_message_sid: "SM_concurrent",
      metadata: { queue_id: 42 },
      delivery_status: initial.delivery_status || "sent",
      provider_delivery_status: initial.provider_delivery_status || "sent",
      raw_carrier_status: initial.raw_carrier_status || "sent",
      sent_at: initial.sent_at || "2026-05-27T10:00:00.000Z",
      delivered_at: initial.delivered_at || null,
      failed_at: null,
      master_owner_id: "mo-1",
      to_phone_number: "+15551234567",
    },
    send_queue: {
      id: 42,
      provider_message_id: "SM_concurrent",
      textgrid_message_id: "SM_concurrent",
      queue_status: initial.queue_status || "sent",
      sent_at: initial.sent_at || "2026-05-27T10:00:00.000Z",
      delivered_at: initial.delivered_at || null,
      delivery_confirmed: initial.delivery_confirmed || null,
      failed_reason: null,
      metadata: {},
    },
    inbox_thread_state: {
      thread_key: "5551234567",
      latest_direction: "outbound",
      latest_message_event_id: 9001,
      latest_delivery_status: initial.delivery_status || "sent",
    },
    webhook_log: {
      id: 501,
      processed: false,
      processed_at: null,
      error_message: null,
    },
  };

  let reconcile_lock = Promise.resolve();

  async function runSerialized(task) {
    const run = reconcile_lock.then(task);
    reconcile_lock = run.catch(() => {});
    return run;
  }

  const supabase = {
    rpc: async (_fn, args) => {
      return runSerialized(async () => {
        const incoming = {
          delivery_status: args.p_incoming_delivery_status,
          provider_delivery_status: args.p_provider_status,
          raw_carrier_status: args.p_raw_carrier_status,
          sent_at: args.p_sent_at,
          delivered_at: args.p_delivered_at,
          failed_at: args.p_failed_at,
          error_message: args.p_failure_reason,
          failure_reason: args.p_failure_reason,
          failure_bucket: args.p_failure_bucket,
          updated_at: args.p_now,
        };

        const merged_event = mergeDeliveryReceiptState(state.message_events, incoming);
        Object.assign(state.message_events, merged_event, { updated_at: args.p_now });

        const merged_queue = mergeQueueDeliveryState(state.send_queue, {
          ...incoming,
          queue_status_terminal: "failed",
        });
        Object.assign(state.send_queue, merged_queue);

        if (state.inbox_thread_state.latest_direction === "outbound") {
          state.inbox_thread_state.latest_delivery_status = merged_event.delivery_status;
        }

        if (args.p_webhook_log_id) {
          state.webhook_log.processed = true;
          state.webhook_log.processed_at = args.p_now;
          state.webhook_log.error_message = null;
        }

        return {
          ok: true,
          final_delivery_status: merged_event.delivery_status,
          message_events_updated: 1,
          send_queue_updated: 1,
          inbox_threads_updated: 1,
          reconciled_event_id: state.message_events.id,
        };
      });
    },
    from(table) {
      const chain = {
        _table: table,
        _filters: [],
        _payload: null,
        _is_update: false,
        _is_select: false,
        select() {
          this._is_select = true;
          return this;
        },
        eq(col, val) {
          this._filters.push([col, val]);
          return this;
        },
        or() {
          return this;
        },
        update(payload) {
          this._is_update = true;
          this._payload = payload;
          return this;
        },
        maybeSingle() {
          return Promise.resolve({ data: this._resolveOne(), error: null });
        },
        then(onFulfilled, onRejected) {
          return Promise.resolve({ data: this._resolveMany(), error: null }).then(onFulfilled, onRejected);
        },
        _resolveOne() {
          if (this._is_update) {
            if (this._table === "webhook_log") {
              Object.assign(state.webhook_log, this._payload);
            }
            return state[this._table] || null;
          }
          if (this._table === "inbox_thread_state") {
            return state.inbox_thread_state;
          }
          if (this._table === "message_events") {
            return state.message_events;
          }
          return null;
        },
        _resolveMany() {
          if (this._table === "message_events") return [state.message_events];
          if (this._table === "send_queue") return [state.send_queue];
          return [];
        },
      };
      return chain;
    },
  };

  return { supabase, state };
}

function makeLegacyRaceStore() {
  let delivery_status = "sent";
  let delivered_at = null;
  const barrier = createBarrier();
  let read_phase = 0;

  const supabase = {
    from(table) {
      const chain = {
        _table: table,
        _payload: null,
        _is_update: false,
        select() {
          return chain;
        },
        eq() {
          return chain;
        },
        or() {
          return chain;
        },
        update(payload) {
          chain._is_update = true;
          chain._payload = payload;
          return chain;
        },
        async maybeSingle() {
          if (chain._is_update) {
            if (barrier && read_phase > 0) {
              await barrier.wait("write");
            }
            delivery_status = chain._payload.delivery_status;
            delivered_at = chain._payload.delivered_at || delivered_at;
            return { data: { delivery_status, delivered_at }, error: null };
          }
          return { data: null, error: null };
        },
        then(onFulfilled, onRejected) {
          if (chain._is_update) {
            return (async () => {
              if (barrier && read_phase > 0) {
                await barrier.wait("write");
              }
              delivery_status = chain._payload.delivery_status;
              delivered_at = chain._payload.delivered_at || delivered_at;
              return { data: [{ delivery_status, delivered_at }], error: null };
            })().then(onFulfilled, onRejected);
          }
          return Promise.resolve({ data: [{ id: 9001, delivery_status, delivered_at }], error: null })
            .then(async (result) => {
              read_phase += 1;
              if (barrier) {
                await barrier.wait("read");
              }
              return result;
            })
            .then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
  };

  return {
    supabase,
    getStatus: () => delivery_status,
    barrier,
  };
}

test("mergeDeliveryReceiptState: sent → delivered → pending stays delivered", () => {
  let current = { delivery_status: "sent", provider_delivery_status: "sent" };
  current = mergeDeliveryReceiptState(current, {
    delivery_status: "delivered",
    provider_delivery_status: "delivered",
    delivered_at: NOW,
  });
  current = mergeDeliveryReceiptState(current, {
    delivery_status: "sent",
    provider_delivery_status: "pending",
  });
  assert.equal(current.delivery_status, "delivered");
  assert.equal(current.provider_delivery_status, "delivered");
});

test("mergeDeliveryReceiptState: delivered → queued stays delivered", () => {
  const current = {
    delivery_status: "delivered",
    provider_delivery_status: "delivered",
    delivered_at: NOW,
  };
  const merged = mergeDeliveryReceiptState(current, {
    delivery_status: "sent",
    provider_delivery_status: "queued",
  });
  assert.equal(merged.delivery_status, "delivered");
  assert.equal(merged.provider_delivery_status, "delivered");
});

test("mergeDeliveryReceiptState: failed → delivered promotes to delivered", () => {
  const current = {
    delivery_status: "failed",
    provider_delivery_status: "failed",
    failed_at: NOW,
  };
  const merged = mergeDeliveryReceiptState(current, {
    delivery_status: "delivered",
    provider_delivery_status: "delivered",
    delivered_at: NOW,
  });
  assert.equal(merged.delivery_status, "delivered");
});

test("mergeDeliveryReceiptState: failed → pending stays failed", () => {
  const current = {
    delivery_status: "failed",
    provider_delivery_status: "failed",
    failed_at: NOW,
  };
  const merged = mergeDeliveryReceiptState(current, {
    delivery_status: "sent",
    provider_delivery_status: "pending",
  });
  assert.equal(merged.delivery_status, "failed");
});

test("syncDeliveryEvent: concurrent delivered/pending callbacks end delivered everywhere", async () => {
  const { supabase, state } = makeConcurrentDeliveryStore();
  const barrier = createBarrier();

  const noopOutreach = { updateContactOutreachState: async () => ({ ok: true }) };

  const runPending = syncDeliveryEvent(
    { message_id: "SM_concurrent", status: "pending" },
    {
      supabase,
      now: NOW,
      webhook_log_id: 501,
      ...noopOutreach,
      async reconcileDeliveryReceipt(args) {
        await barrier.wait("pending-read");
        return supabase.rpc("reconcile_delivery_receipt", {
          p_provider_message_sid: args.provider_message_sid,
          p_provider_status: args.provider_status,
          p_raw_carrier_status: args.raw_carrier_status,
          p_incoming_delivery_status: args.incoming_delivery_status,
          p_sent_at: args.incoming_sent_at,
          p_delivered_at: args.incoming_delivered_at,
          p_failed_at: null,
          p_failure_reason: null,
          p_failure_bucket: null,
          p_failure_metadata: null,
          p_webhook_log_id: args.webhook_log_id,
          p_now: args.now,
        });
      },
    },
  );

  const runDelivered = syncDeliveryEvent(
    { message_id: "SM_concurrent", status: "delivered" },
    {
      supabase,
      now: NOW,
      webhook_log_id: 501,
      ...noopOutreach,
      async reconcileDeliveryReceipt(args) {
        await barrier.wait("delivered-read");
        const result = await supabase.rpc("reconcile_delivery_receipt", {
          p_provider_message_sid: args.provider_message_sid,
          p_provider_status: args.provider_status,
          p_raw_carrier_status: args.raw_carrier_status,
          p_incoming_delivery_status: args.incoming_delivery_status,
          p_sent_at: args.incoming_sent_at,
          p_delivered_at: args.incoming_delivered_at,
          p_failed_at: null,
          p_failure_reason: null,
          p_failure_bucket: null,
          p_failure_metadata: null,
          p_webhook_log_id: args.webhook_log_id,
          p_now: args.now,
        });
        barrier.open("pending-read");
        return result;
      },
    },
  );

  barrier.open("delivered-read");
  await Promise.all([runPending, runDelivered]);

  assert.equal(state.message_events.delivery_status, "delivered");
  assert.equal(state.send_queue.queue_status, "delivered");
  assert.equal(state.inbox_thread_state.latest_delivery_status, "delivered");
  assert.equal(state.webhook_log.processed, true);
});

test("legacy read-then-write race loses delivered when pending completes last", () => {
  const staleRead = { delivery_status: "sent", provider_delivery_status: "sent" };
  const deliveredWrite = {
    delivery_status: "delivered",
    provider_delivery_status: "delivered",
    delivered_at: NOW,
  };
  const pendingWrite = {
    delivery_status: "sent",
    provider_delivery_status: "pending",
    delivered_at: null,
  };

  const finalState = { ...staleRead };
  Object.assign(finalState, deliveredWrite);
  Object.assign(finalState, pendingWrite);

  assert.equal(finalState.delivery_status, "sent", "late pending overwrote delivered delivery_status");
  assert.equal(finalState.provider_delivery_status, "pending");
  assert.equal(finalState.delivered_at, null, "delivered_at was cleared by stale pending write");
});

test("syncDeliveryEvent: duplicate delivered callbacks are idempotent", async () => {
  const { supabase, state } = makeConcurrentDeliveryStore({
    delivery_status: "delivered",
    provider_delivery_status: "delivered",
    delivered_at: NOW,
    queue_status: "delivered",
    delivery_confirmed: "confirmed",
  });

  const outreach = { updateContactOutreachState: async () => ({ ok: true }) };
  await syncDeliveryEvent(
    { message_id: "SM_concurrent", status: "delivered" },
    { supabase, now: NOW, ...outreach },
  );
  await syncDeliveryEvent(
    { message_id: "SM_concurrent", status: "delivered" },
    { supabase, now: NOW, ...outreach },
  );

  assert.equal(state.message_events.delivery_status, "delivered");
  assert.equal(state.send_queue.queue_status, "delivered");
  assert.ok(state.message_events.delivered_at);
});

test("syncDeliveryEvent: failed reconciliation records webhook_log error", async () => {
  const { supabase, state } = makeConcurrentDeliveryStore();
  supabase.rpc = async () => {
    throw new Error("rpc_failed");
  };

  await assert.rejects(
    () =>
      syncDeliveryEvent(
        { message_id: "SM_concurrent", status: "delivered" },
        {
          supabase,
          now: NOW,
          webhook_log_id: 501,
          updateContactOutreachState: async () => ({ ok: true }),
        },
      ),
    /rpc_failed/,
  );

  assert.equal(state.webhook_log.processed, false);
  assert.match(state.webhook_log.error_message || "", /rpc_failed/);
});