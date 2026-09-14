/**
 * INBOX-COMPOSER-LOCK-1 — operator DNC has to reach the queue.
 *
 * Suppress / DNC from the Inbox wrote is_suppressed=true on inbox_thread_state
 * and stopped there. Anything already parked in send_queue for that seller -- a
 * bulk re-engagement scheduled for tomorrow morning, a pending follow-up -- was
 * untouched. The thread read DNC while the queue read "sending at 9am", and the
 * Scheduled count kept counting the message.
 *
 * The cancellation machinery already existed and was already used by the INBOUND
 * paths (a seller who sends STOP has their pending automation cancelled). The
 * operator-initiated path simply never called it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { patchUniversalLeadState } from "../../src/lib/domain/lead-state/patch-universal-lead-state.js";

const THREAD_KEY = "+15550009001";

function makeSupabase({ previous = {}, queueRows = [] } = {}) {
  const updates = [];
  const state = {
    row: { thread_key: THREAD_KEY, canonical_e164: THREAD_KEY, property_id: "prop-1", ...previous },
  };
  const supabase = {
    updates,
    from(table) {
      const q = { table, filters: [], patch: null };
      const api = {
        select() { return api },
        eq(col, val) { q.filters.push([col, val]); return api },
        in(col, vals) { q.filters.push([col, vals]); return api },
        is() { return api },
        not() { return api },
        or() { return api },
        lt() { return api },
        gte() { return api },
        lte() { return api },
        gt() { return api },
        order() { return api },
        limit() { return api },
        insert(rows) { q.patch = rows; return api },
        update(patch) { q.patch = patch; return api },
        upsert(patch) { q.patch = patch; state.row = { ...state.row, ...patch }; return api },
        maybeSingle: async () => {
          if (q.table === "inbox_thread_state") return { data: state.row, error: null };
          return { data: null, error: null };
        },
        upsert_: null,
        single: async () => ({ data: state.row, error: null }),
        then(resolve) {
          if (q.patch) updates.push({ table: q.table, patch: q.patch, filters: q.filters });
          const data = q.table === "send_queue" ? queueRows
            : q.table === "inbox_thread_state" ? [state.row]
            : [];
          return Promise.resolve().then(() => resolve({ data, error: null, count: data.length }));
        },
      };
      return api;
    },
  };
  return supabase;
}

test("operator DNC attempts to cancel the seller's pending sends", async () => {
  const supabase = makeSupabase({
    previous: { is_suppressed: false },
    queueRows: [
      { id: "q1", thread_key: THREAD_KEY, queue_status: "scheduled", scheduled_for: new Date(Date.now() + 864e5).toISOString(), type: "followup", to_phone_number: THREAD_KEY, property_id: "prop-1" },
    ],
  });

  const result = await patchUniversalLeadState({
    threadKey: THREAD_KEY,
    // Exactly what the Inbox's Suppress / DNC sends: is_suppressed is derived
    // server-side from a blocking contactability, never patched directly.
    patch: { contactability_status: "opted_out", lifecycle_stage: "closed", operational_status: "paused" },
    meta: { source_view: "inbox", reason: "operator_suppressed" },
    supabase,
  });

  assert.equal(result.ok, true);
  assert.ok(
    Object.prototype.hasOwnProperty.call(result, "suppression_cancellation"),
    "the response must report what happened to the pending sends",
  );
  assert.notEqual(
    result.suppression_cancellation,
    null,
    "suppressing a contact must ATTEMPT to cancel their pending outbound",
  );
});

test("a patch that does not suppress leaves the queue alone", async () => {
  const supabase = makeSupabase({ previous: { is_suppressed: false } });
  const result = await patchUniversalLeadState({
    threadKey: THREAD_KEY,
    patch: { lead_temperature: "hot" },
    meta: { source_view: "inbox" },
    supabase,
  });

  assert.equal(result.ok, true);
  assert.equal(result.suppression_cancellation, null, "changing temperature is not a compliance event");
});

test("re-suppressing an already-suppressed contact does not re-cancel", async () => {
  // Idempotence: the transition is what triggers cancellation, not the state.
  const supabase = makeSupabase({ previous: { is_suppressed: true } });
  const result = await patchUniversalLeadState({
    threadKey: THREAD_KEY,
    patch: { contactability_status: "opted_out" },
    meta: { source_view: "inbox" },
    supabase,
  });

  assert.equal(result.ok, true);
  assert.equal(result.suppression_cancellation, null);
});

test("a cancellation failure does not undo the suppression", async () => {
  // The suppression is already persisted and is the thing that matters. A
  // failure here is reported, never thrown -- the alternative is a seller who
  // asked not to be contacted whose DNC silently did not stick.
  const supabase = makeSupabase({ previous: { is_suppressed: false } });
  const original = supabase.from;
  supabase.from = (table) => {
    if (table === "send_queue") throw new Error("queue unreachable");
    return original(table);
  };

  const result = await patchUniversalLeadState({
    threadKey: THREAD_KEY,
    patch: { contactability_status: "opted_out" },
    meta: { source_view: "inbox" },
    supabase,
  });

  assert.equal(result.ok, true, "the DNC must stick even if the queue sweep fails");
  // Reported, never thrown. The alternative is a seller who asked not to be
  // contacted whose DNC silently did not persist because a queue sweep failed.
  assert.notEqual(result.suppression_cancellation, null, "the failure has to be reported, not swallowed");
  assert.notEqual(result.suppression_cancellation?.ok, true, "a failed sweep must not report success");
});
