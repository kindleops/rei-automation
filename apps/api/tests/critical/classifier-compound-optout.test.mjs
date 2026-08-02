import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";

// Compound/embedded opt-outs found by full-corpus replay review: messages
// that combine a decline (or anything else) with a trailing STOP directive or
// remove-me phrasing. Carriers only honor the bare keyword message, so the
// classifier must bind these itself — a soft not_interested here could be
// reopened by a later re-engagement, which is a compliance violation.

const MUST_BE_BINDING = [
  // Historical production shapes (bodies paraphrased where needed)
  "NFS.         Stop",
  "No stop",
  "Please stop!!!!",
  "NOT for sale. STOP !!!",
  "I do not want to sell it please stop communication",
  "Please remove my name and number from your data base",
  "Not interested. STOP.",
  "wrong person, stop",
  "Unsubscribe",
  "not selling, unsubscribe!",
  "Take me off. Opt out",
];

const MUST_NOT_BE_BINDING = [
  "I get off at the bus stop on Maple",
  "you people never stop do you",
  "don't stop working on that offer",
  "we can stop by the property tomorrow",
  "what price would make this stop feeling like a lowball",
  "Yes I want to sell",
  "esa casa es para mi hija", // Spanish "para" must never trail-match
];

test("compound trailing STOP directives are binding opt-outs", async () => {
  for (const body of MUST_BE_BINDING) {
    const result = await classify(body, null, { heuristicOnly: true });
    const binding =
      result.compliance_flag === "stop_texting" || result.primary_intent === "opt_out";
    assert.equal(binding, true, `${body} → ${result.primary_intent}/${result.compliance_flag}`);
  }
});

test("benign uses of stop/para never bind", async () => {
  for (const body of MUST_NOT_BE_BINDING) {
    const result = await classify(body, null, { heuristicOnly: true });
    assert.notEqual(result.compliance_flag, "stop_texting", body);
    assert.notEqual(result.primary_intent, "opt_out", body);
  }
});

test("wrong-number + stop keeps binding suppression with wrong-number routing", async () => {
  const result = await classify(
    "This is not Cheryl's number do not text at this number again",
    null,
    { heuristicOnly: true }
  );
  assert.equal(result.compliance_flag, "stop_texting");
});
