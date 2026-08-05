/**
 * A deterministic response-policy matrix — and a correction to the record.
 *
 * WHY THIS FILE EXISTS
 * The historical inbound replay reports `would_reply: 0`, and that number was
 * read as evidence that automatic response behaviour is safe. It is not evidence
 * of that. The zero is STRUCTURAL, not observational.
 *
 * The chain (verified, each link measured):
 *   inbound-full-replay.mjs:309   `if (result.detail?.should_queue_reply) bulk.would_reply += 1`
 *   inbound-replay-engine.js:182  that flag is the FINAL post-execution value
 *   inbound-replay-engine.js:163  execution runs against makeReplaySupabase(...)
 *   inbound-replay-engine.js:46   which returns [] for every table but sms_suppression_list
 *   apply-inbound-automation-decision.js:901  so the sms_templates lookup is always empty
 *   apply-inbound-automation-decision.js:2175 which HARD-SETS should_queue_reply: false
 *                                             (audit_reason "no_safe_template")
 *
 * So the metric is sampled downstream of a fail-closed template gate that the
 * harness's own test double guarantees will fail. It measures "the stub has no
 * templates", not "policy declined to reply".
 *
 * The policy layer DOES run and DOES say "reply" — that is the part that makes
 * the zero misleading rather than merely uninformative. Asserted below.
 *
 * Consequence: every replay metric gated on `should_queue_reply === true` is
 * vacuous — suppression_violations, wrong_number_violations, post_optout_replies,
 * and the adversarial `must_not_auto_reply` / golden `no_auto_reply` checks all
 * pass because the condition can never be met, not because the policy is safe.
 *
 * This file therefore exercises reply eligibility DIRECTLY, against the pure
 * policy authority `applyInboundAutomationDecision` — synchronous, no network,
 * no template dependency, no stub that can silently pin the answer.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { applyInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { replayInboundCase } from "@/lib/domain/inbound/inbound-replay-engine.js";

const THREAD = "+15550100042";

/** The identity/context a real inbound carries. Without it every decision
 *  degrades to `missing_context`, which would make this matrix vacuous too. */
const IDENTITY = {
  threadKey: THREAD,
  inboundFrom: THREAD,
  inboundTo: "+15550100999",
  ownerId: "owner-1",
  propertyId: "prop-1",
  prospectId: "prospect-1",
  inboundReceivedAt: "2026-08-04T10:00:00.000Z",
  latestThreadContext: { disposition: null, last_intent: null },
};

async function decide(message) {
  const classification = await classify(message, null, { heuristicOnly: true });
  return applyInboundAutomationDecision({ ...IDENTITY, message, classification });
}

/** Every inbound must produce at least one explicit outcome. */
function outcomesOf(decision) {
  return {
    reply: decision.should_queue_reply === true,
    suppress: decision.should_suppress_contact === true,
    review: decision.should_mark_human_review === true,
    // A scheduled follow-up is a real outcome too — "not interested" resolves
    // this way rather than by replying, suppressing, or escalating.
    scheduled: Boolean(decision.next_action),
  };
}

// ── the correction ──────────────────────────────────────────────────────────

test("the replay's would_reply metric cannot distinguish policy from its own stub", async () => {
  // Messages the POLICY layer positively wants to answer.
  const eligible = ["Yes I still own it", "I want 250k for it", "Yes I am interested, send me an offer"];

  for (const message of eligible) {
    const policy = await decide(message);
    assert.equal(
      policy.should_queue_reply,
      true,
      `policy must want to reply to ${JSON.stringify(message)}`
    );

    // The same message through the replay engine reports the opposite, because
    // the metric is read after a template gate the harness stub always fails.
    const replayed = await replayInboundCase({
      case_id: message,
      message_body: message,
      prior_context: {},
      provider_quirks: {},
    });
    assert.equal(
      replayed.detail?.should_queue_reply,
      false,
      "CURRENT BEHAVIOUR: the replay reports false even though policy said true"
    );
    assert.ok(
      ["no_safe_template", "template_render_failed"].includes(replayed.detail?.audit_reason),
      `the reason is the template gate, not policy — got ${replayed.detail?.audit_reason}`
    );
  }
});

test("a replay would_reply of zero is therefore not evidence about suppression safety", async () => {
  // Directly pins the vacuity: no message in a broad, deliberately reply-eager
  // corpus can make the metric non-zero. A suppression-violation check gated on
  // this flag can never fire, so it proves nothing.
  const corpus = [
    "Yes I still own it", "I want 250k for it", "Yes I am interested, send me an offer",
    "Sure, what are you offering?", "Yeah I own it", "call me", "I'd take 200k",
    "Send me an offer", "what can you pay", "yes im the owner",
  ];
  let nonZero = 0;
  for (const message of corpus) {
    const replayed = await replayInboundCase({
      case_id: message, message_body: message, prior_context: {}, provider_quirks: {},
    });
    if (replayed.detail?.should_queue_reply === true) nonZero += 1;
  }
  assert.equal(nonZero, 0, "CURRENT BEHAVIOUR: structurally pinned to zero across the corpus");
});

// ── the real matrix ─────────────────────────────────────────────────────────

test("an eligible ownership confirmation is reply-required", async () => {
  const decision = await decide("Yes I still own it");
  assert.equal(decision.should_queue_reply, true, "reply_required");
  assert.equal(decision.should_suppress_contact, false);
  assert.equal(decision.should_mark_human_review, false);
  assert.equal(decision.audit_reason, "ownership_confirmed");
});

test("an eligible price statement is reply-required", async () => {
  const decision = await decide("I want 250k for it");
  assert.equal(decision.should_queue_reply, true);
  assert.equal(decision.should_suppress_contact, false);
  assert.equal(decision.audit_reason, "asking_price_provided");
});

test("an explicit opt-out is NEVER reply-required and always suppresses", async () => {
  for (const message of ["STOP", "leave me alone", "remove me from your list", "unsubscribe"]) {
    const decision = await decide(message);
    assert.equal(decision.should_queue_reply, false, `${JSON.stringify(message)} must not be answered`);
    assert.equal(decision.should_suppress_contact, true, `${JSON.stringify(message)} must suppress`);
  }
});

test("a wrong number is NEVER reply-required and always suppresses", async () => {
  for (const message of ["wrong number", "this is the wrong number", "you have the wrong person"]) {
    const decision = await decide(message);
    assert.equal(decision.should_queue_reply, false, `${JSON.stringify(message)} must not be answered`);
    assert.equal(decision.should_suppress_contact, true, `${JSON.stringify(message)} must suppress`);
  }
});

test("an unclear but safe message resolves to review, never to silence", async () => {
  for (const message of ["hmm", "ok", "?"]) {
    const decision = await decide(message);
    assert.equal(decision.should_suppress_contact, false, "an unclear message is not a compliance event");
    const outcomes = outcomesOf(decision);
    assert.ok(
      outcomes.review || outcomes.reply,
      `${JSON.stringify(message)} must reach a human or a clarifier — got ${JSON.stringify(outcomes)}`
    );
  }
});

// ── the invariant that matters most ─────────────────────────────────────────

test("NO scenario silently produces no outcome at all", async () => {
  // The 2026-08-03 shape was an inbound that produced nothing anyone recorded.
  // Every message below must resolve to at least one explicit outcome: a reply,
  // a suppression, a human escalation, or a scheduled next action.
  const corpus = [
    "Yes I still own it", "I want 250k for it", "Yes I am interested, send me an offer",
    "STOP", "leave me alone", "wrong number", "this is the wrong number",
    "hmm", "ok", "?", "who is this", "not interested", "call me",
    "maybe later", "I need time to think", "my attorney handles this",
    "the house burned down", "its already under contract", "Yeah", "no",
  ];

  for (const message of corpus) {
    const decision = await decide(message);
    const outcomes = outcomesOf(decision);
    assert.ok(
      outcomes.reply || outcomes.suppress || outcomes.review || outcomes.scheduled,
      `${JSON.stringify(message)} produced NO outcome — ${JSON.stringify(outcomes)}, audit=${decision.audit_reason}`
    );
    assert.ok(decision.audit_reason, `${JSON.stringify(message)} must carry an audit reason`);
  }
});

test("a suppressing outcome and a reply outcome are mutually exclusive", async () => {
  // Safety must never coexist with an intent to answer.
  const corpus = [
    "STOP", "leave me alone", "wrong number", "Yes I still own it",
    "I want 250k for it", "call me", "not interested", "hmm",
  ];
  for (const message of corpus) {
    const decision = await decide(message);
    assert.equal(
      decision.should_queue_reply === true && decision.should_suppress_contact === true,
      false,
      `${JSON.stringify(message)} cannot both suppress and reply`
    );
  }
});
