// ─── acquisition-brain-lifecycle-nba.test.mjs ──────────────────────────────
// PR A: canonical Stage 1–10 registry + next-best-action resolver.

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  ACQUISITION_LIFECYCLE_STAGES as S,
  ORDERED_LIFECYCLE_STAGES,
  STAGE_NUMBERS,
  LIFECYCLE_REGISTRY,
  AUTHORITATIVE_TRANSACTION_EVENTS,
  normalizeLifecycleStage,
  getLifecycleStage,
  isTransactionGatedStage,
  canAdvanceLifecycleStage,
  recommendStageFromFacts,
  evaluateStage5Readiness,
  evaluateStage6Readiness,
  resolveNextBestAction,
  NBA_ACTION_TYPES,
  STAGE_PRIMARY_USE_CASES,
} from "@/lib/domain/acquisition-brain/index.js";

test("registry contains exactly stages 1–10 in order", () => {
  assert.equal(ORDERED_LIFECYCLE_STAGES.length, 10);
  assert.equal(STAGE_NUMBERS[S.OWNERSHIP_CHECK], 1);
  assert.equal(STAGE_NUMBERS[S.CLOSED], 10);
  for (const id of ORDERED_LIFECYCLE_STAGES) {
    const def = getLifecycleStage(id);
    assert.ok(def, `missing def for ${id}`);
    assert.equal(def.stage_id, id);
    assert.ok(Array.isArray(def.allowed_next_stages));
    assert.ok(def.follow_up_policy);
  }
});

test("aliases map legacy seller-flow labels to canonical stages", () => {
  assert.equal(normalizeLifecycleStage("consider_selling"), S.INTEREST_PROPOSAL_CONFIRMATION);
  assert.equal(normalizeLifecycleStage("seller_asking_price"), S.ASKING_PRICE);
  assert.equal(normalizeLifecycleStage("S3"), S.ASKING_PRICE);
  assert.equal(normalizeLifecycleStage("under_contract"), S.UNDER_CONTRACT_WITH_BUYER);
});

test("stages 7–10 are transaction-gated (seller text cannot advance)", () => {
  for (const id of [
    S.DISPOSITION,
    S.UNDER_CONTRACT_WITH_BUYER,
    S.ESCROW,
    S.CLOSED,
  ]) {
    assert.equal(isTransactionGatedStage(id), true, id);
    assert.equal(LIFECYCLE_REGISTRY[id].seller_text_may_advance, false);
  }
  assert.equal(isTransactionGatedStage(S.ASKING_PRICE), false);
});

test("seller text cannot advance to disposition", () => {
  const gate = canAdvanceLifecycleStage({
    from_stage: S.FORMAL_CONTRACT,
    to_stage: S.DISPOSITION,
    advance_source: "seller_text",
  });
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /seller_text|not_permitted|authoritative/i);
});

test("authoritative event can advance disposition when package event present", () => {
  const gate = canAdvanceLifecycleStage({
    from_stage: S.FORMAL_CONTRACT,
    to_stage: S.DISPOSITION,
    advance_source: "authoritative_event",
    authoritative_events: [
      AUTHORITATIVE_TRANSACTION_EVENTS.DISPOSITION_PACKAGE_CREATED,
    ],
  });
  assert.equal(gate.ok, true);
});

test('facts for "Yes, what\'s the proposal?" recommend Asking Price', () => {
  const rec = recommendStageFromFacts({
    ownership_confirmed: true,
    proposal_interest_confirmed: true,
    seller_requests_proposal: true,
  });
  assert.equal(rec.stage, S.ASKING_PRICE);
});

test("NBA: proposal request → send_template seller_asking_price", () => {
  const nba = resolveNextBestAction({
    current_stage: S.OWNERSHIP_CHECK,
    facts: {
      ownership_confirmed: true,
      proposal_interest_confirmed: true,
      seller_requests_proposal: true,
    },
    classification: {
      primary_intent: "asks_offer",
      confidence: 0.98,
    },
    inbound_event_id: "evt-proposal",
  });
  assert.equal(nba.action_type, NBA_ACTION_TYPES.SEND_TEMPLATE);
  assert.equal(nba.required_template_use_case, "seller_asking_price");
  assert.equal(nba.lifecycle_stage_after, S.ASKING_PRICE);
  assert.ok(nba.idempotency_key.includes("send_template"));
  // Must not re-ask Stage 2 interest
  assert.notEqual(nba.required_template_use_case, "consider_selling");
});

test("NBA: bare ownership → consider_selling Stage 2", () => {
  const nba = resolveNextBestAction({
    current_stage: S.OWNERSHIP_CHECK,
    facts: { ownership_confirmed: true },
    classification: { primary_intent: "ownership_confirmed", confidence: 0.95 },
  });
  assert.equal(nba.action_type, NBA_ACTION_TYPES.SEND_TEMPLATE);
  assert.equal(nba.required_template_use_case, "consider_selling");
  assert.equal(nba.lifecycle_stage_after, S.INTEREST_PROPOSAL_CONFIRMATION);
});

test("NBA: opt-out always suppresses", () => {
  const nba = resolveNextBestAction({
    facts: { opt_out: true, ownership_confirmed: true, seller_requests_proposal: true },
    classification: { primary_intent: "asks_offer", confidence: 0.99 },
  });
  assert.equal(nba.action_type, NBA_ACTION_TYPES.OPT_OUT);
});

test("NBA: not_interested not overridden by superficial positive facts", () => {
  const nba = resolveNextBestAction({
    facts: { not_interested: true, ownership_confirmed: true },
    classification: { primary_intent: "ownership_confirmed", confidence: 0.99 },
  });
  assert.equal(nba.action_type, NBA_ACTION_TYPES.SUPPRESS);
});

test("stage primary use cases cover stages 1–6 only for templates", () => {
  assert.equal(STAGE_PRIMARY_USE_CASES[S.ASKING_PRICE], "seller_asking_price");
  assert.equal(STAGE_PRIMARY_USE_CASES[S.DISPOSITION], null);
  assert.equal(STAGE_PRIMARY_USE_CASES[S.CLOSED], null);
});

test("S1→S3 skip is allowed when listed on ownership_check", () => {
  const gate = canAdvanceLifecycleStage({
    from_stage: S.OWNERSHIP_CHECK,
    to_stage: S.ASKING_PRICE,
    advance_source: "seller_text",
  });
  assert.equal(gate.ok, true);
});

test("forbidden jump S1→actual_proposal blocked", () => {
  const gate = canAdvanceLifecycleStage({
    from_stage: S.OWNERSHIP_CHECK,
    to_stage: S.ACTUAL_PROPOSAL,
    advance_source: "seller_text",
  });
  assert.equal(gate.ok, false);
});

// ── Stage 5 / Stage 6 contract tests (closes former 13/17 PR-body gap) ─────

test("Stage 5 registry lists required substates and tight entry requirements", () => {
  const s5 = getLifecycleStage(S.ACTUAL_PROPOSAL);
  assert.ok(s5.stage_substates.includes("proposal_calculation_ready"));
  assert.ok(s5.stage_substates.includes("seller_accepted_verbally"));
  assert.ok(s5.stage_substates.includes("insufficient_facts"));
  assert.ok(
    s5.entry_requirements.some((r) => String(r).includes("ownership_confirmed"))
  );
  assert.ok(
    s5.entry_requirements.some((r) => String(r).includes("proposal_interest"))
  );
});

test("Stage 5: enthusiasm alone cannot open Actual Proposal", () => {
  const blocked = evaluateStage5Readiness({
    ownership_confirmed: true,
    proposal_interest_confirmed: true,
    // missing price, condition, valuation, authority
  });
  assert.equal(blocked.entry_allowed, false);
  assert.equal(blocked.substate, "insufficient_facts");
  assert.ok(blocked.missing_facts.length >= 2);

  const ready = evaluateStage5Readiness({
    ownership_confirmed: true,
    proposal_interest_confirmed: true,
    asking_price: { value: 250000 },
    condition_summary: "needs roof",
    underwriting_ready: true,
    authority_risks_identified: true,
  });
  assert.equal(ready.entry_allowed, true);
  assert.equal(ready.substate, "proposal_calculation_ready");
});

test("Stage 6: paperwork request without proposal outcome is not contract_ready", () => {
  const blocked = evaluateStage6Readiness({
    ownership_confirmed: true,
    contract_requested: true, // "send me the paperwork" alone
  });
  assert.equal(blocked.entry_allowed, false);
  assert.ok(blocked.missing_facts.includes("proposal_accepted_or_contract_intent"));

  const ready = evaluateStage6Readiness({
    ownership_confirmed: true,
    proposal_accepted: true,
    can_execute_alone: true,
  });
  assert.equal(ready.entry_allowed, true);
  assert.equal(ready.substate, "contract_ready");
});

test("Stage 6: co-owner / probate never assume solo execution", () => {
  const spouse = evaluateStage6Readiness({
    ownership_confirmed: true,
    proposal_accepted: true,
    spouse_co_owner: true,
  });
  assert.equal(spouse.can_execute_alone, false);
  assert.equal(spouse.substate, "waiting_on_spouse");

  const probate = evaluateStage6Readiness({
    ownership_confirmed: true,
    proposal_accepted: true,
    probate: true,
  });
  assert.equal(probate.human_review, true);
  assert.equal(probate.substate, "probate_heirship");
  assert.equal(probate.can_execute_alone, false);
});
