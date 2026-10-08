/**
 * Round 10 (owner, 2026-10-08) — two behaviour conditions on the RC 8.4.7
 * safety fixes.
 *
 * 2. An ambiguous bare "No" gets NO automatic clarifier while the
 *    BARE_NO_AUTO_CLARIFIER double gate (env + system_control) is OFF (the
 *    default): hold, no outbound, quiet lane, no review -- even with an active
 *    clarifier row.
 *
 * Every string is exact; replayed through the live chain
 * (buildConversationContext -> classify -> executeInboundAutomationDecision).
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { replayReply } from "../helpers/reply-replay-harness.mjs";
import { resolveInboxBucketFromClassification } from "@/lib/domain/inbox/resolve-inbox-state-from-classification.js";
import { isBareNoAutoClarifierEnabled, BARE_NO_AUTO_CLARIFIER_FLAG } from "@/lib/domain/seller-flow/bare-no-clarifier-gate.js";

const CATALOG = JSON.parse(readFileSync(new URL("../fixtures/reply-quality/2026-10-06-safe-templates-en-es.json", import.meta.url), "utf8")).rows;
const CLARIFIER_ROW = { id: "c1", template_id: "lc-ap2-ocl-en-1", use_case: "ownership_connection_clarifier", language: "English", stage_code: null, is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply", template_body: "Got it. Are you connected to the property, or do I have the wrong number?" };
const QUESTION = "Hey Pat, this is Alex. 🙂 Are you still the owner of 606 Winterbrooke Way?";

function fixture(message, text = QUESTION) {
  return {
    fixture_id: "r10",
    received_at: "2026-10-08T18:00:00.000Z",
    seller_message: message,
    prior_question: { message_type: null, template_id: "t-r10", template_use_case: "ownership_check", text, sent_at: "2026-10-08T17:00:00.000Z", delivered_at: "2026-10-08T17:00:05.000Z" },
    intervening_inbound: [],
    r7_history: [],
    valuation: null,
  };
}
const replay = (message, opts = {}) => replayReply(fixture(message, opts.text), { catalog: opts.catalog || CATALOG, executorOverrides: opts.executorOverrides || {} });

// ── 2. BARE_NO_AUTO_CLARIFIER (default OFF) ─────────────────────────────────
const BARE_NOS = ["No", "No, I'm not", "No not at all", "Of Course Not", "Noo"];
for (const message of BARE_NOS) {
  test(`flag OFF: bare ${JSON.stringify(message)} with the clarifier row ACTIVE -> hold, no outbound, no review`, async () => {
    const r = await replay(message, { catalog: [...CATALOG, CLARIFIER_ROW] });
    assert.equal(r.classification.automation_decision.clarification_use_case, "ownership_connection_clarifier");
    assert.equal(r.text, null);
    assert.equal(r.result.queued, false);
    assert.equal(r.decision.should_queue_reply, false);
    assert.equal(r.decision.should_mark_human_review, false);
    assert.equal(r.decision.next_action, "hold_ownership_clarifier");
    assert.equal(r.decision.audit_reason, "bare_no_auto_clarifier_off");
    assert.equal(r.outcome, "no_reply_by_design");
    // Quiet lane: not New Replies, not the review lane.
    const bucket = resolveInboxBucketFromClassification(r.classification, { direction: "inbound" }, {});
    assert.notEqual(bucket, "needs_review");
    assert.notEqual(bucket, "priority");
  });
}

test("flag OFF is the default even with env set but the runtime switch missing", async () => {
  const r = await replay("No", {
    catalog: [...CATALOG, CLARIFIER_ROW],
    executorOverrides: { bareNoAutoClarifierGate: async () => (await isBareNoAutoClarifierEnabled({ env: { BARE_NO_AUTO_CLARIFIER: "true" }, readSystemFlag: async () => null })).enabled },
  });
  assert.equal(r.text, null);
  assert.equal(r.decision.audit_reason, "bare_no_auto_clarifier_off");
});

test("flag ON + clarifier row active -> the one clarifier is sent", async () => {
  const r = await replay("No, I'm not", { catalog: [...CATALOG, CLARIFIER_ROW], executorOverrides: { bareNoAutoClarifierGate: async () => true } });
  assert.equal(r.outcome, "auto_reply");
  assert.match(r.text, /connected to the property/);
});

test("flag ON + no clarifier row -> deterministic hold (template inactive), not review", async () => {
  const r = await replay("No", { executorOverrides: { bareNoAutoClarifierGate: async () => true } });
  assert.equal(r.outcome, "no_reply_by_design");
  assert.equal(r.decision.audit_reason, "ownership_clarifier_template_inactive");
});

test("the flag gate never throws and a throwing injected gate is OFF", async () => {
  const r = await replay("No", { catalog: [...CATALOG, CLARIFIER_ROW], executorOverrides: { bareNoAutoClarifierGate: async () => { throw new Error("boom"); } } });
  assert.equal(r.text, null);
  assert.equal(r.decision.audit_reason, "bare_no_auto_clarifier_off");
});

test("BARE_NO_AUTO_CLARIFIER double gate: env ceiling AND system_control", async () => {
  assert.deepEqual(BARE_NO_AUTO_CLARIFIER_FLAG, { env: "BARE_NO_AUTO_CLARIFIER", control: "bare_no_auto_clarifier" });
  let reads = 0;
  const on = async (key) => { reads += 1; assert.equal(key, "bare_no_auto_clarifier"); return "true"; };
  assert.equal((await isBareNoAutoClarifierEnabled({ env: {}, readSystemFlag: on })).enabled, false);
  assert.equal(reads, 0, "env ceiling off: the runtime switch is never read");
  assert.equal((await isBareNoAutoClarifierEnabled({ env: { BARE_NO_AUTO_CLARIFIER: "1" }, readSystemFlag: on })).enabled, false, "ceiling is exact 'true'");
  assert.equal((await isBareNoAutoClarifierEnabled({ env: { BARE_NO_AUTO_CLARIFIER: "true" }, readSystemFlag: async () => false })).enabled, false);
  assert.equal((await isBareNoAutoClarifierEnabled({ env: { BARE_NO_AUTO_CLARIFIER: "true" }, readSystemFlag: async () => { throw new Error("db"); } })).enabled, false);
  assert.equal((await isBareNoAutoClarifierEnabled({ env: { BARE_NO_AUTO_CLARIFIER: "true" }, readSystemFlag: () => new Promise(() => {}), timeoutMs: 20 })).enabled, false);
  assert.equal((await isBareNoAutoClarifierEnabled({ env: { BARE_NO_AUTO_CLARIFIER: "true" }, readSystemFlag: on })).enabled, true);
  assert.equal((await isBareNoAutoClarifierEnabled({ env: {} })).enabled, false, "default: OFF");
});
