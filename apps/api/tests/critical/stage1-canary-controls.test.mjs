// ─── stage1-canary-controls.test.mjs ─────────────────────────────────────────
// Final Stage 1 canary-control semantics:
//   • the initial ownership outbound never fabricates a seller intent
//     ("unclear") — the Stage 1 no-reply follow-up derives from the canonical
//     stage policy registry (stage_no_reply plan);
//   • the internal canary first touch uses the combined ownership+interest
//     variant with COMPLETE attribution and sticky experiment assignment;
//   • canary/proof records are quarantined from normal campaign selection,
//     public automation, and KPI aggregation — while remaining executable by
//     an EXPLICITLY authorized internal canary;
//   • the inbound reply cancels the Stage 1 follow-up.

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInternalCanaryFirstTouch,
} from "@/lib/domain/templates/build-internal-canary-first-touch.js";
import {
  assignVariantDeterministic,
  resolveExperimentAssignment,
  OWNERSHIP_EXPERIMENT_ID,
} from "@/lib/domain/templates/template-experiment-assignment.js";
import { maybeScheduleFollowUpAfterDelivery } from "@/lib/domain/seller-flow/delivery-triggered-followup.js";
import {
  resolveFollowUpPlan,
  scheduleFollowUp,
  STAGE_NO_REPLY_FOLLOWUP_INTENT,
} from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import { resolveDeferredQueueMessage } from "@/lib/domain/queue/resolve-deferred-queue-message.js";
import { evaluateCandidateEligibility } from "@/lib/domain/outbound/supabase-candidate-feeder.js";
import {
  isInternalCanaryFactRow,
  excludeInternalCanaryRows,
  INTERNAL_CANARY_SOURCE,
} from "@/lib/config/internal-phones.js";

const CANARY_PHONE_B = "+16124515970"; // deterministic experiment variant B (combo)
const CANARY_PHONE_A = "+16127433952"; // deterministic experiment variant A (control)
const SENDER = "+16128060495";
const TEXTGRID_ID = "673d34f8-1d3c-47c8-bb1d-c8fda559ec9f";

function canaryBuildArgs(overrides = {}) {
  return {
    recipientPhone: CANARY_PHONE_B,
    senderNumber: SENDER,
    textgridNumberId: TEXTGRID_ID,
    masterOwnerId: "mo_52f521c7e28ea3152f5e5f2c",
    prospectId: "pros1_6038996e62edf1f9d20aff95",
    propertyId: "canaryprop_6bb8a46414092cb6318fbc35",
    sellerFirstName: "Ryan",
    agentFirstName: "Scott",
    propertyAddress: "4157 Pillsbury Ave S Unit B",
    city: "Minneapolis",
    market: "Minneapolis, MN",
    activatedOverride: true,
    ...overrides,
  };
}

// Generic chainable fake Supabase (same contract as the launch-automation
// control-plane tests): respond(ctx) → { data, error }.
function createFakeSupabase(respond, log = []) {
  return {
    from(table) {
      const ctx = { table, op: "select", filters: [], payload: null, single: false };
      const finish = () => {
        log.push(ctx);
        const out = respond(ctx) || {};
        return Promise.resolve({
          data: out.data !== undefined ? out.data : ctx.single ? null : [],
          error: out.error || null,
        });
      };
      const q = {
        select() { return q; },
        insert(payload) { ctx.op = "insert"; ctx.payload = payload; return q; },
        update(payload) { ctx.op = "update"; ctx.payload = payload; return q; },
        upsert(payload) { ctx.op = "upsert"; ctx.payload = payload; return q; },
        eq(col, val) { ctx.filters.push(["eq", col, val]); return q; },
        neq(col, val) { ctx.filters.push(["neq", col, val]); return q; },
        gt(col, val) { ctx.filters.push(["gt", col, val]); return q; },
        gte(col, val) { ctx.filters.push(["gte", col, val]); return q; },
        lte(col, val) { ctx.filters.push(["lte", col, val]); return q; },
        in(col, val) { ctx.filters.push(["in", col, val]); return q; },
        is(col, val) { ctx.filters.push(["is", col, val]); return q; },
        not(col, op, val) { ctx.filters.push(["not", col, op, val]); return q; },
        or(expr) { ctx.filters.push(["or", expr]); return q; },
        order() { return q; },
        limit() { return q; },
        range() { return q; },
        maybeSingle() { ctx.single = true; return finish(); },
        single() { ctx.single = true; return finish(); },
        then(resolve, reject) { return finish().then(resolve, reject); },
      };
      return q;
    },
  };
}

const NO_SYSTEM_MODE = async () => null;

function deliveredOutboundSupabase({ provenance = {}, metadata = {}, lifecycle_stage = "ownership_confirmation" } = {}) {
  const sent_at = "2026-07-12T10:00:00.000Z";
  return createFakeSupabase((ctx) => {
    if (ctx.table === "message_events" && ctx.single) {
      return {
        data: {
          id: "me_canary_out_1",
          thread_key: CANARY_PHONE_B,
          sent_at,
          event_timestamp: sent_at,
          master_owner_id: "mo_52f521c7e28ea3152f5e5f2c",
          property_id: "canaryprop_6bb8a46414092cb6318fbc35",
          metadata: { agent_first_name: "Scott", ...metadata, automation_provenance: { ...provenance } },
        },
      };
    }
    if (ctx.table === "message_events") return { data: [] }; // no newer events
    if (ctx.table === "send_queue") return { data: [] }; // no pending follow-ups
    if (ctx.table === "inbox_thread_state") {
      return { data: { contactability_status: "contactable", lifecycle_stage } };
    }
    return { data: null };
  });
}

// ── 1. Combined first-touch variant: attribution + copy + quarantine ────────
test("canary first touch uses the combined variant with complete attribution and no fabricated intent", () => {
  const built = buildInternalCanaryFirstTouch(canaryBuildArgs());
  assert.equal(built.ok, true, built.reason);

  // Sticky deterministic assignment → variant B (combo) for this thread.
  assert.equal(built.assignment.variant, "B");
  assert.equal(built.assignment.experiment_id, OWNERSHIP_EXPERIMENT_ID);
  assert.equal(built.assignment.variant_id, "ownership_interest_combo_B");
  assert.equal(built.assignment.assignment_source, "deterministic_hash");

  // Exact rendered copy: agent name + truthful descriptor + property +
  // ownership question + soft offer interest. No company name.
  assert.equal(
    built.rendered_message,
    "Hi Ryan, this is Scott, a local investor. Do you still own 4157 Pillsbury Ave S Unit B? If so, would you be open to reviewing an offer for it?"
  );

  // Complete attribution contract.
  const a = built.attribution;
  assert.equal(a.template_id, "ownership_interest_combo_v1_en_A");
  assert.match(String(a.template_version_id), /^sha1:[0-9a-f]{40}$/);
  assert.equal(a.template_key, "ownership_interest_combo_v1");
  assert.equal(a.stage, "S1");
  assert.equal(a.experiment_id, OWNERSHIP_EXPERIMENT_ID);
  assert.equal(a.experiment_variant_id, "ownership_interest_combo_B");
  assert.equal(a.language, "English");
  assert.equal(a.automation_origin, "internal_canary_first_touch");
  assert.equal(a.touch_number, 1);
  // First touch: the seller has said nothing — no classified outcome.
  assert.equal(a.classified_outcome, null);

  // Queue row: linkage + Stage 1 + quarantine markers, held (not queued).
  const row = built.queue_row;
  assert.equal(row.master_owner_id, "mo_52f521c7e28ea3152f5e5f2c");
  assert.equal(row.prospect_id, "pros1_6038996e62edf1f9d20aff95");
  assert.equal(row.property_id, "canaryprop_6bb8a46414092cb6318fbc35");
  assert.equal(row.thread_key, CANARY_PHONE_B);
  assert.equal(row.textgrid_number_id, TEXTGRID_ID);
  assert.equal(row.stage_before, "ownership_confirmation");
  assert.equal(row.touch_number, 1);
  assert.equal(row.language, "English");
  assert.equal(row.source, INTERNAL_CANARY_SOURCE);
  assert.equal(row.queue_status, "held");
  assert.equal(row.metadata.internal_canary, true);
  assert.equal(row.metadata.internal_test_phone, true);
  assert.equal(row.metadata.exclude_from_kpis, true);
  assert.equal(row.metadata.automation_provenance.followup_intent, null);
  assert.equal(row.metadata.automation_provenance.template_use_case, "ownership_check");
  // No fabricated seller intent anywhere on the initial outbound.
  assert.ok(!JSON.stringify(row).includes('"unclear"'));
});

test("experiment assignment is sticky, deterministic, and fail-closed", () => {
  for (const [phone, expected] of [[CANARY_PHONE_B, "B"], [CANARY_PHONE_A, "A"]]) {
    for (let i = 0; i < 3; i += 1) {
      assert.equal(assignVariantDeterministic(OWNERSHIP_EXPERIMENT_ID, phone), expected);
    }
    const assignment = resolveExperimentAssignment({
      threadKey: phone,
      recipientPhone: phone,
      activatedOverride: true,
    });
    assert.equal(assignment.variant, expected);
  }
  // Dormant experiment or non-internal phone → null (fail closed).
  assert.equal(resolveExperimentAssignment({ threadKey: CANARY_PHONE_B, recipientPhone: CANARY_PHONE_B, activatedOverride: false }), null);
  assert.equal(resolveExperimentAssignment({ threadKey: "+15551234567", recipientPhone: "+15551234567", activatedOverride: true }), null);
});

test("canary builder fails closed: non-internal recipient and dormant experiment", () => {
  assert.equal(
    buildInternalCanaryFirstTouch(canaryBuildArgs({ recipientPhone: "+15551234567" })).reason,
    "non_internal_phone"
  );
  assert.equal(
    buildInternalCanaryFirstTouch(canaryBuildArgs({ activatedOverride: null, env: {} })).reason,
    "experiment_not_activated"
  );
});

// ── 2. Stage 1 follow-up resolves canonically (never "unclear") ─────────────
test("delivered S1 ownership outbound schedules the stage-policy follow-up (stage_no_reply, 3d)", async () => {
  const calls = [];
  const outcome = await maybeScheduleFollowUpAfterDelivery({
    provider_message_sid: "SM_canary_1",
    final_delivery_status: "delivered",
    supabase: deliveredOutboundSupabase({
      provenance: { template_use_case: "ownership_check", followup_intent: null },
    }),
    followUpMode: "internal_only",
    getSystemValueImpl: NO_SYSTEM_MODE,
    scheduleFollowUpImpl: async (intent, thread_key, context) => {
      calls.push({ intent, thread_key, context });
      return { ok: true, followup_created: true, scheduled_for: "2026-07-15T10:00:00.000Z" };
    },
  });

  assert.equal(outcome.scheduled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].intent, STAGE_NO_REPLY_FOLLOWUP_INTENT);
  assert.notEqual(calls[0].intent, "unclear");
  assert.equal(calls[0].thread_key, CANARY_PHONE_B);
  assert.equal(calls[0].context.stage, "ownership_confirmation");
  assert.equal(calls[0].context.stage_no_reply_days, 3); // S1 registry cadence
  assert.equal(calls[0].context.followup_use_case, "ownership_check");
  assert.equal(calls[0].context.agent_name, "Scott");
});

test("declared nurture intent still takes precedence over the stage plan", async () => {
  const calls = [];
  await maybeScheduleFollowUpAfterDelivery({
    provider_message_sid: "SM_canary_2",
    final_delivery_status: "delivered",
    supabase: deliveredOutboundSupabase({
      provenance: { template_use_case: "ownership_check", followup_intent: "not_interested" },
    }),
    followUpMode: "internal_only",
    getSystemValueImpl: NO_SYSTEM_MODE,
    scheduleFollowUpImpl: async (intent, thread_key, context) => {
      calls.push({ intent, context });
      return { ok: true, followup_created: true, scheduled_for: "2026-08-11T10:00:00.000Z" };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].intent, "not_interested");
});

test("no declared intent and no stage plan → no follow-up (operational stage)", async () => {
  const outcome = await maybeScheduleFollowUpAfterDelivery({
    provider_message_sid: "SM_canary_3",
    final_delivery_status: "delivered",
    supabase: deliveredOutboundSupabase({
      provenance: { template_use_case: "close_handoff", followup_intent: null },
      lifecycle_stage: "under_contract", // stage policy disabled
    }),
    followUpMode: "internal_only",
    getSystemValueImpl: NO_SYSTEM_MODE,
    scheduleFollowUpImpl: async () => {
      throw new Error("must_not_schedule");
    },
  });
  assert.equal(outcome.scheduled, false);
  assert.equal(outcome.reason, "no_declared_followup_plan");
});

test("stage_no_reply plan: canonical cadence, attribution, and fail-closed without policy", async () => {
  const plan = resolveFollowUpPlan(STAGE_NO_REPLY_FOLLOWUP_INTENT, {
    thread_key: CANARY_PHONE_B,
    stage: "ownership_confirmation",
    stage_no_reply_days: 3,
  });
  assert.equal(plan.followup_created, true);
  assert.equal(plan.days, 3);
  assert.equal(plan.reason, "stage_no_reply_followup:ownership_confirmation");

  const missing = resolveFollowUpPlan(STAGE_NO_REPLY_FOLLOWUP_INTENT, { thread_key: CANARY_PHONE_B });
  assert.equal(missing.followup_created, false);
  assert.equal(missing.reason, "stage_no_reply_policy_missing");

  // Scheduled row is attributed to the outbound's REAL use case, and the
  // dedupe key targets the thread so an inbound cancellation removes it.
  const inserts = [];
  const supabase = createFakeSupabase((ctx) => {
    if (ctx.table === "send_queue" && ctx.op === "insert") {
      inserts.push(ctx.payload);
      return { data: { id: "q_followup_1", ...ctx.payload } };
    }
    return {};
  });
  const scheduled = await scheduleFollowUp(
    STAGE_NO_REPLY_FOLLOWUP_INTENT,
    CANARY_PHONE_B,
    {
      stage: "ownership_confirmation",
      stage_no_reply_days: 3,
      followup_use_case: "ownership_check",
      agent_name: "Scott",
      source: "delivery_triggered_followup",
    },
    supabase
  );
  assert.equal(scheduled.ok, true, scheduled.reason);
  assert.equal(scheduled.followup_created, true);
  assert.equal(scheduled.reason, "stage_no_reply_followup:ownership_confirmation");
  assert.equal(inserts.length, 1);
  const row = Array.isArray(inserts[0]) ? inserts[0][0] : inserts[0];
  assert.equal(row.use_case_template, "ownership_check"); // never nurture_unclear
  assert.equal(row.agent_name, "Scott");
  assert.equal(row.metadata.intent, STAGE_NO_REPLY_FOLLOWUP_INTENT);
  assert.equal(row.metadata.followup_use_case, "ownership_check");
  assert.equal(row.dedupe_key, `seller_followup:${CANARY_PHONE_B}:${STAGE_NO_REPLY_FOLLOWUP_INTENT}`);
});

test("deferred stage_no_reply resolution renders the outbound's use case — never the unclear pool", async () => {
  const ownershipTemplate = {
    id: "tpl-own-1",
    template_id: "200001",
    use_case: "ownership_check",
    stage_code: "S1",
    language: "English",
    reply_mode: "auto",
    safe_for_auto_reply: true,
    is_active: true,
    template_body: "Hi {{seller_first_name}}, this is {{agent_name}}. Do you still own {{property_address}}?",
  };
  const supabase = createFakeSupabase((ctx) => {
    if (ctx.table === "sms_templates") {
      const inFilter = ctx.filters.find(([op, col]) => op === "in" && col === "use_case");
      const useCases = inFilter ? inFilter[2] : [];
      return { data: useCases.includes("ownership_check") ? [ownershipTemplate] : [] };
    }
    return {};
  });

  const resolved = await resolveDeferredQueueMessage(
    {
      id: "q_followup_1",
      use_case_template: "ownership_check",
      language: "English",
      to_phone_number: CANARY_PHONE_B,
      seller_first_name: "Ryan",
      agent_name: "Scott",
      property_address: "4157 Pillsbury Ave S Unit B",
      metadata: {
        deferred_message_resolution: true,
        intent: STAGE_NO_REPLY_FOLLOWUP_INTENT,
        followup_use_case: "ownership_check",
      },
    },
    { supabase }
  );
  assert.equal(resolved.ok, true, resolved.reason);
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.use_case, "ownership_check");
  assert.equal(resolved.template_id, "200001");
  assert.equal(
    resolved.message_body,
    "Hi Ryan, this is Scott. Do you still own 4157 Pillsbury Ave S Unit B?"
  );

  // Missing declared use case ⇒ fail closed, never the unclear nurture pool.
  const failed = await resolveDeferredQueueMessage(
    {
      id: "q_followup_2",
      use_case_template: "stage_no_reply",
      language: "English",
      to_phone_number: CANARY_PHONE_B,
      metadata: { deferred_message_resolution: true, intent: STAGE_NO_REPLY_FOLLOWUP_INTENT },
    },
    { supabase }
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "stage_no_reply_use_case_missing");
});

// ── 3. Quarantine: campaign selection, public automation, KPIs ──────────────
test("canary identity is rejected by normal campaign/feeder selection", async () => {
  for (const phone of [CANARY_PHONE_A, CANARY_PHONE_B]) {
    const verdict = await evaluateCandidateEligibility(
      {
        master_owner_id: "mo_52f521c7e28ea3152f5e5f2c",
        property_id: "canaryprop_6bb8a46414092cb6318fbc35",
        best_phone_id: "ph_2ec5d75e72e842b33a7f7414",
        phone_id: "ph_2ec5d75e72e842b33a7f7414",
        canonical_e164: phone,
      },
      { allow_internal_test_phones: false } // production default (campaign feed pins false)
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason_code, "INTERNAL_TEST_PHONE");
    assert.equal(verdict.reason, "internal_test_phone_blocked_in_production");
  }
});

test("canary/proof rows are quarantined from KPI aggregation but recognizable for authorized execution", () => {
  const canary_by_phone = { thread_key: CANARY_PHONE_B, queue_status: "delivered" };
  const canary_by_marker = { thread_key: "+15551230000", metadata: { internal_canary: true } };
  const canary_by_kpi_marker = { thread_key: "+15551230001", metadata: { exclude_from_kpis: true } };
  const canary_by_source = { thread_key: "+15551230002", source: INTERNAL_CANARY_SOURCE };
  const real_row = { thread_key: "+15559998888", queue_status: "delivered" };
  const real_from_our_number = { thread_key: "+15559998888", from_phone_number: "+16128060495" };

  for (const row of [canary_by_phone, canary_by_marker, canary_by_kpi_marker, canary_by_source]) {
    assert.equal(isInternalCanaryFactRow(row), true);
  }
  assert.equal(isInternalCanaryFactRow(real_row), false);
  assert.equal(isInternalCanaryFactRow(real_from_our_number), false);

  const kept = excludeInternalCanaryRows([
    canary_by_phone,
    canary_by_marker,
    canary_by_kpi_marker,
    canary_by_source,
    real_row,
  ]);
  assert.deepEqual(kept, [real_row]);

  // The SAME markers make the row eligible for explicitly authorized canary
  // execution (queue-run proof mode recognizes internal_test_phone /
  // exclude_from_kpis) — quarantine and authorization share one vocabulary.
  const built = buildInternalCanaryFirstTouch(canaryBuildArgs());
  assert.equal(built.ok, true);
  assert.equal(built.queue_row.metadata.internal_test_phone, true);
  assert.equal(built.queue_row.metadata.exclude_from_kpis, true);
  assert.equal(isInternalCanaryFactRow(built.queue_row), true);
});
