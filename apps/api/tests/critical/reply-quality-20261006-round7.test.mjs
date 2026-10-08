/**
 * Round 7 live cases (prod 8f4bf32b, 2026-10-06).
 *  1. Tampa: "Yes, and nothing's for sale." got the interest probe; then
 *     "Did you read my text?".
 *  2. Garland: "Yes. $5 million" (est. $262K) -> condition probe; then
 *     "There are shitstains all over the walls and dead rats ...".
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { replayReply } from "../helpers/reply-replay-harness.mjs";
import { classify } from "@/lib/domain/classification/classify.js";
import { resolveCanonicalAskingPrice, isCommittedAskingPrice } from "@/lib/domain/seller-flow/canonical-asking-price.js";

const CASES = JSON.parse(readFileSync(new URL("../fixtures/reply-quality/2026-10-06-round7.json", import.meta.url), "utf8")).cases;
const CATALOG = JSON.parse(readFileSync(new URL("../fixtures/reply-quality/2026-10-06-safe-templates-en-es.json", import.meta.url), "utf8")).rows;
const byId = (n) => CASES.find((c) => c.fixture_id.endsWith(n));

const APOLOGY_ROWS = [
  { id: "sfa-en", template_id: "lc-seller-frustration-apology-en-1", use_case: "seller_frustration_apology", language: "English", stage_code: null, is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply", template_body: "Sorry about that, I'll note it. Thanks for letting me know." },
  { id: "sfa-es", template_id: "lc-seller-frustration-apology-es-1", use_case: "seller_frustration_apology", language: "Spanish", stage_code: null, is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply", template_body: "Disculpe, lo anoto. Gracias por avisarme." },
];

const OWNERSHIP_CTX_FIXTURE = byId("001");

test("Tampa 'Yes, and nothing's for sale.' -> not_interested, 30-day nurture, NO interest probe", async () => {
  const r = await replayReply(byId("001"), { catalog: CATALOG });
  assert.equal(r.classification.primary_intent, "not_interested");
  assert.equal(r.outcome, "no_reply_by_design");
  assert.notEqual(r.template?.use_case, "consider_selling");
  assert.equal(r.text, null);
});

test("yes + not-for-sale in any position after the yes is a decline", async () => {
  for (const message of [
    "Yes, and nothing's for sale.", "Yes, nothing is for sale", "Yes but not selling", "yes, not interested",
    "Yes it's mine but it's not for sale", "Yes. Not for sale", "Sí, pero no vendo", "Si pero no esta en venta",
  ]) {
    const r = await replayReply({ ...OWNERSHIP_CTX_FIXTURE, seller_message: message }, { catalog: CATALOG });
    assert.equal(r.classification.primary_intent, "not_interested", message);
    assert.notEqual(r.template?.use_case, "consider_selling", message);
  }
});

test("Tampa 'Did you read my text?' -> frustration: ONE apology + nurture once the template is active; review now; never a re-ask", async () => {
  const now = await replayReply(byId("002"), { catalog: CATALOG });
  assert.equal(now.classification.matched_rule_ids.includes("seller_frustration_after_misread"), true);
  assert.equal(now.classification.automation_decision.clarification_use_case, "seller_frustration_apology");
  assert.equal(now.outcome, "review");
  assert.equal(now.text, null);
  const later = await replayReply(byId("002"), { catalog: [...CATALOG, ...APOLOGY_ROWS] });
  assert.equal(later.outcome, "auto_reply");
  assert.equal(later.template.use_case, "seller_frustration_apology");
  for (const m of ["I already told you", "I said no", "I told you already", "Ya te dije que no", "Did u even read my message?"]) {
    const c = await classify(m, null, { heuristicOnly: true });
    assert.ok(c.matched_rule_ids.includes("seller_frustration_after_misread"), m);
    assert.notEqual(c.automation_decision.queue_action, "queue_auto_reply", m);
  }
});

test("Garland 'Yes. $5 million' on a $262K house -> implausible (already fixed by 6d39efab): no price fact, no stage advance, reality check or review", async () => {
  const r = await replayReply(byId("003"), { catalog: CATALOG });
  assert.equal(r.classification.primary_intent, "asking_price_implausible");
  assert.notEqual(r.classification.primary_intent, "ownership_confirmed");
  assert.equal(r.classification.price_parse.implausibility.estimated_value, 262000);
  assert.equal(isCommittedAskingPrice(resolveCanonicalAskingPrice("Yes. $5 million", { classification: r.classification })), false);
  assert.notEqual(r.template?.use_case, "condition_probe");
  assert.equal(r.outcome, "review", "reality-check templates are proposed, not active");
});

// Round 9 (owner 2026-10-07): trolling is a QUIET ARCHIVE -- no reply, no
// review item, nothing suppressed (was: review).
test("Garland 'shitstains ... dead rats' after the implausible ask -> hostile_or_troll: quiet archive, no auto-reply", async () => {
  const r = await replayReply(byId("004"), { catalog: CATALOG });
  assert.equal(r.classification.primary_intent, "hostile_or_troll");
  assert.equal(r.classification.automation_decision.auto_reply_allowed, false);
  assert.equal(r.classification.automation_decision.human_review_required, false);
  assert.equal(r.classification.automation_decision.quiet_archive, true);
  assert.equal(r.outcome, "no_reply_by_design");
  assert.equal(r.text, null);
});

test("gross condition WITHOUT profanity and without a prior implausible ask is a condition disclosure; profanity alone is never auto-replied", async () => {
  const clean = await replayReply({ ...byId("004"), seller_message: "There are dead rats in the basement and the roof leaks", r7_history: [{ text: "Yes" }] }, { catalog: CATALOG });
  assert.equal(clean.classification.primary_intent, "condition_disclosed");
  const afterJoke = await replayReply({ ...byId("004"), seller_message: "There are dead rats in every room" }, { catalog: CATALOG });
  assert.equal(afterJoke.classification.primary_intent, "hostile_or_troll");
  for (const m of ["The place is a shithole", "It's in crappy shape lol", "fucking roof leaks"]) {
    const c = await classify(m, null, { heuristicOnly: true });
    assert.equal(c.automation_decision.auto_reply_allowed, false, m);
  }
});
