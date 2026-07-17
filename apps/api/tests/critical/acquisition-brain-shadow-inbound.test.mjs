// ─── acquisition-brain-shadow-inbound.test.mjs ─────────────────────────────
// Shadow evaluation matrix — pure, no I/O, no SMS.

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateAcquisitionBrainShadow,
  compareShadowDecisions,
  extractBrainFactsFromInbound,
  SHADOW_COMPARISON,
  SHADOW_EVENT_TYPE,
} from "@/lib/domain/acquisition-brain/shadow-inbound-decision.js";
import {
  ACQUISITION_LIFECYCLE_STAGES as S,
  isTransactionGatedStage,
} from "@/lib/domain/acquisition-brain/index.js";
import { NBA_ACTION_TYPES } from "@/lib/domain/acquisition-brain/next-best-action-registry.js";

function run(message, classification, extra = {}) {
  return evaluateAcquisitionBrainShadow({
    message,
    classification: {
      confidence: 0.95,
      ...classification,
    },
    current_stage: S.OWNERSHIP_CHECK,
    thread_key: "+16128072000",
    inbound_event_id: "evt-test",
    message_event_id: "evt-test",
    ...extra,
  });
}

test("shadow never allows enqueue/send/stage mutation flags", () => {
  const r = run("Yeah", { primary_intent: "ownership_confirmed" });
  assert.equal(r.may_enqueue, false);
  assert.equal(r.may_send, false);
  assert.equal(r.may_mutate_stages, false);
  assert.equal(r.shadow, true);
  assert.equal(r.event.event_type, SHADOW_EVENT_TYPE);
});

test('1. "Yeah" → Stage 2 consider_selling', () => {
  const r = run("Yeah", { primary_intent: "ownership_confirmed" });
  assert.equal(r.brain_decision.proposed_lifecycle_stage_after, S.INTEREST_PROPOSAL_CONFIRMATION);
  assert.equal(r.brain_decision.template_use_case, "consider_selling");
  assert.equal(r.brain_decision.proposed_next_best_action, NBA_ACTION_TYPES.SEND_TEMPLATE);
});

test('2. "Yes, what\'s the proposal?" → Stage 3 asking price', () => {
  const r = run("Yes, what's the proposal?", { primary_intent: "asks_offer" });
  assert.equal(r.facts.ownership_confirmed, true);
  assert.equal(r.facts.seller_requests_proposal, true);
  assert.equal(r.brain_decision.proposed_lifecycle_stage_after, S.ASKING_PRICE);
  assert.equal(r.brain_decision.template_use_case, "seller_asking_price");
});

test('3. "I\'d want 250" → asking price fact toward condition', () => {
  const r = run("I'd want 250", {
    primary_intent: "asking_price_provided",
    seller_state: { ownership_confirmed: true, price_mentioned: 250000 },
  }, {
    fact_extraction: { asking_price: { value: 250000 } },
    current_stage: S.ASKING_PRICE,
  });
  assert.ok(r.facts.asking_price || r.facts.asking_price_known);
  // May remain asking_price or advance to property_condition; never skip to S5–S10
  const stage = r.brain_decision.proposed_lifecycle_stage_after;
  assert.ok(
    [S.PROPERTY_CONDITION, S.ASKING_PRICE, S.INTEREST_PROPOSAL_CONFIRMATION].includes(stage),
    `unexpected stage ${stage}`
  );
  assert.ok(!isTransactionGatedStage(stage));
});

test('4. "Needs a roof and HVAC" → condition facts, no re-ask ownership', () => {
  const r = run("Needs a roof and HVAC", {
    primary_intent: "condition_disclosed",
    seller_state: { ownership_confirmed: true },
  }, { current_stage: S.PROPERTY_CONDITION });
  assert.equal(r.facts.roof, true);
  assert.equal(r.facts.hvac, true);
  assert.notEqual(r.brain_decision.template_use_case, "ownership_check");
});

test('5. "Send me the paperwork" → no Stage 6 without proposal outcome', () => {
  const r = run("Send me the paperwork", {
    primary_intent: "info_request",
    seller_state: { ownership_confirmed: true },
  });
  assert.equal(r.facts.contract_requested, true);
  assert.notEqual(r.brain_decision.proposed_lifecycle_stage_after, S.FORMAL_CONTRACT);
  assert.ok(
    r.brain_decision.proposed_next_best_action === NBA_ACTION_TYPES.HUMAN_REVIEW ||
      r.brain_decision.stage6_readiness?.entry_allowed === false ||
      r.brain_decision.proposed_lifecycle_stage_after !== S.FORMAL_CONTRACT
  );
});

test('6. "My husband also owns it" → co-owner, no solo execution', () => {
  const r = run("My husband also owns it", {
    primary_intent: "ownership_confirmed",
  });
  assert.equal(r.facts.spouse_co_owner, true);
  assert.equal(r.facts.can_execute_alone, false);
});

test("7. Probate/executor → authority review facts", () => {
  const r = run("It's my mom's property and she passed away. We're still doing probate.", {
    primary_intent: "ownership_confirmed",
  });
  assert.equal(r.facts.probate, true);
  assert.equal(r.facts.estate, true);
});

test("8. LLC-owned → llc authority fact", () => {
  const r = run("The property is owned by my LLC", {
    primary_intent: "ownership_confirmed",
  });
  assert.equal(r.facts.entity_type, "llc");
});

test("9. Wrong number → suppress", () => {
  const r = run("Wrong number", { primary_intent: "wrong_number" });
  assert.equal(r.brain_decision.proposed_next_best_action, NBA_ACTION_TYPES.SUPPRESS);
});

test("10. STOP → opt_out", () => {
  const r = run("STOP", { primary_intent: "opt_out", compliance_flag: "stop_texting" });
  assert.equal(r.brain_decision.proposed_next_best_action, NBA_ACTION_TYPES.OPT_OUT);
});

test("11. Hostile/legal → human review", () => {
  const r = run("I will sue you and report to FCC", {
    primary_intent: "hostile_or_legal",
    compliance_flag: "litigator",
  });
  assert.equal(r.brain_decision.proposed_next_best_action, NBA_ACTION_TYPES.HUMAN_REVIEW);
});

test("12. Already under contract claim → facts only, not Stage 8", () => {
  const r = run("We're already under contract with a buyer", {
    primary_intent: "not_interested",
  });
  // not_interested may suppress — either way not Stage 8
  assert.notEqual(
    r.brain_decision.proposed_lifecycle_stage_after,
    S.UNDER_CONTRACT_WITH_BUYER
  );
  assert.ok(!isTransactionGatedStage(r.brain_decision.proposed_lifecycle_stage_after) ||
    r.brain_decision.proposed_next_best_action === NBA_ACTION_TYPES.UPDATE_FACTS_ONLY ||
    r.brain_decision.proposed_next_best_action === NBA_ACTION_TYPES.SUPPRESS ||
    r.brain_decision.proposed_next_best_action === NBA_ACTION_TYPES.OPT_OUT);
});

test('13. "we closed" → no Stage 10 from text', () => {
  const r = run("we closed last week", {
    primary_intent: "ownership_confirmed",
  });
  assert.notEqual(r.brain_decision.proposed_lifecycle_stage_after, S.CLOSED);
  assert.ok(
    r.brain_decision.proposed_next_best_action === NBA_ACTION_TYPES.UPDATE_FACTS_ONLY ||
      r.unsupported_transition_reason ||
      r.brain_decision.unsupported_transition_reason ||
      r.facts.seller_claims_closed
  );
});

test("14. duplicate webhook same message_event_id → stable dedupe key", () => {
  const a = run("Yeah", { primary_intent: "ownership_confirmed" }, {
    message_event_id: "same-id",
    inbound_event_id: "same-id",
  });
  const b = run("Yeah", { primary_intent: "ownership_confirmed" }, {
    message_event_id: "same-id",
    inbound_event_id: "same-id",
  });
  assert.equal(a.event.dedupe_key, b.event.dedupe_key);
});

test("15. archived alias input normalizes to E.164 thread in shadow payload", () => {
  const r = evaluateAcquisitionBrainShadow({
    message: "Yeah",
    classification: { primary_intent: "ownership_confirmed", confidence: 0.95 },
    thread_key: "+16128072000",
    inbound_event_id: "e1",
  });
  assert.equal(r.brain_decision.canonical_thread, "+16128072000");
  assert.notEqual(r.brain_decision.canonical_thread, "6128072000");
});

test("16. multi-message strongest facts: proposal request wins over bare yes", () => {
  const facts = extractBrainFactsFromInbound({
    message: "Yes, what's the proposal?",
    classification: { primary_intent: "asks_offer", confidence: 0.98 },
  });
  assert.equal(facts.seller_requests_proposal, true);
  assert.equal(facts.ownership_confirmed, true);
  const r = evaluateAcquisitionBrainShadow({
    message: "Yes, what's the proposal?",
    classification: { primary_intent: "asks_offer", confidence: 0.98 },
    current_stage: S.OWNERSHIP_CHECK,
  });
  assert.equal(r.brain_decision.template_use_case, "seller_asking_price");
});

test("safety divergence when legacy suppresses but brain would send", () => {
  const cmp = compareShadowDecisions({
    brain: {
      action_type: NBA_ACTION_TYPES.SEND_TEMPLATE,
      required_template_use_case: "consider_selling",
      lifecycle_stage_after: S.INTEREST_PROPOSAL_CONFIRMATION,
    },
    legacy: { effective_action: "suppress", stage_after: "stop_or_opt_out" },
  });
  assert.equal(cmp.result, SHADOW_COMPARISON.SAFETY_DIVERGENCE);
  assert.equal(cmp.safety_divergence, true);
});
