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

import {
  assessDealAmount,
  assessOfferAmount,
  evaluateStageAdvance,
  validateOfferEvent,
  offerEventFromSellerOffer,
  offerEventFromQuote,
  classifyOfferWording,
  MIN_PLAUSIBLE_PROPERTY_PRICE,
} from "@/lib/domain/opportunity/stage-advance-guard.js";
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

const event = (over = {}) => ({ amount: 210_000, source: "operator", operator_id: "op-1", at: "2026-10-06T12:00:00Z", opportunity_id: "o1", quote_type: "FORMAL_OFFER", ...over });

test("STRICT Offer: an automated move needs a real offer EVENT; current_offer > 0 alone is not enough", () => {
  const zero = evaluateStageAdvance({ current: opp(), to_stage: "offer", source: "seller_inbound_orchestrator" });
  assert.equal(zero.code, "OFFER_EVENT_REQUIRED");
  const bare = evaluateStageAdvance({ current: opp({ current_offer: 210_000 }), to_stage: "offer", source: "seller_autopilot" });
  assert.equal(bare.code, "OFFER_EVENT_REQUIRED", "a number on the row is not an offer event");
  const good = evaluateStageAdvance({ current: opp({ current_offer: 210_000, asking_price: 240_000 }), to_stage: "offer", source: "seller_autopilot", offer_events: [event()] });
  assert.equal(good.ok, true);
  for (const [field, over] of [["source", { source: "parsed_reply" }], ["operator_id", { operator_id: "" }], ["engine_version", { source: "engine", engine_version: null }], ["timestamp", { at: "not-a-date" }], ["deal_or_conversation_id", { opportunity_id: null, thread_key: null }], ["quote_type", { quote_type: "GUESS" }]]) {
    const r = evaluateStageAdvance({ current: opp(), to_stage: "offer", source: "seller_autopilot", offer_events: [event(over)] });
    assert.equal(r.code, "OFFER_EVENT_REQUIRED", field);
    assert.ok(r.guard.offer_events_seen[0].missing.includes(field), field);
  }
  for (const amount of [4100, 331, 2024, 0]) {
    assert.equal(evaluateStageAdvance({ current: opp(), to_stage: "offer", source: "seller_autopilot", offer_events: [event({ amount })] }).ok, false, `amount ${amount}`);
  }
  const ask331 = evaluateStageAdvance({ current: opp({ asking_price: 331, estimated_value: 220_000 }), to_stage: "offer", source: "seller_autopilot", offer_events: [event()] });
  assert.equal(ask331.code, "ASKING_PRICE_IMPLAUSIBLE");
  const year = evaluateStageAdvance({ current: opp({ asking_price: 2024 }), to_stage: "offer", source: "seller_autopilot", offer_events: [event()] });
  assert.equal(year.guard.ask_rule, "bare_year");
  assert.equal(evaluateStageAdvance({ current: opp(), to_stage: "offer", source: "operator" }).ok, true, "an operator decision is not a parse");
});

test("offer events from the canonical records: seller_offers rows and negotiation_quotes (anchor / observed operator offer)", () => {
  const so = offerEventFromSellerOffer({ offer_id: "offer:o1:v1", opportunity_id: "o1", thread_key: "+1", purchase_price: 132_000, status: "active", sent_at: "2026-09-30T15:30:00Z", metadata: { offer_event: { source: "operator", operator_id: "operator_unattributed", quote_type: "FORMAL_OFFER" } } });
  assert.equal(validateOfferEvent(so).valid, true);
  assert.equal(offerEventFromSellerOffer({ status: "withdrawn", sent_at: "2026-09-30T15:30:00Z", purchase_price: 1 }), null);
  const engine = offerEventFromSellerOffer({ offer_id: "offer:o1:v2", opportunity_id: "o1", purchase_price: 150_000, status: "active", sent_at: "2026-10-01T00:00:00Z", policy_version: "seller_offer_policy_v1", ade_snapshot_id: "s1", metadata: {} });
  assert.equal(engine.source, "engine");
  assert.equal(validateOfferEvent(engine, { valuation_mid: 200_000, mao: 160_000 }).valid, true);
  const anchor = offerEventFromQuote({ quote_key: "q1", quote_type: "anchor", amount: 185_000, engine_version: "ade_v3", quoted_at: "2026-10-06T00:00:00Z", thread_key: "+1" });
  assert.equal(anchor.quote_type, "NEGOTIATION_ANCHOR");
  assert.equal(validateOfferEvent(anchor).valid, true);
  const observedHigh = offerEventFromQuote({ quote_key: "observed_offer:m1", quote_type: "observed_offer", quote_source: "manual", extraction_confidence: "high", amount: 825_000, evidence: { offer_kind: "FORMAL_OFFER", operator_action_id: "act-9" }, quoted_at: "2026-10-07T02:06:00Z", thread_key: "+1" });
  assert.equal(validateOfferEvent(observedHigh).valid, true, "an unambiguous operator offer is an offer event");
  assert.equal(offerEventFromQuote({ quote_type: "observed_offer", quote_source: "manual", extraction_confidence: "medium", amount: 825_000, evidence: { offer_kind: "FORMAL_OFFER" } }), null, "ambiguous extraction → no event");
  assert.equal(offerEventFromQuote({ quote_type: "observed_offer", quote_source: "manual", extraction_confidence: "high", amount: 825_000, evidence: {} }), null, "unclassified wording → no event");
});

test("operator wording → quote type, on the 5 reconciled threads", () => {
  assert.equal(classifyOfferWording("Understood. I'm serious. Based on the property size, unit count, recent multifamily sales, and the current market, I'd be at $825,000 cash, which is $75,000 per unit. I can close quickly, purchase it as-is, and cover all closing costs with no fees to you. If that's in the range you'd consider, I can get a purchase agreement over right away."), "FORMAL_OFFER", "'in the range you'd consider' qualifies acceptance, not the \$825,000");
  assert.equal(classifyOfferWording("Hey Gale, this is Alex following up on 3635 Emerson Ave N. Are you interested in moving forward with my offer at $132,000 cash with a 7 day close, or did you have a different price in mind?"), "FORMAL_OFFER");
  assert.equal(classifyOfferWording("Entiendo. Gracias por la informacion. Si podemos cerrar en aproximadamente siete dias y nosotros cubrimos todos los costos de cierre, puedo ofrecer $55K. Si le funciona, preparo el contrato hoy mismo."), "FORMAL_OFFER", "'aproximadamente siete dias' hedges the closing time, not the \$55K");
  assert.equal(classifyOfferWording("I would be at $222K as-is, and can close in 7 days. Would that work for you?"), "FORMAL_OFFER");
  assert.equal(classifyOfferWording("I'm good to move forward at $315,000. I can send over the purchase agreement today and get everything moving toward closing. What's your best email?"), "FORMAL_OFFER");
  assert.equal(classifyOfferWording("I'd be at around $315K, close in 10 days."), "NEGOTIATION_ANCHOR");
  assert.equal(classifyOfferWording("The county has the property accessed at around $193K with an estimated $64,500 in repair cost."), "NEGOTIATION_ANCHOR", "value talk is never a formal offer");
  assert.equal(classifyOfferWording("Similar buildings nearby are trading between $60–85K a door"), "NEGOTIATION_ANCHOR");
  assert.equal(classifyOfferWording("Right, so $240K is the ARV, meaning that will be the price after it's fully updated. $240K X .75 = $180K - $40K in repairs put me at $140K"), "NEGOTIATION_ANCHOR");
  assert.equal(classifyOfferWording("What price did you have in mind?"), null);
});

test("E — asset-aware amounts: years / rents never prices; an engine offer stays inside the authority and valuation band", () => {
  assert.equal(assessOfferAmount(2024).rule, "bare_year");
  assert.equal(assessOfferAmount(1500).rule, "below_property_price_floor");
  assert.equal(assessOfferAmount(170_000, { source: "engine", mao: 160_000 }).rule, "above_authoritative_ceiling");
  assert.equal(assessOfferAmount(250_000, { source: "engine", valuation_mid: 200_000 }).rule, "outside_valuation_band");
  assert.equal(assessOfferAmount(20_000, { source: "engine", valuation_mid: 200_000 }).rule, "outside_valuation_band");
  assert.equal(assessOfferAmount(150_000, { source: "engine", valuation_mid: 200_000, mao: 160_000 }).plausible, true);
  assert.equal(assessOfferAmount(60_000, { units: 11 }).rule, "below_per_unit_floor");
  assert.equal(assessOfferAmount(825_000, { source: "operator", units: 11 }).plausible, true);
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
  assert.equal(r1.code, "OFFER_EVENT_REQUIRED");
  assert.equal(a.updates.length, 0, "nothing written");
  // 227876842: formal_contract with only a voided closing case.
  const b = fakeDb({ row: opp({ id: "o227", acquisition_stage: "offer", current_offer: 4100 }), cases: [{ closing_status: "not_scheduled", contract_status: "cancelled" }] });
  const r2 = await transitionOpportunityStage("o227", { to_stage: "formal_contract", source: "seller_inbound_orchestrator" }, { supabase: b });
  assert.equal(r2.code, "CONTRACT_EVENT_REQUIRED");
  assert.equal(r2.action_label, "Record contract to continue", "D: the refusal names the unblocking action");
  assert.ok(r2.open.startsWith("/closing-desk"));
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

test("transitionOpportunityStage: current_offer > 0 with no offer event stays put; a seller_offers event lets it move", async () => {
  const noEvent = fakeDb({ row: opp({ id: "o9", current_offer: 210_000 }) });
  const r = await transitionOpportunityStage("o9", { to_stage: "offer", source: "seller_inbound_orchestrator" }, { supabase: noEvent });
  assert.equal(r.code, "OFFER_EVENT_REQUIRED");
  const withEvent = fakeDb({ row: opp({ id: "o9", current_offer: 210_000 }), cases: [] });
  withEvent.from = ((orig) => (table) => {
    if (table !== "seller_offers") return orig(table);
    const chain = { select: () => chain, eq: () => chain, limit: async () => ({ data: [{ offer_id: "offer:o9:v1", opportunity_id: "o9", purchase_price: 210_000, status: "active", sent_at: "2026-10-06T00:00:00Z", metadata: { offer_event: { source: "operator", operator_id: "op-1", quote_type: "FORMAL_OFFER" } } }], error: null }) };
    return chain;
  })(withEvent.from);
  const ok = await transitionOpportunityStage("o9", { to_stage: "offer", source: "seller_inbound_orchestrator" }, { supabase: withEvent });
  assert.notEqual(ok.code, "OFFER_EVENT_REQUIRED", JSON.stringify(ok).slice(0, 200));
});
