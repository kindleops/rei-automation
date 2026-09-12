/**
 * THE S1-S6 CONVERSATION LOCK.
 *
 * One seller, one thread, turn by turn, with state carried forward through the
 * real resolver exactly as persistence would carry it. Every stage advance must
 * be caused by an INBOUND SELLER MESSAGE, and every message class the operator
 * called out gets an explicit regression case.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { resolveAskingPriceSignal } from "@/lib/domain/seller-flow/monetary-understanding.js";

const UW = { recommended_cash_offer: 200_000, max_allowable_offer: 230_000, sufficient_facts: true };

/** A conversation that carries its own state forward, like persistence does. */
function conversation() {
  let facts = {};
  let stage = null;
  let negotiation = null;
  return {
    get stage() { return stage; },
    get facts() { return facts; },
    say(intent, new_facts = {}, { ade = null, ns = null } = {}) {
      if (ns) negotiation = { ...(negotiation || {}), ...ns };
      const t = resolveSellerStageTransition({
        stage_before: stage,
        known_facts: facts,
        new_facts,
        intent,
        ade_result: ade,
        negotiation_state: negotiation,
      });
      stage = t.stage_after;
      facts = { ...facts, ...(t.facts_patch || {}) };
      return t;
    },
  };
}

const price = (text) => resolveAskingPriceSignal(text, { reference: 200_000 })?.asking_price ?? null;

test("S1 -> S6: the full journey, every advance caused by a seller message", () => {
  const c = conversation();

  // S1 — ownership
  let t = c.say("ownership_confirmed", { ownership_status: "confirmed" });
  assert.equal(t.stage_after, "offer_interest", "ownership resolved -> S2");

  // S2 — interest
  t = c.say("seller_interested", { interest: "interested" });
  assert.equal(t.stage_after, "asking_price", "interest resolved -> S3");
  assert.equal(t.lead_temperature, "warm", "engaged, economics unknown");

  // A sparse acknowledgement in the middle must change nothing.
  const beforeAck = JSON.stringify({ s: c.stage, f: c.facts });
  t = c.say("acknowledgement");
  assert.equal(JSON.stringify({ s: c.stage, f: c.facts }), beforeAck, "an ack is inert");

  // S3 — asking price, inside the buy box
  t = c.say("price_provided", { asking_price: price("I want 220k") }, { ade: UW });
  assert.equal(t.economic_gate?.offer_band, "close_range");
  assert.equal(t.economic_gate?.route_id, "close_range_initial_offer", "nothing revealed yet");
  assert.equal(t.economic_gate?.template_use_case, "offer_reveal_cash");
  assert.equal(t.stage_after, "offer", "inside MAO is the offer stage");

  // S5 — we present $200k, the seller comes back at 220k. NOW it is a counter,
  // and it is asserted BEFORE condition resolves: the economic gate governs the
  // price decision point, so once condition is answered the route is no longer
  // re-derived. Realistic order too - sellers counter before they describe the
  // roof.
  t = c.say("price_provided", { asking_price: price("I want 220k") }, {
    ade: UW,
    ns: { latest_offer: 200_000, offers_made: [{ amount: 200_000 }] },
  });
  assert.equal(t.economic_gate?.route_id, "close_range_counter", "after a reveal it is a counter");
  assert.equal(t.economic_gate?.template_use_case, "counter_offer");

  // S4 — condition. The journey cannot reach S6 without it: milestone
  // completeness is first-unresolved-wins, so an unanswered condition question
  // holds the lifecycle below the contract milestone no matter what the seller
  // later agrees to. That is the model working, not a gap.
  t = c.say("condition_disclosed", { occupancy_status: "vacant", condition_level: "needs work" }, { ade: UW });
  assert.ok(["offer", "property_condition"].includes(t.stage_after), "condition resolved");

  // Contract request WITHOUT acceptance: hot, but not S6.
  t = c.say("contract_requested");
  assert.equal(t.lead_temperature, "hot");
  assert.notEqual(t.stage_after, "formal_contract", "economics cannot fabricate acceptance");

  // S6 — real acceptance
  t = c.say("contract_requested", {}, {
    ade: UW,
    ns: { terms_accepted: true, accepted_price: 200_000 },
  });
  assert.equal(t.stage_after, "formal_contract", "seller acceptance reaches S6");
  assert.ok((t.workflow_event_types || []).includes("SELLER_ACCEPTED_OFFER"));
});

test("S4 condition path: a high ask routes to condition, never to an offer", () => {
  const c = conversation();
  c.say("ownership_confirmed", { ownership_status: "confirmed" });
  c.say("seller_interested", { interest: "interested" });
  const t = c.say("price_provided", { asking_price: price("I want 250k") }, { ade: UW });
  assert.equal(t.economic_gate?.offer_band, "negotiable");
  assert.equal(t.economic_gate?.template_use_case, "price_high_condition_probe");
  assert.equal(t.stage_after, "property_condition");
});

test("very-wide-gap parks in nurture and goes cold, at any point in the journey", () => {
  const c = conversation();
  c.say("ownership_confirmed", { ownership_status: "confirmed" });
  c.say("seller_interested", { interest: "interested" });
  const t = c.say("price_provided", { asking_price: price("Half mil and its yours") }, {
    ade: { recommended_cash_offer: 160_000, max_allowable_offer: 184_000, sufficient_facts: true },
  });
  assert.equal(t.economic_gate?.offer_band, "very_wide_gap");
  assert.equal(t.economic_gate?.template_use_case, "asking_price_follow_up");
  assert.equal(t.stage_after, "asking_price");
  assert.equal(t.lead_temperature, "cold");
});

test("no outbound-shaped turn advances the conversation at any stage", () => {
  for (const intent of ["stage_no_reply", "followup_due", "no_inbound_outbound_only", "acknowledgement"]) {
    const c = conversation();
    c.say("ownership_confirmed", { ownership_status: "confirmed" });
    c.say("seller_interested", { interest: "interested" });
    const before = c.stage;
    const t = c.say(intent);
    assert.equal(t.stage_after, before, `${intent} must not advance`);
    assert.equal(t.facts_patch?.asking_price ?? null, null, `${intent} must not invent a price`);
  }
});

test("acknowledgement vs contract request, side by side, from identical state", () => {
  const build = () => {
    const c = conversation();
    c.say("ownership_confirmed", { ownership_status: "confirmed" });
    c.say("seller_interested", { interest: "interested" });
    return c;
  };
  const ack = build().say("acknowledgement");
  const req = build().say("contract_requested");

  assert.notEqual(ack.lead_temperature, "hot", "an ack is not qualification");
  assert.equal(req.lead_temperature, "hot", "a contract request is");
  // Neither fabricates a stage or acceptance.
  for (const t of [ack, req]) {
    assert.notEqual(t.stage_after, "formal_contract");
    assert.ok(!(t.workflow_event_types || []).includes("SELLER_ACCEPTED_OFFER"));
  }
});
