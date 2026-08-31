import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveValuationSpendability,
  resolveNonSpendableNextAction,
  resolveV3ContaminationDefense,
  OFFER_AUTHORITATIVE_TIERS,
  MAD_MIN_COMP_COUNT,
  NON_SPENDABLE_REASONS,
} from "@/lib/domain/seller-flow/valuation-offer-authority.js";
import { qualifyComps } from "@/lib/acquisition/transactionQualification.js";
import { resolveAuthorizedOfferAmount } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { persistActiveOffer } from "@/lib/domain/seller-flow/seller-offer-authority.js";

// Valuation -> offer authority gate.
//
// Pinned production defect (canaryprop_6bb8a464…, 2026-08-03): a null-featured
// subject valued off 2 raw-price comps — one carrying $19,032,220 of
// package/portfolio consideration — produced recommended_cash_offer
// $10,969,000 at decision_tier=REVIEW_REQUIRED, confidence=31,
// valuation_confidence=36. The only guard was a ceiling (investor_ceiling_mid
// $19,070,400) derived from the SAME contaminated valuation, so it validated
// itself and the number was spendable.

// The exact production snapshot that caused the incident.
const CONTAMINATED = Object.freeze({
  property_id: "canaryprop_6bb8a46414092cb6318fbc35",
  decision_tier: "REVIEW_REQUIRED",
  confidence: 31,
  valuation_confidence: 36,
  comp_count: 2,
  valuation_low: 393800,
  valuation_mid: 12528300,
  valuation_high: 19070400,
  investor_ceiling_mid: 19070400,
  recommended_cash_offer: 10969000,
  minimum_acceptable_offer: 10593200,
});

// A V3 qualification whose anchor-dependent price gates could actually run.
const V3_ANCHORED = Object.freeze({ anchors: Object.freeze({ has_anchor: true }) });
// The production shape: V3 ran, but with no subject anchor its price gates were inert.
const V3_UNANCHORED = Object.freeze({ anchors: Object.freeze({ has_anchor: false }) });

const HEALTHY = Object.freeze({
  decision_tier: "AUTO_HARD_OFFER",
  confidence: 88,
  valuation_confidence: 82,
  comp_count: 6,
  investor_ceiling_mid: 300000,
  recommended_cash_offer: 250000,
});

// ── THE PINNED REGRESSION ────────────────────────────────────────────────────

test("PINNED: the $19.03M-contaminated 2-comp valuation is NOT spendable", () => {
  const s = resolveValuationSpendability({ valuation: CONTAMINATED });
  assert.equal(s.spendable, false, "the incident valuation must never authorize money");
  assert.equal(s.reason, NON_SPENDABLE_REASONS.TIER_NOT_AUTHORITATIVE);
  assert.equal(s.decision_tier, "REVIEW_REQUIRED");
  assert.equal(s.comp_count, 2);
  assert.equal(s.contamination_defense, "none", "2 comps get no MAD defense");
});

test("PINNED: REVIEW_REQUIRED + $10.969M yields NO authorized offer amount", () => {
  const authority = {
    recommended_offer: CONTAMINATED.recommended_cash_offer,
    authorized_offer_amount: null,
    authorized_offer_ceiling: CONTAMINATED.investor_ceiling_mid,
    offer_authoritative: resolveValuationSpendability({ valuation: CONTAMINATED }).spendable,
  };
  assert.equal(resolveAuthorizedOfferAmount(authority), null, "no spendable amount");
});

test("PINNED: a contaminated valuation cannot self-authorize through its own ceiling", () => {
  // $10,969,000 <= ceiling $19,070,400, so the ceiling check ALONE passes.
  // Independent evidence (tier/confidence/comp count) is what refuses it.
  const ceiling = CONTAMINATED.investor_ceiling_mid;
  assert.ok(CONTAMINATED.recommended_cash_offer <= ceiling, "ceiling alone would have allowed it");

  const ungated = { recommended_offer: CONTAMINATED.recommended_cash_offer, authorized_offer_ceiling: ceiling, offer_authoritative: true };
  assert.equal(resolveAuthorizedOfferAmount(ungated), 10969000, "ceiling-only logic admits it");

  const gated = { ...ungated, offer_authoritative: false };
  assert.equal(resolveAuthorizedOfferAmount(gated), null, "spendability gate refuses it");
});

test("PINNED: no seller_offer can be persisted for the contaminated valuation", async () => {
  // The executor only calls persistActiveOffer with a resolved amount; with the
  // gate the amount is null, so the offer is never attempted. Proven directly:
  const amount = resolveAuthorizedOfferAmount({
    recommended_offer: CONTAMINATED.recommended_cash_offer,
    authorized_offer_ceiling: CONTAMINATED.investor_ceiling_mid,
    offer_authoritative: false,
  });
  assert.equal(amount, null);

  let attempted = false;
  const supabase = { from: () => { attempted = true; throw new Error("must not be reached"); } };
  const r = await persistActiveOffer({
    opportunity_id: "opp-1", thread_key: "+15550100000",
    purchase_price: amount, supabase,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing_offer_price");
  assert.equal(attempted, false, "no DB write attempted for an unspendable valuation");
});

// ── tier semantics ───────────────────────────────────────────────────────────

test("only the engine's own offer-authoritative tiers may spend", () => {
  assert.deepEqual(OFFER_AUTHORITATIVE_TIERS, ["AUTO_HARD_OFFER", "AUTO_RANGE_OFFER"]);
  for (const tier of ["REVIEW_REQUIRED", "NURTURE", "CREATIVE_TERMS"]) {
    const s = resolveValuationSpendability({ valuation: { ...HEALTHY, decision_tier: tier } });
    assert.equal(s.spendable, false, `${tier} must not authorize a cash offer`);
    assert.equal(s.reason, NON_SPENDABLE_REASONS.TIER_NOT_AUTHORITATIVE);
  }
  for (const tier of OFFER_AUTHORITATIVE_TIERS) {
    assert.equal(
      resolveValuationSpendability({ valuation: { ...HEALTHY, decision_tier: tier } }).spendable,
      true,
      `${tier} is spendable when defended`
    );
  }
});

test("REVIEW_REQUIRED is preserved, not renamed away", () => {
  const s = resolveValuationSpendability({ valuation: CONTAMINATED });
  assert.equal(s.decision_tier, "REVIEW_REQUIRED", "the tier is still reported verbatim");
});

// ── low-N contamination defense ──────────────────────────────────────────────

test("low comp counts are never treated as trustworthy just because MAD cannot run", () => {
  for (const n of [0, 1, 2, 3, 4]) {
    const s = resolveValuationSpendability({ valuation: { ...HEALTHY, comp_count: n } });
    assert.equal(s.contamination_defense, "none", `${n} comps => no statistical defense`);
    assert.equal(s.spendable, false, `${n} comps must not be spendable undefended`);
    assert.equal(s.reason, NON_SPENDABLE_REASONS.UNDEFENDED_LOW_N);
  }
  // At the MAD threshold the statistical defense actually runs.
  const defended = resolveValuationSpendability({ valuation: { ...HEALTHY, comp_count: MAD_MIN_COMP_COUNT } });
  assert.equal(defended.contamination_defense, "mad_outlier");
  assert.equal(defended.spendable, true);
});

test("low-N BECOMES spendable when the V3 qualification pass defended it", () => {
  const undefended = resolveValuationSpendability({ valuation: { ...HEALTHY, comp_count: 3 } });
  assert.equal(undefended.spendable, false);

  const qualified = resolveValuationSpendability({
    valuation: { ...HEALTHY, comp_count: 3 },
    v3_qualification: V3_ANCHORED,
  });
  assert.equal(qualified.spendable, true, "a trusted qualification path substitutes for MAD");
  assert.equal(qualified.contamination_defense, "v3_qualification");
});

test("V3 qualification does NOT rescue a non-authoritative tier", () => {
  const s = resolveValuationSpendability({ valuation: CONTAMINATED, v3_qualification: V3_ANCHORED });
  assert.equal(s.spendable, false, "tier still governs");
  assert.equal(s.reason, NON_SPENDABLE_REASONS.TIER_NOT_AUTHORITATIVE);
});

// ── genuinely coherent valuations still work ─────────────────────────────────

test("a healthy high-confidence valuation REMAINS spendable (no false positives)", () => {
  const s = resolveValuationSpendability({ valuation: HEALTHY });
  assert.equal(s.spendable, true);
  assert.equal(s.reason, "valuation_offer_authoritative");

  const amount = resolveAuthorizedOfferAmount({
    recommended_offer: HEALTHY.recommended_cash_offer,
    authorized_offer_ceiling: HEALTHY.investor_ceiling_mid,
    offer_authoritative: s.spendable,
  });
  assert.equal(amount, 250000, "the legitimate offer path is unchanged");
});

test("AUTO_RANGE_OFFER with enough defended comps is spendable", () => {
  const s = resolveValuationSpendability({
    valuation: { ...HEALTHY, decision_tier: "AUTO_RANGE_OFFER", confidence: 70, valuation_confidence: 66, comp_count: 5 },
  });
  assert.equal(s.spendable, true);
});

test("a strategy-authorized amount still wins over the bare recommendation", () => {
  const amount = resolveAuthorizedOfferAmount({
    authorized_offer_amount: 240000,
    recommended_offer: 250000,
    authorized_offer_ceiling: 300000,
    offer_authoritative: true,
  });
  assert.equal(amount, 240000);
});

test("the ceiling clamp still applies on top of the gate", () => {
  const amount = resolveAuthorizedOfferAmount({
    authorized_offer_amount: 400000,
    authorized_offer_ceiling: 300000,
    offer_authoritative: true,
  });
  assert.equal(amount, null, "over-ceiling is still refused");
});

// ── fail-closed + no-manual-dependency ───────────────────────────────────────

test("a missing offer_authoritative flag FAILS CLOSED", () => {
  assert.equal(
    resolveAuthorizedOfferAmount({ recommended_offer: 250000, authorized_offer_ceiling: 300000 }),
    null,
    "absence of the flag must not be read as authorization"
  );
  assert.equal(resolveAuthorizedOfferAmount(null), null);
  assert.equal(resolveAuthorizedOfferAmount({}), null);
});

test("an absent or unpriced valuation is not spendable", () => {
  assert.equal(resolveValuationSpendability({ valuation: null }).reason, NON_SPENDABLE_REASONS.NO_VALUATION);
  assert.equal(
    resolveValuationSpendability({ valuation: { ...HEALTHY, recommended_cash_offer: 0 } }).reason,
    NON_SPENDABLE_REASONS.NO_RECOMMENDATION
  );
});

test("a non-spendable valuation yields a NON-MONETARY autonomous next action", () => {
  // Low confidence must not become a permanent manual-operator dependency.
  for (const reason of Object.values(NON_SPENDABLE_REASONS)) {
    const next = resolveNonSpendableNextAction({ reason });
    assert.ok(next.use_case, `${reason} has a deterministic next use case`);
    assert.ok(
      ["condition_probe", "ask_condition_clarifier"].includes(next.use_case),
      "the fallback is an existing non-monetary discovery route"
    );
    assert.ok(
      ["continue_discovery", "retry_valuation_when_evidence_improves"].includes(next.route),
      "and it keeps the conversation autonomous"
    );
  }
});

// ── Seam 3: what the V3 shadow replay actually proved ────────────────────────

test("PINNED: V3 does NOT reject the $19.03M comp on a null-featured subject", () => {
  // Measured, not assumed. V3's price-plausibility gates are anchor-dependent;
  // the production subject had estimated_value / listing_price /
  // assessed_total_value all null, so the 4x anchor rule never ran.
  const subject = { address: "4157 Pillsbury Ave S", city: "Minneapolis", state: "MN", zip: "55409", asset_type: "single_family" };
  const comps = [
    { address: "3815 2nd Ave S, Minneapolis, Mn 55409", sale_price: 19032220, city: "Minneapolis", state: "MN", zip: "55409", asset_type: "single_family" },
    { address: "3620 Pillsbury Ave S, Minneapolis, Mn 55409", sale_price: 349900, city: "Minneapolis", state: "MN", zip: "55409", asset_type: "single_family" },
  ];

  const unanchored = qualifyComps(subject, comps);
  assert.equal(unanchored.anchors.has_anchor, false);
  assert.ok(
    unanchored.accepted.some((c) => c.consideration === 19032220),
    "V3 accepts the contaminated comp when the subject has no anchor"
  );
  assert.deepEqual(unanchored.anomaly_flags, [], "and raises NO anomaly flag");

  // The SAME comps against an anchored subject ARE caught — proving the gate
  // exists and that the subject data, not the comp, is what disabled it.
  const anchored = qualifyComps({ ...subject, estimated_value: 350000 }, comps);
  assert.equal(anchored.anchors.has_anchor, true);
  assert.ok(!anchored.accepted.some((c) => c.consideration === 19032220));
  const bad = anchored.rejected.find((r) => r.consideration === 19032220);
  assert.equal(bad.status, "QUARANTINE");
  assert.ok(bad.reasons.includes("price_vs_anchor_high"));
  assert.ok(anchored.anomaly_flags.includes("IMPLAUSIBLE_COMP_PRICE"));
});

test("PINNED: an inert (unanchored) V3 pass is NOT a contamination defense", () => {
  assert.equal(resolveV3ContaminationDefense(null).defended, false);
  assert.equal(resolveV3ContaminationDefense(V3_UNANCHORED).defended, false);
  assert.equal(
    resolveV3ContaminationDefense(V3_UNANCHORED).detail,
    "v3_price_gates_inert_without_subject_anchor"
  );
  assert.equal(resolveV3ContaminationDefense(V3_ANCHORED).defended, true);

  // Therefore a low-N valuation cannot be rescued by merely HAVING run V3.
  const s = resolveValuationSpendability({
    valuation: { ...HEALTHY, comp_count: 2 },
    v3_qualification: V3_UNANCHORED,
  });
  assert.equal(s.spendable, false, "presence of a V3 pass is not authorization");
  assert.equal(s.contamination_defense, "none");
  assert.equal(s.reason, NON_SPENDABLE_REASONS.UNDEFENDED_LOW_N);
});

test("a truthy-but-empty qualification object cannot forge a defense", () => {
  for (const forged of [{}, { anchors: {} }, { anchors: { has_anchor: "yes" } }, true, 1]) {
    assert.equal(
      resolveValuationSpendability({ valuation: { ...HEALTHY, comp_count: 2 }, v3_qualification: forged }).spendable,
      false,
      `${JSON.stringify(forged)} must not authorize money`
    );
  }
});
