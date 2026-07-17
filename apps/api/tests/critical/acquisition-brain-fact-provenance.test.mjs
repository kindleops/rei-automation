// ─── acquisition-brain-fact-provenance.test.mjs ────────────────────────────
// PR B: multi-label facts + provenance + precedence (not transport-authoritative).
// 40 permanent tests — all execute, none skipped.

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  FACT_TYPES,
  CLAIM_STATUS,
  PRECEDENCE_BANDS,
  FACT_CONTRACT_VERSION,
  createProvenancedFact,
  factPrecedenceScore,
  mergeFactIntoState,
  buildClassifierResultContract,
  resolveActiveFacts,
  sortFactsDeterministically,
  toJsonSafe,
  applyHumanOverride,
  applyAuthoritativeEvent,
} from "@/lib/domain/acquisition-brain/fact-provenance-contract.js";

// 1
test("1 multi-label ownership + interest + proposal request", () => {
  const r = buildClassifierResultContract({
    message: "Yes, what's the proposal?",
    classification: { primary_intent: "asks_offer", confidence: 0.98 },
    source_message_id: "m1",
  });
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.OWNERSHIP_CONFIRMED));
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.SELLER_REQUESTS_PROPOSAL));
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED));
  assert.equal(r.recommended_next_action, "request_asking_price");
});

// 2
test("2 multi-label price + condition + timeline", () => {
  const r = buildClassifierResultContract({
    message: "Around 250k, needs a roof, want to close soon",
    classification: { primary_intent: "asking_price_provided", confidence: 0.9 },
  });
  assert.equal(r.asking_price, 250000);
  assert.ok(r.condition_facts?.repairs?.includes("roof"));
  assert.ok(r.timeline);
});

// 3
test("3 exact evidence spans", () => {
  const r = buildClassifierResultContract({
    message: "Yes, what's the proposal?",
    classification: { primary_intent: "asks_offer", confidence: 0.98 },
  });
  const f = r.facts.find((x) => x.fact_type === FACT_TYPES.SELLER_REQUESTS_PROPOSAL);
  assert.ok(f.evidence_span?.text);
  assert.ok(
    f.evidence_span.start == null || typeof f.evidence_span.start === "number"
  );
});

// 4
test("4 multiple facts share message evidence", () => {
  const r = buildClassifierResultContract({
    message: "Needs a roof and HVAC",
    classification: { primary_intent: "condition_disclosed", confidence: 0.9 },
  });
  assert.ok(r.facts.filter((f) => f.evidence_span).length >= 2);
});

// 5
test("5 claimed vs verified statuses", () => {
  const claimed = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_CONFIRMED,
    value: true,
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
  });
  const verified = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_CONFIRMED,
    value: true,
    claimed_or_verified: CLAIM_STATUS.VERIFIED,
  });
  assert.ok(factPrecedenceScore(verified) > factPrecedenceScore(claimed));
});

// 6
test("6 explicit claimed beats inferred", () => {
  const a = createProvenancedFact({
    fact_type: FACT_TYPES.ASKING_PRICE,
    value: 1,
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
    confidence: 0.7,
  });
  const b = createProvenancedFact({
    fact_type: FACT_TYPES.ASKING_PRICE,
    value: 2,
    claimed_or_verified: CLAIM_STATUS.INFERRED,
    confidence: 0.99,
  });
  assert.ok(factPrecedenceScore(a) > factPrecedenceScore(b));
});

// 7
test("7 newer explicit correction supersedes", () => {
  const first = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_RELATION,
    value: "owner",
    normalized_value: "owner",
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
    confidence: 0.8,
    source_message_id: "m1",
  });
  const correction = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_RELATION,
    value: "family_member",
    normalized_value: "family_member",
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
    confidence: 0.95,
    source_message_id: "m2",
  });
  const merged = mergeFactIntoState([first], correction);
  assert.equal(resolveActiveFacts(merged)[FACT_TYPES.OWNERSHIP_RELATION].normalized_value, "family_member");
});

// 8
test("8 weak newer cannot erase strong prior", () => {
  const strong = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_CONFIRMED,
    value: true,
    claimed_or_verified: CLAIM_STATUS.VERIFIED,
    confidence: 0.99,
  });
  const weak = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_CONFIRMED,
    value: false,
    claimed_or_verified: CLAIM_STATUS.INFERRED,
    confidence: 0.3,
  });
  const merged = mergeFactIntoState([strong], weak);
  assert.equal(resolveActiveFacts(merged)[FACT_TYPES.OWNERSHIP_CONFIRMED].value, true);
});

// 9
test("9 conflicting ownership remains queryable", () => {
  const a = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_RELATION,
    value: "owner",
    normalized_value: "owner",
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
    confidence: 0.9,
    fact_id: "rel-a",
  });
  const b = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_RELATION,
    value: "tenant",
    normalized_value: "tenant",
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
    confidence: 0.5,
    fact_id: "rel-b",
  });
  const merged = mergeFactIntoState([a], b);
  assert.ok(merged.some((f) => f.conflicts_with_fact_ids?.length));
  assert.ok(merged.some((f) => f.active === false || f.claimed_or_verified === CLAIM_STATUS.CONFLICTED));
});

// 10
test("10 ownership denied not overwritten by generic yeah", () => {
  const denied = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_DENIED,
    value: "not_interested",
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
    confidence: 0.95,
    fact_id: "deny-1",
  });
  const yeah = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_CONFIRMED,
    value: true,
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
    confidence: 0.9,
  });
  const merged = mergeFactIntoState([denied], yeah);
  assert.ok(merged.some((f) => f.fact_type === FACT_TYPES.OWNERSHIP_CONFIRMED && f.active === false));
});

// 11
test('11 "Actually, my brother owns it"', () => {
  const r = buildClassifierResultContract({
    message: "Actually, my brother owns it",
    classification: { primary_intent: "ownership_confirmed", confidence: 0.9 },
  });
  assert.ok(
    r.facts.some(
      (f) =>
        f.fact_type === FACT_TYPES.FAMILY_MEMBER ||
        f.fact_type === FACT_TYPES.OWNERSHIP_RELATION
    )
  );
  assert.equal(r.authority_signers?.can_execute_alone, false);
});

// 12
test("12 spouse/co-owner requirement", () => {
  const r = buildClassifierResultContract({
    message: "My wife is also on title",
    classification: { primary_intent: "ownership_confirmed", confidence: 0.9 },
  });
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.CO_OWNER_REQUIRED));
  assert.equal(r.authority_signers?.can_execute_alone, false);
});

// 13
test("13 LLC authority", () => {
  const r = buildClassifierResultContract({
    message: "The property is owned by my LLC",
    classification: { primary_intent: "ownership_confirmed", confidence: 0.9 },
  });
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.LLC_AUTHORITY_REQUIRED));
});

// 14
test("14 Trust authority", () => {
  const r = buildClassifierResultContract({
    message: "It's in a family trust",
    classification: { primary_intent: "ownership_confirmed", confidence: 0.9 },
  });
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.TRUST_AUTHORITY_REQUIRED));
});

// 15
test("15 Estate/probate", () => {
  const r = buildClassifierResultContract({
    message: "Mom passed away, still in probate",
    classification: { primary_intent: "ownership_confirmed", confidence: 0.9 },
  });
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.PROBATE_DETECTED));
  assert.equal(r.human_review_required, true);
});

// 16
test("16 Executor claim remains claimed/unverified", () => {
  const r = buildClassifierResultContract({
    message: "I'm the executor of the estate",
    classification: { primary_intent: "ownership_confirmed", confidence: 0.9 },
  });
  const ex = r.facts.find((f) => f.fact_type === FACT_TYPES.EXECUTOR_AUTHORITY_REQUIRED);
  assert.ok(ex);
  assert.equal(ex.claimed_or_verified, CLAIM_STATUS.CLAIMED);
});

// 17
test("17 asking price single value", () => {
  const r = buildClassifierResultContract({
    message: "I'd want 250k",
    classification: { primary_intent: "asking_price_provided", confidence: 0.92 },
  });
  assert.equal(r.asking_price, 250000);
});

// 18
test("18 asking price range", () => {
  const r = buildClassifierResultContract({
    message: "Between 200k and 250k",
    classification: { primary_intent: "asking_price_provided", confidence: 0.9 },
  });
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.ASKING_PRICE_RANGE));
});

// 19
test("19 asking price qualifier around/at least", () => {
  const r = buildClassifierResultContract({
    message: "Around 180k",
    classification: { primary_intent: "asking_price_provided", confidence: 0.9 },
  });
  assert.equal(r.asking_price, 180000);
  assert.ok(r.asking_price_qualifier === "approx" || r.facts.some((f) => f.fact_type === FACT_TYPES.PRICE_FLEXIBILITY));
});

// 20
test("20 mortgage balance claim", () => {
  const r = buildClassifierResultContract({
    message: "I still owe about 120k",
    classification: { primary_intent: "info_request", confidence: 0.85 },
  });
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.MORTGAGE_BALANCE_CLAIM));
});

// 21
test("21 roof and HVAC repair facts", () => {
  const r = buildClassifierResultContract({
    message: "Needs a roof and HVAC",
    classification: { primary_intent: "condition_disclosed", confidence: 0.9 },
  });
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.ROOF_CONDITION));
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.HVAC_CONDITION));
});

// 22
test("22 occupied vs vacant", () => {
  const v = buildClassifierResultContract({
    message: "It's vacant",
    classification: { primary_intent: "condition_disclosed", confidence: 0.9 },
  });
  assert.equal(v.occupancy, "vacant");
  const o = buildClassifierResultContract({
    message: "Tenants are still there",
    classification: { primary_intent: "condition_disclosed", confidence: 0.9 },
  });
  assert.equal(o.occupancy, "occupied");
});

// 23
test("23 listed with agent", () => {
  const r = buildClassifierResultContract({
    message: "I have a realtor listing it",
    classification: { primary_intent: "listed_or_unavailable", confidence: 0.9 },
  });
  assert.equal(r.listing_agent_involvement, true);
});

// 24
test("24 competing proposal", () => {
  const r = buildClassifierResultContract({
    message: "We already have another offer",
    classification: { primary_intent: "info_request", confidence: 0.9 },
  });
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.COMPETING_PROPOSAL));
});

// 25
test("25 wrong number", () => {
  const r = buildClassifierResultContract({
    message: "Wrong number",
    classification: { primary_intent: "wrong_number", confidence: 1 },
  });
  assert.equal(r.wrong_number, true);
  assert.equal(r.recommended_next_action, "suppress");
});

// 26
test("26 opt-out", () => {
  const r = buildClassifierResultContract({
    message: "STOP",
    classification: { primary_intent: "opt_out", confidence: 1 },
  });
  assert.equal(r.opt_out, true);
  assert.equal(r.recommended_next_action, "opt_out");
});

// 27
test("27 hostile/legal", () => {
  const r = buildClassifierResultContract({
    message: "I will sue you and report to the FCC",
    classification: { primary_intent: "hostile_or_legal", confidence: 0.99 },
  });
  assert.equal(r.hostility_legal, true);
});

// 28
test("28 Spanish ownership and interest", () => {
  const r = buildClassifierResultContract({
    message: "Sí, me interesa la propiedad",
    classification: {
      primary_intent: "ownership_confirmed",
      language: "Spanish",
      confidence: 0.9,
    },
  });
  assert.equal(r.language, "Spanish");
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.OWNERSHIP_CONFIRMED));
});

// 29
test("29 Spanish asking price", () => {
  const r = buildClassifierResultContract({
    message: "Quiero 250k por la propiedad",
    classification: {
      primary_intent: "asking_price_provided",
      language: "Spanish",
      confidence: 0.9,
    },
  });
  assert.equal(r.asking_price, 250000);
  assert.equal(r.language, "Spanish");
});

// 30
test("30 typo-heavy/slang", () => {
  const r = buildClassifierResultContract({
    message: "yeah whts the proposal",
    classification: { primary_intent: "asks_offer", confidence: 0.9 },
  });
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.SELLER_REQUESTS_PROPOSAL));
});

// 31
test("31 duplicate message idempotency (same source id confirms)", () => {
  const a = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_CONFIRMED,
    value: true,
    source_message_id: "same",
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
  });
  const b = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_CONFIRMED,
    value: true,
    source_message_id: "same",
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
  });
  const merged = mergeFactIntoState([a], b);
  const active = merged.filter(
    (f) => f.fact_type === FACT_TYPES.OWNERSHIP_CONFIRMED && f.active !== false
  );
  assert.equal(active.length, 1);
});

// 32
test("32 out-of-order: older weaker cannot supersede newer stronger", () => {
  const newer = createProvenancedFact({
    fact_type: FACT_TYPES.ASKING_PRICE,
    value: 300000,
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
    confidence: 0.95,
    source_timestamp: "2026-07-17T12:00:00.000Z",
    fact_id: "price-new",
  });
  const older = createProvenancedFact({
    fact_type: FACT_TYPES.ASKING_PRICE,
    value: 100000,
    claimed_or_verified: CLAIM_STATUS.INFERRED,
    confidence: 0.4,
    source_timestamp: "2026-07-17T11:00:00.000Z",
    fact_id: "price-old",
  });
  // Process newer first, then older arrives late
  const merged = mergeFactIntoState([newer], older);
  assert.equal(resolveActiveFacts(merged)[FACT_TYPES.ASKING_PRICE].value, 300000);
});

// 33
test("33 human override immutable against weaker text", () => {
  const base = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_CONFIRMED,
    value: true,
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
  });
  const overridden = applyHumanOverride(base, {
    value: false,
    reason: "operator_verified_wrong_owner",
    overridden_by: "ops",
  });
  assert.equal(overridden.human_override.active, true);
  const attack = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_CONFIRMED,
    value: true,
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
    confidence: 0.99,
  });
  const merged = mergeFactIntoState([overridden], attack);
  assert.equal(resolveActiveFacts(merged)[FACT_TYPES.OWNERSHIP_CONFIRMED].value, false);
});

// 34
test('34 "under contract" remains claimed', () => {
  const r = buildClassifierResultContract({
    message: "We are already under contract",
    classification: { primary_intent: "not_interested", confidence: 0.9 },
  });
  const f = r.facts.find((x) => x.fact_type === FACT_TYPES.UNDER_CONTRACT_CLAIM);
  assert.ok(f);
  assert.equal(f.claimed_or_verified, CLAIM_STATUS.CLAIMED);
  assert.notEqual(r.recommended_stage, "under_contract_with_buyer");
});

// 35
test('35 "we closed yesterday" remains claimed', () => {
  const r = buildClassifierResultContract({
    message: "We closed yesterday",
    classification: { primary_intent: "ownership_confirmed", confidence: 0.9 },
  });
  const f = r.facts.find((x) => x.fact_type === FACT_TYPES.CLOSING_CLAIM);
  assert.ok(f);
  assert.equal(f.claimed_or_verified, CLAIM_STATUS.CLAIMED);
  assert.notEqual(r.recommended_stage, "closed");
});

// 36
test("36 authoritative closing event beats seller claim", () => {
  const claim = createProvenancedFact({
    fact_type: FACT_TYPES.CLOSING_CLAIM,
    value: true,
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
    fact_id: "close-claim",
  });
  const merged = applyAuthoritativeEvent([claim], {
    event_type: "closing_confirmed",
    event_id: "evt-close-1",
  });
  const active = resolveActiveFacts(merged)[FACT_TYPES.CLOSING_CLAIM];
  assert.equal(active.claimed_or_verified, CLAIM_STATUS.AUTHORITATIVE);
  assert.ok(factPrecedenceScore(active) > PRECEDENCE_BANDS.AUTHORITATIVE);
});

// 37
test("37 JSON serialization round-trip", () => {
  const r = buildClassifierResultContract({
    message: "Yes, what's the proposal?",
    classification: { primary_intent: "asks_offer", confidence: 0.98 },
    source_message_id: "m-json",
  });
  const json = JSON.stringify(r);
  const back = JSON.parse(json);
  assert.equal(back.contract_version, FACT_CONTRACT_VERSION);
  assert.ok(Array.isArray(back.facts));
  assert.equal(typeof back.facts[0].confidence, "number");
});

// 38
test("38 stable deterministic fact ordering", () => {
  const a = [
    createProvenancedFact({ fact_type: FACT_TYPES.ROOF_CONDITION, value: 1, fact_id: "z" }),
    createProvenancedFact({ fact_type: FACT_TYPES.ASKING_PRICE, value: 2, fact_id: "a" }),
  ];
  const b = sortFactsDeterministically([...a].reverse());
  const c = sortFactsDeterministically(a);
  assert.deepEqual(
    b.map((f) => f.fact_type),
    c.map((f) => f.fact_type)
  );
});

// 39
test("39 no duplicate active facts same value+source", () => {
  const f1 = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_CONFIRMED,
    value: true,
    source_message_id: "dup",
  });
  const f2 = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_CONFIRMED,
    value: true,
    source_message_id: "dup",
  });
  const merged = mergeFactIntoState([f1], f2);
  assert.equal(
    merged.filter((f) => f.fact_type === FACT_TYPES.OWNERSHIP_CONFIRMED && f.active !== false)
      .length,
    1
  );
});

// 40
test("40 conflicts remain queryable after supersession", () => {
  const first = createProvenancedFact({
    fact_type: FACT_TYPES.ASKING_PRICE,
    value: 200000,
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
    confidence: 0.8,
    fact_id: "p1",
  });
  const second = createProvenancedFact({
    fact_type: FACT_TYPES.ASKING_PRICE,
    value: 300000,
    claimed_or_verified: CLAIM_STATUS.CLAIMED,
    confidence: 0.95,
    fact_id: "p2",
  });
  const merged = mergeFactIntoState([first], second);
  const inactive = merged.find((f) => f.fact_id === "p1");
  assert.equal(inactive.active, false);
  assert.ok(inactive.conflicts_with_fact_ids.includes("p2") || second.supersedes_fact_id === "p1" || merged.find((f) => f.fact_id === "p2").supersedes_fact_id === "p1");
  assert.ok(merged.some((f) => f.fact_id === "p1")); // still present
});

// bonus: JSON-safe strips functions/dates
test("41 toJsonSafe strips non-JSON values", () => {
  const safe = toJsonSafe({
    a: 1,
    b: new Date("2026-01-01T00:00:00.000Z"),
    c: () => 1,
    d: undefined,
  });
  assert.equal(safe.a, 1);
  assert.equal(safe.b, "2026-01-01T00:00:00.000Z");
  assert.equal(safe.c, undefined);
});

// bonus: createProvenancedFact full fields
test("42 createProvenancedFact includes full provenance fields", () => {
  const f = createProvenancedFact({
    fact_type: FACT_TYPES.OWNERSHIP_CONFIRMED,
    value: true,
    confidence: 0.94,
    evidence_span: { text: "Yeah", start: 0, end: 4 },
    source_message_id: "msg-1",
    classifier_version: "classify_js_v1",
  });
  assert.equal(f.source_message_id, "msg-1");
  assert.ok(f.fact_id);
  assert.equal(f.active, true);
  assert.ok(Array.isArray(f.conflicts_with_fact_ids));
});
