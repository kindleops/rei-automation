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

import { replayV3 } from "../helpers/seller-conversation-v3-harness.mjs";
import { catalogFor, ALL_LANGUAGES_SWITCH } from "../helpers/seller-conversation-v3-catalog.mjs";

const CASES = JSON.parse(readFileSync(new URL("../fixtures/reply-quality/2026-10-05to06-all-inbound.json", import.meta.url), "utf8")).cases;
const EARLY = new Set(["S1_ownership", "S2_interest", "unknown"]);
// OWNER RULE (P0 2026-10-09, binding): "never ask about condition before we
// have their price". These three used to get "No worries, I can run the
// numbers. What's the condition of the property right now?" with no price in
// hand; they are now held for a person. Exactly these, with exactly this reason.
const OWNER_RULE_20261009_REVIEWS = new Map([
  ["rq-2026-10-05to06-056", "condition_before_seller_price_forbidden"], // "I have no idea"
  ["rq-2026-10-05to06-169", "condition_before_seller_price_forbidden"], // "No price it brings in a good amount…"
  ["rq-2026-10-05to06-289", "repeat_intent_no_alternative"], // "What are u offering" after the price question
]);
const ownerRuleReview = ({ c, r }) => OWNER_RULE_20261009_REVIEWS.get(c.fixture_id) === r.review_reason;
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
  const reviews = rows.filter((row) => row.r.outcome === "review" && !ownerRuleReview(row));
  const early = reviews.filter(({ r }) => EARLY.has(r.plan?.stage));
  for (const { c, r } of early) {
    assert.ok(!["English", "Spanish"].includes(r.classification.language), `${c.fixture_id}: ${r.review_reason}`);
  }
  assert.ok(early.length <= 1, `S1/S2 reviews: ${early.length}`);
  assert.ok(reviews.length <= 1, `all reviews: ${reviews.length}`);
  const auto = rows.filter(({ r }) => r.outcome === "auto_reply").length;
  // 220 before the owner rule of 2026-10-09 took the three no-price condition
  // probes above out of automation (and S3 asking-price reroutes added others).
  assert.ok(auto >= 219, `auto-replies: ${auto} (round 8 with EN/ES drafts: 201)`);
});

test("(b) all drafts active: zero review", async () => {
  const rows = await run("b");
  const reviews = rows
    .filter((row) => row.r.outcome === "review" && !ownerRuleReview(row))
    .map(({ c, r }) => `${c.fixture_id}:${r.review_reason}`);
  assert.deepEqual(reviews, []);
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
