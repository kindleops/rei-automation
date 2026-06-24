import "../register-aliases.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const {
  classifyStage5Negotiation,
  extractCounterOffer,
  STAGE5_OUTCOMES,
  NEGOTIATION_BANDS,
} = await import("../../src/lib/domain/seller-flow/stage5-offer-negotiation-engine.js");

const { ACQUISITION_LIFECYCLE_EVENTS: EV } = await import(
  "../../src/lib/domain/seller-flow/acquisition-lifecycle-events.js"
);

const FIXED_NOW = "2026-06-23T12:00:00.000Z";
const RCO = 175000;
const MAO = 185000;

function run(message, overrides = {}) {
  return classifyStage5Negotiation({
    message,
    recommended_cash_offer: RCO,
    max_allowable_offer: MAO,
    ...overrides,
    context: {
      now: FIXED_NOW,
      entities: { property_id: "p1", master_owner_id: "o1", prospect_id: "pr1", contact_point_id: "c1" },
      ...(overrides.context || {}),
    },
  });
}

const types = (d) => d.events.map((e) => e.type);
const has = (d, t) => types(d).includes(t);

// ── Acceptance / rejection ───────────────────────────────────────────────────

test("seller accepts offer → ready_for_contract", () => {
  const d = run("I accept your offer");
  assert.equal(d.outcome, STAGE5_OUTCOMES.SELLER_ACCEPTS_OFFER);
  assert.equal(d.route, "ready_for_contract");
  assert.equal(d.stage_code, "S6");
  assert.ok(has(d, EV.SELLER_ACCEPTED_OFFER));
  assert.ok(has(d, EV.READY_FOR_CONTRACT));
});

test("seller rejects offer → SELLER_REJECTED_OFFER", () => {
  const d = run("no thanks, too low");
  assert.equal(d.outcome, STAGE5_OUTCOMES.SELLER_REJECTS_OFFER);
  assert.ok(has(d, EV.SELLER_REJECTED_OFFER));
});

// ── Counter offers ───────────────────────────────────────────────────────────

test("seller counters above range → counter_above_range, too-high event", () => {
  const d = run("I need at least 200");
  assert.equal(d.outcome, STAGE5_OUTCOMES.COUNTER_ABOVE_RANGE);
  assert.equal(d.counter_offer, 200000);
  assert.ok(has(d, EV.SELLER_COUNTER_OFFERED));
  assert.ok(has(d, EV.COUNTER_OFFER_TOO_HIGH));
});

test("seller counters within range → counter_within_range, acceptable event", () => {
  const d = run("I'd take 175k");
  assert.equal(d.outcome, STAGE5_OUTCOMES.COUNTER_WITHIN_RANGE);
  assert.equal(d.counter_offer, 175000);
  assert.equal(d.counter_gap_amount, 0);
  assert.equal(d.route, "ready_for_contract"); // == RCO
  assert.ok(has(d, EV.COUNTER_OFFER_ACCEPTABLE));
});

test('bare negotiation number "can you do 180" → within range → narrow', () => {
  const d = run("can you do 180");
  assert.equal(d.counter_offer, 180000);
  assert.equal(d.outcome, STAGE5_OUTCOMES.COUNTER_WITHIN_RANGE);
  assert.equal(d.route, "narrow_gap_negotiation"); // > RCO, <= MAO
});

// ── Best & final / proof / contract / sign ───────────────────────────────────

test("seller asks best and final", () => {
  const d = run("what's your best and final");
  assert.equal(d.outcome, STAGE5_OUTCOMES.SELLER_REQUESTS_BEST_AND_FINAL);
  assert.ok(has(d, EV.SELLER_REQUESTED_BEST_AND_FINAL));
});

test("seller asks proof of funds", () => {
  const d = run("can you send proof of funds");
  assert.equal(d.outcome, STAGE5_OUTCOMES.SELLER_REQUESTS_PROOF);
  assert.equal(d.template_use_case, "proof_of_funds");
  assert.ok(has(d, EV.SELLER_REQUESTED_PROOF));
});

test("seller asks for contract → ready_for_contract (S6)", () => {
  const d = run("send me the contract");
  assert.equal(d.outcome, STAGE5_OUTCOMES.SELLER_REQUESTS_CONTRACT);
  assert.equal(d.stage_code, "S6");
  assert.ok(has(d, EV.READY_FOR_CONTRACT));
});

test('seller asks where to sign → ready_for_contract', () => {
  const d = run("ok where do i sign");
  assert.equal(d.outcome, STAGE5_OUTCOMES.SELLER_REQUESTS_CONTRACT);
  assert.equal(d.route, "ready_for_contract");
});

// ── Posture / flexibility ────────────────────────────────────────────────────

test("seller says price is firm (wide gap) → wide_gap_negotiation, anchored", () => {
  const d = run("price is firm", { seller_asking_price: 240000 });
  assert.equal(d.negotiation_band, NEGOTIATION_BANDS.WIDE_GAP);
  assert.equal(d.outcome, STAGE5_OUTCOMES.WIDE_GAP_NEGOTIATION);
  assert.equal(d.negotiation_posture, "anchored");
  assert.equal(d.flexibility_trend, "falling");
});

test('seller lowers price ("I can come down") → narrow, flexibility rising', () => {
  const d = run("I can come down a little");
  assert.equal(d.outcome, STAGE5_OUTCOMES.NARROW_GAP_NEGOTIATION);
  assert.equal(d.flexibility_trend, "rising");
  assert.equal(d.negotiation_posture, "flexible");
});

test('seller says "make it make sense" → narrow_gap_negotiation', () => {
  const d = run("make it make sense for me");
  assert.equal(d.outcome, STAGE5_OUTCOMES.NARROW_GAP_NEGOTIATION);
});

// ── Creative finance ─────────────────────────────────────────────────────────

test("seller asks for monthly payments → seller_finance_candidate", () => {
  const d = run("could you do monthly payments");
  assert.equal(d.outcome, STAGE5_OUTCOMES.SELLER_FINANCE_CANDIDATE);
  assert.ok(has(d, EV.SELLER_FINANCE_CANDIDATE));
  assert.ok(has(d, EV.CREATIVE_FINANCE_CANDIDATE));
});

test("seller open to seller financing → seller_finance_candidate", () => {
  const d = run("I'm open to seller financing");
  assert.equal(d.outcome, STAGE5_OUTCOMES.SELLER_FINANCE_CANDIDATE);
  assert.equal(d.stage_code, "S5C");
});

test("seller open to subject-to → subject_to_candidate", () => {
  const d = run("would you take over payments");
  assert.equal(d.outcome, STAGE5_OUTCOMES.SUBJECT_TO_CANDIDATE);
  assert.equal(d.template_use_case, "offer_reveal_subject_to");
  assert.ok(has(d, EV.SUBJECT_TO_CANDIDATE));
});

test("seller open to creative terms → creative_finance_candidate", () => {
  const d = run("I'm open to creative terms");
  assert.equal(d.outcome, STAGE5_OUTCOMES.CREATIVE_FINANCE_CANDIDATE);
  assert.ok(has(d, EV.CREATIVE_FINANCE_CANDIDATE));
});

// ── Multilingual ─────────────────────────────────────────────────────────────

test("Spanish counteroffer (lo dejo en 180 mil)", () => {
  const d = run("lo dejo en 180 mil");
  assert.equal(d.counter_offer, 180000);
  assert.equal(d.outcome, STAGE5_OUTCOMES.COUNTER_WITHIN_RANGE);
});

test("Spanish acceptance (acepto)", () => {
  const d = run("acepto");
  assert.equal(d.outcome, STAGE5_OUTCOMES.SELLER_ACCEPTS_OFFER);
  assert.equal(d.route, "ready_for_contract");
});

// ── Band-driven defaults ─────────────────────────────────────────────────────

test("very wide gap (neutral msg) → deal_nurture", () => {
  const d = run("", { seller_asking_price: 300000 });
  assert.equal(d.negotiation_band, NEGOTIATION_BANDS.VERY_WIDE_GAP);
  assert.equal(d.outcome, STAGE5_OUTCOMES.DEAL_NURTURE);
  assert.ok(has(d, EV.DEAL_NURTURE_TRIGGERED));
});

test("narrow gap (close range, neutral msg) → narrow_gap_negotiation", () => {
  const d = run("", { seller_asking_price: 182000 });
  assert.equal(d.negotiation_band, NEGOTIATION_BANDS.CLOSE_RANGE);
  assert.equal(d.outcome, STAGE5_OUTCOMES.NARROW_GAP_NEGOTIATION);
});

test("auto-accept band (neutral msg) → ready_for_contract", () => {
  const d = run("", { seller_asking_price: 150000 });
  assert.equal(d.negotiation_band, NEGOTIATION_BANDS.AUTO_ACCEPT);
  assert.equal(d.outcome, STAGE5_OUTCOMES.READY_FOR_CONTRACT);
});

test("accepted offer after negotiation", () => {
  const d = run("ok that works, let's do it");
  assert.equal(d.outcome, STAGE5_OUTCOMES.SELLER_ACCEPTS_OFFER);
  assert.equal(d.route, "ready_for_contract");
});

// ── Offer reveal ─────────────────────────────────────────────────────────────

test("offer reveal when Stage 4 flagged should_reveal_offer", () => {
  const d = run("", { should_reveal_offer: true });
  assert.equal(d.outcome, STAGE5_OUTCOMES.OFFER_REVEALED);
  assert.equal(d.template_use_case, "offer_reveal_cash");
  assert.ok(has(d, EV.OFFER_REVEALED));
});

// ── Creative with large gap / no underwriting / human review ─────────────────

test("creative candidate with large gap (creative eligible)", () => {
  const d = run("I'm open to terms", { seller_asking_price: 300000, context: { creative_allowed: true } });
  assert.equal(d.outcome, STAGE5_OUTCOMES.CREATIVE_FINANCE_CANDIDATE);
  assert.equal(d.route, "creative_finance");
});

test("no underwriting available → counter captured, human review", () => {
  const d = run("I'd take 175k", { recommended_cash_offer: null, max_allowable_offer: null });
  assert.equal(d.outcome, STAGE5_OUTCOMES.SELLER_COUNTER_OFFER);
  assert.equal(d.counter_offer, 175000);
  assert.equal(d.underwriting_ready, false);
  assert.equal(d.route, "human_review");
});

test("human review fallback (no signal, no underwriting)", () => {
  const d = run("asdf qwerty", { recommended_cash_offer: null, max_allowable_offer: null });
  assert.equal(d.outcome, STAGE5_OUTCOMES.HUMAN_REVIEW_REQUIRED);
});

// ── Reusable artifacts ───────────────────────────────────────────────────────

test("negotiation profile schema is populated", () => {
  const d = run("I can come down", {
    motivation_score: 70, urgency_score: 60, trust_score: 80, anchor_strength: 40,
  });
  const p = d.negotiation_profile;
  assert.equal(p.motivation_score, 70);
  assert.equal(p.urgency_score, 60);
  assert.equal(p.trust_score, 80);
  assert.equal(p.anchor_strength, 40);
  assert.equal(typeof p.flexibility_score, "number");
  assert.equal(typeof p.creative_finance_openness, "number");
  assert.equal(p.negotiation_posture, "flexible");
});

test("offer justification packet is reusable + computes gap", () => {
  const d = run("price is firm", {
    seller_asking_price: 230000, repair_estimate: 30000, lowest_relevant_comp: 210000,
    occupancy_status: "occupied_tenant",
  });
  const pkt = d.offer_justification_packet;
  assert.equal(pkt.seller_asking_price, 230000);
  assert.equal(pkt.recommended_cash_offer, 175000);
  assert.equal(pkt.repair_estimate, 30000);
  assert.equal(pkt.lowest_relevant_comp, 210000);
  assert.equal(pkt.offer_gap_amount, 55000); // 230000 - 175000
  assert.equal(pkt.justification_basis, "mixed");
});

test("extractCounterOffer normalizes variants", () => {
  assert.equal(extractCounterOffer("I'd take 175k", RCO).normalized_amount, 175000);
  assert.equal(extractCounterOffer("can you do 160?", RCO).normalized_amount, 160000);
  assert.equal(extractCounterOffer("meet me at 150", RCO).normalized_amount, 150000);
  assert.equal(extractCounterOffer("lo dejo en 180 mil", RCO).normalized_amount, 180000);
  assert.equal(extractCounterOffer("give me a week", RCO).normalized_amount, null);
});

test("negotiation/offer routes never auto-send", () => {
  for (const msg of ["I accept your offer", "I need at least 200", "send me the contract", "price is firm"]) {
    const d = run(msg, { seller_asking_price: 240000 });
    assert.equal(d.auto_send_eligible, false, msg);
    assert.equal(d.safety_tier, "review", msg);
  }
});
