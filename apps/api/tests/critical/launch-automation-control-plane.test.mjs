/**
 * launch-automation-control-plane.test.mjs
 *
 * Internal-only proof suite for the launch automation control plane slice.
 * Certifies that the EXISTING seller flow (classify.js + deterministic
 * transition resolver + decision contract) is the brain, and that the new
 * thin wiring (adapter, provenance, delivery-triggered follow-up, inbound
 * takeover cancellation, legacy flag lock, language fail-closed) routes
 * through it without introducing new classification, stages, or schedulers.
 *
 * Uses internal test identities only. No SMS is sent; every Supabase call is
 * an in-memory fake.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { normalizeClassificationContract } from "@/lib/domain/seller-flow/normalize-classification-contract.js";
import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { resolveDeterministicStageTransition } from "@/lib/domain/seller-flow/deterministic-stage-map.js";
import { buildSellerFlowDecision } from "@/lib/domain/seller-flow/seller-flow-decision-contract.js";
import {
  normalizeSellerFlowAutomationResult,
  CLASSIFICATION_SOURCE_CLASSIFY_JS,
} from "@/lib/domain/seller-flow/seller-flow-automation-adapter.js";
import {
  buildOutboundProvenance,
  attachOutboundProvenance,
  resolveSourceSurface,
  OUTBOUND_SOURCE_SURFACES,
} from "@/lib/domain/automation/outbound-provenance.js";
import {
  resolveGuardedAutoReplyMode,
  autoReplyModeAllowsQueue,
} from "@/lib/domain/seller-flow/auto-reply-mode.js";
import {
  resolveFollowUpPlan,
  cancelPendingFollowUpsForThread,
} from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import {
  resolveDeliveryFollowUpDecision,
  maybeScheduleFollowUpAfterDelivery,
  resolveFollowUpAutomationMode,
  FOLLOW_UP_AUTOMATION_MODES,
} from "@/lib/domain/seller-flow/delivery-triggered-followup.js";
import { selectSafeAutoReplyTemplate } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { processInboundWebhookLive } from "@/lib/domain/webhooks/webhook-event-processor.js";
import { patchUniversalLeadState } from "@/lib/domain/lead-state/patch-universal-lead-state.js";
import { LIFECYCLE_STAGE_ORDER } from "@/lib/domain/lead-state/universal-lead-state-registry.js";

const INTERNAL_PHONE = "+16127433952"; // registered internal test number

// ── Generic chainable fake Supabase ────────────────────────────────────────
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
        gt(col, val) { ctx.filters.push(["gt", col, val]); return q; },
        in(col, vals) { ctx.filters.push(["in", col, vals]); return q; },
        filter(col, op, val) { ctx.filters.push([op, col, val]); return q; },
        order() { return q; },
        limit() { return q; },
        maybeSingle() { ctx.single = true; return finish(); },
        single() { ctx.single = true; return finish(); },
        then(resolve, reject) { return finish().then(resolve, reject); },
      };
      return q;
    },
  };
}

async function contractFor(message, opts = {}) {
  const classification = await classify(message, opts.brain || null);
  const result = normalizeClassificationContract({
    classification,
    message,
    messageId: opts.messageId || "evt_test_1",
    threadId: opts.threadKey || INTERNAL_PHONE,
    propertyId: opts.propertyId || "prop_test_1",
    phone: opts.phone || INTERNAL_PHONE,
    inboundEventId: opts.inboundEventId || "evt_test_1",
  });
  assert.equal(result.ok, true);
  return { classification, contract: result.contract };
}

// ── Proof A — Map Touch 1 provenance ───────────────────────────────────────
test("Proof A: map_command touch-1 ownership check carries canonical provenance", () => {
  const provenance = buildOutboundProvenance({
    to_phone_number: INTERNAL_PHONE,
    property_id: "prop_map_1",
    template_id: "tpl_ownership_en",
    language: "English",
    metadata: {
      source: "map_command",
      touch_number: 1,
      seller_stage: "ownership_check",
      automation_origin: "map_command",
    },
  });
  assert.equal(provenance.source_surface, "map_command");
  assert.equal(provenance.touch_number, 1);
  assert.equal(provenance.stage_number, 1);
  assert.equal(provenance.seller_stage, "ownership_confirmation");
  assert.equal(provenance.template_language, "English");
  assert.equal(provenance.canonical_e164, INTERNAL_PHONE);
  assert.equal(provenance.automation_origin, "map_command");
});

// ── Proof B — Campaign Touch 1 provenance (same lifecycle as Map) ─────────
test("Proof B: campaign_command touch-1 enters the same lifecycle", () => {
  const provenance = buildOutboundProvenance({
    to_phone_number: INTERNAL_PHONE,
    campaign_id: "cmp_1",
    campaign_target_id: "ct_1",
    property_id: "prop_cmp_1",
    template_id: "tpl_ownership_es",
    language: "Spanish",
    metadata: { touch_number: 1, seller_stage: "ownership_check" },
  });
  assert.equal(provenance.source_surface, "campaign_command");
  assert.equal(provenance.campaign_id, "cmp_1");
  assert.equal(provenance.touch_number, 1);
  assert.equal(provenance.stage_number, 1);
  assert.equal(provenance.seller_stage, "ownership_confirmation");
  assert.equal(provenance.template_language, "Spanish");
});

test("provenance never fabricates touch or stage; all surfaces normalize", () => {
  const bare = buildOutboundProvenance({ to_phone_number: INTERNAL_PHONE, metadata: {} });
  assert.equal(bare.touch_number, null);
  assert.equal(bare.stage_number, null);
  assert.equal(bare.seller_stage, null);

  for (const [alias, expected] of [
    ["leadcommand_inbox", "inbox_manual"],
    ["seller_followup_scheduler", "follow_up_scheduler"],
    ["workflow_v2", "workflow_studio"],
    ["queue_runner", "queue_processor"],
    ["inbound_autopilot", "auto_reply"],
  ]) {
    const surface = resolveSourceSurface({ payload: {}, metadata: { source: alias } });
    assert.equal(surface, expected, `alias ${alias}`);
    assert.ok(OUTBOUND_SOURCE_SURFACES.includes(surface));
  }

  const explicit = attachOutboundProvenance({
    metadata: { automation_provenance: { provenance_version: "caller_supplied" } },
  });
  assert.equal(explicit.automation_provenance.provenance_version, "caller_supplied");
});

// ── Proof C — Inbound owner confirmed: S1 → S2 through classify.js ─────────
test("Proof C: classify.js owner confirmation advances Stage 1 → Stage 2 and gates through policy", async () => {
  const { classification, contract } = await contractFor("Yes, this is John. I own that property.");
  assert.equal(contract.normalized_intent, "ownership_confirmed");
  assert.equal(contract.ownership_signal, "confirmed");

  const transition = resolveSellerStageTransition({
    stage_before: "ownership_confirmation",
    intent: contract.normalized_intent,
    classification_confidence: classification.confidence,
  });
  assert.equal(transition.stage_before, "ownership_confirmation");
  assert.equal(transition.stage_after, "offer_interest");

  const decision = buildSellerFlowDecision({
    contract,
    transition,
    stage_before: "ownership_confirmation",
    auto_reply_mode: "internal_only",
    execution_allowed: false,
  });
  const normalized = normalizeSellerFlowAutomationResult({
    decision,
    contract,
    classification,
    inboundMessageId: "evt_test_1",
    threadKey: INTERNAL_PHONE,
  });
  assert.equal(normalized.classificationSource, CLASSIFICATION_SOURCE_CLASSIFY_JS);
  assert.equal(normalized.sellerStage, "offer_interest");
  assert.equal(normalized.stageNumber, 2);
  assert.equal(normalized.ownershipOutcome, "confirmed");
  assert.equal(normalized.humanReviewRequired, false);

  // Auto-reply decision flows through the explicit policy gate.
  const internal = autoReplyModeAllowsQueue({ mode: "internal_only", inboundFrom: INTERNAL_PHONE });
  assert.equal(internal.allowed, true);
  assert.equal(internal.internal_test_phone, true);
  const external = autoReplyModeAllowsQueue({ mode: "internal_only", inboundFrom: "+15555550100" });
  assert.equal(external.allowed, false);
});

test("Proof C (takeover): inbound cancels pending no-reply follow-ups", async () => {
  const log = [];
  const supabase = createFakeSupabase((ctx) => {
    if (ctx.table === "send_queue" && ctx.op === "select") {
      return { data: [{ id: "q1", metadata: {}, queue_status: "scheduled", type: "followup" }] };
    }
    return { data: null };
  }, log);

  const result = await cancelPendingFollowUpsForThread({
    thread_key: INTERNAL_PHONE,
    inbound_event_id: "evt_test_1",
    supabase,
  });
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, 1);
  const update = log.find((c) => c.op === "update" && c.table === "send_queue");
  assert.equal(update.payload.queue_status, "cancelled");
  assert.equal(update.payload.metadata.cancelled_by, "inbound_takeover");
});

// ── Proof D — Interested: existing flow advances toward asking price ───────
test("Proof D: seller interest routes to the canonical next stage (no new stages)", () => {
  const transition = resolveSellerStageTransition({
    stage_before: "offer_interest",
    intent: "seller_interested",
    classification_confidence: 0.95,
  });
  assert.equal(transition.stage_after, "asking_price");
  assert.ok(LIFECYCLE_STAGE_ORDER.includes(transition.stage_after));
});

// ── Proof E — Asking price captured ────────────────────────────────────────
test("Proof E: asking price is captured and advances toward condition with preliminary ADE", async () => {
  const { classification } = await contractFor("I would want $250,000 for it");
  assert.equal(classification.primary_intent, "asking_price_provided");

  const transition = resolveSellerStageTransition({
    stage_before: "offer_interest",
    intent: "asking_price_provided",
    new_facts: { asking_price: 250000 },
    classification_confidence: classification.confidence,
  });
  assert.equal(transition.stage_after, "property_condition");
  assert.equal(transition.ade_action, "run_preliminary");
  assert.ok(transition.facts_patch?.asking_price, "asking price persisted in facts patch");
});

// ── Proof F — Condition facts prepare offer authority ──────────────────────
test("Proof F: condition disclosure captures facts and requests offer authority", () => {
  const transition = resolveSellerStageTransition({
    stage_before: "asking_price",
    intent: "condition_disclosed",
    known_facts: { asking_price: 250000 },
    new_facts: {
      condition_summary: "roof leak, HVAC out",
      condition_disclosed: true,
      occupancy_status: "vacant",
    },
    classification_confidence: 0.95,
  });
  assert.equal(transition.stage_after, "offer");
  assert.equal(transition.next_action, "execute_ade");
  assert.equal(transition.ade_action, "run_full");
});

// ── Proof G — Stage 5 offer requires offer authority ───────────────────────
test("Proof G: no actual offer proceeds without underwriting authority", () => {
  for (const intent of ["offer_accepted", "accepts_offer", "contract_request"]) {
    const transition = resolveSellerStageTransition({
      stage_before: "offer",
      intent,
      negotiation_state: { terms_accepted: true },
      contract_state: null,
      ade_result: null,
      classification_confidence: 0.95,
    });
    assert.equal(transition.stage_after, "offer", intent);
    assert.equal(transition.next_action, "execute_ade", intent);
    assert.match(transition.reasoning_code, /^S5_HOLD_/, intent);
  }
});

// ── Proof H — Contract authority ambiguity goes to human review ────────────
test("Proof H: signer/LLC/trust/heir ambiguity routes to human review, never auto-send", () => {
  for (const intent of [
    "executor_heir_respondent",
    "entity_representative_respondent",
    "co_owner_respondent",
  ]) {
    const decision = resolveDeterministicStageTransition({
      current_stage: "seller_contract",
      inbound_intent: intent,
    });
    assert.equal(decision.safety_tier, "review", intent);
    assert.equal(decision.auto_send_eligible, false, intent);
    assert.equal(decision.should_queue_reply, false, intent);
  }
});

// ── Proof I — Opt-out wins over everything ──────────────────────────────────
test("Proof I: STOP suppresses all automation and follow-ups", async () => {
  const { contract } = await contractFor("STOP");
  assert.equal(contract.normalized_intent, "opt_out");
  assert.equal(contract.opt_out_signal, true);

  const routed = resolveDeterministicStageTransition({
    current_stage: "ownership_check",
    inbound_intent: "opt_out",
  });
  assert.equal(routed.safety_tier, "suppress");
  assert.equal(routed.should_queue_reply, false);

  const plan = resolveFollowUpPlan("opt_out", { thread_key: INTERNAL_PHONE });
  assert.equal(plan.suppressed, true);
  assert.equal(plan.followup_created, false);

  const normalized = normalizeSellerFlowAutomationResult({ contract });
  assert.equal(normalized.suppressionAction, "opt_out");
});

// ── Proof J — Wrong number wins; no normal auto-reply ───────────────────────
test("Proof J: wrong number suppresses reply and creates no follow-up", async () => {
  const { contract } = await contractFor("Wrong number, I do not know that property");
  assert.equal(contract.normalized_intent, "wrong_number");
  assert.equal(contract.wrong_number_signal, true);

  const routed = resolveDeterministicStageTransition({
    current_stage: "ownership_check",
    inbound_intent: "wrong_number",
  });
  assert.equal(routed.safety_tier, "suppress");
  assert.equal(routed.should_queue_reply, false);

  const plan = resolveFollowUpPlan("wrong_number", { thread_key: INTERNAL_PHONE });
  assert.equal(plan.followup_created, false);

  const normalized = normalizeSellerFlowAutomationResult({ contract });
  assert.equal(normalized.suppressionAction, "wrong_number");
});

// ── Proof K — Language continuity: no English fallback ──────────────────────
test("Proof K: non-English inbound preserves language and fails closed without matching template", async () => {
  const { classification, contract } = await contractFor("Sí, soy el dueño de esa propiedad");
  assert.equal(classification.language, "Spanish");
  assert.equal(contract.language, "Spanish");

  const english_only = createFakeSupabase((ctx) => {
    if (ctx.table === "sms_templates") {
      return {
        data: [
          {
            template_id: "tpl_en",
            use_case: "consider_selling",
            stage_code: "consider_selling",
            language: "English",
            is_active: true,
            safe_for_auto_reply: true,
            template_body: "English body",
          },
        ],
      };
    }
    return { data: null };
  });

  const blocked = await selectSafeAutoReplyTemplate({
    supabaseClient: english_only,
    classification,
    decision: { allowed_template_stages: ["consider_selling"] },
    threadKey: INTERNAL_PHONE,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "language_template_missing");
  assert.equal(blocked.human_review_required, true);

  const with_spanish = createFakeSupabase((ctx) => {
    if (ctx.table === "sms_templates") {
      return {
        data: [
          {
            template_id: "tpl_en",
            use_case: "consider_selling",
            stage_code: "consider_selling",
            language: "English",
            is_active: true,
            safe_for_auto_reply: true,
            template_body: "English body",
          },
          {
            template_id: "tpl_es",
            use_case: "consider_selling",
            stage_code: "consider_selling",
            language: "Spanish",
            is_active: true,
            safe_for_auto_reply: true,
            template_body: "Cuerpo en español",
          },
        ],
      };
    }
    return { data: null };
  });

  const selected = await selectSafeAutoReplyTemplate({
    supabaseClient: with_spanish,
    classification,
    decision: { allowed_template_stages: ["consider_selling"] },
    threadKey: INTERNAL_PHONE,
  });
  assert.equal(selected.ok !== false, true);
  assert.equal(selected.template?.language, "Spanish");

  const adapter = normalizeSellerFlowAutomationResult({ contract, classification });
  assert.equal(adapter.language, "Spanish");
});

// ── Proof L — Duplicate webhook: one classification, one decision ───────────
test("Proof L: duplicate inbound webhook is skipped without reclassification", async () => {
  const supabase = createFakeSupabase((ctx) => {
    if (ctx.table === "message_events" && ctx.op === "select") {
      return { data: { id: "me_1", metadata: { seller_flow_completed: true } } };
    }
    if (ctx.table === "webhook_log") {
      return { data: { id: "wh_1" } };
    }
    return { data: null };
  });

  let handler_calls = 0;
  const outcome = await processInboundWebhookLive(
    {
      id: "wh_1",
      provider_message_sid: "SM_dup_1",
      payload: { from: INTERNAL_PHONE, message_id: "SM_dup_1", message_body: "Yes I own it" },
    },
    {},
    {
      supabase,
      handleTextgridInbound: async () => {
        handler_calls += 1;
        return { ok: true };
      },
    }
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.skipped, true);
  assert.equal(outcome.reason, "already_persisted");
  assert.equal(handler_calls, 0, "seller flow must not run twice for the same provider message");
});

// ── Proof M — Manual stage change updates canonical state + audit ───────────
test("Proof M: manual stage change patches canonical state and writes an audit event", async () => {
  const log = [];
  const supabase = createFakeSupabase((ctx) => {
    if (ctx.table === "inbox_thread_state" && ctx.op === "select") {
      return {
        data: {
          thread_key: INTERNAL_PHONE,
          lifecycle_stage: "offer_interest",
          operational_status: "active_communication",
        },
      };
    }
    if (ctx.table === "inbox_thread_state" && ctx.op === "upsert") {
      return { data: { thread_key: INTERNAL_PHONE, ...ctx.payload } };
    }
    if (ctx.table === "universal_lead_state_events" && ctx.op === "insert") {
      return { data: (ctx.payload || []).map((_, index) => ({ id: `audit_${index}` })) };
    }
    return { data: null };
  }, log);

  const result = await patchUniversalLeadState({
    threadKey: INTERNAL_PHONE,
    patch: { lifecycle_stage: "asking_price" },
    meta: { change_source: "manual", operator_id: "op_internal" },
    supabase,
  });

  assert.equal(result.ok, true);
  const upsert = log.find((c) => c.table === "inbox_thread_state" && c.op === "upsert");
  assert.equal(upsert.payload.lifecycle_stage, "asking_price");
  assert.equal(upsert.payload.stage_source, "manual");
  const audit = log.find((c) => c.table === "universal_lead_state_events" && c.op === "insert");
  assert.ok(audit, "audit event written");
  assert.ok((result.audit_event_ids || []).length >= 1);
});

// ── Legacy flag lock ────────────────────────────────────────────────────────
test("legacy live flags can never enable public sending without auto_reply_mode", () => {
  const blocked = resolveGuardedAutoReplyMode({
    legacyEnabled: true,
    legacyLiveEnabled: true,
  });
  assert.equal(blocked.mode, "disabled");
  assert.equal(blocked.legacy_live_fallthrough_blocked, true);
  assert.equal(blocked.audit_reason, "auto_reply_mode_missing_or_invalid");

  assert.equal(resolveGuardedAutoReplyMode({}).mode, "disabled");
  assert.equal(resolveGuardedAutoReplyMode({ requestedMode: "totally_invalid" }).mode, "disabled");
  assert.equal(
    resolveGuardedAutoReplyMode({ systemMode: "internal_only", legacyLiveEnabled: true, legacyEnabled: true }).mode,
    "internal_only"
  );
  // Legacy dry-run may surface diagnostics but cannot send publicly.
  assert.equal(
    resolveGuardedAutoReplyMode({ legacyEnabled: true, legacyDryRun: true }).mode,
    "dry_run"
  );
});

// ── Delivery-triggered follow-up gate ───────────────────────────────────────
test("follow-ups schedule only after provider-confirmed delivery", async () => {
  const base = {
    provider_message_id: "SM_1",
    followup_intent: "not_interested",
  };
  for (const status of ["failed", "undelivered", "blocked", "accepted", "sent", ""]) {
    const decision = resolveDeliveryFollowUpDecision({ ...base, final_delivery_status: status });
    assert.equal(decision.eligible, false, `status ${status || "(empty)"}`);
  }
  assert.equal(
    resolveDeliveryFollowUpDecision({ final_delivery_status: "delivered", followup_intent: "x" }).eligible,
    false,
    "missing provider id"
  );
  assert.equal(
    resolveDeliveryFollowUpDecision({ ...base, final_delivery_status: "delivered", has_inbound_after_outbound: true }).eligible,
    false
  );
  assert.equal(
    resolveDeliveryFollowUpDecision({ ...base, final_delivery_status: "delivered", pending_followup_exists: true }).eligible,
    false
  );
  assert.equal(
    resolveDeliveryFollowUpDecision({ ...base, final_delivery_status: "delivered", contactability_status: "opted_out" }).eligible,
    false
  );
  assert.equal(
    resolveDeliveryFollowUpDecision({ ...base, final_delivery_status: "delivered" }).eligible,
    true
  );
});

function deliveryFakeSupabase(thread_key = INTERNAL_PHONE) {
  const sent_at = "2026-07-08T10:00:00.000Z";
  return createFakeSupabase((ctx) => {
    if (ctx.table === "message_events" && ctx.single) {
      return {
        data: {
          id: "me_out_1",
          thread_key,
          sent_at,
          event_timestamp: sent_at,
          master_owner_id: "own_1",
          property_id: "prop_1",
          metadata: { automation_provenance: { followup_intent: "not_interested" } },
        },
      };
    }
    if (ctx.table === "message_events") return { data: [] }; // no newer events
    if (ctx.table === "send_queue") return { data: [] }; // no pending follow-ups
    if (ctx.table === "inbox_thread_state") {
      return { data: { contactability_status: "contactable", lifecycle_stage: "offer_interest" } };
    }
    return { data: null };
  });
}

const NO_SYSTEM_MODE = async () => null;

function throwingScheduler() {
  return async () => {
    throw new Error("must_not_schedule");
  };
}

test("delivery trigger delegates to the existing follow-up scheduler with guards", async () => {
  const supabase = deliveryFakeSupabase();

  const calls = [];
  const outcome = await maybeScheduleFollowUpAfterDelivery({
    provider_message_sid: "SM_1",
    final_delivery_status: "delivered",
    supabase,
    followUpMode: "live_limited",
    getSystemValueImpl: NO_SYSTEM_MODE,
    scheduleFollowUpImpl: async (intent, thread_key, context) => {
      calls.push({ intent, thread_key, context });
      return { ok: true, followup_created: true, scheduled_for: "2026-08-07T10:00:00.000Z" };
    },
  });

  assert.equal(outcome.scheduled, true);
  assert.equal(outcome.mode, "live_limited");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].intent, "not_interested");
  assert.equal(calls[0].thread_key, INTERNAL_PHONE);
  assert.equal(calls[0].context.source, "delivery_triggered_followup");

  // Failed delivery never reaches the scheduler, even with live authority.
  const failed = await maybeScheduleFollowUpAfterDelivery({
    provider_message_sid: "SM_1",
    final_delivery_status: "failed",
    supabase,
    followUpMode: "live_limited",
    getSystemValueImpl: NO_SYSTEM_MODE,
    scheduleFollowUpImpl: throwingScheduler(),
  });
  assert.equal(failed.scheduled, false);
  assert.match(failed.reason, /not_provider_confirmed_delivered/);
});

// ── Explicit follow-up activation gate ──────────────────────────────────────
test("follow-up activation: missing mode fails closed — delivered receipt alone is not authority", async () => {
  const outcome = await maybeScheduleFollowUpAfterDelivery({
    provider_message_sid: "SM_1",
    final_delivery_status: "delivered",
    supabase: deliveryFakeSupabase(),
    getSystemValueImpl: NO_SYSTEM_MODE,
    scheduleFollowUpImpl: throwingScheduler(),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.scheduled, false);
  assert.equal(outcome.reason, "followup_automation_disabled");
  assert.equal(outcome.mode, "disabled");
});

test("follow-up activation: invalid mode fails closed to disabled", async () => {
  const outcome = await maybeScheduleFollowUpAfterDelivery({
    provider_message_sid: "SM_1",
    final_delivery_status: "delivered",
    supabase: deliveryFakeSupabase(),
    followUpMode: "totally_invalid_mode",
    getSystemValueImpl: NO_SYSTEM_MODE,
    scheduleFollowUpImpl: throwingScheduler(),
  });
  assert.equal(outcome.scheduled, false);
  assert.equal(outcome.reason, "followup_automation_disabled");

  const unreadable = await maybeScheduleFollowUpAfterDelivery({
    provider_message_sid: "SM_1",
    final_delivery_status: "delivered",
    supabase: deliveryFakeSupabase(),
    getSystemValueImpl: async () => {
      throw new Error("system_control_unreadable");
    },
    scheduleFollowUpImpl: throwingScheduler(),
  });
  assert.equal(unreadable.scheduled, false);
  assert.equal(unreadable.reason, "followup_automation_disabled");
});

test("follow-up activation: dry_run evaluates guards but inserts no send_queue rows", async () => {
  const outcome = await maybeScheduleFollowUpAfterDelivery({
    provider_message_sid: "SM_1",
    final_delivery_status: "delivered",
    supabase: deliveryFakeSupabase(),
    followUpMode: "dry_run",
    getSystemValueImpl: NO_SYSTEM_MODE,
    scheduleFollowUpImpl: throwingScheduler(),
  });
  assert.equal(outcome.scheduled, false);
  assert.equal(outcome.reason, "followup_dry_run");
  assert.equal(outcome.would_schedule, true);
});

test("follow-up activation: internal_only blocks real seller phones and allows internal test phones", async () => {
  const blocked = await maybeScheduleFollowUpAfterDelivery({
    provider_message_sid: "SM_1",
    final_delivery_status: "delivered",
    supabase: deliveryFakeSupabase("+15555550123"),
    followUpMode: "internal_only",
    getSystemValueImpl: NO_SYSTEM_MODE,
    scheduleFollowUpImpl: throwingScheduler(),
  });
  assert.equal(blocked.scheduled, false);
  assert.equal(blocked.reason, "followup_internal_only_blocked");

  const calls = [];
  const allowed = await maybeScheduleFollowUpAfterDelivery({
    provider_message_sid: "SM_1",
    final_delivery_status: "delivered",
    supabase: deliveryFakeSupabase(INTERNAL_PHONE),
    followUpMode: "internal_only",
    getSystemValueImpl: NO_SYSTEM_MODE,
    scheduleFollowUpImpl: async (intent, thread_key) => {
      calls.push({ intent, thread_key });
      return { ok: true, followup_created: true, scheduled_for: "2026-08-07T10:00:00.000Z" };
    },
  });
  assert.equal(allowed.scheduled, true);
  assert.equal(calls[0].thread_key, INTERNAL_PHONE);
});

test("follow-up activation: legacy auto_reply_live_enabled can never activate scheduling", async () => {
  const resolution = resolveFollowUpAutomationMode({ legacyLiveEnabled: true });
  assert.equal(resolution.mode, "disabled");
  assert.equal(resolution.legacy_live_fallthrough_blocked, true);
  assert.equal(resolution.audit_reason, "followup_automation_mode_missing_or_invalid");

  // Explicit system_control mode always wins over legacy flags.
  assert.equal(
    resolveFollowUpAutomationMode({ systemMode: "internal_only", legacyLiveEnabled: true }).mode,
    "internal_only"
  );
  assert.ok(FOLLOW_UP_AUTOMATION_MODES.includes("disabled"));

  const outcome = await maybeScheduleFollowUpAfterDelivery({
    provider_message_sid: "SM_1",
    final_delivery_status: "delivered",
    supabase: deliveryFakeSupabase(),
    legacyLiveEnabled: true,
    getSystemValueImpl: NO_SYSTEM_MODE,
    scheduleFollowUpImpl: throwingScheduler(),
  });
  assert.equal(outcome.scheduled, false);
  assert.equal(outcome.reason, "followup_automation_disabled");
});
