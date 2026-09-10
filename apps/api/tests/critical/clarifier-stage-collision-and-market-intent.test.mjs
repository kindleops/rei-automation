/**
 * clarifier-stage-collision-and-market-intent.test.mjs
 *
 * Locks the 2026-09-10 production incident and the operator flow rules issued
 * the same day.
 *
 * THE INCIDENT. classify.js detectStageHint() returns a legacy TOPIC label and
 * returns "Offer" for ANY message containing "offer", "price", "number" or
 * "how much". apply-inbound-automation-decision.js let that topic label OUTRANK
 * the real conversation stage, and safe-fallback.js resolveStageBucket() matched
 * the substring "offer" and returned the S5 LIFECYCLE bucket, whose copy assumes
 * an offer was already presented.
 *
 * A seller answering the first text with the single word "Offer" was told
 * "are you still open to the offer, or should I hold off?" -- a break-up line
 * about an offer that never existed. 16 sellers received it. The Minneapolis
 * seller who wrote "$399,000 coming on MLS spring 2027" got it and replied
 * "Never had an offer worth my time, please remove me from your list."
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSafeFallback,
  resolveStageBucket,
  UNCERTAINTY_TYPES,
} from "@/lib/domain/seller-flow/coverage-net/safe-fallback.js";
import { detectInboundIntent } from "@/lib/domain/classification/classify.js";

// ── the incident itself ─────────────────────────────────────────────────────

test("a legacy TOPIC label can never reach a presupposing late bucket", () => {
  // detectStageHint() emits exactly these. None is a lifecycle position.
  for (const topic of ["Offer", "Q/A", "Contract", "Ownership", "Follow-Up"]) {
    const fb = buildSafeFallback({ stage: topic, uncertainty_type: "intent" });
    assert.equal(
      fb.presupposes_prior_offer,
      false,
      `topic label ${topic} promoted to bucket ${fb.stage_bucket}`
    );
    assert.ok(!/still open to the offer/i.test(fb.suggested_text), topic);
  }
});

test("the exact incident message no longer produces the break-up line", () => {
  const fb = buildSafeFallback({ stage: "Offer", uncertainty_type: "intent" });
  assert.notEqual(
    fb.suggested_text,
    "Want to be respectful of your time, are you still open to the offer, or should I hold off?"
  );
  assert.equal(fb.stage_bucket, "consider_selling");
  assert.ok(fb.suggested_text.trim().endsWith("?"), "every clarifier ends in a question");
});

test("an unrecognised stage degrades to the safest bucket, never a late one", () => {
  for (const junk of [null, undefined, "", "garbage", "S2", "who knows"]) {
    const fb = buildSafeFallback({ stage: junk, uncertainty_type: "intent" });
    assert.equal(fb.presupposes_prior_offer, false, String(junk));
  }
});

test("a REAL late lifecycle stage still gets late-stage copy", () => {
  // The fix must not blind the system where the offer genuinely went out.
  for (const stage of ["offer_reveal_cash", "Offer Positioning", "Negotiation", "close_handoff"]) {
    const fb = buildSafeFallback({ stage, uncertainty_type: "intent" });
    assert.equal(fb.presupposes_prior_offer, true, stage);
  }
});

test("no clarifier presupposes an offer outside a late bucket, and all end in a question", () => {
  const stages = [
    null, "Offer", "Q/A", "Contract", "ownership_check", "consider_selling",
    "asking_price", "mf_rents", "Offer Interest Confirmation", "garbage",
  ];
  for (const uncertainty_type of UNCERTAINTY_TYPES) {
    for (const stage of stages) {
      const fb = buildSafeFallback({ stage, uncertainty_type });
      assert.ok(fb.suggested_text, `${uncertainty_type}/${stage}`);
      assert.equal(fb.presupposes_prior_offer, false, `${uncertainty_type}/${stage}`);
      if (uncertainty_type !== "language") {
        assert.ok(
          fb.suggested_text.trim().endsWith("?"),
          `${uncertainty_type}/${stage} must end in a question: ${fb.suggested_text}`
        );
      }
      // No clarifier may reference a number/offer we may never have sent.
      assert.ok(
        !/the number i sent|the offer i sent|still open to the offer/i.test(fb.suggested_text),
        `${uncertainty_type}/${stage} presupposes: ${fb.suggested_text}`
      );
    }
  }
});

test("resolveStageBucket maps the canonical vocabularies correctly", () => {
  assert.equal(resolveStageBucket("consider_selling"), "consider_selling");
  assert.equal(resolveStageBucket("Offer Interest Confirmation"), "consider_selling");
  assert.equal(resolveStageBucket("asking_price"), "asking_price");
  assert.equal(resolveStageBucket("mf_rents"), "condition");
  assert.equal(resolveStageBucket("offer_reveal_cash"), "offer");
  assert.equal(resolveStageBucket("Negotiation"), "negotiation_close");
});

// ── terse offer request ─────────────────────────────────────────────────────

test("a one word 'Offer' is an offer request, not an unclear message", () => {
  for (const m of ["Offer", "offer", "Offer.", "offer?", "An offer", "Cash offer", "Proposal"]) {
    assert.equal(detectInboundIntent(m)?.detected_intent, "asks_offer", m);
  }
});

test("statements ABOUT an offer are still not offer requests", () => {
  for (const m of [
    "your offer was too low",
    "I already have an offer",
    "the offer is insulting",
    "we rejected your offer",
  ]) {
    assert.notEqual(detectInboundIntent(m)?.detected_intent, "asks_offer", m);
  }
});

// ── going to market (operator rule, 2026-09-10) ─────────────────────────────

test("a FUTURE listing is going_to_market, not already_listed", () => {
  for (const m of [
    "$399,000 coming on MLS spring 2027",
    "Going on the market next month",
    "I'm listing it with an agent in the spring",
    "about to list it",
    "putting it on the market soon",
    "will be listed next year",
    "Coming soon on the MLS",
  ]) {
    assert.equal(detectInboundIntent(m)?.detected_intent, "going_to_market", m);
  }
});

test("a PRESENT listing or a closed sale is never going_to_market", () => {
  for (const m of [
    "It's already listed with an agent",
    "currently listed on the MLS",
    "under contract",
    "in escrow",
    "sale pending",
    "already on the market",
    "we sold it last year",
  ]) {
    assert.notEqual(detectInboundIntent(m)?.detected_intent, "going_to_market", m);
  }
});

test("going_to_market outranks a bare wait", () => {
  // "going on the market next month" used to score need_time, parking a decided
  // seller in a wait lane instead of pitching an off-market close.
  assert.equal(detectInboundIntent("Going on the market next month")?.detected_intent, "going_to_market");
});

// ── THE ACTUAL DOMINANT CAUSE: the canonical lifecycle vocabulary ───────────
// The audit proved the legacy topic label was NOT the main driver. The stage the
// clarifier receives comes from transitionDirective?.stage_after ||
// effectiveStageBefore, both emitted in LIFECYCLE_STAGE_CODES. The old resolver
// guarded with s.includes("offer interest") -- a SPACE -- while the code is
// `offer_interest` with an UNDERSCORE, so the guard missed its own case and fell
// through to includes("offer") and the S5 break-up copy. 4 of the 5 break-up
// messages ever delivered came from this, not from the topic label.

test("offer_interest is S2, the stage where 79% of live threads sit", () => {
  const fb = buildSafeFallback({ stage: "offer_interest", uncertainty_type: "intent" });
  assert.equal(fb.stage_bucket, "consider_selling");
  assert.equal(fb.presupposes_prior_offer, false);
  assert.equal(fb.stage_bucket_source, "exact", "must be an EXACT entry, not a lucky substring");
});

test("every canonical LIFECYCLE_STAGE_CODES value maps exactly, never by guesswork", () => {
  const expected = {
    ownership_confirmation: ["ownership", false],
    offer_interest: ["consider_selling", false],
    asking_price: ["asking_price", false],
    property_condition: ["condition", false],
    // bare "offer" is ambiguous with the legacy topic label; safety wins
    offer: ["consider_selling", false],
    formal_contract: ["negotiation_close", true],
    under_contract: ["negotiation_close", true],
    disposition: ["negotiation_close", true],
    prepared_to_close: ["negotiation_close", true],
    closed: ["ownership", false],
  };
  for (const [code, [bucket, presupposes]] of Object.entries(expected)) {
    const fb = buildSafeFallback({ stage: code, uncertainty_type: "intent" });
    assert.equal(fb.stage_bucket, bucket, code);
    assert.equal(fb.presupposes_prior_offer, presupposes, code);
    if (code !== "offer") {
      assert.equal(fb.stage_bucket_source, "exact", `${code} must be exact-mapped`);
    }
  }
});

test("an unregistered stage vocabulary is reported, not silently bucketed", () => {
  // The next engine that invents a stage code must be visible rather than
  // inheriting a bucket by substring luck, which is how this incident happened.
  const fb = buildSafeFallback({ stage: "some_future_stage_code", uncertainty_type: "intent" });
  assert.equal(fb.stage_bucket_source, "unmapped");
  assert.equal(fb.presupposes_prior_offer, false);
});

// ── inbound lead phrasings ──────────────────────────────────────────────────
// Live case 2026-09-10, thread +13055376631 (Miami): the seller texted
// "Hi do you buy houses?" at 20:27Z and "Yes I have a house in Miami to sell"
// at 20:33Z. Both scored unclear and both were answered with nothing. The
// existing rule caught "I want to sell my house" at 0.90 but not "I have a
// house to sell", which is the same statement.

test("a seller announcing a property to sell is interested, not unclear", () => {
  for (const m of [
    "Hi do you buy houses?",
    "Yes I have a house in Miami to sell",
    "do you buy houses",
    "I have a house to sell",
    "Do you guys buy properties?",
    "i got a property to sell",
    "Do you still buy houses",
    "I own a duplex to sell",
    "are you buying",
  ]) {
    assert.equal(detectInboundIntent(m)?.detected_intent, "seller_interested", m);
  }
});

test("declines and non-property solicitations are not leads", () => {
  for (const m of [
    "I don't have a house to sell",   // negated possession
    "I have a house but not to sell", // possession, explicit decline
    "Do you buy stolen cars",         // not a property
    "not interested",
  ]) {
    assert.notEqual(detectInboundIntent(m)?.detected_intent, "seller_interested", m);
  }
});

// ── occupancy vocabulary + "both units" ─────────────────────────────────────
// Live case 2026-09-10, +13058426269, 2005 NW 93rd Ter Miami. Asked "Is it
// vacant or occupied, currently?" the seller answered "Both units are tenanted".
// That produced NO intent, NO occupancy fact and NO unit count: "tenanted" was
// absent from both vocabularies, and "both units" was never read as a count of 2.
// A duplex owner answering the occupancy question could not advance to rents.
import {
  extractSellerFacts,
  extractionToResolverFacts,
} from "@/lib/domain/seller-flow/extract-seller-facts.js";

const facts = (m) => extractionToResolverFacts(extractSellerFacts({ message: m }));

test("'tenanted' is occupancy language in BOTH the classifier and the extractor", () => {
  for (const m of ["Both units are tenanted", "It's tenanted", "all units are tenanted"]) {
    assert.equal(detectInboundIntent(m)?.detected_intent, "tenant_occupied", `intent: ${m}`);
    assert.equal(facts(m).occupancy_status, "tenant_occupied", `fact: ${m}`);
  }
});

test("'both units' states a unit count of exactly 2", () => {
  for (const m of ["Both units are tenanted", "Both units rented", "both units are vacant"]) {
    assert.equal(facts(m).reported_units_count, 2, m);
  }
});

test("vacancy is still read as vacancy, not occupancy", () => {
  assert.equal(facts("It's vacant").occupancy_status, "vacant");
  assert.equal(facts("both units are vacant").occupancy_status, "vacant");
  assert.equal(facts("it is empty").occupancy_status, "vacant");
});

// ── operator item 18: contextual monetary parsing ───────────────────────────
// Every case below is a real production message that parsed wrong.
import { resolveStageDomainRecommendation } from "@/lib/domain/seller-flow/stage-domain-recommendation.js";

test("a bare monthly cadence is a rent, including the live double-spaced form", () => {
  // 2026-09-10, +19549807015: we asked "what are the current monthly rents?" and
  // the answer scored no rent fact at all, then landed in asking_price.
  assert.equal(facts("$4100.00 per Month").monthly_gross_rent, 4100);
  assert.equal(facts("$4100.00  per  Month. The property is zone Business - B1").monthly_gross_rent, 4100);
  assert.equal(facts("1450/mo").monthly_gross_rent, 1450);
  assert.equal(facts("rent is 1450").monthly_gross_rent, 1450);
});

test("per-unit rent plus a unit count derives the gross, and never the reverse", () => {
  const f = facts("3 units, 1500 each");
  assert.equal(f.reported_units_count, 3);
  assert.equal(f.average_monthly_unit_rent, 1500);
  assert.equal(f.monthly_gross_rent, 4500);
  assert.equal(f.monthly_gross_rent_basis, "per_unit_times_unit_count");
  // Nothing is invented when the count is unknown.
  const partial = facts("1500 each");
  assert.equal(partial.average_monthly_unit_rent, 1500);
  assert.equal(partial.monthly_gross_rent, undefined);
});

test("an offer request is never a literal monetary counter", () => {
  const r = detectInboundIntent("Make me an offer I can't refuse");
  assert.equal(r?.detected_intent, "asks_offer");
  assert.equal(facts("Make me an offer I can't refuse").asking_price, undefined);
});

test("off-market plus an invitation to bid is interest, not a decline", () => {
  // Theodore, +13058426269, 2026-09-10. This is the strongest buying signal a
  // seller can send and it must stay in the acquisition flow.
  for (const m of [
    "The property is not on the market but you're welcome to make an offer.",
    "Yes. The property is not on the market but you're welcome to make an offer.",
  ]) {
    assert.equal(detectInboundIntent(m)?.detected_intent, "asks_offer", m);
  }
});

// ── operator item 8: the qualification engine must run on the same turn ─────
test("a stated price is evaluated by the asking-price engine on the same turn", () => {
  const r = resolveStageDomainRecommendation({
    message: "$650,000",
    classification: { primary_intent: "asking_price_provided", stage_hint: "Offer" },
    context: { summary: { conversation_stage: "offer_interest" } },
    semantic_intent: "asking_price_provided",
    underwriting: { recommended_cash_offer: 219200, max_allowable_offer: 281400 },
    deal_state: { negotiation_state: { current_asking_price: 650000 } },
  });
  assert.equal(r.authority, "stage3_asking_price_engine");
  assert.equal(r.engine_stage_source, "semantic_event");
  assert.equal(r.engine_result.stage_decision.offer_band, "very_wide_gap");
  assert.equal(r.engine_result.stage_decision.recommended_strategy, "nurture_drip");
  assert.equal(r.unmapped_stage, null);
});

test("every canonical lifecycle stage reaches a real engine, and unknowns are visible", () => {
  const expected = {
    ownership_confirmation: "stage1_ownership_engine",
    offer_interest: "stage2_offer_interest_engine",
    asking_price: "stage3_asking_price_engine",
    property_condition: "stage4_condition_engine",
    offer: "stage5_negotiation_engine",
    formal_contract: "stage6_contract_engine",
    under_contract: "stage6_contract_engine",
    prepared_to_close: "stage6_contract_engine",
    disposition: "stage6_contract_engine",
    closed: "stage6_contract_engine",
  };
  for (const [stage, authority] of Object.entries(expected)) {
    const r = resolveStageDomainRecommendation({
      message: "hi", classification: {}, context: { summary: { conversation_stage: stage } },
    });
    assert.equal(r.authority, authority, stage);
    assert.equal(r.unmapped_stage, null, stage);
  }
  // Unknown vocabulary is safe AND reported, never silently stage 1.
  const unknown = resolveStageDomainRecommendation({
    message: "hi", classification: {},
    context: { summary: { conversation_stage: "a_stage_nobody_registered" } },
  });
  assert.equal(unknown.engine_stage_source, "unmapped_stage_fallback");
  assert.equal(unknown.unmapped_stage, "a_stage_nobody_registered");
});
