import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  NEGOTIATION_ZONES,
  resolveNegotiationPolicy,
  classifyNegotiationZone,
  resolveMarginProtectedCeiling,
  evaluateConcession,
} from "@/lib/domain/seller-flow/negotiation-policy.js";
import { applyNegotiationTurn } from "@/lib/domain/seller-flow/negotiation-state.js";
import {
  NEGOTIATION_STRATEGIES as S,
  routeNegotiationStrategy,
} from "@/lib/domain/seller-flow/negotiation-strategy-router.js";

// MINIMUM-MARGIN NEGOTIATION BOUND (supersprint §8, P0 #4).
//
// NEVER CROSS CANONICAL MAXIMUM SPEND OR MINIMUM ASSIGNMENT-MARGIN ECONOMICS.
//
// The authorized ceiling is GROSS. The concession ladder already stops at
// (ceiling - minimum_margin); before this slice the three DIRECT monetary
// paths did not: the final authorized offer routed the raw ceiling (a zero-fee
// deal), and both accept-the-seller paths accepted any ask/counter at or below
// the raw ceiling -- including asks INSIDE the margin band. These tests are
// adversarial: a seller probing the band, repeatedly asking above the ceiling,
// tiny and massive movement, and the no-margin regression guard.

const CEILING = 90000;
const MIN_MARGIN = 15000;
const PROTECTED = CEILING - MIN_MARGIN; // 75000

// ADE-consistent fixture: the recommendation already sits below the protected
// ceiling, exactly as the production ADE clamps it.
const ADE_WITH_MARGIN = Object.freeze({
  recommended_cash_offer: 70000,
  minimum_acceptable_offer: 60000,
  valuation_mid: 130000,
  valuation_confidence: 0.8,
  comp_count: 5,
  evidence: {
    offer_calculation: {
      valuation_based_ceiling: CEILING,
      effective_authorized_ceiling: CEILING,
      behavior_based_ceiling: CEILING,
      buyer_ceiling_authoritative: true,
      assignment_margin_floor: MIN_MARGIN,
    },
  },
});

// Same economics with NO margin carried: the pre-slice contract.
const ADE_NO_MARGIN = Object.freeze({
  ...ADE_WITH_MARGIN,
  recommended_cash_offer: 80000,
  evidence: { offer_calculation: { ...ADE_WITH_MARGIN.evidence.offer_calculation, assignment_margin_floor: undefined } },
});

const POLICY = resolveNegotiationPolicy({ asset_class: "sfr", reference_value: 130000 });

function stateWith({ ask = null, ade = ADE_WITH_MARGIN, extra = {} } = {}) {
  const base = applyNegotiationTurn(null, {
    price_signal: ask ? { asking_price: { value: ask, price_type: "exact", confidence: 0.9 }, is_counter: false } : null,
    ade_snapshot: ade,
    now: "2026-09-01T00:00:00.000Z",
  });
  return { ...base, ...extra };
}

function zoneFor(state) {
  return classifyNegotiationZone({
    current_ask: state.current_asking_price,
    recommended_offer: state.recommended_offer,
    authorized_offer_ceiling: state.authorized_offer_ceiling,
    valuation_confidence: state.comp_confidence,
    asking_price_confidence: state.asking_price_confidence,
    policy: POLICY,
  });
}

const route = (state, over = {}) =>
  routeNegotiationStrategy({ zone: zoneFor(state), state, policy: POLICY, sufficiency: { sufficient: true }, ...over });

// ── the shared definition ────────────────────────────────────────────────────

test("one definition of the margin-protected ceiling, opt-in on the state", () => {
  const withMargin = resolveMarginProtectedCeiling(stateWith({ ask: 80000 }));
  assert.equal(withMargin.ceiling, CEILING);
  assert.equal(withMargin.minimum_margin, MIN_MARGIN);
  assert.equal(withMargin.protected_ceiling, PROTECTED);
  assert.equal(withMargin.margin_bound_active, true);

  const noMargin = resolveMarginProtectedCeiling(stateWith({ ask: 80000, ade: ADE_NO_MARGIN }));
  assert.equal(noMargin.protected_ceiling, CEILING, "no margin -> raw ceiling");
  assert.equal(noMargin.margin_bound_active, false);

  // a margin that swallows the whole ceiling is nonsense and is ignored, not obeyed
  const absurd = resolveMarginProtectedCeiling({ authorized_offer_ceiling: 1000, minimum_assignment_margin: 5000 });
  assert.equal(absurd.protected_ceiling, 1000);
  assert.equal(absurd.margin_bound_active, false);
});

test("the state carries the minimum margin from the ADE snapshot", () => {
  assert.equal(stateWith({ ask: 80000 }).minimum_assignment_margin, MIN_MARGIN);
  assert.equal(stateWith({ ask: 80000, ade: ADE_NO_MARGIN }).minimum_assignment_margin ?? null, null);
});

// ── ask-within-authority accept honors the margin ────────────────────────────

test("an ask INSIDE the margin band is NOT accepted (it would leave < minimum margin)", () => {
  const state = stateWith({ ask: 80000 }); // 75000 < 80000 <= 90000
  assert.equal(zoneFor(state).zone, NEGOTIATION_ZONES.WITHIN_AUTHORITY, "raw zone still says within authority");
  const d = route(state);
  assert.notEqual(d.strategy, S.ACCEPT_SELLER_TERMS, "must not accept inside the margin band");
  if (d.monetary?.amount != null) {
    assert.ok(d.monetary.amount <= PROTECTED, `authorized ${d.monetary.amount} must be <= protected ${PROTECTED}`);
  }
  assert.ok(d.eligibility_trace.some((t) => t.reason === "ask_inside_minimum_margin_band"));
});

test("an ask AT the protected ceiling is accepted at that ask", () => {
  const d = route(stateWith({ ask: PROTECTED }));
  assert.equal(d.strategy, S.ACCEPT_SELLER_TERMS);
  assert.equal(d.monetary.amount, PROTECTED);
  assert.equal(d.monetary.margin_protected_ceiling, PROTECTED);
});

test("an ask BELOW the protected ceiling is accepted at THEIR price", () => {
  const d = route(stateWith({ ask: 70000 }));
  assert.equal(d.strategy, S.ACCEPT_SELLER_TERMS);
  assert.equal(d.monetary.amount, 70000);
});

// ── final authorized offer is the protected ceiling, never the raw one ───────

test("the FINAL authorized offer is (ceiling - minimum margin), not the raw ceiling", () => {
  const state = stateWith({
    ask: 95000,
    extra: {
      initial_offer: 70000,
      latest_offer: PROTECTED,
      offers_made: [{ amount: 70000, strategy: S.INITIAL_OFFER }, { amount: PROTECTED, strategy: S.COUNTER_OFFER }],
    },
  });
  const d = route(state);
  assert.equal(d.strategy, S.FINAL_AUTHORIZED_OFFER);
  assert.equal(d.monetary.amount, PROTECTED, "final offer must keep the minimum margin");
  assert.notEqual(d.monetary.amount, CEILING, "never the raw ceiling");
});

test("the ladder's MINIMUM_MARGIN_REACHED verdict counts as exhaustion", () => {
  const state = stateWith({
    ask: 95000,
    extra: { initial_offer: 70000, latest_offer: PROTECTED, offers_made: [{ amount: PROTECTED, strategy: S.COUNTER_OFFER }] },
  });
  const concession = evaluateConcession({ negotiation_state: state, policy: POLICY, seller_moved_amount: 10000 });
  assert.equal(concession.allowed, false);
  assert.equal(concession.reason_code, "MINIMUM_MARGIN_REACHED");
  const d = route(state, { seller_moved_amount: 10000 });
  assert.equal(d.strategy, S.FINAL_AUTHORIZED_OFFER);
  assert.equal(d.monetary.amount, PROTECTED);
});

// ── counter accept honors the margin ─────────────────────────────────────────

test("a seller COUNTER inside the margin band is NOT accepted", () => {
  const state = stateWith({ ask: 100000, extra: { initial_offer: 70000, latest_offer: 70000, offers_made: [{ amount: 70000, strategy: S.INITIAL_OFFER }] } });
  const d = route(state, { engine_decision: { counter_offer: 80000 } });
  assert.notEqual(d.reason_code, "COUNTER_WITHIN_AUTHORITY_ACCEPT");
  if (d.monetary?.amount != null) assert.ok(d.monetary.amount <= PROTECTED);
  assert.ok(d.eligibility_trace.some((t) => t.reason === "counter_inside_minimum_margin_band"));
});

test("a seller COUNTER at or below the protected ceiling is accepted at the counter", () => {
  const state = stateWith({ ask: 100000, extra: { initial_offer: 70000, latest_offer: 70000, offers_made: [{ amount: 70000, strategy: S.INITIAL_OFFER }] } });
  const d = route(state, { engine_decision: { counter_offer: 74000 } });
  assert.equal(d.reason_code, "COUNTER_WITHIN_AUTHORITY_ACCEPT");
  assert.equal(d.monetary.amount, 74000);
});

// ── adversarial sweeps ───────────────────────────────────────────────────────

test("ADVERSARIAL: no strategy ever authorizes above the protected ceiling, across the whole ask range", () => {
  for (let ask = 40000; ask <= 200000; ask += 2500) {
    const d = route(stateWith({ ask }));
    if (d.monetary?.amount != null) {
      assert.ok(d.monetary.amount <= PROTECTED, `ask=${ask} strategy=${d.strategy} authorized ${d.monetary.amount} > ${PROTECTED}`);
      assert.ok(d.monetary.amount <= ask, `ask=${ask} never offer more than the seller asked`);
    }
  }
});

test("ADVERSARIAL: a seller who repeatedly asks above the ceiling gets one final offer at the protected ceiling, then no more money", () => {
  let state = stateWith({ ask: 120000, extra: { initial_offer: 70000, latest_offer: PROTECTED, offers_made: [{ amount: 70000, strategy: S.INITIAL_OFFER }, { amount: PROTECTED, strategy: S.COUNTER_OFFER }] } });
  const first = route(state);
  assert.equal(first.strategy, S.FINAL_AUTHORIZED_OFFER);
  assert.equal(first.monetary.amount, PROTECTED);
  // The seller asks again, still above; the final offer was already made.
  state = { ...state, offers_made: [...state.offers_made, { amount: PROTECTED, strategy: S.FINAL_AUTHORIZED_OFFER }] };
  const second = route(state);
  assert.notEqual(second.strategy, S.FINAL_AUTHORIZED_OFFER);
  if (second.monetary?.amount != null) assert.ok(second.monetary.amount <= PROTECTED);
});

test("DEFENSE IN DEPTH: an inconsistent recommendation above the protected ceiling is clamped, never trusted", () => {
  const inconsistent = { ...ADE_WITH_MARGIN, recommended_cash_offer: 85000 }; // > protected 75000
  const d = route(stateWith({ ask: 100000, ade: inconsistent }));
  if (d.monetary?.amount != null) assert.ok(d.monetary.amount <= PROTECTED, `${d.strategy} authorized ${d.monetary.amount}`);
});

// ── regression guard: no margin carried -> exactly the prior contract ────────

test("REGRESSION GUARD: with no margin on the state, behaviour is exactly as before", () => {
  // ask equal to raw ceiling -> accepted at the ask (pinned pre-slice behaviour)
  const atCeiling = route(stateWith({ ask: CEILING, ade: ADE_NO_MARGIN }));
  assert.equal(atCeiling.strategy, S.ACCEPT_SELLER_TERMS);
  assert.equal(atCeiling.monetary.amount, CEILING);

  // final offer at the RAW ceiling when no margin is carried
  const exhausted = stateWith({
    ask: 95000, ade: ADE_NO_MARGIN,
    extra: { initial_offer: 80000, latest_offer: CEILING, offers_made: [{ amount: 80000, strategy: S.INITIAL_OFFER }, { amount: CEILING, strategy: S.COUNTER_OFFER }] },
  });
  const fin = route(exhausted);
  assert.equal(fin.strategy, S.FINAL_AUTHORIZED_OFFER);
  assert.equal(fin.monetary.amount, CEILING);
});
