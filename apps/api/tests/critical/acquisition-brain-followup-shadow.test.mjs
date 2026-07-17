// ─── acquisition-brain-followup-shadow.test.mjs ────────────────────────────
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  planShadowFollowup,
  cancelShadowFollowup,
  proveStage1FollowupShadow,
  resolveFollowupPolicy,
  FOLLOWUP_POLICY_REGISTRY,
  SHADOW_FOLLOWUP_EVENT,
} from "@/lib/domain/acquisition-brain/shadow-followup-planner.js";

const THREAD = "+16128072000";
const DELIVERED = "2026-07-10T15:00:00.000Z";

test("registry has stage 1–6 policies", () => {
  assert.ok(FOLLOWUP_POLICY_REGISTRY.stage1_ownership_no_reply);
  assert.ok(FOLLOWUP_POLICY_REGISTRY.stage2_interest_no_reply);
  assert.equal(
    FOLLOWUP_POLICY_REGISTRY.stage1_ownership_no_reply.delay_ms,
    3 * 24 * 60 * 60_000
  );
});

test("delivered-only eligibility", () => {
  const bad = planShadowFollowup({
    thread_key: THREAD,
    delivery_status: "failed",
    delivery_event_id: "d1",
    outbound_use_case: "ownership_check",
    delivered_at: DELIVERED,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "delivery_not_authoritative");
});

test("Stage 1 creates one 3-day shadow follow-up", () => {
  const r = planShadowFollowup({
    thread_key: THREAD,
    triggering_outbound_id: "out-1",
    delivery_event_id: "del-1",
    delivery_status: "delivered",
    stage: "ownership_check",
    outbound_use_case: "ownership_check",
    delivered_at: DELIVERED,
  });
  assert.equal(r.ok, true);
  assert.equal(r.plan.policy_id, "stage1_ownership_no_reply");
  assert.equal(r.plan.delay_ms, 3 * 24 * 60 * 60_000);
  assert.equal(r.may_enqueue, false);
  assert.equal(r.may_send, false);
  assert.equal(r.event.event_type, SHADOW_FOLLOWUP_EVENT);
});

test("duplicate active follow-up rejected", () => {
  const first = planShadowFollowup({
    thread_key: THREAD,
    triggering_outbound_id: "out-1",
    delivery_event_id: "del-1",
    delivery_status: "delivered",
    outbound_use_case: "ownership_check",
    delivered_at: DELIVERED,
  });
  const second = planShadowFollowup({
    thread_key: THREAD,
    triggering_outbound_id: "out-2",
    delivery_event_id: "del-2",
    delivery_status: "delivered",
    outbound_use_case: "ownership_check",
    delivered_at: DELIVERED,
    active_followups: [first.plan],
  });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "active_followup_exists");
});

test("inbound cancels pending no-reply follow-up", () => {
  const created = planShadowFollowup({
    thread_key: THREAD,
    triggering_outbound_id: "out-1",
    delivery_event_id: "del-1",
    delivery_status: "delivered",
    outbound_use_case: "ownership_check",
    delivered_at: DELIVERED,
  });
  const cancelled = cancelShadowFollowup({
    plan: created.plan,
    reason: "inbound_reply",
    source_event_id: "in-1",
  });
  assert.equal(cancelled.plan.cancellation_state, "cancelled");
  assert.equal(cancelled.plan.cancellation_reason, "inbound_reply");
  assert.equal(cancelled.plan.may_send, false);
});

test("opt-out / wrong-number cancellation", () => {
  const created = planShadowFollowup({
    thread_key: THREAD,
    triggering_outbound_id: "out-1",
    delivery_event_id: "del-1",
    delivery_status: "delivered",
    outbound_use_case: "ownership_check",
    delivered_at: DELIVERED,
  });
  for (const reason of ["opt_out", "wrong_number"]) {
    const c = cancelShadowFollowup({
      plan: created.plan,
      reason,
      source_event_id: "x",
    });
    assert.equal(c.plan.cancellation_reason, reason);
  }
});

test("archived alias cannot receive follow-up", () => {
  const r = planShadowFollowup({
    thread_key: "6128072000",
    delivery_event_id: "d",
    delivery_status: "delivered",
    outbound_use_case: "ownership_check",
    delivered_at: DELIVERED,
  });
  assert.equal(r.ok, false);
});

test("duplicate delivery webhook same dedupe key", () => {
  const a = planShadowFollowup({
    thread_key: THREAD,
    triggering_outbound_id: "out-1",
    delivery_event_id: "del-same",
    delivery_status: "delivered",
    outbound_use_case: "ownership_check",
    delivered_at: DELIVERED,
  });
  const b = planShadowFollowup({
    thread_key: THREAD,
    triggering_outbound_id: "out-1",
    delivery_event_id: "del-same",
    delivery_status: "delivered",
    outbound_use_case: "ownership_check",
    delivered_at: DELIVERED,
  });
  assert.equal(a.event.dedupe_key, b.event.dedupe_key);
});

test("prove Stage 1 gap: delivery would create follow-up; inbound cancels", () => {
  const proof = proveStage1FollowupShadow({
    thread_key: THREAD,
    outbound_id: "canary-out-1",
    delivery_event_id: "canary-del-1",
    delivered_at: DELIVERED,
    inbound_event_id: "canary-in-1",
    inbound_at: "2026-07-11T12:00:00.000Z",
  });
  assert.equal(proof.ok, true);
  assert.equal(proof.would_create_followup, true);
  assert.equal(proof.followup_count, 1);
  assert.equal(proof.cancelled_before_transport, true);
  assert.equal(proof.production_followup_created, false);
  assert.equal(proof.may_send, false);
});

test("resolveFollowupPolicy by use case", () => {
  const p = resolveFollowupPolicy({ outbound_use_case: "seller_asking_price" });
  assert.equal(p.policy_id, "stage3_asking_price_no_reply");
});
