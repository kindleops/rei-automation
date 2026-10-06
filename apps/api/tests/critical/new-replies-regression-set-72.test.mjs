/**
 * NEW REPLIES REGRESSION SET (7.2, 2026-10-01).
 *
 * Every case in tests/fixtures/new-replies/new-replies-regression-set-20261001.json
 * is classified by the LIVE classifier (heuristicOnly, conversation context
 * built from OUR previous outbound exactly as build-conversation-context.js
 * does) and categorized by the cleanup planner. The set is de-identified and
 * pins semantics, not strings: wrong person, sold, not for sale / not
 * interested, hostile (no DNC), call request, auto-reply, language,
 * Spanish / Portuguese / Vietnamese, emoji (affirmative, negative, hostile,
 * acknowledgement, amusement) and genuine engagement that must stay.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classify } from "@/lib/domain/classification/classify.js";
import { deriveUseCaseFromBody } from "@/lib/domain/classification/build-conversation-context.js";
import {
  extractAddresseeName,
  extractSenderName,
  detectMessageLanguage,
} from "@/lib/domain/classification/reply-disposition-signals.js";
import { categorizeReply, planThreadCleanup } from "@/lib/domain/inbox/new-replies-cleanup.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SET = JSON.parse(
  fs.readFileSync(path.join(here, "../fixtures/new-replies/new-replies-regression-set-20261001.json"), "utf8")
);
const THREAD = "+15555550100";

function contextFor(item) {
  if (!item.context) return null;
  return {
    context_version: "conversation_context_v1",
    canonical_thread: THREAD,
    inbound_thread: THREAD,
    canonical_stage: null,
    last_outbound_message_id: `out-${item.id}`,
    last_outbound_use_case: item.context,
    last_outbound_delivered_at: "2026-10-01T15:00:00.000Z",
    current_inbound_received_at: "2026-10-01T15:05:00.000Z",
    intervening_outbound_count: 0,
    intervening_inbound_count: 0,
    unanswered_question: true,
    last_outbound_addressee: item.addressee ?? extractAddresseeName(item.previous_outbound),
    last_outbound_agent: item.agent ?? extractSenderName(item.previous_outbound),
    last_outbound_language: detectMessageLanguage(item.previous_outbound),
  };
}

async function run(item) {
  const classification = await classify(item.reply, null, { heuristicOnly: true, conversation_context: contextFor(item) });
  const category = categorizeReply({ classification, body: item.reply });
  const plan = planThreadCleanup({ thread: { id: item.id, thread_key: THREAD }, classification, category });
  return { classification, category, plan };
}

test("the regression set is de-identified: no phone number, no email, and only placeholder names", () => {
  const blob = JSON.stringify(SET.cases);
  assert.equal(/\+?1?\s?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(blob), false, "a phone number leaked");
  assert.equal(/[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i.test(blob), false, "an email leaked");
  assert.ok(SET.cases.length >= 80, `the set must stay broad (${SET.cases.length})`);
});

test("the set covers every category the 7.2 brief names", () => {
  const categories = new Set(SET.cases.map((c) => c.category));
  for (const required of [
    "WRONG PERSON", "SOLD", "NOT FOR SALE", "NOT INTERESTED", "HOSTILE", "CALL REQUEST", "AUTO-REPLY",
    "LANGUAGE", "KEEP AS GENUINE NEW REPLY", "OTHER AMBIGUOUS", "EMOJI NEEDS CLARIFICATION", "EMOJI ACKNOWLEDGMENT",
  ]) {
    assert.ok(categories.has(required), `missing ${required}`);
  }
});

for (const item of SET.cases) {
  test(`[${item.id}] ${item.category}: ${JSON.stringify(item.reply).slice(0, 60)}`, async () => {
    const { classification, category, plan } = await run(item);
    const e = item.expected;
    if (e.intent) assert.equal(classification.primary_intent, e.intent, `intent (category ${category})`);
    if (e.not_intent) assert.notEqual(classification.primary_intent, e.not_intent);
    if (e.rule) assert.ok(classification.matched_rule_ids.includes(e.rule), `rule ${e.rule} in ${classification.matched_rule_ids}`);
    if (e.secondary) assert.ok(classification.secondary_intents.includes(e.secondary), `secondary ${e.secondary}`);
    if (e.new_replies) assert.equal(plan.new_replies, e.new_replies, `new replies (category ${category})`);
    if (e.no_dnc) {
      assert.equal(classification.compliance_flag ?? null, null, "hostility is not a compliance stop");
      assert.equal(classification.automation_decision.suppression_action, "none", "hostility never writes DNC");
    }
    if (e.signal) assert.equal(classification.emoji_interpretation?.semantic_signal, e.signal);
    if (e.clarification) {
      assert.equal(classification.emoji_interpretation?.clarification?.template_use_case, e.clarification);
      assert.equal(classification.automation_decision.reply_kind, "clarification");
      assert.equal(classification.automation_decision.clarification_use_case, e.clarification);
      assert.equal(classification.factual_commitment, "LIKELY", "an emoji is LIKELY at most, never CONFIRMED");
    }
    if (e.no_clarification) assert.notEqual(classification.automation_decision.reply_kind, "clarification");
    if (e.fact) assert.equal(classification.factual_commitment, e.fact);
    if ("avoid_language" in e) assert.equal(classification.language_preference.avoid_language, e.avoid_language);
    if ("preferred_language" in e) assert.equal(classification.language_preference.preferred_language, e.preferred_language);
    if (e.call_state) assert.equal(classification.call_request?.state, e.call_state);
    if (e.call_time) assert.equal(classification.call_request?.requested_time_text, e.call_time);
    if (classification.call_request) assert.equal(classification.call_request.scheduled_at, null, "never an invented calendar time");
    assert.equal(classification.classifier_version, "classify_js_context_v3_reply_disposition");
  });
}

test("an emoji never confirms ownership, a price, an acceptance or a contract (S1-S6 stage rules)", async () => {
  const at = (canonical_stage, use_case) => ({
    ...contextFor({ id: "stage", context: use_case, previous_outbound: "Hi Pat, this is Sam." }),
    canonical_stage,
  });
  // S1 changed 2026-10-06 (owner rule): a typed 👍 to the ownership question
  // answers it like "Yes" (asserted in new-replies-emoji-live-path-72). The
  // price / offer / contract stages below keep the 7.2 rules.
  const s1 = await classify("👍", null, { heuristicOnly: true, conversation_context: at("ownership_confirmation", "ownership_check") });
  assert.equal(s1.primary_intent, "ownership_confirmed");
  const s3 = await classify("👍", null, { heuristicOnly: true, conversation_context: at("asking_price", "asking_price") });
  assert.notEqual(s3.primary_intent, "asking_price_provided");
  assert.equal(s3.automation_decision.reply_kind, undefined, "S3: a thumbs-up gives no price and is not auto-clarified");
  const s5 = await classify("👍", null, { heuristicOnly: true, conversation_context: at("offer", "general_followup") });
  assert.equal(s5.emoji_interpretation.rule_id, "emoji_affirmative_is_not_offer_acceptance");
  const s6 = await classify("👍", null, { heuristicOnly: true, conversation_context: at("formal_contract", "general_followup") });
  assert.equal(s6.emoji_interpretation.rule_id, "emoji_never_contract_authority");
  for (const c of [s3, s5, s6]) {
    assert.notEqual(c.primary_intent, "ownership_confirmed");
    assert.notEqual(c.factual_commitment, "CONFIRMED");
  }
});

test("explicit denials answer the ownership question even when the context is valid; a bare 'No' still asks", async () => {
  const ctx = contextFor({ id: "ctx", context: "ownership_check", previous_outbound: "Hi Pat, this is Sam. Do you still own 123 Main St?" });
  assert.equal((await classify("Wrong number", null, { heuristicOnly: true, conversation_context: ctx })).primary_intent, "wrong_number");
  assert.equal((await classify("Not mine", null, { heuristicOnly: true, conversation_context: ctx })).primary_intent, "wrong_number");
  assert.equal((await classify("I sold it", null, { heuristicOnly: true, conversation_context: ctx })).primary_intent, "sold_property");
  const bare = await classify("No", null, { heuristicOnly: true, conversation_context: ctx });
  assert.equal(bare.primary_intent, "unclear");
  assert.ok(bare.secondary_intents.includes("ownership_denial_needs_clarification"));
});

test("detector negatives: ordinary seller sentences never trip the new rules", async () => {
  const cases = [
    ["Not interested", "not_interested"],
    ["Not now", null],
    ["This isn't a good time", null],
    ["no soy de aqui", null],
    ["I am not sure", null],
    ["I'm keeping the tenant until March", null],
    ["I won't sell for less than 300k", null],
  ];
  for (const [text, expected] of cases) {
    const c = await classify(text, null, { heuristicOnly: true });
    assert.notEqual(c.primary_intent, "wrong_number", text);
    assert.notEqual(c.primary_intent, "hostile_or_legal", text);
    assert.notEqual(c.primary_intent, "reaction_only", text);
    if (expected) assert.equal(c.primary_intent, expected, text);
  }
  const floor = await classify("I won't sell for less than 300k", null, { heuristicOnly: true });
  assert.notEqual(floor.primary_intent, "not_interested", "a price floor is not a decline");
});

// ── Active-deal review (2026-10-01): the 27 unanswered sellers ──────────────

test("ownership answers are bound to the OWNERSHIP question: 'Never have' / 'mal informado' mean nothing without it", async () => {
  const noCtx = { heuristicOnly: true };
  assert.notEqual((await classify("Never have\nNo", null, noCtx)).primary_intent, "wrong_number");
  assert.notEqual((await classify("Estas mal informado", null, noCtx)).primary_intent, "wrong_number");
  const asking = contextFor({ id: "ap", context: "asking_price", previous_outbound: "Do you have a number in mind?" });
  assert.notEqual(
    (await classify("Never have", null, { heuristicOnly: true, conversation_context: asking })).primary_intent,
    "wrong_number",
    "'never have' after a price question is not a denial of ownership"
  );
});

test("a premise denial is a LIKELY wrong person: a person confirms, no wrong-number mark is automatic", async () => {
  const ctx = contextFor({ id: "pd", context: "ownership_check", previous_outbound: "Ola Pat, sou Sam. Voce ainda e o proprietario de 123 Main St?" });
  const c = await classify("Estas mal informado\nVoce deve fazer o seu trabalho de casa", null, { heuristicOnly: true, conversation_context: ctx });
  assert.equal(c.primary_intent, "wrong_number");
  assert.ok(c.confidence <= 0.75);
  assert.equal(c.factual_commitment, "LIKELY");
  assert.equal(c.automation_decision.suppression_action, "none");
  assert.equal(c.automation_decision.human_review_required, true);
  assert.equal(c.matched_rule_ids.includes("hostile_insult_no_opt_out"), false, "'do your homework' rides on the denial");
});

test("a misspelled 'not interested' is read only near 'interested'", async () => {
  for (const reply of ["And not inter stud.", "not intrested", "Not intersted thx"]) {
    const c = await classify(reply, null, { heuristicOnly: true });
    assert.equal(c.primary_intent, "not_interested", reply);
  }
  for (const reply of ["I'm not into it right now, call me next month", "That was not intended for you"]) {
    const c = await classify(reply, null, { heuristicOnly: true });
    assert.equal(c.matched_rule_ids.includes("not_interested_misspelled"), false, reply);
  }
});

test("'¿En qué te puedo ayudar?' is a purpose question, not a call request", async () => {
  const c = await classify("En que te puedo ayudar", null, { heuristicOnly: true });
  assert.equal(c.primary_intent, "who_is_this");
  assert.equal(c.secondary_intents.includes("callback_requested"), false);
});

test("another property for sale is a person's lead: human review, never an auto reply about this property", async () => {
  const ctx = contextFor({ id: "op", context: "proposal_interest", previous_outbound: "¿Consideraría una propuesta por la propiedad?" });
  const c = await classify("Esta publicada en el mercado\nTengo otra propiedad de venta\nNo gracias", null, { heuristicOnly: true, conversation_context: ctx });
  assert.ok(c.matched_rule_ids.includes("other_property_for_sale"));
  assert.equal(c.automation_decision.auto_reply_allowed, false);
  assert.equal(c.automation_decision.human_review_required, true);
  assert.equal(categorizeReply({ classification: c, body: "Tengo otra propiedad de venta" }), "KEEP AS GENUINE NEW REPLY");
});
