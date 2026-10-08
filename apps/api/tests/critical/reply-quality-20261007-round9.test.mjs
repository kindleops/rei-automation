/**
 * Round 9 (owner escalation, 2026-10-07 ~01:40Z): "There is a serious problem
 * with our inbox and classifying messages wrongly. All the messages in New
 * Replies and Priority really shouldn't even be there."
 *
 * Every string below is the exact live inbound (redacted of names/phones where
 * needed), replayed through the live chain (buildConversationContext ->
 * classify -> executeInboundAutomationDecision) after the question it answered.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { replayReply } from "../helpers/reply-replay-harness.mjs";
import { classify } from "@/lib/domain/classification/classify.js";

const CATALOG = JSON.parse(readFileSync(new URL("../fixtures/reply-quality/2026-10-06-safe-templates-en-es.json", import.meta.url), "utf8")).rows;

const QUESTIONS = {
  ownership_check: "Hey Pat, this is Alex. 🙂 Are you still the owner of 606 Winterbrooke Way?",
  ownership_check_es: "Hola Pat, soy Alex. ¿Sigue siendo el dueño de 606 Winterbrooke Way?",
  consider_selling: "Would you consider an offer on 606 Winterbrooke Way if the number made sense?",
  price_high_condition_probe: "Got it. What kind of shape is it in? Anything major it needs?",
};

async function replay(message, { use_case = "ownership_check", estimated_value = null } = {}) {
  const text = QUESTIONS[use_case] ?? null;
  const fixture = {
    fixture_id: "r9",
    received_at: "2026-10-07T18:00:00.000Z",
    seller_message: message,
    prior_question: text
      ? { message_type: null, template_id: "t-r9", template_use_case: use_case.replace(/_es$/, ""), text, sent_at: "2026-10-07T17:00:00.000Z", delivered_at: "2026-10-07T17:00:05.000Z" }
      : null,
    intervening_inbound: [],
    r7_history: [],
    valuation: estimated_value ? { estimated_value, arv_estimate: null } : null,
  };
  return replayReply(fixture, { catalog: CATALOG });
}

// ── Opt-outs: compliance, the canonical suppression path ────────────────────
for (const message of [
  "Remove this number from your contacts",
  "NOT TYREN!!!!!!!!!! Lose this number.",
  "Owner of EraseMyNumber.com",
]) {
  test(`opt-out: ${JSON.stringify(message)} -> opt_out, suppressed`, async () => {
    const r = await replay(message);
    assert.equal(r.classification.primary_intent, "opt_out");
    assert.equal(r.classification.compliance_flag, "stop_texting");
    assert.equal(r.classification.automation_decision.suppression_action, "opt_out");
    assert.equal(r.outcome, "suppressed");
  });
}

for (const message of ["Ya quita mi número de tus contactos", "Mejor te blokeo..."]) {
  test(`opt-out (Spanish, after a Spanish text): ${JSON.stringify(message)} -> opt_out`, async () => {
    const r = await replay(message, { use_case: "ownership_check_es" });
    assert.equal(r.classification.primary_intent, "opt_out");
    assert.equal(r.outcome, "suppressed");
  });
}

// ── Hostility with no removal words: quiet archive, never review ────────────
for (const message of ["Suck a dick", "FU!", "👹"]) {
  test(`hostile: ${JSON.stringify(message)} -> no reply, no review, nothing suppressed`, async () => {
    const r = await replay(message);
    assert.equal(r.classification.primary_intent, "hostile_or_legal");
    assert.equal(r.classification.automation_decision.quiet_archive, true);
    assert.equal(r.classification.automation_decision.suppression_action, "none");
    assert.equal(r.outcome, "no_reply_by_design");
    assert.equal(r.decision.audit_reason, "hostile_quiet_archive");
  });
}

test("a legal threat still keeps the human lane", async () => {
  const r = await replay("Text me again and my attorney will sue you");
  assert.equal(r.classification.primary_intent, "hostile_or_legal");
  assert.notEqual(r.classification.automation_decision.quiet_archive, true);
  assert.equal(r.outcome, "review");
});

// ── Bare "No" to the ownership question ─────────────────────────────────────
for (const message of ["No", "No, I'm not", "No, I don't", "No not at all", "No and no", "Of Course Not", "Noo"]) {
  test(`bare no: ${JSON.stringify(message)} -> the ownership clarifier; no template = no review`, async () => {
    const r = await replay(message);
    assert.equal(r.classification.primary_intent, "unclear");
    assert.ok(r.classification.matched_rule_ids.includes("ctx_no_after_ownership_check"));
    assert.equal(r.classification.automation_decision.clarification_use_case, "ownership_connection_clarifier");
    // The 10-06 prod catalog has no active clarifier row: deterministic hold, not review.
    assert.equal(r.outcome, "no_reply_by_design");
    assert.equal(r.decision.audit_reason, "ownership_clarifier_template_inactive");
  });
}

test("bare no with the clarifier row active -> the clarifier is sent", async () => {
  const clarifier = { id: "c1", template_id: "lc-ap2-ocl-en-1", use_case: "ownership_connection_clarifier", language: "English", stage_code: null, is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply", template_body: "Got it. Are you connected to the property, or do I have the wrong number?" };
  const fixture = { fixture_id: "r9", received_at: "2026-10-07T18:00:00.000Z", seller_message: "No, I'm not", prior_question: { template_id: "t-r9", template_use_case: "ownership_check", text: QUESTIONS.ownership_check, sent_at: "2026-10-07T17:00:00.000Z", delivered_at: "2026-10-07T17:00:05.000Z" }, intervening_inbound: [], r7_history: [], valuation: null };
  const r = await replayReply(fixture, { catalog: [...CATALOG, clarifier] });
  assert.equal(r.outcome, "auto_reply");
  assert.match(r.text, /connected to the property/);
});

test("'No I never did sorry' -> never owned: not the owner, closed", async () => {
  const r = await replay("No I never did sorry");
  assert.equal(r.classification.primary_intent, "wrong_number");
  assert.ok(r.classification.matched_rule_ids.includes("ctx_never_owned_after_ownership_check"));
});

test("'No not at all' to the consider-selling question is a decline (nurture), not a clarifier", async () => {
  const r = await replay("No not at all", { use_case: "consider_selling" });
  assert.equal(r.classification.primary_intent, "not_interested");
});

test("'No thanks' / 'No 👎' keep their decline meaning", async () => {
  for (const message of ["No thanks", "No 👎"]) {
    const r = await replay(message);
    assert.equal(r.classification.primary_intent, "not_interested", message);
  }
});

// ── Everything else from the 10-07 New Replies ──────────────────────────────
const CASES = [
  ["Sold 💯", "ownership_check", "sold_property"],
  ["Joseph Casassa", "ownership_check", "who_is_this"],
  ["Chris who", "ownership_check", "who_is_this"],
  ["no speako aspanish", "ownership_check_es", "language_switch"],
  ["La casa esta ocupada ahora mismo", "ownership_check_es", "tenant_occupied"],
  ["Bigger repairs as the home was impacted by tornado last May", null, "condition_disclosed"],
  ["It's going to be need roof soon. That's why the low price", "price_high_condition_probe", "condition_disclosed"],
  ["Do you have an offer? Do you know its just land, no house?", "consider_selling", "asks_offer"],
  ["Are you saying is this for rent", "ownership_check", "who_is_this"],
  ["Yes, and I do not want to sell it", "ownership_check", "not_interested"],
  ["what's up with the contract?", null, "contract_requested"],
  ["Put address in zillow", "ownership_check", "unclear"],
  ["No. What city?", "ownership_check", "unclear"],
  ["re doing", "ownership_check", "unclear"],
  ["La", "ownership_check", "unclear"],
  ["El nopo", "ownership_check", "unclear"],
];
for (const [message, use_case, intent] of CASES) {
  test(`${JSON.stringify(message)} -> ${intent}`, async () => {
    const r = await replay(message, { use_case });
    assert.equal(r.classification.primary_intent, intent);
  });
}

test("'no speako aspanish' refuses Spanish and is answered in English", async () => {
  const r = await replay("no speako aspanish", { use_case: "ownership_check_es" });
  assert.equal(r.classification.language, "English");
  assert.equal(r.classification.reply_signals?.language?.avoid_language ?? r.classification.language_preference?.avoid_language ?? "Spanish", "Spanish");
  assert.ok(!r.template || r.template.language === "English");
  assert.ok(!r.template || r.template.use_case === "ownership_check");
});

test("'La casa esta ocupada ahora mismo' is Spanish", async () => {
  const r = await replay("La casa esta ocupada ahora mismo", { use_case: "ownership_check_es" });
  assert.equal(r.classification.language, "Spanish");
});

test("a bare name is never confused with ordinary capitalised words", async () => {
  for (const message of ["Of Course Not", "Move In Ready", "La Casa", "Thank You"]) {
    const c = await classify(message, null, { heuristicOnly: true });
    assert.equal((c.matched_rule_ids || []).includes("bare_name_reply"), false, message);
  }
});

// ── Priority: implausible asks are the far-above-value lane, never Priority ─
for (const [message, estimated_value] of [["2 million", 254000], ["It can be yours for $1M", 222000]]) {
  test(`${JSON.stringify(message)} on a $${estimated_value} house -> asking_price_implausible`, async () => {
    const r = await replay(message, { estimated_value });
    assert.equal(r.classification.primary_intent, "asking_price_implausible");
  });
}

test("'As I have said 4-6 times, I do not own any land in OKlahoma.' -> not the owner", async () => {
  const r = await replay("As I have said 4-6 times, I do not own any land in OKlahoma.  If U have");
  assert.equal(r.classification.primary_intent, "wrong_number");
});

// ── Not opt-outs (precision) ────────────────────────────────────────────────
for (const message of ["Is this number still good for you?", "Remove the old carpet and it's fine", "Lose the attitude"]) {
  test(`not an opt-out: ${JSON.stringify(message)}`, async () => {
    const c = await classify(message, null, { heuristicOnly: true });
    assert.notEqual(c.primary_intent, "opt_out");
  });
}
