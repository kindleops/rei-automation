import "../register-aliases.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const {
  classifyStage3AskingPrice,
  evaluateAskingPrice,
  STAGE3_OFFER_BANDS,
} = await import("../../src/lib/domain/seller-flow/stage3-asking-price-engine.js");

const { ACQUISITION_LIFECYCLE_EVENTS: EV } = await import(
  "../../src/lib/domain/seller-flow/acquisition-lifecycle-events.js"
);

const FIXED_NOW = "2026-06-23T12:00:00.000Z";

// recommended_cash_offer = 175k, max_allowable_offer = 185k.
//  auto_accept   : ask <= 175000
//  close_range   : ask <= 185000
//  negotiable    : ask <= 185000 * 1.15 = 212750
//  wide_gap      : ask <= 185000 * 1.40 = 259000
//  very_wide_gap : ask >  259000
const UW = {
  recommended_cash_offer: 175000,
  max_allowable_offer: 185000,
  contract_ceiling: 185000,
  repair_estimate: 25000,
  lowest_relevant_comp: 210000,
};

function run({ seller_asking_price = null, message = "", underwriting = UW, context = {} } = {}) {
  return classifyStage3AskingPrice({
    seller_asking_price,
    message,
    underwriting,
    context: {
      now: FIXED_NOW,
      entities: { property_id: "p1", master_owner_id: "o1", prospect_id: "pr1", contact_point_id: "c1" },
      ...context,
    },
  });
}

function eventTypes(d) {
  return d.events.map((e) => e.type);
}

// ── Accept price from Stage 2 (number) and from text fallback ────────────────

test("accepts seller_asking_price handed over from Stage 2", () => {
  const d = run({ seller_asking_price: 150000 });
  assert.equal(d.seller_asking_price, 150000);
  assert.equal(d.offer_band, STAGE3_OFFER_BANDS.AUTO_ACCEPT);
});

test("falls back to extracting price from message text", () => {
  const d = run({ message: "I'd take 150k" });
  assert.equal(d.seller_asking_price, 150000);
  assert.equal(d.offer_band, STAGE3_OFFER_BANDS.AUTO_ACCEPT);
});

// ── Band assignment + routing ────────────────────────────────────────────────

test("auto_accept (ask <= RCO) → S6 contract", () => {
  const d = run({ seller_asking_price: 160000 });
  assert.equal(d.offer_band, STAGE3_OFFER_BANDS.AUTO_ACCEPT);
  assert.equal(d.route, "s6_contract");
  assert.equal(d.stage_code, "S6");
  assert.equal(d.template_use_case, "asks_contract");
  assert.deepEqual(eventTypes(d), [EV.ASKING_PRICE_EVALUATED, EV.ADVANCED_TO_SELLER_CONTRACT]);
});

test("close_range (RCO < ask <= MAO) → S5 negotiation", () => {
  const d = run({ seller_asking_price: 182000 });
  assert.equal(d.offer_band, STAGE3_OFFER_BANDS.CLOSE_RANGE);
  assert.equal(d.route, "s5_negotiation");
  assert.equal(d.stage_code, "S5");
  assert.deepEqual(eventTypes(d), [EV.ASKING_PRICE_EVALUATED, EV.OFFER_NEGOTIATION_OPENED]);
});

test("negotiable (MAO < ask <= MAO*1.15) → S4 condition", () => {
  const d = run({ seller_asking_price: 200000 });
  assert.equal(d.offer_band, STAGE3_OFFER_BANDS.NEGOTIABLE);
  assert.equal(d.route, "s4_condition");
  assert.equal(d.stage_code, "S4");
  assert.deepEqual(eventTypes(d), [EV.ASKING_PRICE_EVALUATED, EV.CONDITION_PROBE_REQUESTED]);
});

test("wide_gap with creative allowed → creative finance (S5)", () => {
  const d = run({ seller_asking_price: 240000, context: { creative_allowed: true } });
  assert.equal(d.offer_band, STAGE3_OFFER_BANDS.WIDE_GAP);
  assert.equal(d.route, "creative_finance");
  assert.equal(d.template_use_case, "creative_probe");
  assert.deepEqual(eventTypes(d), [EV.ASKING_PRICE_EVALUATED, EV.CREATIVE_FINANCE_PROPOSED]);
});

test("wide_gap without creative allowed → S4 condition", () => {
  const d = run({ seller_asking_price: 240000, context: { creative_allowed: false } });
  assert.equal(d.offer_band, STAGE3_OFFER_BANDS.WIDE_GAP);
  assert.equal(d.route, "s4_condition");
  assert.equal(d.template_use_case, "price_high_condition_probe");
});

test("very_wide_gap (ask > MAO*1.40) → nurture (S3F)", () => {
  const d = run({ seller_asking_price: 300000 });
  assert.equal(d.offer_band, STAGE3_OFFER_BANDS.VERY_WIDE_GAP);
  assert.equal(d.route, "nurture");
  assert.equal(d.stage_code, "S3F");
  assert.equal(d.follow_up_policy.schedule, true);
  assert.deepEqual(eventTypes(d), [EV.ASKING_PRICE_EVALUATED, EV.DEAL_NURTURE_TRIGGERED]);
});

// ── Boundary behavior ────────────────────────────────────────────────────────

test("ask exactly == RCO → auto_accept", () => {
  const d = run({ seller_asking_price: 175000 });
  assert.equal(d.offer_band, STAGE3_OFFER_BANDS.AUTO_ACCEPT);
});

test("ask exactly == MAO → close_range", () => {
  const d = run({ seller_asking_price: 185000 });
  assert.equal(d.offer_band, STAGE3_OFFER_BANDS.CLOSE_RANGE);
});

// ── Acquisition math ─────────────────────────────────────────────────────────

test("computes all required gap metrics", () => {
  const d = run({ seller_asking_price: 200000 });
  assert.equal(d.seller_asking_price, 200000);
  assert.equal(d.recommended_cash_offer, 175000);
  assert.equal(d.max_allowable_offer, 185000);
  assert.equal(d.offer_gap_amount, 25000); // 200000 - 175000
  assert.equal(d.offer_gap_pct, 12.5); // 25000 / 200000 * 100
  assert.equal(d.offer_to_ask_ratio, 0.88); // 175000 / 200000, rounded
  assert.equal(d.ask_to_offer_ratio, 1.14); // 200000 / 175000, rounded
  assert.equal(d.recommended_strategy, "justify_with_condition");
});

test("evaluateAskingPrice is pure and band-correct", () => {
  const e = evaluateAskingPrice(150000, UW);
  assert.equal(e.offer_band, STAGE3_OFFER_BANDS.AUTO_ACCEPT);
  assert.equal(e.offer_gap_amount, -25000);
  assert.equal(e.has_underwriting, true);
});

// ── No underwriting ──────────────────────────────────────────────────────────

test("no underwriting → unknown band, human review, no routing event", () => {
  const d = classifyStage3AskingPrice({
    seller_asking_price: 200000,
    underwriting: {},
    context: { now: FIXED_NOW },
  });
  assert.equal(d.offer_band, STAGE3_OFFER_BANDS.UNKNOWN);
  assert.equal(d.route, "human_review");
  assert.equal(d.acquisition_action, "run_underwriting");
  assert.deepEqual(eventTypes(d), [EV.ASKING_PRICE_EVALUATED]);
});

// ── Event payload shape ──────────────────────────────────────────────────────

test("ASKING_PRICE_EVALUATED carries full metrics + entity graph", () => {
  const d = run({ seller_asking_price: 200000 });
  const e = d.events[0];
  assert.equal(e.type, EV.ASKING_PRICE_EVALUATED);
  assert.equal(e.occurred_at, FIXED_NOW);
  assert.equal(e.data.offer_band, STAGE3_OFFER_BANDS.NEGOTIABLE);
  assert.equal(e.data.offer_gap_amount, 25000);
  assert.deepEqual(e.entities, {
    property_id: "p1",
    master_owner_id: "o1",
    prospect_id: "pr1",
    contact_point_id: "c1",
  });
});

// ── Never auto-sends ─────────────────────────────────────────────────────────

test("price decisions are review-tier, never auto-send", () => {
  for (const price of [150000, 182000, 200000, 240000, 300000]) {
    const d = run({ seller_asking_price: price });
    assert.equal(d.auto_send_eligible, false);
    assert.equal(d.safety_tier, "review");
    assert.equal(d.should_mark_human_review, true);
  }
});
