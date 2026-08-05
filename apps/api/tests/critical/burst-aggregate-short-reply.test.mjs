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
