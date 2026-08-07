import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveNegotiationTurn } from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { detectNewMaterialFact, MATERIAL_FACT_KEYS } from "@/lib/domain/seller-flow/negotiation-policy.js";
import { NEGOTIATION_STRATEGIES as S } from "@/lib/domain/seller-flow/negotiation-strategy-router.js";

// ADE-native snapshot (0–100 confidence — the production scale).
const ADE = Object.freeze({
  recommended_cash_offer: 80000,
  minimum_acceptable_offer: 70000,
  investor_ceiling_mid: 90000,
  investor_ceiling_high: 95000,
  valuation_mid: 130000,
  valuation_confidence: 80,
  estimated_repairs: 20000,
  comp_count: 5,
});

/** Prior turn: seller asked 160k, we made our 80k initial offer at S5. */
function priorStateFixture(overrides = {}) {
  return {
    version: "negotiation_state_v2",
    initial_asking_price: 160000,
    current_asking_price: 160000,
    asking_price_history: [
      { value: 160000, kind: "initial", at: "2026-08-01T00:00:00.000Z" },
    ],
    initial_offer: 80000,
    latest_offer: 80000,
    offers_made: [{ amount: 80000, strategy: S.INITIAL_OFFER, at: "2026-08-01T00:00:00.000Z" }],
    seller_counters: [],
    seller_concessions: [],
    recommended_offer: 80000,
    authorized_offer_floor: 70000,
    authorized_offer_ceiling: 90000,
    negotiation_round: 1,
    ...overrides,
  };
}

function transitionFixture(overrides = {}) {
  return {
    stage_before: "offer",
    stage_before_number: 5,
    stage_after: "offer",
    stage_after_number: 5,
    advanced: false,
    review_required: false,
    contactability_patch: null,
    facts_patch: {},
    resolved_at: "2026-08-07T00:00:00.000Z",
    next_action: "wait_for_seller",
    ...overrides,
  };
}

function priceSignal(value) {
  return {
    asking_price: {
      value,
      price_type: "exact",
      confidence: 0.9,
      extracted_text: `$${value}`,
      source_message_id: "msg-counter",
    },
    is_counter: true,
    needs_clarification: false,
  };
}

// ─── G7: seller movement unlocks the ladder ────────────────────────────────

test("G7: seller counters down $50k ⇒ ladder advances with a bounded counter-offer", () => {
  const negotiation = resolveNegotiationTurn({
    transition: transitionFixture(),
    priceSignal: priceSignal(110000), // 160k → 110k: −50k this turn
    priorState: priorStateFixture(),
    adeSnapshot: ADE,
    intent: "seller_counter",
    classificationConfidence: 0.9,
    contextSummary: {},
    sourceMessageId: "msg-counter",
  });

  assert.ok(negotiation?.strategy_decision, "negotiation turn must route at S5");
  assert.equal(negotiation.concession_inputs.seller_moved_amount, 50000);
  assert.equal(negotiation.strategy_decision.strategy, S.COUNTER_OFFER);
  const amount = negotiation.strategy_decision.monetary.amount;
  assert.ok(amount > 80000, "the ladder must actually advance past the prior offer");
  assert.ok(amount <= 90000, "never above the ADE ceiling");
  assert.equal(amount, 85000, "step is bounded to 50% of remaining authority");
});

test("G7: seller repeats the same number with no new facts ⇒ movement block preserved", () => {
  const negotiation = resolveNegotiationTurn({
    transition: transitionFixture(),
    priceSignal: priceSignal(110000), // same as current ask — no movement
    priorState: priorStateFixture({
      current_asking_price: 110000,
      asking_price_history: [
        { value: 160000, kind: "initial", at: "2026-08-01T00:00:00.000Z" },
        { value: 110000, kind: "counter", at: "2026-08-02T00:00:00.000Z" },
      ],
    }),
    adeSnapshot: ADE,
    intent: "seller_counter",
    classificationConfidence: 0.9,
    contextSummary: {},
    sourceMessageId: "msg-repeat",
    knownFacts: { occupancy_status: "vacant" },
    newFacts: { occupancy_status: "vacant" }, // repeating a known fact
  });

  assert.equal(negotiation.concession_inputs.seller_moved_amount, 0);
  assert.equal(negotiation.concession_inputs.new_material_fact, false);
  assert.notEqual(negotiation.strategy_decision.strategy, S.COUNTER_OFFER);
  assert.equal(
    negotiation.strategy_decision.monetary,
    null,
    "no qualifying movement or fact ⇒ no new monetary authority this turn"
  );
});

test("G7: a new material fact (condition disclosure) unlocks one qualifying step", () => {
  const negotiation = resolveNegotiationTurn({
    transition: transitionFixture({
      facts_patch: { condition_summary: "roof needs replacement", condition_disclosed: true },
    }),
    priceSignal: priceSignal(110000), // unchanged ask — fact is the qualifier
    priorState: priorStateFixture({
      current_asking_price: 110000,
      asking_price_history: [
        { value: 160000, kind: "initial", at: "2026-08-01T00:00:00.000Z" },
        { value: 110000, kind: "counter", at: "2026-08-02T00:00:00.000Z" },
      ],
    }),
    adeSnapshot: ADE,
    intent: "condition_disclosed",
    classificationConfidence: 0.9,
    contextSummary: {},
    sourceMessageId: "msg-condition",
    knownFacts: { occupancy_status: "vacant" },
    newFacts: { condition_summary: "roof needs replacement", condition_disclosed: true },
  });

  assert.equal(negotiation.concession_inputs.new_material_fact, true);
  assert.ok(negotiation.concession_inputs.new_material_fact_keys.includes("condition_summary"));
  assert.equal(negotiation.strategy_decision.strategy, S.COUNTER_OFFER);
  assert.equal(negotiation.strategy_decision.monetary.amount, 85000);
});

// ─── detectNewMaterialFact unit behavior ───────────────────────────────────

test("detectNewMaterialFact: only NEW disclosures qualify — repeats never re-qualify", () => {
  const fresh = detectNewMaterialFact({
    new_facts: { condition_summary: "Bad roof" },
    known_facts: {},
  });
  assert.equal(fresh.new_material_fact, true);

  const repeat = detectNewMaterialFact({
    new_facts: { condition_summary: "bad roof" },
    known_facts: { condition_summary: "Bad Roof" }, // case-insensitive repeat
  });
  assert.equal(repeat.new_material_fact, false);

  const changed = detectNewMaterialFact({
    new_facts: { occupancy_status: "vacant" },
    known_facts: { occupancy_status: "tenant_occupied" },
  });
  assert.equal(changed.new_material_fact, true);
});

test("detectNewMaterialFact: identity/contact facts never qualify the ladder", () => {
  assert.ok(!MATERIAL_FACT_KEYS.includes("ownership_status"));
  assert.ok(!MATERIAL_FACT_KEYS.includes("seller_email"));
  const identityOnly = detectNewMaterialFact({
    new_facts: { ownership_status: "confirmed", seller_email: "a@b.com" },
    known_facts: {},
  });
  assert.equal(identityOnly.new_material_fact, false);
});

test("detectNewMaterialFact: array facts qualify on new members only", () => {
  const newSignal = detectNewMaterialFact({
    new_facts: { motivation_signals: ["divorce", "relocation"] },
    known_facts: { motivation_signals: ["divorce"] },
  });
  assert.equal(newSignal.new_material_fact, true);

  const sameSignals = detectNewMaterialFact({
    new_facts: { motivation_signals: ["divorce"] },
    known_facts: { motivation_signals: ["divorce"] },
  });
  assert.equal(sameSignals.new_material_fact, false);
});
