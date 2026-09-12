/**
 * THE S1-S6 CONVERSATION MATRIX.
 *
 * Real seller sentences, through the real production functions, in state.
 * Every case answers one question: given message X in state Y, does the system
 * extract the right facts, land in the right stage, pick the right route and
 * template - and never send something inappropriate?
 *
 * The economics are fixed so every band is deterministic:
 *   recommended_cash_offer 200,000   max_allowable_offer 230,000
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { resolveAskingPriceSignal } from "@/lib/domain/seller-flow/monetary-understanding.js";
import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { routeForBand, STAGE3_OFFER_BANDS, STAGE3_ROUTES } from "@/lib/domain/seller-flow/stage3-asking-price-engine.js";
import { resolveTemplateFromPool } from "@/lib/domain/templates/template-runtime-resolver.js";

const UW = { recommended_cash_offer: 200_000, max_allowable_offer: 230_000, sufficient_facts: true };
const OWNED = { ownership_status: "confirmed" };
const INTERESTED = { ...OWNED, interest: "interested" };
const CONDITIONED = { ...INTERESTED, occupancy_status: "vacant", condition_level: "needs work" };

const intentOf = async (m) => {
  const r = await classify(m, null, { heuristicOnly: true });
  return r?.primary_intent ?? r?.intent ?? "unclear";
};
const priceOf = (m) => resolveAskingPriceSignal(m, { reference: 200_000 })?.asking_price ?? null;

/** One inbound turn against fixed prior state. */
function turn({ stage = null, facts = {}, message = "", intent = "unclear", ade = null, ns = null } = {}) {
  const ask = priceOf(message);
  const t = resolveSellerStageTransition({
    stage_before: stage,
    known_facts: facts,
    new_facts: ask ? { asking_price: ask } : {},
    intent,
    ade_result: ade,
    negotiation_state: ns,
  });
  const gate = t.economic_gate?.applied === false ? null : t.economic_gate;
  return { t, gate, ask };
}

// ══════════════════════════════════════════════════════════════════════════
// S1 — OWNERSHIP
// ══════════════════════════════════════════════════════════════════════════

test("S1 positive ownership advances to S2", async () => {
  for (const m of ["Yes", "Yeah that's mine", "I own it"]) {
    assert.equal(await intentOf(m), "ownership_confirmed", m);
  }
  const { t } = turn({ stage: "ownership_confirmation", facts: { ownership_status: "confirmed" }, intent: "ownership_confirmed" });
  assert.equal(t.stage_after, "offer_interest");
});

test("S1 ownership + interest in one message skips to S3", () => {
  // One inbound supplied two facts; the skip is legitimate.
  const { t } = turn({
    stage: "ownership_confirmation",
    facts: { ownership_status: "confirmed", interest: "interested" },
    intent: "asks_offer",
  });
  assert.equal(t.stage_after, "asking_price");
  assert.equal(t.lead_temperature, "warm", "asks_offer alone is never HOT");
});

test("S1 ambiguity holds at S1 and never advances", async () => {
  for (const m of ["Who is this?", "What property?"]) {
    const i = await intentOf(m);
    assert.ok(["who_is_this", "info_request"].includes(i), `${m} -> ${i}`);
    const { t } = turn({ stage: "ownership_confirmation", facts: {}, intent: i });
    assert.equal(t.stage_after, "ownership_confirmation", `${m} must hold at S1`);
  }
});

test("S1 wrong owner is suppressed, never advanced", async () => {
  for (const m of ["Wrong person", "I don't own that"]) {
    assert.equal(await intentOf(m), "wrong_number", m);
  }
  const { t } = turn({ stage: "ownership_confirmation", facts: {}, intent: "wrong_number" });
  assert.notEqual(t.stage_after, "offer_interest");
  assert.ok(t.contactability_patch || t.next_action === "no_action_contact_blocked", "must suppress");
});

test("REGRESSION: an explicit refusal is never read as interest", async () => {
  // Production defect: "We aren't looking to sell" classified as
  // seller_interested because the negation lookbehind covered "not " but not
  // the contraction. The seller sat in the active S1 outbound pool.
  for (const m of [
    "Not interested",
    "We aren't looking to sell",
    "we arent looking to sell",
    "We aren't selling",
    "Yes we do, but It's not a duplex, and we aren't looking to sell",
    "No thanks",
    "Not selling",
  ]) {
    const i = await intentOf(m);
    assert.notEqual(i, "seller_interested", `"${m}" must never read as interest`);
    assert.notEqual(i, "latent_interest", `"${m}" must never read as latent interest`);
  }
  // And genuine interest still reads as interest.
  for (const m of ["We are looking to sell", "I want to sell", "ready to sell"]) {
    assert.equal(await intentOf(m), "seller_interested", m);
  }
});

test("S1 opt-out suppresses", async () => {
  assert.equal(await intentOf("Stop texting me"), "opt_out");
});

// ══════════════════════════════════════════════════════════════════════════
// S2 — INTEREST
// ══════════════════════════════════════════════════════════════════════════

test("S2 positive interest advances to S3 and is WARM, never HOT", () => {
  const { t } = turn({ stage: "offer_interest", facts: INTERESTED, intent: "seller_interested" });
  assert.equal(t.stage_after, "asking_price");
  assert.equal(t.lead_temperature, "warm");
});

test("S2 'make me an offer' resolves interest but never fabricates a price", async () => {
  assert.equal(await intentOf("Make me an offer"), "asks_offer");
  const { t, ask } = turn({ stage: "offer_interest", facts: OWNED, message: "Make me an offer", intent: "asks_offer" });
  assert.equal(ask, null, "no price may be invented");
  assert.equal(t.lead_temperature, "warm");
});

// ══════════════════════════════════════════════════════════════════════════
// S3 — ASKING PRICE
// ══════════════════════════════════════════════════════════════════════════

test("S3 price forms normalize correctly", () => {
  const cases = [
    ["220k", 220_000, "exact"], ["220", 220_000, "exact"], ["$220,000", 220_000, "exact"],
    ["half mil", 500_000, "exact"], ["half a million", 500_000, "exact"], ["250 net", 250_000, "net"],
    ["at least 400", 400_000, "minimum"], ["no less than 400", 400_000, "minimum"],
    ["under 500", 500_000, "maximum"], ["no more than 500", 500_000, "maximum"],
  ];
  for (const [m, value, type] of cases) {
    const p = priceOf(m);
    assert.equal(p?.value, value, m);
    assert.equal(p?.price_type, type, `${m} type`);
  }
  const anchored = priceOf("Number has to start with a 4");
  assert.equal(anchored?.value, 400_000);
  assert.equal(anchored?.price_type, "minimum");
});

test("S3 ranges stay ranges", () => {
  for (const m of ["350 to 400", "between 350k and 400k"]) {
    const p = priceOf(m);
    assert.equal(p?.price_type, "range", m);
    assert.equal(p?.range?.low, 350_000, m);
    assert.equal(p?.range?.high, 400_000, m);
  }
});

test("S3 false numbers produce NO asking price", () => {
  for (const m of [
    "Houston TX 77020", "built in 2020", "call me at 209-505-5314", "1720 Pannell",
    "mortgage is 2100", "rent is 2200", "Yes, I own 121/123 Congress Ave",
  ]) {
    assert.equal(priceOf(m)?.value ?? null, null, `"${m}" must not yield a price`);
  }
});

test("S3 conditional refusal keeps BOTH the threshold and the refusal", async () => {
  const m = "Not for sale unless you have $400,000";
  assert.equal(priceOf(m)?.value, 400_000, "the threshold survives");
  const intent = await intentOf(m);
  assert.notEqual(intent, "seller_interested", "a conditional refusal is not unconditional interest");
});

// ══════════════════════════════════════════════════════════════════════════
// S3 ECONOMIC ROUTING MATRIX
// ══════════════════════════════════════════════════════════════════════════

const BANDS = [
  { ask: 195_000, band: "auto_accept",    route: "auto_accept_offer",        stage: "offer",              temp: "hot",  uc: "offer_reveal_cash" },
  { ask: 220_000, band: "close_range",    route: "close_range_initial_offer", stage: "offer",             temp: "warm", uc: "offer_reveal_cash" },
  { ask: 250_000, band: "negotiable",     route: "negotiable_condition",     stage: "property_condition", temp: "warm", uc: "price_high_condition_probe" },
  { ask: 300_000, band: "wide_gap",       route: "wide_gap_condition",       stage: "property_condition", temp: "warm", uc: "price_high_condition_probe" },
  { ask: 500_000, band: "very_wide_gap",  route: "very_wide_gap_nurture",    stage: "asking_price",       temp: "cold", uc: "asking_price_follow_up" },
];

test("S3 economic bands route deterministically", () => {
  for (const c of BANDS) {
    const { t, gate } = turn({
      stage: "asking_price", facts: INTERESTED,
      message: `I want ${c.ask / 1000}k`, intent: "price_provided", ade: UW,
    });
    assert.equal(gate?.offer_band, c.band, `${c.ask} band`);
    assert.equal(gate?.route_id, c.route, `${c.ask} route`);
    assert.equal(t.stage_after, c.stage, `${c.ask} stage`);
    assert.equal(t.lead_temperature, c.temp, `${c.ask} temperature`);
    assert.equal(gate?.template_use_case, c.uc, `${c.ask} use case`);
    // Economics may never fabricate acceptance, in ANY band.
    assert.notEqual(t.stage_after, "formal_contract", `${c.ask} must not reach S6`);
    assert.ok(!(t.workflow_event_types || []).includes("SELLER_ACCEPTED_OFFER"), `${c.ask}`);
  }
});

test("S3 close range: first ask vs true counter", () => {
  const first = turn({ stage: "asking_price", facts: INTERESTED, message: "I want 220k", intent: "price_provided", ade: UW });
  assert.equal(first.gate?.route_id, "close_range_initial_offer");
  assert.equal(first.gate?.template_use_case, "offer_reveal_cash");

  const counter = turn({
    stage: "asking_price", facts: INTERESTED, message: "I need 220000", intent: "price_provided", ade: UW,
    ns: { latest_offer: 200_000, offers_made: [{ amount: 200_000 }] },
  });
  assert.equal(counter.gate?.route_id, "close_range_counter");
  assert.equal(counter.gate?.template_use_case, "counter_offer");
});

test("S3 wide gap: creative requires an explicit seller signal", () => {
  const silent = routeForBand(STAGE3_OFFER_BANDS.WIDE_GAP, { creative_allowed: false });
  assert.equal(silent.route_id, "wide_gap_condition");
  assert.equal(silent.template_use_case, "price_high_condition_probe");

  const signalled = routeForBand(STAGE3_OFFER_BANDS.WIDE_GAP, { creative_allowed: true });
  assert.equal(signalled.route_id, "wide_gap_creative");
  assert.equal(signalled.template_use_case, "creative_probe");
  assert.equal(signalled.inbox_bucket, "needs_review", "creative is review-only");
});

test("ANCHORS: James and Lorrie", () => {
  const james = turn({
    stage: "asking_price", facts: INTERESTED, message: "Half mil and its yours", intent: "price_provided",
    ade: { recommended_cash_offer: 160_000, max_allowable_offer: 184_000, sufficient_facts: true },
  });
  assert.equal(james.ask?.value, 500_000);
  assert.equal(james.gate?.offer_band, "very_wide_gap");
  assert.equal(james.gate?.economic_fit, "out_of_band");
  assert.equal(james.t.stage_after, "asking_price");
  assert.equal(james.t.lead_temperature, "cold");
  assert.equal(james.gate?.template_use_case, "asking_price_follow_up");

  const lorrie = turn({
    stage: "asking_price", facts: INTERESTED, message: "Number has to start with a 4", intent: "price_provided", ade: UW,
  });
  assert.equal(lorrie.ask?.value, 400_000);
  assert.equal(lorrie.ask?.price_type, "minimum");
  assert.equal(lorrie.gate?.offer_band, "very_wide_gap");
  assert.equal(lorrie.t.lead_temperature, "cold");
});

// ══════════════════════════════════════════════════════════════════════════
// S4 — CONDITION
// ══════════════════════════════════════════════════════════════════════════

test("S4 condition replies classify as condition, and corrupt no price", async () => {
  for (const m of ["It's vacant and needs a roof", "HVAC is old", "It was renovated last year", "roof is fine"]) {
    const i = await intentOf(m);
    assert.ok(["condition_disclosed", "tenant_occupied"].includes(i), `${m} -> ${i}`);
    assert.equal(priceOf(m)?.value ?? null, null, `"${m}" must not yield a price`);
  }
});

test("S4 condition alone does NOT force S5 — economics decide", () => {
  // A resolved condition on a deal that is still far out of band stays out.
  const { t, gate } = turn({
    stage: "property_condition", facts: { ...CONDITIONED, asking_price: { value: 500_000, raw: "500k" } },
    intent: "condition_disclosed",
    ade: { recommended_cash_offer: 160_000, max_allowable_offer: 184_000, sufficient_facts: true },
  });
  assert.notEqual(t.stage_after, "formal_contract");
  assert.ok(gate === null || gate.offer_band !== "auto_accept", "a bad deal stays bad after condition");
});

// ══════════════════════════════════════════════════════════════════════════
// S5 / S6 — OFFER, COUNTER, ACCEPTANCE
// ══════════════════════════════════════════════════════════════════════════

test("S5 an outbound offer creates ZERO seller facts", () => {
  const before = { ...CONDITIONED, asking_price: { value: 220_000, raw: "220k" } };
  const t = resolveSellerStageTransition({
    stage_before: "offer", known_facts: before, new_facts: {},
    intent: "no_inbound_outbound_only", ade_result: UW,
    negotiation_state: { latest_offer: 200_000, offers_made: [{ amount: 200_000 }] },
  });
  const patch = t.facts_patch || {};
  for (const key of Object.keys(patch)) {
    assert.ok(key in before, `outbound invented the fact "${key}"`);
  }
  assert.notEqual(patch.terms_accepted, true, "an outbound may never accept on the seller's behalf");
  assert.ok(!(t.workflow_event_types || []).includes("SELLER_ACCEPTED_OFFER"));
});

test("S5 a counter is a counter, and never a contract", () => {
  for (const m of ["Can you do 215?", "I need 220", "Meet me at 210"]) {
    const { t, ask } = turn({
      stage: "offer", facts: CONDITIONED, message: m, intent: "price_provided", ade: UW,
      ns: { latest_offer: 200_000, offers_made: [{ amount: 200_000 }] },
    });
    assert.ok(ask?.value > 0, `${m} must extract a counter amount`);
    assert.notEqual(t.stage_after, "formal_contract", `${m} must not reach S6`);
  }
});

test("S6 is reachable ONLY through seller acceptance evidence", () => {
  const base = {
    stage_before: "offer",
    known_facts: { ...CONDITIONED, asking_price: { value: 200_000, raw: "200k" } },
    new_facts: {}, intent: "contract_requested", ade_result: UW,
  };
  const ns = { latest_offer: 200_000, offers_made: [{ amount: 200_000 }] };

  const without = resolveSellerStageTransition({ ...base, negotiation_state: { ...ns, terms_accepted: false } });
  assert.equal(without.stage_after, "offer", "a contract request is not acceptance");
  assert.equal(without.lead_temperature, "hot", "but it IS high priority");

  const with_ = resolveSellerStageTransition({ ...base, negotiation_state: { ...ns, terms_accepted: true, accepted_price: 200_000 } });
  assert.equal(with_.stage_after, "formal_contract");
  assert.ok((with_.workflow_event_types || []).includes("SELLER_ACCEPTED_OFFER"));
});

test("S6 CONTROL: economics alone, however favourable, never reach S6", () => {
  for (const ask of [195_000, 150_000, 100_000, 50_000]) {
    const { t } = turn({
      stage: "asking_price", facts: CONDITIONED, message: `I'd take ${ask / 1000}k`,
      intent: "price_provided", ade: UW,
    });
    assert.notEqual(t.stage_after, "formal_contract", `${ask} must stop at S5`);
    assert.ok(!(t.workflow_event_types || []).includes("SELLER_ACCEPTED_OFFER"));
  }
});

test("S5 a question is not acceptance", async () => {
  for (const m of ["Is that cash?", "Who pays closing costs?"]) {
    const i = await intentOf(m);
    assert.notEqual(i, "contract_requested", `"${m}" is a question`);
    const { t } = turn({ stage: "offer", facts: CONDITIONED, intent: i, ade: UW,
      ns: { latest_offer: 200_000, offers_made: [{ amount: 200_000 }], terms_accepted: false } });
    assert.notEqual(t.stage_after, "formal_contract");
  }
});

// ══════════════════════════════════════════════════════════════════════════
// TEMPLATE LOCK — route purpose == selected template purpose, or HOLD
// ══════════════════════════════════════════════════════════════════════════

const FOREIGN = ["ownership_check", "consider_selling", "reengagement", "condition_probe",
                 "vacancy_probe", "occupancy_probe", "price_works_confirm_basics", "asks_contract"];

test("TEMPLATE LOCK: every route resolves in-purpose or fails closed", () => {
  const foreignPool = FOREIGN.map((uc, i) => ({
    id: `f${i}`, template_id: `f${i}`, use_case: uc, language: "English",
    template_body: "x", is_active: true, safe_for_auto_reply: true,
  }));
  for (const route of Object.values(STAGE3_ROUTES)) {
    const uc = route.template_use_case;
    // Only foreign templates available -> must HOLD.
    const held = resolveTemplateFromPool({ use_case: uc, language: "English" }, foreignPool);
    assert.equal(held.ok, false, `${route.route_id} must not cross purposes`);
    // Its own template available -> resolves, and to the right purpose.
    const ok = resolveTemplateFromPool({ use_case: uc, language: "English" }, [
      ...foreignPool,
      { id: `own-${uc}`, template_id: `own-${uc}`, use_case: uc, language: "English",
        template_body: "x", is_active: true, safe_for_auto_reply: true },
    ]);
    assert.equal(ok.ok, true, `${route.route_id} should resolve its own purpose`);
    assert.equal(ok.template.use_case, uc);
  }
});

test("TEMPLATE LOCK: a disabled template is never selected", () => {
  const uc = "asking_price_follow_up";
  const disabled = [{ id: "d1", template_id: "d1", use_case: uc, language: "English",
                      template_body: "x", is_active: false, safe_for_auto_reply: true }];
  assert.equal(resolveTemplateFromPool({ use_case: uc, language: "English" }, disabled).ok, false);
});

// ══════════════════════════════════════════════════════════════════════════
// NO-REPLY LOCK
// ══════════════════════════════════════════════════════════════════════════

test("NO-REPLY LOCK: silence never advances or invents, at any stage", () => {
  // Facts are matched to each stage. Starting from a LAGGING stage would
  // trigger the documented reconciliation behaviour (a non-inbound turn
  // re-derives stage from already-known facts), which is a different rule and
  // is pinned separately in acquisition-no-response-pipeline-proof.
  const STAGES = [
    ["ownership_confirmation", {}],
    ["offer_interest", { ownership_status: "confirmed" }],
    ["asking_price", { ownership_status: "confirmed", interest: "interested" }],
    // 250k is negotiable against a 230k ceiling, so the canonical route for
    // these facts IS property_condition - the stage and the economics agree.
    // A 220k ask would route to offer, and the no-reply turn would correctly
    // reconcile forward; that is the reconciliation rule, tested elsewhere.
    ["property_condition", { ownership_status: "confirmed", interest: "interested", asking_price: { value: 250_000, raw: "250k" } }],
    ["offer", CONDITIONED],
  ];
  for (const [stage, facts] of STAGES) {
    for (const intent of ["stage_no_reply", "followup_due", "no_inbound_outbound_only"]) {
      const t = resolveSellerStageTransition({
        stage_before: stage, known_facts: facts, new_facts: {}, intent, ade_result: UW,
      });
      assert.equal(t.stage_after, stage, `${intent} at ${stage} must not move the stage`);
      assert.equal(t.advanced, false, `${intent} at ${stage} must not report advancement`);

      // And it may never invent a fact.
      const patch = t.facts_patch || {};
      for (const key of Object.keys(patch)) {
        assert.ok(key in facts, `${intent} at ${stage} invented "${key}"`);
      }
      assert.equal(patch.terms_accepted ?? null, null, `${intent} must not invent acceptance`);
      assert.notEqual(t.stage_after, "formal_contract");
    }
  }
});

test("NO-REPLY LOCK: a follow-up stays inside its own communication purpose", () => {
  // Silence must not let a Stage-3 nurture drift into an S1 or S2 message.
  const { policy, stage } = (() => {
    // The registry is the authority for which purpose a stage follows up with.
    return { policy: null, stage: null };
  })();
  void policy; void stage;
  for (const [stageCode, facts] of [
    ["offer_interest", { ownership_status: "confirmed" }],
    ["asking_price", { ownership_status: "confirmed", interest: "interested" }],
  ]) {
    const t = resolveSellerStageTransition({
      stage_before: stageCode, known_facts: facts, new_facts: {}, intent: "stage_no_reply", ade_result: UW,
    });
    assert.equal(t.stage_after, stageCode, "the follow-up stays in the same stage");
  }
});

// ══════════════════════════════════════════════════════════════════════════
// AUTO-SEND POLICY — template availability is NOT send eligibility
// ══════════════════════════════════════════════════════════════════════════

test("AUTO-SEND LOCK: every price-bearing band is engine-gated to review", async () => {
  const { classifyStage3AskingPrice } = await import("@/lib/domain/seller-flow/stage3-asking-price-engine.js");
  // Production has auto-safe templates for offer_reveal_cash, counter_offer,
  // price_high_condition_probe and asking_price_follow_up. Availability is not
  // permission: the engine refuses autonomous send for EVERY band, so a
  // fabricated or surprising price cannot reach a seller unattended.
  for (const ask of [195_000, 220_000, 250_000, 300_000, 500_000, 6_245]) {
    const d = classifyStage3AskingPrice({
      seller_asking_price: ask,
      underwriting: { recommended_cash_offer: 200_000, max_allowable_offer: 230_000 },
      context: {},
    });
    assert.equal(d.auto_send_eligible, false, `${ask} must not be auto-send eligible`);
    assert.equal(d.should_mark_human_review, true, `${ask} must require review`);
    assert.equal(d.safety_tier, "review", `${ask} safety tier`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// FULL JOURNEYS A-F
// ══════════════════════════════════════════════════════════════════════════

function journey() {
  let facts = {}, stage = null, negotiation = null;
  return {
    get stage() { return stage; }, get facts() { return facts; },
    say(intent, new_facts = {}, { ade = null, ns = null } = {}) {
      if (ns) negotiation = { ...(negotiation || {}), ...ns };
      const t = resolveSellerStageTransition({
        stage_before: stage, known_facts: facts, new_facts, intent,
        ade_result: ade, negotiation_state: negotiation,
      });
      stage = t.stage_after;
      facts = { ...facts, ...(t.facts_patch || {}) };
      return t;
    },
  };
}
const askFact = (m) => ({ asking_price: priceOf(m) });

test("JOURNEY A — straightforward deal to S6", () => {
  const c = journey();
  assert.equal(c.say("ownership_confirmed", { ownership_status: "confirmed" }).stage_after, "offer_interest");
  assert.equal(c.say("seller_interested", { interest: "interested" }).stage_after, "asking_price");
  const priced = c.say("price_provided", askFact("220"), { ade: UW });
  assert.equal(priced.economic_gate?.route_id, "close_range_initial_offer");
  assert.equal(priced.stage_after, "offer");
  c.say("condition_disclosed", { occupancy_status: "vacant", condition_level: "needs work" }, { ade: UW });
  const accepted = c.say("contract_requested", {}, {
    ade: UW, ns: { latest_offer: 200_000, offers_made: [{ amount: 200_000 }], terms_accepted: true, accepted_price: 200_000 },
  });
  assert.equal(accepted.stage_after, "formal_contract");
  assert.ok((accepted.workflow_event_types || []).includes("SELLER_ACCEPTED_OFFER"));
});

test("JOURNEY B — dead economics end in cold nurture, never condition", () => {
  const ADE = { recommended_cash_offer: 160_000, max_allowable_offer: 184_000, sufficient_facts: true };
  const c = journey();
  c.say("ownership_confirmed", { ownership_status: "confirmed" });
  c.say("seller_interested", { interest: "interested" });
  const t = c.say("price_provided", askFact("Half mil"), { ade: ADE });
  assert.equal(t.economic_gate?.offer_band, "very_wide_gap");
  assert.equal(t.stage_after, "asking_price");
  assert.equal(t.lead_temperature, "cold");
  assert.equal(t.economic_gate?.template_use_case, "asking_price_follow_up");
  assert.notEqual(t.economic_gate?.template_use_case, "price_high_condition_probe");
});

test("JOURNEY C — negotiable routes through condition", () => {
  const c = journey();
  c.say("ownership_confirmed", { ownership_status: "confirmed" });
  c.say("seller_interested", { interest: "interested" });
  const t = c.say("price_provided", askFact("250"), { ade: UW });
  assert.equal(t.economic_gate?.offer_band, "negotiable");
  assert.equal(t.stage_after, "property_condition");
  assert.equal(t.economic_gate?.template_use_case, "price_high_condition_probe");
});

test("JOURNEY D — counter negotiation into acceptance", () => {
  const c = journey();
  c.say("ownership_confirmed", { ownership_status: "confirmed" });
  c.say("seller_interested", { interest: "interested" });
  c.say("price_provided", askFact("220"), { ade: UW });
  const counter = c.say("price_provided", askFact("I need 220"), {
    ade: UW, ns: { latest_offer: 200_000, offers_made: [{ amount: 200_000 }] },
  });
  assert.equal(counter.economic_gate?.route_id, "close_range_counter");
  assert.equal(counter.economic_gate?.template_use_case, "counter_offer");
  c.say("condition_disclosed", { occupancy_status: "vacant", condition_level: "needs work" }, { ade: UW });
  const accepted = c.say("contract_requested", {}, { ade: UW, ns: { terms_accepted: true, accepted_price: 200_000 } });
  assert.equal(accepted.stage_after, "formal_contract");
});

test("JOURNEY E — refusal at ANY stage is terminal for autopilot", () => {
  for (const entry of ["ownership_confirmation", "offer_interest", "asking_price", "property_condition", "offer"]) {
    const t = resolveSellerStageTransition({
      stage_before: entry, known_facts: CONDITIONED, new_facts: {}, intent: "not_interested", ade_result: UW,
    });
    assert.notEqual(t.stage_after, "formal_contract", `refusal at ${entry} must not reach contract`);
    assert.ok(
      t.disposition_patch || t.next_action !== "send_message_now",
      `refusal at ${entry} must not leave an autonomous send queued`,
    );
  }
});

test("JOURNEY F — a rich reply extracts every fact correctly", () => {
  const m = "Yeah I own it. I'd sell it for 250. Roof is about 5 years old.";
  const p = priceOf(m);
  assert.equal(p?.value, 250_000, "the price is extracted");
  assert.equal(p?.price_type, "exact");
  // "5 years old" must not corrupt the price.
  assert.notEqual(p?.value, 5);
  assert.notEqual(p?.value, 5_000);
});

/**
 * POST-CONDITION ECONOMIC AUTHORITY.
 *
 * economicStageGate used to open with `if (unresolvedIdx !== CONDITION_STAGE_IDX)
 * return null`, so economics governed only the instant where condition was the
 * next missing milestone. The moment a seller answered the condition question
 * the gate fell silent and milestone completeness walked them to the offer
 * stage regardless of band - James, having disclosed a condition, was routed to
 * an OFFER on a property he wanted $340,000 more for than we could pay.
 *
 * The gate now runs for every post-price milestone up to the offer milestone,
 * and stops at acceptance, where seller evidence outranks arithmetic.
 */
test("POST-CONDITION LOCK: economics still govern after condition resolves", () => {
  const withCondition = (value, ade = UW) =>
    resolveSellerStageTransition({
      stage_before: "property_condition",
      known_facts: {
        ownership_status: "confirmed", interest: "interested",
        asking_price: { value, raw: `${value / 1000}k` },
        occupancy_status: "vacant", condition_level: "needs work",
      },
      new_facts: {}, intent: "condition_disclosed", ade_result: ade,
    });

  // Out of band stays out of band, and returns to nurture.
  const james = withCondition(500_000, { recommended_cash_offer: 160_000, max_allowable_offer: 184_000, sufficient_facts: true });
  assert.equal(james.economic_gate?.offer_band, "very_wide_gap");
  assert.equal(james.stage_after, "asking_price", "an out-of-band ask is never an offer");
  assert.equal(james.lead_temperature, "cold", "condition cannot promote temperature");
  assert.equal(james.economic_gate?.template_use_case, "asking_price_follow_up");

  // Lorrie, condition disclosed.
  const lorrie = withCondition(400_000);
  assert.equal(lorrie.economic_gate?.offer_band, "very_wide_gap");
  assert.equal(lorrie.stage_after, "asking_price");
  assert.equal(lorrie.lead_temperature, "cold");

  // Wide gap and negotiable stay in the condition/negotiation lane.
  assert.equal(withCondition(300_000).stage_after, "property_condition");
  assert.equal(withCondition(250_000).stage_after, "property_condition");

  // And an actionable ask still reaches the offer, on economics.
  const actionable = withCondition(195_000);
  assert.equal(actionable.economic_gate?.offer_band, "auto_accept");
  assert.equal(actionable.stage_after, "offer");
  assert.equal(actionable.lead_temperature, "hot");
});

test("POST-CONDITION LOCK: acceptance outranks economics, both ways", () => {
  const F = {
    ownership_status: "confirmed", interest: "interested",
    asking_price: { value: 200_000, raw: "200k" },
    occupancy_status: "vacant", condition_level: "needs work",
  };
  const ns = { latest_offer: 200_000, offers_made: [{ amount: 200_000 }] };

  // Acceptance reaches S6 even though the gate is now active post-condition.
  const accepted = resolveSellerStageTransition({
    stage_before: "offer", known_facts: F, new_facts: {}, intent: "contract_requested",
    ade_result: UW, negotiation_state: { ...ns, terms_accepted: true, accepted_price: 200_000 },
  });
  assert.equal(accepted.stage_after, "formal_contract");

  // And bad economics can never pull an accepted deal back out of S6.
  const stillS6 = resolveSellerStageTransition({
    stage_before: "formal_contract", known_facts: F, new_facts: {}, intent: "acknowledgement",
    ade_result: { recommended_cash_offer: 160_000, max_allowable_offer: 184_000, sufficient_facts: true },
    negotiation_state: { ...ns, terms_accepted: true },
  });
  assert.equal(stillS6.stage_after, "formal_contract", "arithmetic may not undo acceptance");
});

test("POST-CONDITION LOCK: a revealed offer floors the stage, James does not", () => {
  // Once we have actually presented an offer the deal is in negotiation, and a
  // wider counter must not walk it back to a condition probe. Nothing was ever
  // presented to James, which is why he DOES return to nurture.
  const negotiating = resolveSellerStageTransition({
    stage_before: "offer",
    known_facts: { ownership_status: "confirmed", interest: "interested", asking_price: { value: 300_000, raw: "300k" } },
    new_facts: {}, intent: "price_provided", ade_result: UW,
    negotiation_state: { latest_offer: 200_000, offers_made: [{ amount: 200_000 }] },
  });
  assert.equal(negotiating.stage_after, "offer", "a presented offer floors the lifecycle");

  const neverOffered = resolveSellerStageTransition({
    stage_before: "property_condition",
    known_facts: { ownership_status: "confirmed", interest: "interested", asking_price: { value: 500_000, raw: "500k" },
                   occupancy_status: "vacant", condition_level: "needs work" },
    new_facts: {}, intent: "price_provided",
    ade_result: { recommended_cash_offer: 160_000, max_allowable_offer: 184_000, sufficient_facts: true },
  });
  assert.equal(neverOffered.stage_after, "asking_price", "nothing presented, so nurture wins");
});

test("JOURNEY G — dead economics with condition known never reaches S5", () => {
  const ADE = { recommended_cash_offer: 160_000, max_allowable_offer: 184_000, sufficient_facts: true };
  const c = journey();
  c.say("ownership_confirmed", { ownership_status: "confirmed" });
  c.say("seller_interested", { interest: "interested" });
  c.say("price_provided", askFact("Half mil"), { ade: ADE });
  const afterCondition = c.say("condition_disclosed", { occupancy_status: "vacant", condition_level: "needs work" }, { ade: ADE });
  assert.equal(afterCondition.economic_gate?.offer_band, "very_wide_gap");
  assert.equal(afterCondition.stage_after, "asking_price", "condition does not rescue dead economics");
  assert.equal(afterCondition.lead_temperature, "cold");
  assert.notEqual(afterCondition.economic_gate?.template_use_case, "offer_reveal_cash");
});

test("JOURNEY H — condition that changes the economics changes the workflow", () => {
  // Deterministic: the SAME ask, evaluated against underwriting before and
  // after condition moves the numbers. Proves condition feeds economics rather
  // than ticking a milestone box.
  const ask = { asking_price: { value: 195_000, raw: "195k" } };
  const facts = { ownership_status: "confirmed", interest: "interested", ...ask };
  const withCond = { ...facts, occupancy_status: "vacant", condition_level: "full_rehab" };

  const before = resolveSellerStageTransition({
    stage_before: "asking_price", known_facts: facts, new_facts: {}, intent: "price_provided",
    ade_result: { recommended_cash_offer: 200_000, max_allowable_offer: 230_000, sufficient_facts: true },
  });
  // Condition reveals a full rehab; underwriting drops.
  const after = resolveSellerStageTransition({
    stage_before: "property_condition", known_facts: withCond, new_facts: {}, intent: "condition_disclosed",
    ade_result: { recommended_cash_offer: 120_000, max_allowable_offer: 138_000, sufficient_facts: true },
  });

  assert.equal(before.economic_gate?.offer_band, "auto_accept", "before condition the deal looked executable");
  assert.equal(before.stage_after, "offer");
  assert.notEqual(after.economic_gate?.offer_band, "auto_accept", "after condition it is not");
  assert.notEqual(after.stage_after, "offer", "and the workflow follows the AFTER economics");
  assert.notEqual(before.economic_gate?.offer_band, after.economic_gate?.offer_band);
});
