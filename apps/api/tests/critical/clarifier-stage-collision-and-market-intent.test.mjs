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
