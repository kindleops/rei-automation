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

test("REGRESSION: the function-word guard applies AFTER the direction skip", () => {
  // The direction skip moved the window to all.slice(1,4) but the non-street
  // lead-word guard still only ran on all[0], so once a direction was consumed
  // the new lead word went unguarded and a street type three words later
  // suppressed real money:
  //
  //   "I want 300 East of the drive" -> ["of","the","drive"], "drive" is a
  //   STREET_TYPE_TOKEN -> read as an address -> 300 DROPPED
  //   "I want 300 of the drive"      -> correctly rejected -> 300 KEPT
  //
  // Same sentence, same words, opposite outcome. All of these are 300000 on
  // production baseline eeee5bd8.
  for (const message of [
    "I want 300 East of the drive",
    "I want 300 West of the property",
    "I want 300 North of the road",
    "I want 300 South of the building",
    "I'd take 300 east of the court",
    "I want 300 NE of the parkway",
    // the un-skipped control that always worked
    "I want 300 of the drive",
  ]) {
    assert.equal(signalPrice(message, { reference: 200000 }), 300000, message);
  }
});

test("the direction skip still recognises genuine directional addresses", () => {
  for (const message of [
    "4157 S Main St",
    "4157 North Main Street",
    "327 E Pennsylvania Ave",
    "Do you still own 4157 S Main St?",
  ]) {
    assert.equal(signalPrice(message), null, message);
  }
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

/**
 * The COMPLETE measured set. A 40-word differential against production baseline
 * eeee5bd8 (bare number + capitalized follower, with a reference in scope so the
 * number legitimately scales to thousands) found 38 of 40 losing the number
 * entirely. Every word below returned 300000 on eeee5bd8 and null on the branch.
 * Kept as an explicit table so the family can never silently shrink.
 */
const CAPITALIZED_FOLLOWERS = [
  "Net", "Cash", "Firm", "Total", "Obo", "Down", "Flat", "Minimum", "Best",
  "Plus", "Even", "Dollars", "Bucks", "Negotiable", "Only", "Max", "Min",
  "Today", "Tops", "Ish", "Clear", "Package", "Deposit", "Earnest", "Payoff",
  "Repairs", "Taxes", "Monthly", "Together", "Portfolio", "Asking", "Take",
  "Want", "Need", "About", "Around",
];

for (const word of CAPITALIZED_FOLLOWERS) {
  test(`REGRESSION: "I want 300 ${word}" keeps its number`, () => {
    const message = `I want 300 ${word}`;
    const mentions = extractMonetaryMentions(message, { reference: 200000 });
    assert.equal(mentions.length, 1, `${message} — the number must survive`);
    assert.equal(mentions[0].value, 300000, `${message} — and keep its value`);
  });
}

test("the two survivors of that differential are unchanged", () => {
  // "Each" and "OBO" never broke — "each" is a function word and "OBO" is not
  // capitalized in the /^[A-ZÀ-Ý][a-zà-ÿ]{2,}$/ sense. Pinned so a future
  // narrowing of the qualifier set cannot quietly change them either.
  for (const message of ["I want 300 Each", "I want 300 OBO"]) {
    assert.equal(
      extractMonetaryMentions(message, { reference: 200000 })[0]?.value,
      300000,
      message
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
  // A cue-based narrowing was implemented, measured and REJECTED: an address
  // follows those cues too, so "how about 331 Pennsylvania" would have read the
  // neighbouring property's street number as a price. These cases pin that.
  //
  // None of them yields an asking price — which is the protection that matters.
  // The bare number does survive as a 0.3-confidence mention, exactly as it
  // does on production baseline eeee5bd8, so the caller routes to clarification
  // instead of acting. An earlier revision of this file suppressed the mention
  // outright; that was stricter than baseline and was given up when the
  // trailing-token family showed that capitalization alone cannot tell
  // "327 Pennsylvania" from "I want 300 Pennsylvania" — the word is identical.
  for (const message of [
    "what about 327 Pennsylvania",
    "how about 331 Pennsylvania",
    "around 327 Pennsylvania",
    "about 327 Pennsylvania",
    "take 327 Pennsylvania",
    "want 327 Pennsylvania",
  ]) {
    assert.equal(signalPrice(message), null, `${message} — must not yield a price`);
    const mentions = extractMonetaryMentions(message);
    assert.ok(
      mentions.every((m) => m.confidence <= 0.3),
      `${message} — any surviving mention must stay below the acceptance gate`
    );
  }
  // A street type is still unambiguous address evidence, cue or no cue.
  assert.equal(signalPrice("need 4157 Oak Drive"), null);
  assert.deepEqual(extractMonetaryMentions("need 4157 Oak Drive"), []);
});

/**
 * FAMILY 5 — a trailing capitalized token is not a street name.
 *
 * With a reference in scope, EVERY capitalized multi-letter word trailing a
 * bare number was read as a street name and the number deleted. Measured
 * against production baseline eeee5bd8: 45 of 53 tokens across five vocabulary
 * groups, all 300000 -> null. Not a direction problem — a whole-class problem.
 *
 * It cannot be fixed by vocabulary: "I want 300 Pennsylvania" and
 * "327 Pennsylvania" contain the SAME word and need opposite answers. Only
 * context separates them, so the capitalization branch now requires either a
 * skipped compass direction or other money in the message to protect.
 */
const TRAILING_TOKENS = [
  // compass directions, the form CodeRabbit reported
  "East", "West", "North", "South", "Northeast", "Northwest", "Southeast", "Southwest",
  // politeness and closers
  "Please", "Thanks", "Thank", "Sorry", "Sure", "Okay", "Maybe", "Right",
  "Correct", "Deal", "Done", "Agreed", "Fine", "Good", "Great", "Perfect",
  // time and availability
  "Tomorrow", "Tonight", "Anytime", "Whenever", "Soon", "Later", "Now",
  // confirmations
  "Yes", "Yeah", "Yep", "Nope", "Absolutely", "Definitely",
  // words that are genuinely street names in other contexts
  "Pennsylvania", "Broadway", "Lincoln", "Oak", "Maple", "Jefferson", "Madison", "Franklin",
];

for (const word of TRAILING_TOKENS) {
  test(`REGRESSION: a trailing "${word}" does not delete the price`, () => {
    const message = `I want 300 ${word}`;
    assert.equal(signalPrice(message, { reference: 200000 }), 300000, message);
  });
}

test("the trailing-token fix does not re-open the incident", () => {
  // Same words, address context, other money present to protect.
  assert.equal(factPrice("For 327 Pennsylvania alone 130,000"), 130000);
  assert.equal(factPrice("331 Pennsylvania is worth 200k"), 200000);
  const incident =
    "For 327 Pennsylvania alone 130,000...however i have a newly renovated property " +
    "next door (331 Pennsylvania) that i could through in as a package and make you a combo deal.";
  assert.equal(factPrice(incident), 130000);
  // And no street number survives where a street type or a direction says address.
  for (const message of [
    "4157 S Main St",
    "1200 N Broadway",
    "its 8612 Oak Leaf Rd",
    "Do you still own 4157 Pillsbury Ave S Unit B?",
    "4157 North Main Street",
  ]) {
    assert.equal(signalPrice(message), null, message);
  }
});
