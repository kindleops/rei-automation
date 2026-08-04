/**
 * Explicit call readiness must not classify as `unclear`.
 *
 * "We can schedule a call and talk" resolved to unclear (0.6) and went to
 * review. The ontology already models this as `requests_call` (reply required,
 * human places the call, warm, interested, no suppression); only the classifier
 * was missing the scheduling forms.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";

const intentOf = async (text) =>
  (await classify(text, null, { heuristicOnly: true })).primary_intent;

for (const text of [
  "We can schedule a call and talk",
  "We can schedule a call",
  "lets set up a call",
  "let's schedule a time",
  "can we hop on a call",
  "call me",
  "give me a call tomorrow",
  "what is a good time to call",
  "call anytime",
]) {
  test(`call readiness: ${JSON.stringify(text)}`, async () => {
    const intent = await intentOf(text);
    assert.equal(intent, "callback_requested", `${text} must read as call readiness`);
    assert.notEqual(intent, "unclear");
  });
}

test("call readiness is never suppression and never fabricates selling interest", async () => {
  const result = await classify("We can schedule a call and talk", null, { heuristicOnly: true });
  assert.equal(result.primary_intent, "callback_requested");
  assert.notEqual(result.primary_intent, "opt_out");
  assert.notEqual(result.primary_intent, "not_interested");
  assert.notEqual(result.primary_intent, "ownership_confirmed", "no fabricated ownership");
  assert.notEqual(result.primary_intent, "asking_price_provided", "no fabricated price");
});

test("the ontology already routes requests_call correctly", async () => {
  const { INBOUND_INTENT_ONTOLOGY } = await import(
    "@/lib/domain/classification/inbound-intent-ontology.js"
  );
  const entry = INBOUND_INTENT_ONTOLOGY.requests_call;
  assert.ok(entry, "requests_call must exist");
  assert.equal(entry.reply_policy.reply_required, true);
  assert.equal(entry.reply_policy.reply_permitted, true);
  assert.equal(entry.state_hints.lead_temperature, "warm");
});

test("unrelated or negative language is unaffected", async () => {
  assert.equal(await intentOf("I am not interested"), "not_interested");
  assert.equal(await intentOf("STOP"), "opt_out");
  assert.equal(await intentOf("do not call me"), "opt_out");
  assert.notEqual(await intentOf("we can talk later"), "callback_requested");
});
