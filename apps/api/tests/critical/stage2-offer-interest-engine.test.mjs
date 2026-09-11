import "../register-aliases.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const {
  classifyStage2OfferInterest,
  extractAskingPrice,
  STAGE2_OUTCOMES,
} = await import("../../src/lib/domain/seller-flow/stage2-offer-interest-engine.js");

const { ACQUISITION_LIFECYCLE_EVENTS: EV } = await import(
  "../../src/lib/domain/seller-flow/acquisition-lifecycle-events.js"
);

const FIXED_NOW = "2026-06-23T12:00:00.000Z";

function run(message, { classification = {}, context = {} } = {}) {
  return classifyStage2OfferInterest({
    message,
    classification,
    context: { now: FIXED_NOW, entities: { property_id: "p1", master_owner_id: "o1", prospect_id: "pr1", contact_point_id: "c1" }, ...context },
  });
}

function eventTypes(decision) {
  return decision.events.map((e) => e.type);
}

// ── Interest phrasing ────────────────────────────────────────────────────────

test('"yes" → offer_interest_confirmed, advances to S3', () => {
  const d = run("yes");
  assert.equal(d.outcome, STAGE2_OUTCOMES.OFFER_INTEREST_CONFIRMED);
  assert.equal(d.stage_code, "S3");
  assert.equal(d.template_use_case, "seller_asking_price");
  assert.deepEqual(eventTypes(d), [EV.OFFER_INTEREST_CONFIRMED]);
});

test('"sure depends on price" → conditional_interest (conditional beats plain yes)', () => {
  const d = run("sure depends on price");
  assert.equal(d.outcome, STAGE2_OUTCOMES.CONDITIONAL_INTEREST);
  assert.equal(d.stage_code, "S3");
  assert.deepEqual(eventTypes(d), [EV.CONDITIONAL_INTEREST_DETECTED]);
});

test('"what would you offer" → seller_requests_offer', () => {
  const d = run("what would you offer");
  assert.equal(d.outcome, STAGE2_OUTCOMES.SELLER_REQUESTS_OFFER);
  assert.deepEqual(eventTypes(d), [EV.SELLER_REQUESTED_OFFER]);
});

test('"send me an offer" → seller_requests_offer', () => {
  const d = run("send me an offer");
  assert.equal(d.outcome, STAGE2_OUTCOMES.SELLER_REQUESTS_OFFER);
});

// ── Asking price capture ─────────────────────────────────────────────────────

test('"I\'d sell for 185k" → seller_provides_asking_price, price 185000, capture event', () => {
  const d = run("I'd sell for 185k");
  assert.equal(d.outcome, STAGE2_OUTCOMES.SELLER_PROVIDES_ASKING_PRICE);
  assert.equal(d.seller_asking_price, 185000);
  assert.deepEqual(eventTypes(d), [EV.SELLER_ASKING_PRICE_CAPTURED]);
  assert.equal(d.events[0].data.seller_asking_price, 185000);
});

// ── Disinterest / timing / signoff / listed / trust ──────────────────────────

test('"not interested" → not_interested', () => {
  const d = run("not interested");
  assert.equal(d.outcome, STAGE2_OUTCOMES.NOT_INTERESTED);
  assert.deepEqual(eventTypes(d), [EV.SELLER_NOT_INTERESTED]);
});

test('"not interested" with dead policy → S10 dead / suppressed', () => {
  const d = run("not interested", { context: { disinterest_policy: "dead" } });
  assert.equal(d.stage_code, "S10");
  assert.equal(d.inbox_bucket, "dead");
  assert.equal(d.acquisition_action, "mark_dead");
});

test('"maybe next year" → follow_up_later (timing beats conditional "maybe")', () => {
  const d = run("maybe next year");
  assert.equal(d.outcome, STAGE2_OUTCOMES.FOLLOW_UP_LATER);
  assert.equal(d.stage_code, "S2F");
  assert.equal(d.follow_up_policy.schedule, true);
  assert.deepEqual(eventTypes(d), [EV.SELLER_FOLLOW_UP_REQUESTED]);
});

test('"talk to my wife" → family_or_partner_signoff_needed', () => {
  const d = run("talk to my wife");
  assert.equal(d.outcome, STAGE2_OUTCOMES.FAMILY_OR_PARTNER_SIGNOFF_NEEDED);
  assert.deepEqual(eventTypes(d), [EV.SELLER_NEEDS_SIGNOFF]);
});

test('"I have it listed" → listed_with_agent', () => {
  const d = run("I have it listed");
  assert.equal(d.outcome, STAGE2_OUTCOMES.LISTED_WITH_AGENT);
  assert.deepEqual(eventTypes(d), [EV.SELLER_LISTED_WITH_AGENT]);
});

test('"are you legit?" → trust_or_legitimacy_question', () => {
  const d = run("are you legit?");
  assert.equal(d.outcome, STAGE2_OUTCOMES.TRUST_OR_LEGITIMACY_QUESTION);
  assert.deepEqual(eventTypes(d), [EV.SELLER_TRUST_QUESTION]);
});

// ── Multilingual ─────────────────────────────────────────────────────────────

test("Spanish interest → offer_interest_confirmed", () => {
  const d = run("sí, me interesa", { classification: { language: "Spanish" } });
  assert.equal(d.outcome, STAGE2_OUTCOMES.OFFER_INTEREST_CONFIRMED);
  assert.equal(d.language, "Spanish");
});

test("Spanish asking price (200 mil = 200000, not millions)", () => {
  const d = run("lo vendo por 200 mil", { classification: { language: "Spanish" } });
  assert.equal(d.outcome, STAGE2_OUTCOMES.SELLER_PROVIDES_ASKING_PRICE);
  assert.equal(d.seller_asking_price, 200000);
});

// ── Compliance + contact-graph overrides ─────────────────────────────────────

test("opt-out overrides active S2 negotiation", () => {
  const d = run("yes I want to sell but actually STOP", {
    classification: { compliance_flag: "stop_texting" },
  });
  assert.equal(d.outcome, STAGE2_OUTCOMES.HOSTILE_OR_COMPLIANCE);
  assert.equal(d.should_suppress_contact, true);
  assert.equal(d.should_queue_reply, false);
  assert.equal(d.suppression_reason, "opt_out");
  assert.deepEqual(d.events, []);
});

test("wrong number overrides S2 without invalidating owner/property graph", () => {
  const d = run("wrong number, I never owned that", {
    classification: { primary_intent: "wrong_number" },
  });
  assert.equal(d.outcome, STAGE2_OUTCOMES.WRONG_CONTACT);
  assert.equal(d.should_suppress_contact, true);
  assert.equal(d.contact_point_only, true);
  assert.equal(d.defer_to_stage1, true);
  assert.equal(d.next_stage, null, "no stage progression");
  assert.equal(d.suppression_reason, "wrong_number");
  assert.deepEqual(d.events, []);
});

// ── Underwriting-gated offer requests ────────────────────────────────────────

test("seller asks for offer but underwriting missing → S3/S4 data collection", () => {
  const d = run("make me an offer", { context: { underwriting_ready: false } });
  assert.equal(d.outcome, STAGE2_OUTCOMES.SELLER_REQUESTS_OFFER);
  assert.equal(d.stage_code, "S3");
  assert.equal(d.acquisition_action, "collect_price_and_condition");
});

test("seller asks for offer with underwriting ready → S5 offer reveal", () => {
  const d = run("make me an offer", { context: { underwriting_ready: true } });
  assert.equal(d.outcome, STAGE2_OUTCOMES.SELLER_REQUESTS_OFFER);
  assert.equal(d.stage_code, "S5");
  assert.equal(d.template_use_case, "offer_reveal_cash");
  assert.equal(d.acquisition_action, "reveal_cash_offer");
});

// ── Asking-price band routing (acquisition decision engine) ──────────────────

const UW = {
  recommended_cash_offer: 175000,
  maximum_allowable_offer: 185000,
  contract_ceiling: 185000,
  repair_estimate: 25000,
  lowest_relevant_comp: 210000,
};

test("asking price below our offer → inside range → S6 seller contract", () => {
  const d = run("I'd take 150k", { context: { underwriting: UW } });
  assert.equal(d.outcome, STAGE2_OUTCOMES.SELLER_PROVIDES_ASKING_PRICE);
  assert.equal(d.acquisition.negotiation_band, "inside_range");
  assert.equal(d.stage_code, "S6");
  assert.equal(d.template_use_case, "asks_contract");
});

test("asking price inside approval range → S6 seller contract", () => {
  const d = run("looking for 180k", { context: { underwriting: UW } });
  assert.equal(d.acquisition.negotiation_band, "inside_range");
  assert.equal(d.stage_code, "S6");
});

test("asking price above offer (near) → S4/S5 justify & negotiate", () => {
  const d = run("I want 200k", { context: { underwriting: UW } });
  assert.equal(d.acquisition.negotiation_band, "near");
  assert.equal(d.stage_code, "S4");
  assert.equal(d.acquisition_action, "justify_offer_and_negotiate");
  assert.equal(d.acquisition.offer_gap_amount, 25000); // 200000 - 175000
});

test("asking price materially above range → far → gather condition", () => {
  const d = run("not a penny under 300k", { context: { underwriting: UW } });
  assert.equal(d.acquisition.negotiation_band, "far");
  assert.equal(d.stage_code, "S4");
  assert.equal(d.acquisition_action, "gather_condition_then_reveal");
});

test("asking price with no underwriting → capture + human review", () => {
  const d = run("I'd sell for 185k");
  assert.equal(d.acquisition.has_underwriting, false);
  assert.equal(d.acquisition_action, "run_underwriting");
  assert.equal(d.safety_tier, "review");
});

// ── Price extraction unit checks ─────────────────────────────────────────────

test("extractAskingPrice normalizes variants and ignores time expressions", () => {
  assert.equal(extractAskingPrice("185k").value, 185000);
  assert.equal(extractAskingPrice("$185,000").value, 185000);
  assert.equal(extractAskingPrice("2 million").value, 2000000);
  assert.equal(extractAskingPrice("200 mil").value, 200000);
  assert.equal(extractAskingPrice("check back in 30 days"), null);
  assert.equal(extractAskingPrice("I have 2 houses"), null);
});

// ── Canonical event payload shape ────────────────────────────────────────────

test("emitted events carry the full entity graph + stage/status", () => {
  const d = run("I'd sell for 185k");
  const e = d.events[0];
  assert.equal(e.type, EV.SELLER_ASKING_PRICE_CAPTURED);
  assert.equal(e.occurred_at, FIXED_NOW);
  assert.deepEqual(e.entities, {
    property_id: "p1",
    master_owner_id: "o1",
    prospect_id: "pr1",
    contact_point_id: "c1",
  });
  assert.equal(e.stage_code, d.stage_code);
  assert.equal(e.status, d.status);
});
