/**
 * Compatibility tests between legacy canSend / queue callers and compliance layer.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { canSend, createInboxSendNowQueueRow } from "@/lib/domain/inbox/send-now-service.js";
import { evaluateCanonicalContactability, CONTACT_CHECK_MODES } from "@/lib/domain/compliance/evaluate-canonical-contactability.js";
import { cancelPendingFollowUpsForThread } from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import { processSendQueueItem } from "@/lib/domain/queue/process-send-queue.js";
import { extendSupabaseForHealthyCompliance } from "../helpers/compliance-test-harness.js";
import { buildSupabaseQueueRow, makeQueueTestRpc } from "../helpers/queue-run-test-harness.js";

function makeLegacyHealthySupabase() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { status: "active", metadata: {} }, error: null }),
          or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
        }),
        or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
      }),
    }),
  };
}

function makeLegacySuppressedSupabase() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { status: "active", metadata: {} }, error: null }),
          or: () => ({ eq: () => Promise.resolve({ count: 1 }) }),
        }),
        or: () => ({ eq: () => Promise.resolve({ count: 1 }) }),
      }),
    }),
  };
}

function makePausedManualSupabase() {
  return {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data:
                table === "inbox_thread_state"
                  ? { status: "paused_review", metadata: {} }
                  : null,
              error: null,
            }),
          or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
        }),
        or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
      }),
    }),
  };
}

test("A: legacy canSend caller with healthy recipient is allowed", async () => {
  const result = await canSend(
    {
      to_phone_number: "+15005550001",
      thread_key: "+15005550001",
      message_body: "Hi John, are you interested in selling?",
    },
    { supabase: makeLegacyHealthySupabase() }
  );
  assert.equal(result.ok, true);
});

test("B: legacy canSend caller with suppressed recipient is blocked", async () => {
  const result = await canSend(
    {
      to_phone_number: "+15005550099",
      message_body: "Hi John, interested in selling?",
    },
    { supabase: makeLegacySuppressedSupabase() }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "phone_suppressed");
});

test("C: manual-review recipient with explicit operator send is allowed when contactable", async () => {
  const result = await canSend(
    {
      to_phone_number: "+15005550001",
      thread_key: "+15005550001",
      message_body: "Manual bypass proof",
      source: "manual_inbox",
      action: "send_now",
    },
    { supabase: makePausedManualSupabase() }
  );
  assert.equal(result.ok, true);
});

test("D: manual-review recipient with suppression remains blocked", async () => {
  const result = await canSend(
    {
      to_phone_number: "+15005550099",
      thread_key: "+15005550099",
      message_body: "Should not send",
      source: "manual_inbox",
      action: "send_now",
    },
    { supabase: makeLegacySuppressedSupabase() }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "phone_suppressed");
});

test("E: processSendQueueItem healthy legacy fake calls provider once", async () => {
  const row = buildSupabaseQueueRow("compat-healthy", {
    queue_status: "processing",
    lock_token: "lock-compat",
  });
  let transport_calls = 0;
  const supabase = extendSupabaseForHealthyCompliance({ rpc: makeQueueTestRpc() });

  const result = await processSendQueueItem(row, {
    supabase,
    supabaseClient: supabase,
    getSystemValue: async () => null,
    claimedLockToken: "lock-compat",
    sendTextgridSMS: async () => {
      transport_calls += 1;
      return { sid: "SMcompat", raw: { status: "queued" } };
    },
    evaluateContactWindow: () => ({
      allowed: true,
      reason: "within_contact_window",
      timezone: "America/Chicago",
      valid_window: true,
    }),
    selectAvailableTextgridNumber: async () => ({
      ok: true,
      from_phone_number: "+15005550001",
      selected: { id: "tg-1", phone_number: "+15005550001", market: "houston" },
    }),
    updateSendQueueRowWithLock: async (row_id, lock_token, payload) => ({
      ...row,
      ...payload,
      id: row_id,
      queue_row_id: row_id,
      queue_item_id: row_id,
      item_id: row_id,
      lock_token,
    }),
    writeOutboundSuccessMessageEvent: async () => ({ item_id: "evt-compat" }),
    finalizeSendQueueSuccess: async (queue_row, lock_token, send_result) => ({
      ...queue_row,
      queue_status: "sent",
      provider_message_id: send_result?.sid || "SMcompat",
      lock_token,
    }),
  });

  assert.equal(transport_calls, 1);
  assert.equal(result.sent, true);
});

test("F: enqueue contactability with missing optional data preserves healthy behavior", async () => {
  const guard = await evaluateCanonicalContactability(
    {
      thread_key: "+15005550001",
      to_phone_number: "+15005550001",
      contact_check_mode: CONTACT_CHECK_MODES.ENQUEUE,
    },
    { supabase: makeLegacyHealthySupabase() }
  );
  assert.equal(guard.blocked, false);
});

test("G: send-time suppression lookup error fails closed for automated sends", async () => {
  const supabase = {
    from(table) {
      if (table === "sms_suppression_list") {
        return {
          select: () => ({
            eq: () => {
              throw new Error("db_down");
            },
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      };
    },
  };
  const guard = await evaluateCanonicalContactability(
    {
      thread_key: "+15005550006",
      to_phone_number: "+15005550006",
      fail_closed_for_automated: true,
      contact_check_mode: CONTACT_CHECK_MODES.SEND_TIME,
    },
    { supabase }
  );
  assert.equal(guard.blocked, true);
  assert.equal(guard.fail_closed, true);
});

test("H: follow-up takeover fake Supabase proves cancellation", async () => {
  const rows = new Map([
    [
      "q1",
      {
        id: "q1",
        thread_key: "+15005550006",
        to_phone_number: "+15005550006",
        queue_status: "scheduled",
        type: "followup",
        metadata: {},
      },
    ],
  ]);
  const supabase = {
    from(table) {
      if (table !== "send_queue") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      }
      return {
        select() {
          const query = {
            _filters: [],
            eq(c, v) {
              this._filters.push({ op: "eq", col: c, val: v });
              return this;
            },
            in(c, vals) {
              this._filters.push({ op: "in", col: c, vals });
              return this;
            },
            limit: async function limit() {
              let result = [...rows.values()];
              for (const f of this._filters) {
                if (f.op === "eq") result = result.filter((r) => r[f.col] === f.val);
                if (f.op === "in") result = result.filter((r) => f.vals.includes(r[f.col]));
              }
              return { data: result, error: null };
            },
          };
          return query;
        },
        update(patch) {
          return {
            eq(col, val) {
              return {
                in(col2, vals) {
                  return (async () => {
                    const row = rows.get(String(val));
                    if (!row || !vals.includes(row[col2])) return { error: null };
                    Object.assign(row, patch);
                    if (patch.metadata) row.metadata = { ...row.metadata, ...patch.metadata };
                    return { error: null };
                  })();
                },
              };
            },
          };
        },
      };
    },
  };

  const result = await cancelPendingFollowUpsForThread({
    thread_key: "+15005550006",
    inbound_event_id: "evt-compat",
    supabase,
  });
  assert.equal(result.cancelled, 1);
  assert.equal(rows.get("q1").queue_status, "cancelled");
});

test("manual enqueue: suppressed manual inbox send blocked with no insert", async () => {
  let insert_called = false;
  const result = await createInboxSendNowQueueRow(
    {
      thread_key: "+15005550001",
      to_phone_number: "+15005550001",
      from_phone_number: "+15005550002",
      message_body: "Should not send",
      source: "manual_inbox",
      action: "send_now",
    },
    {
      supabase: makeLegacySuppressedSupabase(),
      insertImpl: async () => {
        insert_called = true;
        return { ok: true, queue_row_id: "should-not-insert" };
      },
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "phone_suppressed");
  assert.equal(insert_called, false);
});