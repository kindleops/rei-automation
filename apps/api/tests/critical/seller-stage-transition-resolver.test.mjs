import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveSellerStageTransition,
  mergeSellerFacts,
  hasMinimumConditionFacts,
  normalizeAskingPriceFact,
  NEXT_ACTIONS,
  ADE_ACTIONS,
} from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";

const NOW = "2026-07-01T12:00:00.000Z";

function resolve(overrides = {}) {
  return resolveSellerStageTransition({ now: NOW, ...overrides });
}

// ─── Table-driven lifecycle matrix ───────────────────────────────────────────

const MATRIX = [
  {
    name: "yes owner: S1 ownership confirmed advances to S2 interest probe",
    input: { stage_before: "ownership_confirmation", intent: "ownership_confirmed", classification_confidence: 0.95 },
    expect: {
      stage_after: "offer_interest",
      next_action: NEXT_ACTIONS.SEND_MESSAGE_NOW,
      required_template_use_case: "consider_selling",
      operational_status: "active_communication",
      review_required: false,
    },
  },
  {
    name: "not owner: wrong_person blocks contact without stage regression",
    input: { stage_before: "offer_interest", intent: "wrong_person" },
    expect: {
      stage_after: "offer_interest",
      next_action: NEXT_ACTIONS.NO_ACTION_CONTACT_BLOCKED,
      disposition: "wrong_person",
      review_required: false,
    },
    contactability: "do_not_text",
    cancels_followups: true,
    alternate_contact: true,
  },
  {
    name: "wrong number: phone blocked, ownership not_owner, alternates evaluated",
    input: { stage_before: "ownership_confirmation", intent: "wrong_number" },
    expect: {
      stage_after: "ownership_confirmation",
      next_action: NEXT_ACTIONS.NO_ACTION_CONTACT_BLOCKED,
      disposition: "wrong_number",
    },
    contactability: "invalid_number",
    ownership: "not_owner",
    cancels_followups: true,
    alternate_contact: true,
  },
  {
    name: "STOP: opt-out suppresses everything and cancels follow-ups",
    input: { stage_before: "asking_price", intent: "opt_out", current_temperature: "warm" },
    expect: {
      stage_after: "asking_price",
      next_action: NEXT_ACTIONS.NO_ACTION_CONTACT_BLOCKED,
      operational_status: "paused",
    },
    contactability: "opted_out",
    cancels_followups: true,
  },
  {
    name: "not interested at S1: ownership inferred, advance to S2, cold nurture",
    input: { stage_before: "ownership_confirmation", intent: "not_interested" },
    expect: {
      stage_after: "offer_interest",
      next_action: NEXT_ACTIONS.SCHEDULE_FOLLOW_UP,
      lead_temperature: "cold",
      disposition: "not_interested",
      required_template_use_case: "consider_selling_follow_up",
    },
    ownership: "inferred",
    followup_days: 30,
  },
  {
    name: "not interested at S3: stage holds, nurture scheduled",
    input: { stage_before: "asking_price", intent: "not_interested", current_temperature: "warm" },
    expect: {
      stage_after: "asking_price",
      lead_temperature: "cold",
      disposition: "not_interested",
      next_action: NEXT_ACTIONS.SCHEDULE_FOLLOW_UP,
    },
    followup_days: 30,
  },
  {
    name: "yes interested at S2 advances to S3 asking price",
    input: { stage_before: "offer_interest", intent: "seller_interested", classification_confidence: 0.9 },
    expect: {
      stage_after: "asking_price",
      next_action: NEXT_ACTIONS.SEND_MESSAGE_NOW,
      required_template_use_case: "seller_asking_price",
      lead_temperature: "warm",
      disposition: "interested",
    },
  },
  {
    name: "make me an offer: no price re-ask, underwriting question + preliminary ADE",
    input: { stage_before: "offer_interest", intent: "asks_offer", classification_confidence: 0.88 },
    expect: {
      stage_after: "asking_price",
      required_template_use_case: "condition_probe",
      ade_action: ADE_ACTIONS.RUN_PRELIMINARY,
      lead_temperature: "hot",
    },
  },
  {
    name: "make me an offer with sufficient ADE facts advances past S3 to S4",
    input: {
      stage_before: "offer_interest",
      intent: "asks_offer",
      ade_result: { sufficient_facts: true },
      classification_confidence: 0.88,
    },
    expect: { stage_after: "property_condition" },
  },
  {
    name: "direct price from S1: multi-stage advance to S4, warm, preliminary ADE",
    input: {
      stage_before: "ownership_confirmation",
      intent: "asking_price_provided",
      new_facts: { asking_price: { value: 95000, raw: "$95,000" } },
      classification_confidence: 0.92,
      source_message_id: "msg-123",
    },
    expect: {
      stage_after: "property_condition",
      next_action: NEXT_ACTIONS.SEND_MESSAGE_NOW,
      required_template_use_case: "condition_probe",
      operational_status: "active_communication",
      ade_action: ADE_ACTIONS.RUN_PRELIMINARY,
    },
    min_temperature: "warm",
    ownership: "inferred",
  },
  {
    name: "direct price from S2 (spec example: \"$95,000\")",
    input: {
      stage_before: "offer_interest",
      intent: "asking_price_provided",
      new_facts: { asking_price: 95000 },
      classification_confidence: 0.9,
    },
    expect: {
      stage_after: "property_condition",
      operational_status: "active_communication",
      ade_action: ADE_ACTIONS.RUN_PRELIMINARY,
    },
    min_temperature: "warm",
  },
  {
    name: "high unrealistic ask is captured, never killed",
    input: {
      stage_before: "offer_interest",
      intent: "asking_price_provided",
      new_facts: { asking_price: 2500000 },
      classification_confidence: 0.9,
    },
    expect: { stage_after: "property_condition", review_required: false },
  },
  {
    name: "price plus condition in one reply: S2 jumps to S5 and runs full ADE",
    input: {
      stage_before: "offer_interest",
      intent: "asking_price_provided",
      new_facts: {
        asking_price: 120000,
        occupancy_status: "vacant",
        condition_level: "full_rehab",
      },
      classification_confidence: 0.9,
    },
    expect: {
      stage_after: "offer",
      next_action: NEXT_ACTIONS.EXECUTE_ADE,
      ade_action: ADE_ACTIONS.RUN_FULL,
      lead_temperature: "hot",
    },
  },
  {
    name: "vacant / full rehab condition at S4 advances to S5",
    input: {
      stage_before: "property_condition",
      intent: "condition_disclosed",
      known_facts: { asking_price: { value: 90000 }, ownership_status: "confirmed", interest: "interested" },
      new_facts: { occupancy_status: "vacant", condition_level: "full_rehab" },
      classification_confidence: 0.88,
    },
    expect: { stage_after: "offer", ade_action: ADE_ACTIONS.RUN_FULL },
  },
  {
    name: "occupied / good condition at S4 advances to S5",
    input: {
      stage_before: "property_condition",
      intent: "condition_disclosed",
      known_facts: { asking_price: { value: 90000 }, ownership_status: "confirmed", interest: "interested" },
      new_facts: { occupancy_status: "owner_occupied", condition_level: "move_in_ready" },
      classification_confidence: 0.9,
    },
    expect: { stage_after: "offer" },
  },
  {
    name: "seller counter during S5 stays at S5 and negotiates",
    input: {
      stage_before: "offer",
      intent: "asking_price_provided",
      new_facts: { asking_price: 110000 },
      negotiation_state: { offers_made: 1, terms_accepted: false },
      ade_result: { recommended_offer: 85000, sufficient_facts: true },
      engine_decision: { acquisition_action: "narrow_gap_negotiation", template_use_case: "narrow_range" },
      classification_confidence: 0.9,
    },
    expect: {
      stage_after: "offer",
      next_action: NEXT_ACTIONS.NEGOTIATE,
      required_template_use_case: "narrow_range",
      ade_action: ADE_ACTIONS.RERUN_MATERIAL_FACTS,
    },
  },
  {
    name: "new condition fact during negotiation stays at S5 and reruns ADE",
    input: {
      stage_before: "offer",
      intent: "condition_disclosed",
      known_facts: { asking_price: { value: 100000 } },
      new_facts: { repairs_summary: "roof leaks" },
      negotiation_state: { offers_made: 1, terms_accepted: false },
      ade_result: { recommended_offer: 80000, sufficient_facts: true },
      classification_confidence: 0.85,
    },
    expect: { stage_after: "offer", ade_action: ADE_ACTIONS.RERUN_MATERIAL_FACTS },
  },
  {
    name: "seller accepts terms: S5 advances to S6 and generates contract",
    input: {
      stage_before: "offer",
      intent: "seller_interested",
      negotiation_state: { offers_made: 2, terms_accepted: true, accepted_price: 87500 },
      known_facts: { asking_price: { value: 95000 }, occupancy_status: "vacant", condition_level: "light_rehab" },
      classification_confidence: 0.93,
    },
    expect: {
      stage_after: "formal_contract",
      next_action: NEXT_ACTIONS.GENERATE_CONTRACT,
      lead_temperature: "hot",
    },
  },
  {
    name: "contract sent awaits signature at S6",
    input: {
      stage_before: "formal_contract",
      intent: "unclear",
      new_facts: { condition_disclosed: true },
      known_facts: { asking_price: { value: 95000 }, occupancy_status: "vacant", condition_level: "turnkey" },
      negotiation_state: { terms_accepted: true },
      contract_state: { sent: true, signed: false },
      classification_confidence: 0.9,
    },
    expect: {
      stage_after: "formal_contract",
      next_action: NEXT_ACTIONS.AWAIT_SIGNATURE,
      required_template_use_case: "signature_reminder",
    },
  },
  {
    // S6 → S7: seller contract executed (contract/disposition readiness) enters Dispo.
    name: "seller contract executed advances S6 → S7 dispo",
    input: {
      stage_before: "formal_contract",
      intent: "ownership_confirmed",
      known_facts: { asking_price: { value: 95000 }, occupancy_status: "vacant", condition_level: "turnkey" },
      negotiation_state: { terms_accepted: true },
      contract_state: { sent: true, signed: true, executed: true },
      classification_confidence: 0.95,
    },
    expect: { stage_after: "disposition", next_action: NEXT_ACTIONS.START_DISPOSITION },
  },
  {
    // S7 → S8: requires an authoritative buyer-contract event (buyer_selected).
    // "disposition started" alone keeps the deal in Dispo (S7).
    name: "disposition started alone does NOT advance past S7 dispo",
    input: {
      stage_before: "disposition",
      intent: "unclear",
      new_facts: { condition_disclosed: true },
      known_facts: { asking_price: { value: 95000 }, occupancy_status: "vacant", condition_level: "turnkey" },
      negotiation_state: { terms_accepted: true },
      contract_state: { executed: true },
      disposition_state: { started: true },
      classification_confidence: 0.9,
    },
    expect: { stage_after: "disposition", next_action: NEXT_ACTIONS.START_DISPOSITION },
  },
  {
    // S7 → S8: buyer under contract (authoritative buyer-contract event).
    name: "buyer under contract advances S7 → S8 under contract with buyer",
    input: {
      stage_before: "disposition",
      intent: "unclear",
      known_facts: { asking_price: { value: 95000 }, occupancy_status: "vacant", condition_level: "turnkey" },
      negotiation_state: { terms_accepted: true },
      contract_state: { executed: true },
      disposition_state: { started: true, buyer_selected: true },
      classification_confidence: 0.9,
    },
    expect: { stage_after: "under_contract", next_action: NEXT_ACTIONS.RESOLVE_CLOSING_BLOCKER },
  },
  {
    // S8 → S9: escrow/title event.
    name: "escrow ready advances S8 → S9 escrow",
    input: {
      stage_before: "under_contract",
      intent: "unclear",
      known_facts: { asking_price: { value: 95000 }, occupancy_status: "vacant", condition_level: "turnkey" },
      negotiation_state: { terms_accepted: true },
      contract_state: { executed: true },
      disposition_state: { started: true, buyer_selected: true },
      closing_readiness: { ready: true },
      classification_confidence: 0.9,
    },
    expect: { stage_after: "prepared_to_close", next_action: NEXT_ACTIONS.RESOLVE_CLOSING_BLOCKER },
  },
  {
    // S9 → S10: verified closing event.
    name: "verified closing advances S9 → S10 closed",
    input: {
      stage_before: "prepared_to_close",
      intent: "unclear",
      known_facts: { asking_price: { value: 95000 }, occupancy_status: "vacant", condition_level: "turnkey" },
      negotiation_state: { terms_accepted: true },
      contract_state: { executed: true },
      disposition_state: { started: true, buyer_selected: true },
      closing_readiness: { ready: true },
      closing_evidence: { closed: true, closed_at: NOW },
      classification_confidence: 0.9,
    },
    expect: { stage_after: "closed", next_action: NEXT_ACTIONS.CLOSE },
  },
];

for (const scenario of MATRIX) {
  test(scenario.name, () => {
    const result = resolve(scenario.input);

    for (const [key, expected] of Object.entries(scenario.expect)) {
      assert.equal(result[key], expected, `${key}: expected ${expected}, got ${result[key]}`);
    }
    if (scenario.contactability) {
      assert.equal(result.contactability_patch?.contactability_status, scenario.contactability);
    }
    if (scenario.ownership) {
      assert.equal(result.ownership_patch?.ownership_status, scenario.ownership);
    }
    if (scenario.cancels_followups) {
      assert.equal(result.follow_up.cancel, true);
    }
    if (scenario.alternate_contact) {
      assert.equal(result.evaluate_alternate_contact, true);
    }
    if (scenario.followup_days) {
      assert.equal(result.follow_up.create, true);
      assert.equal(result.follow_up.days, scenario.followup_days);
      assert.ok(result.next_action_due_at, "nurture must set next_action_due_at");
    }
    if (scenario.min_temperature) {
      const rank = { unscored: 0, cold: 1, warm: 2, hot: 3 };
      assert.ok(
        rank[result.lead_temperature] >= rank[scenario.min_temperature],
        `temperature ${result.lead_temperature} must be at least ${scenario.min_temperature}`
      );
    }
    // Universal invariants: monotonic stage + exactly one next action.
    assert.ok(result.stage_after_number >= result.stage_before_number, "stage must never regress");
    assert.ok(Object.values(NEXT_ACTIONS).includes(result.next_action), "next_action must be canonical");
    assert.ok(result.reasoning_code, "reasoning_code is mandatory");
  });
}

// ─── Invariant-focused tests ─────────────────────────────────────────────────

test("stage never regresses even when facts imply an earlier milestone", () => {
  const result = resolve({
    stage_before: "offer",
    intent: "asking_price_provided",
    new_facts: { asking_price: 105000 },
    classification_confidence: 0.9,
  });
  assert.equal(result.stage_after, "offer");
  assert.equal(result.advanced, false);
});

test("blocking intents never regress or advance the stage", () => {
  for (const intent of ["opt_out", "wrong_number", "wrong_person", "hostile_or_legal"]) {
    const result = resolve({ stage_before: "offer", intent });
    assert.equal(result.stage_after, "offer", `${intent} must hold stage`);
    assert.equal(result.stages_advanced, 0);
  }
});

test("hostile_or_legal requires human review", () => {
  const result = resolve({ stage_before: "offer_interest", intent: "hostile_or_legal" });
  assert.equal(result.review_required, true);
  assert.equal(result.next_action, NEXT_ACTIONS.HUMAN_REVIEW);
});

test("ambiguous reply at same stage routes to review without advancing", () => {
  const result = resolve({ stage_before: "asking_price", intent: "unclear", classification_confidence: 0.4 });
  assert.equal(result.stage_after, "asking_price");
  assert.equal(result.next_action, NEXT_ACTIONS.HUMAN_REVIEW);
  assert.equal(result.review_required, true);
});

test("low-confidence multi-stage advancement is flagged for review", () => {
  const result = resolve({
    stage_before: "ownership_confirmation",
    intent: "asking_price_provided",
    new_facts: { asking_price: 95000 },
    classification_confidence: 0.5,
  });
  assert.equal(result.stage_after, "property_condition");
  assert.equal(result.review_required, true);
  assert.equal(result.next_action, NEXT_ACTIONS.HUMAN_REVIEW);
});

test("asking price fact persists value, currency, confidence, source and timestamp", () => {
  const result = resolve({
    stage_before: "offer_interest",
    intent: "asking_price_provided",
    new_facts: { asking_price: { value: 95000, raw: "95k" } },
    classification_confidence: 0.91,
    source_message_id: "evt-777",
  });
  const fact = result.facts_patch.asking_price;
  assert.equal(fact.value, 95000);
  assert.equal(fact.currency, "USD");
  assert.equal(fact.confidence, 0.91);
  assert.equal(fact.source_message_id, "evt-777");
  assert.equal(fact.extracted_text, "95k");
  assert.equal(fact.captured_at, NOW);
});

test("a reply always cancels stale reply-pending follow-ups on the positive path", () => {
  const result = resolve({
    stage_before: "offer_interest",
    intent: "seller_interested",
    classification_confidence: 0.9,
  });
  assert.equal(result.follow_up.cancel, true);
});

test("workflow events are emitted for multi-stage advancement", () => {
  const result = resolve({
    stage_before: "ownership_confirmation",
    intent: "asking_price_provided",
    new_facts: { asking_price: 95000 },
    classification_confidence: 0.92,
  });
  assert.ok(result.workflow_event_types.includes("OWNER_CONFIRMED"));
  assert.ok(result.workflow_event_types.includes("OFFER_INTEREST_CONFIRMED"));
  assert.ok(result.workflow_event_types.includes("SELLER_ASKING_PRICE_CAPTURED"));
});

// ─── Helper units ────────────────────────────────────────────────────────────

test("mergeSellerFacts keeps known facts and lets new facts win", () => {
  const merged = mergeSellerFacts(
    { occupancy_status: "unknown", ownership_status: "confirmed" },
    { occupancy_status: "vacant", asking_price: 90000 },
    { sourceMessageId: "m1", now: NOW }
  );
  assert.equal(merged.occupancy_status, "vacant");
  assert.equal(merged.ownership_status, "confirmed");
  assert.equal(merged.asking_price.value, 90000);
});

test("hasMinimumConditionFacts requires occupancy plus a condition signal", () => {
  assert.equal(hasMinimumConditionFacts({}), false);
  assert.equal(hasMinimumConditionFacts({ occupancy_status: "vacant" }), false);
  assert.equal(hasMinimumConditionFacts({ condition_level: "full_rehab" }), false);
  assert.equal(hasMinimumConditionFacts({ occupancy_status: "vacant", condition_level: "full_rehab" }), true);
});

test("normalizeAskingPriceFact rejects junk and normalizes shapes", () => {
  assert.equal(normalizeAskingPriceFact(null), null);
  assert.equal(normalizeAskingPriceFact(0), null);
  assert.equal(normalizeAskingPriceFact(-5), null);
  assert.equal(normalizeAskingPriceFact("abc"), null);
  assert.equal(normalizeAskingPriceFact(95000).value, 95000);
  assert.equal(normalizeAskingPriceFact({ value: "120000", price_type: "Range" }).price_type, "range");
});
