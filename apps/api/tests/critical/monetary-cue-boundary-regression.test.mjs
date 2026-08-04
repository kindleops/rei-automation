/**
 * Monetary cue matching must respect word boundaries.
 *
 * The cue table matched SUBSTRINGS, so "however" contains "owe" and bound the
 * asking price in "130,000...however" to the MORTGAGE_PAYOFF cue — the seller's
 * $130,000 was discarded as a loan balance. The same trap sits in "net"
 * (cabinet, network), "clear" (clearly) and "fix" (fixture).
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { extractSellerFacts } from "@/lib/domain/seller-flow/extract-seller-facts.js";

const NOW = "2026-08-04T00:00:00Z";
const askingPrice = (message) =>
  extractSellerFacts({ message, sourceMessageId: "t", now: NOW })?.facts?.asking_price?.value ??
  null;

test("the exact incident sentence binds 130000", () => {
  const message =
    "For 327 Pennsylvania alone 130,000...however i have a newly renovated property " +
    "next door (331 Pennsylvania) that i could through in as a package and make you a combo deal.";
  const extracted = askingPrice(message);
  assert.equal(extracted?.amount, 130000, "the seller's asking price must survive 'however'");
  assert.notEqual(extracted?.amount, 331, "331 is a street number");
  assert.notEqual(extracted?.amount, 327, "327 is a street number");
});

for (const [label, message] of [
  ["ellipsis", "asking 130,000...however i also have another"],
  ["ellipsis+space", "asking 130,000... however i also have another"],
  ["comma", "asking 130,000, however i also have another"],
  ["period", "asking 130,000. However i also have another"],
  ["semicolon", "asking 130,000; however i also have another"],
  ["em dash", "asking 130,000 — however i also have another"],
  ["parentheses", "asking (130,000) however i also have another"],
  ["line break", "asking 130,000\nhowever i also have another"],
  ["immediate word", "asking 130,000 however"],
]) {
  test(`punctuation form: ${label}`, () => {
    assert.equal(askingPrice(message)?.amount, 130000, message);
  });
}

test("'however' no longer reads as the payoff cue 'owe'", () => {
  assert.equal(askingPrice("i want 200k however that is firm")?.amount, 200000);
});

test("other substring traps do not capture the amount", () => {
  assert.equal(askingPrice("i want 200k, the cabinets are new")?.amount, 200000);
  assert.equal(askingPrice("i want 200k, clearly firm")?.amount, 200000);
  assert.equal(askingPrice("i want 200k, fixtures included")?.amount, 200000);
});

test("a genuine payoff is still not an asking price", () => {
  assert.equal(askingPrice("I owe 60,000 on it"), null);
  assert.equal(askingPrice("I still owe 60k"), null);
});

test("taxes, repairs and monthly amounts are still not asking prices", () => {
  assert.equal(askingPrice("taxes are 4,000 a year"), null);
  assert.equal(askingPrice("repairs would be 15,000"), null);
  assert.equal(askingPrice("rent is 1,200 a month"), null);
});

test("street numbers are not money", () => {
  assert.equal(askingPrice("Do you still own 4157 Pillsbury Ave S Unit B?"), null);
  assert.equal(askingPrice("327 Pennsylvania"), null);
  assert.equal(askingPrice("I own 331 Pennsylvania"), null);
});

test("KNOWN PRE-EXISTING GAP: bare years and ZIP codes still parse as amounts", () => {
  // Documented, not fixed here. Both behave identically on pristine eeee5bd8,
  // so this is not a regression — but it is a real defect and must not be
  // mistaken for covered behaviour.
  assert.equal(askingPrice("I bought it in 1998")?.amount, 1998);
  assert.equal(askingPrice("we are in 55407")?.amount, 55407);
});

test("legitimate asking prices still bind", () => {
  for (const [message, expected] of [
    ["I want 130,000 for it", 130000],
    ["asking $250k", 250000],
    ["The house alone is 130k", 130000],
    ["That parcel alone would be 50 thousand", 50000],
    ["I need at least 250k", 250000],
  ]) {
    assert.equal(askingPrice(message)?.amount, expected, message);
  }
});
