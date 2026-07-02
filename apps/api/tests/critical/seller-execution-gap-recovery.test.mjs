import test from "node:test";
import assert from "node:assert/strict";

import { recoverSellerExecutionGaps } from "@/lib/domain/seller-flow/recover-seller-execution-gaps.js";

const NOW = Date.parse("2026-07-01T12:00:00.000Z");
const OLD = "2026-06-30T00:00:00.000Z";

/** Stateful mock covering inbox_thread_state, acquisition_opportunities, send_queue, message_events. */
function makeFakeSupabase(seed = {}) {
  const state = {
    inbox_thread_state: seed.inbox_thread_state || [],
    acquisition_opportunities: seed.acquisition_opportunities || [],
    send_queue: seed.send_queue || [],
    message_events: seed.message_events || [],
    other: [],
  };

  function rowsFor(table) {
    return state[table] || state.other;
  }

  function query(table) {
    const q = {
      _op: "select",
      _payload: null,
      _filters: [],
      select() { return q; },
      insert(row) { q._op = "insert"; q._payload = row; return q; },
      update(patch) { q._op = "update"; q._payload = patch; return q; },
      upsert(row) { q._op = "upsert"; q._payload = row; return q; },
      eq(col, val) { q._filters.push((r) => String(pick(r, col)) === String(val)); return q; },
      in(col, vals) { q._filters.push((r) => vals.map(String).includes(String(pick(r, col)))); return q; },
      is(col, val) { q._filters.push((r) => (val === null ? pick(r, col) == null : pick(r, col) === val)); return q; },
      not(col, op, val) { q._filters.push((r) => !(val === null ? pick(r, col) == null : pick(r, col) === val)); return q; },
      lt(col, val) { q._filters.push((r) => String(pick(r, col) ?? "") < String(val)); return q; },
      gte(col, val) { q._filters.push((r) => String(pick(r, col) ?? "") >= String(val)); return q; },
      order() { return q; },
      limit(n) { return q._run(n).then((rows) => ({ data: rows, error: null })); },
      maybeSingle() { return q._run(1).then((rows) => ({ data: rows[0] || null, error: null })); },
      single() { return q._run(1).then((rows) => ({ data: rows[0] || null, error: null })); },
      then(onF, onR) { return q._run().then(() => ({ data: null, error: null })).then(onF, onR); },
      async _run(n) {
        const rows = rowsFor(table);
        if (q._op === "insert" || q._op === "upsert") {
          const payload = Array.isArray(q._payload) ? q._payload[0] : q._payload;
          if (q._op === "upsert") {
            const keyCol = table === "inbox_thread_state" ? "thread_key" : "id";
            const existing = rows.find((r) => String(r[keyCol]) === String(payload[keyCol]));
            if (existing) {
              Object.assign(existing, payload);
              return [existing];
            }
          }
          const row = { id: `gen-${rows.length + 1}`, ...payload };
          rows.push(row);
          return [row];
        }
        const matches = rows.filter((r) => q._filters.every((f) => f(r)));
        if (q._op === "update") {
          for (const row of matches) Object.assign(row, q._payload);
        }
        return n ? matches.slice(0, n) : matches;
      },
    };
    return q;
  }

  function pick(row, col) {
    // Supports the json path forms used by the sweeps.
    if (col === "metadata->ade_snapshot") return row.metadata?.ade_snapshot ?? null;
    if (col === "metadata->negotiation_state->>terms_accepted") {
      const v = row.metadata?.negotiation_state?.terms_accepted;
      return v == null ? null : String(v);
    }
    if (col === "metadata->seller_flow_decision") return row.metadata?.seller_flow_decision ?? null;
    return row[col];
  }

  return { _state: state, from: (table) => query(table) };
}

test("stale active lead without next action gets one restored from its deal record", async () => {
  const supabase = makeFakeSupabase({
    inbox_thread_state: [
      {
        thread_key: "+13125550100",
        operational_status: "active_communication",
        next_action: null,
        updated_at: OLD,
        is_archived: false,
        is_suppressed: false,
        lifecycle_stage: "asking_price",
      },
    ],
    acquisition_opportunities: [
      { id: "opp-1", primary_thread_key: "+13125550100", next_action: "send_message_now", next_action_due: OLD, updated_at: OLD, version: 1, metadata: {} },
    ],
  });

  const result = await recoverSellerExecutionGaps({ supabaseClient: supabase, dryRun: false, now: NOW });
  const sweep = result.sweeps.find((s) => s.gap === "stale_active_without_next_action");
  assert.equal(sweep.repaired, 1);
  assert.equal(supabase._state.inbox_thread_state[0].next_action, "send_message_now");
});

test("accepted terms without contract advances the deal and flags review", async () => {
  const supabase = makeFakeSupabase({
    acquisition_opportunities: [
      {
        id: "opp-2",
        primary_thread_key: "+13125550111",
        acquisition_stage: "offer",
        opportunity_status: "active",
        version: 1,
        metadata: { negotiation_state: { terms_accepted: true, accepted_price: 87500 } },
      },
    ],
    inbox_thread_state: [
      { thread_key: "+13125550111", lifecycle_stage: "offer", operational_status: "active_communication", updated_at: OLD, is_archived: false },
    ],
  });

  const result = await recoverSellerExecutionGaps({ supabaseClient: supabase, dryRun: false, now: NOW });
  const sweep = result.sweeps.find((s) => s.gap === "accepted_terms_without_contract");
  assert.equal(sweep.repaired, 1, JSON.stringify(sweep));
  assert.equal(supabase._state.acquisition_opportunities[0].acquisition_stage, "formal_contract");
  assert.equal(supabase._state.inbox_thread_state[0].lifecycle_stage, "formal_contract");
  assert.equal(supabase._state.inbox_thread_state[0].next_action, "generate_contract");
});

test("stale reply-pending follow-up is cancelled after a newer inbound", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [
      { id: "q-1", thread_key: "+13125550122", type: "followup", queue_status: "scheduled", created_at: "2026-06-25T00:00:00.000Z", metadata: {} },
    ],
    inbox_thread_state: [
      { thread_key: "+13125550122", last_inbound_at: "2026-06-28T00:00:00.000Z", is_archived: false },
    ],
  });

  const result = await recoverSellerExecutionGaps({ supabaseClient: supabase, dryRun: false, now: NOW });
  const sweep = result.sweeps.find((s) => s.gap === "stale_followup_after_reply");
  assert.equal(sweep.repaired, 1);
  assert.equal(supabase._state.send_queue[0].queue_status, "cancelled");
  assert.equal(supabase._state.send_queue[0].metadata.skip_reason, "cancelled_stale_followup_after_reply");
});

test("recorded transition missing from thread state is re-applied monotonically", async () => {
  const supabase = makeFakeSupabase({
    message_events: [
      {
        id: "evt-9",
        direction: "inbound",
        from_phone_number: "+13125550133",
        received_at: "2026-07-01T09:00:00.000Z",
        metadata: {
          seller_flow_decision: {
            stage_after: "property_condition",
            operational_status: "active_communication",
            temperature: "warm",
            next_action: "send_message_now",
          },
        },
      },
    ],
    inbox_thread_state: [
      { thread_key: "+13125550133", lifecycle_stage: "offer_interest", next_action: null, updated_at: OLD, is_archived: false },
    ],
  });

  const result = await recoverSellerExecutionGaps({ supabaseClient: supabase, dryRun: false, now: NOW });
  const sweep = result.sweeps.find((s) => s.gap === "transition_without_state_patch");
  assert.equal(sweep.repaired, 1, JSON.stringify(sweep));
  assert.equal(supabase._state.inbox_thread_state[0].lifecycle_stage, "property_condition");
  assert.equal(supabase._state.inbox_thread_state[0].next_action, "send_message_now");
});

test("dry run scans but never mutates anything", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [
      { id: "q-1", thread_key: "+13125550122", type: "followup", queue_status: "scheduled", created_at: "2026-06-25T00:00:00.000Z", metadata: {} },
    ],
    inbox_thread_state: [
      { thread_key: "+13125550122", last_inbound_at: "2026-06-28T00:00:00.000Z", operational_status: "active_communication", next_action: null, updated_at: OLD, is_archived: false, is_suppressed: false },
    ],
  });

  const result = await recoverSellerExecutionGaps({ supabaseClient: supabase, dryRun: true, now: NOW });
  assert.equal(result.dry_run, true);
  assert.ok(result.total_repaired >= 1);
  assert.equal(supabase._state.send_queue[0].queue_status, "scheduled");
  assert.equal(supabase._state.inbox_thread_state[0].next_action, null);
});

test("recovery never inserts send_queue rows (no resends)", async () => {
  const supabase = makeFakeSupabase({
    inbox_thread_state: [
      { thread_key: "+13125550144", operational_status: "active_communication", next_action: null, updated_at: OLD, is_archived: false, is_suppressed: false, lifecycle_stage: "offer_interest" },
    ],
  });
  const before = supabase._state.send_queue.length;
  await recoverSellerExecutionGaps({ supabaseClient: supabase, dryRun: false, now: NOW });
  assert.equal(supabase._state.send_queue.length, before);
});
