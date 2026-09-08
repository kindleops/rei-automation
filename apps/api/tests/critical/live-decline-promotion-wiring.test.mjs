/**
 * live-decline-promotion-wiring.test.mjs
 *
 * Exercises the REAL call site -- applyInboundAutomationDecision -- not the
 * promotion resolver in isolation. The resolver was already proven; what was
 * unproven is that the live inbound path actually invokes it and that the
 * promoted fields survive to decisionToUniversalLeadStatePatch, which is the
 * payload patchUniversalLeadState commits.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { applyInboundAutomationDecision } from "../../src/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { decisionToUniversalLeadStatePatch } from "../../src/lib/domain/seller-flow/seller-flow-decision-contract.js";

/** Run the live decision path, then the real patch builder it feeds. */
function live({ intent, body, currentDisposition = null, classification = {} }) {
  const decision = applyInboundAutomationDecision({
    threadKey: "+15550002222",
    message: { message_body: body },
    classification: { primary_intent: intent, confidence: 0.9, ...classification },
    latestThreadContext: { summary: { disposition: currentDisposition } },
  });
  return { decision, patch: decisionToUniversalLeadStatePatch(decision) };
}

test("1. English decline promotes durable state through the LIVE path", () => {
  const { decision, patch } = live({ intent: "not_interested", body: "Not selling" });
  assert.equal(decision.disposition, "not_interested");
  assert.equal(patch.disposition, "not_interested", "must survive into the committed patch");
  assert.equal(patch.operational_status, "paused");
  assert.equal(patch.lead_temperature, "cold", "temperature must map, not be dropped");
});

test("2. Spanish decline promotes through the LIVE path", () => {
  const { patch } = live({ intent: "ownership_confirmed", body: "No está de venta" });
  assert.equal(patch.disposition, "not_interested");
});

test("3. Spanish compound keeps ownership AND records the decline", () => {
  const { decision, patch } = live({
    intent: "ownership_confirmed",
    body: "Si, pero no esta de venta!",
  });
  assert.equal(patch.disposition, "not_interested", "the refusal must win");
  assert.equal(
    decision.decline_promotion_reason,
    "compound_ownership_confirmed_with_sale_decline",
  );
  // The ownership fact the decision computed is not erased by the overlay.
  assert.notEqual(decision.ownership_status, "not_owner");
});

test("4. price + decline keeps the price fact and still records the decline", () => {
  const { decision, patch } = live({
    intent: "gives_asking_price",
    body: "I'd want 200k but it's not for sale",
  });
  assert.equal(patch.disposition, "not_interested");
  // Nothing in the overlay touches price-bearing fields.
  assert.equal("asking_price" in (decision.overwritten_fields || {}), false);
});

test("5. a decline is NOT DNC on the live path", () => {
  const { decision, patch } = live({ intent: "not_interested", body: "Not selling" });
  assert.equal(decision.should_suppress_contact, false);
  assert.notEqual(patch.disposition, "suppressed");
  assert.notEqual(patch.contactability_status, "do_not_text");
});

test("6. STOP is NEVER recorded as a decline by this overlay", () => {
  // Found by this test: an early build promoted opt_out to
  // disposition="not_interested", because the ontology gives a legal opt-out
  // the SAME disposition as a commercial refusal. A STOP would have been
  // durably recorded as "not interested". The overlay now refuses any intent
  // that is not a decline, leaving opt_out entirely on the compliance path.
  const { decision, patch } = live({ intent: "opt_out", body: "STOP" });
  assert.equal(decision.decline_promotion_reason ?? null, null, "overlay must not act on opt_out");
  assert.notEqual(patch.disposition, "not_interested", "STOP must never read as a decline");
});

test("7. an ordinary decline REOPENS when the seller re-engages", () => {
  const { patch } = live({
    intent: "gives_asking_price",
    body: "Actually, what would you offer?",
    currentDisposition: "not_interested",
  });
  assert.equal(patch.disposition, "none");
  assert.equal(patch.operational_status, "active_communication");
});

test("8. a SUPPRESSED contact does not reopen on sale-interest language", () => {
  const { patch } = live({
    intent: "gives_asking_price",
    body: "what would you offer?",
    currentDisposition: "suppressed",
  });
  assert.notEqual(patch.disposition, "none", "suppression is not cleared by interest");
});

test("9. unrelated decision fields survive the merge untouched", () => {
  const base = applyInboundAutomationDecision({
    threadKey: "+15550002222",
    message: { message_body: "Yes, I do" },
    classification: { primary_intent: "ownership_confirmed", confidence: 0.9 },
  });
  const declined = applyInboundAutomationDecision({
    threadKey: "+15550002222",
    message: { message_body: "Yes, I do, but not selling" },
    classification: { primary_intent: "ownership_confirmed", confidence: 0.9 },
  });
  // Only the promoted fields may differ. Clock-derived fields are excluded:
  // exception_sla_deadline is computed from now() on every call and drifts by
  // milliseconds between two invocations regardless of this overlay.
  const CLOCK_DERIVED = new Set(["exception_sla_deadline", "next_action_due_at", "follow_up_at"]);
  const changed = Object.keys({ ...base, ...declined })
    .filter((k) => !CLOCK_DERIVED.has(k))
    .filter((k) => JSON.stringify(base[k]) !== JSON.stringify(declined[k]))
    .sort();
  for (const key of changed) {
    assert.ok(
      ["disposition", "operational_status", "temperature", "decline_promotion_reason"].includes(key),
      `overlay must not change ${key}`,
    );
  }
});

test("10. FUS2 eligibility agrees with the promoted state", async () => {
  const { resolveFollowUpEligibility } = await import(
    "../../src/lib/domain/inbox/resolve-followup-eligibility.js"
  );
  const { patch } = live({ intent: "not_interested", body: "Not selling" });
  assert.equal(patch.disposition, "not_interested");

  const gate = resolveFollowUpEligibility({
    thread_key: "+15550002222",
    messages: [{ direction: "inbound", body: "Not selling", intent: "not_interested" }],
    salutation: { name: "Sam", needs_review: false },
  });
  assert.equal(gate.eligible, false);
  assert.equal(gate.reason, "seller_explicit_decline");
});

test("a non-decline inbound is left entirely alone by the overlay", () => {
  const { decision } = live({ intent: "ownership_confirmed", body: "Yes, I do" });
  assert.equal(decision.decline_promotion_reason ?? null, null);
});
