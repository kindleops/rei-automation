import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

// ─── ACCEPTANCE: 15-unit Miami multifamily (lane C, spine §6/G5–G8) ────────
// units_count=15, seller says "I want 1.5 million":
//   • monetary extraction records $1,500,000
//   • negotiation state records asking_price_per_unit = $100,000
//   • the resolver emits multifamily_price_per_unit with target/initial/max
//   • every generated offer amount ≤ maximum_acquisition_price
//   • a seller counter produces a bounded ladder step
//   • with NO ade_snapshot the same thread routes to human_review with
//     valuation_authority_absent

import { resolveAskingPriceSignal } from "@/lib/domain/seller-flow/monetary-understanding.js";
import { resolveNegotiationTurn } from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { NEGOTIATION_STRATEGIES as S } from "@/lib/domain/seller-flow/negotiation-strategy-router.js";
import {
  resolveValuationAuthority,
  VALUATION_METHODS,
} from "@/lib/domain/underwriting/valuation-authority.js";

// Plausible ADE V2 snapshot for a 15-unit Miami building (native 0–100 confidence).
const MIAMI_ADE = Object.freeze({
  valuation_low: 1_300_000,
  valuation_mid: 1_500_000,
  valuation_high: 1_650_000,
  valuation_confidence: 78,
  comp_count: 5,
  investor_ceiling_mid: 1_200_000,
  investor_ceiling_high: 1_280_000,
  buyer_demand_score: 60,
  liquidity_score: 58,
  estimated_repairs: 150_000,
  recommended_cash_offer: 1_050_000,
  minimum_acceptable_offer: 1_000_000,
  evidence: { engine: { name: "acquisition_decision_engine", version: "2.0.0" } },
});

const MIAMI_CONTEXT = Object.freeze({
  property_type: "Multifamily",
  property_type_scope: "multifamily",
  units_count: 15,
  market_name: "Miami",
});

// Sufficiency facts for a 5+ unit asset: occupancy + unit count + rents.
const MIAMI_FACTS = Object.freeze({
  occupancy_status: "tenant_occupied",
  unit_count: 15,
  rents_summary: "14 of 15 occupied, ~$1,450/mo average",
  asking_price: { value: 1_500_000, confidence: 0.9 },
});

function transitionFixture(overrides = {}) {
  return {
    stage_before: "offer",
    stage_before_number: 5,
    stage_after: "offer",
    stage_after_number: 5,
    advanced: false,
    review_required: false,
    contactability_patch: null,
    facts_patch: { ...MIAMI_FACTS },
    resolved_at: "2026-08-07T00:00:00.000Z",
    next_action: "generate_offer",
    ...overrides,
  };
}

const askSignal = resolveAskingPriceSignal("I want 1.5 million", {
  sourceMessageId: "msg-miami-1",
});

test("monetary extraction records $1,500,000 from 'I want 1.5 million'", () => {
  assert.equal(askSignal.asking_price?.value, 1_500_000);
  assert.equal(askSignal.needs_clarification, false);
});

test("resolver emits multifamily_price_per_unit with target/initial/maximum", () => {
  const authority = resolveValuationAuthority({
    property: { units_count: 15, property_type: "Multifamily" },
    ade_snapshot: MIAMI_ADE,
    facts: MIAMI_FACTS,
  });
  assert.equal(authority.valuation_method, VALUATION_METHODS.MULTIFAMILY_PRICE_PER_UNIT);
  assert.equal(authority.target_acquisition_price, 1_050_000);
  assert.equal(authority.initial_offer, 1_000_000);
  assert.equal(authority.maximum_acquisition_price, 1_200_000);
  assert.equal(authority.offer_confidence, 0.78);
  assert.equal(authority.units_count, 15);
  assert.equal(authority.estimated_value_per_unit, 100_000);
  assert.equal(authority.calculation_version, "ade_2.0.0/valuation_authority_1.0.0");
});

// Turn 1: the ask arrives with ADE authority present.
const turn1 = resolveNegotiationTurn({
  transition: transitionFixture(),
  priceSignal: askSignal,
  priorState: null,
  adeSnapshot: MIAMI_ADE,
  intent: "asking_price_value",
  classificationConfidence: 0.92,
  contextSummary: MIAMI_CONTEXT,
  sourceMessageId: "msg-miami-1",
  knownFacts: {},
  newFacts: MIAMI_FACTS,
});

test("state records the ask absolute AND per-unit ($100,000 across 15 units)", () => {
  assert.equal(turn1.state_preview.current_asking_price, 1_500_000);
  assert.equal(turn1.state_preview.units_count, 15);
  assert.equal(turn1.state_preview.asking_price_per_unit, 100_000);
});

test("turn 1 generates an authorized offer at or below the maximum", () => {
  const decision = turn1.strategy_decision;
  assert.ok(decision, "S5 turn must route a strategy");
  assert.ok(
    [S.CONDITIONAL_OFFER, S.INITIAL_OFFER].includes(decision.strategy),
    `expected an offer strategy, got ${decision.strategy}`
  );
  assert.equal(decision.monetary.amount, 1_050_000, "ADE recommended offer");
  assert.ok(decision.monetary.amount <= 1_200_000, "never above maximum_acquisition_price");
});

// Turn 2: seller counters down to $1.35M — a real concession.
const priorAfterOffer = {
  ...turn1.state_preview,
  offers_made: [{ amount: 1_050_000, strategy: S.CONDITIONAL_OFFER, queue_row_id: "q-miami-1" }],
  latest_offer: 1_050_000,
  initial_offer: 1_050_000,
};

const counterSignal = resolveAskingPriceSignal("I could do 1.35 million", {
  reference: 1_500_000,
  negotiationActive: true,
  sourceMessageId: "msg-miami-2",
});

const turn2 = resolveNegotiationTurn({
  transition: transitionFixture({ facts_patch: { ...MIAMI_FACTS, asking_price: { value: 1_350_000 } } }),
  priceSignal: counterSignal,
  priorState: priorAfterOffer,
  adeSnapshot: MIAMI_ADE,
  intent: "seller_counter",
  classificationConfidence: 0.9,
  contextSummary: MIAMI_CONTEXT,
  sourceMessageId: "msg-miami-2",
  knownFacts: MIAMI_FACTS,
  newFacts: {},
});

test("a seller counter produces a bounded ladder step, still under the ceiling", () => {
  assert.equal(counterSignal.asking_price?.value, 1_350_000);
  assert.equal(turn2.concession_inputs.seller_moved_amount, 150_000);
  assert.equal(turn2.strategy_decision.strategy, S.COUNTER_OFFER);
  const amount = turn2.strategy_decision.monetary.amount;
  assert.equal(amount, 1_125_000, "step = 50% of remaining floor→ceiling authority");
  assert.ok(amount > 1_050_000 && amount <= 1_200_000);
  assert.equal(turn2.state_preview.asking_price_per_unit, 90_000, "per-unit ask tracks the new ask");
});

test("every ledgered offer in the scenario stays within authority", () => {
  const withLedger = resolveNegotiationTurn({
    transition: transitionFixture(),
    priceSignal: counterSignal,
    priorState: priorAfterOffer,
    adeSnapshot: MIAMI_ADE,
    intent: "seller_counter",
    classificationConfidence: 0.9,
    contextSummary: MIAMI_CONTEXT,
    sourceMessageId: "msg-miami-2b",
    knownFacts: MIAMI_FACTS,
    newFacts: {},
  });
  for (const offer of withLedger.state_preview.offers_made) {
    if (offer.amount == null) continue;
    assert.ok(offer.amount <= 1_200_000, `offer ${offer.amount} must be ≤ maximum`);
  }
});

test("with NO ade_snapshot the same thread routes to human_review / valuation_authority_absent", () => {
  // Discovery exhausted: occupancy, units, rents AND condition are all known —
  // with no valuation authority left to discover around, the thread must land
  // with a human, never with a fabricated number. (While discovery facts are
  // still missing, the router correctly probes those first.)
  const factsComplete = {
    ...MIAMI_FACTS,
    condition_summary: "renovated 2019, roofs replaced",
    condition_disclosed: true,
  };
  const noAuthority = resolveNegotiationTurn({
    transition: transitionFixture({ facts_patch: factsComplete }),
    priceSignal: askSignal,
    priorState: null,
    adeSnapshot: null,
    intent: "asking_price_value",
    classificationConfidence: 0.92,
    contextSummary: MIAMI_CONTEXT,
    sourceMessageId: "msg-miami-3",
    knownFacts: {},
    newFacts: factsComplete,
  });
  assert.equal(noAuthority.zone.zone, "insufficient_confidence");
  assert.equal(noAuthority.zone.reason_code, "NO_PERSISTED_AUTHORITY");
  assert.equal(noAuthority.strategy_decision.strategy, S.HUMAN_REVIEW);
  assert.equal(noAuthority.strategy_decision.review_required, true);
  assert.equal(noAuthority.strategy_decision.review_reason, "valuation_authority_absent");
  assert.equal(noAuthority.strategy_decision.monetary, null, "no number is ever fabricated");

  const resolverView = resolveValuationAuthority({ property: { units_count: 15 }, ade_snapshot: null });
  assert.deepEqual(resolverView.reason_codes, ["valuation_authority_absent"]);
});
