/**
 * THE ACQUISITION DECISION GATE, and what lead temperature means.
 *
 * firstUnresolvedIdx answers "which factual milestone is still missing?".
 * That is correct and still used. It does NOT answer "what should we do next",
 * and promoting it to workflow state produced this, verbatim from production:
 *
 *   James: "Half mil and its yours"   (we would pay $160,000)
 *     price resolved -> condition is the first unresolved milestone
 *     -> stage_after = property_condition, S3_TO_S4_PRICE_PROVIDED
 *     -> seller asked "is it vacant right now or occupied?"
 *     -> lead_temperature = warm, because afterIdx >= 2
 *
 * No amount of condition information bridges $340,000. The price question was
 * ANSWERED; the next useful act is nurture, not a probe.
 *
 * Two separations are pinned here:
 *   1. milestone completeness  !=  active workflow state
 *   2. engagement              !=  acquisition priority (temperature)
 *
 * No pricing thresholds live in the resolver or in the temperature rule. The
 * canonical Stage-3 engine (MAO x 1.15 / x 1.40) remains the only pricing
 * authority; both read its verdict.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { resolveAskingPriceSignal } from "@/lib/domain/seller-flow/monetary-understanding.js";

const INTERESTED = { ownership_status: "confirmed", interest: "interested" };
const UW = (recommended, mao) => ({
  recommended_cash_offer: recommended, max_allowable_offer: mao, sufficient_facts: true,
});

const priced = (msg, ade, facts = INTERESTED, stage = "asking_price") =>
  resolveSellerStageTransition({
    stage_before: stage,
    known_facts: facts,
    new_facts: { asking_price: resolveAskingPriceSignal(msg)?.asking_price },
    intent: "price_provided",
    ade_result: ade,
  });

test("JAMES: a price far above our number does NOT become property_condition", () => {
  const t = priced("Half mil and its yours", UW(160_000, 185_000));
  assert.equal(t.stage_after, "asking_price", "the price question is answered; condition is not the next act");
  assert.notEqual(t.stage_after, "property_condition");
  assert.equal(t.economic_gate.offer_band, "very_wide_gap");
  assert.equal(t.economic_gate.economic_fit, "out_of_band");
  assert.equal(t.lead_temperature, "cold", "responsiveness does not override economic reality");
});

test("LORRIE: a floor far above our number behaves identically", () => {
  const t = priced("Number has to start with a 4. Otherwise, nothing to talk about.", UW(200_000, 230_000));
  assert.equal(t.stage_after, "asking_price");
  assert.equal(t.economic_gate.offer_band, "very_wide_gap");
  assert.equal(t.lead_temperature, "cold");
});

test("the band decides the active stage across the whole range", () => {
  const ade = UW(200_000, 230_000);
  const at = (ask) => priced(`I want ${ask / 1000}k`, ade);
  assert.equal(at(195_000).stage_after, "offer", "at/below our number the next act is the OFFER");
  assert.equal(at(220_000).stage_after, "property_condition", "close range: condition can move the number");
  assert.equal(at(250_000).stage_after, "property_condition", "negotiable: condition can justify the gap");
  assert.equal(at(300_000).stage_after, "property_condition", "stretch: still worth qualifying");
  assert.equal(at(500_000).stage_after, "asking_price", "very wide: nurture, never a condition probe");
});

test("TEMPERATURE IS ACQUISITION PRIORITY, not engagement", () => {
  const ade = UW(200_000, 230_000);
  const at = (ask) => priced(`I want ${ask / 1000}k`, ade).lead_temperature;
  assert.equal(at(195_000), "hot", "executable now");
  assert.equal(at(220_000), "warm", "plausible, not yet executable");
  assert.equal(at(500_000), "cold", "engaged but economically dead");
});

test("a price existing is NOT sufficient for warm", () => {
  // The old rule was afterIdx >= 2 -> WARM, so any captured price warmed the
  // lead. "Sure, $2 million" on a $150,000 house was WARM.
  const t = priced("I'd need 2 million", UW(150_000, 172_000));
  assert.equal(t.lead_temperature, "cold");
  assert.equal(t.economic_gate.economic_fit, "out_of_band");
});

test("asks_offer supports WARM but can never independently create HOT", () => {
  const t = resolveSellerStageTransition({
    stage_before: "ownership_confirmation",
    known_facts: { ownership_status: "confirmed", wants_offer: true },
    intent: "asks_offer",
  });
  assert.equal(t.lead_temperature, "warm", "engaged, economics unknown");
  assert.notEqual(t.lead_temperature, "hot");
});

test("terms accepted is HOT regardless of band", () => {
  const t = resolveSellerStageTransition({
    stage_before: "offer",
    known_facts: INTERESTED,
    intent: "accepts_offer",
    ade_result: UW(200_000, 230_000),
    negotiation_state: { terms_accepted: true },
  });
  assert.equal(t.lead_temperature, "hot");
});

test("ownership confirmed with no interest established is COLD", () => {
  const t = resolveSellerStageTransition({
    stage_before: "ownership_confirmation",
    known_facts: { ownership_status: "confirmed" },
    intent: "ownership_confirmed",
  });
  assert.equal(t.stage_after, "offer_interest", "the fact advanced the milestone");
  assert.equal(t.lead_temperature, "cold", "no interest yet, so not actionable");
});

test("interest confirmed with no price is WARM", () => {
  const t = resolveSellerStageTransition({
    stage_before: "offer_interest", known_facts: INTERESTED, intent: "interested",
  });
  assert.equal(t.stage_after, "asking_price");
  assert.equal(t.lead_temperature, "warm", "live conversation, economics unknown");
});

test("MILESTONE COMPLETENESS IS PRESERVED, not destroyed", () => {
  // The gate changes the WORKFLOW stage only. The fact that condition is still
  // missing remains true and remains reported.
  const t = priced("Half mil and its yours", UW(160_000, 185_000));
  assert.equal(t.economic_gate.milestone_unresolved_idx, 3, "condition IS the next missing fact");
  assert.equal(t.economic_gate.workflow_stage_idx, 2, "but asking_price is the active workflow state");
  assert.equal(t.economic_gate.diverged, true);
});

test("with no underwriting the gate stays silent and nothing changes", () => {
  // The engine cannot speak without a recommended offer, so milestone
  // completeness stands exactly as it did before this change.
  const t = priced("I want 250k", null);
  assert.equal(t.economic_gate.applied, false);
  assert.equal(t.stage_after, "property_condition");
});
