/**
 * Seller pricing language must normalise into structured price semantics.
 *
 * Two real production conversations drove this:
 *
 *   "Half mil and its yours"                          -> extracted NOTHING
 *   "Number has to start with a 4. Otherwise,
 *    nothing to talk about."                          -> extracted NOTHING
 *
 * Both sellers had stated a number. The system saw no price, so the thread sat
 * at the wrong stage and the operator watched us answer as though nothing had
 * been said.
 *
 * Worse, the spelled-out path was actively wrong:
 *
 *   "half a million"  ->  $1,500,000
 *
 * because half(0.5) + a(1) = 1.5 before the scale multiplied. A 3x
 * overstatement of a seller's asking price, in the same class as the $4,100
 * rent-as-contract-price incident.
 *
 * Price TYPE is preserved rather than collapsed: "starts with a 4" permits
 * $499,000 and forbids $399,000, so it is a `minimum`, never an exact $400,000.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveAskingPriceSignal } from "@/lib/domain/seller-flow/monetary-understanding.js";

const price = (msg) => resolveAskingPriceSignal(msg)?.asking_price ?? null;

test("the two real seller messages now extract", () => {
  const james = price("Half mil and its yours");
  assert.equal(james?.value, 500_000, '"Half mil and its yours" is $500,000');

  const lorrie = price("Number has to start with a 4. Otherwise, nothing to talk about.");
  assert.equal(lorrie?.value, 400_000);
  assert.equal(lorrie?.price_type, "minimum", "a leading-digit anchor is a FLOOR, not an asking price");
});

test("a fraction is a fraction OF the scale, not an addend", () => {
  // The article between a fraction and its scale is grammar, not arithmetic.
  for (const phrase of ["half a million", "a half million", "half million", "half a mil", "half mil"]) {
    assert.equal(price(phrase)?.value, 500_000, `${phrase} is $500,000`);
  }
  assert.equal(price("quarter million")?.value, 250_000);
});

test("REGRESSION: half a million is never 1.5 million", () => {
  // The exact defect: half(0.5) + a(1) = 1.5, then x 1,000,000.
  assert.notEqual(price("half a million")?.value, 1_500_000);
  assert.notEqual(price("a half million")?.value, 1_500_000);
});

test("Spanish 'mil' still means thousand", () => {
  // "mil" is genuinely ambiguous. A whole quantity keeps Spanish semantics;
  // only a FRACTION forces millions, because half a thousand is $500 and that
  // is not a house.
  assert.equal(price("Quiero 150 mil")?.value, 150_000);
  assert.equal(price("son 200 mil")?.value, 200_000);
});

test("price_type is preserved across the vocabulary", () => {
  assert.equal(price("I want 500k")?.price_type, "exact");
  assert.equal(price("I need at least 400k")?.price_type, "minimum");
  assert.equal(price("around 200k maybe")?.price_type, "approximate");
  assert.equal(price("somewhere between 180k and 200k")?.price_type, "range");
});

test("the raw seller phrase is always retained alongside the number", () => {
  // Normalisation must never destroy what the seller actually said.
  assert.match(price("Half mil and its yours")?.extracted_text ?? "", /half mil/i);
  assert.match(
    price("Number has to start with a 4. Otherwise, nothing to talk about.")?.extracted_text ?? "",
    /start with a 4/i,
  );
});

test("a digit that COUNTS something is not a price floor", () => {
  // "start with a 4 day notice" must not invent a $400,000 expectation.
  for (const phrase of [
    "I start with a 4 day notice",
    "it starts with a 3 bedroom layout",
    "starts with a 4 unit building",
    "we start with a 2 week inspection",
  ]) {
    assert.equal(price(phrase), null, `${phrase} is not a price`);
  }
});

test("a stated number always outranks an inferred floor", () => {
  // The floor pattern is consulted ONLY when no monetary mention exists.
  const both = price("It has to start with a 4, so 450k firm");
  assert.equal(both?.value, 450_000);
  assert.notEqual(both?.price_type, "minimum");
});
