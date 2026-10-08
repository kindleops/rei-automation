/**
 * Acquisition OS v1 — the executable matrices (§73, §74) and the conversation /
 * multilingual tests (§90, §92) for SELLER CONVERSATION MACHINE v3.
 *   §73  21 intents × S1–S4: every combination reaches ONE deterministic state
 *        (the golden rule below), never review in S1/S2.
 *   §74  12 canonical turns × every registry language (native script): the
 *        canonical state is reached and the reply is in the seller's language.
 *   §92  no silent English fallback; per-language activation; unknown → review.
 * Full chain (classify → v2 overlay → v3 plan → executor dry run). No network.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { runCell, INTENT_MESSAGES, MATRIX_STAGES, PHRASEBOOK, MULTILINGUAL_TURNS, trustedSnapshot } from "../helpers/seller-conversation-v3-matrix.mjs";
import { catalogFor, PROD_SAFE } from "../helpers/seller-conversation-v3-catalog.mjs";
import { CANONICAL_LANGUAGES } from "@/lib/domain/templates/canonical-language-adapter.js";
import { identifyReplyLanguage } from "@/lib/domain/classification/seller-reply-language.js";
import { canonicalTemplateLanguage } from "@/lib/domain/seller-flow/seller-autopilot-v2.js";

const ACTIONS = new Set(["auto_reply", "auto_terminal", "suppressed", "review"]);

// Golden §73 matrix (stage.intent → rule). Reviewed by hand 2026-10-07; a change
// here is a behaviour change and needs the same review.
const GOLDEN_73 = {
  "S1.YES": "v3_checklist:ask_interest",
  "S1.NO": "v3_bare_no_ownership_clarifier_once",
  "S1.MAYBE": "v3_s1_maybe_reask_ownership",
  "S1.WHO": "v3_who_local_investor_then_resume",
  "S1.WHY": "v3_who_local_investor_then_resume",
  "S1.HOW_NUMBER": "v3_who_local_investor_then_resume",
  "S1.MAKE_ME_OFFER": "v3_no_price_condition",
  "S1.WHATS_YOUR_OFFER": "v3_no_price_condition",
  "S1.ASKING_PRICE": "v3_near_value_condition",
  "S1.RENT_AMOUNT": "v3_checklist:ask_ownership",
  "S1.YEAR": "v3_unclear_reask_once",
  "S1.CONDITION": "v3_checklist:ask_interest",
  "S1.REPAIRS": "v3_checklist:ask_interest",
  "S1.OCCUPANCY": "v3_checklist:ask_interest",
  "S1.CAPITAL_GAINS": "v3_capital_gains_creative_probe",
  "S1.WRONG_NUMBER": "v3_existing_lane_wrong_number",
  "S1.REFERRAL": "v3_referral_number_captured",
  "S1.OPT_OUT": "v3_opt_out_suppressed_silently",
  "S1.HOSTILE": "v3_hostile_archived_no_reply",
  "S1.EMOJI": "v3_checklist:ask_interest",
  "S1.SARCASTIC": "v3_far_above_value_serious_offer_nurture",
  "S2.YES": "v3_checklist:ask_asking_price",
  "S2.NO": "v3_existing_lane_not_interested",
  "S2.MAYBE": "v3_checklist:ask_asking_price",
  "S2.WHO": "v3_who_local_investor_then_resume",
  "S2.WHY": "v3_who_local_investor_then_resume",
  "S2.HOW_NUMBER": "v3_who_local_investor_then_resume",
  "S2.MAKE_ME_OFFER": "v3_no_price_condition",
  "S2.WHATS_YOUR_OFFER": "v3_no_price_condition",
  "S2.ASKING_PRICE": "v3_near_value_condition",
  "S2.RENT_AMOUNT": "v3_checklist:ask_interest",
  "S2.YEAR": "v3_unclear_reask_once",
  "S2.CONDITION": "v3_checklist:ask_interest",
  "S2.REPAIRS": "v3_checklist:ask_interest",
  "S2.OCCUPANCY": "v3_checklist:ask_interest",
  "S2.CAPITAL_GAINS": "v3_capital_gains_creative_probe",
  "S2.WRONG_NUMBER": "v3_existing_lane_wrong_number",
  "S2.REFERRAL": "v3_referral_number_captured",
  "S2.OPT_OUT": "v3_opt_out_suppressed_silently",
  "S2.HOSTILE": "v3_hostile_archived_no_reply",
  "S2.EMOJI": "v3_checklist:ask_asking_price",
  "S2.SARCASTIC": "v3_far_above_value_serious_offer_nurture",
  "S3.YES": "v3_s3_yes_continue_price_discovery",
  "S3.NO": "v3_no_price_condition",
  "S3.MAYBE": "v3_checklist:ask_asking_price",
  "S3.WHO": "v3_who_local_investor_then_resume",
  "S3.WHY": "v3_who_local_investor_then_resume",
  "S3.HOW_NUMBER": "v3_who_local_investor_then_resume",
  "S3.MAKE_ME_OFFER": "v3_no_price_condition",
  "S3.WHATS_YOUR_OFFER": "v3_no_price_condition",
  "S3.ASKING_PRICE": "v3_near_value_condition",
  "S3.RENT_AMOUNT": "v3_no_price_condition",
  "S3.YEAR": "v3_s3_number_not_a_price_clarify",
  "S3.CONDITION": "v3_checklist_occupancy",
  "S3.REPAIRS": "v3_checklist_occupancy",
  "S3.OCCUPANCY": "v3_no_price_condition",
  "S3.CAPITAL_GAINS": "v3_capital_gains_creative_probe",
  "S3.WRONG_NUMBER": "v3_existing_lane_wrong_number",
  "S3.REFERRAL": "v3_referral_number_captured",
  "S3.OPT_OUT": "v3_opt_out_suppressed_silently",
  "S3.HOSTILE": "v3_hostile_archived_no_reply",
  "S3.EMOJI": "v3_s3_yes_continue_price_discovery",
  "S3.SARCASTIC": "v3_far_above_value_serious_offer_nurture",
  "S4.YES": "v3_s4_yes_major_repairs_which",
  "S4.NO": "v3_checklist_occupancy",
  "S4.MAYBE": "v3_no_price_condition",
  "S4.WHO": "v3_who_local_investor_then_resume",
  "S4.WHY": "v3_who_local_investor_then_resume",
  "S4.HOW_NUMBER": "v3_who_local_investor_then_resume",
  "S4.MAKE_ME_OFFER": "v3_no_price_condition",
  "S4.WHATS_YOUR_OFFER": "v3_no_price_condition",
  "S4.ASKING_PRICE": "v3_near_value_condition",
  "S4.RENT_AMOUNT": "v3_no_price_condition",
  "S4.YEAR": "v3_unclear_reask_once",
  "S4.CONDITION": "v3_checklist_occupancy",
  "S4.REPAIRS": "v3_checklist_occupancy",
  "S4.OCCUPANCY": "v3_no_price_condition",
  "S4.CAPITAL_GAINS": "v3_capital_gains_creative_probe",
  "S4.WRONG_NUMBER": "v3_existing_lane_wrong_number",
  "S4.REFERRAL": "v3_referral_number_captured",
  "S4.OPT_OUT": "v3_opt_out_suppressed_silently",
  "S4.HOSTILE": "v3_hostile_archived_no_reply",
  "S4.EMOJI": "v3_s4_yes_major_repairs_which",
  "S4.SARCASTIC": "v3_far_above_value_serious_offer_nurture",
};

test("§73: 21 intents × S1–S4 — every cell has the golden deterministic state; none is review", async () => {
  const cells = [];
  for (const stage of Object.keys(MATRIX_STAGES)) {
    for (const [key, message] of Object.entries(INTENT_MESSAGES)) {
      const a = await runCell({ stage, message, ade_snapshot: trustedSnapshot() });
      const b = await runCell({ stage, message, ade_snapshot: trustedSnapshot() });
      cells.push(`${stage}.${key}`);
      assert.ok(ACTIONS.has(a.outcome), `${stage}.${key}: ${a.outcome}`);
      assert.equal(a.plan?.reasoning_code, b.plan?.reasoning_code, `${stage}.${key} is deterministic`);
      assert.equal(a.text, b.text, `${stage}.${key} same text`);
      assert.equal(a.plan?.reasoning_code, GOLDEN_73[`${stage}.${key}`], `${stage}.${key} "${message}"`);
      // Round 10: a number / emoji-only cell carries no seller language
      // evidence -> language HOLD (no send); every other cell needs no person.
      if (a.review_reason === "hold_language") assert.equal(identifyReplyLanguage(message), null, `${stage}.${key} held with language evidence`);
      else assert.notEqual(a.outcome, "review", `${stage}.${key} must not need a person`);
    }
  }
  assert.equal(cells.length, 84);
});

test("§73 hard rules: opt-out suppresses, hostile archives without suppression, wrong number never replies", async () => {
  for (const stage of Object.keys(MATRIX_STAGES)) {
    const stop = await runCell({ stage, message: INTENT_MESSAGES.OPT_OUT });
    assert.equal(stop.outcome, "suppressed", stage);
    assert.equal(stop.text, null);
    const hostile = await runCell({ stage, message: INTENT_MESSAGES.HOSTILE });
    assert.equal(hostile.outcome, "auto_terminal", stage);
    assert.equal(hostile.text, null);
    assert.notEqual(hostile.decision.should_suppress_contact, true, "hostile is never suppression");
    assert.equal(hostile.decision.should_mark_human_review, false);
    const wrong = await runCell({ stage, message: INTENT_MESSAGES.WRONG_NUMBER });
    assert.equal(wrong.text, null, stage);
  }
});

test("§74: 12 canonical turns × every registry language reach the canonical state, replied in that language", async () => {
  const EXPECT = {
    ownership_yes: /^v3_checklist:ask_interest/, ownership_no: /bare_no_ownership_clarifier/, interest_yes: /ask_asking_price/,
    interest_no: /not_interested/, make_me_an_offer: /no_price_condition/, price: /near_value_condition/,
    condition: /checklist_occupancy|major_repairs/, why: /who_local_investor/, who: /who_local_investor/,
    wrong_number: /wrong_number/, opt_out: /opt_out/, unrealistic_price: /far_above/,
  };
  // The registry is authoritative: every canonical language has a phrasebook.
  const registry = CANONICAL_LANGUAGES.map((l) => canonicalTemplateLanguage(l) || l);
  for (const lang of registry) assert.ok(PHRASEBOOK[lang], `phrasebook covers registry language ${lang}`);
  for (const [lang, phrases] of Object.entries(PHRASEBOOK)) {
    for (const [i, [stage, key]] of MULTILINGUAL_TURNS.entries()) {
      const r = await runCell({ stage, message: phrases[i], language: lang, ade_snapshot: trustedSnapshot() });
      assert.match(r.plan?.reasoning_code || "", EXPECT[key], `${lang} ${key} "${phrases[i]}" → ${r.plan?.reasoning_code}`);
      if (r.template) assert.equal(r.template.language, lang, `${lang} ${key}: reply language`);
      if (key === "opt_out") assert.equal(r.outcome, "suppressed", `${lang} opt-out suppresses`);
      if (key === "unrealistic_price") assert.doesNotMatch(r.template?.use_case || "", /condition/, `${lang}: no condition ask on an unrealistic price`);
    }
  }
});

test("§92: no silent English fallback — a language without approved rows goes to review, never an English template", async () => {
  // Only today's prod active+safe rows (EN/ES): a French / Mandarin seller.
  const prodOnly = PROD_SAFE.map((r) => ({ ...r, source: "prod_active_safe" }));
  for (const [lang, idx] of [["French", 0], ["Mandarin", 0], ["Korean", 2], ["Arabic", 7]]) {
    const [stage] = MULTILINGUAL_TURNS[idx];
    const r = await runCell({ stage, message: PHRASEBOOK[lang][idx], language: lang, catalog: [...prodOnly, ...catalogFor("all").filter((x) => x.language === lang && x.use_case.startsWith("v3_reask"))], languages: "English,Spanish" });
    if (r.outcome === "auto_reply") assert.fail(`${lang}: replied with ${r.template?.language}`);
    assert.ok(["review", "auto_terminal", "suppressed"].includes(r.outcome), `${lang}: ${r.outcome}`);
    if (r.template) assert.notEqual(r.template.language, "English", `${lang}: never an English template`);
  }
});

test("§92 per-language activation: drafts exist but the language is not switched on → review, not a send", async () => {
  const r = await runCell({ stage: "S1", message: PHRASEBOOK.French[0], language: "French", languages: "English,Spanish" });
  assert.equal(r.outcome, "review");
  assert.match(String(r.review_reason), /language_not_enabled:French/);
  const on = await runCell({ stage: "S1", message: PHRASEBOOK.French[0], language: "French" });
  assert.equal(on.outcome, "auto_reply");
  assert.equal(on.template.language, "French");
});

// Round 10 (owner 2026-10-08): the reply language comes from the SELLER's own
// inbound evidence only; our outbound / stored thread language never decides.
// An emoji / number-only reply with no seller language evidence HOLDS.
test("§92 numerals / emoji never borrow the thread language: no seller evidence -> HOLD; the English default is not English in a non-English thread", async () => {
  const price = await runCell({ stage: "S3", message: "$250,000", language: "German", ade_snapshot: trustedSnapshot() });
  assert.notEqual(price.outcome, "auto_reply");
  assert.equal(price.review_reason, "hold_language");
  assert.notEqual(price.template?.language, "English");
  const why = await runCell({ stage: "S1", message: "Warum fragen Sie?", language: "German" });
  assert.equal(why.template?.language, "German");
  const en = await runCell({ stage: "S1", message: "Huh?", language: "Hebrew" });
  assert.notEqual(en.template?.language, "Hebrew", "a reply the seller wrote in English stays English");
});
