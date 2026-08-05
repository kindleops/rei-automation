/**
 * CHARACTERIZATION — a multi-fragment burst does NOT bind to the live question.
 *
 * This is a KNOWN LIMITATION, deliberately shipped, not a defect awaiting a fix.
 * It asserts today's behaviour so that a change to it is a visible decision
 * rather than an accident, and it records why two attempts to "fix" it were
 * built, measured, and reverted. Read this before writing a third.
 *
 * ── The limitation ────────────────────────────────────────────────────────
 * aggregateBurstMessage joins constituent bodies with "\n", and
 * isShortContextualReply tests the WHOLE normalized body against
 * ^(yes|yeah|...)$. So applyContextualShortReply is unreachable for every
 * multi-fragment burst, no matter how valid the conversation context is:
 *     "Yeah"             -> ownership_confirmed 0.88, clears the 0.82 gate
 *     "Yeah\nits a 3br"  -> unclear 0.64, routed to human review
 * The seller who volunteers MORE information gets the worse outcome. That is
 * conservative and safe — nobody is contacted wrongly — but it is a missed
 * automation opportunity, and it is the behaviour asserted below.
 *
 * ── Attempt 1: bind the first fragment. REJECTED before shipping. ─────────
 * applyContextualShortReply is a hard override — classify calls it BEFORE
 * resolveIntents and returns immediately, so nothing else in the classifier
 * runs. Binding on a fragment therefore DISCARDS every other fragment.
 * Measured with a valid ownership context:
 *     "Yeah\nSTOP"                       opt_out 0.99        -> ownership 0.88
 *     "Yeah\nnot interested"             not_interested 0.92 -> ownership 0.88
 *     "Yeah\nactually I already sold it" wrong_number 0.97   -> ownership 0.88
 * It would have auto-replied to a seller who said STOP.
 *
 * ── Attempt 2: rescue only when primary === "unclear". REVERTED. ──────────
 * Shipped as 3b40ef5a, hardened twice, then reverted. The guard was wrong for a
 * subtle reason worth stating: `primary === "unclear"` is a claim about the RULE
 * SET, not about the MESSAGE. It proves no rule matched; it does not prove no
 * stop request is present. Uncovered phrasings land in `unclear`, which was
 * exactly the state treated as a licence to promote. Measured leaks:
 *     "Yeah\nplease quit bothering me" / "Yeah\nno more texts"
 *     "Yeah\nim blocking this number"  / "Yeah\nthis number is on dnc"
 *     "Yeah\nno me contacten mas"      / "Yeah\nporfavor no me llamen"
 * all -> ownership_confirmed 0.88 with auto-reply allowed.
 * Two rounds of vocabulary hardening did not close it: round 1 leaked 30 of 45
 * disengagement phrasings, round 2 closed all 78 strings in the test corpora and
 * still leaked 26 of 36 previously-unseen ones.
 *
 * ── Why no phrase list can work ───────────────────────────────────────────
 * The rescue can only fire when the extra fragment is UNCLASSIFIABLE: a fragment
 * the classifier understands makes the whole aggregate resolve, so `primary` is
 * not "unclear" and the rescue is never reached. Measured: 0 of 11 firings had a
 * confidently-classified extra fragment, 7 of 7 had an unclear one. And inside
 * that set the two classes are identical to this classifier —
 *     "its a 3br" 0.6, "built in 1998" 0.6, "its vacant" 0.6
 *     "im done talking" 0.6, "please quit bothering me" 0.6, "drop it" 0.6
 * So the rescue's entire domain of operation is exactly the region where benign
 * detail cannot be distinguished from a demand to stop. A blocklist must
 * enumerate an open set; an allowlist fires only where the classifier already
 * succeeded, which is where the rescue is never invoked. There is no third
 * option inside this design.
 *
 * ── The follow-up ─────────────────────────────────────────────────────────
 * Closing this needs a disengagement/withdrawal model that can score an
 * unrecognised fragment, not a longer vocabulary. Until that exists, a
 * multi-fragment burst answering a question routes to a human, and that is the
 * correct trade.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { CONTEXT_VERSION } from "@/lib/domain/classification/conversation-context.js";

function context({ use_case = "ownership_check", question_type = "ownership" } = {}) {
  return {
    context_version: CONTEXT_VERSION,
    canonical_thread: "+15550100042",
    inbound_thread: "+15550100042",
    last_outbound_message_id: "SM-outbound-1",
    last_outbound_use_case: use_case,
    last_outbound_question_type: question_type,
    last_outbound_delivered_at: new Date(Date.now() - 3600e3).toISOString(),
    current_inbound_received_at: new Date().toISOString(),
    intervening_outbound_count: 0,
    intervening_inbound_count: 0,
    question_status: "unanswered",
    unanswered_question: true,
  };
}

const classifyWithContext = (message, ctx = context()) =>
  classify(message, null, { heuristicOnly: true, conversation_context: ctx });

// ── The single-fragment path works and must keep working ───────────────────

test("a lone short reply binds to the delivered question and clears the gate", async () => {
  const result = await classifyWithContext("Yeah");
  assert.equal(result.primary_intent, "ownership_confirmed");
  assert.equal(result.confidence, 0.88);
  assert.ok(result.confidence >= 0.82, "clears the automation gate");
  assert.equal(result.precedence_result, "contextual_short_reply_override");
});

test("a lone short reply without context is capped below the gate — the original incident", async () => {
  // This is the 2026-08-03 signature itself: the intent is right, but with no
  // validated context the confidence is capped at 0.72 by
  // short_reply_without_validated_context, missing the 0.82 automation gate.
  // Cause one (88cea73e) is what makes the context actually arrive.
  const result = await classify("Yeah", null, { heuristicOnly: true });
  assert.equal(result.confidence, 0.72);
  assert.ok(result.confidence < 0.82, "capped below the automation gate");
  assert.ok(
    (result.ambiguity_flags || []).includes("short_reply_without_validated_context"),
    "and it says why"
  );
  assert.notEqual(result.precedence_result, "contextual_short_reply_override");
});

// ── The limitation itself ──────────────────────────────────────────────────

test("KNOWN LIMITATION: a multi-fragment burst does not bind, and goes to a human", async () => {
  const result = await classifyWithContext("Yeah\nits a 3br");
  assert.notEqual(
    result.precedence_result,
    "contextual_short_reply_override",
    "documented limitation — see this file's header before changing it"
  );
  assert.ok(
    result.confidence < 0.82,
    "falls below the automation gate, so a human reviews it rather than an auto-reply going out"
  );
});

test("KNOWN LIMITATION applies regardless of fragment order", async () => {
  const result = await classifyWithContext("its a 3br\nYeah");
  assert.notEqual(result.precedence_result, "contextual_short_reply_override");
  assert.ok(result.confidence < 0.82);
});

// ── Why attempt 1 was rejected. These must never regress. ──────────────────
// A terminal signal in any fragment must win. If a future rescue is built,
// these are the assertions it has to satisfy.

for (const [message, expected] of [
  ["Yeah\nSTOP", "opt_out"],
  ["Yeah\nnot interested", "not_interested"],
  ["Yeah\nactually I already sold it", "wrong_number"],
]) {
  test(`a terminal signal in a burst still wins: ${JSON.stringify(message)}`, async () => {
    const result = await classifyWithContext(message);
    assert.equal(result.primary_intent, expected);
    assert.notEqual(
      result.primary_intent,
      "ownership_confirmed",
      "binding the affirmative here would discard the seller's real instruction"
    );
  });
}

test("an opt-out inside a burst is never downgraded to an ownership confirmation", async () => {
  // The single most important assertion in this file.
  const result = await classifyWithContext("Yeah\nSTOP");
  assert.equal(result.primary_intent, "opt_out");
  assert.ok(result.confidence >= 0.9, "and it stays confident enough to act on");
});

// ── Why attempt 2 was reverted. These are the measured leaks. ──────────────
// Every one of these promoted to ownership_confirmed 0.88 with auto-reply
// allowed under the reverted rescue. They pass trivially today because no
// rescue exists — that is the point. They are here so that anyone who adds one
// discovers immediately whether it reopens the hole.

for (const message of [
  "Yeah\nplease quit bothering me",
  "Yeah\nquit bothering me",
  "Yeah\nno more texts",
  "Yeah\nim blocking this number",
  "Yeah\nscrub my number",
  "Yeah\nthis number is on dnc",
  "Yeah\ncut contact",
  "Yeah\nkindly desist",
  "Yeah\nim not responding anymore",
  "Yeah\nim done talking",
  "Yeah\nthats enough",
  "Yeah\ndrop it",
  "Yeah\nno me contacten mas",
  "Yeah\nporfavor no me llamen",
  "Yeah\ndejeme tranquilo",
]) {
  test(`a stop request in a burst is never auto-replyable: ${JSON.stringify(message)}`, async () => {
    const result = await classifyWithContext(message);
    assert.notEqual(
      result.primary_intent,
      "ownership_confirmed",
      "a seller asking us to stop must never read as an ownership confirmation"
    );
    const terminal = ["opt_out", "not_interested", "wrong_number", "hostile_or_legal"];
    assert.ok(
      terminal.includes(result.primary_intent) || result.confidence < 0.82,
      `expected a terminal intent or a sub-gate confidence, got ${result.primary_intent} @ ${result.confidence}`
    );
  });
}
