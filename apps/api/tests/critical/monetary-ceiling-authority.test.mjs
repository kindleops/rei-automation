import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveBuyerCeilingAuthority,
  resolveEffectiveAuthorizedCeiling,
  applyBuyerSampleOutlierDefense,
  BUYER_CEILING_REASONS,
} from "@/lib/acquisition/buyerCeilingAuthority.js";
import { MAD_MIN_OBSERVATIONS } from "@/lib/acquisition/modelConstants.js";
import { resolveValuationSpendability } from "@/lib/domain/seller-flow/valuation-offer-authority.js";
import { resolveAuthorizedOfferAmount } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

// THE MONETARY CEILING INVARIANT
//
// Buyer-behavior evidence may constrain the seller-offer ceiling; it may never
// expand it beyond the independently supported property valuation.
//
// Pinned production defect (canaryprop_6bb8a464…, 2026-08-31): a HEALTHY
// valuation leg (100 candidates -> 99 eligible -> 12 selected, MAD ran,
// $406,500/$468,200/$521,500, contaminated comp correctly excluded) still
// produced a $5,479,900 offer, because the buyer-ceiling leg independently
// re-consumed the SAME $19,032,220 package consideration from
// buyer_purchase_events_v2 with n=2 and no contamination defense whatsoever.

// The exact production buyer-purchase sample.
const CONTAMINATED_SAMPLE = Object.freeze([
  Object.freeze({ buyer_key: "bk_12aa10f6", purchase_price: 19032220, adjusted_price: 21284800, distance_miles: 0.42 }),
  Object.freeze({ buyer_key: "bk_b82e55dc", purchase_price: 349900, adjusted_price: 404400, distance_miles: 0.47 }),
]);

const CONTAMINATED_INVESTOR = Object.freeze({
  mid: 21284800,
  confidence: 44, // one point under the old `>= 45` threshold -> old blend branch
  summary: { method: "weighted_nearby_investor_purchase_quantiles" },
  purchases: CONTAMINATED_SAMPLE,
});

const VALUATION_CEILING = 295940; // 468,200 * 0.70 - 31,800
const CONTAMINATED_RECOMMENDATION = 5479900;

// A healthy, defended buyer sample (>= MAD minimum, tight cluster).
const healthySample = (mid = 250000) =>
  Array.from({ length: MAD_MIN_OBSERVATIONS + 1 }, (_, i) => ({
    buyer_key: `bk_${i}`,
    purchase_price: mid + i * 1000,
    adjusted_price: mid + i * 1000,
    distance_miles: 0.5,
  }));

const healthyInvestor = (mid) => ({
  mid,
  confidence: 70,
  summary: { method: "weighted_nearby_investor_purchase_quantiles" },
  purchases: healthySample(mid),
});

// ── THE PINNED REGRESSION ────────────────────────────────────────────────────

test("PINNED: the contaminated n=2 buyer sample is NOT ceiling-authoritative", () => {
  const a = resolveBuyerCeilingAuthority(CONTAMINATED_INVESTOR);
  assert.equal(a.authoritative, false);
  assert.ok(a.reasons.includes(BUYER_CEILING_REASONS.INSUFFICIENT_SAMPLE));
  assert.equal(a.sample_size, 2);
  assert.equal(a.outlier_defense.ran, false, "MAD cannot run on n=2");
  assert.equal(a.outlier_defense.method, "insufficient_count_for_mad");
});

test("PINNED: contaminated buyer behavior cannot expand the ceiling", () => {
  const a = resolveBuyerCeilingAuthority(CONTAMINATED_INVESTOR);
  const r = resolveEffectiveAuthorizedCeiling({
    valuation_based_ceiling: VALUATION_CEILING,
    behavior_based_ceiling: 21284800,
    buyer_ceiling_authority: a,
  });
  assert.equal(r.effective_authorized_ceiling, VALUATION_CEILING);
  assert.ok(
    r.effective_authorized_ceiling <= VALUATION_CEILING,
    "effective_authorized_ceiling <= valuation_based_ceiling"
  );
  // The old formula produced 5,543,155 here.
  assert.ok(r.effective_authorized_ceiling < 5543155, "the 18.7x expansion is gone");
});

test("PINNED COUNTERFACTUAL: $5,479,900 is unauthorizable even at an auto-offer tier", () => {
  // THE key regression: safety must NOT depend on the tier happening to be
  // REVIEW_REQUIRED. Same subject, same comps, same contaminated buyer sample,
  // but an otherwise auto-offer-eligible tier.
  for (const tier of ["AUTO_HARD_OFFER", "AUTO_RANGE_OFFER"]) {
    const valuation = {
      decision_tier: tier,
      confidence: 88,
      valuation_confidence: 82,
      comp_count: 12, // the valuation leg genuinely passes MAD
      recommended_cash_offer: CONTAMINATED_RECOMMENDATION,
      investor_ceiling_mid: 21284800,
    };
    const spend = resolveValuationSpendability({ valuation });
    assert.equal(spend.spendable, true, `${tier} valuation leg is authoritative`);

    // ...but the ceiling leg is not, so the authorized ceiling collapses to the
    // valuation ceiling and the contaminated recommendation exceeds it.
    const buyerAuthority = resolveBuyerCeilingAuthority(CONTAMINATED_INVESTOR);
    const ceiling = resolveEffectiveAuthorizedCeiling({
      valuation_based_ceiling: VALUATION_CEILING,
      behavior_based_ceiling: 21284800,
      buyer_ceiling_authority: buyerAuthority,
    }).effective_authorized_ceiling;

    const amount = resolveAuthorizedOfferAmount({
      recommended_offer: CONTAMINATED_RECOMMENDATION,
      authorized_offer_ceiling: ceiling,
      offer_authoritative: spend.spendable,
    });
    assert.equal(amount, null, `${tier}: $5,479,900 must remain unauthorizable`);
  }
});

test("PINNED: the contaminated recommendation cannot validate against its own ceiling", () => {
  // Using investor_ceiling_mid (the leg that PRODUCED the recommendation) as the
  // ceiling is exactly the self-validation this closes: 5,479,900 <= 21,284,800.
  const selfValidating = resolveAuthorizedOfferAmount({
    recommended_offer: CONTAMINATED_RECOMMENDATION,
    authorized_offer_ceiling: 21284800, // derived from the same contaminated leg
    offer_authoritative: true,
  });
  assert.equal(selfValidating, 5479900, "self-derived ceiling would admit it");

  const independent = resolveAuthorizedOfferAmount({
    recommended_offer: CONTAMINATED_RECOMMENDATION,
    authorized_offer_ceiling: VALUATION_CEILING, // independent
    offer_authoritative: true,
  });
  assert.equal(independent, null, "an independent ceiling refuses it");
});

// ── the invariant, generally ─────────────────────────────────────────────────

test("buyer behavior can never expand the ceiling, at any magnitude", () => {
  for (const behavior of [300000, 1000000, 21284800, 1e9]) {
    for (const authoritative of [true, false]) {
      const r = resolveEffectiveAuthorizedCeiling({
        valuation_based_ceiling: VALUATION_CEILING,
        behavior_based_ceiling: behavior,
        buyer_ceiling_authority: { authoritative },
      });
      assert.ok(
        r.effective_authorized_ceiling <= VALUATION_CEILING,
        `behavior ${behavior} (authoritative=${authoritative}) must not expand`
      );
    }
  }
});

test("trustworthy buyer behavior BELOW the valuation ceiling still constrains it", () => {
  const investor = healthyInvestor(180000);
  const a = resolveBuyerCeilingAuthority(investor);
  assert.equal(a.authoritative, true, "a defended sample is authoritative");
  const r = resolveEffectiveAuthorizedCeiling({
    valuation_based_ceiling: VALUATION_CEILING,
    behavior_based_ceiling: 180000,
    buyer_ceiling_authority: a,
  });
  assert.equal(r.effective_authorized_ceiling, 180000, "behavior tightens the ceiling");
  assert.equal(r.basis, "authoritative_buyer_behavior_constrains_valuation_ceiling");
});

test("trustworthy buyer behavior ABOVE the valuation ceiling does not raise it", () => {
  const investor = healthyInvestor(900000);
  const a = resolveBuyerCeilingAuthority(investor);
  assert.equal(a.authoritative, true);
  const r = resolveEffectiveAuthorizedCeiling({
    valuation_based_ceiling: VALUATION_CEILING,
    behavior_based_ceiling: 900000,
    buyer_ceiling_authority: a,
  });
  assert.equal(r.effective_authorized_ceiling, VALUATION_CEILING, "valuation still caps it");
});

test("missing buyer behavior does NOT kill a strong valuation (autonomy preserved)", () => {
  const a = resolveBuyerCeilingAuthority({ mid: null, purchases: [], summary: {} });
  assert.equal(a.authoritative, false);
  const r = resolveEffectiveAuthorizedCeiling({
    valuation_based_ceiling: VALUATION_CEILING,
    behavior_based_ceiling: null,
    buyer_ceiling_authority: a,
  });
  assert.equal(r.effective_authorized_ceiling, VALUATION_CEILING);
  assert.equal(r.basis, "valuation_ceiling_only");

  // and an offer within that ceiling is still authorizable
  const amount = resolveAuthorizedOfferAmount({
    recommended_offer: 200000,
    authorized_offer_ceiling: r.effective_authorized_ceiling,
    offer_authoritative: true,
  });
  assert.equal(amount, 200000, "weak buyer data must not block a good valuation");
});

// ── buyer-sample contamination defenses ──────────────────────────────────────

test("low-N buyer samples are non-authoritative below the MAD minimum", () => {
  for (let n = 0; n < MAD_MIN_OBSERVATIONS; n += 1) {
    const investor = { mid: 250000, summary: {}, purchases: healthySample().slice(0, n) };
    const a = resolveBuyerCeilingAuthority(investor);
    assert.equal(a.authoritative, false, `n=${n} must not be authoritative`);
    assert.ok(a.reasons.includes(BUYER_CEILING_REASONS.INSUFFICIENT_SAMPLE));
  }
});

test("package/portfolio consideration disqualifies the buyer ceiling", () => {
  const investor = {
    mid: 21284800,
    summary: {},
    purchases: [...healthySample(), { buyer_key: "bk_pkg", purchase_price: 19032220, adjusted_price: 21284800, is_package: true }],
  };
  const a = resolveBuyerCeilingAuthority(investor);
  assert.equal(a.authoritative, false);
  assert.ok(a.reasons.includes(BUYER_CEILING_REASONS.PACKAGE_CONSIDERATION));
});

test("a sample dominated by duplicate transactions is non-authoritative", () => {
  const dup = { buyer_key: "bk_dup", purchase_price: 500000, adjusted_price: 500000 };
  const investor = { mid: 500000, summary: {}, purchases: Array.from({ length: 6 }, () => ({ ...dup })) };
  const a = resolveBuyerCeilingAuthority(investor);
  assert.equal(a.authoritative, false);
  assert.ok(a.reasons.includes(BUYER_CEILING_REASONS.DUPLICATE_DOMINATED));
});

test("a valuation-derived fallback ceiling is not independent evidence", () => {
  const investor = { mid: 300000, summary: { method: "valuation_discount_fallback" }, purchases: healthySample() };
  const a = resolveBuyerCeilingAuthority(investor);
  assert.equal(a.authoritative, false);
  assert.ok(a.reasons.includes(BUYER_CEILING_REASONS.DERIVED_FROM_VALUATION));
});

test("the buyer-sample outlier defense reuses the MAD policy and reports honestly", () => {
  const low = applyBuyerSampleOutlierDefense(CONTAMINATED_SAMPLE);
  assert.equal(low.ran, false);
  assert.equal(low.method, "insufficient_count_for_mad");
  assert.equal(low.rejected.length, 0, "it must not claim to have rejected anything");

  const withOutlier = [...healthySample(250000), { buyer_key: "x", adjusted_price: 21284800 }];
  const defended = applyBuyerSampleOutlierDefense(withOutlier);
  assert.equal(defended.ran, true);
  assert.equal(defended.method, "median_absolute_deviation");
  assert.ok(defended.rejected.some((r) => r.adjusted_price === 21284800), "the extreme value is rejected");
});

// ── final resolver: defense in depth ─────────────────────────────────────────

test("a missing or non-positive ceiling FAILS CLOSED (was fail-open)", () => {
  for (const ceiling of [undefined, null, 0, -1, Number.NaN, "abc"]) {
    assert.equal(
      resolveAuthorizedOfferAmount({
        recommended_offer: CONTAMINATED_RECOMMENDATION,
        authorized_offer_ceiling: ceiling,
        offer_authoritative: true,
      }),
      null,
      `ceiling=${String(ceiling)} must authorize nothing`
    );
  }
});

test("an amount above the independent ceiling is refused; at or below is allowed", () => {
  const at = resolveAuthorizedOfferAmount({
    recommended_offer: VALUATION_CEILING,
    authorized_offer_ceiling: VALUATION_CEILING,
    offer_authoritative: true,
  });
  assert.equal(at, VALUATION_CEILING, "exactly at the ceiling is allowed");
  assert.equal(
    resolveAuthorizedOfferAmount({
      recommended_offer: VALUATION_CEILING + 1,
      authorized_offer_ceiling: VALUATION_CEILING,
      offer_authoritative: true,
    }),
    null,
    "one dollar over is refused"
  );
});

test("the one-resolver invariant still holds (SMS amount == persisted amount)", () => {
  const authority = {
    authorized_offer_amount: 240000,
    recommended_offer: 250000,
    authorized_offer_ceiling: 295940,
    offer_authoritative: true,
  };
  const sent = resolveAuthorizedOfferAmount(authority);
  const persisted = resolveAuthorizedOfferAmount(authority);
  assert.equal(sent, 240000);
  assert.equal(persisted, sent, "one resolver feeds both the SMS and the offer row");
});
