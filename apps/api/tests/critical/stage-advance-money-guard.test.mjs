/**
 * FAIL-CLOSED lifecycle promotion (2026-10-07 deal-attribution audit):
 *   227876842 reached formal_contract on a "$4,100" misparse (case voided),
 *   296670809 reached formal_contract on a "$331" asking price,
 *   "2024" (a year) was read as an asking price, and 16 deals sat at Offer
 *   with current_offer = 0.
 * No stage advance to Offer from an implausible number or a zero offer; Formal
 * Contract and later only through a live closing case / the closing authority.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { assessDealAmount, evaluateStageAdvance, MIN_PLAUSIBLE_PROPERTY_PRICE } from "@/lib/domain/opportunity/stage-advance-guard.js";
import { transitionOpportunityStage } from "@/lib/domain/opportunity/opportunity-service.js";
import { resolveCanonicalTerms } from "@/lib/domain/closings/create-closing-case-from-acceptance.js";
import { patchUniversalLeadState } from "@/lib/domain/lead-state/patch-universal-lead-state.js";

test("number rules: $4,100 / $331 / 2024 / 0 are never deal prices; a real price is", () => {
  assert.equal(assessDealAmount(4100).plausible, false);
  assert.equal(assessDealAmount(4100).rule, "below_property_price_floor");
  assert.equal(assessDealAmount(331).plausible, false);
  assert.equal(assessDealAmount(2024).rule, "bare_year");
  assert.equal(assessDealAmount(0).rule, "zero_or_missing");
  assert.equal(assessDealAmount(null).plausible, false);
  assert.equal(assessDealAmount(185_000, { estimated_value: 210_000 }).plausible, true);
  assert.equal(assessDealAmount(5_000_000, { estimated_value: 300_000 }).plausible, false, "implausible vs value");
  assert.equal(MIN_PLAUSIBLE_PROPERTY_PRICE, 10_000);
});

const opp = (over = {}) => ({ id: "o1", acquisition_stage: "property_condition", opportunity_status: "active", current_offer: 0, asking_price: null, estimated_value: 320_900, ...over });

test("Offer: an automated move needs a real offer and a plausible ask (the 16 current_offer = 0 deals, $331, 2024)", () => {
  const zero = evaluateStageAdvance({ current: opp(), to_stage: "offer", source: "seller_inbound_orchestrator" });
  assert.equal(zero.ok, false);
  assert.equal(zero.code, "VALID_OFFER_REQUIRED");
  const ask331 = evaluateStageAdvance({ current: opp({ current_offer: 180_000, asking_price: 331, estimated_value: 220_000 }), to_stage: "offer", source: "seller_autopilot" });
  assert.equal(ask331.code, "ASKING_PRICE_IMPLAUSIBLE");
  const year = evaluateStageAdvance({ current: opp({ current_offer: 150_000, asking_price: 2024 }), to_stage: "offer", source: "seller_autopilot" });
  assert.equal(year.code, "ASKING_PRICE_IMPLAUSIBLE");
  assert.equal(year.guard.ask_rule, "bare_year");
  const good = evaluateStageAdvance({ current: opp({ current_offer: 210_000, asking_price: 240_000 }), to_stage: "offer", source: "seller_autopilot" });
  assert.equal(good.ok, true);
  const record = evaluateStageAdvance({ current: opp({ active_offer_id: "offer-1" }), to_stage: "offer", source: "seller_autopilot" });
  assert.equal(record.ok, true, "an active offer record is a real offer");
  assert.equal(evaluateStageAdvance({ current: opp(), to_stage: "offer", source: "operator" }).ok, true, "an operator decision is not a parse");
});

test("Formal Contract+: only an explicit contract event — never a parsed reply ($4,100 → formal_contract)", () => {
  const fromReply = evaluateStageAdvance({ current: opp({ acquisition_stage: "offer", current_offer: 4100 }), to_stage: "formal_contract", source: "seller_inbound_orchestrator" });
  assert.equal(fromReply.code, "CONTRACT_EVENT_REQUIRED");
  assert.equal(evaluateStageAdvance({ current: opp({ acquisition_stage: "offer" }), to_stage: "formal_contract", source: "operator" }).ok, false, "even an operator needs the Closing Desk contract");
  assert.equal(evaluateStageAdvance({ current: opp({ acquisition_stage: "offer" }), to_stage: "formal_contract", source: "closing_authority" }).ok, true);
  assert.equal(evaluateStageAdvance({ current: opp({ acquisition_stage: "offer" }), to_stage: "formal_contract", source: "seller_autopilot", live_closing_case: true }).ok, true);
  for (const s of ["disposition", "under_contract", "prepared_to_close"]) {
    assert.equal(evaluateStageAdvance({ current: opp({ acquisition_stage: "formal_contract" }), to_stage: s, source: "workflow" }).ok, false, s);
  }
  assert.equal(evaluateStageAdvance({ current: opp({ acquisition_stage: "offer" }), to_stage: "asking_price", source: "seller_autopilot" }).ok, true, "moving back is not gated here");
});

function fakeDb({ row, cases = [] }) {
  const updates = [];
  const from = (table) => {
    const chain = {
      select: () => chain, eq: () => chain, in: () => chain, order: () => chain,
      limit: async () => ({ data: table === "closing_cases" ? cases : [row], error: null }),
      single: async () => ({ data: row, error: null }),
      maybeSingle: async () => ({ data: row, error: null }),
      update: (patch) => { updates.push({ table, patch }); return chain; },
      insert: async () => ({ data: null, error: null }),
    };
    return chain;
  };
  return { from, updates };
}

test("transitionOpportunityStage refuses the historical promotions before any write", async () => {
  // 296670809: $331 ask, current_offer 0, automated promotion to Offer.
  const a = fakeDb({ row: opp({ id: "o296", asking_price: 331, recommended_offer: 25_400 }) });
  const r1 = await transitionOpportunityStage("o296", { to_stage: "offer", source: "seller_inbound_orchestrator", actor: "seller_inbound_orchestrator" }, { supabase: a });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, "VALID_OFFER_REQUIRED");
  assert.equal(a.updates.length, 0, "nothing written");
  // 227876842: formal_contract with only a voided closing case.
  const b = fakeDb({ row: opp({ id: "o227", acquisition_stage: "offer", current_offer: 4100 }), cases: [{ closing_status: "not_scheduled", contract_status: "cancelled" }] });
  const r2 = await transitionOpportunityStage("o227", { to_stage: "formal_contract", source: "seller_inbound_orchestrator" }, { supabase: b });
  assert.equal(r2.code, "CONTRACT_EVENT_REQUIRED");
  assert.equal(b.updates.length, 0);
});

test("a closing case is refused for an implausible contract price ($4,100)", () => {
  const terms = resolveCanonicalTerms({
    opportunity: { id: "o227", estimated_value: 320_900 },
    accepted_offer: { offer_id: "off-1", accepted_price: 4100, purchase_price: 4100, closing_window_days: 30, closing_date: "2026-11-01", earnest_money: 1000, emd_due_policy: "3_business_days", scheduled_closing_date: "2026-11-01", emd_due_date: "2026-10-10",
      offer_version: 1, opportunity_id: "o227", thread_key: "+16125550123", emd_amount: 1000, emd_due_business_days: 3, terms_hash: "h1", acceptance_event_id: "ev-1", accepted_at: "2026-09-10T12:00:00Z" },
  });
  assert.equal(terms.ok, false);
  assert.equal(terms.reason, "contract_price_implausible");
  assert.equal(terms.price_rule, "below_property_price_floor");
});

test("an automated thread write never sets Offer+ directly; it follows the opportunity", async () => {
  const res = await patchUniversalLeadState({
    threadKey: "+16125550123",
    patch: { lifecycle_stage: "formal_contract" },
    meta: { change_source: "autopilot", source_view: "seller_inbound" },
    dryRun: true,
    supabase: fakeDb({ row: {} }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "lifecycle_stage_requires_canonical_opportunity");
  assert.equal(res.lifecycle_stage_withheld, "formal_contract");
});
