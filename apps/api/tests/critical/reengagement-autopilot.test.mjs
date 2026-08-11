// ─── reengagement-autopilot.test.mjs ─────────────────────────────────────────
// G3: deterministic re-enrollment after a dispatched follow-up got no inbound
// within its policy window.
//
// Proves, on the REAL path (sweeper #8 → reengagement planner → canonical
// scheduleFollowUp → enqueueSendQueueItem):
//   • idempotent re-enrollment (same scan twice → exactly one row)
//   • the stop-condition matrix fails closed BEFORE scheduling
//   • attempt caps (stage attempts → nurture waves → absolute lifetime cap)
//   • no scheduling when followup_automation_mode denies (disabled/dry_run/
//     internal_only)
//   • a condition_disclosed thread still gets a STAGE-level follow-up
//     (UNAPPROVED_FOLLOWUP_INTENTS operator policy unchanged)

import test from "node:test";
import assert from "node:assert/strict";

import { recoverSellerExecutionGaps } from "@/lib/domain/seller-flow/recover-seller-execution-gaps.js";
import { resolveReengagementDecision } from "@/lib/domain/seller-flow/reengagement-planner.js";
import {
  REENGAGEMENT_POLICY,
  resolveReengagementWave,
} from "@/lib/domain/seller-flow/followup-policy-registry.js";
import {
  buildFollowupDedupeKey,
  scheduleFollowUp,
} from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import { maybeScheduleFollowUpAfterDelivery } from "@/lib/domain/seller-flow/delivery-triggered-followup.js";

const NOW_ISO = "2026-08-07T12:00:00.000Z";
const NOW = Date.parse(NOW_ISO);
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgoIso(days) {
  return new Date(NOW - days * DAY_MS).toISOString();
}

// ── Stateful fake supabase covering every query the run needs ───────────────
// (all 8 sweeps + the real enqueueSendQueueItem path incl. the 21610 check,
// dedupe-unique insert, and the idempotent-replay lookup).
function makeFakeSupabase(seed = {}) {
  const state = {
    send_queue: seed.send_queue || [],
    inbox_thread_state: seed.inbox_thread_state || [],
    acquisition_opportunities: seed.acquisition_opportunities || [],
    message_events: seed.message_events || [],
    sms_suppression_list: seed.sms_suppression_list || [],
    other: [],
  };
  let next_id = 9000;

  function rowsFor(table) {
    return state[table] || state.other;
  }

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
    const q = {
      _op: "select",
      _payload: null,
      _filters: [],
      _limit: null,
      select() {
        return q;
      },
      insert(payload) {
        q._op = "insert";
        q._payload = payload;
        return q;
      },
      update(patch) {
        q._op = "update";
        q._payload = patch;
        return q;
      },
      upsert(payload) {
        q._op = "upsert";
        q._payload = payload;
        return q;
      },
      eq(col, val) {
        q._filters.push((r) => String(pick(r, col)) === String(val));
        return q;
      },
      neq(col, val) {
        q._filters.push((r) => String(pick(r, col)) !== String(val));
        return q;
      },
      in(col, vals) {
        q._filters.push((r) => vals.map(String).includes(String(pick(r, col))));
        return q;
      },
      is(col, val) {
        q._filters.push((r) => (val === null ? pick(r, col) == null : pick(r, col) === val));
        return q;
      },
      not(col, _op, val) {
        q._filters.push((r) => !(val === null ? pick(r, col) == null : pick(r, col) === val));
        return q;
      },
      lt(col, val) {
        q._filters.push((r) => String(pick(r, col) ?? "") < String(val));
        return q;
      },
      lte(col, val) {
        q._filters.push((r) => String(pick(r, col) ?? "") <= String(val));
        return q;
      },
      gt(col, val) {
        q._filters.push((r) => String(pick(r, col) ?? "") > String(val));
        return q;
      },
      gte(col, val) {
        q._filters.push((r) => String(pick(r, col) ?? "") >= String(val));
        return q;
      },
      or() {
        return q;
      },
      ilike() {
        return q;
      },
      order() {
        return q;
      },
      limit(n) {
        q._limit = n;
        return q;
      },
      maybeSingle() {
        return q._exec().then(({ data, error }) => ({
          data: Array.isArray(data) ? data[0] || null : data,
          error,
        }));
      },
      single() {
        return q.maybeSingle();
      },
      then(onFulfilled, onRejected) {
        return q._exec().then(onFulfilled, onRejected);
      },
      async _exec() {
        const rows = rowsFor(table);
        if (q._op === "insert" || q._op === "upsert") {
          const payload = Array.isArray(q._payload) ? q._payload[0] : q._payload;
          if (
            table === "send_queue" &&
            payload?.dedupe_key &&
            rows.some((r) => r.dedupe_key === payload.dedupe_key)
          ) {
            return { data: null, error: { code: "23505", message: "duplicate key" } };
          }
          const row = { id: `gen-${(next_id += 1)}`, ...payload };
          rows.push(row);
          return { data: [row], error: null };
        }
        const matches = rows.filter((r) => q._filters.every((f) => f(r)));
        if (q._op === "update") {
          for (const row of matches) Object.assign(row, q._payload);
        }
        const limited = q._limit ? matches.slice(0, q._limit) : matches;
        return { data: limited, error: null };
      },
    };
    return q;
  }

  return { _state: state, from: (table) => query(table) };
}

const THREAD = "+13125550100";

function dispatchedStageFollowupRow(overrides = {}) {
  return {
    id: "q-followup-1",
    thread_key: THREAD,
    to_phone_number: THREAD,
    type: "followup",
    queue_status: "delivered",
    sent_at: daysAgoIso(10),
    created_at: daysAgoIso(11),
    use_case_template: "ownership_check",
    master_owner_id: "own_1",
    property_id: "prop_1",
    agent_name: "Jordan",
    metadata: {
      intent: "stage_no_reply",
      followup_use_case: "ownership_check",
      followup_attempt: 1,
      deferred_message_resolution: true,
    },
    ...overrides,
  };
}

function healthyThreadState(overrides = {}) {
  return {
    thread_key: THREAD,
    is_suppressed: false,
    is_archived: false,
    contactability_status: "contactable",
    lifecycle_stage: "ownership_confirmation",
    disposition: "none",
    last_inbound_at: null,
    ...overrides,
  };
}

const LIVE_DEPS = { followUpMode: "full_live", getSystemValueImpl: async () => null };

async function runSweep(supabase, { dryRun = false, deps = LIVE_DEPS } = {}) {
  const result = await recoverSellerExecutionGaps({
    supabaseClient: supabase,
    dryRun,
    now: NOW,
    deps,
  });
  return {
    result,
    sweep: result.sweeps.find((s) => s.gap === "followup_no_response_reengagement"),
  };
}

// ═══ Real-path re-enrollment ════════════════════════════════════════════════

test("sweeper #8 re-enrolls a silent thread: attempt 2 via the canonical scheduler", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [dispatchedStageFollowupRow()],
    inbox_thread_state: [healthyThreadState()],
  });

  const { sweep } = await runSweep(supabase);
  assert.equal(sweep.repaired, 1, JSON.stringify(sweep));

  const scheduled = supabase._state.send_queue.filter((r) => r.queue_status === "scheduled");
  assert.equal(scheduled.length, 1);
  const row = scheduled[0];
  assert.equal(row.type, "followup");
  assert.equal(row.to_phone_number, THREAD);
  assert.equal(row.dedupe_key, `seller_followup:${THREAD}:stage_no_reply:attempt_2`);
  // Attribution: the outbound's REAL use case, never a fabricated nurture bucket.
  assert.equal(row.use_case_template, "ownership_check");
  // Audit metadata sufficient to reconstruct the decision.
  assert.equal(row.metadata.followup_attempt, 2);
  assert.equal(row.metadata.reengagement_reason, "followup_no_response_attempt_2");
  assert.equal(row.metadata.followup_reason, "followup_no_response_attempt_2");
  assert.equal(row.metadata.stage, "ownership_confirmation");
  assert.equal(row.metadata.reengagement_wave, "stage");
  assert.equal(row.metadata.source, "reengagement_gap_recovery");
  assert.equal(row.metadata.trigger_queue_row_id, "q-followup-1");
  assert.equal(row.metadata.deferred_message_resolution, true);
  // The window already elapsed ⇒ due now (dispatch-time rules apply downstream).
  assert.equal(row.scheduled_for, NOW_ISO);
});

test("idempotent re-enrollment: the same scan twice creates exactly one row", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [dispatchedStageFollowupRow()],
    inbox_thread_state: [healthyThreadState()],
  });

  const first = await runSweep(supabase);
  assert.equal(first.sweep.repaired, 1);
  const after_first = supabase._state.send_queue.length;

  const second = await runSweep(supabase);
  assert.equal(second.sweep.repaired, 0);
  assert.equal(second.sweep.denied.duplicate_pending_followup, 1, JSON.stringify(second.sweep));
  assert.equal(supabase._state.send_queue.length, after_first);
});

test("scheduleFollowUp replay onto the same attempt key is a no-op (dedupe unique)", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [
      {
        id: "existing",
        dedupe_key: `seller_followup:${THREAD}:stage_no_reply:attempt_2`,
        queue_status: "scheduled",
        thread_key: THREAD,
        type: "followup",
      },
    ],
  });
  const result = await scheduleFollowUp(
    "stage_no_reply",
    THREAD,
    {
      attempt: 2,
      reengagement_scheduled_for: NOW_ISO,
      reengagement_window_days: 3,
      reengagement_reason: "followup_no_response_attempt_2",
      stage: "ownership_confirmation",
      followup_use_case: "ownership_check",
    },
    supabase
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "duplicate_followup_exists");
  assert.equal(supabase._state.send_queue.length, 1);
});

test("dedupe-key convention: attempt-less keys keep the historical shape", () => {
  assert.equal(buildFollowupDedupeKey(THREAD, "not_interested"), `seller_followup:${THREAD}:not_interested`);
  assert.equal(buildFollowupDedupeKey(THREAD, "not_interested", 1), `seller_followup:${THREAD}:not_interested`);
  assert.equal(
    buildFollowupDedupeKey(THREAD, "not_interested", 3),
    `seller_followup:${THREAD}:not_interested:attempt_3`
  );
});

// ═══ Mode gates: the planner is inert when the authority denies ═════════════

test("mode gate: default (disabled) mode leaves the sweep fully inert", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [dispatchedStageFollowupRow()],
    inbox_thread_state: [healthyThreadState()],
  });
  const { sweep } = await runSweep(supabase, {
    deps: { getSystemValueImpl: async () => null },
  });
  assert.equal(sweep.mode, "disabled");
  assert.equal(sweep.skipped, "followup_automation_disabled");
  assert.equal(sweep.repaired, 0);
  assert.equal(supabase._state.send_queue.length, 1);
});

test("mode gate: dry_run evaluates guards, reports would_schedule, inserts nothing", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [dispatchedStageFollowupRow()],
    inbox_thread_state: [healthyThreadState()],
  });
  const { sweep } = await runSweep(supabase, {
    deps: { followUpMode: "dry_run", getSystemValueImpl: async () => null },
  });
  assert.equal(sweep.repaired, 0);
  const preview = sweep.results.find((r) => r.would_schedule === true);
  assert.ok(preview, JSON.stringify(sweep));
  assert.equal(preview.reason, "reengagement_dry_run");
  assert.equal(supabase._state.send_queue.length, 1);
});

test("mode gate: internal_only blocks real seller phones", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [dispatchedStageFollowupRow()],
    inbox_thread_state: [healthyThreadState()],
  });
  const { sweep } = await runSweep(supabase, {
    deps: {
      followUpMode: "internal_only",
      getSystemValueImpl: async () => null,
      isInternalTestPhoneImpl: () => false,
    },
  });
  assert.equal(sweep.repaired, 0);
  assert.equal(sweep.denied.reengagement_internal_only_blocked, 1, JSON.stringify(sweep));
  assert.equal(supabase._state.send_queue.length, 1);
});

test("sweep-level dryRun counts the repair but never mutates the queue", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [dispatchedStageFollowupRow()],
    inbox_thread_state: [healthyThreadState()],
  });
  const { sweep } = await runSweep(supabase, { dryRun: true });
  assert.equal(sweep.repaired, 1);
  assert.equal(supabase._state.send_queue.length, 1);
});

// ═══ Stop-condition matrix (fail-closed, checked BEFORE scheduling) ═════════

const STOP_CASES = [
  ["thread suppressed", { thread: { is_suppressed: true } }, "thread_suppressed"],
  ["thread archived", { thread: { is_archived: true } }, "thread_archived"],
  ["opted out", { thread: { contactability_status: "opted_out" } }, "contact_blocked:opted_out"],
  ["do_not_text", { thread: { contactability_status: "do_not_text" } }, "contact_blocked:do_not_text"],
  ["legacy wrong_number contactability", { thread: { contactability_status: "wrong_number" } }, "contact_blocked:wrong_number"],
  ["terminal disposition wrong_number", { thread: { disposition: "wrong_number" } }, "terminal_disposition:wrong_number"],
  ["terminal disposition sold", { thread: { disposition: "sold" } }, "terminal_disposition:sold"],
  ["stage S6 formal_contract", { thread: { lifecycle_stage: "formal_contract" } }, "stage_beyond_automation:formal_contract"],
  ["stage closed", { thread: { lifecycle_stage: "closed" } }, "stage_beyond_automation:closed"],
  ["terms accepted", { terms_accepted: true }, "negotiation_terms_accepted"],
  ["seller replied after follow-up", { thread: { last_inbound_at: daysAgoIso(5) } }, "seller_replied_after_followup"],
  ["pending queue row exists", { pending_followup_exists: true }, "duplicate_pending_followup"],
  ["suppressed follow-up intent", { last_followup: { intent: "hostile_or_legal" } }, "permanent_suppression:hostile_or_legal"],
  ["unapproved follow-up intent", { last_followup: { intent: "condition_disclosed" } }, "follow_up_policy_not_approved"],
  ["active-workflow intent", { last_followup: { intent: "ownership_confirmed" } }, "active_workflow_no_nurture"],
  ["never dispatched", { last_followup: { sent_at: null } }, "last_followup_not_dispatched"],
];

for (const [label, overrides, expected_reason] of STOP_CASES) {
  test(`planner stop condition: ${label} → ${expected_reason}`, () => {
    const decision = resolveReengagementDecision({
      now: NOW,
      mode: { mode: "full_live" },
      thread: { ...healthyThreadState(), ...(overrides.thread || {}) },
      last_followup: {
        intent: "stage_no_reply",
        sent_at: daysAgoIso(10),
        followup_use_case: "ownership_check",
        ...(overrides.last_followup || {}),
      },
      prior_automated_followups: 1,
      pending_followup_exists: overrides.pending_followup_exists === true,
      terms_accepted: overrides.terms_accepted === true,
    });
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, expected_reason);
  });
}

test("planner: window not elapsed defers with an explicit next_eligible_at", () => {
  const decision = resolveReengagementDecision({
    now: NOW,
    mode: { mode: "full_live" },
    thread: healthyThreadState(),
    last_followup: {
      intent: "stage_no_reply",
      sent_at: daysAgoIso(1), // S1 window is 3 days
      followup_use_case: "ownership_check",
    },
    prior_automated_followups: 1,
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "reengagement_window_not_elapsed");
  assert.equal(decision.next_eligible_at, new Date(Date.parse(daysAgoIso(1)) + 3 * DAY_MS).toISOString());
});

test("planner: stage lane without a resolvable use case fails closed", () => {
  const decision = resolveReengagementDecision({
    now: NOW,
    mode: { mode: "full_live" },
    thread: healthyThreadState(),
    last_followup: { intent: "stage_no_reply", sent_at: daysAgoIso(10), followup_use_case: null },
    prior_automated_followups: 1,
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "stage_followup_use_case_missing");
});

test("planner: nurture-intent lane uses the intent cadence, not the stage delay", () => {
  // not_interested nurtures at 30d; 10 days of silence is NOT eligible yet.
  const early = resolveReengagementDecision({
    now: NOW,
    mode: { mode: "full_live" },
    thread: healthyThreadState(),
    last_followup: { intent: "not_interested", sent_at: daysAgoIso(10) },
    prior_automated_followups: 1,
  });
  assert.equal(early.eligible, false);
  assert.equal(early.reason, "reengagement_window_not_elapsed");

  const due = resolveReengagementDecision({
    now: NOW,
    mode: { mode: "full_live" },
    thread: healthyThreadState(),
    last_followup: { intent: "not_interested", sent_at: daysAgoIso(31) },
    prior_automated_followups: 1,
  });
  assert.equal(due.eligible, true);
  assert.equal(due.intent, "not_interested");
  assert.equal(due.attempt, 2);
  assert.equal(due.window_days, 30);
});

// ═══ Attempt caps: stage attempts → nurture waves → absolute cap ════════════

test("wave resolution: stage attempts, then 45d nurture waves, then hard stop", () => {
  const stage = "ownership_confirmation"; // stage cap 3

  const w2 = resolveReengagementWave({ stage, prior_automated_followups: 1 });
  assert.deepEqual([w2.eligible, w2.wave, w2.attempt, w2.window_days], [true, "stage", 2, 3]);

  const w4 = resolveReengagementWave({ stage, prior_automated_followups: 3 });
  assert.deepEqual(
    [w4.eligible, w4.wave, w4.attempt, w4.window_days],
    [true, "nurture", 4, REENGAGEMENT_POLICY.nurture_wave_days]
  );

  const w5 = resolveReengagementWave({ stage, prior_automated_followups: 4 });
  assert.deepEqual([w5.eligible, w5.wave, w5.attempt], [true, "nurture", 5]);

  // Absolute lifetime cap (5): a sixth automated follow-up may never exist.
  const w6 = resolveReengagementWave({ stage, prior_automated_followups: 5 });
  assert.equal(w6.eligible, false);
  assert.match(w6.reason, /reengagement_total_cap_reached/);

  // Stages with automation off never re-enroll.
  const off = resolveReengagementWave({ stage: "under_contract", prior_automated_followups: 1 });
  assert.equal(off.eligible, false);
  assert.match(off.reason, /followup_policy_disabled_for_stage/);
});

test("sweeper enforces the max-attempt cap from the thread's real ledger", async () => {
  // 5 non-cancelled follow-up rows already exist (absolute cap) — latest silent.
  const rows = [1, 2, 3, 4, 5].map((n) => ({
    id: `q-${n}`,
    thread_key: THREAD,
    to_phone_number: THREAD,
    type: "followup",
    queue_status: "delivered",
    sent_at: daysAgoIso(120 - n),
    created_at: daysAgoIso(121 - n),
    use_case_template: "ownership_check",
    metadata: { intent: "stage_no_reply", followup_use_case: "ownership_check", followup_attempt: n },
  }));
  const supabase = makeFakeSupabase({
    send_queue: rows,
    inbox_thread_state: [healthyThreadState()],
  });
  const { sweep } = await runSweep(supabase);
  assert.equal(sweep.repaired, 0);
  const denial = Object.keys(sweep.denied).find((k) => k.startsWith("reengagement_total_cap_reached"));
  assert.ok(denial, JSON.stringify(sweep.denied));
  assert.equal(supabase._state.send_queue.length, 5);
});

test("nurture wave rides the real path once stage attempts are exhausted", async () => {
  const rows = [1, 2, 3].map((n) => ({
    id: `q-${n}`,
    thread_key: THREAD,
    to_phone_number: THREAD,
    type: "followup",
    queue_status: "delivered",
    sent_at: daysAgoIso(150 - n * 10),
    created_at: daysAgoIso(151 - n * 10),
    use_case_template: "ownership_check",
    metadata: { intent: "stage_no_reply", followup_use_case: "ownership_check", followup_attempt: n },
  }));
  // Latest was 120 days ago — well past the 45d nurture wave window.
  const supabase = makeFakeSupabase({
    send_queue: rows,
    inbox_thread_state: [healthyThreadState()],
  });
  const { sweep } = await runSweep(supabase);
  assert.equal(sweep.repaired, 1, JSON.stringify(sweep));
  const row = supabase._state.send_queue.find((r) => r.queue_status === "scheduled");
  assert.equal(row.metadata.followup_attempt, 4);
  assert.equal(row.metadata.reengagement_wave, "nurture");
  assert.equal(row.metadata.reengagement_reason, "reengagement_nurture_wave_attempt_4");
  assert.equal(row.dedupe_key, `seller_followup:${THREAD}:stage_no_reply:attempt_4`);
});

test("only the LATEST dispatched follow-up triggers; older rows are superseded evidence", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [
      dispatchedStageFollowupRow({ id: "q-old", sent_at: daysAgoIso(40) }),
      dispatchedStageFollowupRow({ id: "q-new", sent_at: daysAgoIso(10), metadata: { intent: "stage_no_reply", followup_use_case: "ownership_check", followup_attempt: 2 } }),
    ],
    inbox_thread_state: [healthyThreadState()],
  });
  const { sweep } = await runSweep(supabase);
  // One thread ⇒ one evaluation ⇒ one new row keyed to attempt 3.
  assert.equal(sweep.repaired, 1);
  const scheduled = supabase._state.send_queue.filter((r) => r.queue_status === "scheduled");
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].metadata.trigger_queue_row_id, "q-new");
  assert.equal(scheduled[0].dedupe_key, `seller_followup:${THREAD}:stage_no_reply:attempt_3`);
});

test("unknown thread state fails closed: no state row ⇒ no scheduling", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [dispatchedStageFollowupRow()],
    inbox_thread_state: [],
  });
  const { sweep } = await runSweep(supabase);
  assert.equal(sweep.repaired, 0);
  assert.equal(sweep.denied.thread_state_missing, 1);
  assert.equal(supabase._state.send_queue.length, 1);
});

// ═══ UNAPPROVED_FOLLOWUP_INTENTS: stage-level coverage, not orphaned ════════

test("condition_disclosed thread still gets a STAGE-level follow-up after delivery", async () => {
  const sent_at = "2026-08-01T10:00:00.000Z";
  const outbound_event = {
    id: "me_out_cd",
    thread_key: THREAD,
    sent_at,
    event_timestamp: sent_at,
    master_owner_id: "own_1",
    property_id: "prop_1",
    metadata: {
      automation_provenance: {
        followup_intent: "condition_disclosed", // operator-unapproved nurture lane
        template_use_case: "condition_probe",
      },
      agent_name: "Jordan",
    },
  };
  const supabase = {
    from(table) {
      const chain = {
        _table: table,
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        gt: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () =>
          table === "message_events"
            ? { data: outbound_event, error: null }
            : table === "inbox_thread_state"
              ? { data: { contactability_status: "contactable", lifecycle_stage: "property_condition" }, error: null }
              : { data: null, error: null },
        then: (onF, onR) => Promise.resolve({ data: [], error: null }).then(onF, onR),
      };
      return chain;
    },
  };

  const calls = [];
  const outcome = await maybeScheduleFollowUpAfterDelivery({
    provider_message_sid: "SM_CD_1",
    final_delivery_status: "delivered",
    supabase,
    followUpMode: "full_live",
    getSystemValueImpl: async () => null,
    scheduleFollowUpImpl: async (intent, thread_key, context) => {
      calls.push({ intent, thread_key, context });
      return { ok: true, followup_created: true, scheduled_for: "2026-08-05T10:00:00.000Z" };
    },
  });

  assert.equal(outcome.scheduled, true, JSON.stringify(outcome));
  assert.equal(calls.length, 1);
  // The unapproved intent is NOT scheduled as a nurture lane…
  assert.equal(calls[0].intent, "stage_no_reply");
  // …but the thread keeps its stage cadence, attributed to the real use case.
  assert.equal(calls[0].context.followup_use_case, "condition_probe");
  assert.equal(calls[0].context.stage, "property_condition");
  assert.equal(calls[0].context.stage_no_reply_days, 4);
  // Audit trail of the fallback decision.
  assert.equal(calls[0].context.declared_followup_intent, "condition_disclosed");
  assert.equal(calls[0].context.unapproved_intent_stage_fallback, true);
});

test("condition_disclosed stage fallback produces a REAL resolvable queue row end-to-end", async () => {
  // Through the real scheduleFollowUp: the row must be a stage_no_reply row
  // carrying the condition_probe use case, resolvable at dispatch time.
  const supabase = makeFakeSupabase({});
  const result = await scheduleFollowUp(
    "stage_no_reply",
    THREAD,
    {
      source: "delivery_triggered_followup",
      stage: "property_condition",
      stage_no_reply_days: 4,
      followup_use_case: "condition_probe",
      declared_followup_intent: "condition_disclosed",
      unapproved_intent_stage_fallback: true,
    },
    supabase
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const row = supabase._state.send_queue[0];
  assert.equal(row.use_case_template, "condition_probe");
  assert.equal(row.metadata.intent, "stage_no_reply");
  assert.equal(row.metadata.followup_use_case, "condition_probe");
  assert.equal(row.metadata.declared_followup_intent, "condition_disclosed");

  const { isDeferredQueueRow, nurtureIntentFromRow } = await import(
    "@/lib/domain/queue/resolve-deferred-queue-message.js"
  );
  assert.equal(isDeferredQueueRow(row), true);
  assert.equal(nurtureIntentFromRow(row), "stage_no_reply");
});

// ═══ Regression: existing recovery invariants still hold ════════════════════

test("with the mode denied, recovery still never inserts send_queue rows", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [dispatchedStageFollowupRow()],
    inbox_thread_state: [healthyThreadState()],
  });
  const before = supabase._state.send_queue.length;
  await recoverSellerExecutionGaps({
    supabaseClient: supabase,
    dryRun: false,
    now: NOW,
    deps: { getSystemValueImpl: async () => null },
  });
  assert.equal(supabase._state.send_queue.length, before);
});
