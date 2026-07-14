/**
 * Compliance send-boundary tests — B1/B2/B3 hardening matrix (A–R).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { cancelSupabasePendingOutbound, CANCELLATION_POLICIES } from "@/lib/domain/queue/cancel-supabase-pending-outbound.js";
import { evaluateCanonicalContactability } from "@/lib/domain/compliance/evaluate-canonical-contactability.js";
import { evaluateAndBlockSendAtCompliance } from "@/lib/domain/queue/block-send-at-compliance.js";
import { buildSupabaseQueueRow, makeQueueTestRpc } from "../helpers/queue-run-test-harness.js";

const NOW = "2026-07-13T18:00:00.000Z";
const THREAD = "+15005550006";
const OTHER_THREAD = "+15005550099";

function makeComplianceSupabase(initial_rows = [], table_data = {}) {
  const rows = new Map(
    initial_rows.map((row) => {
      if (!row.metadata || typeof row.metadata !== "object") row.metadata = {};
      return [String(row.id), row];
    })
  );
  const suppression = table_data.suppression || [];
  const phones = table_data.phones || [];
  const thread_state = table_data.thread_state || null;
  const message_events = table_data.message_events || [];
  let emit_count = 0;

  const supabase = {
    from(table) {
      if (table === "send_queue") {
        return {
          select() {
            const query = {
              _filters: [],
              eq(col, val) {
                this._filters.push({ op: "eq", col, val });
                return this;
              },
              in(col, vals) {
                this._filters.push({ op: "in", col, vals });
                return this;
              },
              limit() {
                let result = [...rows.values()];
                for (const f of this._filters) {
                  if (f.op === "eq") {
                    result = result.filter((r) => r[f.col] === f.val);
                  }
                  if (f.op === "in" && Array.isArray(f.val)) {
                    result = result.filter((r) => f.val.includes(r[f.col]));
                  }
                }
                return Promise.resolve({ data: result, error: null });
              },
              maybeSingle: async function maybeSingle() {
                const id_filter = this._filters.find((f) => f.col === "id");
                if (id_filter) {
                  const row = rows.get(String(id_filter.val));
                  return { data: row || null, error: null };
                }
                return { data: null, error: null };
              },
            };
            return query;
          },
          update(patch) {
            const applyUpdate = async (col, val, status_col = null, status_vals = null) => {
              const row = rows.get(String(val));
              if (!row) return { error: null };
              if (status_col && status_vals && !status_vals.includes(row[status_col])) {
                return { error: null };
              }
              Object.assign(row, patch);
              if (patch.metadata) {
                row.metadata = { ...(row.metadata || {}), ...patch.metadata };
              }
              return { error: null };
            };
            return {
              eq(col, val) {
                return {
                  in(col2, vals) {
                    return applyUpdate(col, val, col2, vals);
                  },
                  then(resolve, reject) {
                    return applyUpdate(col, val).then(resolve, reject);
                  },
                };
              },
            };
          },
        };
      }

      if (table === "sms_suppression_list") {
        return {
          select() {
            return {
              or() {
                return this;
              },
              eq() {
                return this;
              },
              limit() {
                return Promise.resolve({ data: suppression, error: null });
              },
            };
          },
          insert: async () => ({ error: null }),
        };
      }

      if (table === "phones") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({ data: phones[0] || null, error: null }),
                };
              },
            };
          },
          update() {
            return { eq: async () => ({ error: null }) };
          },
        };
      }

      if (table === "inbox_thread_state") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({ data: thread_state, error: null }),
                };
              },
            };
          },
        };
      }

      if (table === "deal_thread_state") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({ data: null, error: null }),
                };
              },
            };
          },
        };
      }

      if (table === "message_events") {
        return {
          select() {
            return {
              eq() {
                return {
                  order() {
                    return {
                      limit: async () => ({ data: message_events, error: null }),
                    };
                  },
                };
              },
            };
          },
        };
      }

      if (table === "textgrid_numbers") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: { phone_number: "+15005550001" },
                    error: null,
                  }),
                };
              },
            };
          },
        };
      }

      return {
        select() {
          return { eq() { return { maybeSingle: async () => ({ data: null, error: null }) }; } };
        },
      };
    },
    rpc: makeQueueTestRpc(),
    _emit_count: () => emit_count,
  };

  return { supabase, rows, bump_emit: () => { emit_count += 1; } };
}

// A — queued auto_reply + STOP before claim
test("A: queued auto_reply cancelled on compliance before claim", async () => {
  const row = buildSupabaseQueueRow("ar-1", {
    thread_key: THREAD,
    type: "auto_reply",
    queue_status: "queued",
  });
  const { supabase } = makeComplianceSupabase([row]);

  const result = await cancelSupabasePendingOutbound(
    {
      thread_key: THREAD,
      policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL,
      reason: "opt_out",
      inbound_event_id: "evt-stop-1",
    },
    { supabase }
  );

  assert.equal(result.cancelled, 1);
  assert.equal(row.queue_status, "cancelled");
});

// B — queued auto_reply + STOP after claim but before transport
test("B: send-time guard blocks claimed auto_reply with zero transport calls", async () => {
  const row = buildSupabaseQueueRow("ar-claimed", {
    thread_key: THREAD,
    type: "auto_reply",
    queue_status: "processing",
    lock_token: "lock-1",
  });
  const { supabase } = makeComplianceSupabase([row], {
    message_events: [{ is_opt_out: true, detected_intent: "opt_out" }],
  });

  let transport_calls = 0;
  const block = await evaluateAndBlockSendAtCompliance(row, {
    supabase,
    claimedLockToken: "lock-1",
    sendTextgridSMS: async () => {
      transport_calls += 1;
      return { ok: true, sid: "SMxxx" };
    },
  });

  assert.equal(block.blocked, true);
  assert.equal(block.result?.sent, false);
  assert.equal(row.queue_status, "cancelled");
  assert.equal(transport_calls, 0);
});

// C — queued followup + opt-out
test("C: queued followup cancelled on opt-out", async () => {
  const row = buildSupabaseQueueRow("fu-1", {
    thread_key: THREAD,
    type: "followup",
    queue_status: "scheduled",
  });
  const { supabase } = makeComplianceSupabase([row]);

  const result = await cancelSupabasePendingOutbound(
    {
      thread_key: THREAD,
      reason: "opt_out",
      policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL,
    },
    { supabase }
  );

  assert.equal(result.cancelled, 1);
  assert.equal(row.queue_status, "cancelled");
});

// D — campaign touch + wrong number
test("D: queued campaign touch cancelled on wrong number", async () => {
  const row = buildSupabaseQueueRow("camp-1", {
    thread_key: THREAD,
    type: "outbound",
    message_type: "campaign_touch",
    queue_status: "queued",
    campaign_id: "camp-abc",
  });
  const { supabase } = makeComplianceSupabase([row], {
    phones: [{ canonical_e164: THREAD, wrong_number: true, phone_contact_status: "wrong_number" }],
  });

  const cancel = await cancelSupabasePendingOutbound(
    {
      thread_key: THREAD,
      reason: "wrong_number",
      policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL,
    },
    { supabase }
  );
  assert.equal(cancel.cancelled, 1);

  const guard = await evaluateCanonicalContactability(
    { thread_key: THREAD, to_phone_number: THREAD, phone_id: null },
    { supabase }
  );
  assert.equal(guard.blocked, true);
  assert.equal(guard.reason_code, "wrong_number_at_send_time");
});

// E — suppression list added after enqueue blocks at send time
test("E: send-time guard blocks when suppression list added after enqueue", async () => {
  const row = buildSupabaseQueueRow("post-enqueue", {
    thread_key: THREAD,
    queue_status: "processing",
  });
  const { supabase } = makeComplianceSupabase([row], {
    suppression: [{ id: "sup-1", is_active: true, suppression_reason: "opt_out" }],
  });

  const guard = await evaluateCanonicalContactability(
    { thread_key: THREAD, to_phone_number: THREAD, queue_row_id: row.id },
    { supabase }
  );
  assert.equal(guard.blocked, true);
  assert.equal(guard.reason_code, "opted_out_at_send_time");
});

// F — terminal not-owner policy cancels pending rows
test("F: terminal not-owner compliance cancels pending rows", async () => {
  const row = buildSupabaseQueueRow("not-owner", {
    thread_key: THREAD,
    type: "auto_reply",
    queue_status: "queued",
  });
  const { supabase } = makeComplianceSupabase([row]);

  const result = await cancelSupabasePendingOutbound(
    {
      thread_key: THREAD,
      reason: "inbound_compliance_suppression",
      suppression_reason: "not_owner_terminal",
      policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL,
    },
    { supabase }
  );
  assert.equal(result.cancelled, 1);
});

// G — inbound takeover does not cancel unrelated campaign rows
test("G: inbound takeover cancels followup/auto_reply only, not campaign touch", async () => {
  const followup = buildSupabaseQueueRow("g-fu", {
    thread_key: THREAD,
    type: "followup",
    queue_status: "queued",
  });
  const auto_reply = buildSupabaseQueueRow("g-ar", {
    thread_key: THREAD,
    type: "auto_reply",
    queue_status: "queued",
  });
  const campaign = buildSupabaseQueueRow("g-camp", {
    thread_key: THREAD,
    type: "outbound",
    message_type: "campaign_touch",
    queue_status: "queued",
  });
  const { supabase } = makeComplianceSupabase([followup, auto_reply, campaign]);

  const result = await cancelSupabasePendingOutbound(
    {
      thread_key: THREAD,
      policy: CANCELLATION_POLICIES.INBOUND_TAKEOVER,
      reason: "cancelled_followup_on_inbound_reply",
    },
    { supabase }
  );

  assert.equal(result.cancelled, 2);
  assert.equal(followup.queue_status, "cancelled");
  assert.equal(auto_reply.queue_status, "cancelled");
  assert.equal(campaign.queue_status, "queued");
});

// H — duplicate opt-out webhook is idempotent
test("H: duplicate compliance cancellation is idempotent", async () => {
  const row = buildSupabaseQueueRow("dup-1", {
    thread_key: THREAD,
    type: "auto_reply",
    queue_status: "queued",
  });
  const { supabase } = makeComplianceSupabase([row]);
  const cache = new Set();

  const first = await cancelSupabasePendingOutbound(
    {
      thread_key: THREAD,
      reason: "opt_out",
      inbound_event_id: "evt-dup",
      policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL,
    },
    { supabase, audit_idempotency_cache: cache }
  );
  const second = await cancelSupabasePendingOutbound(
    {
      thread_key: THREAD,
      reason: "opt_out",
      inbound_event_id: "evt-dup",
      policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL,
    },
    { supabase, audit_idempotency_cache: cache }
  );

  assert.equal(first.cancelled, 1);
  assert.equal(second.idempotent_replay, true);
  assert.equal(second.cancelled, 0);
});

// I — cancellation by thread_key only affects matching thread
test("I: cancellation by thread_key leaves unrelated thread untouched", async () => {
  const match = buildSupabaseQueueRow("i-match", {
    thread_key: THREAD,
    type: "auto_reply",
    queue_status: "queued",
  });
  const other = buildSupabaseQueueRow("i-other", {
    thread_key: OTHER_THREAD,
    to_phone_number: OTHER_THREAD,
    type: "auto_reply",
    queue_status: "queued",
  });
  const { supabase } = makeComplianceSupabase([match, other]);

  const result = await cancelSupabasePendingOutbound(
    { thread_key: THREAD, policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL, reason: "opt_out" },
    { supabase }
  );

  assert.equal(result.cancelled, 1);
  assert.equal(match.queue_status, "cancelled");
  assert.equal(other.queue_status, "queued");
});

// J — cancellation by phone cancels all matching unsent rows
test("J: cancellation by phone cancels all matching unsent rows", async () => {
  const a = buildSupabaseQueueRow("j-a", {
    thread_key: THREAD,
    to_phone_number: THREAD,
    type: "followup",
    queue_status: "queued",
  });
  const b = buildSupabaseQueueRow("j-b", {
    thread_key: THREAD,
    to_phone_number: THREAD,
    type: "auto_reply",
    queue_status: "scheduled",
  });
  const { supabase } = makeComplianceSupabase([a, b]);

  const result = await cancelSupabasePendingOutbound(
    { to_phone_number: THREAD, policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL, reason: "opt_out" },
    { supabase }
  );

  assert.equal(result.cancelled, 2);
});

// K — processing row becomes suppressed → no TextGrid call (claim-to-send race guard)
test("K: processing row blocked at send time with no TextGrid call", async () => {
  const row = buildSupabaseQueueRow("k-1", {
    thread_key: THREAD,
    queue_status: "processing",
    lock_token: "lock-k",
    seller_first_name: "John",
  });
  const { supabase } = makeComplianceSupabase([row], {
    suppression: [{ id: "s1", is_active: true, suppression_reason: "opt_out" }],
  });

  let transport_calls = 0;
  const block = await evaluateAndBlockSendAtCompliance(row, {
    supabase,
    claimedLockToken: "lock-k",
    sendTextgridSMS: async () => {
      transport_calls += 1;
      return { ok: true, sid: "SMblocked" };
    },
  });

  assert.equal(transport_calls, 0);
  assert.equal(block.blocked, true);
  assert.match(block.result?.reason || "", /suppressed|opted_out/);
  assert.equal(row.queue_status, "cancelled");
});

// L — delivered row unchanged
test("L: delivered row is not cancelled by compliance helper", async () => {
  const row = buildSupabaseQueueRow("l-1", {
    thread_key: THREAD,
    queue_status: "delivered",
    type: "auto_reply",
  });
  const { supabase } = makeComplianceSupabase([row]);

  const result = await cancelSupabasePendingOutbound(
    { thread_key: THREAD, policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL, reason: "opt_out" },
    { supabase }
  );

  assert.equal(result.cancelled, 0);
  assert.equal(row.queue_status, "delivered");
});

// M — terminal failed row unchanged
test("M: terminal failed row is not cancelled", async () => {
  const row = buildSupabaseQueueRow("m-1", {
    thread_key: THREAD,
    queue_status: "failed",
    failed_reason: "content_filter_blocked",
  });
  const { supabase } = makeComplianceSupabase([row]);

  const result = await cancelSupabasePendingOutbound(
    { thread_key: THREAD, policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL, reason: "opt_out" },
    { supabase }
  );

  assert.equal(result.cancelled, 0);
  assert.equal(row.queue_status, "failed");
});

// N — internal canary row gets same compliance guard
test("N: internal canary row blocked by compliance guard", async () => {
  const row = buildSupabaseQueueRow("n-1", {
    thread_key: THREAD,
    queue_status: "processing",
    metadata: { internal_test_phone: true, proof: true },
  });
  const { supabase } = makeComplianceSupabase([row], {
    message_events: [{ is_opt_out: true }],
  });

  const block = await evaluateAndBlockSendAtCompliance(row, { supabase });
  assert.equal(block.blocked, true);
});

// O — manual scheduled row blocked after opt-out at send time
test("O: manual operator send blocked at send time after opt-out", async () => {
  const row = buildSupabaseQueueRow("o-1", {
    thread_key: THREAD,
    queue_status: "processing",
    metadata: { manual_operator_send: true, source: "manual_inbox" },
  });
  const { supabase } = makeComplianceSupabase([row], {
    suppression: [{ id: "s2", is_active: true, suppression_reason: "opt_out" }],
  });

  const block = await evaluateAndBlockSendAtCompliance(row, {
    supabase,
    manual_operator_send: true,
  });
  assert.equal(block.blocked, true);
  assert.equal(block.result?.final_queue_status, "cancelled");
});

// P — retry_pending (queued + next_retry_at) cancelled, never retried
test("P: queued retry row cancelled on compliance", async () => {
  const row = buildSupabaseQueueRow("p-1", {
    thread_key: THREAD,
    queue_status: "queued",
    next_retry_at: "2026-07-13T19:00:00.000Z",
    retry_count: 1,
  });
  const { supabase } = makeComplianceSupabase([row]);

  const result = await cancelSupabasePendingOutbound(
    { thread_key: THREAD, policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL, reason: "opt_out" },
    { supabase }
  );

  assert.equal(result.cancelled, 1);
  assert.equal(row.queue_status, "cancelled");
  assert.equal(row.metadata.next_retry_at ?? row.next_retry_at, row.next_retry_at);
});

// Q — suppression lookup DB error fails closed for automated sends
test("Q: suppression lookup failure fails closed for automated sends", async () => {
  const supabase = {
    from(table) {
      if (table === "send_queue") {
        return {
          select() {
            return {
              eq() {
                return { maybeSingle: async () => ({ data: null, error: null }) };
              },
            };
          },
        };
      }
      if (table === "sms_suppression_list") {
        return {
          select() {
            return {
              or() {
                return this;
              },
              eq() {
                return this;
              },
              limit: async () => ({ data: null, error: new Error("db_down") }),
            };
          },
        };
      }
      return {
        select() {
          return { eq() { return { maybeSingle: async () => ({ data: null, error: null }) }; } };
        },
      };
    },
    rpc: makeQueueTestRpc(),
  };

  const guard = await evaluateCanonicalContactability(
    { thread_key: THREAD, to_phone_number: THREAD, fail_closed_for_automated: true },
    { supabase }
  );

  assert.equal(guard.blocked, true);
  assert.equal(guard.fail_closed, true);
});

// R — duplicate lookup DB error on auto-reply dedupe preserves existing fail-open (not changed here)
test("R: compliance guard independent of duplicate lookup fail-open behavior", async () => {
  const guard = await evaluateCanonicalContactability(
    { thread_key: null, to_phone_number: null, fail_closed_for_automated: true },
    { supabase: null }
  );
  assert.equal(guard.blocked, true);
  assert.equal(guard.reason, "suppression_check_unavailable");
});