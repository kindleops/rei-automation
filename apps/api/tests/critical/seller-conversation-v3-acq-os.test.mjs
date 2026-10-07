/**
 * Acquisition OS v1 (§20–40, §59–66, §83, §90, §93) on SELLER CONVERSATION
 * MACHINE v3: contextual yes, connected persons + Contact Matching Tags,
 * conditional interest, deterministic number rules, the highest-value S4
 * question, the §33 checklist states and their persistence, the audit trail /
 * research log, the four contact-history truths + retext rule, and the
 * suppression guarantees. No network, no DB.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  planSellerConversationV3,
  applySellerConversationV3,
  applySellerConversationV3TerminalDecision,
  deriveChecklist,
  checklistState,
  selectS4Question,
  statedAskingPrice,
  majorRepairsFromMessage,
  occupancyFromMessage,
  V3_USE_CASES as U,
  V3_TERMINAL,
  V3_ACTIONS,
  mapNegotiationMove,
} from "@/lib/domain/seller-flow/seller-conversation-v3.js";
import { buildNegotiationPlan, nextNegotiationMove } from "@/lib/domain/negotiation-v3/index.js";
import { buildV3AuditRecord, compactV3AuditForInbox, isUncertainTurn, buildV3ResearchRecord, nextExpectedInfo } from "@/lib/domain/seller-flow/seller-conversation-v3-audit.js";
import { lexiconIntent, resolveV3ReplyLanguage } from "@/lib/domain/seller-flow/seller-conversation-v3-lexicon.js";
import { contactHistoryTruths, evaluatePropertyTouchHold, propertyTouchHoldMode } from "@/lib/domain/campaigns/contact-history-truths.js";
import { runCell, trustedSnapshot } from "../helpers/seller-conversation-v3-matrix.mjs";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const C = (primary_intent, extra = {}) => ({ primary_intent, language: "English", automation_decision: {}, ...extra });
const STAGE = { S1: "ownership_confirmation", S2: "offer_interest", S3: "asking_price", S4: "property_condition" };
const ctx = (uc) => ({ last_outbound_template_use_case: uc });
const plan = (p) => planSellerConversationV3({ now: NOW, ...p });

// ── §38 contextual YES ─────────────────────────────────────────────────────
test("§38 a Yes means what the last question asked: S1 owner, S2 interest, S3 'I have a number' only", async () => {
  const s1 = await runCell({ stage: "S1", message: "Yes" });
  assert.equal(s1.plan.reasoning_code, "v3_checklist:ask_interest");
  assert.equal(s1.plan.facts_patch.ownership_status, "confirmed");
  const s2 = await runCell({ stage: "S2", message: "Yes" });
  assert.equal(s2.plan.reasoning_code, "v3_checklist:ask_asking_price");
  assert.equal(s2.plan.facts_patch.interest, "interested");
  for (const yes of ["Yes", "yes I do", "I do", "I have one", "👍"]) {
    const s3 = await runCell({ stage: "S3", message: yes });
    assert.equal(s3.plan.reasoning_code, "v3_s3_yes_continue_price_discovery", yes);
    assert.equal(s3.plan.template_use_case, U.PRICE_NUMBER, yes);
    assert.equal(s3.plan.facts_patch.ownership_status, undefined, `${yes}: no ownership implication`);
    assert.equal(s3.plan.facts_patch.interest, undefined, `${yes}: no interest implication`);
    assert.equal(s3.plan.checklist.asking_price.collected, false, `${yes}: still no price`);
  }
  const s4yes = await runCell({ stage: "S4", message: "Yes" });
  assert.equal(s4yes.plan.template_use_case, U.REPAIR_CLARIFICATION, "Yes to 'anything major?' → which ones");
  const s4no = await runCell({ stage: "S4", message: "No" });
  assert.equal(s4no.plan.facts_patch.major_repairs.none_major, true, "No to 'anything major?' → nothing major");
});

// ── §21 / §22 connected persons + Contact Matching Tags ────────────────────
test("§21 connected persons: wife / manager → can-you-speak-for-the-owner once; LLC → interest; renter → archive pairing", () => {
  const wife = plan({ classification: C("unclear"), message: "My wife owns it", stage_before: STAGE.S1 });
  assert.equal(wife.template_use_case, U.CONNECTED_PERSON);
  assert.equal(wife.identity.claim, "family_owner");
  const mgr = plan({ classification: C("tenant_occupied"), message: "I manage it for my mom", stage_before: STAGE.S1 });
  assert.equal(mgr.template_use_case, U.CONNECTED_PERSON, "a manager is not the owner");
  assert.equal(mgr.facts_patch.ownership_status, undefined);
  const llc = plan({ classification: C("llc_corporation"), message: "my LLC owns it", stage_before: STAGE.S1 });
  assert.equal(llc.template_use_case, U.INTEREST);
  const renter = plan({ classification: C("unclear"), message: "I rent here", stage_before: STAGE.S1 });
  assert.equal(renter.terminal_action, V3_TERMINAL.ARCHIVE_PROPERTY);
  const owner_says_tenant = plan({ classification: C("tenant_occupied"), message: "Tenant lives there", stage_before: STAGE.S1 });
  assert.notEqual(owner_says_tenant.terminal_action, V3_TERMINAL.ARCHIVE_PROPERTY, "the owner describing occupancy is not the occupant");
  // The answer to the connected-person question decides.
  const yes = plan({ classification: C("unclear"), message: "Yes I can", stage_before: STAGE.S1, conversation_context: ctx(U.CONNECTED_PERSON) });
  assert.equal(yes.template_use_case, U.INTEREST);
  assert.equal(yes.checklist.ownership.confidence, "connected_person_authorized");
  const num = plan({ classification: C("unclear"), message: "her cell is 612-555-0199", stage_before: STAGE.S1, conversation_context: ctx(U.CONNECTED_PERSON) });
  assert.equal(num.terminal_action, V3_TERMINAL.REFERRAL_CAPTURE);
  const no = plan({ classification: C("unclear"), message: "No", stage_before: STAGE.S1, conversation_context: ctx(U.CONNECTED_PERSON) });
  assert.equal(no.terminal_action, V3_TERMINAL.ARCHIVE_PROPERTY);
  // Asked once, then the best-contact question, then archive.
  const again = plan({ classification: C("unclear"), message: "My wife owns it", stage_before: STAGE.S1, conversation_context: ctx(U.CONNECTED_PERSON) });
  assert.equal(again.template_use_case, U.REFERRAL_BEST_CONTACT);
  for (const p of [wife, mgr, llc, renter, yes, num, no, again]) assert.equal(p.review, false);
});

test("§22 Contact Matching Tags: corroborate / contradict ownership; an LLC claim from a tagged renter is checked", () => {
  const corroborated = plan({ classification: C("ownership_confirmed"), message: "Yes", stage_before: STAGE.S1, matching_flags: "Likely Owner" });
  assert.equal(corroborated.checklist.ownership.confidence, "high_corroborated");
  const linked = plan({ classification: C("ownership_confirmed"), message: "Yes", stage_before: STAGE.S1, matching_flags: "Linked To Company, Family" });
  assert.equal(linked.checklist.ownership.confidence, "high_corroborated");
  const contradicted = plan({ classification: C("ownership_confirmed"), message: "Yes", stage_before: STAGE.S1, matching_flags: "Resident, Likely Renting" });
  assert.equal(contradicted.checklist.ownership.confidence, "low_contradicted_by_matching_tag");
  assert.equal(contradicted.review, false, "contradiction lowers confidence; S1 never goes to a person");
  assert.equal(contradicted.facts_patch.ownership_confidence, "low_contradicted_by_matching_tag");
  const renterLlc = plan({ classification: C("llc_corporation"), message: "my LLC owns it", stage_before: STAGE.S1, matching_flags: "Likely Renting" });
  assert.equal(renterLlc.template_use_case, U.CONNECTED_PERSON);
});

// ── §23 conditional interest ───────────────────────────────────────────────
test("§23 conditional interest goes to price discovery; 'not for any price' stays a decline", () => {
  for (const m of ["depends on the price", "if it is a good offer", "For the right price, sure", "No, it is not on the market. I will sell it for the right price"]) {
    const p = plan({ classification: C(m.startsWith("No") ? "not_interested" : "unclear"), message: m, stage_before: STAGE.S2 });
    assert.equal(p.template_use_case, U.CONDITIONAL_ASK_PRICE, m);
    assert.equal(p.facts_patch.interest, "conditional", m);
  }
  const s3 = plan({ classification: C("not_interested"), message: "I will sell it for the right price", stage_before: STAGE.S3 });
  assert.equal(s3.template_use_case, U.NO_PRICE_CONDITION, "at S3 a dodge is a decline to price → run the numbers");
  const hard = plan({ classification: C("not_interested"), message: "Not for any price, not selling", stage_before: STAGE.S2 });
  assert.equal(hard.terminal_action, V3_TERMINAL.NURTURE);
});

// ── §26–27 / §90 deterministic numbers ─────────────────────────────────────
test("§90 numbers: 2020 is never $2.02M; 1,500 can be rent; 300 is $300K; stated asks are read", async () => {
  const year = await runCell({ stage: "S3", message: "2020", ade_snapshot: trustedSnapshot() });
  assert.equal(year.plan.checklist.asking_price.collected, false);
  assert.equal(year.plan.template_use_case, U.PRICE_CLARIFY);
  const rent = await runCell({ stage: "S3", message: "1,500" });
  assert.equal(rent.plan.checklist.asking_price.value, null);
  const rentS4 = await runCell({ stage: "S4", message: "Rent is 1,500" });
  assert.equal(rentS4.plan.checklist.occupancy.value, "tenant_occupied");
  const three = await runCell({ stage: "S3", message: "300", ade_snapshot: trustedSnapshot(280_000) });
  assert.equal(three.plan.checklist.asking_price.value, 300_000);
  assert.equal(statedAskingPrice("235k is my bottom"), 235_000);
  assert.equal(statedAskingPrice("my goal is 200"), 200_000);
  assert.equal(statedAskingPrice("my number is 1,500"), null);
  assert.equal(statedAskingPrice("2020 is my goal"), null);
  assert.equal(statedAskingPrice("Sure, for 10 million lol"), 10_000_000);
});

test("§90 make-me-an-offer stays in price discovery (declined-to-price persisted), never money, never review", async () => {
  for (const stage of ["S1", "S2", "S3"]) {
    const r = await runCell({ stage, message: "Make me an offer", ade_snapshot: trustedSnapshot() });
    assert.equal(r.plan.template_use_case, U.NO_PRICE_CONDITION, stage);
    assert.equal(r.plan.facts_patch.asking_price_declined, true, stage);
    assert.equal(r.plan.monetary, null, stage);
    assert.equal(r.outcome, "auto_reply", stage);
  }
});

test("§90/§29 unrealistic ask exits politely with NO condition ask and nurtures; a second one archives", async () => {
  const r = await runCell({ stage: "S3", message: "$1,000,000", ade_snapshot: trustedSnapshot(300_000) });
  assert.equal(r.plan.template_use_case, U.FAR_ABOVE_NURTURE);
  assert.equal(r.plan.then, V3_TERMINAL.NURTURE);
  assert.doesNotMatch(r.text || "", /condition|repair|roof|living there/i);
  const applied = applySellerConversationV3(C("asking_price_provided"), r.plan);
  assert.equal(applied.classification.seller_conversation_v3.terminal_action, V3_TERMINAL.NURTURE, "orchestrator schedules the 30-day follow-up");
  assert.equal(applied.classification.seller_conversation_v3.inbox_bucket, "follow_up", "never New Replies / Priority");
});

test("§90 known condition / occupancy are never re-asked", () => {
  const known = { asking_price: 150_000, condition_disclosed: true, condition_level: "good", occupancy_status: "vacant", update_years: { roof: 2019 } };
  for (const m of ["ok", "what else do you need?", "Sounds good"]) {
    const p = plan({ classification: C("unclear"), message: m, stage_before: STAGE.S4, known_facts: known, conversation_context: ctx("v3_occupancy_check") });
    for (const uc of [U.CONDITION_CLARIFIER, U.CONDITION_NEAR_VALUE, U.OCCUPANCY, U.BELOW_VALUE_BASICS, U.UPDATE_YEARS, U.NO_PRICE_CONDITION]) {
      assert.ok(!(p.template_preference || []).includes(uc), `${m}: re-asked ${uc}`);
    }
  }
});

// ── §32 / §33 ──────────────────────────────────────────────────────────────
test("§32 one highest-value S4 question: needs work → major repairs; generic good → years once; then occupancy", () => {
  const work = deriveChecklist({ stage: "S4_condition", classification: C("condition_disclosed"), message: "it needs some work", known_facts: { asking_price: 1 } });
  assert.equal(selectS4Question(work), "major_repairs");
  const named = deriveChecklist({ stage: "S4_condition", classification: C("condition_disclosed"), message: "needs a new roof and hvac" });
  assert.deepEqual(named.major_repairs.value.components, ["roof", "hvac"]);
  assert.equal(selectS4Question(named), "occupancy");
  const good = deriveChecklist({ stage: "S4_condition", classification: C("condition_disclosed"), message: "good shape" });
  assert.equal(selectS4Question(good), "update_years");
  assert.equal(selectS4Question(good, [U.UPDATE_YEARS]), "occupancy", "years asked once");
  assert.equal(majorRepairsFromMessage("Same roof. HVAC 3 years old. No foundation issues"), null, "negations / ages are not repairs");
  assert.equal(occupancyFromMessage("it's vacant"), "vacant");
});

test("§33 checklist: unknown / known / not_applicable, and what persists (years merged, declined-to-price)", () => {
  const empty = checklistState(deriveChecklist({ stage: "S1_ownership", classification: C("unclear"), message: "hm" }));
  assert.deepEqual(Object.values(empty), Array(7).fill("unknown"));
  const good = checklistState(deriveChecklist({ stage: "S4_condition", classification: C("condition_disclosed"), message: "great shape, roof 2019" }));
  assert.equal(good.condition, "known");
  assert.equal(good.major_repairs, "not_applicable");
  assert.equal(good.update_years, "known");
  const gut = checklistState(deriveChecklist({ stage: "S4_condition", classification: C("condition_disclosed"), message: "needs a new roof", known_facts: { condition_level: "poor" } }));
  assert.equal(gut.update_years, "not_applicable");
  const p = plan({ classification: C("condition_disclosed"), message: "kitchen 2018", stage_before: STAGE.S4, known_facts: { asking_price: 100_000, update_years: { roof: 2015 } } });
  assert.deepEqual(p.facts_patch.update_years, { roof: 2015, kitchen: 2018 }, "a later turn never drops an earlier year");
  const declined = plan({ classification: C("asking_price_absent"), message: "No", stage_before: STAGE.S3 });
  assert.equal(declined.facts_patch.asking_price_declined, true);
});

// ── §39 / §83 ──────────────────────────────────────────────────────────────
test("§83 audit record per autonomous turn: said, classification, stage, rule, template, language, number, send, follow-up", () => {
  const p = plan({ classification: C("unclear", { language: "Spanish", confidence: 0.4 }), message: "Vues", stage_before: STAGE.S1 });
  const execution = { queued: true, queue_row_id: "q1", automation_decision: {}, selected_template: { template_id: "lc-v3-ro-es-1", use_case: "v3_reask_ownership", language: "Spanish" } };
  const a = buildV3AuditRecord({ plan: p, message: "Vues", classification: C("unclear", { language: "Spanish" }), stage_before: STAGE.S1, execution, inbound_event_id: "ev-1", follow_up: null });
  for (const k of ["seller_said", "classification", "stage_before", "stage", "rule", "template", "quoted_number", "send", "follow_up", "checklist", "next_expected", "objective"]) assert.ok(k in a, k);
  assert.equal(a.template.language, "Spanish");
  assert.equal(a.quoted_number, null, "no money on this turn");
  assert.equal(a.send.dedupe_identity, "inbound:ev-1");
  assert.equal(a.next_expected, "ownership");
  const compact = compactV3AuditForInbox(a);
  assert.ok(JSON.stringify(compact).length < 1500, "compact enough for message metadata");
  assert.equal(nextExpectedInfo({ action: "terminal" }), null);
});

test("§39 uncertain turns go to the research log with raw reply, language, stage, candidates and reason", () => {
  const p = plan({ classification: C("unclear", { matched_intents: ["who_is_this"] }), message: "Checking in the jv", stage_before: STAGE.S1 });
  assert.equal(isUncertainTurn(p, C("unclear")), true);
  const r = buildV3ResearchRecord({ plan: p, message: "Checking in the jv", classification: C("unclear", { matched_intents: ["who_is_this"] }), inbound_event_id: "ev-2" });
  assert.equal(r.raw_reply, "Checking in the jv");
  assert.equal(r.stage, "S1_ownership");
  assert.deepEqual(r.candidate_intents, ["who_is_this"]);
  assert.equal(r.replay_status, "pending_rule");
  const clear = plan({ classification: C("ownership_confirmed"), message: "Yes", stage_before: STAGE.S1 });
  assert.equal(isUncertainTurn(clear, C("ownership_confirmed")), false);
});

// ── §34 language → canonical intent ───────────────────────────────────────
test("§34/§92 lexicon names canonical intents in native script; reply language never defaults to English", () => {
  assert.equal(lexiconIntent("别再给我发短信了").intent, "opt_out");
  assert.equal(lexiconIntent("Smetta di scrivermi").language, "Italian");
  assert.equal(lexiconIntent("Warum fragen Sie?").intent, "who_why");
  assert.equal(lexiconIntent("ok"), null, "ambiguous words prove nothing");
  const lang = resolveV3ReplyLanguage({ message: "250000", classification: { language: "English" }, conversation_context: { last_outbound_template_language: "Korean" } });
  assert.equal(lang.language, "Korean");
  const en = resolveV3ReplyLanguage({ message: "who is this?", classification: { language: "English" }, conversation_context: { last_outbound_language: "Spanish" } });
  assert.equal(en.language, "English");
});

// ── §93 suppression guarantees ─────────────────────────────────────────────
test("§93 an opt-out the classifier missed reaches the canonical STOP path; hostile is never an opt-out", async () => {
  for (const [lang, m] of [["Italian", "Smetta di scrivermi"], ["Mandarin", "别再给我发短信了"], ["Spanish", "No me mande más mensajes"]]) {
    const r = await runCell({ stage: "S1", message: m, language: lang });
    assert.equal(r.outcome, "suppressed", m);
    assert.equal(r.decision.should_suppress_contact, true, `${m}: executor suppression`);
    assert.equal(r.text, null);
  }
  const hostile = await runCell({ stage: "S2", message: "You people are idiots" });
  assert.notEqual(hostile.decision.should_suppress_contact, true);
});

test("§93 a v3 terminal never overrides compliance; wrong number at S3 can never reply (v2 reply overridden)", async () => {
  const sup = { should_suppress_contact: true, should_queue_reply: false };
  const stamp = { seller_conversation_v3: { action: V3_ACTIONS.TERMINAL, terminal_action: V3_TERMINAL.ARCHIVE } };
  assert.equal(applySellerConversationV3TerminalDecision(sup, stamp, { SELLER_CONVERSATION_V3: "1", SELLER_AUTOPILOT_V2: "1" }), sup);
  const wrong = await runCell({ stage: "S3", message: "Wrong number" });
  assert.equal(wrong.text, null);
  assert.equal(wrong.decision.should_queue_reply, false);
  assert.equal(wrong.plan.terminal_action, V3_TERMINAL.WRONG_NUMBER);
  const applied = applySellerConversationV3(C("asking_price_absent", { automation_decision: { suppression_action: "archive_wrong_number" } }), wrong.plan);
  assert.equal(applied.classification.automation_decision.suppression_action, "archive_wrong_number", "the wrong-number archive is kept");
});

// ── §61–62 four truths + retext ────────────────────────────────────────────
const sent = (property_id, to_phone_number, prospect_id = null) => ({ property_id, to_phone_number, prospect_id, queue_status: "sent", sent_at: "2026-09-01T00:00:00Z" });

test("§61 four distinct truths, never one boolean; an unknown person is null, not false", () => {
  const t = contactHistoryTruths({ prior_rows: [sent("P1", "+16125550001", "K1")], property_id: "P1", person_key: null, phone: "+16125550002" });
  assert.equal(t.property_ever_touched, true);
  assert.equal(t.person_ever_contacted, null);
  assert.equal(t.phone_contacted, false);
  assert.equal(t.current_best_contact_touched, false);
  const failed = contactHistoryTruths({ prior_rows: [{ property_id: "P1", to_phone_number: "+16125550001", queue_status: "failed" }], property_id: "P1", phone: "+16125550001" });
  assert.equal(failed.property_ever_touched, false, "a provably unsent row is not a touch");
});

test("§62 retext: no second opener because the best phone changed; release only for a proven different person", () => {
  const base = { property_id: "P1", phone: "+16125550002", is_opener: true };
  assert.equal(evaluatePropertyTouchHold({ ...base, prior_rows: [] }).hold, false, "T1 never touched");
  assert.equal(evaluatePropertyTouchHold({ ...base, prior_rows: [sent("P1", "+16125550002", "K1")], person_key: "K1" }).why, "phone_rules_govern", "T2");
  assert.equal(evaluatePropertyTouchHold({ ...base, prior_rows: [sent("P1", "+16125550001", "K1")], person_key: "K1", phone_owned_by_person: true }).why, "same_person_new_phone", "T3");
  const release = evaluatePropertyTouchHold({ ...base, prior_rows: [sent("P1", "+16125550001", "K1")], person_key: "K2", phone_owned_by_person: true });
  assert.equal(release.hold, false);
  assert.equal(release.release, "known_different_person", "T4");
  assert.equal(evaluatePropertyTouchHold({ ...base, prior_rows: [sent("P1", "+16125550001", "K1"), sent("P1", "+16125550003", null)], person_key: "K2", phone_owned_by_person: true }).why, "prior_recipient_unknown", "T5");
  assert.equal(evaluatePropertyTouchHold({ ...base, prior_rows: [sent("P1", "+16125550001", "K1")], person_key: "K2", phone_owned_by_person: true, same_person_keys: ["K1"] }).hold, true, "T7 same canonical person");
  assert.equal(evaluatePropertyTouchHold({ ...base, prior_rows: [sent("P1", "+16125550001", "K1")], person_key: "K2", phone_owned_by_person: false }).why, "phone_ownership_unproven", "T8/T12 a different number alone is not proof");
  assert.equal(evaluatePropertyTouchHold({ ...base, prior_rows: [sent("P1", "+16125550001", "K1")], person_key: null }).why, "candidate_person_unknown", "T10");
  assert.equal(evaluatePropertyTouchHold({ ...base, is_opener: false, prior_rows: [sent("P1", "+16125550001", "K1")], person_key: "K1" }).hold, false, "T14 follow-ups are never held");
  assert.equal(propertyTouchHoldMode({}), "off", "default OFF");
  assert.equal(propertyTouchHoldMode({ CAMPAIGN_PROPERTY_TOUCH_HOLD: "shadow" }), "shadow");
});

// ── §46 negotiation handoff (agent C owns every number) ────────────────────
test("§46 handoff: B maps C's move to a template family and never computes or raises a number", () => {
  const b = { version: "x", stage: "S4_condition", missing: [], facts_patch: {} };
  const ctxx = { conversation_context: null, recent_outbound: [], used_use_cases: [] };
  const quote = mapNegotiationMove(b, { plan: { ceiling: 200_000, comp_support: { ids: ["c1"] } }, move: { action: "QUOTE", amount: 180_000, quote_type: "NEGOTIATION_ANCHOR", language_branch: "comps", rule_branch: "anchor" } }, ctxx);
  assert.equal(quote.action, V3_ACTIONS.REPLY);
  assert.equal(quote.monetary.amount, 180_000);
  assert.equal(quote.monetary.source, "negotiation_v3");
  assert.equal(quote.template_use_case, U.ANCHOR_COMPS);
  const over = mapNegotiationMove(b, { plan: { ceiling: 150_000 }, move: { action: "QUOTE", amount: 180_000, language_branch: "comps" } }, ctxx);
  assert.equal(over.action, V3_ACTIONS.REVIEW, "a number above C's ceiling is never sent");
  const human = mapNegotiationMove(b, { plan: { ceiling: 200_000 }, move: { action: "HUMAN", amount: 190_000, rule_branch: "above_autonomous_limit" } }, ctxx);
  assert.equal(human.review, true);
  assert.ok(!human.monetary, "no money leaves on a HUMAN move");
  const close = mapNegotiationMove(b, { plan: {}, move: { action: "CLOSE_UNREALISTIC" } }, ctxx);
  assert.equal(close.template_use_case, U.FAR_ABOVE_NURTURE);
  const hold = mapNegotiationMove(b, { plan: {}, move: { action: "NO_NUMBER" } }, ctxx);
  assert.equal(hold.template_use_case, U.NUMBERS_PENDING);
  assert.equal(mapNegotiationMove(b, null, ctxx), null, "no C input → the existing v2 anchor path");
});

test("§46 handoff with C's real engine and both money flags OFF: money becomes HUMAN, never a send", () => {
  const snap = trustedSnapshot(200_000);
  const nplan = buildNegotiationPlan({ ade_snapshot: snap, property: { property_id: "prop-1", property_type: "Single Family" }, seller: { asking_price: 170_000 }, history: [], now: NOW });
  const move = nextNegotiationMove(nplan, { lc_positions: [], seller_positions: [170_000] }, { kind: "price", amount: 170_000 });
  const p = plan({
    classification: C("tenant_occupied"), message: "Tenant in place", stage_before: STAGE.S4,
    known_facts: { asking_price: 170_000, condition_disclosed: true, condition_level: "fair" },
    negotiation_v3: { plan: nplan, move },
  });
  assert.equal(move.action === "QUOTE", false, "autonomy off: C never returns a QUOTE");
  if (p.monetary) assert.fail(`money left B with autonomy off: ${JSON.stringify(p.monetary)}`);
});
