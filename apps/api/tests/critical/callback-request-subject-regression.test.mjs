/**
 * A callback request needs a request subject.
 *
 * "I have a call at 3" reports an existing appointment. It does not ask us to
 * call. The classifier matched it on TWO unconditional phrases at once — the
 * bare "have a call" and the bare "call at" — so removing either one alone left
 * the false positive intact. Both are now gated on a request or
 * mutual-availability subject.
 *
 * The negative assertions check primary_intent, secondary_intents AND
 * matched_intents. Primary alone is not enough: at the time this was written
 * "I have a call at 3" carried callback_requested as a SECONDARY intent while a
 * separate, pre-existing pricing defect (parseSellerAskingPrice reading the
 * bare "3" as $3) held primary. That pricing defect is deliberately out of
 * scope here — these tests assert only the callback dimension, so they stay
 * meaningful whichever way the pricing question is later resolved.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";

const classifyText = (text) => classify(text, null, { heuristicOnly: true });

/** Every axis the intent can appear on — primary is not the only one. */
function callbackAxes(result) {
  return {
    primary: result.primary_intent,
    secondary: result.secondary_intents || [],
    matched: result.matched_intents || [],
  };
}

function assertNoCallback(result, text) {
  const axes = callbackAxes(result);
  assert.notEqual(
    axes.primary,
    "callback_requested",
    `${text} must not be callback_requested (primary was ${axes.primary})`
  );
  assert.equal(
    axes.secondary.includes("callback_requested"),
    false,
    `${text} must not carry callback_requested as a secondary intent (got ${JSON.stringify(axes.secondary)})`
  );
  assert.equal(
    axes.matched.includes("callback_requested"),
    false,
    `${text} must not match the callback rule at all (got ${JSON.stringify(axes.matched)})`
  );
}

// ── Reports of an existing appointment — never a request for contact ────────
// The adjective-padded cases are the second round of this defect. The first fix
// excluded a determiner immediately before "call" ("a call at 3"), which any
// adjective defeats: in "I have a scheduled call at 3pm" the token before
// "call" is "scheduled". Enumerating how a noun phrase can be padded is
// open-ended, so the rule now requires a positive request subject instead.
for (const text of [
  "I have a call at 3",
  "I have a call at 3pm today",
  "Sorry I have a call right now",
  "I have another call coming in",
  "we already had a call",
  "my call at 4 ran long",
  // Adjective between the determiner and the noun.
  "I have a scheduled call at 3pm",
  "I have an important call at 4",
  "I have a quick call at 2",
  "I have a conference call at 9",
  "I already have a call at 3",
  // Other appointment reports.
  "the call at noon ran long",
  "Im currently on a call",
  "sorry im on a call at the moment",
]) {
  test(`not a callback request: ${JSON.stringify(text)}`, async () => {
    assertNoCallback(await classifyText(text), text);
  });
}

// ── Genuine requests must survive the gate ──────────────────────────────────
for (const text of [
  // "have a call" WITH a request / mutual-availability subject.
  "can we have a call",
  "could we have a short call",
  "can we have a quick call tomorrow",
  "lets have a call",
  "let us have a call",
  "we can have a call",
  "we should have a call",
  "I would like to have a call",
  "want to have a call",
  "wanna have a call",
  "would love to have a call",
  // "call at" as a verb, which the request-subject gate must still admit.
  "call at 2145551212",
  "You can call at 5pm",
  "Please call at your convenience",
  // Unconditional phrases — untouched by this change, asserted so a future
  // edit to the gate cannot quietly take them down with it.
  "schedule a call",
  "schedule a time",
  "set up a call",
  "setup a call",
  "hop on a call",
  "can we hop on a call",
  "jump on a call",
  "get on a call",
  "call me",
  "give me a call tomorrow",
  "text me",
  "call anytime",
  "when can you call",
  "what is a good time to call",
  "We can schedule a call and talk",
]) {
  test(`still a callback request: ${JSON.stringify(text)}`, async () => {
    const result = await classifyText(text);
    assert.equal(
      result.primary_intent,
      "callback_requested",
      `${text} must read as a callback request (got ${result.primary_intent})`
    );
  });
}

// ── Request-subject forms of "call at", asserted on the CALLBACK AXIS ──────
// These carry a bare 1-2 digit time ("call at 3"), which a separate,
// pre-existing and deliberately out-of-scope defect reads as an asking price —
// so primary_intent is captured by asking_price_provided for several of them.
// Asserting the callback axis keeps these meaningful either way, and they will
// still hold if the pricing defect is fixed later.
for (const text of [
  "Can you call at 3?",
  "You can call at 3",
  "Please call at 3",
  "could we call at 4",
  "u can call at 6",
  "best to call at 5",
  "Sure, call at 3",
  "Im busy. Please call at 5",
  "Call at 3 works for me",
  "Can we have a call at 3?",
  "Give me a call at 3",
  "Schedule a call for 3",
]) {
  test(`request-subject "call at" still reads as a callback: ${JSON.stringify(text)}`, async () => {
    const result = await classifyText(text);
    const axes = callbackAxes(result);
    assert.equal(
      axes.matched.includes("callback_requested") || axes.primary === "callback_requested",
      true,
      `${text} must match the callback rule (got primary ${axes.primary}, matched ${JSON.stringify(axes.matched)})`
    );
  });
}

test("the gate admits an adjective the old substring match could not span", async () => {
  // "can we have a quick call tomorrow" classified as `unclear` before the
  // gate existed: no literal phrase could span the inserted adjective.
  for (const text of ["can we have a quick call tomorrow", "could we have a short call"]) {
    const result = await classifyText(text);
    assert.equal(result.primary_intent, "callback_requested", text);
    assert.notEqual(result.primary_intent, "unclear", text);
  }
});

test("gating callbacks does not fabricate suppression, interest, or a price", async () => {
  const result = await classifyText("I have a call at 3pm today");
  assert.notEqual(result.primary_intent, "opt_out", "no fabricated suppression");
  assert.notEqual(result.primary_intent, "not_interested");
  assert.notEqual(result.primary_intent, "ownership_confirmed", "no fabricated ownership");
  assert.notEqual(result.primary_intent, "asking_price_provided", "no fabricated price");
});

test("unrelated language is unaffected by the callback gate", async () => {
  assert.equal((await classifyText("I am not interested")).primary_intent, "not_interested");
  assert.equal((await classifyText("STOP")).primary_intent, "opt_out");
  assert.equal((await classifyText("do not call me")).primary_intent, "opt_out");
  assert.notEqual((await classifyText("we can talk later")).primary_intent, "callback_requested");
});
