/**
 * seller-reconciliation-policy.test.mjs
 *
 * An assertion does not become canonical state by being newer. It becomes
 * canonical by passing a policy allowed to say no. These tests pin the four
 * ways "latest row wins" is wrong, and the four outcomes that replace it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  reconcileAssertion,
  reconcileCorrection,
  touchesCanonicalState,
  requiresReview,
  RECONCILIATION,
  MONEY_PLAUSIBILITY,
  MIN_CONFIDENCE_FOR_CANONICAL,
} from "../../src/lib/domain/seller-intelligence/reconciliation-policy.js";
import { ASSERTION_BASIS } from "../../src/lib/domain/seller-intelligence/assertion-contract.js";

const price = (amount, over = {}) => ({
  type: "seller_price_expectation",
  basis: ASSERTION_BASIS.EXPLICIT,
  confidence: 0.95,
  value: { currency: "USD", amount },
  evidence: `${amount}`,
  ...over,
});

// ── the four ways latest-row-wins is wrong ────────────────────────────────

test("an INFERENCE never overwrites something the seller stated", () => {
  const result = reconcileAssertion({
    assertion: price(200000, { basis: ASSERTION_BASIS.INFERRED }),
    current: { id: "a1", basis: ASSERTION_BASIS.EXPLICIT },
  });
  assert.notEqual(result.outcome, RECONCILIATION.ACCEPT);
});

test("a WEAKER basis never displaces a stronger one, even when newer", () => {
  const result = reconcileAssertion({
    assertion: price(200000, { basis: ASSERTION_BASIS.STRONGLY_IMPLIED }),
    current: { id: "a1", basis: ASSERTION_BASIS.EXPLICIT },
  });
  assert.equal(result.outcome, RECONCILIATION.SOFT);
  assert.equal(result.reason, "weaker_basis_than_current");
});

test("a seller's CLAIM never rewrites a verified record", () => {
  // "I own it" is evidence about a person's belief, not a property record.
  const result = reconcileAssertion({
    assertion: {
      type: "ownership_claim", basis: ASSERTION_BASIS.EXPLICIT, confidence: 0.99,
      value: "sole_owner", evidence: "I own it outright",
    },
    context: { has_verified_owner: true },
  });
  assert.equal(result.outcome, RECONCILIATION.SOFT);
  assert.equal(touchesCanonicalState(result.outcome), false);
});

test("HISTORY is appended, never overwritten as current state", () => {
  // "My mother died and I inherited it" does not stop being true when the next
  // message is about tenants.
  const result = reconcileAssertion({
    assertion: {
      type: "probate_context", basis: ASSERTION_BASIS.EXPLICIT, confidence: 0.95,
      value: "probate_open", evidence: "my mom died and we inherited it",
    },
    current: { id: "a1", basis: ASSERTION_BASIS.EXPLICIT },
  });
  assert.equal(result.outcome, RECONCILIATION.ACCEPT);
  assert.equal(result.supersedes, null, "a historical fact superseded another");
});

// ── the family that DOES take recency ─────────────────────────────────────

test("a newer explicit price supersedes an older one", () => {
  // The seller is allowed to change their mind, and this is the one family
  // where recency is genuinely the right rule.
  const result = reconcileAssertion({
    assertion: price(190000),
    current: { id: "a1", basis: ASSERTION_BASIS.EXPLICIT },
  });
  assert.equal(result.outcome, RECONCILIATION.ACCEPT);
  assert.equal(result.supersedes, "a1");
});

test("225k then 205k then 190k leaves 190k current and the others history", () => {
  let current = null;
  const accepted = [];
  for (const [id, amount] of [["a1", 225000], ["a2", 205000], ["a3", 190000]]) {
    const result = reconcileAssertion({ assertion: price(amount), current });
    assert.equal(result.outcome, RECONCILIATION.ACCEPT);
    accepted.push({ id, amount, supersedes: result.supersedes });
    current = { id, basis: ASSERTION_BASIS.EXPLICIT };
  }
  assert.equal(accepted[2].supersedes, "a2");
  assert.equal(accepted.length, 3, "an earlier statement was destroyed");
});

test("occupancy changes because the WORLD changed, and says so", () => {
  const result = reconcileAssertion({
    assertion: {
      type: "occupancy_status", basis: ASSERTION_BASIS.EXPLICIT, confidence: 0.95,
      value: "vacant", evidence: "it's vacant now",
    },
    current: { id: "o1", basis: ASSERTION_BASIS.EXPLICIT },
  });
  assert.equal(result.outcome, RECONCILIATION.ACCEPT);
  assert.equal(result.reason, "state_changed");
});

test("a communication preference updates, because ignoring it contacts them wrongly", () => {
  const result = reconcileAssertion({
    assertion: {
      type: "channel_restriction", basis: ASSERTION_BASIS.EXPLICIT, confidence: 0.98,
      value: "do_not_call", evidence: "don't call me, email is fine",
    },
    current: { id: "p1", basis: ASSERTION_BASIS.EXPLICIT },
  });
  assert.equal(result.outcome, RECONCILIATION.ACCEPT);
});

// ── soft is what lets us know without acting ──────────────────────────────

test("motivation is SOFT, never canonical", () => {
  const result = reconcileAssertion({
    assertion: {
      type: "seller_motivation", basis: ASSERTION_BASIS.STRONGLY_IMPLIED, confidence: 0.9,
      value: "landlord_fatigue", evidence: "sick of dealing with those tenants",
    },
  });
  assert.equal(result.outcome, RECONCILIATION.SOFT);
});

test("an inference is soft even with no competing value at all", () => {
  const result = reconcileAssertion({
    assertion: price(185000, { basis: ASSERTION_BASIS.INFERRED }),
    current: null,
  });
  assert.equal(result.outcome, RECONCILIATION.SOFT);
});

test("low confidence is soft, not accepted and not refused", () => {
  const result = reconcileAssertion({
    assertion: price(185000, { confidence: MIN_CONFIDENCE_FOR_CANONICAL - 0.01 }),
  });
  assert.equal(result.outcome, RECONCILIATION.SOFT);
});

// ── implausible money is surfaced, never corrected ────────────────────────

test("an absurd amount goes to review rather than being clamped", () => {
  // A clamped number is a number we invented. The seller never said it.
  for (const amount of [1, 5, MONEY_PLAUSIBILITY.MIN_USD - 1, MONEY_PLAUSIBILITY.MAX_USD + 1, 99_999_999]) {
    const result = reconcileAssertion({ assertion: price(amount) });
    assert.equal(result.outcome, RECONCILIATION.REVIEW, `${amount} was not reviewed`);
    assert.equal(result.amount, amount, "the original amount was not preserved");
  }
});

test("a plausible amount is accepted", () => {
  for (const amount of [MONEY_PLAUSIBILITY.MIN_USD, 185000, 1_200_000]) {
    assert.equal(reconcileAssertion({ assertion: price(amount) }).outcome, RECONCILIATION.ACCEPT, String(amount));
  }
});

test("money with no amount is refused, not treated as zero", () => {
  const result = reconcileAssertion({
    assertion: { ...price(0), value: { currency: "USD" } },
  });
  assert.equal(result.outcome, RECONCILIATION.REFUSE);
  assert.equal(result.reason, "money_without_amount");
});

// ── legal conflict outranks everything ────────────────────────────────────

test("a legal conflict sends even a perfect assertion to review", () => {
  // "My brother says he owns half and we're in court" cannot be reconciled by
  // any confidence value.
  const result = reconcileAssertion({
    assertion: price(185000),
    context: { legal_conflict: true },
  });
  assert.equal(result.outcome, RECONCILIATION.REVIEW);
  assert.equal(requiresReview(result.outcome), true);
});

test("a legal conflict outranks even implausible money's own review", () => {
  const result = reconcileAssertion({ assertion: price(1), context: { legal_conflict: true } });
  assert.equal(result.outcome, RECONCILIATION.REVIEW);
});

// ── corrections ───────────────────────────────────────────────────────────

test("an explicit correction supersedes the value it corrects", () => {
  const result = reconcileCorrection({
    assertion: price(190000),
    current: { id: "a1", basis: ASSERTION_BASIS.EXPLICIT },
  });
  assert.equal(result.outcome, RECONCILIATION.ACCEPT);
  assert.equal(result.supersedes, "a1");
  assert.equal(result.corrected, true);
});

test("correcting a guess does not promote it to canonical", () => {
  const result = reconcileCorrection({
    assertion: {
      type: "seller_motivation", basis: ASSERTION_BASIS.EXPLICIT, confidence: 0.95,
      value: "relocation", evidence: "actually it's the move, not the tenants",
    },
    current: { id: "m1", basis: ASSERTION_BASIS.EXPLICIT },
  });
  assert.equal(result.outcome, RECONCILIATION.SOFT);
});

test("a correction carrying implausible money still goes to review", () => {
  const result = reconcileCorrection({ assertion: price(2) });
  assert.equal(result.outcome, RECONCILIATION.REVIEW);
});

// ── gaps fail towards a human ─────────────────────────────────────────────

test("malformed assertions are refused rather than guessed at", () => {
  assert.equal(
    reconcileAssertion({ assertion: { type: "not_a_real_type", basis: "explicit", confidence: 1 } }).outcome,
    RECONCILIATION.REFUSE
  );
  assert.equal(
    reconcileAssertion({ assertion: { type: "occupancy_status", basis: "certain", confidence: 1 } }).outcome,
    RECONCILIATION.REFUSE
  );
  assert.equal(
    reconcileAssertion({ assertion: { type: "occupancy_status", basis: "explicit" } }).outcome,
    RECONCILIATION.REFUSE
  );
});

test("the policy never throws, and a refusal is a result", () => {
  for (const value of [null, undefined, "", 0, [], { assertion: null }, { assertion: [] }]) {
    let result;
    assert.doesNotThrow(() => { result = reconcileAssertion(value); }, String(value));
    assert.equal(result.outcome, RECONCILIATION.REFUSE);
  }
});

test("no outcome other than ACCEPT writes canonical state", () => {
  assert.equal(touchesCanonicalState(RECONCILIATION.ACCEPT), true);
  for (const outcome of [RECONCILIATION.SOFT, RECONCILIATION.REVIEW, RECONCILIATION.REFUSE, "", null]) {
    assert.equal(touchesCanonicalState(outcome), false, String(outcome));
  }
});

test("every decision names a reason an operator can read", () => {
  const cases = [
    { assertion: price(185000) },
    { assertion: price(185000, { basis: ASSERTION_BASIS.INFERRED }) },
    { assertion: price(1) },
    { assertion: price(185000), context: { legal_conflict: true } },
    { assertion: { type: "nope", basis: "explicit", confidence: 1 } },
  ];
  for (const input of cases) {
    const result = reconcileAssertion(input);
    assert.ok(result.reason && result.reason.length > 3, JSON.stringify(input));
    assert.equal(result.policy_version, "seller_reconciliation_v1");
  }
});
