/**
 * A cue must still match its ordinary written and inflected forms.
 *
 * a5b27c8d replaced substring cue matching with a word-boundary matcher. That
 * fixed a real defect ("however" contains "owe", so the seller's $130,000 was
 * discarded as a loan balance) but it also stopped matching forms that the
 * substring rule had matched CORRECTLY, and every one of those numbers fell
 * through to the asking-price branch.
 *
 * The worst instance, measured against production baseline eeee5bd8:
 *
 *   "its rented at $1,450/month"
 *     eeee5bd8 -> monthly_amount 1450, asking_price null
 *     branch   -> asking_price  1450
 *
 * "/mo" matched inside "/month" as a substring; with a right boundary it no
 * longer does, and no other monthly cue covers the "/month" written form. A
 * seller's MONTHLY RENT became their ASKING PRICE FOR THE HOUSE, and it reached
 * extractSellerFacts and the negotiation engines — a rental priced as a $1,450
 * property. The baseline was safe; the branch regressed it.
 *
 * The same break hit ordinary inflections across the whole cue table: "I owed
 * 60,000" stopped being a payoff, "I fixed it for 15,000" stopped being a
 * repair, "the deposits were 5,000" stopped being earnest money.
 *
 * This file locks BOTH directions: the inflections match again, and every trap
 * a5b27c8d deliberately closed stays closed.
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

const kindOf = (message) => extractMonetaryMentions(message)[0]?.kind ?? null;
const signalPrice = (message) =>
  resolveAskingPriceSignal(message, { now: NOW }).asking_price?.value ?? null;
const factPrice = (message) =>
  extractSellerFacts({ message, sourceMessageId: "t", now: NOW })?.facts?.asking_price?.value
    ?.amount ?? null;

// ── the merge blocker: monthly rent is not an asking price ──────────────────

for (const [message, value] of [
  ["$1,200/month rent", 1200],
  ["its rented at $1,450/month", 1450],
  ["rent is $500/month", 500],
  ["tenant pays 950/month", 950],
  ["$1,200/months", 1200],
  ["rent 1,200/mos", 1200],
  ["$1,200/mth", 1200],
]) {
  test(`monthly rent is not an asking price: "${message}"`, () => {
    assert.equal(kindOf(message), "monthly_amount", `${message} — kind`);
    assert.equal(extractMonetaryMentions(message)[0]?.value, value, `${message} — value`);
    assert.equal(signalPrice(message), null, `${message} — resolveAskingPriceSignal`);
    assert.equal(factPrice(message), null, `${message} — extractSellerFacts`);
  });
}

test("the monthly forms that never broke are unchanged", () => {
  for (const message of [
    "950/mo",
    "rent is 500 a month",
    "$1,200 per month rent",
    "$1,200 monthly",
    "son 900 mensuales",
  ]) {
    assert.equal(kindOf(message), "monthly_amount", message);
    assert.equal(signalPrice(message), null, message);
  }
});

// ── inflections across the cue table ────────────────────────────────────────

/**
 * The COMPLETE inflection differential, cue by cue. Derived mechanically: the
 * boundary switch changed matching from `text.includes(cue)` to a bounded
 * regex, so the full set of breaks is every (cue, token) pair where the token
 * contains the cue but does not match it as a bounded word. Cross-producting
 * all 116 cues against a 199-token corpus of realistic seller vocabulary
 * yielded 79 divergences; the ones below are the REAL regressions — cases where
 * the substring match had been correct and the number silently became an
 * asking price. Every one is a non-price kind on eeee5bd8.
 */
const INFLECTION_CASES = [
  ["mortgage_payoff", "I owed 60,000 on it"],
  ["mortgage_payoff", "he owes 60,000"],
  ["mortgage_payoff", "the payoffs are 60,000"],
  ["repair_amount", "it was repaired for 15,000"],
  ["repair_amount", "repairing it cost 15,000"],
  ["repair_amount", "repairs are 15,000"],
  ["repair_amount", "I fixed it for 15,000"],
  ["repair_amount", "fixing it ran 15,000"],
  ["repair_amount", "the fixes came to 15,000"],
  ["earnest_money", "the deposits were 5,000"],
  ["earnest_money", "I deposited 5,000"],
  ["monthly_amount", "son 900 mensuales"],
];

for (const [kind, message] of INFLECTION_CASES) {
  test(`inflection keeps its kind: "${message}" -> ${kind}`, () => {
    assert.equal(kindOf(message), kind, `${message} — kind`);
    assert.equal(signalPrice(message), null, `${message} — must not be an asking price`);
  });
}

test("PRE-EXISTING GAP, not a regression: 'owing' is not a payoff cue", () => {
  // Found while building the table above, and measured before asserting:
  // "owing" does NOT contain "owe" as a substring (o-w-e vs o-w-i-n-g), so it
  // never matched under the old substring rule either. This is asking_price on
  // production baseline eeee5bd8 AND here — a pre-existing defect of the same
  // class as the payoff regression, NOT something a5b27c8d or this PR caused.
  // Asserting the true behaviour rather than a fix nobody has approved; the
  // repair is a one-word cue addition if the operator wants it.
  assert.equal(kindOf("still owing 60,000 on the note"), "asking_price");
});

test("Spanish 'mil' after an already-thousands number is redundant, not multiplicative", () => {
  // "150,000 mil" is a seller writing 150 thousand TWICE. Multiplying gave
  // $150,000,000 — the same magnitude error as the original Spanish blocker.
  // The identical guard lives in classify.js scalePriceToken; the two parsers
  // must not disagree by three orders of magnitude on the same string, because
  // a silent disagreement looks handled from whichever side you inspect.
  const value = (message) => extractMonetaryMentions(message)[0]?.value ?? null;
  assert.equal(value("150,000 mil"), 150000);
  assert.equal(value("quiero 150000 mil"), 150000);
  assert.equal(value("$150,000 mil"), 150000);
  // The ordinary forms must not move.
  assert.equal(value("150 mil"), 150000);
  assert.equal(value("200 mil"), 200000);
  assert.equal(value("300 mil"), 300000);
  assert.equal(value("quiero 150 mil"), 150000);
  assert.equal(value("2 mil"), 2000);
  // And no other scale suffix is touched by the guard.
  assert.equal(value("1.2 million"), 1200000);
  assert.equal(value("150k"), 150000);
});

test("the inflected forms that were never broken are unchanged", () => {
  // Controls: the uninflected cue always matched. If these ever diverge from
  // the inflected forms above, the suffix rule has stopped applying evenly.
  for (const [kind, message] of [
    ["mortgage_payoff", "I owe 60,000 on it"],
    ["repair_amount", "the repair is 15,000"],
    ["earnest_money", "the deposit is 5,000"],
    ["monthly_amount", "son 900 mensual"],
  ]) {
    assert.equal(kindOf(message), kind, message);
    assert.equal(signalPrice(message), null, message);
  }
});

test("written forms that are not regular inflections are listed explicitly", () => {
  // Found by the exhaustive a5b27c8d surface sweep, not by a probe. None of
  // these is a regular inflection, so the suffix rule cannot reach them; each
  // was a non-price figure becoming an asking price.
  assert.equal(kindOf("the repairman quoted 15,000"), "repair_amount");
  assert.equal(signalPrice("the repairman quoted 15,000"), null);
  assert.equal(kindOf("la mensualidad es 900"), "monthly_amount");
  assert.equal(kindOf("bimonthly it is 1,200"), "monthly_amount");
  assert.equal(signalPrice("bimonthly it is 1,200"), null);
});

test("earnest, package, minimum and net cues match their inflections", () => {
  assert.equal(kindOf("the deposits were 5,000"), "earnest_money");
  assert.equal(kindOf("I deposited 5,000"), "earnest_money");
  assert.equal(kindOf("the packages are 500,000"), "package_price");
  assert.equal(kindOf("the portfolios are 500,000"), "package_price");
  assert.equal(kindOf("my minimums are 85,000"), "minimum_price");
  assert.equal(kindOf("it nets 90,000"), "net_requirement");
  assert.equal(kindOf("quiero 90000 netos"), "net_requirement");
});

// ── a5b27c8d's traps must stay closed ───────────────────────────────────────

test("'however' still does not read as the payoff cue 'owe'", () => {
  const incident =
    "For 327 Pennsylvania alone 130,000...however i have a newly renovated property " +
    "next door (331 Pennsylvania) that i could through in as a package and make you a combo deal.";
  assert.equal(factPrice(incident), 130000);
  for (const message of [
    "asking 130,000...however i also have another",
    "asking 130,000, however i also have another",
    "asking 130,000. However i also have another",
    "asking 130,000; however i also have another",
    "asking 130,000 — however i also have another",
    "asking (130,000) however i also have another",
    "asking 130,000\nhowever i also have another",
    "asking 130,000 however",
  ]) {
    assert.equal(factPrice(message), 130000, message);
  }
  assert.equal(factPrice("i want 200k however that is firm"), 200000);
});

test("the substring traps a5b27c8d closed stay closed", () => {
  // "ly" and "er" are excluded from the inflection set precisely for these.
  assert.equal(factPrice("i want 200k, the cabinets are new"), 200000);
  assert.equal(factPrice("i want 200k, clearly firm"), 200000);
  assert.equal(factPrice("i want 200k, fixtures included"), 200000);
  assert.equal(kindOf("clearly 90,000 is firm"), "asking_price");
  assert.equal(kindOf("the fixtures were 15,000"), "asking_price");
  assert.equal(kindOf("its a 15,000 fixer upper"), "asking_price");
});

test("the semantic guards are unchanged", () => {
  for (const message of [
    "I owe 60,000 on it",
    "I still owe 60k",
    "taxes are 4,000 a year",
    "repairs would be 15,000",
    "rent is 1,200 a month",
  ]) {
    assert.equal(factPrice(message), null, message);
  }
});

test("legitimate asking prices are untouched by the inflection rule", () => {
  for (const [message, expected] of [
    ["I want 130,000 for it", 130000],
    ["asking $250k", 250000],
    ["I wanted 130,000", 130000],
    ["he needs 130,000", 130000],
    ["I asked 130,000", 130000],
    ["I need at least 250k", 250000],
  ]) {
    assert.equal(factPrice(message), expected, message);
  }
});
