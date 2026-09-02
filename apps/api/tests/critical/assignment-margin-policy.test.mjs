import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveTargetAssignmentMargin,
  resolveConcessionFloor,
  ASSIGNMENT_MARGIN_POLICY_VERSION,
} from "@/lib/acquisition/assignmentMarginPolicy.js";
import { MARGIN_MAX_PCT } from "@/lib/acquisition/modelConstants.js";
import { evaluateConcession, resolveNegotiationPolicy } from "@/lib/domain/seller-flow/negotiation-policy.js";

// DEAL-AWARE PROFIT PRESERVATION
//
// The flat $15,000 DEFAULT_TARGET_ASSIGNMENT_FEE made the expected assignment
// fee ~$15k + ~1% of ceiling for EVERY deal, so preserved margin collapsed as
// deals grew: 15.9% of ceiling at $100k, 6.9% at $250k, 2.9% at $750k, 2.1% at
// $1.2M. $15,000 is a MINIMUM/target concept and must never behave as a cap.

const FLOOR = 15_000;
const policy = (over = {}) =>
  resolveTargetAssignmentMargin({
    effective_authorized_ceiling: 250_000,
    asset_family: "RESIDENTIAL_SINGLE",
    buyer_demand_score: 55,
    liquidity_score: 55,
    valuation_confidence: 82,
    buyer_ceiling_authoritative: true,
    minimum_margin_floor: FLOOR,
    ...over,
  });

// ── the fee is not capped at $15,000 ────────────────────────────────────────

test("assignment margin is NOT capped at $15,000", () => {
  for (const ceiling of [250_000, 400_000, 750_000, 1_500_000]) {
    const p = policy({ effective_authorized_ceiling: ceiling });
    assert.ok(
      p.target_margin > FLOOR,
      `ceiling ${ceiling} must target more than the floor (got ${p.target_margin})`
    );
  }
});

test("a high-spread deal targets substantially more than $15,000", () => {
  const p = policy({ effective_authorized_ceiling: 750_000 });
  assert.equal(p.target_margin, 75_000, "10% of a $750k ceiling");
  assert.ok(p.target_margin >= 5 * FLOOR, "materially more than the old flat target");
});

test("margin scales with the deal instead of staying flat in dollars", () => {
  const small = policy({ effective_authorized_ceiling: 250_000 }).target_margin;
  const large = policy({ effective_authorized_ceiling: 750_000 }).target_margin;
  assert.ok(large > small, "bigger deals preserve more profit");
  assert.ok(large / small > 2, "and materially so, not a token increase");
});

// ── small deals are not killed ──────────────────────────────────────────────

test("a thin but worthwhile deal is not killed: the floor governs, unchanged", () => {
  const p = policy({ effective_authorized_ceiling: 100_000 });
  assert.equal(p.target_margin, FLOOR, "small deal keeps exactly the existing floor");
  assert.equal(p.minimum_margin, FLOOR);
  assert.ok(p.reasons.includes("minimum_floor_governs_small_deal"));
});

test("the policy can never target LESS than the incoming floor", () => {
  // Guarantees no deal becomes easier to approve than it is today.
  for (const ceiling of [40_000, 80_000, 100_000, 150_000, 250_000, 900_000]) {
    for (const demand of [10, 55, 95]) {
      const p = policy({ effective_authorized_ceiling: ceiling, buyer_demand_score: demand });
      assert.ok(
        p.target_margin >= FLOOR,
        `ceiling ${ceiling} demand ${demand} produced ${p.target_margin} < floor`
      );
    }
  }
});

// ── margin never expands acquisition authority ──────────────────────────────

test("protected margin NEVER increases the authorized ceiling", () => {
  const ceiling = 250_000;
  const p = policy({ effective_authorized_ceiling: ceiling });
  assert.equal(p.inputs.effective_authorized_ceiling, ceiling, "ceiling is an input, never an output");
  assert.ok(p.max_available_margin <= ceiling, "even the max stays inside the ceiling");
  assert.ok(p.target_margin < ceiling, "target is room INSIDE the ceiling");
  // The policy exposes no field that could raise authority.
  assert.deepEqual(
    Object.keys(p).filter((k) => /ceiling/.test(k)),
    [],
    "policy must not emit any ceiling-like output"
  );
});

test("a seller offer built from the policy cannot exceed the effective ceiling", () => {
  for (const ceiling of [100_000, 250_000, 750_000]) {
    const p = policy({ effective_authorized_ceiling: ceiling });
    const offer = ceiling - p.target_margin;
    assert.ok(offer <= ceiling, "offer stays within authority");
    assert.ok(offer > 0, "and remains a real offer");
    assert.equal(ceiling - offer, p.target_margin, "fee is ceiling minus offer, by construction");
  }
});

// ── contaminated buyer behavior cannot inflate margin authority ─────────────

test("UNDEFENDED buyer behavior cannot move the margin in either direction", () => {
  const defendedWeak = policy({ buyer_demand_score: 10, buyer_ceiling_authoritative: true });
  const undefendedWeak = policy({ buyer_demand_score: 10, buyer_ceiling_authoritative: false });
  const undefendedStrong = policy({ buyer_demand_score: 95, buyer_ceiling_authoritative: false });

  assert.ok(
    defendedWeak.margin_pct > undefendedWeak.margin_pct,
    "defended weak demand legitimately widens margin"
  );
  assert.equal(
    undefendedWeak.margin_pct,
    undefendedStrong.margin_pct,
    "undefended demand is ignored regardless of its value"
  );
  assert.ok(undefendedWeak.reasons.includes("buyer_demand_ignored_undefended_buyer_evidence"));
});

test("a contaminated buyer ceiling cannot be used as the margin base", () => {
  // The $1,699,400 behavior ceiling from the canary must be irrelevant: the
  // policy only ever sees the clamped effective ceiling.
  const p = policy({ effective_authorized_ceiling: 159_800 });
  assert.ok(p.target_margin <= 159_800 * MARGIN_MAX_PCT);
  assert.ok(p.target_margin < 1_699_400 * 0.04, "margin is nowhere near behavior-ceiling scale");
});

// ── the four quantities ─────────────────────────────────────────────────────

test("policy emits minimum / target / protected / max with a version and reasons", () => {
  const p = policy({ effective_authorized_ceiling: 400_000 });
  assert.equal(typeof p.minimum_margin, "number");
  assert.equal(typeof p.target_margin, "number");
  assert.equal(typeof p.protected_margin, "number");
  assert.equal(typeof p.max_available_margin, "number");
  assert.equal(p.policy_version, ASSIGNMENT_MARGIN_POLICY_VERSION);
  assert.ok(Array.isArray(p.reasons) && p.reasons.length > 0, "human-readable evidence");
  assert.ok(p.minimum_margin <= p.target_margin, "minimum <= target");
  assert.ok(p.target_margin <= p.max_available_margin, "target <= max available");
});

test("evidence quality moves the margin in the defensible direction", () => {
  const thin = policy({ effective_authorized_ceiling: 400_000, valuation_confidence: 60, buyer_demand_score: 25 });
  const strong = policy({ effective_authorized_ceiling: 400_000, valuation_confidence: 90, buyer_demand_score: 85 });
  assert.ok(
    thin.target_margin > strong.target_margin,
    "weaker evidence preserves more cushion; stronger evidence can price tighter"
  );
});

test("no authorized ceiling => no margin authority", () => {
  for (const ceiling of [null, 0, -1, undefined]) {
    const p = resolveTargetAssignmentMargin({ effective_authorized_ceiling: ceiling });
    assert.equal(p.max_available_margin, 0);
    assert.ok(p.reasons.includes("no_authorized_ceiling"));
  }
});

// ── negotiation: concede margin without crossing the ceiling ────────────────

test("negotiation may concede margin but never crosses the authorized ceiling", () => {
  const ceiling = 250_000;
  const p = policy({ effective_authorized_ceiling: ceiling });
  const initialOffer = ceiling - p.target_margin;

  const negotiationPolicy = resolveNegotiationPolicy({ asset_class: "sfr", reference_value: 300_000 });
  let latest = initialOffer;
  for (let turn = 0; turn < 3; turn += 1) {
    const c = evaluateConcession({
      negotiation_state: {
        authorized_offer_ceiling: ceiling,
        latest_offer: latest,
        initial_offer: initialOffer,
        current_asking_price: 260_000,
        initial_asking_price: 260_000,
        offers_made: turn,
      },
      policy: negotiationPolicy,
      new_material_fact: true,
      seller_moved_amount: 15_000,
    });
    if (!c.allowed || c.amount === null) break;
    assert.ok(c.amount <= ceiling, `turn ${turn}: concession ${c.amount} exceeded ceiling`);
    assert.ok(c.amount > latest, "each concession moves toward the seller");
    latest = c.amount;
  }
  assert.ok(latest <= ceiling, "final position never exceeds the ceiling");
  assert.ok(latest > initialOffer, "margin was genuinely conceded");
});

test("concession works from the REALIZED fee and never drops below the minimum", () => {
  const p = policy({ effective_authorized_ceiling: 750_000 });
  const realizedFee = 75_450; // what the offer actually preserved

  const start = resolveConcessionFloor(p, 0, realizedFee);
  assert.equal(start.starting_margin, realizedFee, "negotiation concedes the ACTUAL fee, not the aspiration");
  assert.equal(start.negotiable_margin, realizedFee - p.minimum_margin);
  assert.equal(start.may_concede, true);

  const deep = resolveConcessionFloor(p, realizedFee, realizedFee);
  assert.equal(deep.remaining_margin, p.minimum_margin, "cannot concede past the minimum");
  assert.equal(deep.may_concede, false);

  const past = resolveConcessionFloor(p, realizedFee * 10, realizedFee);
  assert.equal(past.remaining_margin, p.minimum_margin, "over-concession clamps at the minimum");
});

// ── target is ASPIRATIONAL; protected is ENFORCED ───────────────────────────

test("SEMANTICS: target_margin is aspirational, protected_margin is the enforced floor", () => {
  const p = policy({ effective_authorized_ceiling: 400_000 });
  assert.ok(p.target_margin > p.protected_margin, "target aims higher than the enforced floor");
  assert.equal(p.protected_margin, p.minimum_margin, "V1 protects exactly the hard floor");
});

test("market adjustments may undercut TARGET but never PROTECTED", () => {
  // Small, very-high-demand deal: demandPremium pushes the market-adjusted offer
  // ABOVE (ceiling - target), which is exactly how target gets eaten.
  const ceiling = 100_000;
  const p = resolveTargetAssignmentMargin({
    effective_authorized_ceiling: ceiling,
    asset_family: "RESIDENTIAL_SINGLE",
    buyer_demand_score: 100,
    liquidity_score: 100,
    valuation_confidence: 100,
    buyer_ceiling_authoritative: true,
    minimum_margin_floor: FLOOR,
    market_adjustments_applied_by_caller: true,
  });
  const h = 0;
  const demandPremium = ((100 + 100) / 200) * 0.015;
  const marketAdjusted = ceiling * (1 - h + demandPremium) - p.target_margin;
  const cap = ceiling - p.protected_margin;

  assert.ok(marketAdjusted > cap, "without the clamp the fee would fall below protected");
  const offer = Math.min(marketAdjusted, cap);
  const fee = ceiling - offer;
  assert.ok(fee >= p.protected_margin, "clamped: realized fee never below protected margin");
  assert.equal(fee, p.protected_margin, "clamp binds exactly at the protected floor");
});

// ── no double counting of demand / confidence ───────────────────────────────

test("DOUBLE-COUNT GUARD: caller-applied mode omits demand and confidence", () => {
  const base = { effective_authorized_ceiling: 400_000, asset_family: "RESIDENTIAL_SINGLE", minimum_margin_floor: FLOOR, buyer_ceiling_authoritative: true };
  const strong = resolveTargetAssignmentMargin({ ...base, buyer_demand_score: 95, valuation_confidence: 95, market_adjustments_applied_by_caller: true });
  const weak = resolveTargetAssignmentMargin({ ...base, buyer_demand_score: 10, valuation_confidence: 55, market_adjustments_applied_by_caller: true });

  assert.equal(
    strong.margin_pct,
    weak.margin_pct,
    "when the caller models demand/confidence, the policy must not re-apply them"
  );
  assert.ok(strong.reasons.includes("market_adjustments_applied_by_caller"));
  assert.ok(!strong.reasons.some((r) => /demand|confidence|valuation_evidence/.test(r)));
});

test("DOUBLE-COUNT GUARD: standalone mode still applies demand and confidence once", () => {
  const base = { effective_authorized_ceiling: 400_000, asset_family: "RESIDENTIAL_SINGLE", minimum_margin_floor: FLOOR, buyer_ceiling_authoritative: true };
  const strong = resolveTargetAssignmentMargin({ ...base, buyer_demand_score: 95, valuation_confidence: 95 });
  const weak = resolveTargetAssignmentMargin({ ...base, buyer_demand_score: 10, valuation_confidence: 55 });
  assert.ok(weak.margin_pct > strong.margin_pct, "standalone callers still get market sensitivity");
});

test("structural signals (family, deal size) survive caller-applied mode", () => {
  const opts = { asset_family: "RESIDENTIAL_SINGLE", minimum_margin_floor: FLOOR, market_adjustments_applied_by_caller: true };
  const mid = resolveTargetAssignmentMargin({ ...opts, effective_authorized_ceiling: 400_000 });
  const large = resolveTargetAssignmentMargin({ ...opts, effective_authorized_ceiling: 1_200_000 });
  assert.ok(large.margin_pct < mid.margin_pct, "large-deal narrowing is structural, not a market adjustment");
  const mf = resolveTargetAssignmentMargin({ ...opts, effective_authorized_ceiling: 400_000, asset_family: "MULTIFAMILY" });
  assert.ok(mf.margin_pct < mid.margin_pct, "asset family still differentiates");
});
