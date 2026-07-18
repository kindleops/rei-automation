// ─── acquisition-brain-authority-gate.test.mjs ─────────────────────────────
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  validateCanonicalE164,
  resolveCanonicalStageEvidence,
  evaluateClassifierCalibration,
  evaluateBrainAuthorityEligibility,
  resolveAuthorityWriter,
  buildBrainQueueIntent,
  resolveRollbackAction,
  evaluateShadowAuthorityDecision,
  resolveAcquisitionBrainMode,
  ACQUISITION_BRAIN_MODES,
  DEFAULT_ACQUISITION_BRAIN_MODE,
  AUTHORITY_WRITERS,
  REASON_CLASS,
  CLASSIFIER_CALIBRATION_VERSION,
  AUTHORITY_GATE_VERSION,
} from "@/lib/domain/acquisition-brain/authority-gate.js";
import { ACQUISITION_LIFECYCLE_STAGES as S } from "@/lib/domain/acquisition-brain/lifecycle-registry.js";

const CANARY = "+16128072000";
const AS_OF = "2026-07-18T15:00:00.000Z";

function fullEvidence(over = {}) {
  return {
    mode: ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE,
    thread_key: CANARY,
    is_internal_canary: true,
    is_public_seller: false,
    canonical_thread_resolution_status: "resolved",
    archived_alias: false,
    resolved_inbound_identity: CANARY,
    lifecycle_stage: S.OWNERSHIP_CHECK,
    stage_number: 1,
    primary_intent: "ownership_confirmed",
    language: "English",
    classifier_version: "classify.js",
    calibration_version: CLASSIFIER_CALIBRATION_VERSION,
    material_conflict: false,
    human_review_required: false,
    brain_plan_ok: true,
    opt_out: false,
    wrong_number: false,
    template_evidence: {
      template_id: "tpl-1",
      template_version: "v1",
      use_case: "ownership_check",
      active: true,
      language: "English",
      placeholder_validation: true,
      prohibited_term_validation: true,
      resolved_at: AS_OF,
    },
    suppression_evidence: {
      clear: true,
      canonical_thread: CANARY,
      lookup_source: "test",
      checked_at: AS_OF,
      policy_version: "v1",
      error_state: null,
    },
    contact_window_evidence: {
      timezone: "America/Chicago",
      timezone_source: "operational_fallback",
      final_planned_send_at: AS_OF,
      allowed: true,
      deferred: false,
      policy_version: "v1",
    },
    burst_evidence: {
      burst_id: "b1",
      burst_content_hash: "h1",
      status: "final_shadow",
      plan_status: "final_shadow",
      planner_version: "v2",
      superseded: false,
    },
    nba_evidence: {
      action: "request_asking_price",
      reason: "missing_price",
      lifecycle_stage: S.ASKING_PRICE,
      fact_state_version: "v1",
      confidence: 0.9,
      deterministic_resolver_version: "v1",
    },
    health_evidence: {
      emergency_stop: false,
      queue_healthy: true,
      provider_healthy: true,
      observability_healthy: true,
      checked_at: AS_OF,
      as_of: AS_OF,
      stale: false,
    },
    inbound_event_ids: ["in-1"],
    ...over,
  };
}

// 1–8 identity / stage
test("1 strict E.164 valid +16128072000", () => {
  assert.equal(validateCanonicalE164(CANARY).ok, true);
});

test("2 local 6128072000 rejected", () => {
  assert.equal(validateCanonicalE164("6128072000").ok, false);
});

test("3 +abc rejected", () => {
  assert.equal(validateCanonicalE164("+abc").ok, false);
});

test("4 spaces rejected", () => {
  assert.equal(validateCanonicalE164("+1 612 807 2000").ok, false);
});

test("5 malformed plus rejected", () => {
  assert.equal(validateCanonicalE164("++16128072000").ok, false);
});

test("6 archived alias rejected", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({ thread_key: "6128072000", archived_alias: true })
  );
  assert.equal(e.eligible, false);
  assert.ok(e.reasons.some((r) => r.includes("alias") || r.includes("e164") || r.includes("plus")));
});

test("7 e164_identity boolean cannot override malformed thread", () => {
  // Old API had e164_identity — must not accept
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({ thread_key: "not-valid", e164_identity: true })
  );
  assert.equal(e.e164.ok, false);
  assert.equal(e.eligible, false);
});

test("8 canonical-resolution mismatch rejected", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({
      resolved_inbound_identity: "+19999999999",
    })
  );
  assert.ok(e.reasons.includes("canonical_identity_mismatch"));
});

test("5b consistent Stage 1", () => {
  const s = resolveCanonicalStageEvidence({
    lifecycle_stage: "ownership_check",
    stage_number: 1,
  });
  assert.equal(s.ok, true);
  assert.equal(s.stage_number, 1);
});

test("6b consistent Stage 2", () => {
  assert.equal(
    resolveCanonicalStageEvidence({
      lifecycle_stage: "interest_proposal_confirmation",
      stage_number: 2,
    }).ok,
    true
  );
});

test("7b consistent Stage 3", () => {
  assert.equal(
    resolveCanonicalStageEvidence({
      lifecycle_stage: "asking_price",
      stage_number: 3,
    }).ok,
    true
  );
});

test("8b contradictory stage evidence", () => {
  const s = resolveCanonicalStageEvidence({
    lifecycle_stage: "property_condition",
    stage_number: 1,
  });
  assert.equal(s.ok, false);
  assert.equal(s.conflict, true);
});

test("9 Stage 4 blocked", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({ lifecycle_stage: S.PROPERTY_CONDITION, stage_number: 4 })
  );
  assert.ok(e.reasons.includes("stage_not_1_3"));
});

test("10 Stage 10 blocked", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({ lifecycle_stage: S.CLOSED, stage_number: 10 })
  );
  assert.ok(e.reasons.includes("stage_not_1_3"));
});

test("11 shadow mode uses legacy", async () => {
  const m = await resolveAcquisitionBrainMode({});
  assert.equal(m.mode, DEFAULT_ACQUISITION_BRAIN_MODE);
  const w = resolveAuthorityWriter({ mode: m.mode });
  assert.equal(w.writer, AUTHORITY_WRITERS.LEGACY);
  assert.equal(w.may_suppress_legacy, false);
});

// 12–15 terminal
test("12 terminal opt-out no action", () => {
  const w = resolveAuthorityWriter({ opt_out: true });
  assert.equal(w.writer, AUTHORITY_WRITERS.NO_ACTION);
  assert.equal(w.reason_class, REASON_CLASS.TERMINAL_NO_ACTION);
});

test("13 wrong number no action", () => {
  assert.equal(resolveAuthorityWriter({ wrong_number: true }).writer, AUTHORITY_WRITERS.NO_ACTION);
});

test("14 never-owned no action", () => {
  assert.equal(resolveAuthorityWriter({ never_owned: true }).writer, AUTHORITY_WRITERS.NO_ACTION);
});

test("15 sold-property no action", () => {
  assert.equal(resolveAuthorityWriter({ sold_property: true }).writer, AUTHORITY_WRITERS.NO_ACTION);
});

// 16–19 calibration / review
test("16 conflict human review under authoritative", () => {
  const el = evaluateBrainAuthorityEligibility(
    fullEvidence({ material_conflict: true })
  );
  const w = resolveAuthorityWriter({
    mode: ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE,
    eligibility: el,
    brain_plan_ok: true,
  });
  assert.equal(w.legacy_may_enqueue, false);
  assert.notEqual(w.writer, AUTHORITY_WRITERS.ACQUISITION_BRAIN);
});

test("17 uncalibrated classifier human review", () => {
  const c = evaluateClassifierCalibration({
    primary_intent: "ownership_confirmed",
  });
  assert.equal(c.intent_authority_eligible, false);
  assert.ok(c.reasons.includes("missing_calibration") || c.reasons.includes("intent_not_authority_eligible"));
});

test("18 stale calibration", () => {
  const c = evaluateClassifierCalibration({
    primary_intent: "ownership_confirmed",
    calibration_version: "old_v_xyz",
    calibration_registry: {
      version: CLASSIFIER_CALIBRATION_VERSION,
      authority_eligible_intents: [],
      languages_approved: [],
    },
  });
  assert.ok(c.reasons.includes("stale_calibration_version") || !c.intent_authority_eligible);
});

test("19 Spanish calibration missing", () => {
  const c = evaluateClassifierCalibration({
    primary_intent: "ownership_confirmed",
    language: "Spanish",
  });
  assert.ok(
    c.reasons.includes("spanish_calibration_missing") ||
      c.reasons.includes("missing_calibration")
  );
});

// 20–24 template / suppression
test("20 suppression blocked", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({
      suppression_evidence: {
        clear: false,
        checked_at: AS_OF,
        error_state: null,
      },
    })
  );
  assert.ok(e.reasons.includes("suppression_active"));
});

test("21 template missing", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({ template_evidence: null })
  );
  assert.ok(e.reasons.some((r) => r.includes("template")));
});

test("22 template inactive", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({
      template_evidence: {
        template_id: "t",
        template_version: "1",
        use_case: "x",
        active: false,
        placeholder_validation: true,
        prohibited_term_validation: true,
      },
    })
  );
  assert.ok(e.reasons.includes("template_inactive"));
});

test("23 unresolved placeholders", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({
      template_evidence: {
        template_id: "t",
        template_version: "1",
        use_case: "x",
        active: true,
        placeholder_validation: false,
        prohibited_term_validation: true,
      },
    })
  );
  assert.ok(e.reasons.includes("placeholders_unvalidated"));
});

test("24 prohibited template terms", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({
      template_evidence: {
        template_id: "t",
        template_version: "1",
        use_case: "x",
        active: true,
        placeholder_validation: true,
        prohibited_term_validation: false,
      },
    })
  );
  assert.ok(e.reasons.includes("prohibited_terms_unvalidated"));
});

// 25–27 burst / nba
test("25 provisional burst blocked", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({
      burst_evidence: {
        burst_id: "b",
        status: "collecting",
        provisional: true,
        superseded: false,
      },
    })
  );
  assert.ok(
    e.reasons.includes("provisional_burst_blocked") ||
      e.reasons.includes("burst_not_final")
  );
});

test("26 stale burst blocked", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({
      burst_evidence: {
        burst_id: "b",
        status: "final_shadow",
        superseded: true,
      },
    })
  );
  assert.ok(e.reasons.includes("stale_burst_blocked"));
});

test("27 missing NBA blocked", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({ nba_evidence: { action: null } })
  );
  assert.ok(e.reasons.includes("missing_canonical_nba"));
});

// 28–32 health
test("28 observability unhealthy", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({
      health_evidence: {
        emergency_stop: false,
        queue_healthy: true,
        provider_healthy: true,
        observability_healthy: false,
        checked_at: AS_OF,
        as_of: AS_OF,
      },
    })
  );
  assert.ok(e.reasons.includes("observability_unhealthy"));
});

test("29 queue unhealthy", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({
      health_evidence: {
        emergency_stop: false,
        queue_healthy: false,
        provider_healthy: true,
        observability_healthy: true,
        checked_at: AS_OF,
        as_of: AS_OF,
      },
    })
  );
  assert.ok(e.reasons.includes("queue_unhealthy"));
});

test("30 provider unhealthy", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({
      health_evidence: {
        emergency_stop: false,
        queue_healthy: true,
        provider_healthy: false,
        observability_healthy: true,
        checked_at: AS_OF,
        as_of: AS_OF,
      },
    })
  );
  assert.ok(e.reasons.includes("provider_unhealthy"));
});

test("31 stale health evidence", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({
      health_evidence: {
        emergency_stop: false,
        queue_healthy: true,
        provider_healthy: true,
        observability_healthy: true,
        checked_at: "2020-01-01T00:00:00.000Z",
        as_of: AS_OF,
        max_age_ms: 1000,
      },
    })
  );
  assert.ok(e.reasons.includes("stale_health_evidence"));
});

test("32 emergency stop", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({
      health_evidence: {
        emergency_stop: true,
        queue_healthy: true,
        provider_healthy: true,
        observability_healthy: true,
        checked_at: AS_OF,
        as_of: AS_OF,
      },
    })
  );
  assert.ok(e.reasons.includes("emergency_stop"));
});

test("33 active queue intent", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({ existing_active_queue_intent: true })
  );
  assert.ok(e.reasons.includes("active_queue_intent_exists"));
});

// 34–35 no legacy fallback
test("34 no legacy fallback after Brain selection path", () => {
  const el = evaluateBrainAuthorityEligibility(fullEvidence());
  // uncalibrated → not eligible
  assert.equal(el.eligible, false);
  const w = resolveAuthorityWriter({
    mode: ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE,
    eligibility: el,
    brain_plan_ok: true,
  });
  assert.equal(w.legacy_may_enqueue, false);
  assert.notEqual(w.writer, AUTHORITY_WRITERS.LEGACY);
});

test("35 Brain-plan failure human review", () => {
  const el = evaluateBrainAuthorityEligibility(fullEvidence());
  const w = resolveAuthorityWriter({
    mode: ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE,
    eligibility: { ...el, eligible: true, reasons: [] },
    brain_plan_ok: false,
    brain_failure: true,
  });
  assert.equal(w.legacy_may_enqueue, false);
  assert.ok(
    w.writer === AUTHORITY_WRITERS.HUMAN_REVIEW ||
      w.writer === AUTHORITY_WRITERS.BLOCKED
  );
});

// 36–41 queue intent
test("36 invalid queue-intent input returns no intent", () => {
  const r = buildBrainQueueIntent({ thread_key: CANARY });
  assert.equal(r.ok, false);
  assert.equal(r.queue_intent, null);
});

test("37 valid preview only with full authority decision", () => {
  const r = buildBrainQueueIntent({
    thread_key: CANARY,
    is_internal_canary: true,
    inbound_event_ids: ["a", "b"],
    burst_id: "burst1",
    burst_content_hash: "hash1",
    burst_version: "v1",
    lifecycle_stage: S.OWNERSHIP_CHECK,
    nba: "request_asking_price",
    template_id: "t1",
    template_version: "tv1",
    planned_send_at: AS_OF,
    authority_decision: {
      writer: AUTHORITY_WRITERS.ACQUISITION_BRAIN,
      mode: ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE,
      authority_decision_id: "dec-1",
    },
    authority_decision_id: "dec-1",
  });
  assert.equal(r.ok, true);
  assert.ok(r.queue_intent.idempotency_key);
  assert.equal(r.queue_intent.may_call_provider_directly, false);
});

test("38 duplicate webhook idempotency", () => {
  const input = {
    thread_key: CANARY,
    is_internal_canary: true,
    inbound_event_ids: ["z", "a"],
    burst_id: "b",
    burst_content_hash: "h",
    nba: "x",
    lifecycle_stage: "ownership_check",
    template_id: "t",
    template_version: "1",
    planned_send_at: AS_OF,
    authority_decision: {
      writer: AUTHORITY_WRITERS.ACQUISITION_BRAIN,
      mode: ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE,
      authority_decision_id: "d",
    },
    authority_decision_id: "d",
  };
  const a = buildBrainQueueIntent(input);
  const b = buildBrainQueueIntent({
    ...input,
    inbound_event_ids: ["a", "z"], // order independent after sort
  });
  assert.equal(a.queue_intent.idempotency_key, b.queue_intent.idempotency_key);
});

test("39 concurrent idempotency same key", () => {
  const input = {
    thread_key: CANARY,
    is_internal_canary: true,
    inbound_event_ids: ["1"],
    burst_id: "b",
    burst_content_hash: "h",
    nba: "x",
    lifecycle_stage: "ownership_check",
    template_id: "t",
    template_version: "1",
    planned_send_at: AS_OF,
    authority_decision: {
      writer: AUTHORITY_WRITERS.ACQUISITION_BRAIN,
      mode: ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE,
      authority_decision_id: "d",
    },
    authority_decision_id: "d",
  };
  assert.equal(
    buildBrainQueueIntent(input).queue_intent.idempotency_key,
    buildBrainQueueIntent(input).queue_intent.idempotency_key
  );
});

test("40 changed template version changes key", () => {
  const base = {
    thread_key: CANARY,
    is_internal_canary: true,
    inbound_event_ids: ["1"],
    burst_id: "b",
    burst_content_hash: "h",
    nba: "x",
    lifecycle_stage: "ownership_check",
    template_id: "t",
    template_version: "1",
    planned_send_at: AS_OF,
    authority_decision: {
      writer: AUTHORITY_WRITERS.ACQUISITION_BRAIN,
      mode: ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE,
      authority_decision_id: "d",
    },
    authority_decision_id: "d",
  };
  const a = buildBrainQueueIntent(base);
  const b = buildBrainQueueIntent({ ...base, template_version: "2" });
  assert.notEqual(a.queue_intent.idempotency_key, b.queue_intent.idempotency_key);
});

test("41 changed burst changes key", () => {
  const base = {
    thread_key: CANARY,
    is_internal_canary: true,
    inbound_event_ids: ["1"],
    burst_id: "b1",
    burst_content_hash: "h1",
    nba: "x",
    lifecycle_stage: "ownership_check",
    template_id: "t",
    template_version: "1",
    planned_send_at: AS_OF,
    authority_decision: {
      writer: AUTHORITY_WRITERS.ACQUISITION_BRAIN,
      mode: ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE,
      authority_decision_id: "d",
    },
    authority_decision_id: "d",
  };
  const a = buildBrainQueueIntent(base);
  const b = buildBrainQueueIntent({ ...base, burst_content_hash: "h2" });
  assert.notEqual(a.queue_intent.idempotency_key, b.queue_intent.idempotency_key);
});

test("42 rollback event contract", () => {
  const r = resolveRollbackAction({
    trigger: "queue_backlog_threshold",
    current_mode: ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE,
    thread_key: CANARY,
    as_of: AS_OF,
  });
  assert.equal(r.transport_blocked_immediately, true);
  assert.equal(r.production_mode_mutated, false);
  assert.equal(r.may_send, false);
  assert.ok(r.rollback_event_type);
});

test("43 live shadow event dedupe stable", () => {
  const a = evaluateShadowAuthorityDecision(fullEvidence({ mode: DEFAULT_ACQUISITION_BRAIN_MODE }));
  const b = evaluateShadowAuthorityDecision(fullEvidence({ mode: DEFAULT_ACQUISITION_BRAIN_MODE }));
  assert.equal(a.event.dedupe_key, b.event.dedupe_key);
  assert.equal(a.decision.proposed_writer, AUTHORITY_WRITERS.LEGACY);
  assert.equal(a.may_enqueue, false);
  assert.equal(a.may_suppress_legacy, false);
});

test("44 event persistence failure shape fail-open", async () => {
  const { emitShadowAuthorityDecision } = await import(
    "@/lib/domain/acquisition-brain/authority-gate.js"
  );
  const r = evaluateShadowAuthorityDecision(fullEvidence());
  const out = await emitShadowAuthorityDecision(r, {
    emitAutomationEvent: async () => {
      throw new Error("db");
    },
  });
  assert.equal(out.ok, false);
});

test("45–48 zero transport flags", () => {
  const r = evaluateShadowAuthorityDecision(fullEvidence());
  assert.equal(r.may_enqueue, false);
  assert.equal(r.may_send, false);
  assert.equal(r.decision.may_suppress_legacy, false);
  assert.equal(r.decision.legacy_remains_authoritative, true);
});

test("49 public seller blocked", () => {
  const e = evaluateBrainAuthorityEligibility(
    fullEvidence({ is_public_seller: true })
  );
  assert.ok(e.reasons.includes("public_seller"));
});

test("50 default mode internal_shadow", async () => {
  const m = await resolveAcquisitionBrainMode({});
  assert.equal(m.mode, "internal_shadow");
  assert.equal(AUTHORITY_GATE_VERSION.startsWith("acquisition_brain_authority_gate"), true);
});

test("Brain eligible count zero under v0 calibration", () => {
  // Even with full evidence, calibration v0 blocks Brain writer
  const el = evaluateBrainAuthorityEligibility(fullEvidence());
  assert.equal(el.eligible, false);
  assert.ok(el.calibration.intent_authority_eligible === false);
});
