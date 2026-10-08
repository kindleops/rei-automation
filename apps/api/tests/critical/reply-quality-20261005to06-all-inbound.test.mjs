/**
 * Round 8 (owner escalation, 2026-10-06): EVERY seller inbound from
 * 2026-10-05 00:00 to 2026-10-06 (394 messages, redacted), replayed through
 * the live chain (buildConversationContext -> classify -> executeInboundAutomationDecision)
 * against the prod catalog of active + safe EN/ES templates.
 *
 * Per message: intent, sentiment (positive / negative / neutral / sarcastic),
 * outcome (auto_reply | no_reply_by_design | suppressed | review).
 * Labels: tests/fixtures/reply-quality/2026-10-05to06-all-inbound.labels.json.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import { withBareNoClarifierOn } from "../helpers/bare-no-clarifier-flag.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { replayReply } from "../helpers/reply-replay-harness.mjs";
import { classify, correctKeyMisspellings } from "@/lib/domain/classification/classify.js";

const read = (name) => JSON.parse(readFileSync(new URL(`../fixtures/reply-quality/${name}`, import.meta.url), "utf8"));
const CASES = read("2026-10-05to06-all-inbound.json").cases;
const LABELS = read("2026-10-05to06-all-inbound.labels.json").labels;
const CATALOG = read("2026-10-06-safe-templates-en-es.json").rows;
const T = (use_case, language, template_id, template_body) => ({ id: template_id, template_id, use_case, language, stage_code: null, is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply", template_body });
const EN_ES_DRAFTS = [
  T("ownership_connection_clarifier", "English", "lc-ap2-ocl-en-1", "Got it. Are you connected to the property, or do I have the wrong number?"),
  T("ownership_connection_clarifier", "Spanish", "lc-ap2-ocl-es-1", "Entendido. ¿Tiene alguna relación con la propiedad, o tengo el número equivocado?"),
  T("price_reality_check", "English", "lc-price-reality-check-en-1", "Ha, I wish! Realistically, if the number made sense, is selling something you'd consider?"),
  T("price_reality_check", "Spanish", "lc-price-reality-check-es-1", "¡Ja, ojalá! Siendo realistas, si el número tuviera sentido, ¿consideraría vender?"),
  T("seller_frustration_apology", "English", "lc-seller-frustration-apology-en-1", "Sorry about that, I'll note it. Thanks for letting me know."),
  T("seller_frustration_apology", "Spanish", "lc-seller-frustration-apology-es-1", "Disculpe, lo anoto. Gracias por avisarme."),
];

const results = new Map();
async function run(id) {
  if (!results.has(id)) {
    const c = CASES.find((x) => x.fixture_id.endsWith(id));
    results.set(id, { today: await replayReply(c, { catalog: CATALOG }), // "With EN/ES drafts" = the drafts active AND the bare-No clarifier
      // validated (round 10: BARE_NO_AUTO_CLARIFIER on); today = defaults.
      drafts: await withBareNoClarifierOn(() => replayReply(c, { catalog: [...CATALOG, ...EN_ES_DRAFTS] })), c });
  }
  return results.get(id);
}

test("394 real inbound messages: intent, sentiment and outcome match the reviewed labels", async () => {
  assert.equal(CASES.length, 394);
  const misses = [];
  for (const [id, e] of Object.entries(LABELS)) {
    const { today, drafts } = await run(id);
    const got = {
      intent: today.classification.primary_intent,
      outcome: today.outcome,
      sentiment: today.classification.reply_sentiment,
      outcome_with_en_es_drafts: drafts.outcome,
    };
    for (const k of Object.keys(e)) if (got[k] !== e[k]) misses.push(`#${id} ${k}: expected ${e[k]}, got ${got[k]}`);
    if (today.text) assert.ok(!/\{\{|\}\}/.test(today.text), `#${id} raw placeholder`);
  }
  assert.deepEqual(misses, []);
});

test("coverage floor: share of inbound that auto-responds / is handled without a person", async () => {
  let auto = 0, handled = 0, autoDrafts = 0, handledDrafts = 0, liveAuto = 0;
  for (const id of Object.keys(LABELS)) {
    const { today, drafts, c } = await run(id);
    if (today.outcome === "auto_reply") auto += 1;
    if (today.outcome !== "review") handled += 1;
    if (drafts.outcome === "auto_reply") autoDrafts += 1;
    if (drafts.outcome !== "review") handledDrafts += 1;
    if (c.live.auto_reply) liveAuto += 1;
  }
  assert.equal(liveAuto, 104, "prod before: 104 / 394 auto-replied (26.4%)");
  assert.ok(auto >= 170, `today's catalog: ${auto} auto`);
  assert.ok(handled >= 328, `today's catalog: ${handled} handled`);
  assert.ok(autoDrafts >= 201, `with EN/ES drafts: ${autoDrafts} auto`);
  assert.ok(handledDrafts >= 359, `with EN/ES drafts: ${handledDrafts} handled`);
});

test("sarcasm is never positive, hot or a price", async () => {
  for (const [id, e] of Object.entries(LABELS)) {
    if (e.sentiment !== "sarcastic") continue;
    const { today } = await run(id);
    assert.ok(!["seller_interested", "latent_interest", "asking_price_provided", "asks_offer"].includes(today.classification.primary_intent), `#${id}`);
    assert.notEqual(today.template?.use_case, "consider_selling", `#${id}`);
    assert.notEqual(today.template?.use_case, "seller_asking_price", `#${id}`);
  }
  for (const m of ["Yeah right", "Sure buddy, 2 million", "Nice try lol", "In your dreams", "Are you sending me a gift lol", "Sure, I'll take a million dollars 😂"]) {
    const r = await classify(m, null, { heuristicOnly: true });
    assert.equal(r.reply_sentiment, "sarcastic", m);
    assert.ok(!["seller_interested", "latent_interest", "asking_price_provided"].includes(r.primary_intent), m);
  }
});

test("every opt-out in the window is suppressed, never replied to", async () => {
  for (const [id, e] of Object.entries(LABELS)) {
    if (e.intent !== "opt_out") continue;
    const { today } = await run(id);
    assert.equal(today.outcome, "suppressed", `#${id}`);
    assert.equal(today.text, null, `#${id}`);
  }
  for (const m of ["Don't ever text me again", "Never text me again", "dont ever contact me", "Lose my number"]) {
    assert.equal((await classify(m, null, { heuristicOnly: true })).primary_intent, "opt_out", m);
  }
});

test("misspelling tolerance on key words; ordinary words untouched", async () => {
  assert.equal(correctKeyMisspellings("not intrested"), "not interested");
  assert.equal(correctKeyMisspellings("proprety is not for sale"), "property is not for sale");
  assert.equal(correctKeyMisspellings("I'm the onwer"), "I'm the owner");
  assert.equal(correctKeyMisspellings("wrong numbr"), "wrong number");
  for (const m of ["Never owned that house", "great offers", "power bill", "the houses are old", "Hola amigo"]) {
    assert.equal(correctKeyMisspellings(m), m, m);
  }
  assert.equal((await classify("not intrested", null, { heuristicOnly: true })).primary_intent, "not_interested");
  assert.equal((await classify("wrong numbr", null, { heuristicOnly: true })).primary_intent, "wrong_number");
  // Round 10 (owner 2026-10-08): an ownership denial is property-scoped.
  assert.equal((await classify("Never owned that house", null, { heuristicOnly: true })).primary_intent, "property_specific_non_owner");
});

test("round-8 rules: condition statements, purpose questions, need-time, bare '?', tapback 👍 on our question", async () => {
  for (const [m, intent] of [
    ["move in ready", "condition_disclosed"], ["Good..it does not need any repair.", "condition_disclosed"],
    ["Central air and heat", "condition_disclosed"], ["4 car garage and lot", "condition_disclosed"],
    ["Why , are you a corporation?", "who_is_this"], ["Are you in a real state? What's the name of the real state", "who_is_this"],
    ["Also she wants to know if your a wholesaler", "who_is_this"], ["?", "who_is_this"], ["Y tu?", "who_is_this"],
    ["Not now", "need_time"], ["Not at this point", "need_time"], ["Almost certainly no.", "not_interested"],
  ]) {
    assert.equal((await classify(m, null, { heuristicOnly: true })).primary_intent, intent, m);
  }
});
