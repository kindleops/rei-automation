// ─── seller-followup-suppression-drift.test.mjs ─────────────────────────────
// Regression coverage for the canonical-intent suppression drift: for each of
// the five non-owner/opt-out outcomes, proves the full real pipeline —
// classify() -> normalizeClassificationContract() (the canonical-intent
// bridge) -> resolveSellerStageTransition() / resolveFollowUpPlan() — cancels
// or permanently suppresses follow-ups at classification/state-transition
// time. Canonical intent strings are taken directly from
// coverage-net/canonical-intent-aliases.js (CANONICAL_INTENTS) and
// resolve-inbound-relationship.js (deriveCanonicalIntent) — none are guessed.
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { normalizeClassificationContract } from "@/lib/domain/seller-flow/normalize-classification-contract.js";
import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { resolveFollowUpPlan } from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import { CONTACTABILITY_CODES } from "@/lib/domain/lead-state/universal-lead-state-registry.js";

const NOW_ISO = "2026-04-04T15:00:00.000Z";

// Each case's reply text is chosen to hit exactly one relationship-claim
// bucket in resolve-inbound-relationship.js's detectRelationshipClaim(), so
// the canonical intent produced is unambiguous (see file comments there for
// the exact phrase -> claim -> canonical-intent chain).
const CASES = [
  {
    label: "opt-out",
    text: "STOP",
    expectedIntent: "opt_out",
  },
  {
    label: "wrong number",
    text: "You have the wrong number, this isn't me.",
    expectedIntent: "wrong_number",
  },
  {
    label: "not the owner",
    text: "I'm not the owner of that property.",
    expectedIntent: "property_specific_non_owner",
  },
  {
    label: "never owned",
    text: "I've never owned that property.",
    expectedIntent: "property_specific_non_owner",
  },
  {
    label: "sold the property",
    text: "I already sold that property, I don't have it anymore.",
    expectedIntent: "former_owner_respondent",
  },
];

for (const { label, text, expectedIntent } of CASES) {
  test(`canonical outcome "${label}" resolves to ${expectedIntent} and permanently suppresses follow-ups`, async () => {
    const classification = await classify(text, null, { heuristicOnly: true });
    const { contract } = normalizeClassificationContract({
      classification,
      message: text,
      threadId: "+15551230001",
      phone: "+15551230001",
    });

    assert.equal(
      contract.normalized_intent,
      expectedIntent,
      `expected "${text}" to resolve to canonical intent ${expectedIntent}, got ${contract.normalized_intent}`
    );

    // ── State-transition time: pending follow-ups are cancelled and the
    // lifecycle never advances or re-prompts for this outcome.
    const transition = resolveSellerStageTransition({
      stage_before: "ownership_confirmation",
      intent: contract.normalized_intent,
      now: NOW_ISO,
    });
    assert.equal(transition.advanced, false, "must never advance the lifecycle stage");
    assert.equal(transition.follow_up.cancel, true, "must cancel pending follow-ups at state-transition time");
    assert.equal(transition.follow_up.create, false, "must never schedule a new follow-up for this outcome");
    assert.notEqual(transition.next_action, "send_message_now", "must never prompt again (e.g. re-ask ownership)");

    // ── Classification time: the follow-up scheduler independently refuses
    // to ever create a new nurture follow-up for this canonical intent.
    const plan = resolveFollowUpPlan(contract.normalized_intent, { thread_key: "+15551230001" });
    assert.equal(plan.suppressed, true, "must be permanently suppressed, not just unmatched by a nurture rule");
    assert.equal(plan.followup_created, false);
  });
}

test("opt-out and wrong-number set contactability that blocks all future sends", () => {
  const optOut = resolveSellerStageTransition({ stage_before: "ownership_confirmation", intent: "opt_out", now: NOW_ISO });
  assert.equal(optOut.contactability_patch.contactability_status, CONTACTABILITY_CODES.OPTED_OUT);

  const wrongNumber = resolveSellerStageTransition({ stage_before: "ownership_confirmation", intent: "wrong_number", now: NOW_ISO });
  assert.equal(wrongNumber.contactability_patch.contactability_status, CONTACTABILITY_CODES.INVALID_NUMBER);
});

test("not-the-owner and sold-the-property halt automation, mark ownership not_owner, and route to review", () => {
  const notOwner = resolveSellerStageTransition({
    stage_before: "ownership_confirmation",
    intent: "property_specific_non_owner",
    now: NOW_ISO,
  });
  assert.equal(notOwner.ownership_patch?.ownership_status, "not_owner");
  assert.equal(notOwner.review_required, true);
  assert.equal(notOwner.contactability_patch.contactability_status, CONTACTABILITY_CODES.DO_NOT_TEXT);

  const sold = resolveSellerStageTransition({
    stage_before: "ownership_confirmation",
    intent: "former_owner_respondent",
    now: NOW_ISO,
  });
  assert.equal(sold.ownership_patch?.ownership_status, "not_owner");
  assert.equal(sold.review_required, true);
  assert.equal(sold.disposition, "sold");
  assert.equal(sold.contactability_patch.contactability_status, CONTACTABILITY_CODES.DO_NOT_TEXT);
});
