// ─── acquisition-brain-fact-provenance.test.mjs ────────────────────────────
// PR B: multi-label facts + provenance + precedence (not transport-authoritative).

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  FACT_TYPES,
  CLAIM_STATUS,
  createProvenancedFact,
  factPrecedenceScore,
  mergeFactIntoState,
  buildClassifierResultContract,
  resolveActiveFacts,
} from "@/lib/domain/acquisition-brain/fact-provenance-contract.js";

test("createProvenancedFact includes full provenance fields", () => {
  const f = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_CONFIRMED,
    value: true,
    confidence: 0.94,
    evidence_span: { text: "Yeah", start: 0, end: 4 },
    source_message_id: "msg-1",
    classifier_version: "classify_js_v1",
  });
  assert.equal(f.fact_type, FACT_TYPES.OWNERSHIP_CONFIRMED);
  assert.equal(f.source_message_id, "msg-1");
  assert.ok(f.fact_id);
  assert.equal(f.active, true);
  assert.equal(f.claimed_or_verified, CLAIM_STATUS.CLAIMED);
  assert.ok(f.first_observed_at);
  assert.ok(Array.isArray(f.conflicts_with_fact_ids));
});

test("multi-label: Yes what's the proposal → ownership + interest + request", () => {
  const r = buildClassifierResultContract({
    message: "Yes, what's the proposal?",
    classification: { primary_intent: "asks_offer", confidence: 0.98 },
    source_message_id: "m1",
  });
  assert.equal(r.primary_intent, "asks_offer");
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.OWNERSHIP_CONFIRMED));
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.SELLER_REQUESTS_PROPOSAL));
  assert.equal(r.proposal_interest, true);
  assert.equal(r.recommended_stage, "asking_price");
  assert.equal(r.recommended_next_action, "request_asking_price");
  assert.ok(r.facts.every((f) => f.evidence_span || f.fact_type));
});

test("verified beats claimed; weak later does not erase strong prior", () => {
  const strong = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_CONFIRMED,
    value: true,
    confidence: 0.99,
    claimed_or_verified: CLAIM_STATUS.VERIFIED,
    source_message_id: "m1",
  });
  const weak = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_CONFIRMED,
    value: false,
    confidence: 0.4,
    claimed_or_verified: CLAIM_STATUS.INFERRED,
    source_message_id: "m2",
  });
  const merged = mergeFactIntoState([strong], weak);
  const active = resolveActiveFacts(merged);
  assert.equal(active[FACT_TYPES.OWNERSHIP_CONFIRMED].value, true);
  assert.equal(active[FACT_TYPES.OWNERSHIP_CONFIRMED].claimed_or_verified, CLAIM_STATUS.VERIFIED);
});

test("explicit correction supersedes older claim", () => {
  const first = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_RELATION,
    value: "owner",
    normalized_value: "owner",
    confidence: 0.8,
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
    source_message_id: "m1",
  });
  const correction = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_RELATION,
    value: "family_member",
    normalized_value: "family_member",
    confidence: 0.95,
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
    source_message_id: "m2",
  });
  const merged = mergeFactIntoState([first], correction);
  const active = resolveActiveFacts(merged);
  assert.equal(active[FACT_TYPES.OWNERSHIP_RELATION].normalized_value, "family_member");
  assert.ok(
    active[FACT_TYPES.OWNERSHIP_RELATION].supersedes_fact_id === first.fact_id ||
      merged.some((f) => f.supersedes_fact_id === first.fact_id)
  );
});

test("co-owner sets can_execute_alone false", () => {
  const r = buildClassifierResultContract({
    message: "My wife is also on title",
    classification: { primary_intent: "ownership_confirmed", confidence: 0.9 },
    source_message_id: "m3",
  });
  const auth = r.authority_signers;
  assert.equal(auth?.can_execute_alone, false);
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.CO_OWNER));
});

test("LLC / trust / probate entity facts", () => {
  for (const [msg, entity] of [
    ["Owned by my LLC", "llc"],
    ["It's in a trust", "trust"],
  ]) {
    const r = buildClassifierResultContract({
      message: msg,
      classification: { primary_intent: "ownership_confirmed", confidence: 0.9 },
    });
    assert.ok(
      r.facts.some(
        (f) => f.fact_type === FACT_TYPES.ENTITY_TYPE && f.normalized_value === entity
      ),
      msg
    );
  }
  const probate = buildClassifierResultContract({
    message: "Mom passed away, still in probate",
    classification: { primary_intent: "ownership_confirmed", confidence: 0.9 },
  });
  assert.equal(probate.ownership_relation, "estate");
  assert.equal(probate.human_review_required, true);
});

test("asking price parse + condition multi-fact", () => {
  const price = buildClassifierResultContract({
    message: "I'd want 250k",
    classification: { primary_intent: "asking_price_provided", confidence: 0.92 },
  });
  assert.equal(price.asking_price, 250000);
  assert.equal(price.asking_price_currency, "USD");

  const cond = buildClassifierResultContract({
    message: "Needs a roof and HVAC",
    classification: { primary_intent: "condition_disclosed", confidence: 0.9 },
  });
  assert.ok(cond.condition_facts?.repairs?.includes("roof"));
  assert.ok(cond.condition_facts?.repairs?.includes("hvac"));
});

test("opt-out and wrong-number are terminal verified", () => {
  const stop = buildClassifierResultContract({
    message: "STOP",
    classification: { primary_intent: "opt_out", confidence: 1 },
  });
  assert.equal(stop.opt_out, true);
  assert.equal(stop.recommended_next_action, "opt_out");

  const wrong = buildClassifierResultContract({
    message: "Wrong number",
    classification: { primary_intent: "wrong_number", confidence: 1 },
  });
  assert.equal(wrong.wrong_number, true);
  assert.equal(wrong.recommended_next_action, "suppress");
});

test("transaction claim remains claimed/unverified — not Stage 10", () => {
  const r = buildClassifierResultContract({
    message: "We already closed last week",
    classification: { primary_intent: "ownership_confirmed", confidence: 0.9 },
  });
  const claim = r.facts.find((f) => f.fact_type === FACT_TYPES.TRANSACTION_CLAIM);
  assert.ok(claim);
  assert.equal(claim.claimed_or_verified, CLAIM_STATUS.CLAIMED);
  assert.notEqual(r.recommended_stage, "closed");
});

test("Spanish language fact", () => {
  const r = buildClassifierResultContract({
    message: "Sí, me interesa la propiedad",
    classification: { primary_intent: "ownership_confirmed", language: "Spanish", confidence: 0.9 },
  });
  assert.equal(r.language, "Spanish");
});

test("factPrecedenceScore orders verified above inferred", () => {
  const v = createProvenancedFact({
    fact_type: FACT_TYPES.ASKING_PRICE,
    value: 1,
    claimed_or_verified: CLAIM_STATUS.VERIFIED,
    confidence: 0.5,
  });
  const i = createProvenancedFact({
    fact_type: FACT_TYPES.ASKING_PRICE,
    value: 2,
    claimed_or_verified: CLAIM_STATUS.INFERRED,
    confidence: 0.99,
  });
  assert.ok(factPrecedenceScore(v) > factPrecedenceScore(i));
});
