// ─── sold-property-scope.test.mjs ────────────────────────────────────────────
// Certification regression: "already sold" is a PROPERTY-scoped disposition.
//
// Root defect locked here (backend certification pass, 2026-08-25):
// matchesOwnershipDisconnect routed every sold report into wrong_number
// "for production suppression", so "I already sold that house" set
// should_suppress_contact=true (phone-global sms_suppression_list +
// phones.phone_contact_status), and the stage resolver wrote phone-level
// do_not_text for the property-scoped former_owner_respondent /
// property_specific_non_owner claims (M1). The ontology has always said the
// opposite: sold_property "suppresses the PAIRING" only.
//
// Deterministic: heuristicOnly, no network, no AI, no DB.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { applyInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { normalizeCanonicalIntent, isSuppressionIntent } from "@/lib/domain/seller-flow/coverage-net/canonical-intent-aliases.js";

async function decide(message) {
  const classification = await classify(message, null, { heuristicOnly: true });
  const decision = applyInboundAutomationDecision({
    message,
    threadKey: "+15550100001",
    propertyId: "prop-A",
    classification,
  });
  return { classification, decision };
}

test("sold family classifies as sold_property, never wrong_number", async () => {
  const SOLD = [
    "I already sold that house",
    "Sold it in 2019",
    "We sold it last year, sorry",
    "That sold months ago",
    "sold it years ago",
    "Ya la vendí",
  ];
  for (const text of SOLD) {
    const r = await classify(text, null, { heuristicOnly: true });
    assert.equal(r.primary_intent, "sold_property", text);
    assert.ok(!r.matched_intents.includes("wrong_number"), text);
    // Classifier-level automation decision carries no suppression action.
    assert.equal(r.automation_decision?.suppression_action, "none", text);
  }
});

test("negated sold is not a sold report", async () => {
  for (const text of ["haven't sold it yet", "It's not sold", "we never sold it"]) {
    const r = await classify(text, null, { heuristicOnly: true });
    assert.notEqual(r.primary_intent, "sold_property", text);
  }
});

test("plain sold → property_sold disposition, contact NOT suppressed, explained terminal", async () => {
  const { decision } = await decide("I already sold that house");
  assert.equal(decision.should_suppress_contact, false);
  assert.equal(decision.should_queue_reply, false);
  assert.equal(decision.next_action, "disposition_property_sold");
  assert.equal(decision.audit_reason, "property_sold");
  assert.equal(decision.reply_mode, "none");
  // Deliberate no-reply is covered, never a silent drop.
  assert.ok(decision.coverage_state, "coverage_state must be set");
  assert.notEqual(decision.coverage_state, "missing_coverage");
});

test("Case E: sold A + owns B → review with the second clause preserved, no suppression", async () => {
  const { decision } = await decide(
    "I sold 123 Main, but I own 456 Oak and might sell that one"
  );
  assert.equal(decision.should_suppress_contact, false);
  assert.equal(decision.should_mark_human_review, true);
  assert.equal(decision.audit_reason, "sold_with_new_opportunity");
  assert.ok(decision.compound_opportunity, "compound payload must survive");
  assert.ok(decision.compound_opportunity.positive_intents.includes("latent_interest"));
});

test("canonical layer: sold is former_owner_respondent, not a suppression intent", () => {
  assert.equal(normalizeCanonicalIntent("sold_property"), "former_owner_respondent");
  assert.equal(normalizeCanonicalIntent("already_sold"), "former_owner_respondent");
  assert.equal(isSuppressionIntent("sold_property"), false);
  assert.equal(isSuppressionIntent("already_sold"), false);
  // True identity disconnects remain suppression intents.
  assert.equal(isSuppressionIntent("wrong_number"), true);
});

test("stage resolver: property-scoped holds carry NO contactability write (M1)", () => {
  for (const intent of ["sold_property", "former_owner_respondent", "property_specific_non_owner"]) {
    const t = resolveSellerStageTransition({
      intent,
      stage_before: "S1_OWNERSHIP_CONFIRMATION",
    });
    assert.equal(t.contactability_patch, null, `${intent} must not touch contactability`);
    assert.equal(t.review_required, true, intent);
    assert.equal(t.advanced, false, intent);
  }
  const sold = resolveSellerStageTransition({
    intent: "sold_property",
    stage_before: "S1_OWNERSHIP_CONFIRMATION",
  });
  assert.equal(sold.disposition, "sold");
});

test("stage resolver: phone-scoped identity disconnects still block the phone", () => {
  const wrongNumber = resolveSellerStageTransition({
    intent: "wrong_number",
    stage_before: "S1_OWNERSHIP_CONFIRMATION",
  });
  assert.equal(wrongNumber.contactability_patch?.contactability_status, "invalid_number");

  const wrongPerson = resolveSellerStageTransition({
    intent: "wrong_person",
    stage_before: "S1_OWNERSHIP_CONFIRMATION",
  });
  assert.equal(wrongPerson.contactability_patch?.contactability_status, "do_not_text");

  const optOut = resolveSellerStageTransition({
    intent: "opt_out",
    stage_before: "S1_OWNERSHIP_CONFIRMATION",
  });
  assert.equal(optOut.contactability_patch?.contactability_status, "opted_out");
});

test("sold + STOP is still a hard opt-out (compliance is absolute)", async () => {
  const { classification, decision } = await decide("Sold it, stop texting me");
  assert.equal(classification.primary_intent, "opt_out");
  assert.equal(decision.should_suppress_contact, true);
  assert.equal(decision.suppression_reason, "opt_out");
});
