// Activation-hardening: the 7 dangerous misroutes from the 2026-08-17 audit.
// Each test asserts the REQUIRED behavior (written failing-first against the
// pre-fix tree). Production classification path is heuristicOnly (no LLM).

import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import {
  resolveSellerResponseStrategy,
  OBJECTIVE_TEMPLATE_USE_CASE,
} from "@/lib/domain/seller-flow/resolve-seller-response-strategy.js";
import { ACQUISITION_OBJECTIVES } from "@/lib/domain/seller-flow/resolve-seller-next-best-action.js";

// Dynamic so the suite still loads (and every other misroute test still runs)
// on a tree where the fix-5 helper does not exist yet.
async function loadPriceObjectionDirective() {
  const mod = await import("@/lib/domain/seller-flow/process-seller-inbound-message.js");
  assert.equal(
    typeof mod.resolvePriceObjectionDirective,
    "function",
    "resolvePriceObjectionDirective must be exported by the orchestrator"
  );
  return mod.resolvePriceObjectionDirective;
}

const heur = (msg, ctx = null) =>
  classify(msg, null, { heuristicOnly: true, conversation_context: ctx });

const NOW = new Date("2026-08-17T15:00:00Z");
const ctxFor = (use_case, question_type) => ({
  context_version: "conversation_context_v1",
  canonical_thread: "+16125550100",
  inbound_thread: "+16125550100",
  last_outbound_message_id: "evt_misroute_probe",
  last_outbound_use_case: use_case,
  last_outbound_question_type: question_type,
  last_outbound_delivered_at: new Date(NOW.getTime() - 3600_000).toISOString(),
  current_inbound_received_at: NOW.toISOString(),
  intervening_outbound_count: 0,
  intervening_inbound_count: 0,
  unanswered_question: true,
  language: "English",
});

// ── 1. "No" answering a condition/repairs question must NOT become not_interested
test('misroute 1: short "No" after a condition question is never not_interested', async () => {
  const r = await heur("No", ctxFor("condition_check", "condition"));
  assert.notEqual(r.primary_intent, "not_interested",
    "a seller whose house needs no repairs must not be shelved as not_interested");
  // fail-closed: it must land in the clarification lane, not a suppressive one
  assert.equal(r.automation_decision.suppression_action, "none");
  assert.equal(r.automation_decision.auto_reply_allowed, false);
  assert.equal(r.automation_decision.human_review_required, true);
});

test('misroute 1 control: short "No" after a proposal-interest question stays not_interested', async () => {
  const r = await heur("No", ctxFor("proposal_interest", "proposal_interest"));
  assert.equal(r.primary_intent, "not_interested");
});

// ── 2. Probate / deceased-owner language → human/empathetic lane, never auto-reply
test("misroute 2: probate/deceased-owner routes to human review, never auto-reply", async () => {
  for (const msg of [
    "My father passed away, I'm handling the estate",
    "The property is in probate right now",
    "She passed away last year and it's part of the estate",
  ]) {
    const r = await heur(msg);
    assert.equal(r.automation_decision.auto_reply_allowed, false, `auto-reply must be off for: ${msg}`);
    assert.equal(r.automation_decision.human_review_required, true, `review required for: ${msg}`);
    assert.equal(r.automation_decision.suppression_action, "none", `never suppress: ${msg}`);
  }
});

// ── 3. Foreclosure / time-critical distress → protected human lane
test("misroute 3: foreclosure/time-critical distress routes to human review, never auto-reply", async () => {
  for (const msg of [
    "We're facing foreclosure, the bank is about to take it",
    "It's in pre-foreclosure",
  ]) {
    const r = await heur(msg);
    assert.equal(r.automation_decision.auto_reply_allowed, false, `auto-reply must be off for: ${msg}`);
    assert.equal(r.automation_decision.human_review_required, true, `review required for: ${msg}`);
    assert.equal(r.automation_decision.suppression_action, "none", `never suppress: ${msg}`);
  }
});

// ── 4. "text me, just don't call me" = channel preference, NOT global opt-out
test("misroute 4: call-only prohibition with explicit text preference is not an opt-out", async () => {
  for (const msg of [
    "Text me, just don't call me",
    "Please text only, do not call me",
    "Stop calling me, text me instead",
  ]) {
    const r = await heur(msg);
    assert.notEqual(r.primary_intent, "opt_out", `not an opt-out: ${msg}`);
    assert.notEqual(r.compliance_flag, "stop_texting", `no stop_texting flag: ${msg}`);
    assert.equal(r.automation_decision.suppression_action, "none", `no suppression: ${msg}`);
  }
});

test("misroute 4 controls: real opt-outs still suppress", async () => {
  for (const msg of [
    "Don't text me",
    "Stop calling and texting me",
    "Don't call or text me again",
    "STOP",
  ]) {
    const r = await heur(msg);
    assert.equal(r.primary_intent, "opt_out", `must remain opt-out: ${msg}`);
  }
});

// ── 5. Sub-S5 price objection must not silently run the fresh-price flow
test("misroute 5: price + rejection language below the negotiation stage forces protected review", async () => {
  // classifier precondition (current behavior, sanity): amount + rejection parses as price w/ objection
  const c = await heur("That's way too low, I want 300k");
  assert.equal(c.primary_intent, "asking_price_provided");
  assert.equal(c.objection, "need_more_money");

  // the orchestrator directive: below S5 with no negotiation strategy → review directive
  const resolvePriceObjectionDirective = await loadPriceObjectionDirective();
  const d = resolvePriceObjectionDirective({
    classification: c,
    negotiation: null,
    stageAfter: "asking_price",
  });
  assert.ok(d, "must produce a protected-review directive below the negotiation stage");
  assert.equal(d.review_required, true);
  assert.equal(d.reason_code, "price_objection_below_negotiation");
});

test("misroute 5 controls: S5 negotiation and plain price answers are untouched", async () => {
  const resolvePriceObjectionDirective = await loadPriceObjectionDirective();
  const c = await heur("That's way too low, I want 300k");
  // at S5 the negotiation router owns the turn → no synthetic directive
  assert.equal(
    resolvePriceObjectionDirective({
      classification: c,
      negotiation: { strategy_decision: { strategy: "COUNTER_OFFER" } },
      stageAfter: "offer",
    }),
    null
  );
  // a plain price answer (no rejection language) is a normal fresh price
  const plain = await heur("We'd want 300k");
  assert.equal(
    resolvePriceObjectionDirective({ classification: plain, negotiation: null, stageAfter: "asking_price" }),
    null
  );
  // an offer solicitation with "best offer" phrasing is not a price objection
  const solicit = await heur("What's your best offer?");
  assert.equal(
    resolvePriceObjectionDirective({ classification: solicit, negotiation: null, stageAfter: "asking_price" }),
    null
  );
});

// ── 6. Confirmed-owner trust/scam concern → safe identity handling, not silence
test("misroute 6: trust concern maps to the safe identity template, not null/silence", () => {
  assert.equal(
    OBJECTIVE_TEMPLATE_USE_CASE[ACQUISITION_OBJECTIVES.HANDLE_TRUST_CONCERN],
    "who_is_this",
    "trust concern must route to the existing safe identity template"
  );
});

test("misroute 6: trust-concern strategy produces a reply, not a withhold", () => {
  const strategy = resolveSellerResponseStrategy({
    conversation_state: {
      safety: { suppression_required: false, human_review_required: false, no_reply_required: false, offer_permission: false },
      authority: { offer_progression_allowed: false },
      identity: { owner_confirmed: true },
      acquisition: { asking_price: { resolution: "unknown" } },
      negotiation: {},
      trust_concern: true,
    },
    next_best_action: {
      objective: ACQUISITION_OBJECTIVES.HANDLE_TRUST_CONCERN,
      reason_code: "trust_concern_raised",
      suppression_required: false,
      human_review_required: false,
      offer_allowed: false,
    },
  });
  assert.equal(strategy.template_use_case, "who_is_this");
  assert.equal(strategy.no_reply, false, "a confirmed owner asking 'is this a scam?' must get an answer");
  assert.equal(strategy.human_review_required, false);
});

// ── 7. Bare "why" must not outrank stronger co-present intent
test('misroute 7: "why" alongside ownership confirmation does not become who_is_this', async () => {
  const r = await heur("Why do you want to buy it? Yes it's mine");
  assert.equal(r.primary_intent, "ownership_confirmed");
});

test("misroute 7 controls: genuine identity questions keep who_is_this", async () => {
  for (const msg of ["Why?", "Who is this?", "How did you get my number"]) {
    const r = await heur(msg);
    assert.equal(r.primary_intent, "who_is_this", `must stay who_is_this: ${msg}`);
  }
});
