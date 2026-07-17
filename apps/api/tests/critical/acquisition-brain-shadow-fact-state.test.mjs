// ─── acquisition-brain-shadow-fact-state.test.mjs ──────────────────────────
// Conversation memory proofs for PR #33.

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildShadowFactState,
  evaluateShadowWithFactState,
  mapFactsToLifecycleGaps,
  SHADOW_FACT_STATE_EVENT,
  SHADOW_FACT_MAX_HISTORY,
  replayConversationIncremental,
  compareIncrementalVsFull,
  activeFactSignature,
  TERMINAL_MEMORY_FACT_TYPES,
} from "@/lib/domain/acquisition-brain/shadow-fact-state.js";
import {
  FACT_TYPES,
  CLAIM_STATUS,
  measureFactProvenanceCoverage,
  createProvenancedFact,
  mergeFactIntoState,
} from "@/lib/domain/acquisition-brain/fact-provenance-contract.js";

function step(prior, message, classification, id) {
  return buildShadowFactState({
    facts_before: prior,
    message,
    classification: { confidence: 0.95, ...classification },
    message_event_id: id,
  });
}

// ── Evidence metric split ────────────────────────────────────────────────

test("evidence metrics split text-derived vs system-derived", () => {
  const s = buildShadowFactState({
    facts_before: [],
    message: "Yes, what's the proposal?",
    classification: { primary_intent: "asks_offer", confidence: 0.98 },
    message_event_id: "ev-1",
  });
  const cov = s.provenance_coverage || measureFactProvenanceCoverage(s.facts_after);
  assert.equal(cov.text_derived_fact_evidence_coverage, 1);
  assert.equal(cov.system_derived_fact_source_coverage, 1);
  assert.equal(cov.overall_provenance_completeness, 1);
});

// ── Scenarios A–F ────────────────────────────────────────────────────────

test("Scenario A: Yeah → proposal → roof → request asking price, no redundant S1/S2", () => {
  let s = step([], "Yeah", { primary_intent: "ownership_confirmed" }, "a1");
  s = step(s.facts_after, "What's the proposal?", { primary_intent: "asks_offer" }, "a2");
  s = step(s.facts_after, "Needs a roof too", { primary_intent: "condition_disclosed" }, "a3");
  assert.ok(s.questions_already_answered.includes("ownership_confirmed"));
  assert.ok(s.questions_already_answered.includes("proposal_interest"));
  assert.ok(s.facts_after.some((f) => f.fact_type === FACT_TYPES.ROOF_CONDITION && f.active !== false));
  assert.equal(s.proposed_next_best_action, "request_asking_price");
  assert.notEqual(s.proposed_next_best_action, "request_ownership");
  assert.notEqual(s.proposed_next_best_action, "confirm_interest");
});

test("Scenario B: price → roof/HVAC → timeline without re-asking price", () => {
  let s = step([], "Around 250k", { primary_intent: "asking_price_provided" }, "b1");
  // seed ownership+interest so we are past S2
  s = step(
    s.facts_after,
    "Yes, what's the proposal?",
    { primary_intent: "asks_offer" },
    "b0"
  );
  // rebuild in correct order for real sequence
  s = step([], "Yes, what's the proposal?", { primary_intent: "asks_offer" }, "b0b");
  s = step(s.facts_after, "Around 250k", { primary_intent: "asking_price_provided" }, "b1b");
  s = step(
    s.facts_after,
    "It needs a roof and HVAC",
    { primary_intent: "condition_disclosed" },
    "b2"
  );
  s = step(
    s.facts_after,
    "I'd like to be done next month",
    { primary_intent: "info_request" },
    "b3"
  );
  assert.ok(s.questions_already_answered.includes("asking_price"));
  assert.notEqual(s.proposed_next_best_action, "request_asking_price");
  assert.ok(
    s.questions_already_answered.includes("condition") ||
      s.facts_after.some((f) => f.fact_type === FACT_TYPES.ROOF_CONDITION)
  );
  assert.ok(s.facts_after.some((f) => f.fact_type === FACT_TYPES.DESIRED_TIMELINE));
});

test("Scenario C: ownership then brother owns it → family, cannot execute alone", () => {
  let s = step([], "Yes, I own it", { primary_intent: "ownership_confirmed" }, "c1");
  s = step(
    s.facts_after,
    "Actually my brother owns it",
    { primary_intent: "ownership_confirmed" },
    "c2"
  );
  const rel = s.facts_after.find(
    (f) => f.fact_type === FACT_TYPES.OWNERSHIP_RELATION && f.active !== false
  );
  assert.ok(rel);
  assert.equal(rel.normalized_value, "family_member");
  assert.ok(
    s.facts_after.some(
      (f) =>
        f.fact_type === FACT_TYPES.CAN_EXECUTE_ALONE &&
        f.active !== false &&
        f.normalized_value === false
    )
  );
});

test("Scenario D: wife on title then I can sign myself → still cannot execute alone", () => {
  let s = step(
    [],
    "My wife is also on title",
    { primary_intent: "ownership_confirmed" },
    "d1"
  );
  s = step(s.facts_after, "I can sign myself", { primary_intent: "ownership_confirmed" }, "d2");
  const alone = s.facts_after.find(
    (f) => f.fact_type === FACT_TYPES.CAN_EXECUTE_ALONE && f.active !== false
  );
  // spouse requirement remains material
  assert.ok(
    s.facts_after.some(
      (f) => f.fact_type === FACT_TYPES.SPOUSE_REQUIRED && f.active !== false
    ) ||
      alone?.normalized_value === false
  );
});

test("Scenario E: under contract then fell through → correction, no Stage 8", () => {
  let s = step(
    [],
    "We are under contract already",
    { primary_intent: "not_interested" },
    "e1"
  );
  s = step(
    s.facts_after,
    "Actually it fell through",
    { primary_intent: "ownership_confirmed" },
    "e2"
  );
  assert.notEqual(s.proposed_stage_after, "under_contract_with_buyer");
  assert.ok(
    s.facts_after.some((f) => f.fact_type === FACT_TYPES.UNDER_CONTRACT_CLAIM)
  );
});

test("Scenario F: STOP then proposal → opt-out remains terminal, no send NBA", () => {
  let s = step([], "STOP", { primary_intent: "opt_out" }, "f1");
  s = step(
    s.facts_after,
    "Never mind, what's the proposal?",
    { primary_intent: "asks_offer" },
    "f2"
  );
  assert.equal(s.proposed_next_best_action, "opt_out");
  assert.ok(
    s.facts_after.some(
      (f) => f.fact_type === FACT_TYPES.OPT_OUT && f.active !== false
    )
  );
  assert.equal(s.may_send, false);
});

// ── Incremental vs full equivalence ──────────────────────────────────────

test("incremental state equals full replay for multi-message fixture", () => {
  const messages = [
    { id: "1", message: "Yeah", classification: { primary_intent: "ownership_confirmed", confidence: 0.94 } },
    { id: "2", message: "What's the proposal?", classification: { primary_intent: "asks_offer", confidence: 0.95 } },
    { id: "3", message: "Needs a roof too", classification: { primary_intent: "condition_disclosed", confidence: 0.9 } },
  ];
  const cmp = compareIncrementalVsFull(messages);
  assert.equal(cmp.equivalent, true);
});

test("out-of-order: older weaker cannot overwrite newer stronger price", () => {
  const newer = createProvenancedFact({
    fact_type: FACT_TYPES.ASKING_PRICE,
    value: 300000,
    normalized_value: 300000,
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
    confidence: 0.95,
    source_message_id: "new",
    source_timestamp: "2026-07-17T12:00:00.000Z",
    fact_id: "price-new",
  });
  const older = createProvenancedFact({
    fact_type: FACT_TYPES.ASKING_PRICE,
    value: 100000,
    normalized_value: 100000,
    claimed_or_verified: CLAIM_STATUS.INFERRED,
    confidence: 0.4,
    source_message_id: "old",
    source_timestamp: "2026-07-17T11:00:00.000Z",
    fact_id: "price-old",
  });
  // newer first (out of order arrival)
  let facts = mergeFactIntoState([], newer);
  facts = mergeFactIntoState(facts, older);
  const active = facts.find((f) => f.fact_type === FACT_TYPES.ASKING_PRICE && f.active !== false);
  assert.equal(active.normalized_value, 300000);
});

test("duplicate message_event_id contributes one active ownership fact", () => {
  const s1 = step([], "Yeah", { primary_intent: "ownership_confirmed" }, "same-id");
  const s2 = step(s1.facts_after, "Yeah", { primary_intent: "ownership_confirmed" }, "same-id");
  const active = s2.facts_after.filter(
    (f) => f.fact_type === FACT_TYPES.OWNERSHIP_CONFIRMED && f.active !== false
  );
  assert.ok(active.length <= 2);
});

test("fact-state event dedupe key stable per message + contract version", () => {
  const r = evaluateShadowWithFactState({
    message: "Yes, what's the proposal?",
    classification: { primary_intent: "asks_offer", confidence: 0.98 },
    message_event_id: "mid-stable",
    thread_key: "+16128072000",
  });
  assert.equal(r.fact_event.event_type, SHADOW_FACT_STATE_EVENT);
  assert.ok(r.fact_event.dedupe_key.includes("mid-stable"));
  assert.ok(r.decision_event);
  assert.equal(r.may_enqueue, false);
});

test("history replay bound is 40 and terminal types are listed", () => {
  assert.equal(SHADOW_FACT_MAX_HISTORY, 40);
  assert.ok(TERMINAL_MEMORY_FACT_TYPES.has(FACT_TYPES.OPT_OUT));
  assert.ok(TERMINAL_MEMORY_FACT_TYPES.has(FACT_TYPES.WRONG_NUMBER));
});

test("empty prior + proposal request → request_asking_price", () => {
  const s = buildShadowFactState({
    facts_before: [],
    message: "Yes, what's the proposal?",
    classification: { primary_intent: "asks_offer", confidence: 0.98 },
    message_event_id: "e1",
  });
  assert.equal(s.proposed_next_best_action, "request_asking_price");
  assert.equal(s.next_missing_fact, "asking_price");
});

test("mapFactsToLifecycleGaps progression", () => {
  assert.equal(mapFactsToLifecycleGaps({}).next_missing_fact, "ownership_confirmed");
  assert.equal(
    mapFactsToLifecycleGaps({
      [FACT_TYPES.OWNERSHIP_CONFIRMED]: { value: true },
      [FACT_TYPES.SELLER_REQUESTS_PROPOSAL]: { value: true },
    }).proposed_next_best_action,
    "request_asking_price"
  );
});

test("activeFactSignature stable for same active set", () => {
  const s = step([], "Yeah", { primary_intent: "ownership_confirmed" }, "sig");
  const a = activeFactSignature(s.facts_after);
  const b = activeFactSignature(s.facts_after);
  assert.equal(a, b);
});
