// Hold-turn stage authority (activation-hardening item 3).
//
// Eliminates the 10 automated-but-wrong-stage cells: on a NON-advancing turn a
// fact-redundant intent (re-confirmation / duplicate) now receives the
// resolver's stage question (next missing fact) instead of the stage-blind
// intent-profile route. Lateral intents keep conversational routing; review /
// contactability / V2-withhold guards unchanged.

import test from "node:test";
import assert from "node:assert/strict";

import { resolveTransitionDirective } from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";

const holdTransition = (overrides = {}) => ({
  advanced: false,
  review_required: false,
  contactability_patch: null,
  required_template_use_case: "seller_asking_price",
  stage_after: "asking_price",
  reasoning_code: "S3_HOLD",
  ...overrides,
});

// ── directive eligibility ──────────────────────────────────────────────────
test("hold directive fires for fact-redundant intents and carries the stage question", () => {
  for (const intent of [
    "ownership_confirmed",
    "seller_interested",
    "latent_interest",
    "asks_offer",
    "asking_price_provided",
    "condition_disclosed",
  ]) {
    const d = resolveTransitionDirective({
      transition: holdTransition(),
      turn_intent: intent,
    });
    assert.ok(d, `directive must fire on hold for ${intent}`);
    assert.equal(d.required_template_use_case, "seller_asking_price");
    assert.equal(d.stage_after, "asking_price");
  }
});

test("lateral/conversational intents keep conversational routing on holds", () => {
  for (const intent of [
    "who_is_this",
    "callback_requested",
    "info_request",
    "requests_email",
    "language_switch",
    "unclear",
    "not_interested",
  ]) {
    assert.equal(
      resolveTransitionDirective({ transition: holdTransition(), turn_intent: intent }),
      null,
      `no hold directive for lateral intent ${intent}`
    );
  }
});

test("advancing turns keep the directive exactly as before", () => {
  const d = resolveTransitionDirective({
    transition: holdTransition({ advanced: true, required_template_use_case: "condition_probe", stage_after: "property_condition" }),
    turn_intent: "who_is_this", // intent irrelevant when advanced
  });
  assert.ok(d);
  assert.equal(d.required_template_use_case, "condition_probe");
});

test("review / contactability / V2-withhold guards still drop the directive", () => {
  const base = { transition: holdTransition(), turn_intent: "ownership_confirmed" };
  assert.equal(
    resolveTransitionDirective({ ...base, transition: holdTransition({ review_required: true }) }),
    null
  );
  assert.equal(
    resolveTransitionDirective({ ...base, transition: holdTransition({ contactability_patch: { contactability_status: "do_not_text" } }) }),
    null
  );
  assert.equal(resolveTransitionDirective({ ...base, v2_withholds_reply: true }), null);
  assert.equal(resolveTransitionDirective({ transition: null, turn_intent: "ownership_confirmed" }), null);
});

test("V2 response strategy keeps precedence over the resolver template", () => {
  const d = resolveTransitionDirective({
    transition: holdTransition(),
    turn_intent: "seller_interested",
    response_strategy: { template_use_case: "condition_probe", reason_code: "discover_condition" },
  });
  assert.equal(d.required_template_use_case, "condition_probe");
  assert.equal(d.reasoning_code, "discover_condition");
});

// ── the audited wrong-stage cells, end-to-end through the REAL resolver ────
// Each case: facts already known → hold turn → the resolver's stage question
// (not the intent profile's stage-earlier question) is what the directive carries.
test("ownership re-confirmed at S3 asks the price question, not the S2 interest question", () => {
  const transition = resolveSellerStageTransition({
    stage_before: "asking_price",
    intent: "ownership_confirmed",
    known_facts: {
      ownership_status: "confirmed",
      interest_status: "interested",
    },
    new_facts: {},
    confidence: 0.9,
  });
  assert.equal(transition.advanced, false);
  const d = resolveTransitionDirective({ transition, turn_intent: "ownership_confirmed" });
  assert.ok(d, "hold directive must fire");
  assert.equal(d.required_template_use_case, "seller_asking_price");
});

test("interest re-expressed at S4 asks the condition question, never re-asks the KNOWN price", () => {
  const transition = resolveSellerStageTransition({
    stage_before: "property_condition",
    intent: "seller_interested",
    known_facts: {
      ownership_status: "confirmed",
      interest_status: "interested",
      asking_price: { value: 250000, currency: "USD" },
    },
    new_facts: {},
    confidence: 0.9,
  });
  assert.equal(transition.advanced, false);
  const d = resolveTransitionDirective({ transition, turn_intent: "seller_interested" });
  assert.ok(d);
  assert.equal(d.required_template_use_case, "condition_probe");
  assert.notEqual(d.required_template_use_case, "seller_asking_price");
});

test('"make me an offer" held at S3 probes condition instead of re-asking the declined price', () => {
  const transition = resolveSellerStageTransition({
    stage_before: "asking_price",
    intent: "asks_offer",
    known_facts: {
      ownership_status: "confirmed",
      interest_status: "interested",
      wants_offer: true,
    },
    new_facts: {},
    confidence: 0.9,
  });
  const d = resolveTransitionDirective({ transition, turn_intent: "asks_offer" });
  assert.ok(d);
  assert.equal(d.required_template_use_case, "condition_probe");
});

test("condition disclosed at S1 asks the ownership question first", () => {
  const transition = resolveSellerStageTransition({
    stage_before: "ownership_confirmation",
    intent: "condition_disclosed",
    known_facts: {},
    new_facts: { property_condition: { summary: "needs a new roof" } },
    confidence: 0.9,
  });
  assert.equal(transition.advanced, false);
  const d = resolveTransitionDirective({ transition, turn_intent: "condition_disclosed" });
  assert.ok(d);
  assert.equal(d.required_template_use_case, "ownership_check");
});
