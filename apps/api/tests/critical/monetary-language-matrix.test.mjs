/**
 * THE MONETARY-LANGUAGE MATRIX.
 *
 * Every phrase an operator listed, asserted against what the parser ACTUALLY
 * does. Where the parser is right, the expectation is the right answer. Where
 * it is not, the test states the current behaviour and names the gap out loud
 * rather than quietly lowering the bar - an unread number is recoverable, a
 * confidently wrong one is not.
 *
 * Directional language is deliberately NOT flattened to "exact". A floor, a
 * ceiling and a range are three different negotiating positions and the schema
 * must keep them apart or the acquisition engine is reasoning about fiction.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveAskingPriceSignal } from "@/lib/domain/seller-flow/monetary-understanding.js";

const ask = (text) => resolveAskingPriceSignal(text)?.asking_price ?? null;
const value = (text) => ask(text)?.value ?? null;
const type = (text) => ask(text)?.price_type ?? null;

// ══════════════════════════════════════════════════════════════════════════
// SCALE WORDS — the family that produced the $1,500,000 misread
// ══════════════════════════════════════════════════════════════════════════

test("fraction + scale word", () => {
  // "half a million" once parsed as 1.5M: the fraction and the article were
  // read as separate addends (1 + 0.5) instead of one quantity.
  assert.equal(value("half mil"), 500_000);
  assert.equal(value("half a mil"), 500_000);
  assert.equal(value("half a million"), 500_000);
  assert.equal(value("Half mil and its yours"), 500_000);
  assert.equal(value("quarter mil"), 250_000);
  assert.equal(value("quarter million"), 250_000);
});

test("whole and decimal millions", () => {
  assert.equal(value("a million"), 1_000_000);
  assert.equal(value("one million"), 1_000_000);
  assert.equal(value("one and a half million"), 1_500_000);
  assert.equal(value("1.5 million"), 1_500_000);
  // "1.5 mil" read as $1,500 - the same ambiguity as "half mil", in digits.
  assert.equal(value("1.5 mil"), 1_500_000);
});

test("Spanish 'mil' is still thousands, which is what makes the fraction rule safe", () => {
  // The rule keys on a NON-INTEGER, not on magnitude, so the Spanish reading
  // is untouched. "150.5 mil" is not how anyone writes 150,500.
  assert.equal(value("150 mil"), 150_000);
  assert.equal(value("quiero 150 mil"), 150_000);
  assert.equal(value("250 mil pesos"), 250_000);
  assert.equal(value("2 mil"), 2_000);
  // And a redundant "mil" after an already-thousands number does not multiply.
  assert.equal(value("$150,000 mil"), 150_000);
});

test("plain scale forms", () => {
  assert.equal(value("500k"), 500_000);
  assert.equal(value("500 grand"), 500_000);
  assert.equal(value("five hundred thousand"), 500_000);
});

// ══════════════════════════════════════════════════════════════════════════
// DIGIT-ANCHORED FLOORS — "it has to start with a 4"
// ══════════════════════════════════════════════════════════════════════════

test("a leading-digit anchor is a MINIMUM, in digits or in words", () => {
  for (const phrase of ["needs to start with a 4", "number has to start with a four"]) {
    assert.equal(value(phrase), 400_000, phrase);
    assert.equal(type(phrase), "minimum", `${phrase} is a floor, not an exact price`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// FALSE-POSITIVE CONTROLS — the expensive direction
// ══════════════════════════════════════════════════════════════════════════

test("no price is extracted from a number that is not a price", () => {
  const CONTROLS = [
    "I start with a 4 day notice",
    "I've owned it for 4 years",
    "there are 4 units",
    "call me after 4",
    "my address starts with 4",
    "I have 4 tenants",
    "it's been vacant 4 months",
  ];
  for (const text of CONTROLS) {
    assert.equal(value(text), null, `"${text}" must not yield an asking price`);
  }
});

test("a street number is not an asking price", () => {
  // This fabricated a $400,000 ask from a seller reciting their address.
  assert.equal(value("my address starts with 4"), null);
  assert.equal(value("the street number starts with a 7"), null);
  assert.equal(value("my phone number is 4"), null);
});

// ══════════════════════════════════════════════════════════════════════════
// DOCUMENTED GAPS — current behaviour, stated plainly
// ══════════════════════════════════════════════════════════════════════════

/**
 * GAP 1: THE SCHEMA HAS NO `maximum`.
 *
 * price_type supports exact | approximate | minimum | net | per_unit |
 * package | range. A ceiling has nowhere to live, so "under 500" yields
 * nothing at all.
 *
 * Returning null is the correct behaviour GIVEN the schema - calling a ceiling
 * "exact" would tell the acquisition engine the seller wants $500,000 when
 * they said at MOST $500,000, and those route to opposite bands. The fix is a
 * schema change, which is an operator decision, not a parser patch.
 */
test("GAP: a ceiling is dropped rather than misreported as exact", () => {
  for (const phrase of ["under 500", "no more than 500", "500 at the most"]) {
    const parsed = ask(phrase);
    assert.notEqual(parsed?.price_type, "exact", `"${phrase}" must never be called exact`);
    assert.notEqual(parsed?.price_type, "minimum", `"${phrase}" is a ceiling, not a floor`);
  }
});

/**
 * GAP 2: BARE HUNDREDS ARE NOT SCALED TO THOUSANDS.
 *
 * "400 net" yields 400, not 400,000. The price_type is captured correctly -
 * net, per_unit and minimum all survive - only the magnitude is literal.
 *
 * This is deliberately NOT patched here. Auto-scaling a bare number by 1000x
 * is the same class of inference that turned a $4,100 monthly rent into a
 * contract price, and the safe direction is not obvious: reading "400" as $400
 * makes the deal look absurd and gets reviewed, while reading it as $400,000
 * could silently authorise a real offer. Which way this should go is a product
 * call.
 */
test("GAP: bare hundreds keep their qualifier but not a thousands magnitude", () => {
  assert.equal(type("400 net"), "net", "the NET qualifier survives");
  assert.equal(type("400 per unit"), "per_unit", "the PER-UNIT qualifier survives");
  assert.equal(type("at least 400"), "minimum", "the FLOOR qualifier survives");
  assert.equal(type("no less than 400"), "minimum");

  // Magnitude is literal. Pinned so a future change is a decision, not a drift.
  assert.equal(value("400 net"), 400);
  assert.equal(value("at least 400"), 400);
});

/**
 * GAP 3: RANGE AND BAND LANGUAGE ON BARE HUNDREDS.
 *
 * The range machinery exists and populates {low, high}, but both endpoints
 * must clear the confidence bar first, and bare hundreds do not. Band language
 * ("in the fours", "low/mid/high fours") has no support at all.
 *
 * Both currently yield nothing, which is the safe failure: the turn falls to
 * review instead of inventing a number.
 */
test("GAP: bare-hundred ranges and band language yield nothing, not a guess", () => {
  for (const phrase of [
    "between 350 and 400",
    "350 to 400",
    "needs to be in the fours",
    "I'm thinking low fours",
    "mid fours",
    "high fours",
    "north of 400",
    "425 each",
    "around 425",
    "roughly 425",
  ]) {
    assert.equal(value(phrase), null, `"${phrase}" must not invent a price`);
  }
});

test("ranges DO work once the endpoints carry scale", () => {
  // Same sentences, magnitudes stated. This proves the range machinery is
  // present and that GAP 3 is a confidence-threshold issue, not a missing
  // feature.
  const parsed = ask("between 350k and 400k");
  assert.equal(parsed?.price_type, "range");
  assert.equal(parsed?.range?.low, 350_000);
  assert.equal(parsed?.range?.high, 400_000);
  assert.equal(parsed?.value, 350_000, "negotiate from the seller's low end");
});

test("approximate language IS preserved when the magnitude is clear", () => {
  assert.equal(value("around 425k"), 425_000);
  assert.equal(type("around 425k"), "approximate");
  assert.equal(value("roughly 425k"), 425_000);
  assert.equal(type("roughly 425k"), "approximate");
});
