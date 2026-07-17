// ─── acquisition-brain-shadow-fact-state.test.mjs ──────────────────────────
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildShadowFactState,
  evaluateShadowWithFactState,
  mapFactsToLifecycleGaps,
  SHADOW_FACT_STATE_EVENT,
} from "@/lib/domain/acquisition-brain/shadow-fact-state.js";
import { FACT_TYPES } from "@/lib/domain/acquisition-brain/fact-provenance-contract.js";

test("empty prior + proposal request → request_asking_price", () => {
  const s = buildShadowFactState({
    facts_before: [],
    message: "Yes, what's the proposal?",
    classification: { primary_intent: "asks_offer", confidence: 0.98 },
    message_event_id: "e1",
  });
  assert.equal(s.may_send, false);
  assert.equal(s.may_enqueue, false);
  assert.ok(s.facts_extracted.length >= 2);
  assert.equal(s.proposed_next_best_action, "request_asking_price");
  assert.ok(s.questions_already_answered.includes("ownership_confirmed"));
  assert.ok(s.questions_already_answered.includes("proposal_interest"));
  assert.equal(s.next_missing_fact, "asking_price");
});

test("continuity: after proposal ask, next inbound price+repairs does not re-ask price", () => {
  const first = buildShadowFactState({
    facts_before: [],
    message: "Yes, what's the proposal?",
    classification: { primary_intent: "asks_offer", confidence: 0.98 },
    message_event_id: "e1",
  });
  const second = buildShadowFactState({
    facts_before: first.facts_after,
    message: "Around 250k, but it needs a roof and HVAC.",
    classification: { primary_intent: "asking_price_provided", confidence: 0.92 },
    message_event_id: "e2",
  });
  assert.ok(second.questions_already_answered.includes("asking_price"));
  assert.notEqual(second.proposed_next_best_action, "request_asking_price");
  // Next missing is not asking_price again — condition may already be filled by roof/HVAC
  assert.ok(
    second.proposed_next_best_action === "request_condition" ||
      second.proposed_next_best_action === "prepare_proposal_review" ||
      second.questions_already_answered.includes("condition")
  );
  assert.notEqual(second.next_missing_fact, "asking_price");
});

test("multi-message Yeah + proposal + roof merges", () => {
  let state = buildShadowFactState({
    facts_before: [],
    message: "Yeah",
    classification: { primary_intent: "ownership_confirmed", confidence: 0.94 },
    message_event_id: "a",
  });
  state = buildShadowFactState({
    facts_before: state.facts_after,
    message: "What's the proposal?",
    classification: { primary_intent: "asks_offer", confidence: 0.95 },
    message_event_id: "b",
  });
  state = buildShadowFactState({
    facts_before: state.facts_after,
    message: "Needs a roof too",
    classification: { primary_intent: "condition_disclosed", confidence: 0.9 },
    message_event_id: "c",
  });
  assert.ok(state.questions_already_answered.includes("ownership_confirmed"));
  assert.ok(state.questions_already_answered.includes("proposal_interest"));
  assert.ok(state.facts_after.some((f) => f.fact_type === FACT_TYPES.ROOF_CONDITION));
  assert.equal(state.may_mutate_stages, false);
});

test("transaction claim does not open under_contract stage", () => {
  const s = buildShadowFactState({
    facts_before: [],
    message: "We are already under contract",
    classification: { primary_intent: "not_interested", confidence: 0.9 },
    message_event_id: "t1",
  });
  assert.notEqual(s.proposed_stage_after, "under_contract_with_buyer");
  assert.ok(s.facts_after.some((f) => f.fact_type === FACT_TYPES.UNDER_CONTRACT_CLAIM));
});

test("evaluateShadowWithFactState emits dual event contracts with dedupe", () => {
  const r = evaluateShadowWithFactState({
    message: "Yes, what's the proposal?",
    classification: { primary_intent: "asks_offer", confidence: 0.98 },
    message_event_id: "mid-1",
    thread_key: "+16128072000",
    stage_before: "ownership_check",
  });
  assert.equal(r.fact_event.event_type, SHADOW_FACT_STATE_EVENT);
  assert.ok(r.fact_event.dedupe_key.includes("mid-1"));
  assert.ok(r.decision_event);
  assert.equal(r.may_send, false);
  assert.equal(r.continuity.forbidden_redundant.ownership, false);
  assert.equal(r.continuity.forbidden_redundant.interest, false);
});

test("mapFactsToLifecycleGaps next missing progression", () => {
  const gaps0 = mapFactsToLifecycleGaps({});
  assert.equal(gaps0.next_missing_fact, "ownership_confirmed");
  const gaps1 = mapFactsToLifecycleGaps({
    [FACT_TYPES.OWNERSHIP_CONFIRMED]: { value: true },
  });
  assert.equal(gaps1.next_missing_fact, "proposal_interest");
  const gaps2 = mapFactsToLifecycleGaps({
    [FACT_TYPES.OWNERSHIP_CONFIRMED]: { value: true },
    [FACT_TYPES.SELLER_REQUESTS_PROPOSAL]: { value: true },
  });
  assert.equal(gaps2.next_missing_fact, "asking_price");
  assert.equal(gaps2.proposed_next_best_action, "request_asking_price");
});

test("duplicate extraction same message id does not explode active set", () => {
  const s1 = buildShadowFactState({
    facts_before: [],
    message: "Yeah",
    classification: { primary_intent: "ownership_confirmed", confidence: 0.9 },
    message_event_id: "same",
  });
  const s2 = buildShadowFactState({
    facts_before: s1.facts_after,
    message: "Yeah",
    classification: { primary_intent: "ownership_confirmed", confidence: 0.9 },
    message_event_id: "same",
  });
  const active_own = s2.facts_after.filter(
    (f) => f.fact_type === FACT_TYPES.OWNERSHIP_CONFIRMED && f.active !== false
  );
  assert.ok(active_own.length <= 2);
});
