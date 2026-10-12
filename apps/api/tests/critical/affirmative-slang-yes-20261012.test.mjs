/**
 * Production miss 2026-10-12 21:03Z (message_events d0eebfde): S1 ownership
 * question → seller "Yeppers" → classify unclear → no S2 reply queued.
 * A whole-message slang yes is "yes" for classification and routing — one
 * shared helper at the entry points, never a patch per regex. The stored body
 * is never rewritten.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { canonicalizeAffirmativeSlang, isAffirmativeSlang } from "@/lib/domain/classification/affirmative-slang.js";
import { classify } from "@/lib/domain/classification/classify.js";
import { planSellerConversationV3, applySellerConversationV3, V3_USE_CASES as U } from "@/lib/domain/seller-flow/seller-conversation-v3.js";

const NOW = Date.parse("2026-10-12T21:03:00Z");
const S1 = "ownership_confirmation";

test("every listed slang yes canonicalizes to yes (case-insensitive)", () => {
  const forms = [
    "yeppers", "Yepper", "YUPPERS", "yupper", "yup yup", "yep yep", "yesss", "yessssss", "yess", "yesir", "yessir",
    "yes sir", "yes maam", "yes ma'am", "yessum", "yeah yeah", "yea yea", "yah", "yass", "yasss", "mhm", "mmhm", "mhmm",
    "uh huh", "uh-huh", "you bet", "ya betcha", "affirmative", "sure thing", "totally", "indeed", "aye", "yeh", "yeap", "yeppp",
  ];
  for (const f of forms) {
    assert.equal(isAffirmativeSlang(f), true, f);
    assert.equal(canonicalizeAffirmativeSlang(f), "yes", f);
  }
});

test("trailing punctuation and emoji are kept; edges trimmed", () => {
  assert.equal(canonicalizeAffirmativeSlang("Yeppers"), "yes");
  assert.equal(canonicalizeAffirmativeSlang("yessir!"), "yes!");
  assert.equal(canonicalizeAffirmativeSlang("Yuppers 👍"), "yes 👍");
  assert.equal(canonicalizeAffirmativeSlang("  Yeppers!!  "), "yes!!");
  assert.equal(canonicalizeAffirmativeSlang("Uh-huh."), "yes.");
});

test("never a negation, never part of a longer message, never a plain word it does not list", () => {
  for (const m of [
    "yeppers but not selling", "yes but not interested", "yessir not selling", "nope", "no sir", "yeah no",
    "not totally", "totally not", "yup yup yup yup yup", "yes", "Yes", "yeah", "ok", "sure", "who is this",
    "Yeppers, call me at 555-1212 about the house on Main", "", "stop",
  ]) {
    assert.equal(canonicalizeAffirmativeSlang(m), m, JSON.stringify(m));
  }
  assert.equal(canonicalizeAffirmativeSlang(null), null);
});

for (const reply of ["Yeppers", "yessir!", "Yuppers 👍"]) {
  test(`"${reply}" to the S1 ownership ask is an ownership yes and the next action is the S2 offer-interest template`, async () => {
    const yes = await classify("Yes", null, { heuristicOnly: true });
    const c = await classify(reply, null, { heuristicOnly: true });
    assert.equal(c.primary_intent, "ownership_confirmed");
    assert.equal(c.primary_intent, yes.primary_intent);
    const message = canonicalizeAffirmativeSlang(reply);
    const plan = planSellerConversationV3({ now: NOW, classification: { ...c, language: "English" }, message, stage_before: S1 });
    const applied = applySellerConversationV3({ ...c, language: "English" }, plan);
    assert.equal(applied.strategyDirective.next_action, "send_message_now");
    // the S2 offer-interest use cases: sms_templates rows, never local copy
    assert.deepEqual(applied.strategyDirective.template_preference, [U.INTEREST, U.INTEREST_FOLLOW_UP]);
    for (const uc of applied.strategyDirective.template_preference) assert.doesNotMatch(String(uc), /^local-template:/);
  });
}

test('"yeppers but not selling" is not canonicalized and is not an ownership yes', async () => {
  assert.equal(canonicalizeAffirmativeSlang("yeppers but not selling"), "yeppers but not selling");
  const c = await classify("yeppers but not selling", null, { heuristicOnly: true });
  assert.notEqual(c.primary_intent, "ownership_confirmed");
});

test("wired at the entry points; the stored body stays the seller's words", () => {
  const classifySrc = fs.readFileSync(new URL("../../src/lib/domain/classification/classify.js", import.meta.url), "utf8");
  assert.match(classifySrc, /const text = canonicalizeAffirmativeSlang\(cleanMessage\(message\)\)/);
  const flow = fs.readFileSync(new URL("../../src/lib/domain/seller-flow/process-seller-inbound-message.js", import.meta.url), "utf8");
  assert.match(flow, /const routing_message = canonicalizeAffirmativeSlang\(message\)/);
  assert.match(flow, /runtimeDeps\.classify\(routing_message,/);
  assert.equal((flow.match(/message: routing_message,/g) || []).length, 3, "v2 overlay, v2 plan and v3 plan read the routing form");
  assert.doesNotMatch(flow, /message_body: routing_message/);
});
