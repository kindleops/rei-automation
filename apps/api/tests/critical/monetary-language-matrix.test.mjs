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
// CEILINGS — the natural inverse of `minimum`
// ══════════════════════════════════════════════════════════════════════════

/**
 * `maximum` exists because a ceiling is a real negotiating position. Collapsing
 * it to "exact" would tell the acquisition engine the seller WANTS the number
 * when they said at MOST that number, and those route to opposite bands.
 */
test("ceiling language resolves to price_type maximum", () => {
  for (const phrase of [
    "under 500k",
    "below 500k",
    "less than 500k",
    "no more than 500k",
    "at most 500k",
    "nothing over 500k",
    "500k is my ceiling",
    "I wouldn't need more than 500k",
  ]) {
    assert.equal(type(phrase), "maximum", phrase);
    assert.equal(value(phrase), 500_000, phrase);
  }
});

test("a bare 'more than' is still a FLOOR — only negation makes a ceiling", () => {
  // "I need more than 400k" raises the bar; it does not cap it. Adding the
  // bare phrase to the ceiling cues would have inverted this.
  assert.notEqual(type("I need more than 400k"), "maximum");
  assert.equal(type("at least 400k"), "minimum");
  assert.equal(type("no less than 400k"), "minimum");
});

// ══════════════════════════════════════════════════════════════════════════
// CONTEXTUAL THOUSANDS SHORTHAND
// ══════════════════════════════════════════════════════════════════════════

/**
 * A bare "400" becomes $400,000 ONLY when a contextual anchor establishes the
 * magnitude - the deal's own reference price (current ask, recommended offer,
 * or valuation). There is no global 400 -> 400000 rule; without an anchor the
 * number stays literal and low-confidence so the turn goes to review.
 */
const anchored = (text) => resolveAskingPriceSignal(text, { reference: 200_000 })?.asking_price ?? null;

test("bare hundreds scale only against a contextual anchor", () => {
  for (const [text, expected] of [
    ["400", 400_000],
    ["425", 425_000],
    ["275", 275_000],
    ["I'd take 350", 350_000],
    ["need 425", 425_000],
    ["probably 375", 375_000],
    ["220", 220_000],
  ]) {
    assert.equal(anchored(text)?.value, expected, text);
  }

  // NO anchor: the same strings must not be promoted.
  for (const text of ["400", "425", "275"]) {
    const unanchored = resolveAskingPriceSignal(text)?.asking_price ?? null;
    assert.notEqual(unanchored?.value, Number(text) * 1000, `"${text}" must not scale without context`);
  }
});

test("shorthand preserves the SEMANTIC, not just the magnitude", () => {
  assert.equal(anchored("400 net")?.value, 400_000);
  assert.equal(anchored("400 net")?.price_type, "net");
  assert.equal(anchored("around 400")?.value, 400_000);
  assert.equal(anchored("around 400")?.price_type, "approximate");
  assert.equal(anchored("at least 400")?.value, 400_000);
  assert.equal(anchored("at least 400")?.price_type, "minimum");
  assert.equal(anchored("under 500")?.value, 500_000);
  assert.equal(anchored("under 500")?.price_type, "maximum");
  assert.equal(anchored("nothing over 475")?.value, 475_000);
  assert.equal(anchored("nothing over 475")?.price_type, "maximum");

  const range = anchored("between 350 and 400");
  assert.equal(range?.price_type, "range");
  assert.equal(range?.range?.low, 350_000);
  assert.equal(range?.range?.high, 400_000);
  assert.equal(anchored("350 to 400")?.range?.high, 400_000);
});

test("an INFERRED magnitude is never indistinguishable from a stated one", () => {
  // The whole point: "400" read as $400,000 is a reading, not a quotation.
  const inferred = anchored("400");
  assert.equal(inferred.value, 400_000);
  assert.equal(inferred.scaled_from_reference, true, "provenance must travel with the fact");
  assert.equal(inferred.extracted_text, "400", "the seller's raw words are kept");

  for (const explicit of ["$400,000", "400k", "400 thousand", "0.4 million"]) {
    const stated = anchored(explicit);
    assert.equal(stated.value, 400_000, explicit);
    assert.equal(stated.scaled_from_reference, false, `${explicit} states its own magnitude`);
  }
  // And the big scale words need no contextual help at all.
  assert.equal(value("half a million"), 500_000);
  assert.equal(value("1.5 mil"), 1_500_000);
});

test("competing semantics defeat the shorthand, anchor or not", () => {
  const NEGATIVE = [
    "rent is 400",
    "rent is 4100",
    "payment is 400",
    "monthly payment is 400",
    "mortgage is 2100",
    "I have 4 units",
    "I've owned it 4 years",
    "call after 4",
    "my address starts with 400",
    "repairs are 400",
    "deposit was 500",
    "tenant pays 1400",
    "taxes are 4200",
    "Rent is 2200 but I'd sell",
  ];
  for (const text of NEGATIVE) {
    assert.equal(anchored(text)?.value ?? null, null, `"${text}" must not become an asking price`);
  }
});

test("a clause boundary rescues a real ask from a suppressed one", () => {
  // The address guard is clause-bounded: suppressing the whole sentence would
  // have dropped a genuine number the seller gave in the same breath.
  assert.equal(anchored("my address starts with 400")?.value ?? null, null);
  assert.equal(anchored("my address starts with 400 but I want 350")?.value, 350_000);
});

test("4100 does not become $4.1M just because the topic is real estate", () => {
  // Shorthand is conventional hundreds-as-thousands, not arbitrary scaling.
  assert.notEqual(anchored("4100")?.value, 4_100_000);
  assert.notEqual(anchored("I'd take 4100")?.value, 4_100_000);
});

// ══════════════════════════════════════════════════════════════════════════
// WHAT STILL FAILS SAFELY
// ══════════════════════════════════════════════════════════════════════════

/**
 * CORRECTION to an earlier report in this session: bare hundreds were NOT an
 * unfixed gap. They already scaled through the reference anchor; the matrix
 * that "found" the gap simply called the parser without a reference, which
 * production never does. The two remaining items below are real.
 */

test("band language is still unsupported, and yields nothing rather than a guess", () => {
  // "in the fours" has no numeral to anchor. Returning null sends the turn to
  // review instead of inventing $400,000 / $450,000 / $480,000 from an adverb.
  for (const phrase of [
    "needs to be in the fours",
    "I'm thinking low fours",
    "mid fours",
    "high fours",
  ]) {
    assert.equal(anchored(phrase)?.value ?? null, null, `"${phrase}" must not invent a price`);
  }
});

test("without any anchor, a bare number stays unresolved rather than guessing", () => {
  // No reference, no currency, no scale word: the magnitude is genuinely
  // unknown, so the parser declines. This is the fail-safe the shorthand rule
  // depends on - inference requires context, never enthusiasm.
  for (const text of ["400", "425", "350"]) {
    const unanchored = resolveAskingPriceSignal(text)?.asking_price ?? null;
    assert.notEqual(unanchored?.value, Number(text) * 1000, `"${text}" must not scale unanchored`);
  }
});

test("ranges and approximates behave identically with explicit scale", () => {
  const parsed = ask("between 350k and 400k");
  assert.equal(parsed?.price_type, "range");
  assert.equal(parsed?.range?.low, 350_000);
  assert.equal(parsed?.range?.high, 400_000);
  assert.equal(parsed?.value, 350_000, "negotiate from the seller's low end");

  assert.equal(value("around 425k"), 425_000);
  assert.equal(type("around 425k"), "approximate");
  assert.equal(value("roughly 425k"), 425_000);
  assert.equal(type("roughly 425k"), "approximate");
});
