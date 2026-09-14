/**
 * seller-statement-mood.test.mjs
 *
 * Four sentences, one number, four meanings:
 *
 *   Is your offer 175?   a question about OUR number
 *   Could you do 175?    a request testing whether we will
 *   I'll take 175.       an acceptance
 *   I need 175.          their floor
 *
 * An extractor that sees "175 near price words" produces a seller price for all
 * four. Two are fabricated — and reading a question as an answer means we stop
 * asking something the seller never answered.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyStatementMood,
  permitsExplicitAssertion,
  splitSentences,
  MOOD,
} from "../../src/lib/domain/seller-intelligence/statement-mood.js";

// ── the four sentences ─────────────────────────────────────────────────────

test("a question about our offer is a question", () => {
  const result = classifyStatementMood("Is your offer 175?");
  assert.equal(result.mood, MOOD.QUESTION);
  assert.equal(result.assertive, false);
});

test("a request is not the seller stating their number", () => {
  const result = classifyStatementMood("Could you do 175?");
  assert.equal(result.assertive, false);
});

test("an acceptance IS assertive", () => {
  const result = classifyStatementMood("I'll take 175.");
  assert.equal(result.mood, MOOD.ASSERTION);
  assert.equal(result.assertive, true);
});

test("a requirement IS assertive", () => {
  const result = classifyStatementMood("I need 175.");
  assert.equal(result.assertive, true);
});

test("only the assertive half of the four permits an explicit fact", () => {
  assert.equal(permitsExplicitAssertion("Is your offer 175?"), false);
  assert.equal(permitsExplicitAssertion("Could you do 175?"), false);
  assert.equal(permitsExplicitAssertion("I'll take 175."), true);
  assert.equal(permitsExplicitAssertion("I need 175."), true);
});

// ── questions ──────────────────────────────────────────────────────────────

test("a question mark is decisive", () => {
  for (const text of [
    "What would you pay?",
    "Are you investors or brokers?",
    "How soon could you close?",
    "175?",
  ]) {
    assert.equal(classifyStatementMood(text).assertive, false, text);
  }
});

test("an interrogative opener without a question mark is still a question", () => {
  // People drop question marks constantly, especially on phones.
  assert.equal(classifyStatementMood("what would you pay for it").assertive, false);
  assert.equal(classifyStatementMood("can you close by the 20th").assertive, false);
});

test("a question followed by a commitment keeps the commitment", () => {
  // "Would you take 185? I'd do 185" is both. The half with consequences wins.
  const result = classifyStatementMood("Would you take 185? I'd do 185.");
  assert.equal(result.assertive, true);
});

// ── negation ───────────────────────────────────────────────────────────────

test("a negation is not the assertion it contains", () => {
  // "I don't need 200 anymore" literally contains "I need 200". Reading it as a
  // requirement re-asserts the thing the seller just retired.
  const result = classifyStatementMood("I don't need 200 anymore.");
  assert.notEqual(result.mood, MOOD.ASSERTION);
});

test("common negations are recognised", () => {
  for (const text of [
    "It is not vacant.",
    "It isn't vacant.",
    "I don't own that house.",
    "I'm not interested.",
    "It's not listed.",
  ]) {
    const result = classifyStatementMood(text);
    assert.ok(
      [MOOD.NEGATION, MOOD.PAST_STATE].includes(result.mood),
      `${text} was read as ${result.mood}`
    );
  }
});

// ── correction outranks everything ────────────────────────────────────────

test("a correction is a correction, not a negation", () => {
  // "Sorry, I meant 190, not 290" contains a negation and two numbers. Reading
  // it as a negation retires 290 and never records 190.
  const result = classifyStatementMood("Sorry, I meant 190, not 290.");
  assert.equal(result.mood, MOOD.CORRECTION);
});

test("correction phrasings are recognised", () => {
  for (const text of [
    "Correction: 190 not 290.",
    "Make that 190.",
    "Scratch that, 190.",
    "Typo — I meant 190.",
    "Sorry I misspoke, 190.",
  ]) {
    assert.equal(classifyStatementMood(text).mood, MOOD.CORRECTION, text);
  }
});

// ── past state is not a denial of the present ─────────────────────────────

test("a past state is not a negation of the present", () => {
  // "The tenant used to live there" does not deny that anyone lives there now.
  const result = classifyStatementMood("The tenant used to live there, but they moved out.");
  assert.equal(result.mood, MOOD.PAST_STATE);
  assert.equal(result.assertive, false);
});

test("past-state markers are recognised", () => {
  for (const text of [
    "It was vacant previously.",
    "That's no longer the case.",
    "I don't need that anymore.",
    "It has since been rented.",
  ]) {
    assert.equal(classifyStatementMood(text).assertive, false, text);
  }
});

// ── conditionals are real offers, not idle hypotheticals ──────────────────

test("a conditional COMMITMENT is assertive", () => {
  // "I'd do 185 if you close Friday" is a real offer with a condition on it,
  // not a musing. Treating it as hypothetical would lose a live number.
  const result = classifyStatementMood("I'd do 185 if you close before the 20th.");
  assert.equal(result.assertive, true);
  assert.ok(result.reasons.includes("conditional_commitment"));
});

test("a conditional with NO commitment is hypothetical", () => {
  const result = classifyStatementMood("What if you covered the taxes?");
  assert.equal(result.assertive, false);
});

// ── per sentence, not per message ─────────────────────────────────────────

test("mood is per sentence, because one message holds several", () => {
  // "Is your offer 175? I need 195." is a question AND a requirement. Judging
  // the message by its first sentence loses the requirement.
  const sentences = splitSentences("Is your offer 175? I need 195.");
  assert.equal(sentences.length, 2);
  assert.equal(classifyStatementMood(sentences[0]).assertive, false);
  assert.equal(classifyStatementMood(sentences[1]).assertive, true);
});

test("sentences split on newlines as well as terminators", () => {
  const sentences = splitSentences("Yes I own it\nI'd want 200\nCall me Tuesday");
  assert.equal(sentences.length, 3);
});

test("splitting never returns empty fragments", () => {
  for (const text of ["", "   ", "...", "\n\n\n", null, undefined]) {
    const sentences = splitSentences(text);
    assert.equal(sentences.every((s) => s.length > 0), true, String(text));
  }
});

// ── plain assertions still work ───────────────────────────────────────────

test("ordinary seller statements are assertive", () => {
  for (const text of [
    "The property is vacant.",
    "Yes I own it outright.",
    "My asking price is 215000.",
    "185 and it's yours.",
  ]) {
    assert.equal(classifyStatementMood(text).assertive, true, text);
  }
});

// ── hostile input ─────────────────────────────────────────────────────────

test("mood classification never throws", () => {
  for (const value of [null, undefined, "", 0, [], {}, { text: {} }, "?".repeat(10_000)]) {
    assert.doesNotThrow(() => classifyStatementMood(value), String(value).slice(0, 20));
  }
});

test("an empty sentence is not treated as a question", () => {
  const result = classifyStatementMood("");
  assert.equal(result.empty, true);
});

// ── aggregation across sentences ──────────────────────────────────────────

test("a commitment anywhere in the message survives aggregation", () => {
  // The cost of missing a stated number is higher than the cost of also
  // noticing a question alongside it.
  for (const text of [
    "Would you take 185? I'd do 185.",
    "Are you investors? Anyway, I need 200.",
    "How soon can you close? I'll take 190.",
  ]) {
    assert.equal(classifyStatementMood(text).assertive, true, text);
  }
});

test("a correction anywhere outranks everything else in the message", () => {
  const result = classifyStatementMood("Is that your best? Sorry, I meant 190, not 290.");
  assert.equal(result.mood, MOOD.CORRECTION);
});

test("a message of only questions stays non-assertive", () => {
  const result = classifyStatementMood("Are you investors? How did you get my number?");
  assert.equal(result.assertive, false);
});

test("aggregation is marked, so a reader knows it happened", () => {
  const result = classifyStatementMood("Are you investors? I need 200.");
  assert.ok(result.reasons.includes("aggregated"));
});

test("aggregation terminates on pathological input", () => {
  // The aggregate recurses into classifyStatementMood per sentence. A sentence
  // that split into itself would not terminate.
  const started = Date.now();
  assert.doesNotThrow(() => classifyStatementMood("a. ".repeat(5_000)));
  assert.ok(Date.now() - started < 5_000);
});

test("asking how we got their number is a question, not a commitment", () => {
  // A real defect this test found: the commitment pattern matched a bare "my
  // number", so "How did you get my number?" read as assertive. That phrase is
  // its own canonical intent (asks_how_number_obtained) and is the OPPOSITE of
  // a commitment -- it is a seller challenging the contact.
  for (const text of [
    "How did you get my number?",
    "Where did you get my number",
    "Who gave you my number?",
  ]) {
    assert.equal(classifyStatementMood(text).assertive, false, text);
  }
});

test("a real price commitment still reads as one", () => {
  // The fix tightened the pattern, so this proves it did not tighten it shut.
  for (const text of [
    "My price is 215000.",
    "My asking price is 215000.",
    "My bottom line is 190.",
  ]) {
    assert.equal(classifyStatementMood(text).assertive, true, text);
  }
});
