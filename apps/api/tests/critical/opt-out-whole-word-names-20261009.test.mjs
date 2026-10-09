/**
 * P0 2026-10-09 (owner): "anytime there's a Christopher in the name it
 * automatically suppresses the thread". chriSTOPher / Kristopher / Stopher /
 * Christophe contain the substring "stop". Every opt-out keyword list is
 * matched as WHOLE WORDS; names and ordinary words ("weekend", "Paramount",
 * "issue") never become opt-outs or legal threats. Real STOP keeps working.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { detectInboundIntent } from "@/lib/domain/classification/classify.js";
import { includesAnyWholeWord, includesWholeWord } from "@/lib/domain/compliance/whole-word.js";
import { classifyInboxMessage, findMatchedKeywords } from "@/lib/domain/inbox/keywords.js";
import { extractOptOutDetails } from "@/lib/domain/events/seller-message-event.js";
import { normalizeSellerInboundIntent } from "@/lib/domain/seller-flow/resolve-seller-auto-reply-plan.js";
import { resolveInboxThreadState } from "@/lib/domain/inbox/resolveInboxThreadState.js";

const OPT_OUT = ["STOP", "stop.", "Stop texting me", "please stop"];
const NOT_OPT_OUT = [
  "Christopher", "This is Christopher", "Kristopher here", "Stopher", "Christophe",
  "Hi Christopher, are you still the owner?", "non-stop", "bus stop near the house",
  "weekend works", "Paramount", "Endicott",
];

test("canonical classifier: real STOP is an opt-out, names are not", () => {
  for (const body of OPT_OUT) assert.equal(detectInboundIntent(body)?.primary_intent, "opt_out", body);
  for (const body of NOT_OPT_OUT) assert.notEqual(detectInboundIntent(body)?.primary_intent, "opt_out", body);
});

test("whole-word helper never matches inside a word or across a hyphen", () => {
  assert.equal(includesWholeWord("Christopher", "stop"), false);
  assert.equal(includesWholeWord("Kristopher", "stop"), false);
  assert.equal(includesWholeWord("non-stop", "stop"), false);
  assert.equal(includesWholeWord("weekend", "end"), false);
  assert.equal(includesWholeWord("Paramount", "para"), false);
  assert.equal(includesWholeWord("an issue", "sue"), false);
  assert.equal(includesWholeWord("STOP!", "stop"), true);
  assert.equal(includesWholeWord("please stop.", "stop"), true);
  assert.equal(includesAnyWholeWord("take   me off", ["take me off"]), true);
});

test("live inbox keyword flags: opt_out only on the whole word", () => {
  for (const body of OPT_OUT) assert.equal(classifyInboxMessage({ message_body: body }).opt_out, true, body);
  // keywords.js is a word-level HIGHLIGHT flag (never suppression): "bus stop"
  // does contain the word "stop", so it is excluded here; the canonical
  // classifier above is the one that decides it is not an opt-out.
  for (const body of NOT_OPT_OUT.filter((b) => b !== "bus stop near the house")) {
    const flags = classifyInboxMessage({ message_body: body });
    assert.equal(flags.opt_out, false, body);
    assert.ok(!flags.matched_keywords.includes("stop"), body);
  }
  // A free search term the operator typed keeps substring semantics.
  assert.equal(findMatchedKeywords("Hi Christopher", ["chris"]).length, 1);
});

test("message-event opt-out annotation: whole words only", () => {
  assert.equal(extractOptOutDetails("Hi Christopher")["is-opt-out"], undefined);
  assert.equal(extractOptOutDetails("see you this weekend")["is-opt-out"], undefined);
  assert.equal(extractOptOutDetails("STOP")["is-opt-out"], "Yes");
  assert.equal(extractOptOutDetails("please stop texting")["is-opt-out"], "Yes");
});

test("legacy auto-reply plan intent: names are not opt-out, 'issue' is not 'sue'", () => {
  assert.notEqual(normalizeSellerInboundIntent({ message_body: "This is Christopher" }), "opt_out");
  assert.notEqual(normalizeSellerInboundIntent({ message_body: "Kristopher here, what is the issue" }), "hostile_or_legal");
  assert.equal(normalizeSellerInboundIntent({ message_body: "please stop" }), "opt_out");
  assert.equal(normalizeSellerInboundIntent({ message_body: "I will sue you" }), "hostile_or_legal");
});

test("debug thread-state resolver: a Christopher greeting is not suppressed", () => {
  const state = resolveInboxThreadState({ lastMessageBody: "Hi Christopher, still own the house?", direction: "outbound" });
  assert.notEqual(state.bucket, "suppressed");
  assert.equal(resolveInboxThreadState({ lastMessageBody: "STOP" }).bucket, "suppressed");
});
