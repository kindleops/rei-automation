import "../register-aliases.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { applyInboundAutomationDecision } = await import(
  "../../src/lib/domain/seller-flow/apply-inbound-automation-decision.js"
);
const { CANONICAL_INTENTS, normalizeCanonicalIntent, isSuppressionIntent } = await import(
  "../../src/lib/domain/seller-flow/coverage-net/canonical-intent-aliases.js"
);
const { CONTACT_IDENTITY_CLASSES } = await import(
  "../../src/lib/domain/inbox/contact-identity.js"
);
const { resolveExceptionWorkflow, exceptionSlaDeadline, EXCEPTION_WORKFLOWS } = await import(
  "../../src/lib/domain/seller-flow/coverage-net/exception-workflows.js"
);
const { buildSafeFallback, uncertaintyTypeForReason } = await import(
  "../../src/lib/domain/seller-flow/coverage-net/safe-fallback.js"
);
const { assessCoverage, isCovered, COVERAGE_STATES } = await import(
  "../../src/lib/domain/seller-flow/coverage-net/coverage-contract.js"
);

const STAGES = [
  "Ownership Confirmation",
  "Offer Interest Confirmation",
  "Seller Price Discovery",
  "Condition / Timeline Discovery",
  "Offer Positioning",
  "Negotiation",
];

function decide({ intent, identity = "probable_owner", confidence = 0.95, stage = "Ownership Confirmation" }) {
  const metadata = identity === "renter_occupant" ? { likely_renter: true } : {};
  return applyInboundAutomationDecision({
    message: `[synthetic ${intent}]`,
    threadKey: "+15550000000",
    propertyId: "prop_1",
    prospectId: null,
    ownerId: "owner_1",
    phoneId: "phone_1",
    classification: {
      primary_intent: intent,
      detected_intent: intent,
      confidence,
      stage_hint: stage,
      compliance_flag: intent === "opt_out" ? "stop_texting" : null,
      automation_decision: { auto_reply_allowed: confidence >= 0.85 },
      metadata,
    },
    latestThreadContext: {
      ids: { property_id: "prop_1", master_owner_id: "owner_1", phone_item_id: "phone_1" },
      summary: { conversation_stage: stage, property_type: "Single Family" },
    },
  });
}

// ── GATE 1: 100% coverage across the full Stage × Intent × Identity × band grid ──
test("no inbound combination resolves to missing_coverage (Stages 1–6)", () => {
  let checked = 0;
  let missing = 0;
  for (const stage of STAGES) {
    for (const intent of CANONICAL_INTENTS) {
      for (const identity of CONTACT_IDENTITY_CLASSES) {
        for (const confidence of [0.95, 0.6]) {
          const d = decide({ intent, identity, confidence, stage });
          checked += 1;
          if (!isCovered(d)) missing += 1;
          assert.ok(d.coverage_state !== COVERAGE_STATES.MISSING, `missing: ${stage}/${intent}/${identity}/${confidence}`);
          // Every decision MUST carry a scheduled next action (no dead end).
          assert.ok(String(d.scheduled_next_action || "").length > 0, `no scheduled_next_action: ${stage}/${intent}`);
          // Every decision MUST carry canonical intent + identity + safety status.
          assert.ok(d.canonical_intent, "canonical_intent missing");
          assert.ok(d.contact_identity, "contact_identity missing");
          assert.ok(d.safety_status, "safety_status missing");
        }
      }
    }
  }
  assert.equal(missing, 0, `expected 0 missing-coverage rows, got ${missing} of ${checked}`);
  assert.ok(checked >= 1500, "grid should be comprehensive");
});

// ── GATE 2: opt-out always suppresses, never replies ──
test("opt_out suppresses at every stage and never queues", () => {
  for (const stage of STAGES) {
    const d = decide({ intent: "opt_out", stage });
    assert.equal(d.should_suppress_contact, true);
    assert.equal(d.should_queue_reply, false);
    assert.equal(d.suppression_reason, "opt_out");
    assert.equal(d.coverage_state, COVERAGE_STATES.DIRECT);
  }
});

// ── GATE 3: wrong_number ≡ wrong_person unification ──
test("wrong_number and wrong_person both suppress (unified)", () => {
  const wn = decide({ intent: "wrong_number" });
  assert.equal(wn.should_suppress_contact, true);
  assert.equal(wn.should_queue_reply, false);
  assert.equal(wn.canonical_intent, "wrong_number");

  const wp = decide({ intent: "wrong_person" });
  assert.equal(wp.canonical_intent, "wrong_number", "wrong_person must canonicalize to wrong_number");
  assert.equal(wp.should_suppress_contact, true, "wrong_person must suppress like wrong_number");
  assert.equal(wp.should_queue_reply, false);

  assert.equal(normalizeCanonicalIntent("wrong_person"), "wrong_number");
  assert.ok(isSuppressionIntent("wrong_person") && isSuppressionIntent("wrong_number"));
});

// ── GATE 4: hostile/legal → owned safety workflow, no clarifier, no auto-send ──
test("hostile_or_legal routes to an owned safety workflow with no clarifier", () => {
  const d = decide({ intent: "hostile_or_legal" });
  assert.equal(d.should_queue_reply, false);
  assert.equal(d.should_mark_human_review, true);
  assert.equal(d.coverage_state, COVERAGE_STATES.HUMAN_EXCEPTION);
  assert.equal(d.safe_fallback, null, "must not prepare a clarifier for safety holds");
  assert.ok(d.exception_workflow?.key, "must have an owned workflow");
  assert.ok(d.exception_workflow?.owner, "workflow must have an owner");
  assert.ok(d.exception_workflow?.blocks_outreach, "safety hold must block outreach");
  assert.ok(d.exception_sla_deadline, "must have an SLA deadline");
});

// ── GATE 5: ambiguous unclear is never a dead end ──
test("unclear (low confidence) gets owned workflow + safe fallback + schedule, never a dead end", () => {
  const d = decide({ intent: "unclear", confidence: 0.55, stage: "Seller Price Discovery" });
  assert.notEqual(d.coverage_state, COVERAGE_STATES.MISSING);
  assert.ok(d.scheduled_next_action);
  assert.ok(d.exception_workflow?.key);
  assert.ok(d.exception_workflow?.owner);
  assert.ok(d.exception_sla_deadline);
  assert.ok(d.safe_fallback?.suggested_text, "must prepare a stage-aware clarifier");
  assert.equal(d.safe_fallback.makes_offer, false);
  assert.equal(d.safe_fallback.assumes_ownership, false);
});

// ── GATE 6: identity-aware routing — renter negativity ≠ confirmed-owner rejection ──
test("renter not_interested resolves renter identity, not confirmed owner", () => {
  const renter = decide({ intent: "not_interested", identity: "renter_occupant" });
  assert.equal(renter.contact_identity, "renter_occupant");
  // not_interested still does_not_reply but is owned + scheduled, not a dead end.
  assert.ok(renter.scheduled_next_action);
  assert.notEqual(renter.coverage_state, COVERAGE_STATES.MISSING);
});

// ── Unit: exception workflows always resolve with owner + SLA ──
test("resolveExceptionWorkflow always returns an owned, SLA-bound workflow", () => {
  for (const reason of [
    "opt_out", "wrong_number", "hostile_or_legal", "missing_context",
    "unclear", "property_correction", "language_unsupported", "duplicate",
    "some_unmapped_reason_xyz",
  ]) {
    const wf = resolveExceptionWorkflow(reason);
    assert.ok(wf?.key, `no workflow for ${reason}`);
    assert.ok(wf.owner, `no owner for ${reason}`);
    assert.ok(Number(wf.sla_ms) > 0, `no SLA for ${reason}`);
    assert.ok(Array.isArray(wf.allowed_actions) && wf.allowed_actions.length > 0);
    assert.ok(wf.fallback_action, `no fallback for ${reason}`);
    assert.ok(wf.terminal, `no terminal resolution for ${reason}`);
    const deadline = exceptionSlaDeadline(wf, new Date("2026-01-01T00:00:00Z"));
    assert.ok(deadline > "2026-01-01T00:00:00Z");
  }
  // unmapped reason falls back to ambiguous_context (still owned).
  assert.equal(resolveExceptionWorkflow("totally_unknown").key, EXCEPTION_WORKFLOWS.ambiguous_context.key);
});

// ── Unit: safe fallback is stage-aware (not one generic message) ──
test("safe fallback differs by stage and uncertainty type", () => {
  const s1 = buildSafeFallback({ stage: "Ownership Confirmation", uncertainty_type: "identity" });
  const s3 = buildSafeFallback({ stage: "Seller Price Discovery", uncertainty_type: "price" });
  const s6 = buildSafeFallback({ stage: "Negotiation", uncertainty_type: "contract" });
  assert.notEqual(s1.suggested_text, s3.suggested_text);
  assert.notEqual(s3.suggested_text, s6.suggested_text);
  for (const f of [s1, s3, s6]) {
    assert.equal(f.makes_offer, false);
    assert.equal(f.assumes_ownership, false);
    assert.equal(f.preserves_stage, true);
    assert.equal(f.reclassify_next_with_context, true);
    assert.ok(f.suggested_text.length > 0);
  }
  assert.equal(uncertaintyTypeForReason("identity_unclear", "who_is_this"), "identity");
  assert.equal(uncertaintyTypeForReason("price", "asking_price_provided"), "price");
});

// ── Unit: coverage contract oracle ──
test("assessCoverage flags a bare review with no workflow as missing", () => {
  assert.equal(
    assessCoverage({ should_mark_human_review: true, next_action: "mark_human_review" }),
    COVERAGE_STATES.MISSING
  );
  assert.equal(
    assessCoverage({ should_suppress_contact: true, next_action: "suppress_contact" }),
    COVERAGE_STATES.DIRECT
  );
});
