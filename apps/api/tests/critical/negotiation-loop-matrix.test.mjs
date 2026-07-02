import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  NEGOTIATION_ZONES,
  resolveNegotiationPolicy,
  computeNegotiationGapMetrics,
  classifyNegotiationZone,
  evaluateConcession,
  evaluateUnderwritingSufficiency,
  resolveClosingTermPolicy,
  normalizeAssetClass,
  ASSET_CLASSES,
} from "@/lib/domain/seller-flow/negotiation-policy.js";
import {
  applyNegotiationTurn,
  createNegotiationState,
  evaluateContractReadiness,
  CONTRACT_READINESS,
} from "@/lib/domain/seller-flow/negotiation-state.js";
import {
  NEGOTIATION_STRATEGIES as S,
  routeNegotiationStrategy,
  evaluateNovationEligibility,
  evaluateSellerFinanceEligibility,
  STRATEGY_CONTRACTS,
} from "@/lib/domain/seller-flow/negotiation-strategy-router.js";
import { selectCredibleCompAnchor, screenCompForDisclosure } from "@/lib/domain/seller-flow/comp-anchor-policy.js";
import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { deriveNegotiationWorkflowEvents } from "@/lib/domain/seller-flow/persist-seller-transition.js";

const ADE = Object.freeze({
  recommended_cash_offer: 80000,
  minimum_acceptable_offer: 70000,
  investor_ceiling_mid: 90000,
  investor_ceiling_high: 95000,
  valuation_mid: 130000,
  valuation_confidence: 0.8,
  estimated_repairs: 20000,
  comp_count: 5,
  subject_to_score: 30,
  seller_finance_score: 40,
  novation_score: 40,
  best_strategy: "cash",
});

function stateWith({ ask = null, ade = ADE, extra = {} } = {}) {
  const base = applyNegotiationTurn(null, {
    price_signal: ask
      ? { asking_price: { value: ask, price_type: "exact", confidence: 0.9 }, is_counter: false }
      : null,
    ade_snapshot: ade,
    now: "2026-07-01T00:00:00.000Z",
  });
  return { ...base, ...extra };
}

function zoneFor(state, policy) {
  return classifyNegotiationZone({
    current_ask: state.current_asking_price,
    recommended_offer: state.recommended_offer,
    authorized_offer_ceiling: state.authorized_offer_ceiling,
    valuation_confidence: state.comp_confidence,
    asking_price_confidence: state.asking_price_confidence,
    policy,
  });
}

const POLICY = resolveNegotiationPolicy({ asset_class: "sfr", reference_value: 130000 });

// ─── §6 zones ────────────────────────────────────────────────────────────────

test("§6 zone: ask below authority ceiling → within_authority", () => {
  const z = zoneFor(stateWith({ ask: 85000 }), POLICY);
  assert.equal(z.zone, NEGOTIATION_ZONES.WITHIN_AUTHORITY);
});

test("§6 zone: ask equal to ceiling → within_authority", () => {
  const z = zoneFor(stateWith({ ask: 90000 }), POLICY);
  assert.equal(z.zone, NEGOTIATION_ZONES.WITHIN_AUTHORITY);
});

test("§6 zone: near gap", () => {
  const z = zoneFor(stateWith({ ask: 95000 }), POLICY);
  assert.equal(z.zone, NEGOTIATION_ZONES.NEAR_GAP);
});

test("§6 zone: moderate gap", () => {
  const z = zoneFor(stateWith({ ask: 115000 }), POLICY);
  assert.equal(z.zone, NEGOTIATION_ZONES.MODERATE_GAP);
});

test("§6 zone: extreme gap", () => {
  const z = zoneFor(stateWith({ ask: 300000 }), POLICY);
  assert.equal(z.zone, NEGOTIATION_ZONES.LARGE_GAP);
});

test("§6 zone: no authority → insufficient confidence, never a fabricated offer", () => {
  const z = zoneFor(stateWith({ ask: 100000, ade: null }), POLICY);
  assert.equal(z.zone, NEGOTIATION_ZONES.INSUFFICIENT_CONFIDENCE);
  assert.equal(z.reason_code, "NO_PERSISTED_AUTHORITY");
});

test("§6 zone: low valuation confidence → insufficient confidence", () => {
  const z = zoneFor(stateWith({ ask: 100000, ade: { ...ADE, valuation_confidence: 0.2 } }), POLICY);
  assert.equal(z.zone, NEGOTIATION_ZONES.INSUFFICIENT_CONFIDENCE);
});

test("§5 gap metrics are computed and persisted on the state", () => {
  const state = stateWith({ ask: 100000 });
  assert.equal(state.gap_metrics.absolute_gap, 20000);
  assert.equal(state.gap_metrics.gap_pct_of_ask, 20);
  assert.ok(Math.abs(state.gap_metrics.gap_pct_of_arv - 15.38) < 0.1);
  assert.equal(state.gap_metrics.remaining_authorized_movement, 10000);
  assert.equal(state.gap_metrics.expected_spread, 130000 - 20000 - 100000);
});

test("§5 zone thresholds are configurable per asset class, not one global number", () => {
  const sfr = resolveNegotiationPolicy({ asset_class: "sfr", reference_value: 150000 });
  const land = resolveNegotiationPolicy({ asset_class: "land", reference_value: 150000 });
  const highValue = resolveNegotiationPolicy({ asset_class: "sfr", reference_value: 800000 });
  assert.notEqual(sfr.near_gap_ceiling_factor, land.near_gap_ceiling_factor);
  assert.ok(highValue.near_gap_ceiling_factor < sfr.near_gap_ceiling_factor);
});

// ─── §6/§7 within authority: conditional accept, never squeeze by default ───

test("§7: ask below authority → accept seller terms at THEIR price, never our higher offer", () => {
  const state = stateWith({ ask: 75000 }); // recommended is 80k — never offer it
  const d = routeNegotiationStrategy({ zone: zoneFor(state, POLICY), state, policy: POLICY, sufficiency: { sufficient: true } });
  assert.equal(d.strategy, S.ACCEPT_SELLER_TERMS);
  assert.equal(d.monetary.amount, 75000);
  assert.ok(d.monetary.amount <= 75000, "never offer more than the seller asked");
});

test("§7: ask equal to ceiling → conditional accept at the ask", () => {
  const state = stateWith({ ask: 90000 });
  const d = routeNegotiationStrategy({ zone: zoneFor(state, POLICY), state, policy: POLICY, sufficiency: { sufficient: true } });
  assert.equal(d.strategy, S.ACCEPT_SELLER_TERMS);
  assert.equal(d.monetary.amount, 90000);
});

test("§6: single soft concession probe only when policy enables it (default off)", () => {
  const state = stateWith({ ask: 75000 });
  const probing = resolveNegotiationPolicy({ asset_class: "sfr", overrides: { single_concession_probe_enabled: true } });
  const probed = routeNegotiationStrategy({ zone: zoneFor(state, probing), state, policy: probing, sufficiency: { sufficient: true } });
  assert.equal(probed.strategy, S.FLEXIBILITY_PROBE);

  const defaultPolicy = resolveNegotiationPolicy({ asset_class: "sfr" });
  const accepted = routeNegotiationStrategy({ zone: zoneFor(state, defaultPolicy), state, policy: defaultPolicy, sufficiency: { sufficient: true } });
  assert.equal(accepted.strategy, S.ACCEPT_SELLER_TERMS);
});

// ─── §7 gap ladders ─────────────────────────────────────────────────────────

test("§7 near gap with no offer yet → initial ADE-authorized offer", () => {
  const state = stateWith({ ask: 95000 });
  const d = routeNegotiationStrategy({ zone: zoneFor(state, POLICY), state, policy: POLICY, sufficiency: { sufficient: true } });
  assert.equal(d.strategy, S.INITIAL_OFFER);
  assert.equal(d.monetary.amount, 80000);
  assert.ok(d.monetary.amount <= state.authorized_offer_ceiling);
});

test("§7 moderate gap missing occupancy → occupancy discovery before money", () => {
  const state = stateWith({ ask: 115000 });
  const d = routeNegotiationStrategy({
    zone: zoneFor(state, POLICY),
    state,
    policy: POLICY,
    sufficiency: { sufficient: false, next_discovery: "occupancy_status" },
  });
  assert.equal(d.strategy, S.OCCUPANCY_DISCOVERY);
  assert.equal(d.monetary, null, "discovery strategies carry no monetary authority");
});

test("§7 moderate gap with credible comp anchor → comp anchor before offer", () => {
  const state = stateWith({ ask: 115000 });
  const anchor = { eligible: true, anchor: { sale_price: 95000 }, authorized_statement: "A comparable property nearby sold for $95,000 recently." };
  const d = routeNegotiationStrategy({ zone: zoneFor(state, POLICY), state, policy: POLICY, sufficiency: { sufficient: true }, comp_anchor: anchor });
  assert.equal(d.strategy, S.COMP_ANCHOR);
});

test("§7 moderate gap sufficiency met, no anchor → conditional ADE-authorized offer", () => {
  const state = stateWith({ ask: 115000 });
  const d = routeNegotiationStrategy({ zone: zoneFor(state, POLICY), state, policy: POLICY, sufficiency: { sufficient: true } });
  assert.equal(d.strategy, S.CONDITIONAL_OFFER);
  assert.equal(d.monetary.amount, 80000);
});

test("§7 large gap without alternate signals → expectation reset, then nurture — no endless lowballs", () => {
  const state = stateWith({ ask: 300000 });
  const first = routeNegotiationStrategy({ zone: zoneFor(state, POLICY), state, policy: POLICY, sufficiency: { sufficient: true } });
  assert.equal(first.strategy, S.EXPECTATION_RESET);

  const after = { ...state, prior_strategies: [{ strategy: S.EXPECTATION_RESET }] };
  const second = routeNegotiationStrategy({ zone: zoneFor(after, POLICY), state: after, policy: POLICY, sufficiency: { sufficient: true } });
  assert.equal(second.strategy, S.FUTURE_NURTURE);
  assert.equal(second.follow_up?.create, true);
});

test("§7 high-value asset with large gap → human review, not a drip", () => {
  const bigAde = { ...ADE, valuation_mid: 900000, recommended_cash_offer: 600000, investor_ceiling_mid: 650000 };
  const state = stateWith({ ask: 2000000, ade: bigAde });
  const policy = resolveNegotiationPolicy({ asset_class: "sfr", reference_value: 900000 });
  const d = routeNegotiationStrategy({ zone: zoneFor(state, policy), state, policy, sufficiency: { sufficient: true }, property_value: 900000 });
  assert.equal(d.strategy, S.HUMAN_REVIEW);
  assert.equal(d.review_required, true);
});

// ─── §13 concession ladder ──────────────────────────────────────────────────

test("§13: rejection alone never authorizes a concession", () => {
  const state = stateWith({ ask: 95000, extra: { latest_offer: 80000, initial_offer: 80000, offers_made: [{ amount: 80000 }] } });
  const c = evaluateConcession({ negotiation_state: state, policy: POLICY });
  assert.equal(c.allowed, false);
  assert.equal(c.reason_code, "NO_QUALIFYING_MOVEMENT_OR_FACT");
});

test("§13: seller movement authorizes a bounded concession that never exceeds ceiling or ask", () => {
  const state = stateWith({ ask: 95000, extra: { latest_offer: 80000, initial_offer: 80000, offers_made: [{ amount: 80000 }] } });
  const c = evaluateConcession({ negotiation_state: state, policy: POLICY, seller_moved_amount: 10000 });
  assert.equal(c.allowed, true);
  assert.ok(c.amount > 80000);
  assert.ok(c.amount <= 90000);
  assert.ok(c.amount <= 95000);
});

test("§13: ceiling reached → final, no further movement", () => {
  const state = stateWith({ ask: 95000, extra: { latest_offer: 90000, initial_offer: 80000, offers_made: [{ amount: 80000 }, { amount: 90000 }] } });
  const c = evaluateConcession({ negotiation_state: state, policy: POLICY, new_material_fact: true });
  assert.equal(c.allowed, false);
  assert.equal(c.is_final, true);
});

test("§13: max monetary turns respected", () => {
  const offers = [{ amount: 80000 }, { amount: 84000 }, { amount: 87000 }];
  const state = stateWith({ ask: 95000, extra: { latest_offer: 87000, initial_offer: 80000, offers_made: offers } });
  const c = evaluateConcession({ negotiation_state: state, policy: POLICY, new_material_fact: true });
  assert.equal(c.allowed, false);
  assert.equal(c.reason_code, "MAX_MONETARY_TURNS_REACHED");
});

test("§7: ceiling exhausted → final authorized offer once, then alternates/nurture", () => {
  const state = stateWith({ ask: 110000, extra: { latest_offer: 90000, initial_offer: 80000, offers_made: [{ amount: 80000 }, { amount: 90000 }] } });
  const first = routeNegotiationStrategy({ zone: zoneFor(state, POLICY), state, policy: POLICY, sufficiency: { sufficient: true } });
  assert.equal(first.strategy, S.FINAL_AUTHORIZED_OFFER);
  assert.equal(first.monetary.amount, 90000);

  const afterFinal = {
    ...state,
    offers_made: [...state.offers_made, { amount: 90000, strategy: S.FINAL_AUTHORIZED_OFFER }],
  };
  const second = routeNegotiationStrategy({ zone: zoneFor(afterFinal, POLICY), state: afterFinal, policy: POLICY, sufficiency: { sufficient: true } });
  assert.notEqual(second.strategy, S.FINAL_AUTHORIZED_OFFER);
  assert.ok([S.FUTURE_NURTURE, S.NOVATION_PROBE, S.SELLER_FINANCE_PROBE, S.HUMAN_REVIEW].includes(second.strategy));
});

// ─── §8 alternate strategies need positive signals ──────────────────────────

test("§8: novation requires positive signals — never merely because cash was rejected", () => {
  const state = stateWith({ ask: 300000 });
  const noSignal = evaluateNovationEligibility({ state, flags: {}, facts: {} });
  assert.equal(noSignal.eligible, false);
  assert.ok(noSignal.reasons.includes("no_positive_novation_signal"));
});

test("§8: novation eligible with seller signal + retail spread", () => {
  const ade = { ...ADE, novation_score: 70, valuation_mid: 140000 };
  const state = stateWith({ ask: 110000, ade });
  const e = evaluateNovationEligibility({ state, flags: { novation: true }, facts: {} });
  assert.equal(e.eligible, true);
});

test("§8: novation ineligible when no retail spread remains", () => {
  const state = stateWith({ ask: 129000, ade: { ...ADE, novation_score: 80 } });
  const e = evaluateNovationEligibility({ state, flags: { novation: true }, facts: {} });
  assert.equal(e.eligible, false);
  assert.ok(e.reasons.includes("no_retail_spread_remaining"));
});

test("§8: seller finance ineligible with insufficient equity", () => {
  const state = stateWith({ ask: 100000 });
  const e = evaluateSellerFinanceEligibility({ state, flags: { seller_finance: true }, facts: { mortgage_payoff: 95000 } });
  assert.equal(e.eligible, false);
  assert.ok(e.reasons.includes("insufficient_equity"));
});

test("§8: seller finance eligible with equity and seller openness", () => {
  const state = stateWith({ ask: 100000, ade: { ...ADE, seller_finance_score: 70 } });
  const e = evaluateSellerFinanceEligibility({ state, flags: { seller_finance: true }, facts: { mortgage_payoff: 20000 } });
  assert.equal(e.eligible, true);
});

test("§7: subject-to signal always routes to structured-terms review", () => {
  const state = stateWith({ ask: 95000 });
  const d = routeNegotiationStrategy({ zone: zoneFor(state, POLICY), state, policy: POLICY, sufficiency: { sufficient: true }, flags: { subject_to: true } });
  assert.equal(d.strategy, S.STRUCTURED_TERMS_REVIEW);
  assert.equal(d.review_required, true);
});

// ─── §2 state reducer invariants ────────────────────────────────────────────

test("§2: seller lowering price appends history and records concession — never overwrites", () => {
  const first = applyNegotiationTurn(null, {
    price_signal: { asking_price: { value: 120000, price_type: "exact", confidence: 0.9 }, is_counter: false },
    ade_snapshot: ADE,
    now: "2026-07-01T00:00:00.000Z",
  });
  const second = applyNegotiationTurn(first, {
    price_signal: { asking_price: { value: 100000, price_type: "exact", confidence: 0.9 }, is_counter: true },
    now: "2026-07-02T00:00:00.000Z",
  });
  assert.equal(second.initial_asking_price, 120000);
  assert.equal(second.current_asking_price, 100000);
  assert.equal(second.asking_price_history.length, 2);
  assert.equal(second.lowest_seller_indication, 100000);
  assert.equal(second.seller_concessions.length, 1);
  assert.equal(second.cumulative_concession_amount, 20000);
  assert.equal(second.seller_counters.length, 1);
  assert.equal(second.negotiation_round, 1);
  // First state untouched (no mutation).
  assert.equal(first.asking_price_history.length, 1);
});

test("§14: accepted terms lock the economics — accepted price never above seller ask", () => {
  const state = stateWith({ ask: 85000 });
  const accepted = applyNegotiationTurn(state, {
    strategy_decision: { strategy: "accept_seller_terms" },
    now: "2026-07-02T00:00:00.000Z",
  });
  assert.equal(accepted.terms_accepted, true);
  assert.equal(accepted.accepted_price, 85000, "must accept the ask, not our 90k ceiling or 80k+recommendation");
  assert.ok(accepted.terms_accepted_at);
  // Further price movement is ignored after lock.
  const afterLock = applyNegotiationTurn(accepted, {
    price_signal: { asking_price: { value: 99000, price_type: "exact", confidence: 0.9 }, is_counter: true },
    now: "2026-07-03T00:00:00.000Z",
  });
  assert.equal(afterLock.current_asking_price, 85000);
  assert.equal(afterLock.accepted_price, 85000);
});

test("§14: duplicate acceptance is suppressed", () => {
  const state = stateWith({ ask: 85000 });
  const once = applyNegotiationTurn(state, { strategy_decision: { strategy: "accept_seller_terms" } });
  const twice = applyNegotiationTurn(once, { strategy_decision: { strategy: "accept_seller_terms" } });
  assert.equal(twice.duplicate_acceptance_suppressed, true);
  assert.equal(twice.terms_accepted_at, once.terms_accepted_at);
});

test("§14: contract readiness requires the minimum contract facts", () => {
  const none = evaluateContractReadiness({});
  assert.equal(none.readiness, CONTRACT_READINESS.NOT_READY);

  const partial = evaluateContractReadiness({ signers_identified: true, seller_email: "a@b.com" });
  assert.equal(partial.readiness, CONTRACT_READINESS.COLLECTING);
  assert.ok(partial.unresolved_contract_fields.includes("vesting_confirmed"));

  const full = evaluateContractReadiness({
    signers_identified: true,
    seller_email: "a@b.com",
    vesting_confirmed: true,
    occupancy_access_confirmed: true,
    closing_timing_preference: "30_days",
  });
  assert.equal(full.readiness, CONTRACT_READINESS.READY);
  assert.equal(full.unresolved_contract_fields.length, 0);
});

test("§7: locked terms route to contract-information collection, not price talk", () => {
  const state = stateWith({ ask: 85000 });
  const locked = applyNegotiationTurn(state, { strategy_decision: { strategy: "accept_seller_terms" } });
  const d = routeNegotiationStrategy({ zone: zoneFor(locked, POLICY), state: locked, policy: POLICY, sufficiency: { sufficient: true } });
  assert.equal(d.strategy, S.ACCEPT_SELLER_TERMS);
  assert.equal(d.template_use_case, "contract_information_request");
  assert.equal(d.next_action, "collect_contract_facts");
});

test("§2: offers ledger enforces ceiling bookkeeping and records violations", () => {
  const state = stateWith({ ask: 95000 });
  const next = applyNegotiationTurn(state, {
    offer_execution: { queued: true, amount: 99000, template_use_case: "initial_offer", queue_row_id: "q-1" },
  });
  assert.equal(next.offers_made.length, 1);
  assert.equal(next.offers_made[0].within_authority, false, "amount above ceiling must be flagged");
});

// ─── §4 underwriting sufficiency ────────────────────────────────────────────

test("§4: SFR with reliable valuation skips unnecessary seller questions", () => {
  const s = evaluateUnderwritingSufficiency({ asset_class: "sfr", facts: { asking_price: { value: 100000 } }, ade_snapshot: ADE });
  assert.equal(s.sufficient, true);
});

test("§4: SFR without valuation needs occupancy + condition", () => {
  const s = evaluateUnderwritingSufficiency({ asset_class: "sfr", facts: { asking_price: { value: 100000 } }, ade_snapshot: null });
  assert.equal(s.sufficient, false);
  assert.ok(s.missing_facts.includes("occupancy_status"));
  assert.ok(s.missing_facts.includes("condition_summary"));
});

test("§4: 5+ multifamily requires rents", () => {
  const s = evaluateUnderwritingSufficiency({
    asset_class: "multi_5_plus",
    unit_count: 12,
    facts: { asking_price: { value: 900000 }, occupancy_status: "tenant_occupied", unit_count: 12 },
    ade_snapshot: ADE,
  });
  assert.equal(s.sufficient, false);
  assert.ok(s.missing_facts.includes("rents_summary"));
});

test("§4: commercial always routes to review", () => {
  const s = evaluateUnderwritingSufficiency({ asset_class: "commercial", facts: { asking_price: { value: 500000 } }, ade_snapshot: ADE });
  assert.ok(s.missing_facts.includes("commercial_review"));
});

// ─── §10 comp anchors ───────────────────────────────────────────────────────

const GOOD_COMP = {
  property_id: "comp-1",
  address: "12 Oak St",
  sale_price: 96000,
  sale_date: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString(),
  distance_miles: 0.4,
  comp_score: 80,
  comp_confidence: 0.8,
  source: "mls",
};

test("§10: credible lowest comp is selected with an exact authorized statement", () => {
  const result = selectCredibleCompAnchor({
    comps: [GOOD_COMP, { ...GOOD_COMP, property_id: "comp-2", sale_price: 120000 }],
    subject: { asset_class: "sfr" },
    valuation_mid: 130000,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.anchor.sale_price, 96000);
  assert.ok(result.authorized_statement.includes("$96,000"));
  assert.ok(!/similar condition/i.test(result.authorized_statement), "never claims similar condition");
});

test("§10: an invalid lowest sale is excluded — outliers, stale, distant, package", () => {
  const outlier = { ...GOOD_COMP, property_id: "c-low", sale_price: 40000 };
  const stale = { ...GOOD_COMP, property_id: "c-old", sale_date: new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString() };
  const far = { ...GOOD_COMP, property_id: "c-far", distance_miles: 8 };
  const pkg = { ...GOOD_COMP, property_id: "c-pkg", source: "portfolio_sale" };
  const result = selectCredibleCompAnchor({
    comps: [outlier, stale, far, pkg, GOOD_COMP],
    subject: { asset_class: "sfr" },
    valuation_mid: 130000,
  });
  assert.equal(result.anchor.comp_property_id, "comp-1");
  assert.equal(result.rejected.length, 4);
  assert.ok(result.rejected.find((r) => r.comp_property_id === "c-low").reasons.includes("outlier_below_valuation_band"));
});

test("§10: insufficient comp confidence yields no anchor at all", () => {
  const weak = { ...GOOD_COMP, comp_confidence: 0.3 };
  const result = selectCredibleCompAnchor({ comps: [weak], subject: { asset_class: "sfr" }, valuation_mid: 130000 });
  assert.equal(result.eligible, false);
  assert.equal(result.anchor, null);
});

test("§10: screening enforces per-asset-class distance rules", () => {
  const compAtTwoMiles = { ...GOOD_COMP, distance_miles: 2.0 };
  assert.equal(screenCompForDisclosure(compAtTwoMiles, { asset_class: "sfr" }).eligible, false);
  assert.equal(screenCompForDisclosure(compAtTwoMiles, { asset_class: "multi_2_4" }).eligible, true);
});

// ─── §11 closing-term policy ────────────────────────────────────────────────

test("§11: no asset class is ever promised a seven-day close", () => {
  for (const cls of Object.values(ASSET_CLASSES)) {
    const p = resolveClosingTermPolicy({ asset_class: cls });
    assert.ok(p.prohibited_claims.includes("seven_day_close"));
    assert.notEqual(p.timing_commitment, "seven_day");
  }
});

test("§11: probate/title issues and tenants change the timing commitment", () => {
  assert.equal(resolveClosingTermPolicy({ asset_class: "sfr", probate: true }).timing_commitment, "title_resolution_dependent");
  assert.equal(resolveClosingTermPolicy({ asset_class: "sfr", occupancy: "tenant_occupied" }).timing_commitment, "tenant_coordination_dependent");
  assert.equal(resolveClosingTermPolicy({ asset_class: "multi_5_plus" }).timing_commitment, "diligence_dependent");
});

test("§11: provider-safe language keys avoid repetitive cash wording", () => {
  const p = resolveClosingTermPolicy({ asset_class: "sfr" });
  assert.ok(p.language_keys.includes("purchase_directly"));
  assert.ok(p.language_keys.includes("purchase_as_is"));
  assert.ok(p.prohibited_claims.includes("cash_wording_repetition"));
});

// ─── stage monotonicity + multi-stage jumps with the resolver ───────────────

test("example 1: ownership + price in one S1 reply completes S1–S3, lands S4, runs preliminary ADE", () => {
  const t = resolveSellerStageTransition({
    stage_before: "ownership_confirmation",
    intent: "ownership_confirmed",
    new_facts: { asking_price: { value: 100000, confidence: 0.9 } },
    classification_confidence: 0.95,
  });
  assert.equal(t.stage_after, "property_condition");
  assert.equal(t.ade_action, "run_preliminary");
  assert.equal(t.required_template_use_case, "condition_probe");
});

test("example 3 + §14 via resolver: accepted terms resolve S5 and advance toward S6", () => {
  const t = resolveSellerStageTransition({
    stage_before: "offer",
    intent: "seller_interested",
    new_facts: {},
    known_facts: { ownership_status: "confirmed", asking_price: { value: 85000 }, occupancy_status: "vacant", condition_disclosed: true },
    negotiation_state: { terms_accepted: true },
    ade_result: { sufficient_facts: true, underwriting_ready: true },
    classification_confidence: 0.9,
  });
  assert.equal(t.stage_after, "formal_contract");
});

test("stage monotonicity: S5 price update never regresses to S3", () => {
  const t = resolveSellerStageTransition({
    stage_before: "offer",
    intent: "seller_counter",
    new_facts: { asking_price: { value: 110000, confidence: 0.9 } },
    known_facts: { ownership_status: "confirmed", occupancy_status: "vacant", condition_disclosed: true },
    ade_result: { sufficient_facts: true, underwriting_ready: true },
    classification_confidence: 0.9,
  });
  assert.equal(t.stage_after, "offer");
  assert.ok(t.stage_after_number >= 5);
});

// ─── §16 event derivation ───────────────────────────────────────────────────

test("§16: one accepted-terms turn derives capture, strategy, acceptance and contract events", () => {
  const prior = stateWith({ ask: 85000 });
  const next = applyNegotiationTurn(prior, {
    strategy_decision: { strategy: "accept_seller_terms", reason_code: "ASK_WITHIN_AUTHORITY_CONDITIONAL_ACCEPT" },
  });
  const events = deriveNegotiationWorkflowEvents({
    transition: { facts_patch: {} },
    negotiationState: next,
    previousState: prior,
    strategyDecision: { strategy: "accept_seller_terms", reason_code: "ASK_WITHIN_AUTHORITY_CONDITIONAL_ACCEPT", monetary: { amount: 85000 } },
  });
  assert.ok(events.includes("strategy_selected"));
  assert.ok(events.includes("terms_accepted"));
  assert.ok(events.includes("contract_information_requested"));
  assert.ok(events.includes("offer_authorized"));
});

test("§16: price capture + underwriting turn derives the right events", () => {
  const next = stateWith({ ask: 100000 });
  const events = deriveNegotiationWorkflowEvents({
    transition: { facts_patch: {} },
    negotiationState: next,
    previousState: null,
    adeSnapshot: ADE,
  });
  assert.ok(events.includes("asking_price_captured"));
  assert.ok(events.includes("underwriting_completed"));
});

// ─── §7 contract completeness ───────────────────────────────────────────────

test("§7: every strategy contract declares templates, facts, prohibitions, next action and stage outcome", () => {
  for (const [name, contract] of Object.entries(STRATEGY_CONTRACTS)) {
    assert.ok(Array.isArray(contract.template_use_cases), `${name} templates`);
    assert.ok(Array.isArray(contract.required_facts), `${name} required facts`);
    assert.ok(Array.isArray(contract.prohibited), `${name} prohibited`);
    assert.ok(typeof contract.monetary_allowed === "boolean", `${name} monetary flag`);
    assert.ok(contract.next_action, `${name} next action`);
    assert.ok(contract.stage_outcome, `${name} stage outcome`);
  }
});

test("§7: every routed decision carries exactly one strategy and a next action", () => {
  const scenarios = [
    stateWith({ ask: 75000 }),
    stateWith({ ask: 95000 }),
    stateWith({ ask: 115000 }),
    stateWith({ ask: 300000 }),
    stateWith({ ask: 100000, ade: null }),
  ];
  for (const state of scenarios) {
    const d = routeNegotiationStrategy({ zone: zoneFor(state, POLICY), state, policy: POLICY, sufficiency: { sufficient: true } });
    assert.ok(Object.values(S).includes(d.strategy));
    assert.ok(d.next_action, `strategy ${d.strategy} must always produce a next action`);
    assert.ok(d.reason_code);
  }
});
