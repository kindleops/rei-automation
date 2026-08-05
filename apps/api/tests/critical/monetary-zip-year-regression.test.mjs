/**
 * Postal codes and calendar years are not asking prices.
 *
 * Measured on BOTH the production baseline (eeee5bd8) and this branch before
 * the fix — identical, so this was a long-standing defect rather than a
 * regression:
 *
 *   extractSellerFacts("zip is 55407")   -> asking_price { amount: 55407 }
 *   extractSellerFacts("built in 1987")  -> asking_price { amount: 1987 }
 *
 * The fix is CUE-BASED, never numeric. "55407" and a $55,407 asking price are
 * structurally identical, as are "1998" and $1,998; a rule keyed on digit count
 * alone would silently delete real seller money. The digit shape is only a
 * precondition — a textual cue ("zip", a state abbreviation, "built in",
 * "since") is what suppresses.
 *
 * A bare preposition is deliberately NOT a cue. See the "documented residual"
 * test at the bottom for exactly what that leaves uncovered and why.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { extractSellerFacts } from "@/lib/domain/seller-flow/extract-seller-facts.js";
import {
  extractMonetaryMentions,
  resolveAskingPriceSignal,
} from "@/lib/domain/seller-flow/monetary-understanding.js";

const NOW = "2026-08-04T00:00:00Z";

const factPrice = (message) =>
  extractSellerFacts({ message, sourceMessageId: "t", now: NOW })?.facts?.asking_price?.value
    ?.amount ?? null;

const signalPrice = (message, options = {}) =>
  resolveAskingPriceSignal(message, { ...options, now: NOW }).asking_price?.value ?? null;

const values = (message, options = {}) =>
  extractMonetaryMentions(message, options).map((m) => m.value);

// ── ZIP codes: suppressed on a cue ──────────────────────────────────────────

for (const message of [
  "zip is 55407",
  "zip code 55407",
  "my zip is 55407",
  "the zipcode 55407",
  "postal code 55407",
  // the way a ZIP actually reaches us: inside a pasted address
  "Minneapolis, MN 55407",
  "Minneapolis MN 55407",
  "its in Minneapolis, MN 55407",
  "4157 S Main St, Minneapolis MN 55407",
]) {
  test(`a cued ZIP is not a price: "${message}"`, () => {
    assert.equal(factPrice(message), null, `${message} — extractSellerFacts`);
    assert.equal(signalPrice(message), null, `${message} — resolveAskingPriceSignal`);
    assert.deepEqual(values(message), [], `${message} — must not tokenize at all`);
  });
}

test("five-digit MONEY is never mistaken for a ZIP", () => {
  // The lead's required proof: bare "in" is NOT a ZIP cue, because these are
  // natural price statements that it would destroy.
  assert.equal(factPrice("I'm interested in 95000"), 95000);
  assert.equal(factPrice("would be interested in 95k"), 95000);
  // No blanket "5-digit numbers are not money" rule exists.
  for (const [message, expected] of [
    ["I want 55000", 55000],
    ["asking 95000", 95000],
    ["I want 130000", 130000],
    ["I need 20000", 20000],
    ["$55,407", 55407],
    // an explicit ask cue beats the ZIP shape entirely
    ["would take 55407", 55407],
  ]) {
    assert.equal(factPrice(message), expected, message);
  }
});

// ── calendar years: suppressed on a cue ─────────────────────────────────────

for (const message of [
  "built in 1987",
  "built 1972",
  "rebuilt in 2001",
  "since 1998",
  "I bought it in 1998",
  "I purchased it in 2004",
  "we bought the place in 2011",
  "renovated in 2015",
  "the roof was replaced in 2019",
  "new roof in 2019",
  "I inherited it in 2020",
]) {
  test(`a cued year is not a price: "${message}"`, () => {
    assert.equal(factPrice(message), null, `${message} — extractSellerFacts`);
    assert.equal(signalPrice(message), null, `${message} — resolveAskingPriceSignal`);
    assert.deepEqual(values(message), [], `${message} — must not tokenize at all`);
  });
}

test("four-digit MONEY inside the year range is never mistaken for a year", () => {
  // No blanket "4-digit numbers are not money" rule exists.
  assert.equal(factPrice("I want 2000"), 2000);
  assert.equal(factPrice("I'd take 1950"), 1950);
  assert.equal(factPrice("$2,000"), 2000);
});

test("a bare preposition alone never suppresses a figure", () => {
  // "in" is not a year cue on its own — it needs a temporal subject nearby.
  // These are real figures that a bare-"in" rule would have deleted.
  assert.deepEqual(values("I put in 2000 for repairs"), [2000]);
  assert.deepEqual(values("2000 in repairs"), [2000]);
  assert.deepEqual(values("I'm in 45000 of debt on it"), [45000]);
});

test("suppression never fires when monetary evidence is present", () => {
  // Currency symbol, thousands separator or scale suffix all bypass the guards.
  assert.equal(factPrice("built in $1,987"), 1987);
  assert.equal(factPrice("zip is $55,407"), 55407);
  assert.equal(factPrice("I want 1998k"), 1998000);
});

// ── a suppressed year no longer destroys the price beside it ────────────────

test("REPAIR: a year no longer collides with the real asking price", () => {
  // Before the fix this returned NULL: 2019 and 130,000 were two confident,
  // materially different price statements, so resolveAskingPriceSignal declared
  // "conflicting_price_statements" and threw the seller's real number away.
  const message = "I bought it in 2019 for 130,000";
  assert.equal(factPrice(message), 130000);
  assert.equal(
    resolveAskingPriceSignal(message, { now: NOW }).needs_clarification,
    false,
    "the year must not manufacture a price conflict"
  );
});

// ── other numbers keep their own semantic kind ──────────────────────────────

test("repair, payoff, tax and monthly figures are reclassified, never deleted", () => {
  const kinds = (message) =>
    extractMonetaryMentions(message).map((m) => `${m.value}/${m.kind}`);
  assert.deepEqual(kinds("repairs would be 5000"), ["5000/repair_amount"]);
  assert.deepEqual(kinds("repairs are 2000"), ["2000/repair_amount"]);
  assert.deepEqual(kinds("I owe 2000 on it"), ["2000/mortgage_payoff"]);
  assert.deepEqual(kinds("taxes are 1950 a year"), ["1950/tax_amount"]);
});

// ── documented residual ─────────────────────────────────────────────────────

test("DOCUMENTED RESIDUAL: a ZIP after a bare preposition is still read as money", () => {
  // NOT delivered, and deliberately so. The only cue that would catch this is a
  // bare "in", and "in" is unsafe: it also precedes real figures — see the
  // "bare preposition" test above ("I'm interested in 95000" -> 95000,
  // "I put in 2000 for repairs" -> 2000). Suppressing those to catch this would
  // trade a cosmetic miss for real seller money. Asserting the true behaviour
  // rather than weakening the claim.
  assert.equal(factPrice("we are in 55407"), 55407);
});
