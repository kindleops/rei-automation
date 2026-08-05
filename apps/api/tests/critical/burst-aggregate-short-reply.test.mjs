/**
 * A burst that answers the question must still bind — cause two of the
 * 2026-08-03 incident.
 *
 * aggregateBurstMessage joins constituent bodies with "\n", and
 * isShortContextualReply tests the WHOLE normalized body against
 * ^(yes|yeah|...)$. So applyContextualShortReply was unreachable for EVERY
 * multi-fragment burst regardless of context validity: a lone "Yeah" bound to
 * the delivered ownership question at 0.88 and cleared the 0.82 automation
 * gate, while "Yeah\nits a 3br" — strictly MORE information — fell to unclear
 * at 0.64 and was routed to human review.
 *
 * THE SAFETY ARGUMENT, which these tests exist to hold in place:
 *
 * The rescue runs LAST in resolveIntents and only when primary === "unclear".
 * That guard is load-bearing. "unclear" is the classifier's own statement that
 * no fragment carried a competing intent, so a burst containing STOP, "not
 * interested", or "I already sold it" resolves to its terminal intent first and
 * never reaches the rescue. The naive alternative — binding the first fragment
 * eagerly — was measured and would have turned "Yeah\nSTOP" from opt_out 0.99
 * into ownership_confirmed 0.88 with auto-reply allowed, discarding an opt-out.
 * The hazard cases below are the regression guard for that; they must never be
 * relaxed to make some future binding case pass.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import {
  CONTEXT_VERSION,
  resolveAggregateShortReplyFragment,
  aggregateCarriesStopRequest,
} from "@/lib/domain/classification/conversation-context.js";

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

// ── The defect ─────────────────────────────────────────────────────────────

test("a two-fragment burst answering the question binds and clears the gate", async () => {
  const result = await classifyWithContext("Yeah\nits a 3br");
  assert.equal(result.primary_intent, "ownership_confirmed");
  assert.equal(result.confidence, 0.88);
  assert.ok(result.confidence >= 0.82, "must clear the automation gate");
  assert.equal(result.precedence_result, "contextual_short_reply_override");
  assert.equal(result.evidence_spans[0], "Yeah", "the bound fragment is the evidence");
});

test("the answering fragment may arrive in either position", async () => {
  const result = await classifyWithContext("its a 3br\nYeah");
  assert.equal(result.primary_intent, "ownership_confirmed");
  assert.equal(result.confidence, 0.88);
});

test("the rescue works for a proposal question too, not just ownership", async () => {
  const result = await classifyWithContext(
    "Yeah\nwhats the number",
    context({ use_case: "proposal_interest", question_type: "proposal_interest" })
  );
  assert.equal(result.primary_intent, "seller_interested");
  assert.ok(result.confidence >= 0.82);
});

// ── Hazard guards. Do NOT relax these. ─────────────────────────────────────

for (const [message, expected] of [
  ["Yeah\nSTOP", "opt_out"],
  ["Yeah\nnot interested", "not_interested"],
  ["Yeah\nactually I already sold it", "wrong_number"],
]) {
  test(`a competing terminal signal still wins: ${JSON.stringify(message)}`, async () => {
    const result = await classifyWithContext(message);
    assert.equal(
      result.primary_intent,
      expected,
      "the rescue must never override a fragment that carries a terminal intent"
    );
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

test("contradictory fragments are not resolved by picking a winner", async () => {
  const result = await classifyWithContext("Yeah\nno");
  assert.notEqual(result.primary_intent, "ownership_confirmed");
});

test("without a validated context the rescue cannot fire", async () => {
  const result = await classify("Yeah\nits a 3br", null, { heuristicOnly: true });
  assert.notEqual(result.primary_intent, "ownership_confirmed", "no context, no fabrication");
  assert.equal(result.precedence_result, "intent_priority");
});

test("a forced-unclear short reply stays unclear in aggregate form", async () => {
  // A bare "No" to an ownership question deliberately resolves to unclear
  // (ownership_denial_needs_clarification) rather than a denial — the aggregate
  // path must inherit that judgement, not route around it.
  const single = await classifyWithContext("No");
  assert.equal(single.primary_intent, "unclear");
  const aggregate = await classifyWithContext("No\nits a 3br");
  assert.equal(aggregate.primary_intent, "unclear");
});

// ── The single-fragment path must be untouched ─────────────────────────────

test("a lone short reply still binds exactly as before", async () => {
  const result = await classifyWithContext("Yeah");
  assert.equal(result.primary_intent, "ownership_confirmed");
  assert.equal(result.confidence, 0.88);
  assert.equal(result.precedence_result, "contextual_short_reply_override");
});

// ── A stop request anywhere in the aggregate blocks promotion ──────────────
// The `primary === "unclear"` guard alone was NOT sufficient and this is the
// correction. `unclear` proves no rule matched; it does not prove no stop
// request is present. The opt-out detector does not cover every phrasing, and
// an uncovered one lands in `unclear` — which was exactly the state the rescue
// treated as a licence to promote. All three of the first cases below were
// measured promoting to ownership_confirmed 0.88 with auto-reply allowed.

for (const message of [
  // The measured regressions.
  "Yeah\nplease quit bothering me",
  "Yeah\nquit bothering me",
  "Yeah\nno more texts",
  // Neighbours of them, to stop the fix from being phrase-specific.
  "Yeah\nno more messages",
  "Yeah\nplease no more calls",
  "Yeah\ndont text me any more",
  "Yeah\nstop bothering me",
  "Yeah\ncease contact",
  "Yeah\ntake me off",
  "Yeah\nlose my number",
  "Yeah\nplease dont reach out again",
  "Yeah\nnot interested in being contacted",
  "Yeah\nknock it off",
  "Yeah\nquit texting",
  // Spanish, mirroring the vocabulary the opt-out rule already knows.
  "Yeah\nno me moleste",
  "Yeah\ndejen de molestarme",
  "Yeah\nno mas llamadas",
  "Yeah\ndejame en paz",
]) {
  test(`a stop request is never promoted: ${JSON.stringify(message)}`, async () => {
    const result = await classifyWithContext(message);
    assert.notEqual(
      result.precedence_result,
      "contextual_short_reply_override",
      "a seller asking us to stop must never be promoted to an ownership confirmation"
    );
    assert.notEqual(result.primary_intent, "ownership_confirmed");
    // Two acceptable outcomes, never a third: the classifier recognises it as a
    // terminal intent in its own right, or it falls below the 0.82 automation
    // gate and a human sees it. What must not happen is a confident,
    // auto-replyable NON-terminal intent.
    const terminal = ["opt_out", "not_interested", "wrong_number"];
    assert.ok(
      terminal.includes(result.primary_intent) || result.confidence < 0.82,
      `expected a terminal intent or a sub-gate confidence, got ${result.primary_intent} @ ${result.confidence}`
    );
  });
}

test("the stop scan is fail-closed on input it cannot read", () => {
  assert.equal(aggregateCarriesStopRequest(""), true);
  assert.equal(aggregateCarriesStopRequest(null), true);
  assert.equal(aggregateCarriesStopRequest(undefined), true);
});

test("the stop scan leaves ordinary seller detail alone", () => {
  // Over-refusal is cheap (one lost auto-reply, routed to a human) but it must
  // not swallow the normal case the rescue exists for.
  for (const text of [
    "Yeah\nits a 3br",
    "Yeah\nneeds a roof",
    "Yeah\nmy cell is 2145551212",
    "Yeah\nwhats the number",
    "Yeah\nI want 250k",
    "Yeah\nthe tenant moved out",
  ]) {
    assert.equal(aggregateCarriesStopRequest(text), false, text);
  }
});

test("the stop scan deliberately over-triggers on bare stop words", () => {
  // Documented, accepted cost: these are not stop requests, but they refuse
  // promotion anyway. One automated reply is lost and a human sees the thread.
  // Asserted so the asymmetry is a recorded decision, not an accident.
  assert.equal(aggregateCarriesStopRequest("Yeah\nstop by anytime"), true);
  assert.equal(aggregateCarriesStopRequest("Yeah\nI quit my job last year"), true);
});

// ── The fragment resolver is fail-closed ───────────────────────────────────

test("resolveAggregateShortReplyFragment only speaks when it is certain", () => {
  assert.equal(resolveAggregateShortReplyFragment("Yeah"), null, "single fragment is not its job");
  assert.equal(resolveAggregateShortReplyFragment(""), null);
  assert.equal(resolveAggregateShortReplyFragment(null), null);
  assert.equal(resolveAggregateShortReplyFragment("Yeah\nits a 3br"), "Yeah");
  assert.equal(resolveAggregateShortReplyFragment("its a 3br\nYeah"), "Yeah");
  assert.equal(
    resolveAggregateShortReplyFragment("Yeah\nno"),
    null,
    "two short replies of opposing polarity must not be resolved by guessing"
  );
  assert.equal(
    resolveAggregateShortReplyFragment("its a 3br\nneeds a roof"),
    null,
    "no qualifying fragment"
  );
});
