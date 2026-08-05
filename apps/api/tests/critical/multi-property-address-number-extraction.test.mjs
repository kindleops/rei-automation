/**
 * Street numbers are not money.
 *
 * Production behaviour before this fix, on the real seller message
 * "For 327 Pennsylvania alone 130,000 ... (331 Pennsylvania) ... package":
 *
 *   asking_price = { amount: 331, price_type: "package" }
 *
 * The system recorded the NEIGHBOURING PROPERTY'S STREET NUMBER as the asking
 * price — a $130,000 property valued at $331 — and missed the real figure. Any
 * downstream underwriting, offer, or comp logic reading that field was working
 * from a number the seller never said.
 *
 * Synthetic identifiers only; no production phone numbers.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { extractSellerFacts } from "@/lib/domain/seller-flow/extract-seller-facts.js";

const NOW = "2026-08-04T00:00:00Z";
const price = (message, id = "t") =>
  extractSellerFacts({ message, sourceMessageId: id, now: NOW })?.facts?.asking_price?.value ?? null;

// ── the incident ────────────────────────────────────────────────────────────

test("a neighbouring property's street number is never the asking price", () => {
  const message =
    "For 327 Pennsylvania alone 130,000...however i have a newly renovated property " +
    "next door (331 Pennsylvania) that i could through in as a package and make you a combo deal.";
  const extracted = price(message, "multi-property");
  assert.notEqual(extracted?.amount, 331, "331 is a street number, not a price");
  assert.notEqual(extracted?.amount, 327, "327 is a street number, not a price");
});

test("the outbound property's street number is never a price", () => {
  assert.equal(price("Do you still own 4157 Pillsbury Ave S Unit B?"), null);
  assert.equal(price("its 8612 Oak Leaf Rd"), null);
  assert.equal(price("327 Pennsylvania"), null);
  assert.equal(price("I own 331 Pennsylvania"), null);
  // A compass direction between the number and the street name pushed the
  // street type out of the two-word lookahead, so 4157 survived as a price.
  // Full coverage lives in monetary-address-direction-regression.test.mjs.
  assert.equal(price("4157 S Main St"), null);
  assert.equal(price("Do you still own 4157 S Main St?"), null);
});

// ── real prices must still extract ──────────────────────────────────────────

test("monetary evidence still yields the price", () => {
  const cases = [
    ["I want 130,000 for it", 130000],
    ["asking $250k", 250000],
    ["The house alone is 130k", 130000],
    ["That parcel alone would be 50 thousand", 50000],
    ["I need at least 250k", 250000],
    ["$1.2m", 1200000],
  ];
  for (const [message, expected] of cases) {
    assert.equal(price(message, message)?.amount, expected, message);
  }
});

test("a comma-formatted figure beside an address still extracts", () => {
  // The street number is discarded; the money survives.
  const extracted = price("For 327 Pennsylvania alone 130,000");
  assert.equal(extracted?.amount, 130000, "the real asking price must survive");
});

test("a scale suffix beside an address still extracts", () => {
  assert.equal(price("331 Pennsylvania is worth 200k")?.amount, 200000);
});

test("a currency symbol always wins over address adjacency", () => {
  // An explicit $ is monetary evidence, so the address-adjacency guard must not
  // fire. (A bare 327 would be discarded as a street number.)
  assert.equal(price("$327,000 Pennsylvania")?.amount, 327000);
});

test("the address guard never eats a per-unit price", async () => {
  // "unit" is a street-type token, so this guard was discarding real per-unit
  // money outright. Over-suppression is as damaging as under-suppression.
  const { resolveAskingPriceSignal } = await import(
    "@/lib/domain/seller-flow/monetary-understanding.js"
  );
  assert.equal(
    resolveAskingPriceSignal("I want 300 per unit", { reference: 200000, now: NOW })
      .asking_price?.value,
    300000
  );
});

// ── the 'alone' phrase must never suppress a live seller ────────────────────

test("price phrases containing 'alone' are not opt-outs", async () => {
  const { isNegativeReply } = await import("@/lib/domain/classification/is-negative-reply.js");
  for (const message of [
    "For 327 Pennsylvania alone 130,000",
    "The house alone is 130k",
    "That parcel alone would be 50 thousand",
  ]) {
    assert.equal(isNegativeReply(message), false, message);
  }
});
