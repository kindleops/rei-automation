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
} from "@/lib/domain/seller-flow/stage3-asking-price-engine.js";

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

test("VERY_WIDE_GAP nurtures on BOTH authorities", () => {
  const route = routeFor(500_000);
  assert.equal(route.offer_band, STAGE3_OFFER_BANDS.VERY_WIDE_GAP);
  assert.equal(route.route, "nurture");
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
  assert.equal(route.route, "nurture");
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
