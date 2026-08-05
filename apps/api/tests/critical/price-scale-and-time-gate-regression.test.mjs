/**
 * Two launch blockers in the classifier's price parsing.
 *
 * BLOCKER 1 — Spanish "mil" inflated every price 1000x.
 * scalePriceToken tested `s.startsWith("m")` before checking the exact token,
 * and "mil" prefixes "million". So "150 mil" — the most common way a
 * Spanish-speaking seller states a price — parsed as $150,000,000 instead of
 * $150,000, on a language path this codebase explicitly supports. This is the
 * same class of defect as the $332.5M offers this repo has already shipped once.
 * monetary-understanding.js already had it right (mil: 1_000); this aligns the
 * classifier with the module that was already correct.
 *
 * BLOCKER 2 — a clock time parsed as an asking price.
 * "at", "around" and "about" were price cues that accepted a bare number, but
 * they are also how a seller states a TIME. "Please call at 3" parsed as an
 * offer to sell for $3, with auto_reply_allowed true — and it hijacked
 * primary_intent, so the most common callback phrasings resolved to
 * asking_price_provided instead of callback_requested. Those three cues now
 * require the number to look like money: an explicit $, a scale suffix,
 * thousands separators, or 4+ digits.
 *
 * The fix had THREE consumers, not the two the report identified. Beyond the
 * ASKING_PRICE_PATTERNS gate, parseSellerAskingPrice carries its own
 * independent `between ... and ...` matcher that never consults the gate, so
 * "between 3 and 4" survived the gate repair and still produced a $3 price.
 * The same money-shape requirement is applied there.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";

const priceOf = async (text) =>
  (await classify(text, null, { heuristicOnly: true })).price_parse?.value ?? null;

// ── Blocker 1: "mil" is a thousand ─────────────────────────────────────────

for (const [text, expected] of [
  ["quiero 150 mil", 150_000],
  ["150 mil", 150_000],
  ["pido 200 mil", 200_000],
  ["lo doy en 150 mil", 150_000],
  ["quiero 90 mil por la casa", 90_000],
  ["vendo en 250 mil", 250_000],
  ["300 mil", 300_000],
]) {
  test(`"mil" is a thousand, not a million: ${JSON.stringify(text)}`, async () => {
    const value = await priceOf(text);
    assert.equal(value, expected, `${text} must be ${expected}, not ${expected * 1000}`);
    assert.notEqual(value, expected * 1000, "the 1000x inflation must not return");
  });
}

test("the other scale suffixes are unchanged by the mil fix", async () => {
  assert.equal(await priceOf("1.2 million"), 1_200_000);
  assert.equal(await priceOf("150k"), 150_000);
  assert.equal(await priceOf("2 million"), 2_000_000);
  assert.equal(await priceOf("300 thousand"), 300_000);
});

test("'mil' after an already-thousands base is redundant, not multiplicative", async () => {
  // "150,000 mil" is the magnitude written twice. Multiplying was arithmetically
  // correct on a redundant input and wrong on intent — it produced $150,000,000.
  // The guard needs no guess about which magnitude was meant: the base carries it.
  assert.equal(await priceOf("150,000 mil"), 150_000);
  assert.equal(await priceOf("200,000 mil"), 200_000);
  // …while a small base still scales, which is the common form.
  assert.equal(await priceOf("150 mil"), 150_000);
  assert.equal(await priceOf("2 mil"), 2_000);
});

// ── Blocker 2: a clock time is not a price ─────────────────────────────────

const CLOCK_PHRASES = [
  "call at 3", "call me at 4", "Please call at 3", "at 3", "at 5pm",
  "around 3", "about 4", "call around 5", "reach me at 6", "lets talk at 2",
  "meeting at 9", "available at 10", "free at 11", "call at 3 or 4",
  "between 3 and 4", "around 2 today", "about 6 tonight", "at 7 tomorrow",
  "call me around 8", "try at 12", "at 1", "at 2", "at 3:30", "around 4:15",
  "call at noon", "at 8am", "about 9pm", "around 10:00",
];

for (const text of CLOCK_PHRASES) {
  test(`a clock time is not an asking price: ${JSON.stringify(text)}`, async () => {
    assert.equal(await priceOf(text), null, `${text} must not parse as a price`);
  });
}

// ── Blocker 2: real money must still parse ─────────────────────────────────

const MONEY_PHRASES = [
  "at least 85k", "meet me at 200k", "around 200k", "about 150,000", "at $200k",
  "between $90,000 and $100,000", "between 90k and 100k", "between 90000 and 100000",
  "$500,000", "1.2 million", "i want 250k", "asking 300k", "minimum 180000",
  "no less than 250", "150k firm", "300k obo", "at 250000", "around $175,000",
  "about 2 million", "want 90k", "asking for 120k", "at 1.5 million",
  "between 100k and 120k", "min 95k", "350,000",
];

for (const text of MONEY_PHRASES) {
  test(`a real price still parses: ${JSON.stringify(text)}`, async () => {
    const value = await priceOf(text);
    assert.notEqual(value, null, `${text} must still parse as a price`);
    assert.ok(value > 0, `${text} must be a positive amount, got ${value}`);
  });
}

// ── Blocker 2: the callback intents it was hijacking ───────────────────────
// The gate is shared: it sets price_parse AND pushes asking_price_provided.
// Before the fix these resolved to asking_price_provided with auto-reply
// allowed, so the seller sending the most common callback phrasing was recorded
// as offering to sell for $3.

for (const text of [
  "Can you call at 3?",
  "You can call at 3",
  "Please call at 3",
  "Can we have a call at 3?",
  "Schedule a call for 3",
  "Give me a call at 3",
]) {
  test(`a callback request is not a price offer: ${JSON.stringify(text)}`, async () => {
    const result = await classify(text, null, { heuristicOnly: true });
    assert.equal(
      result.primary_intent,
      "callback_requested",
      `${text} must read as a callback request, got ${result.primary_intent}`
    );
    assert.notEqual(result.primary_intent, "asking_price_provided");
    assert.equal(result.price_parse?.value ?? null, null, "and carries no fabricated price");
  });
}

// ── The independent range parser, which the gate does not cover ────────────

test("a between-range is a clock only when BOTH sides are bare 1-2 digit numbers", async () => {
  // Clock windows.
  assert.equal(await priceOf("between 3 and 4"), null);
  assert.equal(await priceOf("between 2 and 5"), null);
  assert.equal(await priceOf("call between 2 and 4"), null);
  assert.equal(await priceOf("between 10 and 12"), null);
  // Money-shaped ranges.
  assert.equal(await priceOf("between 90k and 100k"), 90_000);
  assert.equal(await priceOf("between $90,000 and $100,000"), 90_000);
  assert.equal(await priceOf("between 90000 and 100000"), 90_000);
});

test("REI bare-hundreds ranges are prices, not clock windows", async () => {
  // Regression guard on my own first attempt at the rule above. Requiring the
  // range to "look like money" was too strict: "Between 240 and 260" is REI
  // shorthand for a 240k-260k range — the same convention scalePriceToken notes
  // for a bare "250" — and rejecting it silently dropped a stated asking price.
  // The distinguisher is smallness, not money-shape.
  for (const text of ["Between 240 and 260", "between 240 and 260", "between 100 and 120"]) {
    const result = await classify(text, null, { heuristicOnly: true });
    assert.equal(
      result.primary_intent,
      "asking_price_provided",
      `${text} must remain a stated price range`
    );
    assert.ok((result.price_parse?.value ?? 0) > 0, `${text} must carry a price value`);
  }
});
