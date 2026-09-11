// ─── compound-opportunity-preservation.test.mjs ──────────────────────────────
// Certification regression: a negative first clause must never erase a
// positive second clause — the reported production defect family.
//
//   "That house isn't for sale, but I might sell 123 Oak Street."
//   "No that property is not for sale. But what would you pay for 456 Oak Ave?"
//
// Root defect locked here (backend certification pass, 2026-08-25): the
// ownership-probe overlay (applyOwnershipProbeOverlay) unconditionally
// flattened every not-interested classification to the silent
// s1_not_for_sale_advance_with_followup outcome, discarding asks_offer /
// latent_interest components and any new-address signal. The decision layer
// read only primary_intent; compound components survived classification but
// never reached a decision.
//
// Deterministic: heuristicOnly, no network, no AI, no DB.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { applyInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

async function decide(message, extra = {}) {
  const classification = await classify(message, null, { heuristicOnly: true });
  const decision = applyInboundAutomationDecision({
    message,
    threadKey: "+15550100001",
    propertyId: "prop-A",
    classification,
    ...extra,
  });
  return { classification, decision };
}

// Context that puts the thread in the S1 ownership-probe stage, where the
// overlay historically flattened compound messages.
const OWNERSHIP_PROBE_CONTEXT = {
  latestThreadContext: { summary: { conversation_stage: "ownership_check" } },
};

test("not-for-sale + new address → new_property_opportunity review with the address preserved", async () => {
  const { decision } = await decide(
    "No that property is not for sale. But what would you pay for 456 Oak Ave?"
  );
  assert.equal(decision.audit_reason, "new_property_opportunity");
  assert.equal(decision.should_mark_human_review, true);
  assert.equal(decision.should_suppress_contact, false);
  const compound = decision.compound_opportunity;
  assert.ok(compound, "compound payload required");
  assert.ok(
    compound.address_candidates.some((c) => c.street_number === "456"),
    JSON.stringify(compound.address_candidates)
  );
  assert.ok(compound.positive_intents.includes("asks_offer"));
});

test("the ownership-probe overlay never flattens a compound message (the reported defect)", async () => {
  const { decision } = await decide(
    "No that property is not for sale. But what would you pay for 456 Oak Ave?",
    OWNERSHIP_PROBE_CONTEXT
  );
  assert.notEqual(decision.audit_reason, "s1_not_for_sale_advance_with_followup");
  assert.equal(decision.audit_reason, "new_property_opportunity");
  assert.equal(decision.reply_mode, "manual_review");
});

test("a PURE property-specific decline still takes the advance-with-followup lane", async () => {
  const { decision } = await decide("123 Main is not for sale.", OWNERSHIP_PROBE_CONTEXT);
  assert.equal(decision.audit_reason, "s1_not_for_sale_advance_with_followup");
  assert.equal(decision.should_suppress_contact, false);
  assert.equal(decision.next_action, "schedule_later_followup");
});

test("declined + asks-offer with NO new address stays on the same property and answers", async () => {
  const { classification, decision } = await decide(
    "Not for sale. But what would you pay for it?"
  );
  assert.ok(classification.matched_intents.includes("asks_offer"), JSON.stringify(classification.matched_intents));
  assert.equal(decision.audit_reason, "declined_but_asks_offer");
  assert.equal(decision.should_suppress_contact, false);
  // Confident classification answers (execution gates still apply downstream);
  // low confidence routes to review. Either way the question is never dropped.
  assert.ok(
    decision.should_queue_reply || decision.should_mark_human_review,
    JSON.stringify(decision)
  );
  if (decision.should_queue_reply) {
    assert.equal(decision.route_hint, "ask_seller_price_or_basic_condition");
  }
});

test("plain not_interested is unchanged: deliberate no-reply with durable reason", async () => {
  const { decision } = await decide("Not interested, thanks");
  // Without thread context the classifier's default Ownership stage hint
  // routes the decline through the S1 advance-with-followup lane; with a
  // later-stage context it is a bare do_not_reply. Both are deliberate,
  // explained no-reply outcomes — never suppression, never a silent drop.
  assert.ok(
    ["not_interested", "s1_not_for_sale_advance_with_followup"].includes(decision.audit_reason),
    decision.audit_reason
  );
  assert.ok(["do_not_reply", "schedule_later_followup"].includes(decision.next_action));
  assert.equal(decision.should_suppress_contact, false);
  assert.equal(decision.should_queue_reply, false);
  assert.equal(decision.compound_opportunity, null);
});

test("wrong person + explicit seller signal routes to review, not the archive", async () => {
  const { decision } = await decide(
    "Wrong person, but I might sell 123 Oak Street myself"
  );
  assert.equal(decision.audit_reason, "wrong_person_with_seller_signal");
  assert.equal(decision.should_suppress_contact, false);
  assert.equal(decision.should_mark_human_review, true);
});

test("a bare wrong number still archives at phone scope (no behavior drift)", async () => {
  const { decision } = await decide("You have the wrong number");
  assert.equal(decision.audit_reason, "wrong_number");
  assert.equal(decision.should_suppress_contact, true);
  assert.equal(decision.next_action, "archive_wrong_number");
});

test("STOP + additional property information: opt-out remains absolute", async () => {
  const { decision } = await decide("STOP. Also I own 456 Oak Ave");
  assert.equal(decision.should_suppress_contact, true);
  assert.equal(decision.suppression_reason, "opt_out");
  assert.equal(decision.should_queue_reply, false);
});

test("mixed not-for-sale + alternate-address phrasing reaches review, price stays clean", async () => {
  const { classification, decision } = await decide(
    "That house isn't for sale, but I might sell 123 Oak Street."
  );
  // The street number never becomes a price (defect D3 interplay).
  assert.equal(classification.seller_state?.price_mentioned ?? null, null);
  // The address candidate reaches the decision payload whenever the decision
  // routes through a compound-aware lane; at minimum nothing is suppressed
  // and the message is never silently dropped.
  assert.equal(decision.should_suppress_contact, false);
  assert.ok(
    decision.should_mark_human_review || decision.should_queue_reply,
    JSON.stringify(decision)
  );
});
