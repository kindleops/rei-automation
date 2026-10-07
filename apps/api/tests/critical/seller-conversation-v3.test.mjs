/**
 * SELLER CONVERSATION MACHINE v3 (owner brief 2026-10-06 late): the checklist
 * state machine, the price-vs-value branches, multifamily per-door anchors,
 * the who/why loop, the repeat guard, and the no-review policy for S1/S2.
 * Pure planner tests — no network, no DB.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  planSellerConversationV3,
  applySellerConversationV3,
  applySellerConversationV3TerminalDecision,
  deriveChecklist,
  missingChecklist,
  classifyPriceAgainstValue,
  computePerDoorAnchor,
  resolveV3ValueAuthority,
  isSellerConversationV3Active,
  applyRepeatGuard,
  V3_USE_CASES as U,
  V3_TERMINAL,
  V3_ACTIONS,
  PRICE_BRANCHES,
  V3_CONFIG,
} from "@/lib/domain/seller-flow/seller-conversation-v3.js";
import { INTENT_PRIORITY } from "@/lib/domain/classification/classify.js";

const NOW = Date.parse("2026-10-06T18:00:00Z");
const C = (primary_intent, extra = {}) => ({ primary_intent, language: "English", automation_decision: {}, ...extra });
const STAGE = { S1: "ownership_confirmation", S2: "offer_interest", S3: "asking_price", S4: "property_condition" };
const ctx = (last_outbound_template_use_case = null) => (last_outbound_template_use_case ? { last_outbound_template_use_case } : null);
const plan = (p) => planSellerConversationV3({ now: NOW, ...p });

function snapshot({ value = 200_000, offer = 120_000, mao = 140_000, comps = [] } = {}) {
  return {
    property_id: "p1",
    computed_at: "2026-10-05T12:00:00Z",
    decision_tier: "AUTO_HARD_OFFER",
    valuation_mid: value,
    recommended_cash_offer: offer,
    estimated_repairs: 20_000,
    evidence: {
      offer_calculation: { effective_authorized_ceiling: mao },
      subject: { asset_type: "single_family", normalized_features: { estimated_value: value } },
      selected_comps: comps,
    },
  };
}
const trusted = (value = 200_000) => resolveV3ValueAuthority({ ade_snapshot: snapshot({ value, offer: value * 0.6, mao: value * 0.7 }), now: NOW });

test("flags: v3 is active only with BOTH SELLER_CONVERSATION_V3 and SELLER_AUTOPILOT_V2", () => {
  assert.equal(isSellerConversationV3Active({}), false);
  assert.equal(isSellerConversationV3Active({ SELLER_CONVERSATION_V3: "1" }), false);
  assert.equal(isSellerConversationV3Active({ SELLER_AUTOPILOT_V2: "1" }), false);
  assert.equal(isSellerConversationV3Active({ SELLER_CONVERSATION_V3: "1", SELLER_AUTOPILOT_V2: "1" }), true);
});

test("checklist: collects across turns and asks ONLY for what is missing", () => {
  const cl = deriveChecklist({ known_facts: {}, stage: "S1_ownership", classification: C("ownership_confirmed"), message: "Yes", now: NOW });
  assert.deepEqual(missingChecklist(cl), ["interest", "asking_price", "condition", "occupancy"]);
  // Condition already known -> after a price near value the next ask is occupancy, not condition.
  const p = plan({
    classification: C("asking_price_provided"), message: "210k", stage_before: STAGE.S3, asking_price_this_turn: 210_000,
    known_facts: { condition_disclosed: true, condition_level: "good" }, value_authority: trusted(200_000),
  });
  assert.equal(p.action, V3_ACTIONS.REPLY);
  assert.equal(p.template_use_case, U.OCCUPANCY);
  // Occupancy volunteered in the same message is never asked for.
  const p2 = plan({ classification: C("condition_disclosed"), message: "Needs a new roof, it's vacant", stage_before: STAGE.S4, known_facts: { asking_price: 150_000 }, value_authority: trusted(200_000) });
  assert.ok(!p2.missing.includes("occupancy"));
  assert.ok(!p2.missing.includes("condition"));
});

test("checklist: update years are a condition fact; a generic condition answer gets ONE update-year follow-up", () => {
  const cl = deriveChecklist({ known_facts: {}, stage: "S4_condition", classification: C("unclear"), message: "roof 2020, kitchen 2018", now: NOW });
  assert.equal(cl.condition.collected, true);
  assert.deepEqual(cl.condition.update_years.map((f) => [f.component, f.year]), [["roof", 2020], ["kitchen", 2018]]);
  const first = plan({ classification: C("condition_disclosed"), message: "It's in good shape", stage_before: STAGE.S4, known_facts: { asking_price: 210_000 }, value_authority: trusted(200_000) });
  assert.equal(first.template_use_case, U.UPDATE_YEARS);
  const again = plan({ classification: C("condition_disclosed"), message: "It's in good shape", stage_before: STAGE.S4, known_facts: { asking_price: 210_000 }, value_authority: trusted(200_000), conversation_context: ctx(U.UPDATE_YEARS) });
  assert.notEqual(again.template_use_case, U.UPDATE_YEARS);
});

test("price vs value thresholds (SFR): far above / near / below / no trusted value", () => {
  assert.equal(classifyPriceAgainstValue(500_000, 200_000).branch, PRICE_BRANCHES.FAR_ABOVE);
  assert.equal(classifyPriceAgainstValue(1_000_000, 200_000).branch, PRICE_BRANCHES.FAR_ABOVE);
  assert.equal(classifyPriceAgainstValue(301_000, 200_000).branch, PRICE_BRANCHES.FAR_ABOVE, "> value + $100K");
  assert.equal(classifyPriceAgainstValue(290_000, 200_000).branch, PRICE_BRANCHES.NEAR, "+$90K and 1.45x is near");
  assert.equal(classifyPriceAgainstValue(200_000, 175_000).branch, PRICE_BRANCHES.NEAR);
  assert.equal(classifyPriceAgainstValue(120_000, 170_000).branch, PRICE_BRANCHES.BELOW);
  assert.equal(classifyPriceAgainstValue(160_000, 170_000).branch, PRICE_BRANCHES.NEAR, "within 10% under value is near");
  assert.equal(classifyPriceAgainstValue(200_000, null).branch, PRICE_BRANCHES.NO_VALUE);
  assert.equal(V3_CONFIG.far_above_ratio, 1.5);
  assert.equal(V3_CONFIG.far_above_delta, 100_000);
});

test("far above value: the 'seriously considering' nurture, NO condition ask", () => {
  const p = plan({ classification: C("asking_price_provided"), message: "500k", stage_before: STAGE.S3, asking_price_this_turn: 500_000, value_authority: trusted(200_000) });
  assert.equal(p.price_branch, PRICE_BRANCHES.FAR_ABOVE);
  assert.equal(p.template_use_case, U.FAR_ABOVE_NURTURE);
  assert.equal(p.then, V3_TERMINAL.NURTURE);
  assert.ok(!p.template_preference.some((uc) => /condition/.test(uc)));
});

test("near value -> condition (+ occupancy); below value -> condition + occupancy -> offer path", () => {
  const near = plan({ classification: C("asking_price_provided"), message: "200k", stage_before: STAGE.S3, asking_price_this_turn: 200_000, value_authority: trusted(175_000) });
  assert.equal(near.template_use_case, U.CONDITION_NEAR_VALUE);
  const below = plan({ classification: C("asking_price_provided"), message: "120k", stage_before: STAGE.S3, asking_price_this_turn: 120_000, value_authority: trusted(170_000) });
  assert.equal(below.template_use_case, U.BELOW_VALUE_BASICS);
  // Below value with condition + occupancy known: the offer path (MAO-capped as-is anchor).
  const comps = [0.3, 0.5, 0.7, 0.9].map((d, i) => ({ comp_id: `c${i}`, sale_price: 150_000 + i * 5_000, distance_miles: d, sale_date: "2026-08-01" }));
  const ade = snapshot({ value: 170_000, offer: 100_000, mao: 119_000, comps });
  const offer_authority = { ok: true, offer: 100_000, mao: 119_000, comps, snapshot_id: "s1", computed_at: "2026-10-05T12:00:00Z", engine_version: "x", decision_tier: "AUTO_HARD_OFFER" };
  const ready = plan({
    classification: C("tenant_occupied"), message: "Tenant in place", stage_before: STAGE.S4, asking_price_this_turn: null,
    known_facts: { asking_price: 120_000, condition_disclosed: true, condition_level: "fair" }, value_authority: resolveV3ValueAuthority({ ade_snapshot: ade, now: NOW }), offer_authority,
  });
  assert.equal(ready.action, V3_ACTIONS.REPLY);
  assert.ok([U.ANCHOR_COMPS, U.ANCHOR_ABOVE_MAX].includes(ready.template_use_case));
  assert.ok(ready.monetary.amount <= 119_000, "never above MAO");
});

test("no trusted value: still ask condition, never a number", () => {
  const p = plan({ classification: C("asking_price_provided"), message: "240k", stage_before: STAGE.S3, asking_price_this_turn: 240_000, value_authority: { trusted: false, reason: "no_engine_snapshot" } });
  assert.equal(p.price_branch, PRICE_BRANCHES.NO_VALUE);
  assert.ok([U.CONDITION_NEAR_VALUE, U.CONDITION_CLARIFIER].includes(p.template_use_case));
  assert.equal(p.monetary, null);
  // "I don't know / make me an offer" -> "I can run the numbers — condition?"
  const none = plan({ classification: C("asking_price_absent"), message: "I don't know", stage_before: STAGE.S3 });
  assert.equal(none.template_use_case, U.NO_PRICE_CONDITION);
  // Checklist complete, no offer authority -> "let me run the numbers", no number.
  const done = plan({ classification: C("tenant_occupied"), message: "It's rented", stage_before: STAGE.S4, known_facts: { asking_price: 240_000, condition_disclosed: true } });
  assert.equal(done.template_use_case, U.NUMBERS_PENDING);
  assert.equal(done.monetary, null);
});

test("value authority: engine value guarded by offer-sanity (fail closed)", () => {
  assert.equal(resolveV3ValueAuthority({ ade_snapshot: null }).trusted, false);
  assert.equal(trusted(200_000).trusted, true);
  const insane = snapshot({ value: 230_000, offer: 11_800, mao: 27_300 }); // 627 Ontario shape
  assert.equal(resolveV3ValueAuthority({ ade_snapshot: insane, now: NOW }).trusted, false);
  const old = { ...snapshot(), computed_at: "2026-09-01T00:00:00Z" };
  assert.equal(resolveV3ValueAuthority({ ade_snapshot: old, now: NOW }).trusted, false);
});

test("multifamily: per-door range from real MF comps, outliers out, capped at MAO per door", () => {
  const mk = (id, price, units, dist, src = "Public Record Sold") => ({ id, sale_price: price, units_count: units, distance_miles: dist, sale_date: "2026-06-01", sale_source: src });
  const comps = [mk("a", 260_000, 4, 1.2), mk("b", 300_000, 4, 2.5), mk("c", 150_000, 2, 0.8), mk("d", 340_000, 4, 2.9), mk("e", 40_000, 4, 1.0), mk("f", 900_000, 2, 1.1), mk("g", 500_000, 6, 4.5)];
  const a = computePerDoorAnchor({ comps, units: 4, mao: 360_000, now: NOW });
  assert.equal(a.ok, true);
  assert.ok(!a.comp_ids.includes("e") && !a.comp_ids.includes("f"), "outliers dropped");
  assert.ok(!a.comp_ids.includes("g"), "outside 3 mi");
  assert.ok(a.per_door_low <= a.per_door_high);
  assert.ok(a.per_door_high <= 90_000, "capped at MAO / units");
  assert.equal(a.per_door_low % 5_000, 0);
  assert.equal(computePerDoorAnchor({ comps: comps.slice(0, 2), units: 4, now: NOW }).ok, false);
  const p = plan({
    classification: C("tenant_occupied"), message: "All 4 rented", stage_before: STAGE.S4,
    known_facts: { asking_price: 400_000, condition_disclosed: true }, property_metadata: { property_type: "Multi-Family (2-4 Unit)", unit_count: 4 },
    mf_door_comps: comps, offer_authority: { ok: false, mao: 360_000 },
  });
  assert.equal(p.template_use_case, U.MF_PER_DOOR_ANCHOR);
  assert.equal(p.monetary.kind, "negotiation_anchor_per_door");
  // No comps -> a money hold at S4+ (never at S1/S2).
  const hold = plan({ classification: C("tenant_occupied"), message: "All rented", stage_before: STAGE.S4, known_facts: { asking_price: 400_000, condition_disclosed: true }, property_metadata: { unit_count: 4 } });
  assert.equal(hold.action, V3_ACTIONS.REVIEW);
  assert.equal(hold.stage, "S4_condition");
});

test("who / why / how'd you get my number: local-investor answer, a different 2nd answer, then archive; resumes the stage", () => {
  const first = plan({ classification: C("who_is_this"), message: "Who is this?", stage_before: STAGE.S1 });
  assert.equal(first.template_use_case, U.WHO);
  assert.equal(first.resume_stage, "S1_ownership");
  const second = plan({ classification: C("who_is_this"), message: "How did you get my number?", stage_before: STAGE.S2, conversation_context: ctx(U.WHO), recent_outbound: [{ use_case: U.WHO }] });
  assert.equal(second.template_use_case, U.INFO_SOURCE);
  const third = plan({ classification: C("who_is_this"), message: "Why?", stage_before: STAGE.S2, conversation_context: ctx(U.INFO_SOURCE), recent_outbound: [{ use_case: U.INFO_SOURCE }, { use_case: U.WHO }] });
  assert.equal(third.action, V3_ACTIONS.TERMINAL);
  assert.equal(third.terminal_action, V3_TERMINAL.ARCHIVE);
  const s3 = plan({ classification: C("who_is_this"), message: "why do you ask", stage_before: STAGE.S3 });
  assert.equal(s3.template_use_case, U.WHO_S3, "resume at the price question");
});

test("repeat guard: never the identical use case twice in a row", () => {
  const g = applyRepeatGuard([U.CONDITION_CLARIFIER, U.REPAIR_CLARIFICATION], { conversation_context: ctx(U.CONDITION_CLARIFIER) });
  assert.deepEqual(g.preference, [U.REPAIR_CLARIFICATION]);
  const p = plan({ classification: C("asking_price_absent"), message: "no idea", stage_before: STAGE.S3, conversation_context: ctx(U.NO_PRICE_CONDITION) });
  assert.notEqual(p.template_use_case, U.NO_PRICE_CONDITION);
});

test("unclear: re-ask once, then archive (S1/S2) or nurture (S3+)", () => {
  const once = plan({ classification: C("unclear"), message: "Vues", stage_before: STAGE.S1 });
  assert.equal(once.template_use_case, U.REASK_OWNERSHIP);
  const twice = plan({ classification: C("unclear"), message: "Ñ", stage_before: STAGE.S1, conversation_context: ctx(U.REASK_OWNERSHIP) });
  assert.equal(twice.terminal_action, V3_TERMINAL.ARCHIVE);
  const s3 = plan({ classification: C("unclear"), message: "hmm", stage_before: STAGE.S3, conversation_context: ctx(U.ASK_PRICE_FOLLOW_UP) });
  assert.equal(s3.terminal_action, V3_TERMINAL.NURTURE);
  const signoff = plan({ classification: C("unclear"), message: "Have a great day", stage_before: STAGE.S1 });
  assert.equal(signoff.terminal_action, V3_TERMINAL.WAIT);
});

test("hostile / troll: no reply, quiet archive, NOT suppression, no review, no alert; a legal threat keeps the human lane", () => {
  for (const [intent, msg] of [["hostile_or_legal", "Fuck off"], ["hostile_or_troll", "shitstains on the walls"], ["hostile_or_legal", "None of your business!"]]) {
    const p = plan({ classification: C(intent), message: msg, stage_before: STAGE.S1 });
    assert.equal(p.action, V3_ACTIONS.TERMINAL, msg);
    assert.equal(p.terminal_action, V3_TERMINAL.ARCHIVE, msg);
    assert.equal(p.inbox_bucket, "dead");
    assert.equal(p.alert, false);
    const applied = applySellerConversationV3(C(intent, { automation_decision: { human_review_required: true } }), p);
    assert.equal(applied.classification.automation_decision.human_review_required, false);
    assert.equal(applied.classification.automation_decision.suppression_action, "none", "an insult never suppresses");
    assert.equal(applied.strategyDirective, null);
  }
  const legal = plan({ classification: C("hostile_or_legal"), message: "Text me again and my lawyer will sue you", stage_before: STAGE.S1 });
  assert.equal(legal.action, V3_ACTIONS.REVIEW);
});

test("referrals: a number is captured (terminal), otherwise ask once for the best contact, then archive the pairing", () => {
  const withNumber = plan({ classification: C("unclear"), message: "Call 555-010-0199 and talk to Charles.", stage_before: STAGE.S1 });
  assert.equal(withNumber.terminal_action, V3_TERMINAL.REFERRAL_CAPTURE);
  const ask = plan({ classification: C("property_specific_non_owner"), message: "I'm not the owner, my brother is", stage_before: STAGE.S1 });
  assert.equal(ask.template_use_case, U.REFERRAL_BEST_CONTACT);
  const again = plan({ classification: C("property_specific_non_owner"), message: "not me", stage_before: STAGE.S1, conversation_context: ctx(U.REFERRAL_BEST_CONTACT) });
  assert.equal(again.terminal_action, V3_TERMINAL.ARCHIVE_PROPERTY);
});

test("NO S1/S2 intent ends in human review (every classifier intent, both stages)", () => {
  const offenders = [];
  for (const intent of INTENT_PRIORITY) {
    for (const stage_before of [STAGE.S1, STAGE.S2]) {
      const msg = intent === "hostile_or_legal" ? "go away" : "x";
      const p = plan({ classification: C(intent), message: msg, stage_before });
      if (p.action === V3_ACTIONS.REVIEW) offenders.push(`${intent}@${stage_before}:${p.reasoning_code}`);
      assert.ok([V3_ACTIONS.REPLY, V3_ACTIONS.TERMINAL, V3_ACTIONS.DEFER].includes(p.action), `${intent}: ${p.action}`);
      if (p.action === V3_ACTIONS.DEFER) assert.ok(p.lane, `${intent}: a defer names its automatic lane`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("executor hook: a v3 terminal neither replies nor reviews; suppression always passes through", () => {
  const before = { SELLER_CONVERSATION_V3: process.env.SELLER_CONVERSATION_V3, SELLER_AUTOPILOT_V2: process.env.SELLER_AUTOPILOT_V2 };
  const env = { SELLER_CONVERSATION_V3: "1", SELLER_AUTOPILOT_V2: "1" };
  const cls = { seller_conversation_v3: { action: "terminal", terminal_action: V3_TERMINAL.ARCHIVE, reasoning_code: "v3_troll_archived_no_reply" } };
  const review = { should_queue_reply: false, should_mark_human_review: true, should_suppress_contact: false, human_review_reason: "hostile_or_legal" };
  const out = applySellerConversationV3TerminalDecision(review, cls, env);
  assert.equal(out.should_mark_human_review, false);
  assert.equal(out.should_queue_reply, false);
  const suppress = { should_suppress_contact: true, should_mark_human_review: false };
  assert.equal(applySellerConversationV3TerminalDecision(suppress, cls, env), suppress);
  assert.equal(applySellerConversationV3TerminalDecision(review, cls, {}), review, "flags off: untouched");
  void before;
});

test("directives: a reply is an exact-preference immediate send; money rides the deal-authority patch", () => {
  const p = plan({ classification: C("ownership_confirmed"), message: "Yes", stage_before: STAGE.S1 });
  const applied = applySellerConversationV3(C("ownership_confirmed"), p);
  assert.equal(applied.strategyDirective.next_action, "send_message_now");
  assert.deepEqual(applied.strategyDirective.template_preference, [U.INTEREST, U.INTEREST_FOLLOW_UP]);
  assert.equal(applied.dealAuthorityPatch, null);
  assert.equal(applied.classification.automation_decision.human_review_required, false);
});
