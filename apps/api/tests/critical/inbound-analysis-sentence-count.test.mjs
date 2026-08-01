/**
 * Inbound analysis contract: sentence_count boundary detection.
 *
 * SENTENCE_SPLIT_RE must treat terminal punctuation as a sentence boundary
 * only when followed by whitespace or true end-of-input. The prior character
 * class `[\s$]` made `$` a LITERAL dollar sign, so currency-adjacent
 * punctuation ("10.$") counted as an extra boundary. sentence_count is
 * persisted in the ledger disposition_detail, so a miscount is durable.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { buildInboundAnalysis } from "@/lib/domain/inbound/inbound-analysis-contract.js";

function sentenceCount(raw_text) {
  return buildInboundAnalysis({ raw_text }).sentence_count;
}

test("punctuation followed by whitespace splits sentences", () => {
  assert.equal(
    sentenceCount("Yes we own it. Call me tomorrow. What time works?"),
    3
  );
  assert.equal(sentenceCount("Stop texting me! I already sold it."), 2);
});

test("punctuation at end of input closes the final sentence", () => {
  assert.equal(sentenceCount("Sounds good."), 1);
  assert.equal(sentenceCount("Who is this?"), 1);
  assert.equal(sentenceCount("Yes. No."), 2);
});

test("text without terminal punctuation still counts as one sentence", () => {
  assert.equal(sentenceCount("ok"), 1);
  assert.equal(sentenceCount("call me after 5"), 1);
});

test("empty input yields zero sentences", () => {
  assert.equal(sentenceCount(""), 0);
  assert.equal(sentenceCount("   "), 0);
});

test("decimals do not create sentence boundaries", () => {
  assert.equal(sentenceCount("The lot is 2.5 acres and taxes are 1200.50 a year."), 1);
  assert.equal(sentenceCount("Around 3.75 percent I think"), 1);
});

test("currency-like strings do not create sentence boundaries", () => {
  // Regression for the literal-$ character-class bug: the "." before "$" is
  // NOT a boundary. Boundaries here: ". " after "already" and final ".".
  assert.equal(sentenceCount("I paid 10.$ already. Thanks."), 2);
  assert.equal(sentenceCount("It cost 10.$"), 1);
  assert.equal(sentenceCount("$10.50 is fine. $12.75 is not."), 2);
  assert.equal(sentenceCount("I want $150,000. Not $149,999.99."), 2);
});

test("repeated punctuation counts as one boundary", () => {
  assert.equal(sentenceCount("What???"), 1);
  assert.equal(sentenceCount("Really?!? Stop!!!"), 2);
  assert.equal(sentenceCount("No way... Maybe."), 2);
});

test("multiline SMS bodies split on line-terminal punctuation", () => {
  assert.equal(sentenceCount("First line.\nSecond line!\nThird?"), 3);
  // Line break without punctuation is whitespace after normalization,
  // not a sentence boundary of its own.
  assert.equal(sentenceCount("Yes.\n\nCall after 5"), 1);
});
