/**
 * Owner report 2026-10-13 17:20 ET (send_queue e57581b6, cancelled by the
 * owner): our S3 "Got it. What price would you be looking for?" was delivered,
 * the seller replied "What would you like to offer?", and the autopilot queued
 * a SECOND asking-price ask ("Got it. What price would you have in mind for
 * the property?" -- another seller_asking_price variant).
 *
 * Owner rules: never repeat a question already asked; S1 -> S5 in order; no
 * offer is ever invented or sent by automation. Once this cycle's S3 question
 * was sent, an explicit offer request advances to S4 (the existing condition
 * question) or, when the condition is known, holds for a person.
 *
 * Replayed through buildConversationContext -> classify ->
 * executeInboundAutomationDecision (dry run).
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { replayReply } from "../helpers/reply-replay-harness.mjs";
import {
  applyS3DeflectionRule,
  resolveS3AlreadyAsked,
} from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { matchOfferDeflection } from "@/lib/domain/classification/seller-reply-families.js";

// The prod EN/ES safe catalog fixture plus the live S4 condition_probe row
// (lc-s4-condition-res-en-01, active + safe_for_auto_reply in prod 2026-10-13).
const CATALOG = [
  ...JSON.parse(readFileSync(new URL("../fixtures/reply-quality/2026-10-06-safe-templates-en-es.json", import.meta.url), "utf8")).rows,
  { id: "s4-res-en", template_id: "lc-s4-condition-res-en-01", use_case: "condition_probe", language: "English", stage_code: "S4", is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply", template_body: "Got it. How's the property overall? Anything that needs work?" },
];

const QUESTIONS = {
  s1: ["ownership_check", "Hey Pat. This is Michael, a local buyer, reaching out about 1 Main St. Are you the owner?"],
  s2: ["consider_selling", "Thanks for confirming. Would you consider a proposal for the property?"],
  s3: ["seller_asking_price", "Got it. What price would you be looking for?"],
  s3_es: ["seller_asking_price", "Entendido. ¿Qué precio tendría en mente?"],
};

async function replay(message, q) {
  const [use_case, text] = QUESTIONS[q];
  return replayReply(
    {
      fixture_id: "s3d",
      received_at: "2026-10-13T21:10:00.000Z",
      seller_message: message,
      prior_question: { template_id: "lc-s3-asking-price-res-en-02", template_use_case: use_case, text, sent_at: "2026-10-13T20:48:49.000Z", delivered_at: "2026-10-13T20:48:55.000Z" },
      intervening_inbound: [],
      r7_history: [],
      valuation: null,
    },
    { catalog: CATALOG }
  );
}

const ASKING_PRICE_USE_CASES = new Set(["seller_asking_price", "asking_price_follow_up"]);

// rc-8.5.21 v3 (S1–S5 BINDING + owner rule 10-18 "offer before price", supersedes the 2026-10-13 "advance to
// the S4 condition question"): we asked for their number ONCE; a second offer request is research → a gated
// offer recommendation for a PERSON — never a condition question before the price, never a number.
for (const message of ["What would you like to offer?", "What's your offer", "make me an offer", "you tell me", "What would you offer?"]) {
  test(`S3 sent -> ${JSON.stringify(message)} -> held for a person (gated offer), never condition before price, never a second asking-price ask`, async () => {
    const r = await replay(message, "s3");
    assert.equal(r.classification.primary_intent, "asks_offer");
    assert.equal(r.outcome, "review");
    assert.equal(r.text, null);
    assert.ok(!ASKING_PRICE_USE_CASES.has(r.template?.use_case));
    assert.notEqual(r.template?.use_case, "condition_probe");
    assert.equal(r.decision.human_review_reason, "offer_request_after_s3_price_withheld_gated_offer");
  });
}

test("S3 sent + condition already known -> held for a person, no reply, no number", async () => {
  const r = await replay("What would you offer? It needs a new roof", "s3");
  assert.equal(r.classification.primary_intent, "asks_offer");
  assert.equal(r.text, null);
  assert.equal(r.outcome, "review");
  assert.equal(r.decision.should_queue_reply, false);
  assert.equal(r.decision.should_mark_human_review, true);
  assert.equal(r.decision.human_review_reason, "offer_request_after_s3_condition_known");
});

test("S3 sent in Spanish, no Spanish S4 row -> fails closed (no second asking-price ask)", async () => {
  const r = await replay("¿Cuánto me ofrece?", "s3_es");
  assert.equal(r.classification.primary_intent, "asks_offer");
  assert.ok(!ASKING_PRICE_USE_CASES.has(r.template?.use_case));
  assert.notEqual(r.outcome, "auto_reply");
});

for (const q of ["s1", "s2"]) {
  test(`S3 never sent (${q}) -> current behaviour: the offer request gets the S3 asking-price question`, async () => {
    const r = await replay("What would you like to offer?", q);
    assert.equal(r.classification.primary_intent, "asks_offer");
    assert.equal(r.outcome, "auto_reply");
    assert.equal(r.template?.use_case, "seller_asking_price");
    assert.notEqual(r.decision.template_authority, "s3_deflection_rule");
  });
}

test("resolveS3AlreadyAsked reads the bound context and the cycle's send_queue rows", () => {
  assert.equal(resolveS3AlreadyAsked({ classification: { context_use_case: "asking_price" } }), true);
  assert.equal(resolveS3AlreadyAsked({ classification: { context_use_case: "proposal_interest" } }), false);
  // S3 asked earlier in the cycle, a who-is-this reply since.
  assert.equal(
    resolveS3AlreadyAsked({
      classification: { context_use_case: null },
      recent_outbound: [{ use_case_template: "who_is_this" }, { use_case_template: "seller_asking_price" }, { use_case_template: "consider_selling" }],
    }),
    true
  );
  assert.equal(resolveS3AlreadyAsked({ recent_outbound: [{ use_case_template: "s3_no_response_fu1" }] }), true);
  assert.equal(resolveS3AlreadyAsked({ recent_outbound: [{ use_case_template: "consider_selling" }, { use_case_template: "ownership_check" }] }), false);
});

test("applyS3DeflectionRule: any S3 variant is rerouted; other intents, suppression, a known price and post-offer stages are untouched", () => {
  const ask = { should_queue_reply: true, route_hint: "seller_asking_price", allowed_template_stages: ["seller_asking_price"], required_template_use_case: "seller_asking_price", condition_questions_forbidden: true };
  const cls = { primary_intent: "asks_offer" };
  for (const variant of ["seller_asking_price", "asking_price_follow_up"]) {
    const out = applyS3DeflectionRule({ ...ask, required_template_use_case: variant, route_hint: variant }, { classification: cls, s3_already_asked: true });
    assert.equal(out.should_queue_reply, false, variant);
    assert.equal(out.should_mark_human_review, true, variant);
    assert.equal(out.human_review_reason, "offer_request_after_s3_price_withheld_gated_offer", variant);
    assert.equal(out.condition_questions_forbidden, true, "never unlocks the condition question");
  }
  assert.equal(applyS3DeflectionRule(ask, { classification: cls, s3_already_asked: false }), ask);
  assert.equal(applyS3DeflectionRule(ask, { classification: { primary_intent: "asking_price_provided" }, s3_already_asked: true }), ask);
  assert.equal(applyS3DeflectionRule(ask, { classification: cls, s3_already_asked: true, seller_price_known: true }), ask);
  assert.equal(applyS3DeflectionRule(ask, { classification: cls, s3_already_asked: true, stage: "negotiation" }), ask);
  assert.equal(applyS3DeflectionRule(ask, { classification: cls, s3_already_asked: true, strategy_directive_applied: true }), ask);
  const sup = { should_suppress_contact: true, should_queue_reply: false };
  assert.equal(applyS3DeflectionRule(sup, { classification: cls, s3_already_asked: true }), sup);
  const held = applyS3DeflectionRule(ask, { classification: cls, s3_already_asked: true, condition_known: true });
  assert.equal(held.should_queue_reply, false);
  assert.equal(held.should_mark_human_review, true);
  assert.equal(held.human_review_reason, "offer_request_after_s3_condition_known");
});

test("matchOfferDeflection", () => {
  for (const m of ["you tell me", "You first", "make me an offer", "What's your offer?", "What would you like to offer?", "Dime tú", "¿Cuánto me ofrece?"]) {
    assert.equal(matchOfferDeflection(m), true, m);
  }
  for (const m of ["I want 250k", "tell me more", "stop texting me", "who are you"]) assert.equal(matchOfferDeflection(m), false, m);
});
