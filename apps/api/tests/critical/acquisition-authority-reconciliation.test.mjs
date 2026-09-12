/**
 * ONE WORKFLOW DECISION, TWO CONSUMERS.
 *
 * The system had two independent interpretations of the same seller reply:
 *
 *   A. resolve-seller-stage-transition -> transition.stage_after
 *      -> persist-seller-transition -> acquisition_stage        (PERSISTENCE)
 *
 *   B. stage-domain-recommendation -> stage_decision
 *      -> authoritative_universal_stage + recommended_use_case  (TEMPLATE)
 *
 * They could disagree, and for James they did: persisted as S3 nurture while
 * the template layer still reached for an S4 condition probe. Both now read the
 * SAME canonical Stage-3 band, so a disagreement is a test failure rather than
 * a seller receiving the wrong message.
 *
 * Also pinned: an economic calculation can never fabricate seller acceptance.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { resolveAskingPriceSignal } from "@/lib/domain/seller-flow/monetary-understanding.js";
import {
  evaluateAskingPrice,
  classifyStage3AskingPrice,
  STAGE3_OFFER_BANDS,
  STAGE3_ROUTES,
} from "@/lib/domain/seller-flow/stage3-asking-price-engine.js";
import { LIFECYCLE_STAGE_ORDER } from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { extractUnderwritingSignals } from "@/lib/domain/underwriting/extract-underwriting-signals.js";

const UW = { recommended_cash_offer: 200_000, max_allowable_offer: 230_000, contract_ceiling: 250_000 };
const INTERESTED = { ownership_status: "confirmed", interest: "interested" };

const resolverFor = (ask, ade = UW) =>
  resolveSellerStageTransition({
    stage_before: "asking_price",
    known_facts: INTERESTED,
    new_facts: { asking_price: resolveAskingPriceSignal(`I want ${ask / 1000}k`)?.asking_price },
    intent: "price_provided",
    ade_result: { ...ade, sufficient_facts: true },
  });

const routeFor = (ask, context = {}) =>
  classifyStage3AskingPrice({ seller_asking_price: ask, underwriting: UW, context });

test("AUTO_ACCEPT presents an offer and never claims acceptance", () => {
  // ask <= recommended means "we can afford this", NOT "the seller agreed".
  const route = routeFor(195_000);
  assert.equal(route.offer_band, STAGE3_OFFER_BANDS.AUTO_ACCEPT);
  assert.equal(route.stage_code, "S5");
  assert.equal(route.template_use_case, "offer_reveal_cash");
  assert.notEqual(route.template_use_case, "asks_contract");
  assert.notEqual(route.stage_code, "S6");
  assert.equal(route.acquisition_action, "present_approved_cash_offer");

  const t = resolverFor(195_000);
  assert.equal(t.stage_after, "offer", "persistence agrees: offer, not formal_contract");
  assert.notEqual(t.stage_after, "formal_contract");
  assert.equal(t.lead_temperature, "hot");
  assert.notEqual(t.negotiation_patch?.terms_accepted, true, "economics cannot set terms_accepted");
});

test("VERY_WIDE_GAP routes to the STRATEGY LADDER on BOTH authorities", () => {
  // V2-3: a far-above-ceiling ask no longer drips straight to nurture. Cash
  // being infeasible is the trigger to evaluate creative and novation; nurture
  // is reachable only after the ladder exhausts every rung.
  const route = routeFor(500_000);
  assert.equal(route.offer_band, STAGE3_OFFER_BANDS.VERY_WIDE_GAP);
  assert.equal(route.route, "strategy_ladder");
  // The exhaustion flag lives on the canonical route object; the classifier
  // composes a subset of keys, so assert it where it is authoritative.
  assert.equal(STAGE3_ROUTES.VERY_WIDE_GAP_STRATEGY_LADDER.nurture_requires_ladder_exhaustion, true);
  assert.equal(route.template_use_case, "asking_price_follow_up");
  assert.notEqual(route.template_use_case, "price_high_condition_probe");

  const t = resolverFor(500_000);
  assert.equal(t.stage_after, "asking_price");
  assert.equal(t.lead_temperature, "cold");
  assert.equal(t.economic_gate.economic_fit, "out_of_band");
});

test("the two authorities agree on the band for every ask", () => {
  // The reconciliation invariant: both read the same canonical engine, so the
  // band the resolver acted on is the band the router acted on.
  for (const ask of [195_000, 220_000, 250_000, 300_000, 500_000]) {
    const fromRouter = routeFor(ask).offer_band;
    const fromResolver = resolverFor(ask).economic_gate?.offer_band;
    assert.equal(fromResolver, fromRouter, `band disagreement at ask ${ask}`);
  }
});

test("no band may route to a condition probe once economics are out of band", () => {
  const route = routeFor(500_000);
  assert.ok(!/condition/i.test(String(route.template_use_case)),
    `out-of-band must not select a condition template, got ${route.template_use_case}`);
  assert.ok(!/condition/i.test(String(route.next_stage)),
    `out-of-band must not enter a condition stage, got ${route.next_stage}`);
  assert.equal(route.route, "strategy_ladder");
});

test("CREATIVE requires an explicit seller signal, never a price gap", () => {
  // A large gap is not consent to seller finance, subject-to or novation.
  const withoutSignal = routeFor(300_000, { creative_allowed: false });
  assert.equal(withoutSignal.offer_band, STAGE3_OFFER_BANDS.WIDE_GAP);
  assert.notEqual(withoutSignal.template_use_case, "creative_probe");

  const withSignal = routeFor(300_000, { creative_allowed: true });
  assert.equal(withSignal.template_use_case, "creative_probe",
    "creative is reachable ONLY when the seller signalled interest");
});

test("milestone completeness survives the reconciliation", () => {
  const t = resolverFor(500_000);
  assert.equal(t.economic_gate.milestone_unresolved_idx, 3, "condition IS still the missing fact");
  assert.equal(t.economic_gate.workflow_stage_idx, 2, "but nurture is the active workflow");
  assert.equal(t.economic_gate.diverged, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// ONE ROUTE OBJECT, NOT TWO AGREEING MAPPINGS
// ═══════════════════════════════════════════════════════════════════════════

test("persisted stage and template purpose come from the SAME route instance", () => {
  // One ask per band, so no band can quietly skip the identity check.
  for (const ask of [195_000, 220_000, 250_000, 300_000, 500_000]) {
    const transition = resolverFor(ask);
    const recommendation = routeFor(ask);

    // Object identity, not deep equality. Two independently-built-but-equal
    // objects would pass a deepEqual and still be exactly the drift this
    // collapse removed.
    assert.ok(
      Object.is(transition.economic_gate.route, recommendation.canonical_route),
      `ask ${ask}: resolver and recommender must hold the same frozen route instance`,
    );

    // And the persisted stage is a LOOKUP off that route, never a parallel decision.
    assert.equal(transition.stage_after, transition.economic_gate.route.lifecycle_stage_code);
    assert.equal(transition.economic_gate.template_use_case, recommendation.template_use_case);
    assert.equal(transition.economic_gate.acquisition_action, recommendation.acquisition_action);
    assert.equal(transition.economic_gate.route_id, recommendation.route_id);
  }
});

test("the route table is frozen, so no consumer can mutate a shared decision", () => {
  assert.ok(Object.isFrozen(STAGE3_ROUTES.AUTO_ACCEPT_OFFER));
  assert.throws(() => {
    STAGE3_ROUTES.AUTO_ACCEPT_OFFER.stage_code = "S6";
  }, TypeError);
  assert.equal(STAGE3_ROUTES.AUTO_ACCEPT_OFFER.stage_code, "S5");
});

test("every route carries a lifecycle stage, so the lookup can never be a guess", () => {
  for (const [key, route] of Object.entries(STAGE3_ROUTES)) {
    assert.ok(route.route_id, `${key} must be identifiable`);
    assert.ok(route.lifecycle_stage_code, `${key} must map to a canonical lifecycle stage`);
    assert.ok(
      LIFECYCLE_STAGE_ORDER.includes(route.lifecycle_stage_code),
      `${key} stage must be canonical`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// WIDE_GAP: identical economics, different route — decided by the SELLER
// ═══════════════════════════════════════════════════════════════════════════

/** Drives the REAL signal extractor, so no test hand-sets a creative boolean. */
function wideGapTrace(message) {
  const price = resolveAskingPriceSignal(message);
  const signals = extractUnderwritingSignals({ message })?.signals || {};
  const transition = resolveSellerStageTransition({
    stage_before: "asking_price",
    known_facts: INTERESTED,
    new_facts: {
      asking_price: price?.asking_price,
      ...(signals.creative_terms_interest === true ? { creative_terms_interest: true } : {}),
      ...(signals.creative_strategy ? { creative_strategy: signals.creative_strategy } : {}),
    },
    intent: "price_provided",
    classification: { signals },
    ade_result: { ...UW, sufficient_facts: true },
  });
  return { signals, transition, gate: transition.economic_gate };
}

test("WIDE_GAP without a seller signal probes condition — never pitches terms", () => {
  const { signals, transition, gate } = wideGapTrace("I need 300k for it");

  assert.equal(signals.creative_terms_interest, false);
  assert.equal(gate.offer_band, STAGE3_OFFER_BANDS.WIDE_GAP);
  assert.equal(gate.economic_fit, "stretch");
  assert.equal(gate.creative_allowed, false);
  assert.equal(gate.route_id, "wide_gap_condition");
  assert.equal(transition.stage_after, "property_condition");
  assert.equal(gate.template_use_case, "price_high_condition_probe");
  assert.equal(gate.acquisition_action, "gather_condition_then_reveal");
  assert.equal(transition.lead_temperature, "warm");

  // The point of Ruling 3: a $70,000 gap is not consent to discuss terms.
  assert.notEqual(gate.template_use_case, "creative_probe");
  assert.notEqual(gate.acquisition_action, "propose_creative_finance");
});

test("WIDE_GAP with the seller's own creative signal switches message class", () => {
  const { signals, transition, gate } = wideGapTrace(
    "I need 300k, but I'd do owner financing with monthly payments",
  );

  assert.equal(signals.creative_terms_interest, true, "extracted from the seller's words");
  assert.equal(gate.creative_allowed, true);
  assert.equal(gate.route_id, "wide_gap_creative");
  assert.equal(transition.stage_after, "offer");
  assert.equal(gate.template_use_case, "creative_probe");
  assert.equal(gate.acquisition_action, "propose_creative_finance");
});

test("the two WIDE_GAP branches differ ONLY by the seller signal", () => {
  const silent = wideGapTrace("I need 300k for it");
  const signalled = wideGapTrace("I need 300k, but I'd do owner financing with monthly payments");

  // Same band, same arithmetic — so the price gap cannot be what moved it.
  assert.equal(silent.gate.offer_band, signalled.gate.offer_band);
  assert.equal(silent.gate.offer_gap_amount, signalled.gate.offer_gap_amount);
  assert.equal(silent.gate.economic_fit, signalled.gate.economic_fit);

  // Different route, and the only differing input is the seller's own words.
  assert.notEqual(silent.gate.route_id, signalled.gate.route_id);
});
