import "../register-aliases.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { lookupSafetyPolicy, resolveSafetyTier, SELLER_FLOW_SAFETY_POLICY, SELLER_FLOW_SAFETY_TIERS } =
  await import("../../src/lib/domain/seller-flow/seller-flow-safety-policy.js");
const { SELLER_FLOW_STAGES } = await import(
  "../../src/lib/domain/seller-flow/canonical-seller-flow.js"
);
const { resolveStageAwareClarifier, stageCodeOrdinal } = await import(
  "../../src/lib/domain/seller-flow/coverage-net/stage-aware-clarifier.js"
);
const { resolveDeterministicStageTransition } = await import(
  "../../src/lib/domain/seller-flow/deterministic-stage-map.js"
);

test("safety policy table contains no legacy intent keys", () => {
  const legacy = ["asking_price_value", "condition_signal", "wrong_person"];
  for (const [stage, intents] of Object.entries(SELLER_FLOW_SAFETY_POLICY)) {
    for (const legacyKey of legacy) {
      assert.ok(!(legacyKey in intents), `policy[${stage}] must not contain legacy key ${legacyKey}`);
    }
  }
});

test("legacy intent aliases resolve to the same safety-policy entry as canonical", () => {
  const pairs = [
    [SELLER_FLOW_STAGES.ASKING_PRICE, "asking_price_value", "asking_price_provided"],
    [SELLER_FLOW_STAGES.ASKING_PRICE, "condition_signal", "condition_disclosed"],
    [SELLER_FLOW_STAGES.PRICE_WORKS_CONFIRM_BASICS, "condition_signal", "condition_disclosed"],
    [SELLER_FLOW_STAGES.OWNERSHIP_CHECK, "wrong_person", "wrong_number"],
    ["global", "wrong_person", "wrong_number"],
  ];
  for (const [stage, legacy, canonical] of pairs) {
    const viaLegacy = lookupSafetyPolicy(stage, legacy);
    const viaCanonical = lookupSafetyPolicy(stage, canonical);
    assert.deepStrictEqual(viaLegacy, viaCanonical, `${legacy} must equal ${canonical} at ${stage}`);
    assert.ok(viaCanonical, `canonical ${canonical} must resolve at ${stage}`);
  }
});

test("resolveSafetyTier is identical for alias and canonical intent", () => {
  for (const [legacy, canonical] of [
    ["asking_price_value", "asking_price_provided"],
    ["condition_signal", "condition_disclosed"],
    ["wrong_person", "wrong_number"],
  ]) {
    const a = resolveSafetyTier({ current_stage: SELLER_FLOW_STAGES.ASKING_PRICE, inbound_intent: legacy, should_queue_reply: true }, true);
    const b = resolveSafetyTier({ current_stage: SELLER_FLOW_STAGES.ASKING_PRICE, inbound_intent: canonical, should_queue_reply: true }, true);
    assert.equal(a, b, `safety tier must match for ${legacy} vs ${canonical}`);
  }
});

test("locked intents preserve their canonical safety behavior", () => {
  assert.equal(lookupSafetyPolicy("global", "opt_out").safety, SELLER_FLOW_SAFETY_TIERS.SUPPRESS);
  assert.equal(lookupSafetyPolicy("global", "wrong_person").next_stage, SELLER_FLOW_STAGES.TERMINAL);
  assert.equal(lookupSafetyPolicy("global", "wrong_number").next_stage, SELLER_FLOW_STAGES.TERMINAL);
  assert.equal(lookupSafetyPolicy("global", "hostile_or_legal").template, null);
  assert.equal(
    lookupSafetyPolicy(SELLER_FLOW_STAGES.OWNERSHIP_CHECK, "ownership_confirmed").next_stage,
    SELLER_FLOW_STAGES.CONSIDER_SELLING
  );
});

test("deterministic stage map normalizes legacy intent to canonical entry", () => {
  const legacy = resolveDeterministicStageTransition({ current_stage: SELLER_FLOW_STAGES.ASKING_PRICE, inbound_intent: "asking_price_value" });
  const canonical = resolveDeterministicStageTransition({ current_stage: SELLER_FLOW_STAGES.ASKING_PRICE, inbound_intent: "asking_price_provided" });
  assert.equal(legacy.next_stage, canonical.next_stage);
  assert.equal(legacy.template_use_case, canonical.template_use_case);
  assert.equal(legacy.safety_tier, canonical.safety_tier);
});

test("clarifier is stage-aware and never regresses below current stage", () => {
  const s1 = resolveStageAwareClarifier({ stage: "Ownership Confirmation", canonical_intent: "unclear", confidence: 0.5 });
  const s5 = resolveStageAwareClarifier({ stage: "Offer Positioning", canonical_intent: "unclear", confidence: 0.5 });
  assert.equal(s1.is_clarifier, true);
  assert.equal(s5.is_clarifier, true);
  assert.equal(s1.selected_stage_code, "S1");
  assert.equal(s5.selected_stage_code, "S5");
  assert.notEqual(s1.clarifier_text, s5.clarifier_text);
  assert.ok(stageCodeOrdinal(s5.selected_stage_code) >= 5);
  for (const f of [s1, s5]) {
    assert.ok("selected_use_case" in f);
    assert.ok("selected_stage_code" in f);
    assert.ok(f.template_selection_reason);
    assert.ok(f.fallback_path);
    assert.equal(typeof f.human_review_required, "boolean");
    assert.equal(f.no_send_reason, null);
    assert.ok(f.clarifier_text && f.clarifier_text.length > 0);
  }
});

test("clarifier preserves no-send for opt_out / wrong_number / hostile / not_interested", () => {
  const optOut = resolveStageAwareClarifier({ stage: "Seller Price Discovery", canonical_intent: "opt_out" });
  assert.equal(optOut.is_clarifier, false);
  assert.equal(optOut.no_send_reason, "opt_out_no_marketing");
  assert.equal(optOut.clarifier_text, null);
  const wrong = resolveStageAwareClarifier({ stage: "Offer Positioning", canonical_intent: "wrong_person" });
  assert.equal(wrong.is_clarifier, false);
  assert.equal(wrong.no_send_reason, "wrong_number_suppressed");
  const hostile = resolveStageAwareClarifier({ stage: "Negotiation", canonical_intent: "hostile_or_legal" });
  assert.equal(hostile.is_clarifier, false);
  assert.equal(hostile.no_send_reason, "hostile_or_legal_hold");
  assert.equal(hostile.human_review_required, true);
  assert.equal(hostile.clarifier_text, null);
  const notInterested = resolveStageAwareClarifier({ stage: "Negotiation", canonical_intent: "not_interested" });
  assert.equal(notInterested.is_clarifier, false);
  assert.equal(notInterested.no_send_reason, "not_interested_nurture_only");
});

test("confident routed intent defers to deterministic routing (not a clarifier)", () => {
  const r = resolveStageAwareClarifier({ stage: "Seller Price Discovery", canonical_intent: "asking_price_provided", confidence: 0.97 });
  assert.equal(r.is_clarifier, false);
  assert.equal(r.fallback_path, "deterministic_routing");
  const low = resolveStageAwareClarifier({ stage: "Seller Price Discovery", canonical_intent: "asking_price_provided", confidence: 0.5 });
  assert.equal(low.is_clarifier, true);
});
