/**
 * seller-assertion-contract.test.mjs
 *
 * The shape every downstream consumer agrees on, and the boundaries that stop
 * a misreading becoming a false belief.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAssertion,
  ASSERTION_BASIS,
  ASSERTION_TYPE,
  ASSERTION_TYPE_LIST,
  FACT_FAMILY,
  AUTHORITY_CLAIM_TYPES,
  MONETARY_ASSERTION_TYPES,
  basisRank,
  familyOf,
  isKnownAssertionType,
  verifyIntentCoverage,
  canonicalIntent,
  EMAIL4_INTENT_COVERAGE,
  EMAIL4_INTENT_GAPS,
  ACTION_AUTHORITY,
} from "../../src/lib/domain/seller-intelligence/assertion-contract.js";
import { INBOUND_INTENT_ONTOLOGY } from "../../src/lib/domain/classification/inbound-intent-ontology.js";

// ── the vocabulary is borrowed, not invented ──────────────────────────────

test("every intent this phase depends on still exists in the canonical ontology", () => {
  // If a slug is renamed there, this fails loudly rather than silently folding
  // to "unclear" and losing the meaning.
  const result = verifyIntentCoverage();
  assert.equal(result.ok, true, `missing canonical intents: ${result.missing.join(", ")}`);
});

test("EMAIL-4 defines no intent enum of its own", () => {
  // Every value in the coverage map must be a real ontology slug. A value that
  // is not is EMAIL-4 inventing vocabulary.
  for (const [concept, slug] of Object.entries(EMAIL4_INTENT_COVERAGE)) {
    assert.ok(INBOUND_INTENT_ONTOLOGY[slug], `${concept} maps to non-existent ${slug}`);
  }
});

test("the gaps are named rather than silently folded", () => {
  // Four concepts the spec names have no canonical slug. Recording them is the
  // honest alternative to inventing EMAIL-4 slugs beside a registry that is the
  // stated single source of truth.
  assert.ok(Object.keys(EMAIL4_INTENT_GAPS).length > 0);
  for (const [concept, why] of Object.entries(EMAIL4_INTENT_GAPS)) {
    assert.equal(INBOUND_INTENT_ONTOLOGY[concept], undefined, `${concept} is not actually a gap`);
    assert.ok(why.length > 40, `${concept}'s gap is not explained`);
  }
});

test("an unknown classifier label folds to unclear rather than becoming a new intent", () => {
  assert.equal(canonicalIntent("seller_is_definitely_ready"), "unclear");
  assert.equal(canonicalIntent(""), "unclear");
  assert.equal(canonicalIntent(null), "unclear");
});

// ── basis ──────────────────────────────────────────────────────────────────

test("basis is ordered explicit > strongly_implied > inferred", () => {
  assert.ok(basisRank(ASSERTION_BASIS.EXPLICIT) < basisRank(ASSERTION_BASIS.STRONGLY_IMPLIED));
  assert.ok(basisRank(ASSERTION_BASIS.STRONGLY_IMPLIED) < basisRank(ASSERTION_BASIS.INFERRED));
});

test("an unrecognised basis ranks BELOW everything known, never above", () => {
  assert.ok(basisRank("definitely") > basisRank(ASSERTION_BASIS.INFERRED));
  assert.ok(basisRank(null) > basisRank(ASSERTION_BASIS.INFERRED));
});

test("a missing basis is refused, never defaulted to explicit", () => {
  // Defaulting would turn an inference into a quotation -- an operator reading
  // a deal summary would see something the seller never said.
  const result = buildAssertion({
    type: "seller_motivation", value: "landlord_fatigue", confidence: 0.8,
    evidence: "sick of dealing with those tenants",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_basis");
});

test("an invented basis is refused", () => {
  for (const basis of ["certain", "probably", "EXPLICIT!", "", null, 0]) {
    const result = buildAssertion({
      type: "occupancy_status", basis, value: "vacant", confidence: 0.9, evidence: "it's vacant",
    });
    assert.equal(result.ok, false, String(basis));
  }
});

// ── what can be asserted at all ───────────────────────────────────────────

test("an invented assertion type is refused, not stored as a new kind of fact", () => {
  const result = buildAssertion({
    type: "seller_definitely_wants_to_sell", basis: "explicit", confidence: 1, evidence: "yes",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown_assertion_type");
});

test("every declared type has a fact family, because conflict rules are per family", () => {
  // A type with no family would fall through the reconciliation policy to a
  // generic "latest wins", which is exactly what the policy forbids.
  for (const type of ASSERTION_TYPE_LIST) {
    const family = familyOf(type);
    assert.ok(Object.values(FACT_FAMILY).includes(family), `${type} has family ${family}`);
  }
});

test("authority is always a CLAIM family, never a verified state", () => {
  for (const type of AUTHORITY_CLAIM_TYPES) {
    assert.equal(familyOf(type), FACT_FAMILY.CLAIM, `${type} is not a claim`);
    assert.ok(isKnownAssertionType(type));
  }
});

test("a competing offer is its own claim type, not a price expectation", () => {
  // "Someone offered me 205 yesterday" must not become the seller's minimum --
  // that would let a seller move our floor by reporting a rumour.
  assert.ok(AUTHORITY_CLAIM_TYPES.has("ownership_claim"));
  assert.equal(familyOf("competing_offer_claim"), FACT_FAMILY.CLAIM);
  assert.notEqual(familyOf("competing_offer_claim"), familyOf("seller_price_expectation"));
});

test("price is temporal and occupancy is mutable state — different families", () => {
  // A seller revising their price is them changing their mind. A property
  // becoming vacant is the world changing. Both supersede, for different
  // reasons and under different rules.
  assert.equal(familyOf("seller_price_expectation"), FACT_FAMILY.TEMPORAL);
  assert.equal(familyOf("occupancy_status"), FACT_FAMILY.MUTABLE_STATE);
});

test("a probate EVENT is historical; motivation is interpretive", () => {
  // An event that happened does not stop being true and must never be
  // overwritten as though it were current state.
  assert.equal(familyOf("probate_context"), FACT_FAMILY.HISTORICAL);
  assert.equal(familyOf("seller_motivation"), FACT_FAMILY.INTERPRETIVE);
});

// ── evidence ───────────────────────────────────────────────────────────────

test("an assertion with no evidence is refused", () => {
  // One that cannot be traced to the seller's exact words cannot be reviewed,
  // disputed, or explained to an operator who asks where it says that.
  for (const evidence of ["", "   ", null, undefined]) {
    const result = buildAssertion({
      type: "occupancy_status", basis: "explicit", value: "vacant", confidence: 0.95, evidence,
    });
    assert.equal(result.ok, false, String(evidence));
    assert.equal(result.reason, "missing_evidence");
  }
});

test("a well-formed assertion carries its evidence verbatim", () => {
  const result = buildAssertion({
    type: "seller_price_expectation", basis: "explicit", confidence: 0.99,
    value: { currency: "USD", amount: 185000 }, raw_value: "185",
    evidence: "I could do 185",
  });
  assert.equal(result.ok, true);
  assert.equal(result.assertion.evidence, "I could do 185");
  assert.equal(result.assertion.raw_value, "185");
  assert.equal(result.assertion.is_monetary, true);
});

// ── confidence ─────────────────────────────────────────────────────────────

test("confidence outside 0..1 is refused", () => {
  for (const confidence of [-0.1, 1.1, 42, NaN, Infinity, "high", null, undefined]) {
    const result = buildAssertion({
      type: "occupancy_status", basis: "explicit", value: "vacant", confidence, evidence: "vacant",
    });
    assert.equal(result.ok, false, String(confidence));
  }
});

// ── conditions travel with the term ───────────────────────────────────────

test("conditions stay attached to the assertion that carries them", () => {
  // "185 if you close before the 20th" is ONE fact. Flattening it to 185 is how
  // a condition the seller made material disappears before anyone negotiates.
  const result = buildAssertion({
    type: "seller_price_expectation", basis: "explicit", confidence: 0.97,
    value: { currency: "USD", amount: 185000 },
    evidence: "I'd do 185 if you close before the 20th",
    conditions: [{ kind: "close_before", value: "2026-09-20" }],
  });
  assert.equal(result.assertion.conditions.length, 1);
  assert.equal(result.assertion.conditions[0].kind, "close_before");
});

test("conditions default to an empty list, never to null", () => {
  const result = buildAssertion({
    type: "seller_price_expectation", basis: "explicit", confidence: 0.9,
    value: { currency: "USD", amount: 190000 }, evidence: "190 as-is",
  });
  assert.deepEqual(result.assertion.conditions, []);
});

// ── layer D ────────────────────────────────────────────────────────────────

test("EMAIL-4 has exactly one authority value, and it is none", () => {
  // Understanding is not permission. EMAIL-5 owns action selection.
  assert.deepEqual(Object.values(ACTION_AUTHORITY), ["none"]);
});

test("no assertion carries an authority field at all", () => {
  const result = buildAssertion({
    type: "seller_price_expectation", basis: "explicit", confidence: 1,
    value: { currency: "USD", amount: 1 }, evidence: "1",
  });
  for (const forbidden of ["authority", "action", "approved", "send", "reply"]) {
    assert.equal(forbidden in result.assertion, false, `assertion leaked ${forbidden}`);
  }
});

// ── hostile input ──────────────────────────────────────────────────────────

test("buildAssertion never throws, and refusal is a result", () => {
  for (const value of [null, undefined, "", 0, [], "string", { type: {} }, { type: [], basis: [] }]) {
    let result;
    assert.doesNotThrow(() => { result = buildAssertion(value); }, String(value));
    assert.equal(result.ok, false);
    assert.ok(result.reason);
  }
});

test("every monetary type is a real type", () => {
  for (const type of MONETARY_ASSERTION_TYPES) {
    assert.ok(isKnownAssertionType(type), `${type} is monetary but not declared`);
  }
});

test("the type map and the exported list cannot drift apart", () => {
  assert.deepEqual(ASSERTION_TYPE_LIST.slice().sort(), Object.keys(ASSERTION_TYPE).sort());
});

test("a missing confidence is malformed, not zero confidence", () => {
  // Number(null) and Number("") are both 0. Without an explicit type check,
  // `null` would be accepted as 0.0 while `undefined` was refused as NaN --
  // the same missing value behaving two different ways, and the accepted one
  // silently marking the assertion maximally unreliable rather than broken.
  for (const confidence of [null, "", "0", undefined]) {
    const result = buildAssertion({
      type: "occupancy_status", basis: "explicit", value: "vacant", confidence, evidence: "vacant",
    });
    assert.equal(result.ok, false, `${String(confidence)} was accepted`);
    assert.equal(result.reason, "invalid_confidence");
  }
});

test("a genuine zero confidence is still a valid number", () => {
  // The point is not that 0 is forbidden -- it is that it must be MEANT.
  const result = buildAssertion({
    type: "occupancy_status", basis: "inferred", value: "vacant", confidence: 0, evidence: "maybe empty",
  });
  assert.equal(result.ok, true);
  assert.equal(result.assertion.confidence, 0);
});
