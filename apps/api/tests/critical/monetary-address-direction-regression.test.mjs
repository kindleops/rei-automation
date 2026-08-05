/**
 * Direction-prefixed street addresses are not money.
 *
 * `isAddressAdjacent` read only TWO words after a bare number. For the extremely
 * common US address form "4157 S Main St" it read "S" and "Main" and never
 * reached "St", so the guard returned false and 4157 survived as a monetary
 * token. Measured on the branch before this fix:
 *
 *   extractSellerFacts("Do you still own 4157 S Main St?")
 *     -> asking_price { amount: 4157, price_type: "exact" }   (confidence 0.75)
 *
 * 0.75 is ABOVE the 0.5 acceptance gate in resolveAskingPriceSignal, so this was
 * an ACCEPTED asking price, not a clarification request — the outbound
 * property's own street number became the seller's price.
 *
 * The same edit repairs an over-suppression bug in the opposite direction:
 * "unit" is a STREET_TYPE token, so the address guard was deleting real
 * per-unit money ("I want 300 per unit" produced NO mentions at all, where
 * production baseline eeee5bd8 produced 300000). Over-suppressing money is as
 * damaging as under-suppressing it, so both directions are pinned here.
 *
 * Synthetic addresses only; no production phone numbers.
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

/** The production path: what the seller-fact extractor actually records. */
const factPrice = (message) =>
  extractSellerFacts({ message, sourceMessageId: "t", now: NOW })?.facts?.asking_price?.value
    ?.amount ?? null;

/** The module path: what the monetary authority itself resolves. */
const signalPrice = (message, options = {}) =>
  resolveAskingPriceSignal(message, { ...options, now: NOW }).asking_price?.value ?? null;

// ── direction-prefixed addresses must never be a price ──────────────────────

const DIRECTION_ADDRESSES = [
  // single-letter compass abbreviations
  "4157 S Main St",
  "Do you still own 4157 S Main St?",
  "My property is at 4157 S Main St",
  "its 4157 S Main St",
  "1200 N Broadway",
  "1200 E 38th Street",
  "8612 W Lake Dr",
  // two-letter compass abbreviations
  "4157 NE Oak Ave",
  "8612 NE Oak Leaf Rd",
  "1200 NW 5th St",
  "8612 SE Lake Dr",
  "8612 SW 3rd Ave",
  // trailing dot on the direction
  "4157 S. Main St",
  "2500 W. Lake St",
  // lowercase
  "4157 s main st",
  "4157 s. main st",
  "8612 ne oak leaf rd",
  // spelled-out direction
  "4157 North Main St",
  "4157 north main st",
  // numbered street names, with and without a direction
  "1200 W 42nd St",
  "8612 3rd Ave",
];

for (const message of DIRECTION_ADDRESSES) {
  test(`street number is not a price: "${message}"`, () => {
    assert.equal(factPrice(message), null, `${message} — extractSellerFacts`);
    assert.equal(signalPrice(message), null, `${message} — resolveAskingPriceSignal`);
  });
}

test("the direction-prefixed street number produces no monetary mention at all", () => {
  // Not merely "no asking price" — the number must not survive tokenization,
  // otherwise a downstream consumer reading all_mentions still sees it.
  assert.deepEqual(extractMonetaryMentions("4157 S Main St"), []);
  assert.deepEqual(extractMonetaryMentions("8612 SW 3rd Ave"), []);
});

// ── protections from 2b8c9baf must survive unchanged ────────────────────────

test("the original street-number protections still hold", () => {
  for (const message of [
    "Do you still own 4157 Pillsbury Ave S Unit B?",
    "its 8612 Oak Leaf Rd",
    "327 Pennsylvania",
    "I own 331 Pennsylvania",
  ]) {
    assert.equal(factPrice(message), null, message);
    assert.equal(signalPrice(message), null, message);
  }
});

test("327 and 331 are never the price in the real incident message", () => {
  const message =
    "For 327 Pennsylvania alone 130,000...however i have a newly renovated property " +
    "next door (331 Pennsylvania) that i could through in as a package and make you a combo deal.";
  const amount = factPrice(message);
  assert.equal(amount, 130000, "the seller's real asking price must bind");
  assert.notEqual(amount, 327, "327 is a street number");
  assert.notEqual(amount, 331, "331 is a street number");
});

// ── real money must still extract (the failure mode that matters most) ──────

test("legitimate asking prices are untouched", () => {
  for (const [message, expected] of [
    ["I want 130,000", 130000],
    ["I want 130,000 for it", 130000],
    ["asking $145k", 145000],
    ["would take 200k", 200000],
    ["asking $250k", 250000],
    ["The house alone is 130k", 130000],
    ["That parcel alone would be 50 thousand", 50000],
    ["I need at least 250k", 250000],
    ["$1.2m", 1200000],
    // an explicit currency symbol always beats address adjacency
    ["$327,000 Pennsylvania", 327000],
    // a scale suffix beside an address still extracts
    ["331 Pennsylvania is worth 200k", 200000],
    // the word-boundary cue fix from a5b27c8d must not regress
    ["i want 200k however that is firm", 200000],
  ]) {
    assert.equal(factPrice(message), expected, message);
  }
});

test("a direction word in prose does not suppress a price", () => {
  // "south"/"north" outside an address position must not eat the number.
  assert.equal(signalPrice("I'd take 250 south of that", { reference: 200000 }), 250000);
  assert.equal(signalPrice("I want 150 in the court settlement", { reference: 200000 }), 150000);
});

// ── over-suppression repair: per-unit prices are money, not addresses ───────
//
// "unit" lives in STREET_TYPE_TOKENS, so the address guard was deleting these
// outright. Values below are the production-baseline (eeee5bd8) results.

test("REGRESSION: per-unit prices are not swallowed by the address guard", () => {
  assert.equal(signalPrice("I want 300 per unit", { reference: 200000 }), 300000);
  assert.equal(signalPrice("I'd do 300 a unit", { reference: 200000 }), 300000);
  assert.equal(signalPrice("asking 95 per unit for all 4", { reference: 380000 }), 95000);
  // These two were never broken; they pin the surrounding behaviour.
  assert.equal(signalPrice("$80K per unit"), 80000);
  assert.equal(signalPrice("I'd take 250 for the unit", { reference: 200000 }), 250000);
});

test("REGRESSION: a per-unit number survives tokenization, not just resolution", () => {
  const mentions = extractMonetaryMentions("I want 300 per unit", { reference: 200000 });
  assert.equal(mentions.length, 1, "the number must not be discarded");
  assert.equal(mentions[0].value, 300000);
});

// ── over-suppression repair: a capitalized word is not automatically a street ──
//
// The proper-noun branch fired on ANY capitalized word following a bare number,
// so a trailing price qualifier read as a street name and the amount was
// deleted. Measured across 40 capitalized followers with a reference in scope:
// 38 of 40 lost the number entirely versus production baseline eeee5bd8.

test("REGRESSION: a capitalized monetary qualifier is not a street name", () => {
  // The two cases surfaced by the baseline differential.
  assert.equal(signalPrice("I need 300 Net"), 300);
  assert.equal(signalPrice("my net is 300 Net"), 300);
  assert.equal(
    extractMonetaryMentions("I need 300 Net")[0]?.kind,
    "net_requirement",
    "the qualifier must still classify the amount, not delete it"
  );
});

test("REGRESSION: the whole capitalized-follower family survives", () => {
  // Every one of these returned 300000 on eeee5bd8 and null on the branch.
  for (const word of [
    "Net", "Cash", "Firm", "Total", "Obo", "Down", "Flat", "Minimum", "Best",
    "Plus", "Even", "Dollars", "Bucks", "Negotiable", "Only", "Max", "Min",
    "Today", "Tops", "Clear", "Package", "Deposit", "Payoff", "Taxes",
  ]) {
    const message = `I want 300 ${word}`;
    assert.equal(
      extractMonetaryMentions(message, { reference: 200000 }).length,
      1,
      `${message} — the number must survive`
    );
  }
});

test("a capitalized street name is STILL an address after that narrowing", () => {
  // The narrowing must not re-open the original incident.
  assert.equal(signalPrice("327 Pennsylvania"), null);
  assert.equal(signalPrice("I own 331 Pennsylvania"), null);
  assert.equal(factPrice("For 327 Pennsylvania alone 130,000"), 130000);
  assert.equal(signalPrice("its 8612 Oak Leaf Rd"), null);
});

test("a monetary cue before a street number does not make it a price", () => {
  // The narrowing is by VOCABULARY, not by "a monetary cue precedes the
  // number". The cue-based rule was implemented, measured, and rejected: an
  // address follows those cues too, so it re-opened the incident — a seller
  // saying "how about 331 Pennsylvania" about the neighbouring property had its
  // street number read as a price again. These are the cases that proved it.
  // (Production baseline eeee5bd8 extracts 327/331 here; this is stricter.)
  for (const message of [
    "what about 327 Pennsylvania",
    "how about 331 Pennsylvania",
    "around 327 Pennsylvania",
    "about 327 Pennsylvania",
    "take 327 Pennsylvania",
    "want 327 Pennsylvania",
    "need 4157 Oak Drive",
  ]) {
    assert.equal(signalPrice(message), null, message);
    assert.deepEqual(extractMonetaryMentions(message), [], message);
  }
});
