// ─── acquisition-brain-followup-shadow.test.mjs ────────────────────────────
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  planShadowFollowup,
  cancelShadowFollowup,
  evaluateFollowupCancellations,
  proveStage1FollowupShadow,
  resolveFollowupPolicy,
  resolveCanonicalFollowupStage,
  normalizeDeliveryStatus,
  FOLLOWUP_POLICY_REGISTRY,
  FOLLOWUP_PLAN_STATES,
  CANCELLATION_REASONS,
  SHADOW_FOLLOWUP_EVENT,
  SHADOW_FOLLOWUP_CANCELLED_EVENT,
  STAGE_NUMBER_TO_CANONICAL,
} from "@/lib/domain/acquisition-brain/shadow-followup-planner.js";
import { resolveShadowTimezone } from "@/lib/domain/acquisition-brain/shadow-burst-timing.js";
import { ACQUISITION_LIFECYCLE_STAGES as S } from "@/lib/domain/acquisition-brain/lifecycle-registry.js";

const THREAD = "+16128072000";
const DELIVERED = "2026-07-10T15:00:00.000Z";
const SID = "SMO8VxnJAOWsNa926YKkFtS5w==";

function basePlan(overrides = {}) {
  return planShadowFollowup({
    thread_key: THREAD,
    triggering_outbound_id: "out-1",
    delivery_event_id: "del-1",
    delivery_status: "delivered",
    delivered_at: DELIVERED,
    provider_sid: SID,
    stage: S.OWNERSHIP_CHECK,
    outbound_use_case: "ownership_check",
    template_use_case: "ownership_check",
    ...overrides,
  });
}

// 1–11 delivery eligibility
test("1 delivered Stage 1 outbound eligible", () => {
  const r = basePlan();
  assert.equal(r.ok, true);
  assert.equal(r.plan.policy_id, "stage1_ownership_no_reply");
  assert.equal(r.plan.delay_ms, 3 * 24 * 60 * 60_000);
  assert.equal(r.may_send, false);
});

test("2 queued is ineligible", () => {
  const r = basePlan({ delivery_status: "queued" });
  assert.equal(r.ok, false);
  assert.equal(r.state, FOLLOWUP_PLAN_STATES.INELIGIBLE);
});

test("3 accepted is ineligible", () => {
  assert.equal(basePlan({ delivery_status: "accepted" }).ok, false);
});

test("4 sent is ineligible", () => {
  assert.equal(basePlan({ delivery_status: "sent" }).ok, false);
});

test("5 HTTP success without delivered mapping is ineligible", () => {
  const n = normalizeDeliveryStatus("success", {
    provider_sid: SID,
    delivered_at: DELIVERED,
  });
  assert.equal(n.authoritative, false);
  assert.equal(basePlan({ delivery_status: "success" }).ok, false);
});

test("6 delivered with SID is eligible", () => {
  const n = normalizeDeliveryStatus("delivered", {
    provider_sid: SID,
    delivered_at: DELIVERED,
  });
  assert.equal(n.authoritative, true);
  assert.equal(basePlan().ok, true);
});

test("7 missing SID", () => {
  const n = normalizeDeliveryStatus("delivered", { delivered_at: DELIVERED });
  assert.equal(n.authoritative, false);
  assert.equal(n.reason, "missing_provider_sid");
});

test("8 missing delivered_at", () => {
  const n = normalizeDeliveryStatus("delivered", { provider_sid: SID });
  assert.equal(n.authoritative, false);
});

test("9 invalid delivered_at", () => {
  const n = normalizeDeliveryStatus("delivered", {
    provider_sid: SID,
    delivered_at: "not-a-date",
  });
  assert.equal(n.authoritative, false);
  assert.equal(n.reason, "invalid_delivered_at");
});

test("10 missing use case", () => {
  const r = planShadowFollowup({
    thread_key: THREAD,
    delivery_event_id: "d",
    delivery_status: "delivered",
    delivered_at: DELIVERED,
    provider_sid: SID,
    stage: S.OWNERSHIP_CHECK,
    outbound_use_case: null,
    template_use_case: null,
  });
  // may match stage but still need use case for stages 1-6
  assert.equal(r.ok, false);
  assert.ok(["missing_use_case", "no_matching_policy"].includes(r.reason));
});

test("11 missing template provenance falls back to outbound_use_case", () => {
  const r = basePlan({ template_use_case: null, template_id: null });
  assert.equal(r.ok, true);
});

// 12–19 stage mapping
test("12 exact Stage 1 mapping", () => {
  assert.equal(resolveCanonicalFollowupStage("ownership_check").stage, S.OWNERSHIP_CHECK);
  assert.equal(resolveCanonicalFollowupStage(1).stage, S.OWNERSHIP_CHECK);
});

test("13 exact Stage 2 mapping", () => {
  assert.equal(
    resolveCanonicalFollowupStage("interest_proposal").stage,
    S.INTEREST_PROPOSAL_CONFIRMATION
  );
  assert.equal(resolveCanonicalFollowupStage("consider_selling").stage_number, 2);
});

test("14 exact Stage 3 mapping", () => {
  assert.equal(resolveCanonicalFollowupStage("asking_price").stage_number, 3);
});

test("15 exact Stage 4 mapping", () => {
  assert.equal(resolveCanonicalFollowupStage("property_condition").stage_number, 4);
});

test("16 exact Stage 5 mapping", () => {
  assert.equal(resolveCanonicalFollowupStage("actual_proposal").stage_number, 5);
  assert.equal(resolveCanonicalFollowupStage("proposal_review").stage_number, 5);
});

test("17 exact Stage 6 mapping", () => {
  assert.equal(resolveCanonicalFollowupStage("formal_contract").stage_number, 6);
  assert.equal(resolveCanonicalFollowupStage("contract_signature").stage_number, 6);
});

test("18 stage10 cannot map Stage 1", () => {
  const r = resolveCanonicalFollowupStage("stage10");
  assert.equal(r.stage, S.CLOSED);
  assert.equal(r.stage_number, 10);
  assert.notEqual(r.stage_number, 1);
  assert.equal(STAGE_NUMBER_TO_CANONICAL[10], S.CLOSED);
});

test("19 unknown stage", () => {
  const r = resolveCanonicalFollowupStage("not_a_real_stage");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_matching_policy");
});

// 20–23 active plan contract
test("20 duplicate delivery webhook one plan", () => {
  const a = basePlan();
  const b = basePlan({ active_followups: [a.plan] });
  assert.equal(b.reason, "duplicate_delivery_idempotent");
  assert.equal(b.active_count, 1);
});

test("21 concurrent delivery evaluation same dedupe", () => {
  const a = basePlan();
  const b = basePlan();
  assert.equal(a.event.dedupe_key, b.event.dedupe_key);
});

test("22 exactly one active plan after supersede", () => {
  const first = basePlan();
  const second = basePlan({
    triggering_outbound_id: "out-2",
    delivery_event_id: "del-2",
    active_followups: [first.plan],
  });
  assert.equal(second.ok, true);
  assert.equal(second.supersession.resulting_active_count, 1);
  assert.ok(second.plan.superseded_plans.length >= 1);
});

test("23 newer policy supersedes prior plan", () => {
  const first = basePlan();
  const second = basePlan({
    triggering_outbound_id: "out-new",
    delivery_event_id: "del-new",
    active_followups: [first.plan],
  });
  assert.equal(second.supersession.decision, "supersede_prior");
});

// 24–34 cancellations
test("24 inbound cancellation", () => {
  const c = cancelShadowFollowup({
    plan: basePlan().plan,
    reason: CANCELLATION_REASONS.INBOUND_REPLY_RECEIVED,
    source_event_id: "in-1",
  });
  assert.equal(c.ok, true);
  assert.equal(c.plan.state, FOLLOWUP_PLAN_STATES.CANCELLED);
  assert.equal(c.event.event_type, SHADOW_FOLLOWUP_CANCELLED_EVENT);
});

test("25 duplicate inbound cancellation not fabricated", () => {
  const first = cancelShadowFollowup({
    plan: basePlan().plan,
    reason: CANCELLATION_REASONS.INBOUND_REPLY_RECEIVED,
    source_event_id: "in-1",
  });
  const second = cancelShadowFollowup({
    plan: first.plan,
    reason: CANCELLATION_REASONS.INBOUND_REPLY_RECEIVED,
    source_event_id: "in-2",
  });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "plan_not_active");
});

test("26 stage-transition cancellation", () => {
  const c = cancelShadowFollowup({
    plan: basePlan().plan,
    reason: CANCELLATION_REASONS.LIFECYCLE_STAGE_ADVANCED,
    source_event_id: "st-1",
  });
  assert.equal(c.plan.cancellation_reason, CANCELLATION_REASONS.LIFECYCLE_STAGE_ADVANCED);
});

test("27 opt-out cancellation", () => {
  assert.equal(
    cancelShadowFollowup({
      plan: basePlan().plan,
      reason: CANCELLATION_REASONS.OPT_OUT,
      source_event_id: "x",
    }).plan.cancellation_reason,
    CANCELLATION_REASONS.OPT_OUT
  );
});

test("28 wrong-number cancellation", () => {
  assert.equal(
    cancelShadowFollowup({
      plan: basePlan().plan,
      reason: CANCELLATION_REASONS.WRONG_NUMBER,
      source_event_id: "x",
    }).ok,
    true
  );
});

test("29 ownership-denied cancellation", () => {
  assert.equal(
    cancelShadowFollowup({
      plan: basePlan().plan,
      reason: CANCELLATION_REASONS.OWNERSHIP_DENIED,
      source_event_id: "x",
    }).ok,
    true
  );
});

test("30 sold-property cancellation", () => {
  assert.equal(
    cancelShadowFollowup({
      plan: basePlan().plan,
      reason: CANCELLATION_REASONS.SOLD_PROPERTY,
      source_event_id: "x",
    }).ok,
    true
  );
});

test("31 never-owned cancellation", () => {
  assert.equal(
    cancelShadowFollowup({
      plan: basePlan().plan,
      reason: CANCELLATION_REASONS.NEVER_OWNED,
      source_event_id: "x",
    }).ok,
    true
  );
});

test("32 terminal-provider cancellation", () => {
  assert.equal(
    cancelShadowFollowup({
      plan: basePlan().plan,
      reason: CANCELLATION_REASONS.TERMINAL_PROVIDER_FAILURE,
      source_event_id: "x",
    }).ok,
    true
  );
});

test("33 authority-unverified cancellation", () => {
  assert.equal(
    cancelShadowFollowup({
      plan: basePlan().plan,
      reason: CANCELLATION_REASONS.AUTHORITY_UNVERIFIED,
      source_event_id: "x",
    }).ok,
    true
  );
});

test("34 human override", () => {
  assert.equal(
    cancelShadowFollowup({
      plan: basePlan().plan,
      reason: CANCELLATION_REASONS.HUMAN_OVERRIDE,
      source_event_id: "op-1",
    }).ok,
    true
  );
});

test("35 archived alias", () => {
  const r = basePlan({ thread_key: "6128072000" });
  assert.equal(r.ok, false);
});

// 36–42 timezone
test("36 property timezone", () => {
  const tz = resolveShadowTimezone({ property_timezone: "America/New_York" });
  const r = basePlan({ timezone_context: tz });
  assert.equal(r.plan.timezone, "America/New_York");
  assert.equal(r.plan.timezone_source, "property_market");
});

test("37 campaign timezone", () => {
  const tz = resolveShadowTimezone({ campaign_timezone: "America/Denver" });
  assert.equal(basePlan({ timezone_context: tz }).plan.timezone, "America/Denver");
});

test("38 operational fallback", () => {
  const tz = resolveShadowTimezone({});
  assert.equal(tz.fallback_used, true);
  assert.equal(tz.timezone, "America/Chicago");
});

test("39 unknown timezone blocked", () => {
  const tz = resolveShadowTimezone({ property_timezone: "Not/A_Zone" });
  const r = basePlan({ timezone_context: tz });
  assert.equal(r.ok, false);
  assert.equal(r.state, FOLLOWUP_PLAN_STATES.BLOCKED);
});

test("40 contact-window adjustment", () => {
  // delivered late local → scheduled may defer
  const r = basePlan({ delivered_at: "2026-07-11T04:00:00.000Z" });
  assert.ok(r.plan.final_scheduled_for);
  assert.ok(r.plan.raw_scheduled_for);
});

test("41 DST spring scheduled non-null", () => {
  const r = basePlan({ delivered_at: "2026-03-08T10:00:00.000Z" });
  assert.ok(r.plan.final_scheduled_for);
});

test("42 DST fall scheduled non-null", () => {
  const r = basePlan({ delivered_at: "2026-11-01T10:00:00.000Z" });
  assert.ok(r.plan.final_scheduled_for);
});

// 43–47 stages 7–10
test("43 Stage 7 requires authoritative event", () => {
  const r = planShadowFollowup({
    thread_key: THREAD,
    stage: S.DISPOSITION,
    outbound_use_case: "disposition_ops_reminder",
    delivery_status: "delivered",
    delivered_at: DELIVERED,
    provider_sid: SID,
    delivery_event_id: "d",
    authoritative_transaction_event: null,
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.reason === "policy_disabled" ||
      r.reason === "authoritative_transaction_event_required"
  );
});

test("44 Stage 8 requires authoritative event", () => {
  const r = planShadowFollowup({
    thread_key: THREAD,
    stage: "stage8",
    outbound_use_case: "buyer_contract_ops_reminder",
    delivery_status: "delivered",
    delivered_at: DELIVERED,
    provider_sid: SID,
    delivery_event_id: "d",
  });
  assert.equal(r.ok, false);
});

test("45 Stage 9 requires authoritative event", () => {
  assert.equal(
    planShadowFollowup({
      thread_key: THREAD,
      stage: 9,
      outbound_use_case: "escrow_ops_reminder",
      delivery_status: "delivered",
      delivered_at: DELIVERED,
      provider_sid: SID,
      delivery_event_id: "d",
    }).ok,
    false
  );
});

test("46 Stage 10 requires authoritative event", () => {
  assert.equal(
    planShadowFollowup({
      thread_key: THREAD,
      stage: "stage10",
      outbound_use_case: "closing_ops_reminder",
      delivery_status: "delivered",
      delivered_at: DELIVERED,
      provider_sid: SID,
      delivery_event_id: "d",
    }).ok,
    false
  );
});

test("47 seller text cannot create Stage 7–10 follow-up", () => {
  // seller text alone → no delivery authority + no txn event + policies disabled
  const r = planShadowFollowup({
    thread_key: THREAD,
    stage: S.DISPOSITION,
    outbound_use_case: null,
    delivery_status: null,
    delivery_event_id: null,
  });
  assert.equal(r.ok, false);
});

// 48–55 events / safety
test("48 plan event dedupe", () => {
  const a = basePlan();
  assert.ok(a.event.dedupe_key.startsWith("followup:"));
  assert.equal(a.event.event_type, SHADOW_FOLLOWUP_EVENT);
});

test("49 cancellation event dedupe", () => {
  const c = cancelShadowFollowup({
    plan: basePlan().plan,
    reason: CANCELLATION_REASONS.INBOUND_REPLY_RECEIVED,
    source_event_id: "in-9",
  });
  assert.ok(c.event.dedupe_key.startsWith("followup_cancel:"));
});

test("50 event persistence failure fail-open", async () => {
  const { emitShadowFollowupEvent } = await import(
    "@/lib/domain/acquisition-brain/shadow-followup-planner.js"
  );
  const out = await emitShadowFollowupEvent(basePlan(), {
    emitAutomationEvent: async () => {
      throw new Error("db");
    },
  });
  assert.equal(out.ok, false);
});

test("51 history lookup failure does not throw cancel eval", async () => {
  const { evaluateAndEmitShadowFollowupCancellations } = await import(
    "@/lib/domain/acquisition-brain/shadow-followup-planner.js"
  );
  const out = await evaluateAndEmitShadowFollowupCancellations({
    thread_key: THREAD,
    reason: CANCELLATION_REASONS.INBOUND_REPLY_RECEIVED,
    source_event_id: "x",
    supabase: {
      from() {
        throw new Error("db_down");
      },
    },
    emit: false,
  });
  assert.equal(out.ok, true);
  assert.equal(out.cancelled_count, 0);
});

test("52 queue delta zero flags", () => {
  const r = basePlan();
  assert.equal(r.may_enqueue, false);
  assert.equal(r.plan.may_enqueue, false);
});

test("53 provider calls zero", () => {
  assert.equal(basePlan().may_send, false);
});

test("54 stage mutations zero", () => {
  assert.equal(basePlan().may_mutate_stages, false);
});

test("55 legacy path unaffected (shadow isolation)", () => {
  const r = basePlan();
  assert.equal(r.event.source || "acquisition_brain_shadow", "acquisition_brain_shadow");
  assert.equal(r.may_send, false);
});

test("56 exact canary Stage 1 proof", () => {
  const proof = proveStage1FollowupShadow({
    thread_key: THREAD,
    outbound_id: "canary-out",
    delivery_event_id: "canary-del",
    delivered_at: DELIVERED,
    provider_sid: SID,
    inbound_event_id: "canary-in",
    inbound_at: "2026-07-11T12:00:00.000Z",
    outbound_use_case: "ownership_check",
  });
  assert.equal(proof.ok, true);
  assert.equal(proof.followup_count, 1);
  assert.equal(proof.cancelled_before_transport, true);
  assert.equal(proof.second_inbound_no_duplicate, true);
  assert.equal(proof.production_followup_created, false);
  assert.equal(proof.delay_ms, 3 * 24 * 60 * 60_000);
});

test("stage6 never resolves stage 1", () => {
  assert.equal(resolveCanonicalFollowupStage("stage6").stage_number, 6);
  assert.equal(resolveCanonicalFollowupStage("s6").stage_number, 6);
});

test("evaluateFollowupCancellations batch", () => {
  const p1 = basePlan().plan;
  const p2 = basePlan({
    triggering_outbound_id: "out-x",
    delivery_event_id: "del-x",
  }).plan;
  const batch = evaluateFollowupCancellations({
    active_plans: [p1, p2],
    reason: CANCELLATION_REASONS.OPT_OUT,
    source_event_id: "stop",
  });
  assert.equal(batch.cancelled_count, 2);
});

test("resolveFollowupPolicy by use case stage 3", () => {
  const p = resolveFollowupPolicy({ outbound_use_case: "seller_asking_price" });
  assert.equal(p.ok, true);
  assert.equal(p.policy.stage_number, 3);
});

test("empty delivery_status ineligible", () => {
  assert.equal(basePlan({ delivery_status: "" }).ok, false);
});

test("missing delivery_status ineligible", () => {
  assert.equal(basePlan({ delivery_status: null }).ok, false);
});
