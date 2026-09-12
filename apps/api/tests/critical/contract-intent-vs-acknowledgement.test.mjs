/**
 * "OK SEND OVER THE CONTRACT AND WE WILL SIGN IT" IS NOT AN ACKNOWLEDGEMENT.
 *
 * It was classified as one, because the acknowledgement heuristic matched the
 * word "ok" anywhere in the message. The strongest signal a seller can send
 * therefore arrived at the resolver as noise, and only stage-depth temperature
 * promotion kept the lead off the floor.
 *
 * contract_requested is not a new taxonomy: the lead-state registry already
 * maps it to FORMAL_CONTRACT and the intent ontology already carries
 * `contract_request` with lead_temperature hot / automation pause. It simply
 * had no detector, which that file documents as a known gap. This closes it.
 *
 * CONTRACT INTENT IS NOT ACCEPTED ECONOMICS. It raises priority. It does not
 * set terms_accepted, an accepted price, or the formal-contract stage.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { normalizeCanonicalIntent } from "@/lib/domain/seller-flow/coverage-net/canonical-intent-aliases.js";

const intentOf = async (text) => {
  const r = await classify(text, null, { heuristicOnly: true });
  return r?.primary_intent ?? r?.intent ?? null;
};

test("contract requests classify as contract_requested, not acknowledgement", async () => {
  for (const text of [
    "Ok send over the contract and we will sign it",
    "Send me the contract",
    "Send over the agreement",
    "Send the paperwork",
    "Where do I sign?",
    "Let's get the contract done",
    "Email me the purchase agreement",
  ]) {
    const intent = await intentOf(text);
    assert.equal(intent, "contract_requested", text);
    assert.notEqual(intent, "acknowledgement", text);
  }
});

test("generic acknowledgement stays acknowledgement", async () => {
  for (const text of ["Ok thanks", "Got it", "ok", "Understood", "Gotcha"]) {
    const intent = await intentOf(text);
    assert.notEqual(intent, "contract_requested", `"${text}" must not be a contract request`);
  }
});

test("the word 'contract' alone is not a request", async () => {
  // "under contract with another buyer" is a stand-down, not a signal to paper.
  for (const text of [
    "It is under contract with another buyer",
    "My contract with the realtor ends in May",
  ]) {
    assert.notEqual(await intentOf(text), "contract_requested", text);
  }
});

test("contract_requested survives canonical normalization", () => {
  // It folded to "unclear" before, which is how it reached the resolver as noise.
  assert.equal(normalizeCanonicalIntent("contract_requested"), "contract_requested");
  assert.equal(normalizeCanonicalIntent("Contract Requested"), "contract_requested");
});

// ══════════════════════════════════════════════════════════════════════════
// CONTRACT INTENT vs ACCEPTED ECONOMICS
// ══════════════════════════════════════════════════════════════════════════

const INTERESTED = { ownership_status: "confirmed", interest: "interested" };

test("CASE A: acknowledgement alone does not create HOT, and prior facts survive", () => {
  const t = resolveSellerStageTransition({
    stage_before: "offer_interest",
    known_facts: INTERESTED,
    new_facts: {},
    intent: "acknowledgement",
  });
  assert.equal(t.facts_patch?.interest, "interested", "prior interest survives");
  assert.notEqual(t.lead_temperature, "hot", "an acknowledgement is not qualification");
  assert.notEqual(t.stage_after, "formal_contract");
  assert.ok(!(t.workflow_event_types || []).includes("SELLER_ACCEPTED_OFFER"));
});

test("CASE B: contract request with NO agreed offer is HOT but not accepted", () => {
  const t = resolveSellerStageTransition({
    stage_before: "offer_interest",
    known_facts: INTERESTED,
    new_facts: {},
    intent: "contract_requested",
  });
  assert.equal(t.lead_temperature, "hot", "this deserves immediate attention");
  assert.notEqual(t.stage_after, "formal_contract", "no offer exists to accept");
  assert.ok(!(t.workflow_event_types || []).includes("SELLER_ACCEPTED_OFFER"));
});

test("CASE C: contract request AFTER a reveal is HOT, still not acceptance", () => {
  const t = resolveSellerStageTransition({
    stage_before: "offer",
    known_facts: {
      ...INTERESTED,
      asking_price: { value: 200_000, raw: "200k" },
      occupancy_status: "vacant",
      condition_level: "needs work",
    },
    new_facts: {},
    intent: "contract_requested",
    negotiation_state: { latest_offer: 200_000, offers_made: [{ amount: 200_000 }], terms_accepted: false },
  });
  assert.equal(t.lead_temperature, "hot");
  assert.equal(t.stage_after, "offer", "temperature must not manufacture stage");
  assert.notEqual(t.stage_after, "formal_contract");
  assert.ok(!(t.workflow_event_types || []).includes("SELLER_ACCEPTED_OFFER"));
});

test("CASE D: explicit acceptance + contract request DOES reach S6", () => {
  const t = resolveSellerStageTransition({
    stage_before: "offer",
    known_facts: {
      ...INTERESTED,
      asking_price: { value: 200_000, raw: "200k" },
      occupancy_status: "vacant",
      condition_level: "needs work",
    },
    new_facts: {},
    intent: "contract_requested",
    negotiation_state: {
      latest_offer: 200_000,
      offers_made: [{ amount: 200_000 }],
      terms_accepted: true,
      accepted_price: 200_000,
    },
  });
  assert.equal(t.stage_after, "formal_contract", "real acceptance evidence reaches S6");
  assert.equal(t.lead_temperature, "hot");
  assert.ok((t.workflow_event_types || []).includes("SELLER_ACCEPTED_OFFER"));
});

test("the ONLY difference between C and D is seller acceptance evidence", () => {
  const base = {
    stage_before: "offer",
    known_facts: {
      ...INTERESTED,
      asking_price: { value: 200_000, raw: "200k" },
      occupancy_status: "vacant",
      condition_level: "needs work",
    },
    new_facts: {},
    intent: "contract_requested",
  };
  const ns = { latest_offer: 200_000, offers_made: [{ amount: 200_000 }] };
  const without = resolveSellerStageTransition({ ...base, negotiation_state: { ...ns, terms_accepted: false } });
  const with_ = resolveSellerStageTransition({ ...base, negotiation_state: { ...ns, terms_accepted: true } });
  assert.equal(without.lead_temperature, with_.lead_temperature, "both are HOT");
  assert.notEqual(without.stage_after, with_.stage_after, "only acceptance moves the stage");
});
