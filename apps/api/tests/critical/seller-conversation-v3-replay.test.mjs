/**
 * SELLER CONVERSATION MACHINE v3 — the 394 real inbound messages of
 * 2026-10-05..06 (round-8 fixtures, redacted) replayed through the full v3
 * chain (context -> classify -> v2 overlay -> v2 plan -> v3 plan -> executor,
 * dry run) under
 *   (a) EN/ES only: prod active+safe EN/ES + every EN/ES draft, switch EN,ES
 *   (b) all drafts: + every language's drafts, switch = all 16 languages
 * Target (owner): 0% review for S1/S2. The only (a) residual is a language
 * that is not switched on yet (owner activation decision).
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import { withBareNoClarifierOn } from "../helpers/bare-no-clarifier-flag.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { identifyReplyLanguage } from "@/lib/domain/classification/seller-reply-language.js";

import { replayV3 } from "../helpers/seller-conversation-v3-harness.mjs";
import { catalogFor, ALL_LANGUAGES_SWITCH } from "../helpers/seller-conversation-v3-catalog.mjs";

const CASES = JSON.parse(readFileSync(new URL("../fixtures/reply-quality/2026-10-05to06-all-inbound.json", import.meta.url), "utf8")).cases;
const EARLY = new Set(["S1_ownership", "S2_interest", "unknown"]);
const SCENARIOS = {
  a: { catalog: catalogFor("en_es"), languages: "English,Spanish" },
  b: { catalog: catalogFor("all"), languages: ALL_LANGUAGES_SWITCH },
};

const results = {};
async function run(name) {
  if (!results[name]) {
    results[name] = [];
    // Both scenarios are "drafts active": the bare-No clarifier counts as
    // validated (round 10: BARE_NO_AUTO_CLARIFIER on for the scenario).
    for (const c of CASES) results[name].push({ c, r: await withBareNoClarifierOn(() => replayV3(c, SCENARIOS[name])) });
  }
  return results[name];
}

test("(a) EN/ES: no S1/S2 review except a language that is not switched on", async () => {
  const rows = await run("a");
  assert.equal(rows.length, 394);
  const reviews = rows.filter(({ r }) => r.outcome === "review");
  const early = reviews.filter(({ r }) => EARLY.has(r.plan?.stage));
  for (const { c, r } of early) {
    assert.ok(!["English", "Spanish"].includes(r.classification.language), `${c.fixture_id}: ${r.review_reason}`);
  }
  assert.ok(early.length <= 1, `S1/S2 reviews: ${early.length}`);
  assert.ok(reviews.length <= 1, `all reviews: ${reviews.length}`);
  const auto = rows.filter(({ r }) => r.outcome === "auto_reply").length;
  assert.ok(auto >= 220, `auto-replies: ${auto} (round 8 with EN/ES drafts: 201)`);
});

// Round 10 (owner 2026-10-08): the reply language comes from the SELLER's own
// inbound evidence only; our outbound / stored thread language never decides.
// An emoji / number-only reply with no seller language evidence HOLDS.
test("(b) all drafts active: zero review (a language HOLD only where the seller gave no language evidence)", async () => {
  const rows = await run("b");
  const reviews = rows.filter(({ r }) => r.outcome === "review" && r.review_reason !== "hold_language").map(({ c, r }) => `${c.fixture_id}:${r.review_reason}`);
  assert.deepEqual(reviews, []);
  for (const { c, r } of rows) {
    if (r.review_reason !== "hold_language") continue;
    // Held only for no seller evidence, or conflicting seller evidence (this
    // reply vs the seller's earlier identifiable reply).
    const now_lang = identifyReplyLanguage(c.seller_message);
    const history = r.classification?.seller_history_language || null;
    assert.ok(now_lang === null || (history && history !== now_lang), `${c.fixture_id}: held although the seller's language is clear (${now_lang}/${history})`);
  }
});

test("compliance and hostility: opt-outs suppressed silently, insults archived (never suppressed), never a reply", async () => {
  for (const { c, r } of await run("a")) {
    const intent = r.raw.primary_intent;
    if (intent === "opt_out") {
      assert.equal(r.outcome, "suppressed", c.fixture_id);
      assert.equal(r.text, null, c.fixture_id);
    }
    if (intent === "hostile_or_troll" || intent === "hostile_or_legal") {
      assert.equal(r.text, null, c.fixture_id);
      assert.equal(r.outcome, "auto_terminal", c.fixture_id);
      assert.notEqual(r.classification.automation_decision?.suppression_action, "opt_out", c.fixture_id);
      assert.equal(r.decision.should_suppress_contact, false, `${c.fixture_id}: an insult never suppresses`);
    }
    if (r.text) assert.ok(!/\{\{|\}\}/.test(r.text), `${c.fixture_id}: raw placeholder`);
  }
});

test("not interested stays a nurture (never suppressed); wrong numbers keep their disposition", async () => {
  for (const { c, r } of await run("a")) {
    if (r.raw.primary_intent === "not_interested") {
      assert.notEqual(r.outcome, "suppressed", c.fixture_id);
      assert.notEqual(r.outcome, "review", c.fixture_id);
    }
    if (r.raw.primary_intent === "wrong_number") assert.equal(r.outcome, "suppressed", c.fixture_id);
  }
});
