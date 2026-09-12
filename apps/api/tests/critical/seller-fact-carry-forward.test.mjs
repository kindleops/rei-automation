/**
 * SELLER FACTS ARE CUMULATIVE STATE.
 *
 * A sparse later turn may ADD, REFINE, SUPERSEDE or explicitly REVOKE a fact.
 * What it may never do is ERASE one by saying nothing about it.
 *
 * This was broken in a way the old temperature rule hid. "Yes we want to sell,
 * send us your offer" resolves interest but NOT ownership, so the turn stayed
 * at stage 1 and failed the `stage_after_number >= 2` qualification in
 * persist-seller-transition - no opportunity row, nothing persisted. The next
 * inbound arrived with known_facts.interest = null, as if the seller had never
 * said it. Temperature came from stage depth back then, so the lead still
 * looked warm and the amnesia was invisible.
 *
 * `interest`, `wants_offer` and `contract_requested` are now durable.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { mergeSellerFacts, resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { transitionQualifiesForOpportunity } from "@/lib/domain/seller-flow/persist-seller-transition.js";

const SPARSE = ["ok", "thanks", "got it", "sounds good", "👍", ""];

test("a sparse turn never erases a durable fact", () => {
  const established = {
    ownership_status: "confirmed",
    interest: "interested",
    wants_offer: true,
    asking_price: { value: 220_000, raw: "220k", price_type: "exact" },
    occupancy_status: "vacant",
    condition_level: "needs work",
    timeline: "immediate",
    listing_status: "not_listed",
  };

  // An inbound that carries no facts at all - the shape every acknowledgement has.
  const after = mergeSellerFacts(established, {});
  for (const [key, value] of Object.entries(established)) {
    if (key === "asking_price") {
      assert.equal(after.asking_price?.value, 220_000, "asking price must survive");
      continue;
    }
    assert.deepEqual(after[key], value, `${key} must survive a sparse turn`);
  }
});

test("null / undefined / empty in a new turn cannot null out a known fact", () => {
  const known = { ownership_status: "confirmed", interest: "interested" };
  for (const empty of [null, undefined, ""]) {
    const after = mergeSellerFacts(known, { ownership_status: empty, interest: empty });
    assert.equal(after.ownership_status, "confirmed", `ownership survived ${JSON.stringify(empty)}`);
    assert.equal(after.interest, "interested", `interest survived ${JSON.stringify(empty)}`);
  }
});

test("a new turn may still SUPERSEDE a fact with real evidence", () => {
  // Cumulative does not mean frozen.
  const known = { interest: "interested", asking_price: { value: 220_000, raw: "220k" } };
  const after = mergeSellerFacts(known, {
    interest: "not_interested",
    asking_price: { value: 240_000, raw: "240k" },
  });
  assert.equal(after.interest, "not_interested");
  assert.equal(after.asking_price?.value, 240_000);
});

test("each established fact survives the FULL turn, end to end", () => {
  // Not just the merge helper - the resolver's own facts_patch, which is what
  // persistence writes.
  const cases = [
    ["ownership", { ownership_status: "confirmed" }, (f) => assert.equal(f.ownership_status, "confirmed")],
    ["interest", { ownership_status: "confirmed", interest: "interested" }, (f) => assert.equal(f.interest, "interested")],
    ["asking price", { ownership_status: "confirmed", interest: "interested", asking_price: { value: 220_000, raw: "220k" } },
      (f) => assert.equal(f.asking_price?.value, 220_000)],
    ["condition", { ownership_status: "confirmed", occupancy_status: "vacant", condition_level: "needs work" },
      (f) => assert.equal(f.condition_level, "needs work")],
    ["wants_offer", { ownership_status: "confirmed", wants_offer: true }, (f) => assert.equal(f.wants_offer, true)],
  ];
  for (const [label, known, check] of cases) {
    for (const sparse of SPARSE) {
      const t = resolveSellerStageTransition({
        stage_before: null,
        known_facts: known,
        new_facts: {},
        intent: sparse ? "acknowledgement" : "unclear",
      });
      check(t.facts_patch || {}, `${label} survived "${sparse}"`);
    }
  }
});

test("the turn that establishes interest is DURABLE — it must be persisted", () => {
  // The actual defect: interest resolved, ownership did not, stage stayed at 1,
  // and the qualification check dropped the whole turn on the floor.
  const t = resolveSellerStageTransition({
    stage_before: null,
    known_facts: {},
    new_facts: { interest: "interested" },
    intent: "seller_interested",
  });
  assert.equal(t.facts_patch?.interest, "interested");
  assert.equal(
    transitionQualifiesForOpportunity(t),
    true,
    "a seller stating interest must create a durable record, or the fact evaporates",
  );
});

test("a contract request is durable too", () => {
  const t = resolveSellerStageTransition({
    stage_before: null,
    known_facts: {},
    new_facts: { contract_requested: true },
    intent: "contract_requested",
  });
  assert.equal(transitionQualifiesForOpportunity(t), true);
});
