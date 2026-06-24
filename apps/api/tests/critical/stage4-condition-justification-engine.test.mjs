import "../register-aliases.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const {
  classifyStage4Condition,
  STAGE4_OUTCOMES,
  REPAIR_SEVERITY,
  OCCUPANCY_STATUS,
} = await import("../../src/lib/domain/seller-flow/stage4-condition-justification-engine.js");

const { ACQUISITION_LIFECYCLE_EVENTS: EV } = await import(
  "../../src/lib/domain/seller-flow/acquisition-lifecycle-events.js"
);

const FIXED_NOW = "2026-06-23T12:00:00.000Z";

const UW_READY = {
  recommended_cash_offer: 175000,
  max_allowable_offer: 185000,
  repair_estimate: 30000,
  lowest_relevant_comp: 210000,
  arv: 240000,
};

function run(message, { seller_asking_price = 230000, stage3_evaluation = null, underwriting = UW_READY, context = {} } = {}) {
  return classifyStage4Condition({
    message,
    seller_asking_price,
    stage3_evaluation,
    underwriting,
    context: {
      now: FIXED_NOW,
      entities: { property_id: "p1", master_owner_id: "o1", prospect_id: "pr1", contact_point_id: "c1" },
      ...context,
    },
  });
}

const types = (d) => d.events.map((e) => e.type);
const has = (d, t) => types(d).includes(t);

// ── Condition / repair facts ─────────────────────────────────────────────────

test('"needs a roof" → repair_issue_disclosed, moderate, repair event captured', () => {
  const d = run("needs a roof");
  assert.equal(d.outcome, STAGE4_OUTCOMES.REPAIR_ISSUE_DISCLOSED);
  assert.equal(d.repair_severity, REPAIR_SEVERITY.MODERATE);
  assert.ok(d.repair_facts.some((f) => f.key === "roof"));
  assert.ok(has(d, EV.CONDITION_FACT_CAPTURED));
  assert.ok(has(d, EV.REPAIR_ISSUE_CAPTURED));
});

test('"foundation is bad" → major_repairs, major severity → justify (S4)', () => {
  const d = run("foundation is bad");
  assert.equal(d.outcome, STAGE4_OUTCOMES.MAJOR_REPAIRS);
  assert.equal(d.repair_severity, REPAIR_SEVERITY.MAJOR);
  assert.equal(d.route, "justify_price");
  assert.equal(d.should_reveal_offer, true);
  assert.ok(has(d, EV.PRICE_JUSTIFICATION_REQUESTED));
});

test('"it only needs paint" → light_repairs, light severity', () => {
  const d = run("it only needs paint");
  assert.equal(d.outcome, STAGE4_OUTCOMES.LIGHT_REPAIRS);
  assert.equal(d.repair_severity, REPAIR_SEVERITY.LIGHT);
});

test('"needs everything" → major_repairs', () => {
  const d = run("needs everything");
  assert.equal(d.outcome, STAGE4_OUTCOMES.MAJOR_REPAIRS);
  assert.equal(d.repair_severity, REPAIR_SEVERITY.MAJOR);
});

// ── Occupancy ────────────────────────────────────────────────────────────────

test('"tenant is living there" → tenant_occupied, occupancy captured', () => {
  const d = run("tenant is living there");
  assert.equal(d.outcome, STAGE4_OUTCOMES.TENANT_OCCUPIED);
  assert.equal(d.occupancy_status, OCCUPANCY_STATUS.OCCUPIED_TENANT);
  assert.equal(d.template_use_case, "has_tenants");
  assert.ok(has(d, EV.OCCUPANCY_STATUS_CAPTURED));
});

test('"it\'s vacant" → vacant_or_boarded', () => {
  const d = run("it's vacant");
  assert.equal(d.outcome, STAGE4_OUTCOMES.VACANT_OR_BOARDED);
  assert.equal(d.occupancy_status, OCCUPANCY_STATUS.VACANT);
  assert.ok(has(d, EV.OCCUPANCY_STATUS_CAPTURED));
});

// ── Price justification challenges ───────────────────────────────────────────

test('"how did you come up with that number" → asks_how_offer_calculated, justify, mixed basis', () => {
  const d = run("how did you come up with that number");
  assert.equal(d.outcome, STAGE4_OUTCOMES.ASKS_HOW_OFFER_CALCULATED);
  assert.equal(d.route, "justify_price");
  assert.equal(d.offer_justification_basis, "mixed"); // repair_estimate + comp both present
  assert.ok(has(d, EV.PRICE_JUSTIFICATION_REQUESTED));
});

test('"your repair estimate is wrong" → challenges_repair_estimate, repair_estimate basis', () => {
  const d = run("your repair estimate is wrong");
  assert.equal(d.outcome, STAGE4_OUTCOMES.CHALLENGES_REPAIR_ESTIMATE);
  assert.equal(d.offer_justification_basis, "repair_estimate");
});

// ── Negotiation flexibility ──────────────────────────────────────────────────

test('"what\'s your best offer" → asks_for_best_offer → narrow_range (S5)', () => {
  const d = run("what's your best offer");
  assert.equal(d.outcome, STAGE4_OUTCOMES.ASKS_FOR_BEST_OFFER);
  assert.equal(d.route, "narrow_range");
  assert.equal(d.stage_code, "S5");
  assert.ok(has(d, EV.PRICE_GAP_NARROWING_OPENED));
});

test('"I can come down a little" → price_flexibility_detected, high flexibility score', () => {
  const d = run("I can come down a little");
  assert.equal(d.outcome, STAGE4_OUTCOMES.PRICE_FLEXIBILITY_DETECTED);
  assert.ok(d.seller_flexibility_score >= 65);
  assert.equal(d.route, "narrow_range");
});

test('"price is firm" (ask within range, no wide gap) → price_firm → justify_price', () => {
  // 190k is above MAO (185k) but inside the 1.15x wide-gap threshold (212.75k).
  const d = run("price is firm", { seller_asking_price: 190000 });
  assert.equal(d.outcome, STAGE4_OUTCOMES.PRICE_FIRM);
  assert.equal(d.wide_gap, false);
  assert.equal(d.route, "justify_price");
});

// ── Photos / walkthrough ─────────────────────────────────────────────────────

test('"send someone to look" → needs_photos_or_walkthrough → walkthrough template', () => {
  const d = run("send someone to look");
  assert.equal(d.outcome, STAGE4_OUTCOMES.NEEDS_PHOTOS_OR_WALKTHROUGH);
  assert.equal(d.template_use_case, "walkthrough_or_condition");
  assert.ok(has(d, EV.CONDITION_INFO_REQUESTED));
});

test('"I can send photos" → needs_photos_or_walkthrough → photo_request template', () => {
  const d = run("I can send photos");
  assert.equal(d.outcome, STAGE4_OUTCOMES.NEEDS_PHOTOS_OR_WALKTHROUGH);
  assert.equal(d.template_use_case, "photo_request");
});

// ── Ready for offer reveal ───────────────────────────────────────────────────

test("seller asks offer after condition disclosed → ready_for_offer → S5 reveal", () => {
  const d = run("ok go ahead and send me your offer");
  assert.equal(d.outcome, STAGE4_OUTCOMES.READY_FOR_OFFER);
  assert.equal(d.route, "offer_reveal");
  assert.equal(d.stage_code, "S5");
  assert.equal(d.should_reveal_offer, true);
  assert.ok(has(d, EV.READY_FOR_OFFER_REVEAL));
});

test("ready for offer reveal when underwriting ready", () => {
  const d = run("send me your offer");
  assert.equal(d.should_reveal_offer, true);
  assert.equal(d.template_use_case, "offer_reveal_cash");
});

// ── Multilingual ─────────────────────────────────────────────────────────────

test("Spanish condition disclosure (necesita techo nuevo → roof)", () => {
  const d = run("necesita techo nuevo");
  assert.equal(d.outcome, STAGE4_OUTCOMES.REPAIR_ISSUE_DISCLOSED);
  assert.ok(d.repair_facts.some((f) => f.key === "roof"));
});

test("Spanish tenant occupied (está rentada)", () => {
  const d = run("está rentada");
  assert.equal(d.outcome, STAGE4_OUTCOMES.TENANT_OCCUPIED);
  assert.equal(d.occupancy_status, OCCUPANCY_STATUS.OCCUPIED_TENANT);
});

// ── Unclear / no underwriting / creative wide gap ────────────────────────────

test("unclear condition reply → human review", () => {
  const d = run("hmm ok sure thing");
  assert.equal(d.outcome, STAGE4_OUTCOMES.UNCLEAR);
  assert.equal(d.route, "human_review");
  assert.ok(has(d, EV.CONDITION_HUMAN_REVIEW_REQUIRED));
});

test("no underwriting available → never reveals, routes to gather data", () => {
  const d = run("foundation is bad", { underwriting: {} });
  assert.equal(d.outcome, STAGE4_OUTCOMES.MAJOR_REPAIRS);
  assert.equal(d.underwriting_ready, false);
  assert.equal(d.should_reveal_offer, false);
  assert.equal(d.route, "condition_probe");
});

test("price firm + wide gap + creative eligible → creative finance", () => {
  const d = run("price is firm", {
    stage3_evaluation: { offer_band: "wide_gap" },
    context: { creative_allowed: true },
  });
  assert.equal(d.outcome, STAGE4_OUTCOMES.PRICE_FIRM);
  assert.equal(d.wide_gap, true);
  assert.equal(d.route, "creative_finance");
  assert.ok(has(d, EV.CREATIVE_TERMS_PROPOSED));
});

test("price firm + wide gap + NOT creative eligible → nurture", () => {
  const d = run("price is firm", {
    stage3_evaluation: { offer_band: "very_wide_gap" },
    context: { creative_allowed: false },
  });
  assert.equal(d.route, "nurture");
  assert.equal(d.stage_code, "S3F");
  assert.ok(has(d, EV.DEAL_NURTURE_TRIGGERED));
  assert.equal(d.follow_up_policy.schedule, true);
});

test('"open to terms" → creative_terms_possible → S4C creative_probe', () => {
  const d = run("I'd be open to terms or owner financing");
  assert.equal(d.outcome, STAGE4_OUTCOMES.CREATIVE_TERMS_POSSIBLE);
  assert.equal(d.stage_code, "S4C");
  assert.ok(has(d, EV.CREATIVE_TERMS_PROPOSED));
});

// ── Metrics + event payload shape ────────────────────────────────────────────

test("computes condition metrics and completeness", () => {
  const d = run("tenant is living there, needs a roof, I can send photos");
  // repairs known + occupancy known + access (photos) known → 3/3
  assert.equal(d.condition_data_completeness, 1);
  assert.ok(d.condition_confidence >= 0.7);
});

test("CONDITION_FACT_CAPTURED carries facts + full entity graph", () => {
  const d = run("foundation is bad");
  const e = d.events.find((ev) => ev.type === EV.CONDITION_FACT_CAPTURED);
  assert.equal(e.occurred_at, FIXED_NOW);
  assert.equal(e.data.repair_severity, REPAIR_SEVERITY.MAJOR);
  assert.deepEqual(e.entities, {
    property_id: "p1",
    master_owner_id: "o1",
    prospect_id: "pr1",
    contact_point_id: "c1",
  });
});

test("price/offer routes never auto-send", () => {
  for (const msg of ["foundation is bad", "what's your best offer", "send me your offer", "how did you get that number"]) {
    const d = run(msg);
    assert.equal(d.auto_send_eligible, false, msg);
    assert.equal(d.safety_tier, "review", msg);
  }
});
