/**
 * seller-state-reconcile-scheduling.test.mjs
 *
 * The scheduled seller-state reconciliation lane.
 *
 * The canonical primitive recoverSellerExecutionGaps runs SEVEN sweeps. Six of
 * them are unsafe to run unattended under containment: they enqueue offers,
 * schedule follow-ups, replay transitions, run the decision engine, rewrite
 * negotiation/monetary state, or create closing cases. Only
 * stale_active_without_next_action is safe.
 *
 * INVARIANT: the scheduled lane executes exactly that one sweep, writes exactly
 * one table, and cannot produce a dispatchable send_queue row.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  recoverSellerExecutionGaps,
  SELLER_GAP_SWEEPS,
  SCHEDULER_SAFE_SWEEPS,
} from "@/lib/domain/seller-flow/recover-seller-execution-gaps.js";

const NOW = Date.parse("2026-07-01T12:00:00.000Z");
const OLD = "2026-06-30T00:00:00.000Z";
const FRESH = "2026-07-01T11:59:00.000Z";

/** Mirrors the fake in seller-execution-gap-recovery.test.mjs. */
function makeFakeSupabase(seed = {}) {
  const state = {
    inbox_thread_state: seed.inbox_thread_state || [],
    acquisition_opportunities: seed.acquisition_opportunities || [],
    send_queue: seed.send_queue || [],
    message_events: seed.message_events || [],
    other: [],
  };
  const touched = new Set();
  const writes = [];

  function pick(row, col) {
    if (col === "metadata->ade_snapshot") return row.metadata?.ade_snapshot ?? null;
    if (col === "metadata->negotiation_state->>terms_accepted") {
      const v = row.metadata?.negotiation_state?.terms_accepted;
      return v == null ? null : String(v);
    }
    if (col === "metadata->seller_flow_decision") return row.metadata?.seller_flow_decision ?? null;
    return row[col];
  }

  function query(table) {
    touched.add(table);
    const rows = state[table] || state.other;
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
      or(expr) {
        const clauses = String(expr).split(",").map((c) => c.trim()).filter(Boolean).map((c) => {
          const [col, op, ...rest] = c.split(".");
          const val = rest.join(".");
          if (op === "is" && val === "null") return (r) => pick(r, col) == null;
          if (op === "eq") return (r) => String(pick(r, col) ?? "") === val;
          throw new Error(`unsupported or-clause: ${c}`);
        });
        q._filters.push((r) => clauses.some((f) => f(r)));
        return q;
      },
      not(col, op, val) { q._filters.push((r) => !(val === null ? pick(r, col) == null : pick(r, col) === val)); return q; },
      lt(col, val) { q._filters.push((r) => String(pick(r, col) ?? "") < String(val)); return q; },
      gt(col, val) { q._filters.push((r) => String(pick(r, col) ?? "") > String(val)); return q; },
      gte(col, val) { q._filters.push((r) => String(pick(r, col) ?? "") >= String(val)); return q; },
      order() { return q; },
      limit(n) { return q._run(n).then((r) => ({ data: r, error: null })); },
      maybeSingle() { return q._run(1).then((r) => ({ data: r[0] || null, error: null })); },
      single() { return q._run(1).then((r) => ({ data: r[0] || null, error: null })); },
      then(onF, onR) { return q._run().then(() => ({ data: null, error: null })).then(onF, onR); },
      async _run(n) {
        if (q._op === "insert" || q._op === "upsert") {
          const payload = Array.isArray(q._payload) ? q._payload[0] : q._payload;
          writes.push({ table, op: q._op, payload });
          if (q._op === "upsert") {
            const keyCol = table === "inbox_thread_state" ? "thread_key" : "id";
            const existing = rows.find((r) => String(r[keyCol]) === String(payload[keyCol]));
            if (existing) { Object.assign(existing, payload); return [existing]; }
          }
          const row = { id: `gen-${rows.length + 1}`, ...payload };
          rows.push(row);
          return [row];
        }
        const matches = rows.filter((r) => q._filters.every((f) => f(r)));
        if (q._op === "update") {
          writes.push({ table, op: "update", payload: q._payload });
          for (const row of matches) Object.assign(row, q._payload);
        }
        return n ? matches.slice(0, n) : matches;
      },
    };
    return q;
  }

  return { _state: state, _touched: touched, _writes: writes, from: (t) => query(t) };
}

function staleThread(overrides = {}) {
  return {
    thread_key: "+13125550100",
    operational_status: "active_communication",
    next_action: null,
    updated_at: OLD,
    is_archived: false,
    is_suppressed: false,
    lifecycle_stage: "asking_price",
    ...overrides,
  };
}

const runSafeLane = (supabase, opts = {}) =>
  recoverSellerExecutionGaps({
    supabaseClient: supabase,
    limit: 50,
    dryRun: false,
    now: NOW,
    sweeps: SCHEDULER_SAFE_SWEEPS,
    ...opts,
  });

// ── the allowlist itself ────────────────────────────────────────────────────

test("the scheduler-safe allowlist is exactly one sweep, and it is the next_action repair", () => {
  assert.deepEqual(SCHEDULER_SAFE_SWEEPS, [SELLER_GAP_SWEEPS.STALE_ACTIVE_WITHOUT_NEXT_ACTION]);
  assert.equal(SCHEDULER_SAFE_SWEEPS.length, 1, "widening this list requires re-proving side effects");
});

test("every send-capable sweep is EXCLUDED from the scheduled lane", () => {
  const excluded = [
    SELLER_GAP_SWEEPS.OFFER_AUTHORIZED_NEVER_QUEUED,   // enqueues offers
    SELLER_GAP_SWEEPS.STALE_FOLLOWUP_AFTER_REPLY,      // follow-up scheduling
    SELLER_GAP_SWEEPS.ACCEPTED_TERMS_WITHOUT_CONTRACT, // closing cases
    SELLER_GAP_SWEEPS.ADE_REQUIRED_NEVER_RAN,          // decision engine
    SELLER_GAP_SWEEPS.NEGOTIATION_STATE_INTEGRITY,     // monetary state
    SELLER_GAP_SWEEPS.TRANSITION_WITHOUT_STATE_PATCH,  // transition replay
  ];
  for (const sweep of excluded) {
    assert.ok(!SCHEDULER_SAFE_SWEEPS.includes(sweep), `${sweep} must never be scheduled`);
  }
});

test("the allowlist runs ONLY the named sweep", async () => {
  const supabase = makeFakeSupabase({ inbox_thread_state: [staleThread()] });
  const result = await runSafeLane(supabase);
  assert.deepEqual(result.sweeps_executed, [SELLER_GAP_SWEEPS.STALE_ACTIVE_WITHOUT_NEXT_ACTION]);
  assert.equal(result.sweeps.length, 1);
});

test("an UNRECOGNISED sweep name selects NOTHING, never everything", async () => {
  const supabase = makeFakeSupabase({ inbox_thread_state: [staleThread()] });
  const result = await recoverSellerExecutionGaps({
    supabaseClient: supabase, limit: 50, dryRun: false, now: NOW,
    sweeps: ["not_a_real_sweep"],
  });
  assert.deepEqual(result.sweeps_executed, [], "a typo must fail closed, not run all seven");
  assert.equal(result.total_repaired, 0);
});

test("omitting the allowlist preserves the historical run-everything behaviour", async () => {
  const supabase = makeFakeSupabase({ inbox_thread_state: [staleThread()] });
  const result = await recoverSellerExecutionGaps({
    supabaseClient: supabase, limit: 50, dryRun: true, now: NOW,
  });
  assert.equal(result.sweeps_executed.length, 7, "existing callers must be unaffected");
});

// ── side-effect containment ─────────────────────────────────────────────────

test("the scheduled lane NEVER writes send_queue, and creates no dispatchable row", async () => {
  const supabase = makeFakeSupabase({
    inbox_thread_state: [staleThread(), staleThread({ thread_key: "+13125550101" })],
  });
  await runSafeLane(supabase);

  const queueWrites = supabase._writes.filter((w) => w.table === "send_queue");
  assert.equal(queueWrites.length, 0, "no send_queue write of any kind");
  assert.equal(supabase._state.send_queue.length, 0, "no send_queue row created");

  const DISPATCHABLE = ["queued", "scheduled", "pending", "approved", "ready"];
  for (const w of supabase._writes) {
    const status = String(w.payload?.queue_status ?? "").toLowerCase();
    assert.ok(!DISPATCHABLE.includes(status), `wrote a dispatchable status: ${status}`);
  }
});

test("the scheduled lane touches no monetary, offer, or closing table", async () => {
  const supabase = makeFakeSupabase({ inbox_thread_state: [staleThread()] });
  await runSafeLane(supabase);
  for (const forbidden of ["seller_offers", "closing_cases", "send_queue", "message_events"]) {
    assert.ok(!supabase._touched.has(forbidden), `must not touch ${forbidden}`);
  }
});

// ── repair semantics ────────────────────────────────────────────────────────

test("BOTH null and the legacy empty-string sentinel are detected", async () => {
  for (const sentinel of [null, ""]) {
    const supabase = makeFakeSupabase({
      inbox_thread_state: [staleThread({ next_action: sentinel })],
    });
    const result = await runSafeLane(supabase);
    assert.equal(result.total_scanned, 1, `next_action=${JSON.stringify(sentinel)} must be seen`);
  }
});

test("a canonical next_action is COPIED, never invented", async () => {
  const supabase = makeFakeSupabase({
    inbox_thread_state: [staleThread()],
    acquisition_opportunities: [{
      id: "opp-1", primary_thread_key: "+13125550100",
      next_action: "send_message_now", next_action_due: OLD, updated_at: OLD, version: 1, metadata: {},
    }],
  });
  await runSafeLane(supabase);
  assert.equal(supabase._state.inbox_thread_state[0].next_action, "send_message_now");
});

test("with NO canonical evidence it writes the non-send human_review sentinel, and never an outbound action", async () => {
  const supabase = makeFakeSupabase({ inbox_thread_state: [staleThread()] });
  await runSafeLane(supabase);
  const written = supabase._state.inbox_thread_state[0].next_action;
  assert.equal(written, "human_review", "absent evidence must surface to a human, not guess");
  // Critically it must not fabricate a send instruction.
  assert.notEqual(written, "send_message_now");
  assert.notEqual(written, "schedule_follow_up");
  // And human_review contains no "follow", so it cannot inflate the
  // followup_due_but_none_scheduled invariant.
  assert.ok(!written.toLowerCase().includes("follow"));
});

test("a SUPPRESSED thread is exempt", async () => {
  const supabase = makeFakeSupabase({
    inbox_thread_state: [staleThread({ is_suppressed: true })],
  });
  const result = await runSafeLane(supabase);
  assert.equal(result.total_repaired, 0);
  assert.equal(supabase._state.inbox_thread_state[0].next_action, null, "suppressed row untouched");
});

test("an ARCHIVED thread is exempt", async () => {
  const supabase = makeFakeSupabase({
    inbox_thread_state: [staleThread({ is_archived: true })],
  });
  const result = await runSafeLane(supabase);
  assert.equal(result.total_repaired, 0);
});

test("a HEALTHY next_action is never overwritten", async () => {
  const supabase = makeFakeSupabase({
    inbox_thread_state: [staleThread({ next_action: "negotiate" })],
  });
  const result = await runSafeLane(supabase);
  assert.equal(result.total_scanned, 0, "a populated next_action is not a gap");
  assert.equal(supabase._state.inbox_thread_state[0].next_action, "negotiate");
});

test("a FRESH row is not swept (staleness threshold is load-bearing)", async () => {
  const supabase = makeFakeSupabase({
    inbox_thread_state: [staleThread({ updated_at: FRESH })],
  });
  const result = await runSafeLane(supabase);
  assert.equal(result.total_scanned, 0);
});

test("dry_run writes NOTHING", async () => {
  const supabase = makeFakeSupabase({ inbox_thread_state: [staleThread()] });
  const result = await runSafeLane(supabase, { dryRun: true });
  assert.ok(result.total_scanned > 0, "dry run still scans");
  assert.equal(supabase._writes.length, 0, "dry run must not write");
  assert.equal(supabase._state.inbox_thread_state[0].next_action, null);
});

test("re-running is idempotent: the second pass finds nothing left to repair", async () => {
  const supabase = makeFakeSupabase({ inbox_thread_state: [staleThread()] });
  const first = await runSafeLane(supabase);
  assert.ok(first.total_repaired >= 1);
  const second = await runSafeLane(supabase);
  assert.equal(second.total_scanned, 0, "a repaired row is no longer a gap");
  assert.equal(second.total_repaired, 0);
});

test("a duplicate scheduled event produces no additional mutation", async () => {
  const supabase = makeFakeSupabase({ inbox_thread_state: [staleThread()] });
  await runSafeLane(supabase);
  const afterFirst = supabase._writes.length;
  await runSafeLane(supabase);
  assert.equal(supabase._writes.length, afterFirst, "overlapping cron events converge");
});

// ── the route adapter ───────────────────────────────────────────────────────

test("the scheduled route is an adapter: it delegates and holds no reconciliation logic", async () => {
  const src = await readFile(
    new URL("../../src/app/api/internal/seller-flow/reconcile-state/route.js", import.meta.url),
    "utf8"
  );

  assert.ok(src.includes("requireScheduledMutationAuth"), "must use the scheduled-mutation gate");
  assert.ok(src.includes("SCHEDULER_SAFE_SWEEPS"), "must pass the allowlist");
  assert.ok(src.includes("seller_state_reconcile_enabled"), "must consult the kill switch");

  // It must NOT reimplement reconciliation or reach a provider.
  const forbidden = [
    "sendTextgrid",
    "insertSupabaseSendQueueRow",
    "processSendQueueItem",
    "scheduleFollowUp",
    "recoverUnprocessedInboundMessages",
  ];
  for (const f of forbidden) {
    assert.ok(!src.includes(f), `adapter must not reference ${f}`);
  }
});

// ── structural send-incapability: the workflow fan-out ──────────────────────

test("the reconciliation stamp does NOT trigger the workflow fan-out", async () => {
  // updateOpportunity normally emits opportunity_manual_override, which reaches
  // ingestWorkflowEvent -> runEnrollment -> action.enqueue_sms ->
  // insertSupabaseSendQueueRow with queue_status 'queued'. The live_send_blocked
  // flag returned from that path is stamped AFTER the insert, so it is a label
  // and not a gate. The reconciliation lane must never enter that chain.
  const supabase = makeFakeSupabase({
    inbox_thread_state: [staleThread()],
    acquisition_opportunities: [{
      id: "opp-1", primary_thread_key: "+13125550100",
      next_action: null, next_action_due: null, updated_at: OLD, version: 1, metadata: {},
    }],
  });

  await runSafeLane(supabase);

  for (const t of ["workflow_definitions", "workflow_events", "workflow_enrollments", "workflow_runs"]) {
    assert.ok(!supabase._touched.has(t), `reconciliation must not enter the workflow engine (touched ${t})`);
  }
  assert.equal(supabase._state.send_queue.length, 0, "no queue row from the fan-out");
});

test("the reconciliation stamp DOES repair the canonical opportunity next_action", async () => {
  // The projection alone is not enough: the canonical acquisition_opportunities
  // row is what the autonomy invariant reads.
  const supabase = makeFakeSupabase({
    inbox_thread_state: [staleThread()],
    acquisition_opportunities: [{
      id: "opp-1", primary_thread_key: "+13125550100",
      next_action: null, next_action_due: null, updated_at: OLD, version: 1, metadata: {},
    }],
  });

  await runSafeLane(supabase);

  assert.equal(supabase._state.inbox_thread_state[0].next_action, "human_review", "projection repaired");
  assert.equal(supabase._state.acquisition_opportunities[0].next_action, "human_review", "canonical repaired");
});

test("an opportunity that ALREADY has a next_action is not re-stamped", async () => {
  const supabase = makeFakeSupabase({
    inbox_thread_state: [staleThread()],
    acquisition_opportunities: [{
      id: "opp-1", primary_thread_key: "+13125550100",
      next_action: "negotiate", next_action_due: OLD, updated_at: OLD, version: 1, metadata: {},
    }],
  });
  await runSafeLane(supabase);
  assert.equal(supabase._state.acquisition_opportunities[0].next_action, "negotiate", "healthy canonical untouched");
});

test("suppression is OPT-IN: ordinary callers still get the workflow fan-out", async () => {
  // Guard against the suppression silently becoming the global default, which
  // would disable legitimate pipeline automation.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(
    new URL("../../src/lib/domain/opportunity/opportunity-service.js", import.meta.url),
    "utf8"
  );
  assert.match(
    src,
    /if \(deps\.emitWorkflowEvents !== false\)/,
    "emission must remain the default; only an explicit false suppresses it"
  );
});
