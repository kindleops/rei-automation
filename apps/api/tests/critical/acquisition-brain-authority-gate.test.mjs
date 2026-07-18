// ─── acquisition-brain-authority-gate.test.mjs ─────────────────────────────
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveAcquisitionBrainMode,
  evaluateBrainAuthorityEligibility,
  resolveAuthorityWriter,
  buildBrainQueueIntent,
  resolveRollbackAction,
  ACQUISITION_BRAIN_MODES,
  DEFAULT_ACQUISITION_BRAIN_MODE,
  AUTHORITY_WRITERS,
} from "@/lib/domain/acquisition-brain/authority-gate.js";

const CANARY = "+16128072000";

function baseEligible(over = {}) {
  return {
    mode: ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE,
    thread_key: CANARY,
    is_internal_canary: true,
    is_public_seller: false,
    lifecycle_stage: "ownership_check",
    classification_confidence: 0.95,
    material_conflict: false,
    human_review_required: false,
    template_exists: true,
    template_active: true,
    suppression_clear: true,
    contact_window_ok: true,
    e164_identity: true,
    final_burst_plan: true,
    canonical_nba: true,
    existing_active_queue_intent: false,
    emergency_stop: false,
    opt_out: false,
    wrong_number: false,
    ...over,
  };
}

test("default shadow mode", async () => {
  const m = await resolveAcquisitionBrainMode({});
  assert.equal(m.mode, DEFAULT_ACQUISITION_BRAIN_MODE);
  assert.equal(m.mode, "internal_shadow");
});

test("canary eligibility when all gates pass", () => {
  const e = evaluateBrainAuthorityEligibility(baseEligible());
  assert.equal(e.eligible, true);
});

test("public thread blocked", () => {
  const e = evaluateBrainAuthorityEligibility(
    baseEligible({ is_public_seller: true })
  );
  assert.equal(e.eligible, false);
  assert.ok(e.reasons.includes("public_seller"));
});

test("Stage 4 blocked", () => {
  const e = evaluateBrainAuthorityEligibility(
    baseEligible({ lifecycle_stage: "property_condition", stage_number: 4 })
  );
  assert.equal(e.eligible, false);
  assert.ok(e.reasons.includes("stage_not_1_3"));
});

test("conflict blocked", () => {
  assert.equal(
    evaluateBrainAuthorityEligibility(baseEligible({ material_conflict: true }))
      .eligible,
    false
  );
});

test("review required", () => {
  assert.equal(
    evaluateBrainAuthorityEligibility(
      baseEligible({ human_review_required: true })
    ).eligible,
    false
  );
});

test("opt-out blocked", () => {
  assert.equal(
    evaluateBrainAuthorityEligibility(baseEligible({ opt_out: true })).eligible,
    false
  );
});

test("wrong number blocked", () => {
  assert.equal(
    evaluateBrainAuthorityEligibility(baseEligible({ wrong_number: true }))
      .eligible,
    false
  );
});

test("suppression blocked", () => {
  assert.equal(
    evaluateBrainAuthorityEligibility(
      baseEligible({ suppression_clear: false })
    ).eligible,
    false
  );
});

test("template unavailable", () => {
  assert.equal(
    evaluateBrainAuthorityEligibility(
      baseEligible({ template_exists: false })
    ).eligible,
    false
  );
});

test("contact-window deferral allowed", () => {
  const e = evaluateBrainAuthorityEligibility(
    baseEligible({ contact_window_ok: false, contact_window_deferred: true })
  );
  assert.equal(e.eligible, true);
});

test("emergency stop", () => {
  assert.equal(
    evaluateBrainAuthorityEligibility(baseEligible({ emergency_stop: true }))
      .eligible,
    false
  );
});

test("shadow mode writer is legacy", () => {
  const w = resolveAuthorityWriter({
    mode: ACQUISITION_BRAIN_MODES.INTERNAL_SHADOW,
  });
  assert.equal(w.writer, AUTHORITY_WRITERS.LEGACY);
  assert.equal(w.brain_may_enqueue, false);
});

test("brain selected suppresses legacy enqueue", () => {
  const el = evaluateBrainAuthorityEligibility(baseEligible());
  const w = resolveAuthorityWriter({
    mode: ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE,
    eligibility: el,
    brain_plan_ok: true,
  });
  assert.equal(w.writer, AUTHORITY_WRITERS.ACQUISITION_BRAIN);
  assert.equal(w.legacy_may_enqueue, false);
  assert.equal(w.brain_may_enqueue, true);
  assert.equal(w.max_queue_intents, 1);
});

test("brain failure does not trigger legacy duplicate", () => {
  const el = evaluateBrainAuthorityEligibility(baseEligible());
  const w = resolveAuthorityWriter({
    mode: ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE,
    eligibility: el,
    brain_plan_ok: true,
    brain_failure: true,
  });
  assert.equal(w.writer, AUTHORITY_WRITERS.HUMAN_REVIEW);
  assert.equal(w.legacy_may_enqueue, false);
  assert.equal(w.brain_may_enqueue, false);
});

test("queue intent idempotency key stable", () => {
  const a = buildBrainQueueIntent({
    thread_key: CANARY,
    burst_id: "b1",
    burst_version: "v1",
    nba: "request_asking_price",
    template_id: "t1",
    planned_send_at: "2026-07-18T16:00:00.000Z",
  });
  const b = buildBrainQueueIntent({
    thread_key: CANARY,
    burst_id: "b1",
    burst_version: "v1",
    nba: "request_asking_price",
    template_id: "t1",
    planned_send_at: "2026-07-18T16:00:00.000Z",
  });
  assert.equal(a.idempotency_key, b.idempotency_key);
  assert.equal(a.may_call_provider_directly, false);
});

test("archived alias not e164 fails eligibility", () => {
  const e = evaluateBrainAuthorityEligibility(
    baseEligible({ thread_key: "6128072000", e164_identity: false })
  );
  assert.equal(e.eligible, false);
});

test("rollback to shadow on queue backlog", () => {
  const r = resolveRollbackAction("queue_backlog_threshold");
  assert.equal(r.action, "internal_shadow");
  assert.equal(r.may_send, false);
});

test("rollback to human_review on opt-out violation", () => {
  const r = resolveRollbackAction("opt_out_violation");
  assert.equal(r.action, "human_review");
  assert.equal(r.may_send, false);
});

test("zero direct provider calls contract", () => {
  const qi = buildBrainQueueIntent({ thread_key: CANARY });
  assert.equal(qi.may_call_provider_directly, false);
  assert.equal(qi.transport, "compliant_queue_processor_only");
});

test("duplicate active queue intent blocks", () => {
  assert.equal(
    evaluateBrainAuthorityEligibility(
      baseEligible({ existing_active_queue_intent: true })
    ).eligible,
    false
  );
});

test("confidence below threshold blocked", () => {
  assert.equal(
    evaluateBrainAuthorityEligibility(
      baseEligible({ classification_confidence: 0.5 })
    ).eligible,
    false
  );
});
