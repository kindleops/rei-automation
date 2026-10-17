/**
 * 2026-10-13 production misses (last 12h of inbound, read-only audit).
 *
 * 17 bare negatives ("No", "NO", "Nope", "No!!!!!", "Not really", "No gracias
 * Carlos!") answered our S1 ownership question and got NO reply: the context
 * binding forced them to `unclear` (rule ctx_no_after_ownership_check) for an
 * ownership clarifier that is flag-gated OFF and has no sms_templates row.
 *
 * OWNER DECISION 2026-10-13: a bare negative to the S1 ownership question,
 * with no ownership-denial words, is not_interested -- the same 30-day nurture
 * as an explicit "not interested". Never wrong_number, never suppressed, no
 * immediate reply. Explicit denials keep their classification; the same "No"
 * after S2 is already a decline; after S3/S4 it keeps its current meaning.
 *
 * Every string is the live inbound (names redacted to the persona in our own
 * outbound), replayed through buildConversationContext -> classify ->
 * executeInboundAutomationDecision after the question it answered.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { replayReply } from "../helpers/reply-replay-harness.mjs";
import {
  matchBareNegative,
  matchConditionalInterest,
  matchIdentityQuestion,
  matchKeeper,
  matchPreparingToSell,
} from "@/lib/domain/classification/seller-reply-families.js";
import { bareNoOwnershipMode } from "@/lib/domain/classification/conversation-context.js";
import { resolveFollowUpPlan } from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import { NURTURE_TEMPLATE_CANDIDATES } from "@/lib/domain/queue/resolve-deferred-queue-message.js";
import { resolveV2Intent, V2_STAGES, V2_INTENTS } from "@/lib/domain/seller-flow/seller-autopilot-v2.js";

const CATALOG = JSON.parse(readFileSync(new URL("../fixtures/reply-quality/2026-10-06-safe-templates-en-es.json", import.meta.url), "utf8")).rows;

// Our real outbound wording per stage (S1 in EN/ES, S2, S3, S4).
const QUESTIONS = {
  s1_still_own: ["ownership_check", "Hey Pat, this is Carlos. Do you still own 1 Main St?"],
  s1_yours: ["ownership_check", "Hi Pat, Carlos here. Is 1 Main St yours?"],
  s1_es: ["ownership_check", "Hola Pat, soy Carlos. ¿Sigue siendo usted el dueño de 1 Main St?"],
  s2: ["consider_selling", "Would you consider an offer on 1 Main St if the number made sense?"],
  s3: ["seller_asking_price", "Got it. What price would you be looking for?"],
  s4: ["ask_condition_clarifier", "Got it. What kind of shape is it in? Anything major it needs?"],
};

async function replay(message, q = "s1_still_own") {
  const [use_case, text] = QUESTIONS[q];
  return replayReply(
    {
      fixture_id: "r20261013",
      received_at: "2026-10-13T18:00:00.000Z",
      seller_message: message,
      prior_question: { template_id: "t-r20261013", template_use_case: use_case, text, sent_at: "2026-10-13T17:00:00.000Z", delivered_at: "2026-10-13T17:00:05.000Z" },
      intervening_inbound: [],
      r7_history: [],
      valuation: null,
    },
    { catalog: CATALOG }
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ── 1. Bare negative after S1 ─────────────────────────────────────────────
// OWNER DECISION 2026-10-14 (RC 8.5.15) supersedes the 2026-10-13 decline: a
// bare negative to the S1 ownership question DENIES ownership -- property-
// scoped, no nurture, no reply, never suppressed. A polite decline ("No
// gracias Carlos!") still answers a sales approach: the 30-day decline.
const BARE_NEGATIVES_AFTER_S1 = [
  ["No", "s1_still_own"],
  ["NO", "s1_yours"],
  ["Nope", "s1_still_own"],
  ["No!!!!!", "s1_still_own"],
  ["Not really", "s1_still_own"],
  ["No", "s1_es"],
];

for (const [message, q] of BARE_NEGATIVES_AFTER_S1) {
  test(`bare negative after S1 (${q}): ${JSON.stringify(message)} -> ownership denied, no nurture, never suppressed`, async () => {
    const r = await replay(message, q);
    const c = r.classification;
    assert.equal(c.primary_intent, "property_specific_non_owner");
    assert.ok(c.matched_rule_ids.includes("ctx_bare_no_after_ownership_check_ownership_unverified"), c.matched_rule_ids.join(","));
    assert.equal(c.compliance_flag ?? null, null);
    assert.equal(c.automation_decision?.suppression_action, "none");
    assert.equal(c.automation_decision?.clarification_use_case ?? null, null, "no further ownership question");
    assert.equal(r.decision.audit_reason, "s1_ownership_denied_unverified_no_followup");
    assert.equal(r.decision.should_suppress_contact, false);
    assert.equal(r.decision.should_queue_reply, false);
    assert.equal(r.decision.follow_up_at ?? null, null, "no nurture");
    assert.equal(r.text, null, "no immediate reply");
    assert.equal(r.outcome, "no_reply_by_design");
  });
}

test("rc-8.5.21 (owner P0 2026-10-16): a polite negative after S1 ('No gracias Carlos!') denies ownership of THAT property (never not_interested, no nurture)", async () => {
  const polite = await replay("No gracias Carlos!", "s1_es");
  assert.equal(polite.classification.primary_intent, "property_specific_non_owner");
  assert.ok(polite.classification.matched_rule_ids.includes("ctx_polite_no_after_ownership_check_ownership_unverified"));
  assert.equal(polite.decision.follow_up_at ?? null, null, "no nurture after an ownership denial");
  assert.equal(polite.decision.should_suppress_contact, false, "never a phone suppression");
});

test("the not_interested nurture is a 30-day follow-up whose copy comes only from sms_templates use cases", () => {
  const plan = resolveFollowUpPlan("not_interested", { thread_key: "+15555550123" });
  assert.equal(plan.suppressed, false);
  assert.equal(plan.followup_created, true);
  assert.equal(plan.days, 30);
  assert.equal(plan.reason, "nurture_followup:not_interested");
  // Send-time resolution reads these sms_templates use cases (no local copy).
  const candidates = NURTURE_TEMPLATE_CANDIDATES.not_interested;
  assert.ok(candidates.length > 0);
  const catalog_use_cases = new Set(CATALOG.map((row) => row.use_case));
  for (const use_case of candidates) assert.ok(catalog_use_cases.has(use_case), use_case);
});

test("seller autopilot v2 reads the classifier's decline, never the bare-No clarifier", () => {
  const intent = resolveV2Intent({
    classification: { primary_intent: "not_interested", confidence: 0.88 },
    message: "No",
    stage: V2_STAGES.S1,
  });
  assert.equal(intent.intent, V2_INTENTS.NOT_INTERESTED);
});

// ── 2. Explicit ownership denials keep their classification ────────────────
for (const [message, q, intent] of [
  ["No, I sold it", "s1_still_own", "sold_property"],
  // RC 8.5.15: a written ownership denial is property-scoped, never wrong_number.
  ["not mine", "s1_still_own", "property_specific_non_owner"],
  ["wrong number", "s1_still_own", "wrong_number"],
  ["I don't own it", "s1_still_own", "property_specific_non_owner"],
  ["no lo vendí", "s1_es", "sold_property"],
]) {
  test(`explicit denial keeps its lane: ${JSON.stringify(message)} -> ${intent}`, async () => {
    const r = await replay(message, q);
    assert.equal(r.classification.primary_intent, intent);
    assert.ok(!r.classification.matched_rule_ids.includes("ctx_bare_no_after_ownership_check_not_interested"));
  });
}

// "No I don't" / "No I'm not" / "Not anymore" answer the ownership question
// with denial words: never the decline (RC 8.5.15: the denial / former-owner lanes).
for (const message of ["No, I don't", "No, I'm not", "Not anymore", "ya no es mío"]) {
  test(`ownership answer with denial words is not a bare negative: ${JSON.stringify(message)}`, async () => {
    const r = await replay(message, /ya no/.test(message) ? "s1_es" : "s1_still_own");
    assert.notEqual(r.classification.primary_intent, "not_interested");
    assert.ok(!r.classification.matched_rule_ids.includes("ctx_bare_no_after_ownership_check_not_interested"));
  });
}

// ── 3. Opt-out is never weakened ───────────────────────────────────────────
for (const message of ["STOP", "stop texting", "remove me", "No. Stop texting me", "No stop"]) {
  test(`opt-out still suppresses after S1: ${JSON.stringify(message)}`, async () => {
    const r = await replay(message);
    assert.equal(r.classification.primary_intent, "opt_out");
    assert.equal(r.classification.compliance_flag, "stop_texting");
    assert.equal(r.outcome, "suppressed");
  });
}

// ── 4. Context matters: S2 / S3 / S4 ──────────────────────────────────────
test("bare 'No' after S2 (would you consider an offer) stays a decline", async () => {
  const r = await replay("No", "s2");
  assert.equal(r.classification.primary_intent, "not_interested");
  assert.ok(r.classification.matched_rule_ids.includes("ctx_no_after_proposal_interest"));
});

test("bare 'No' after S3 (asking price) keeps its current meaning: no price in mind yet", async () => {
  const r = await replay("No", "s3");
  assert.equal(r.classification.primary_intent, "asking_price_absent");
  assert.ok(r.classification.matched_rule_ids.includes("ctx_no_after_asking_price"));
});

test("bare 'No' after S4 (condition) reports no repairs (RC 8.5.15): condition info, never a decline", async () => {
  const r = await replay("No", "s4");
  assert.equal(r.classification.primary_intent, "condition_disclosed");
  assert.ok(r.classification.matched_rule_ids.includes("ctx_no_after_condition_no_repairs"));
  assert.notEqual(r.outcome, "suppressed");
});

test("LC_BARE_NO_OWNERSHIP_MODE=clarify restores the 2026-10-06 clarifier hold", async () => {
  const prev = process.env.LC_BARE_NO_OWNERSHIP_MODE;
  process.env.LC_BARE_NO_OWNERSHIP_MODE = "clarify";
  try {
    assert.equal(bareNoOwnershipMode(), "clarify");
    const r = await replay("No");
    assert.equal(r.classification.primary_intent, "unclear");
    assert.ok(r.classification.matched_rule_ids.includes("ctx_no_after_ownership_check"));
  } finally {
    if (prev === undefined) delete process.env.LC_BARE_NO_OWNERSHIP_MODE;
    else process.env.LC_BARE_NO_OWNERSHIP_MODE = prev;
  }
  assert.equal(bareNoOwnershipMode(), "ownership_unverified");
});

// ── 5. The other 10-13 misses ─────────────────────────────────────────────
for (const [message, q, language] of [
  ["Sorry I dont know who this is", "s1_still_own", "English"],
  ["Que nesesitas", "s1_es", "Spanish"],
  ["Why do you want it", "s1_still_own", "English"],
  ["Mandamela por texto...cual es el nombre de tu compañia?", "s1_es", "Spanish"],
]) {
  test(`who_is_this: ${JSON.stringify(message)} -> the existing who_is_this template`, async () => {
    const r = await replay(message, q);
    assert.equal(r.classification.primary_intent, "who_is_this");
    assert.equal(r.outcome, "auto_reply");
    assert.equal(r.template?.use_case, "who_is_this");
    assert.equal(r.template?.language, language);
  });
}

for (const message of ["Only if it's market value", "only if the price is right", "depends on the price", "if the money is right"]) {
  test(`conditional interest after S2: ${JSON.stringify(message)} -> an S2 yes, next the S3 asking-price question`, async () => {
    const r = await replay(message, "s2");
    assert.equal(r.classification.primary_intent, "latent_interest");
    assert.equal(r.outcome, "auto_reply");
    assert.equal(r.template?.use_case, "seller_asking_price");
  });
}

for (const [message, q] of [["Itsa keeper", "s1_still_own"], ["it's a keeper", "s2"], ["Not really", "s2"]]) {
  test(`decline: ${JSON.stringify(message)} (${q}) -> not_interested, never suppressed`, async () => {
    const r = await replay(message, q);
    assert.equal(r.classification.primary_intent, "not_interested");
    assert.notEqual(r.outcome, "suppressed");
    assert.equal(r.text, null);
  });
}

test("preparing to sell -> latent_interest in the human lane, no automatic send", async () => {
  const r = await replay("Estamos intalando shower doors sprinkler para ponerla ala venta", "s1_es");
  assert.equal(r.classification.primary_intent, "latent_interest");
  assert.ok(r.classification.matched_rule_ids.includes("r12_preparing_to_sell"));
  assert.equal(r.outcome, "review");
  assert.equal(r.text, null);
});

test("'Title locked' and 'Location can't be beat as well' are left as they were", async () => {
  for (const message of ["Title locked", "Location can't be beat as well"]) {
    const r = await replay(message);
    assert.equal(r.classification.primary_intent, "unclear", message);
    assert.notEqual(r.outcome, "auto_reply", message);
  }
});

// ── 6. The shared family matchers ─────────────────────────────────────────
test("matchBareNegative: refusals only, never an ownership answer or a stop", () => {
  for (const m of ["No", "NO", "Nope", "No!!!!!", "Not really", "No gracias Carlos!", "Nah", "No thanks", "No thank you", "Noo", "No sir", "Hell no", "Of course not", "No, not really 🙂"]) {
    assert.ok(matchBareNegative(m, { names: ["Carlos"] }), m);
  }
  for (const m of [
    "No I don't", "No, I'm not", "not mine", "No, I sold it", "sold", "wrong number", "Not anymore", "no longer",
    "ya no es mío", "never owned it", "No stop", "STOP", "No, stop texting me", "no thanks remove me",
    "No. What city?", "No but my brother does", "No thanks sold", "No gracias vendida", "Yes", "no lo vendí",
  ]) {
    assert.equal(matchBareNegative(m, { names: ["Carlos"] }), null, m);
  }
});

test("matchIdentityQuestion / matchConditionalInterest / matchKeeper / matchPreparingToSell", () => {
  for (const m of ["Sorry I dont know who this is", "Que nesesitas", "Qué necesitas?", "Why do you want it", "Mandamela por texto...cual es el nombre de tu compañia?"]) {
    assert.equal(matchIdentityQuestion(m), true, m);
  }
  for (const m of ["I know who this is", "Why do you want it so cheap? Stop texting"]) assert.equal(matchIdentityQuestion(m), false, m);
  for (const m of ["Only if it's market value", "only if the price is right", "depends on the price", "if the money is right", "Solo si el precio es justo"]) {
    assert.equal(matchConditionalInterest(m), true, m);
  }
  for (const m of ["not even if the price is right", "no, depends on nothing", "market value is 300k"]) assert.equal(matchConditionalInterest(m), false, m);
  for (const m of ["Itsa keeper", "it's a keeper", "That one's a keeper"]) assert.equal(matchKeeper(m), true, m);
  for (const m of ["keeper of the keys", "is it a keeper?"]) assert.equal(matchKeeper(m), false, m);
  assert.equal(matchPreparingToSell("Estamos intalando shower doors sprinkler para ponerla ala venta"), true);
  assert.equal(matchPreparingToSell("No la vamos a vender, la estamos arreglando para ponerla a la venta nunca"), false);
});
