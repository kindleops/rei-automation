/**
 * Behavioral differential against the production baseline (eeee5bd8).
 *
 * This PR added three new guards to the monetary path: a bare-number address
 * guard, a compass-direction skip, and a substring->word-boundary switch for
 * cue matching. Every one of them can only SUBTRACT matches, and the full-suite
 * diff was silent for all three regressions below because no test covered the
 * inputs. A guard that over-suppresses is invisible to a green suite.
 *
 * Each case here was measured on BOTH trees — HEAD and a pristine eeee5bd8
 * worktree — through the real authority (resolveAskingPriceSignal /
 * extractMonetaryMentions) and, where it matters, through the real consumer
 * (extractSellerFacts). The expected values below are the BASELINE's behavior
 * wherever the baseline was right, and the PR's improved behavior wherever the
 * PR genuinely fixed something.
 *
 * Three regression families were found this way, none of them raised by any
 * review thread:
 *   1. per-unit prices eaten by "unit" being a street-type token
 *   2. capitalized monetary qualifiers ("300 Net") eaten by the proper-noun branch
 *   3. "/month" rent figures reclassified as the seller's ASKING PRICE
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  extractMonetaryMentions,
  resolveAskingPriceSignal,
  MONETARY_KINDS,
} from "@/lib/domain/seller-flow/monetary-understanding.js";
import { extractSellerFacts } from "@/lib/domain/seller-flow/extract-seller-facts.js";
import { parseSellerAskingPrice } from "@/lib/domain/classification/classify.js";

const askingPrice = (message) => resolveAskingPriceSignal(message, {})?.asking_price?.value ?? null;
/**
 * The reference is what lets a per-unit figure scale, and it is present in the
 * real negotiation path. Probing only the no-reference form hid a whole
 * regression family: several inputs are null on BOTH trees without a reference,
 * so the delta only appears once the option is supplied. Vary the options
 * matrix, not just the input string.
 */
const askingPriceWithReference = (message, reference) =>
  resolveAskingPriceSignal(message, { reference })?.asking_price?.value ?? null;
const factPrice = (message) =>
  extractSellerFacts({ message })?.facts?.asking_price?.value?.amount ?? null;
const kindsOf = (message) =>
  extractMonetaryMentions(message, {}).map((m) => `${m.kind}:${m.value}`);

// ── FAMILY 1: per-unit prices ───────────────────────────────────────────────
// "unit" is in STREET_TYPE_TOKENS, so the bare-number address guard deleted
// real per-unit money. Baseline extracted these; HEAD must not lose them.

test("per-unit prices survive the address guard", () => {
  for (const [message, expected] of [
    ["300 per unit", 300],
    ["300 a unit", 300],
    ["I'd do 300 a unit", 300],
    ["300 per unit is my number", 300],
  ]) {
    assert.equal(
      askingPrice(message),
      expected,
      `${JSON.stringify(message)} is a price, not 300 Unit Street`
    );
  }
});

test("per-unit prices scale against a reference — the form the negotiation path uses", () => {
  // These are the cases the no-reference probe could not see: null on BOTH
  // trees without a reference, but 300000/95000 on eeee5bd8 and null on
  // 127c829b once one is supplied. The regression is only visible here.
  for (const [message, reference, expected] of [
    ["I want 300 per unit", 200000, 300000],
    ["I'd do 300 a unit", 200000, 300000],
    ["asking 95 per unit for all 4", 380000, 95000],
  ]) {
    assert.equal(
      askingPriceWithReference(message, reference),
      expected,
      `${JSON.stringify(message)} must scale against its reference`
    );
  }
});

test("per-unit prices reach the fact extractor, not just the signal", () => {
  assert.equal(factPrice("300 per unit"), 300);
  assert.equal(factPrice("I'd do 300 a unit"), 300);
});

// ── FAMILY 2: capitalized monetary qualifiers ───────────────────────────────
// isAddressAdjacent's proper-noun branch fires on ANY capitalized non-scale
// word following a bare number. "Net" is a monetary qualifier, not a street
// name. Distinct root cause from family 1 — the function-word allowlist does
// not reach it.

test("a capitalized monetary qualifier does not make the number an address", () => {
  assert.equal(askingPrice("I need 300 Net"), 300, '"Net" is a price qualifier, not a street name');
  assert.equal(askingPrice("my net is 300 Net"), 300);
  // Same family, scaled form: 300000 on eeee5bd8, null at 127c829b.
  assert.equal(askingPriceWithReference("I need 300 Net", 200000), 300000);
  assert.equal(askingPriceWithReference("my net is 300 Net", 200000), 300000);
});

test("the lowercase form was never affected — the bug is capitalization-specific", () => {
  // Control: proves the assertions above isolate the proper-noun branch.
  assert.equal(askingPrice("I need 300 net"), 300);
});

// ── FAMILY 3: /month rent reclassified as an asking price ───────────────────
// The cue substring->word-boundary switch stopped "/mo" matching inside
// "/month". No other MONTHLY_AMOUNT cue covers that written form, so the number
// falls through to the ask-cue branch and becomes the seller's asking price.
// This one FABRICATES money rather than losing it.

test("a monthly rent figure is never classified as an asking price", () => {
  for (const message of [
    "rent is $500/month",
    "$1,200/month rent",
    "tenant pays 950/month",
    "its rented at $1,450/month",
  ]) {
    const kinds = kindsOf(message);
    assert.equal(
      kinds.some((k) => k.startsWith(`${MONETARY_KINDS.ASKING_PRICE}:`)),
      false,
      `${JSON.stringify(message)} states rent, not an asking price — got ${JSON.stringify(kinds)}`
    );
    assert.equal(
      kinds.some((k) => k.startsWith(`${MONETARY_KINDS.MONTHLY_AMOUNT}:`)),
      true,
      `${JSON.stringify(message)} must classify as monthly_amount — got ${JSON.stringify(kinds)}`
    );
  }
});

test("rent never becomes a seller asking price on the consumer path", () => {
  // The escalation that makes this a blocker: these reach extractSellerFacts,
  // which feeds the negotiation/offer engines. Baseline returned null for both.
  assert.equal(askingPrice("$1,200/month rent"), null, "rent is not what the seller wants for the house");
  assert.equal(factPrice("$1,200/month rent"), null);
  assert.equal(askingPrice("its rented at $1,450/month"), null);
  assert.equal(factPrice("its rented at $1,450/month"), null);
});

test("the short /mo form still works — it was never broken", () => {
  // Control isolating the regression to the "/month" written form.
  const kinds = kindsOf("950/mo");
  assert.equal(kinds.some((k) => k.startsWith(`${MONETARY_KINDS.MONTHLY_AMOUNT}:`)), true);
  assert.equal(askingPrice("950/mo"), null);
});

test("spelled-out monthly forms still work", () => {
  for (const message of ["500 per month", "500 monthly", "500 each month"]) {
    assert.equal(
      kindsOf(message).some((k) => k.startsWith(`${MONETARY_KINDS.MONTHLY_AMOUNT}:`)),
      true,
      `${JSON.stringify(message)} must stay monthly_amount`
    );
  }
});

// ── IMPROVEMENTS THIS PR MADE — these must never regress back ───────────────
// Measured as genuinely better than eeee5bd8. Locking them so a fix for the
// families above cannot over-correct and reopen the original defects.

test("street numbers are not money (the fix this PR shipped)", () => {
  for (const message of [
    "4157 S Main St", // direction-prefixed: baseline returned 4157
    "My house is at 4157 S Main St",
    "4157 North Main St",
    "327 W Pennsylvania Ave",
    "327 Pennsylvania Ave",
    "331 Oak Street",
    "its 8612 Oak Leaf Rd", // baseline returned 8612
    "1200 Pillsbury Ave", // baseline returned 1200
    "327 3rd St",
  ]) {
    assert.equal(askingPrice(message), null, `${JSON.stringify(message)} is an address, not a price`);
  }
});

test("ZIP codes and purchase years are not money", () => {
  // Baseline returned 38104 and 1997 respectively.
  assert.equal(askingPrice("My zip is 38104"), null);
  assert.equal(askingPrice("I bought it in 1997"), null);
});

test("the word-boundary cue fix still holds — 'however' does not contain the payoff cue", () => {
  // The incident this PR fixed: "owe" matched inside "however", binding the
  // seller's price to MORTGAGE_PAYOFF and discarding it. Baseline: null.
  assert.equal(askingPrice("For 327 Pennsylvania alone 130,000"), 130000);
  assert.equal(askingPrice("(331 Pennsylvania) I want 130,000"), 130000);
});

test("multi-property messages bind the price to the stated figure", () => {
  // Baseline returned null with conflicting_price_statements, because the
  // street number 4157 was admitted as money and fought the real 250k.
  assert.equal(
    askingPrice("I have 331 Oak and 4157 S Main St, I want 250k for the Oak one"),
    250000,
    "the seller's stated 250k must win over a street number"
  );
});

// ── Spanish prices ──────────────────────────────────────────────────────────
// This file had no Spanish coverage at all. Spanish sellers are a real segment
// and "mil" is a SCALE word (1_000), so every Spanish price runs through a
// multiplier that English prices never touch.

test("Spanish 'mil' prices extract at the correct magnitude, not 1000x", () => {
  // A 1000x inflation here would offer $150,000,000 on a $150,000 house.
  for (const [message, expected] of [
    ["quiero 150 mil", 150000],
    ["quiero 150 mil por la casa", 150000],
    ["150 mil", 150000],
    ["pido 200 mil", 200000],
    ["150 mil pesos", 150000],
    ["quiero $150 mil", 150000],
    ["quiero 200 mil dolares", 200000],
    ["lo doy en 150 mil", 150000],
  ]) {
    assert.equal(
      askingPrice(message),
      expected,
      `${JSON.stringify(message)} must be ${expected}, not ${expected * 1000}`
    );
  }
});

test("Spanish spelled-out prices extract at the correct magnitude", () => {
  assert.equal(askingPrice("ciento cincuenta mil"), 150000);
  assert.equal(askingPrice("quiero ciento cincuenta mil"), 150000);
});

test("classify's OWN extractor agrees with the monetary authority on Spanish 'mil'", () => {
  // THIS is where the launch blocker lived. classify.js scaled any suffix
  // starting with "m" by 1_000_000, so Spanish "mil" (thousand) became a
  // million: "quiero 150 mil" was read as $150,000,000 on a $150,000 house.
  // monetary-understanding.js had `mil: 1_000` correct all along, so the two
  // extractors disagreed by three orders of magnitude on the single most common
  // Spanish price phrasing — and nothing in the suite exercised a Spanish price
  // through classify, which is why it shipped undetected.
  //
  // Both extractors are asserted together so they can never diverge again.
  for (const [message, expected] of [
    ["quiero 150 mil", 150000],
    ["150 mil", 150000],
    ["pido 200 mil", 200000],
    ["lo doy en 150 mil", 150000],
    ["vendo en 250 mil", 250000],
  ]) {
    assert.equal(
      parseSellerAskingPrice(message)?.value ?? null,
      expected,
      `classify must read ${JSON.stringify(message)} as ${expected}, not ${expected * 1000}`
    );
    assert.equal(askingPrice(message), expected, "and the monetary authority must agree");
  }
});

test("a real million still scales to a million — the 'mil' fix must not over-correct", () => {
  // The control that makes the fix above safe: narrowing the "m" suffix must
  // not stop a genuine million from scaling.
  assert.equal(parseSellerAskingPrice("1.2 million")?.value ?? null, 1200000);
  assert.equal(askingPrice("1.2 million"), 1200000);
  assert.equal(parseSellerAskingPrice("150k")?.value ?? null, 150000);
  assert.equal(askingPrice("150k"), 150000);
});

test("KNOWN GAP: Spanish million forms are not extracted at all", () => {
  // "un millon" and "1.2 millones" yield nothing on BOTH extractors — a miss,
  // not an inflation, and the mirror image of the "mil" defect. Pinned so the
  // Spanish scale vocabulary is visibly incomplete rather than silently so.
  for (const message of ["un millon", "1.2 millones"]) {
    assert.equal(askingPrice(message), null, "CURRENT BEHAVIOUR");
    assert.equal(parseSellerAskingPrice(message)?.value ?? null, null, "CURRENT BEHAVIOUR");
  }
});

test("a redundant 'NNN,NNN mil' resolves to the magnitude actually stated", () => {
  // "150,000 mil" carries BOTH a thousands separator and the scale word — a
  // redundant form meaning 150 thousand. It was briefly an accepted residual at
  // 150,000,000 (the mil multiplier applied to a base already at thousands
  // magnitude), then closed in 21f8a395 / dae3a945 rather than shipped.
  assert.equal(askingPrice("150,000 mil"), 150000);
});

test("DOCUMENTED RESIDUAL: 'mil' after a thousands-scale number is read as redundant, not multiplicative", () => {
  // A DECISION, not a defect awaiting a fix. Treating "mil" as redundant after a
  // number that already carries thousands magnitude is what closed the
  // 150,000,000 inflation — and the same rule means "1,200 mil" resolves to
  // 1,200 rather than 1,200,000, which is what eeee5bd8 returned.
  //
  // Accepted for four reasons, recorded so this is not rediscovered as a bug:
  //  1. It is CONSISTENT across both parsers — no divergence, which is the
  //     condition that let the original Spanish blocker hide.
  //  2. It fails in the SAFE direction. The original defect OVER-stated by 1000x
  //     and could authorize an absurd offer; this UNDER-states, and an
  //     under-stated price is caught by a human rather than acted on.
  //  3. The natural Spanish forms for that magnitude are "1.2 millones" and
  //     "un millón", not "1,200 mil".
  //  4. Fixing it requires a magnitude threshold — i.e. guessing which of two
  //     stated magnitudes the seller meant. That class of disambiguation
  //     heuristic is exactly how regression families 2-5 were introduced.
  for (const [message, expected, baseline] of [
    ["1,200 mil", 1200, 1200000],
    ["9,000 mil", 9000, 9000000],
  ]) {
    assert.equal(askingPrice(message), expected, `ACCEPTED RESIDUAL (eeee5bd8 gave ${baseline})`);
    assert.equal(
      parseSellerAskingPrice(message)?.value ?? null,
      expected,
      "and both parsers must agree on the residual"
    );
  }

  // The forms the rule exists to protect are unaffected.
  assert.equal(askingPrice("150 mil"), 150000);
  assert.equal(askingPrice("2 mil"), 2000);
  assert.equal(askingPrice("1.2 million"), 1200000);
});

test("the two extractors never diverge on 'mil'", () => {
  // The original Spanish launch blocker WAS an extractor divergence: classify
  // scaled "mil" by 1_000_000 while monetary-understanding used 1_000, so the
  // two disagreed by three orders of magnitude and the defect hid until a
  // targeted probe found it.
  //
  // While "150,000 mil" was an accepted residual this guard could not be
  // asserted — the two extractors were briefly 1000x apart on exactly that
  // string, which is the more dangerous state than the residual itself because
  // the string looked handled. Both now agree, so the invariant is pinned: any
  // future fix to one extractor must move the other with it.
  for (const message of [
    "150,000 mil",
    "1,200 mil",
    "9,000 mil",
    "quiero 150 mil",
    "150 mil",
    "pido 200 mil",
    "2 mil",
    "1.2 million",
    "150k",
  ]) {
    assert.equal(
      parseSellerAskingPrice(message)?.value ?? null,
      askingPrice(message),
      `classify and monetary-understanding must agree on ${JSON.stringify(message)}`
    );
  }
});

test("legitimate money survives the clock-time and 'mil' narrowing", () => {
  // Controls for both fixes at once: narrowing the "m" suffix and gating bare
  // digits after "at"/"between" must not cost real prices, including the
  // preposition and range forms those gates touch directly.
  for (const [message, expected] of [
    ["at least 85k", 85000],
    ["meet me at 200k", 200000],
    ["between 100k and 150k", 100000],
    ["at $200k", 200000],
    ["$500,000", 500000],
  ]) {
    assert.equal(
      parseSellerAskingPrice(message)?.value ?? null,
      expected,
      `classify must preserve ${JSON.stringify(message)}`
    );
    assert.equal(askingPrice(message), expected, "and the monetary authority must agree");
  }
});

test("KNOWN GAP: a fully spelled-out Spanish price with no digits is not extracted", () => {
  // "doscientos mil" (two hundred thousand) yields nothing. A miss, not an
  // inflation — the seller's price is dropped rather than misread.
  assert.equal(askingPrice("doscientos mil"), null, "CURRENT BEHAVIOUR");
});

// ── legitimate prices must always extract ───────────────────────────────────

test("prices carrying real monetary evidence always extract", () => {
  for (const [message, expected] of [
    ["$185,000", 185000],
    ["I would take $185,000", 185000],
    ["My price is $250,000", 250000],
    ["I want 250k", 250000],
    ["I want 250,000", 250000],
    ["300 grand", 300000],
    ["250 thousand", 250000],
    ["$1.2m", 1200000],
  ]) {
    assert.equal(askingPrice(message), expected, JSON.stringify(message));
  }
});
