/**
 * seller-language-eval.test.mjs
 *
 * THE EVAL HARNESS. Section 29 makes this a gate: EMAIL-5 may not start
 * autonomous response work without a trustworthy eval foundation, and this is
 * that foundation.
 *
 * It asserts SEMANTIC INVARIANTS rather than byte-for-byte outputs, because a
 * corpus that demands exact equality is a corpus that gets deleted the first
 * time a model is upgraded. Each case states what must be true of any
 * acceptable reading — and, just as often, what must not.
 *
 * Everything here runs against the DETERMINISTIC extractor, so the harness has
 * no model dependency, no variance and no cost. When a model layer is added it
 * runs the same corpus and must not break any invariant this proves today.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CORPUS, CORPUS_VERSION, DETERMINISTIC_CASES } from "../fixtures/seller-language/corpus.mjs";
import { extractDeterministicAssertions } from "../../src/lib/domain/seller-intelligence/deterministic-extraction.js";
import { reconcileAssertion, RECONCILIATION } from "../../src/lib/domain/seller-intelligence/reconciliation-policy.js";
import { basisRank } from "../../src/lib/domain/seller-intelligence/assertion-contract.js";

const RECEIVED_AT = "2026-09-08T18:00:00.000Z";

function run(text, channel = "email") {
  return extractDeterministicAssertions({
    body: { newest_reply: text },
    received_at: RECEIVED_AT,
    channel,
  });
}

const amountOf = (assertion) =>
  assertion?.value && typeof assertion.value === "object" ? assertion.value.amount : assertion?.value;

// ── the corpus itself ─────────────────────────────────────────────────────

test("the corpus is versioned and non-trivial", () => {
  assert.equal(CORPUS_VERSION, "seller_language_corpus_v1");
  assert.ok(CORPUS.length >= 18, `only ${CORPUS.length} cases`);
});

test("every case has an id, text and a stated reason for existing", () => {
  const ids = new Set();
  for (const entry of CORPUS) {
    assert.ok(entry.id, "a case has no id");
    assert.equal(ids.has(entry.id), false, `duplicate case id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.text && entry.text.length > 0, `${entry.id} has no text`);
    assert.ok(entry.notes && entry.notes.length > 30, `${entry.id} does not say why it exists`);
  }
});

test("every case states at least one invariant", () => {
  // A case with no expectation is a case that cannot fail, which is worse than
  // no case at all because it looks like coverage.
  for (const entry of CORPUS) {
    const has = ["must_assert", "must_not_assert", "must_value", "must_not_value", "must_have_condition", "must_not_canonical"]
      .some((key) => entry[key]);
    assert.ok(has, `${entry.id} asserts nothing`);
  }
});

test("the corpus contains no real-looking contact data", () => {
  // An eval corpus is a file people copy examples into, which makes it the
  // easiest place in a repository for production PII to accumulate.
  for (const entry of CORPUS) {
    assert.equal(/@(?!example\.)[a-z0-9-]+\.[a-z]{2,}/i.test(entry.text), false, `${entry.id} has an email address`);
    assert.equal(/\+1\d{10}/.test(entry.text), false, `${entry.id} has a phone number`);
  }
});

// ── the invariants, case by case ──────────────────────────────────────────

for (const entry of DETERMINISTIC_CASES) {
  test(`corpus: ${entry.id}`, () => {
    const result = run(entry.text);
    const byType = new Map(result.assertions.map((a) => [a.type, a]));
    const context = `${entry.id}\n  text: ${entry.text}\n  why: ${entry.notes}`;

    for (const type of entry.must_assert ?? []) {
      assert.ok(byType.has(type), `${context}\n  MISSING assertion: ${type}`);
    }

    for (const type of entry.must_not_assert ?? []) {
      assert.equal(byType.has(type), false, `${context}\n  FABRICATED assertion: ${type}`);
    }

    for (const [type, expected] of Object.entries(entry.must_value ?? {})) {
      const actual = amountOf(byType.get(type));
      assert.equal(actual, expected, `${context}\n  ${type} was ${actual}, expected ${expected}`);
    }

    for (const [type, forbidden] of Object.entries(entry.must_not_value ?? {})) {
      const actual = amountOf(byType.get(type));
      assert.notEqual(actual, forbidden, `${context}\n  ${type} took the forbidden value ${forbidden}`);
    }

    if (entry.must_have_condition) {
      const carrying = result.assertions.filter((a) =>
        (a.conditions ?? []).some((c) => c.kind === entry.must_have_condition)
      );
      assert.ok(
        carrying.length > 0,
        `${context}\n  no assertion carried condition ${entry.must_have_condition}`
      );
    }

    if (entry.min_basis) {
      for (const type of entry.must_assert ?? []) {
        const assertion = byType.get(type);
        if (!assertion) continue;
        assert.ok(
          basisRank(assertion.basis) <= basisRank(entry.min_basis),
          `${context}\n  ${type} basis ${assertion.basis} is weaker than ${entry.min_basis}`
        );
      }
    }

    for (const type of entry.must_not_canonical ?? []) {
      const assertion = byType.get(type);
      if (!assertion) continue;
      const decision = reconcileAssertion({ assertion });
      assert.notEqual(
        decision.outcome,
        RECONCILIATION.ACCEPT,
        `${context}\n  ${type} reached canonical state`
      );
    }
  });
}

// ── channel independence ──────────────────────────────────────────────────

test("SMS and email produce the SAME intelligence for every corpus case", () => {
  // Section 27's proof. Provenance may differ; meaning may not. Run over the
  // whole corpus rather than one example, so a channel-shaped rule anywhere in
  // the pipeline shows up.
  for (const entry of CORPUS) {
    const sms = run(entry.text, "sms");
    const email = run(entry.text, "email");

    const shape = (result) =>
      result.assertions
        .map((a) => `${a.type}|${a.basis}|${JSON.stringify(a.value)}|${(a.conditions ?? []).map((c) => c.kind).sort().join("+")}`)
        .sort();

    assert.deepEqual(shape(sms), shape(email), `${entry.id} read differently by channel`);
  }
});

test("nothing in a deterministic assertion records which wire it came down", () => {
  const result = run("I'd take 185k.", "email");
  for (const assertion of result.assertions) {
    const serialized = JSON.stringify(assertion);
    assert.equal(serialized.includes("email"), false, "channel leaked into an assertion");
    assert.equal(serialized.includes("sms"), false);
  }
});

// ── the floor: this works with no model at all ────────────────────────────

test("the deterministic layer alone extracts price, condition and preference", () => {
  // The system has a floor. With no model configured, an outage, a timeout or a
  // response that fails validation, these are still extracted. What degrades is
  // learning WHY they are selling -- the right thing to lose first.
  const price = run("I'd do 185k if you close before the 20th.");
  assert.ok(price.assertions.some((a) => a.type === "seller_price_expectation"));

  const preference = run("Don't call me. Email is fine.");
  assert.ok(preference.assertions.some((a) => a.type === "channel_restriction"));

  const occupancy = run("It's vacant now.");
  assert.ok(occupancy.assertions.some((a) => a.type === "occupancy_status"));
});

test("every deterministic assertion is EXPLICIT, never an inference", () => {
  // If it cannot be read off the seller's own words by rule, this layer does
  // not produce it.
  for (const entry of CORPUS) {
    for (const assertion of run(entry.text).assertions) {
      assert.equal(assertion.basis, "explicit", `${entry.id} produced a non-explicit deterministic assertion`);
    }
  }
});

// ── rejections are visible ────────────────────────────────────────────────

test("a refused reading says why, so a corpus failure is diagnosable", () => {
  const result = run("Is your offer 175k?");
  assert.equal(result.assertions.length, 0);
  assert.ok(result.rejected.length > 0, "a number was discarded with no reason recorded");
  assert.ok(result.rejected.some((r) => r.reason.startsWith("money_in_")));
});

// ── hostile input ─────────────────────────────────────────────────────────

test("the extractor never throws on any corpus case or hostile shape", () => {
  for (const entry of CORPUS) {
    assert.doesNotThrow(() => run(entry.text), entry.id);
  }
  for (const value of [null, undefined, "", 0, [], { body: null }, { body: { newest_reply: {} } }]) {
    assert.doesNotThrow(() => extractDeterministicAssertions(value), String(value));
  }
});

// ── corrections, which the corpus caught ──────────────────────────────────

test("a correction asserts the intended number and RETIRES the retracted one", () => {
  // The defect this test was written for: "Sorry, I meant 190k, not 290k"
  // asserted 290000 -- the exact value the seller had just said was wrong.
  // Mood alone cannot prevent it, because a correction IS assertive: the seller
  // is stating something. The pair has to be resolved.
  const result = run("Sorry, I meant 190k, not 290k.");
  const price = result.assertions.find((a) => a.type === "seller_price_expectation");

  assert.ok(price, "the corrected value was lost entirely");
  assert.equal(price.value.amount, 190000);
  assert.ok(result.rejected.some((r) => r.reason === "money_retracted_by_correction"));
});

test("the reversed correction order is resolved too", () => {
  const result = run("Not 290k, I meant 190k.");
  const price = result.assertions.find((a) => a.type === "seller_price_expectation");
  if (price) assert.equal(price.value.amount, 190000);
});

test("an UNRESOLVABLE correction yields nothing rather than a coin flip", () => {
  // Half of these numbers is wrong and we cannot tell which. Guessing has a
  // fifty percent chance of recording the one the seller retracted.
  const result = run("Correction: 190k. 290k. 215k.");
  assert.equal(result.assertions.filter((a) => a.type === "seller_price_expectation").length, 0);
  assert.ok(result.rejected.some((r) => r.reason === "money_in_unresolved_correction"));
});
