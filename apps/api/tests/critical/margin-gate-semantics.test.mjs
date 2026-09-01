import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { scoreProperty } from "@/lib/acquisition/acquisitionDecisionEngine.js";
import { evaluateConcession, resolveNegotiationPolicy } from "@/lib/domain/seller-flow/negotiation-policy.js";

// MARGIN GATE SEMANTICS
//
// target_margin is an ASPIRATIONAL profit objective. It may drive offer
// construction, AOS scoring, opening posture and negotiation aggression, but it
// must NEVER double as a minimum-worthiness gate.
//
// Before this correction it did exactly that, in four places:
//   * AUTO_HARD_OFFER  assignment_fee_meets_target : fee >= target
//   * CREATIVE_TERMS   routing                     : fee <  target
//   * AUTO_RANGE_OFFER margin gate                 : fee >= target * 0.75
//   * cashViability                                : fee >= target * 0.75
//
// Two concrete pathologies that produced:
//   * a $400k deal whose OWN demandPremium shaved $2,700 off a $40,000
//     aspiration failed its own gate at $37,300 and was routed to creative;
//   * a genuinely excellent $25,000 fee on a $400k deal failed the hard gate,
//     the range gate AND cash viability -- a viable deal treated as invalid.
//
// Correct mapping:
//   "is this worth doing?"        -> minimum_margin   (tier gates, viability)
//   "did we hit the objective?"   -> target_margin    (AOS scoring)
//   "what does the opening keep?" -> protected_margin (offer clamp)
//   "what may we concede?"        -> minimum_margin   (negotiation floor)

const MINIMUM = 15_000;

// Drive the REAL engine with injected loaders so the fee lands where we want.
// The subject/comps are ordinary; only the ceiling scale is varied.
function subjectFor(estimatedValue) {
  return {
    property_id: "gate-subject",
    property_type: "Single Family",
    property_class: "Residential",
    property_address_zip: "75060",
    latitude: 32.81,
    longitude: -96.95,
    building_square_feet: 1500,
    total_bedrooms: 3,
    total_baths: 2,
    year_built: 1975,
    effective_year_built: 1975,
    lot_square_feet: 7000,
    units_count: 1,
    building_condition: "Average",
    construction_type: "Frame",
    estimated_value: estimatedValue,
    equity_percent: 100,
    total_loan_balance: 0,
    ownership_years: 15,
    market_status_label: "Off Market",
    structured_motivation_score: 0,
    tag_distress_score: 0,
    garage: "Attached Garage",
    pool: "No",
    air_conditioning: "Central",
    heating_type: "Central",
    sewer: "Yes",
    water: "Municipal",
    zoning: "Z324",
    flood_zone: "X",
    school_district_name: "Irving ISD",
    subdivision_name: "TEST",
    roof_cover: "Composition Shingle",
    exterior_walls: "Brick veneer",
  };
}

function compsAround(price, n = 12) {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    property_id: `c${i}`,
    property_address_full: `${100 + i} Test St`,
    property_address_zip: "75060",
    latitude: 32.811 + i * 0.0001,
    longitude: -96.951,
    property_type: "Single Family",
    property_class: "Residential",
    total_bedrooms: 3,
    total_baths: 2,
    building_square_feet: 1500,
    lot_square_feet: 7000,
    units_count: 1,
    year_built: 1975,
    effective_year_built: 1975,
    building_condition: "Average",
    construction_type: "Frame",
    sale_price: price + (i % 3) * 1000,
    sale_date: "2026-05-01",
    sale_source: i % 2 ? "mls_sold" : "public_record_sold",
    garage: "Attached Garage",
    pool: "No",
    air_conditioning: "Central",
    heating_type: "Central",
    sewer: "Yes",
    water: "Municipal",
    zoning: "Z324",
    flood_zone: "X",
    school_district_name: "Irving ISD",
    subdivision_name: "TEST",
    roof_cover: "Composition Shingle",
    exterior_walls: "Brick veneer",
    distance_miles: 0.2,
  }));
}

async function scoreWith({ compPrice, buyerPurchases = [] }) {
  const r = await scoreProperty("gate-subject", {
    loadSubjectProperty: async () => subjectFor(compPrice),
    loadComparableProperties: async () => compsAround(compPrice),
    loadBuyerPurchases: async () => buyerPurchases,
    persistAcquisitionScore: async (row) => row,
    persistImmutableScoreSnapshot: async () => null,
  });
  assert.equal(r.ok, true, `scoreProperty failed: ${r.error ?? ""}`);
  const s = r.score;
  const oc = s.evidence.offer_calculation;
  return {
    tier: s.decision_tier,
    aos: s.evidence.aos_breakdown.score,
    aosMargin: s.evidence.aos_breakdown.components.assignment_margin,
    gates: s.evidence.decision_tier_reasoning.hard_gate_checks,
    fee: s.expected_assignment_fee,
    ceiling: oc.effective_authorized_ceiling,
    target: oc.target_assignment_fee,
    minimum: oc.assignment_margin_floor,
    protectedMargin: oc.protected_margin,
    negotiable: oc.negotiable_margin,
    offer: s.recommended_cash_offer,
  };
}

// ── the invariants that must hold at every fee level ────────────────────────

test("gates never key off the aspirational target", async () => {
  const r = await scoreWith({ compPrice: 400_000 });
  assert.ok(
    "assignment_fee_meets_minimum_economics" in r.gates,
    "the hard gate is named for what it measures: minimum economics"
  );
  assert.ok(
    !("assignment_fee_meets_target" in r.gates),
    "no gate may assert the aspirational target as a minimum"
  );
});

test("a deal is viable when fee >= minimum even if it misses the target", async () => {
  const r = await scoreWith({ compPrice: 400_000 });
  // A large deal has a target well above the floor.
  assert.ok(r.target > r.minimum, "target is aspirational and above the floor");
  assert.ok(r.fee >= r.minimum, "fee clears the hard floor");
  assert.equal(
    r.gates.assignment_fee_meets_minimum_economics,
    true,
    "clearing the floor satisfies minimum economics regardless of the target"
  );
  assert.notEqual(r.tier, "NURTURE", "a deal above the floor is not discarded");
});

test("protected margin is enforced at every scale", async () => {
  for (const price of [120_000, 250_000, 400_000, 800_000]) {
    const r = await scoreWith({ compPrice: price });
    assert.ok(
      r.fee >= r.protectedMargin,
      `ceiling ${r.ceiling}: fee ${r.fee} fell below protected ${r.protectedMargin}`
    );
    assert.ok(r.offer <= r.ceiling, "offer never exceeds the authorized ceiling");
    assert.equal(r.fee, r.ceiling - r.offer, "fee is always ceiling minus offer");
  }
});

test("negotiable margin is fee minus the hard floor, never negative", async () => {
  for (const price of [120_000, 400_000, 800_000]) {
    const r = await scoreWith({ compPrice: price });
    assert.ok(r.negotiable >= 0, "negotiable margin cannot be negative");
    assert.equal(r.negotiable, Math.max(0, r.fee - r.minimum));
  }
});

test("AOS scores against the TARGET, so missing the objective costs score", async () => {
  // AOS answers "did we hit our profit objective?" -- the one legitimate use of
  // the aspirational target.
  const small = await scoreWith({ compPrice: 130_000 }); // floor governs target
  const large = await scoreWith({ compPrice: 800_000 }); // target well above floor
  assert.ok(large.target > large.minimum);
  assert.equal(small.target, small.minimum, "small deal: target collapses to the floor");
  // Both remain scored; the margin component is a ratio against the target.
  assert.ok(small.aosMargin > 0 && large.aosMargin > 0);
  assert.ok(large.aos >= 0 && small.aos >= 0);
});

test("the deal-specific target scales while the floor stays fixed", async () => {
  const small = await scoreWith({ compPrice: 130_000 });
  const large = await scoreWith({ compPrice: 800_000 });
  assert.equal(small.minimum, MINIMUM, "floor is invariant");
  assert.equal(large.minimum, MINIMUM, "floor is invariant");
  assert.ok(large.target > small.target, "target scales with the deal");
});

test("viability gates reproduce pre-refactor behaviour exactly", async () => {
  // minimum_margin equals the historic DEFAULT_TARGET_ASSIGNMENT_FEE, so the
  // gates are provably neither looser nor tighter than production was.
  for (const price of [130_000, 250_000, 400_000, 800_000]) {
    const r = await scoreWith({ compPrice: price });
    assert.equal(r.minimum, MINIMUM);
    assert.equal(
      r.gates.assignment_fee_meets_minimum_economics,
      r.fee >= MINIMUM,
      "gate is exactly fee >= 15,000, as before the dynamic target existed"
    );
  }
});

// ── negotiation walkaway is MINIMUM economics, not the raw ceiling ──────────

test("negotiation may NOT concede past the minimum margin", () => {
  const ceiling = 400_000;
  const initialOffer = ceiling - 40_000; // opening fee $40,000
  const p = resolveNegotiationPolicy({ asset_class: "sfr", reference_value: 450_000 });
  let latest = initialOffer;

  for (let turn = 0; turn < 5; turn += 1) {
    const c = evaluateConcession({
      negotiation_state: {
        authorized_offer_ceiling: ceiling,
        minimum_assignment_margin: MINIMUM,
        latest_offer: latest,
        initial_offer: initialOffer,
        current_asking_price: ceiling,
        initial_asking_price: ceiling,
        offers_made: turn,
      },
      policy: p,
      new_material_fact: true,
      seller_moved_amount: 20_000,
    });
    if (!c.allowed || c.amount === null) break;
    latest = c.amount;
    const fee = ceiling - latest;
    assert.ok(
      fee >= MINIMUM,
      `turn ${turn + 1}: fee ${fee} fell below the minimum margin ${MINIMUM}`
    );
    assert.ok(latest <= ceiling, "and never crosses the authorized ceiling");
  }
});

test("without a carried floor, concession behaviour is unchanged (opt-in)", () => {
  const ceiling = 400_000;
  const p = resolveNegotiationPolicy({ asset_class: "sfr", reference_value: 450_000 });
  const c = evaluateConcession({
    negotiation_state: {
      authorized_offer_ceiling: ceiling,
      latest_offer: 360_000,
      initial_offer: 360_000,
      current_asking_price: ceiling,
      initial_asking_price: ceiling,
      offers_made: 0,
    },
    policy: p,
    new_material_fact: true,
    seller_moved_amount: 20_000,
  });
  assert.equal(c.allowed, true);
  assert.equal(c.amount, 380_000, "legacy states keep the historic ceiling-bounded step");
});

test("a state already at the minimum-margin bound is final", () => {
  const ceiling = 400_000;
  const p = resolveNegotiationPolicy({ asset_class: "sfr", reference_value: 450_000 });
  const c = evaluateConcession({
    negotiation_state: {
      authorized_offer_ceiling: ceiling,
      minimum_assignment_margin: MINIMUM,
      latest_offer: ceiling - MINIMUM,
      initial_offer: 360_000,
      current_asking_price: ceiling,
      initial_asking_price: ceiling,
      offers_made: 1,
    },
    policy: p,
    new_material_fact: true,
    seller_moved_amount: 20_000,
  });
  assert.equal(c.allowed, false);
  assert.equal(c.reason_code, "MINIMUM_MARGIN_REACHED");
  assert.equal(c.is_final, true);
});
