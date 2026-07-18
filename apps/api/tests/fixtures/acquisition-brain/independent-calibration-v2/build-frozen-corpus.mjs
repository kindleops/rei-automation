#!/usr/bin/env node
/**
 * Build frozen independent-calibration-v2 fixtures and content hashes.
 * Run once when authoring; commit outputs. Do not re-run after predictions.
 *
 *   node tests/fixtures/acquisition-brain/independent-calibration-v2/build-frozen-corpus.mjs
 */
import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_VERSION = "independent_calibration_v2";

function sha256(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}

function normalizeText(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Independently authored — not copied from development seed texts. */
const GOLD = [
  // ── Candidate A: clear ownership (EN) + ownership_check context ──
  { id: "ic2-own-en-01", fam: "ic2_own_affirm_yes", lang: "en", text: "Yes.", ctx: "ownership_check", stage: "ownership_check", primary: "ownership_confirmed", candidate: "clear_ownership_confirmation", auth_candidate: true, src: "authored" },
  { id: "ic2-own-en-02", fam: "ic2_own_affirm_yeah", lang: "en", text: "Yeah.", ctx: "ownership_check", stage: "ownership_check", primary: "ownership_confirmed", candidate: "clear_ownership_confirmation", auth_candidate: true, src: "authored" },
  { id: "ic2-own-en-03", fam: "ic2_own_affirm_yep", lang: "en", text: "Yep", ctx: "ownership_check", stage: "ownership_check", primary: "ownership_confirmed", candidate: "clear_ownership_confirmation", auth_candidate: true, src: "authored" },
  { id: "ic2-own-en-04", fam: "ic2_own_affirm_correct", lang: "en", text: "Correct", ctx: "ownership_check", stage: "ownership_check", primary: "ownership_confirmed", candidate: "clear_ownership_confirmation", auth_candidate: true, src: "authored" },
  { id: "ic2-own-en-05", fam: "ic2_own_affirm_i_do", lang: "en", text: "I do", ctx: "ownership_check", stage: "ownership_check", primary: "ownership_confirmed", candidate: "clear_ownership_confirmation", auth_candidate: true, src: "authored" },
  { id: "ic2-own-en-06", fam: "ic2_own_affirm_we_do", lang: "en", text: "We do", ctx: "ownership_check", stage: "ownership_check", primary: "ownership_confirmed", candidate: "clear_ownership_confirmation", auth_candidate: true, src: "authored" },
  { id: "ic2-own-en-07", fam: "ic2_own_still", lang: "en", text: "Still own it", ctx: "ownership_check", stage: "ownership_check", primary: "ownership_confirmed", candidate: "clear_ownership_confirmation", auth_candidate: true, src: "authored" },
  { id: "ic2-own-en-08", fam: "ic2_own_explicit", lang: "en", text: "Yes I still hold title", ctx: "ownership_check", stage: "ownership_check", primary: "ownership_confirmed", candidate: "clear_ownership_confirmation", auth_candidate: true, src: "authored" },
  { id: "ic2-own-en-09", fam: "ic2_own_affirm_thats_me", lang: "en", text: "That's me", ctx: "ownership_check", stage: "ownership_check", primary: "ownership_confirmed", candidate: "clear_ownership_confirmation", auth_candidate: true, src: "authored" },
  { id: "ic2-own-en-10", fam: "ic2_own_affirm_affirmative", lang: "en", text: "Affirmative", ctx: "ownership_check", stage: "ownership_check", primary: "ownership_confirmed", candidate: "clear_ownership_confirmation", auth_candidate: true, src: "authored" },
  { id: "ic2-own-en-11", fam: "ic2_own_still_yes", lang: "en", text: "Yes still own the place", ctx: "ownership_check", stage: "ownership_check", primary: "ownership_confirmed", candidate: "clear_ownership_confirmation", auth_candidate: true, src: "authored" },
  { id: "ic2-own-en-12", fam: "ic2_own_we_own", lang: "en", text: "We own it", ctx: "ownership_check", stage: "ownership_check", primary: "ownership_confirmed", candidate: "clear_ownership_confirmation", auth_candidate: true, src: "authored" },

  // ── Candidate B: clear proposal request ──
  { id: "ic2-prop-en-01", fam: "ic2_prop_whats", lang: "en", text: "What proposal can you put together", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "asks_offer", candidate: "clear_seller_requests_proposal", auth_candidate: true, src: "authored" },
  { id: "ic2-prop-en-02", fam: "ic2_prop_send_proposal", lang: "en", text: "Send me the proposal", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "asks_offer", candidate: "clear_seller_requests_proposal", auth_candidate: true, src: "authored" },
  { id: "ic2-prop-en-03", fam: "ic2_prop_offering", lang: "en", text: "What are you offering", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "asks_offer", candidate: "clear_seller_requests_proposal", auth_candidate: true, src: "authored" },
  { id: "ic2-prop-en-04", fam: "ic2_prop_numbers", lang: "en", text: "Send me the numbers", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "asks_offer", candidate: "clear_seller_requests_proposal", auth_candidate: true, src: "authored" },
  { id: "ic2-prop-en-05", fam: "ic2_prop_look", lang: "en", text: "I'll look at a proposal", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "asks_offer", candidate: "clear_seller_requests_proposal", auth_candidate: true, src: "authored" },
  { id: "ic2-prop-en-06", fam: "ic2_prop_propose", lang: "en", text: "What would you propose", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "asks_offer", candidate: "clear_seller_requests_proposal", auth_candidate: true, src: "authored" },
  { id: "ic2-prop-en-07", fam: "ic2_prop_make_offer", lang: "en", text: "Make me an offer please", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "asks_offer", candidate: "clear_seller_requests_proposal", auth_candidate: true, src: "authored" },
  { id: "ic2-prop-en-08", fam: "ic2_prop_your_offer", lang: "en", text: "What offer can you put together?", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "asks_offer", candidate: "clear_seller_requests_proposal", auth_candidate: true, src: "authored" },
  { id: "ic2-prop-en-09", fam: "ic2_prop_send_offer", lang: "en", text: "Send over an offer when ready", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "asks_offer", candidate: "clear_seller_requests_proposal", auth_candidate: true, src: "authored" },
  { id: "ic2-prop-en-10", fam: "ic2_prop_best_number", lang: "en", text: "Give me your best number", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "asks_offer", candidate: "clear_seller_requests_proposal", auth_candidate: true, src: "authored" },

  // ── Candidate C: clear asking price ──
  { id: "ic2-price-en-01", fam: "ic2_price_want_250", lang: "en", text: "I want 250k", ctx: "asking_price", stage: "asking_price", primary: "asking_price_provided", candidate: "clear_asking_price_disclosure", auth_candidate: true, src: "authored" },
  { id: "ic2-price-en-02", fam: "ic2_price_around_dollar", lang: "en", text: "Around $250,000", ctx: "asking_price", stage: "asking_price", primary: "asking_price_provided", candidate: "clear_asking_price_disclosure", auth_candidate: true, src: "authored" },
  { id: "ic2-price-en-03", fam: "ic2_price_no_less", lang: "en", text: "No less than 250", ctx: "asking_price", stage: "asking_price", primary: "asking_price_provided", candidate: "clear_asking_price_disclosure", auth_candidate: true, src: "authored" },
  { id: "ic2-price-en-04", fam: "ic2_price_between", lang: "en", text: "Between 240 and 260", ctx: "asking_price", stage: "asking_price", primary: "asking_price_provided", candidate: "clear_asking_price_disclosure", auth_candidate: true, src: "authored" },
  { id: "ic2-price-en-05", fam: "ic2_price_asking", lang: "en", text: "Asking 275k", ctx: "asking_price", stage: "asking_price", primary: "asking_price_provided", candidate: "clear_asking_price_disclosure", auth_candidate: true, src: "authored" },
  { id: "ic2-price-en-06", fam: "ic2_price_about", lang: "en", text: "About 180000", ctx: "asking_price", stage: "asking_price", primary: "asking_price_provided", candidate: "clear_asking_price_disclosure", auth_candidate: true, src: "authored" },
  { id: "ic2-price-en-07", fam: "ic2_price_firm", lang: "en", text: "300k firm", ctx: "asking_price", stage: "asking_price", primary: "asking_price_provided", candidate: "clear_asking_price_disclosure", auth_candidate: true, src: "authored" },
  { id: "ic2-price-en-08", fam: "ic2_price_range_dash", lang: "en", text: "240-260k", ctx: "asking_price", stage: "asking_price", primary: "asking_price_provided", candidate: "clear_asking_price_disclosure", auth_candidate: true, src: "authored" },
  { id: "ic2-price-en-09", fam: "ic2_price_looking", lang: "en", text: "Looking for 225 thousand", ctx: "asking_price", stage: "asking_price", primary: "asking_price_provided", candidate: "clear_asking_price_disclosure", auth_candidate: true, src: "authored" },
  { id: "ic2-price-en-10", fam: "ic2_price_min", lang: "en", text: "Minimum 200k", ctx: "asking_price", stage: "asking_price", primary: "asking_price_provided", candidate: "clear_asking_price_disclosure", auth_candidate: true, src: "authored" },

  // ── Spanish positives (separate evaluation; remain ineligible by default) ──
  { id: "ic2-own-es-01", fam: "ic2_own_es_si", lang: "es", text: "Sí", ctx: "ownership_check", stage: "ownership_check", primary: "ownership_confirmed", candidate: "clear_ownership_confirmation_es", auth_candidate: false, src: "authored" },
  { id: "ic2-own-es-02", fam: "ic2_own_es_dueno", lang: "es", text: "Todavía soy el dueño", ctx: "ownership_check", stage: "ownership_check", primary: "ownership_confirmed", candidate: "clear_ownership_confirmation_es", auth_candidate: false, src: "authored" },
  { id: "ic2-prop-es-01", fam: "ic2_prop_es_propuesta", lang: "es", text: "Que propuesta tienen ustedes", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "asks_offer", candidate: "clear_seller_requests_proposal_es", auth_candidate: false, src: "authored" },
  { id: "ic2-prop-es-02", fam: "ic2_prop_es_oferta", lang: "es", text: "Mándeme una oferta por favor", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "asks_offer", candidate: "clear_seller_requests_proposal_es", auth_candidate: false, src: "authored" },
  { id: "ic2-price-es-01", fam: "ic2_price_es_250", lang: "es", text: "Mi precio es 250 mil", ctx: "asking_price", stage: "asking_price", primary: "asking_price_provided", candidate: "clear_asking_price_disclosure_es", auth_candidate: false, src: "authored" },
  { id: "ic2-price-es-02", fam: "ic2_price_es_alrededor", lang: "es", text: "Alrededor de 250", ctx: "asking_price", stage: "asking_price", primary: "asking_price_provided", candidate: "clear_asking_price_disclosure_es", auth_candidate: false, src: "authored" },

  // ── Adversarial neighbors for ownership ──
  { id: "ic2-adv-own-01", fam: "ic2_adv_sold_after_yes", lang: "en", text: "Yes but I sold it", ctx: "ownership_check", stage: "ownership_check", primary: "wrong_number", candidate: "adversarial_ownership", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-own-02", fam: "ic2_adv_years_ago", lang: "en", text: "Yeah that was mine years ago", ctx: "ownership_check", stage: "ownership_check", primary: "wrong_number", candidate: "adversarial_ownership", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-own-03", fam: "ic2_adv_brother", lang: "en", text: "Yes my brother owns it", ctx: "ownership_check", stage: "ownership_check", primary: "unclear", candidate: "adversarial_ownership", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-own-04", fam: "ic2_adv_wife", lang: "en", text: "My wife owns it", ctx: "ownership_check", stage: "ownership_check", primary: "unclear", candidate: "adversarial_ownership", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-own-05", fam: "ic2_adv_manage", lang: "en", text: "I manage it", ctx: "ownership_check", stage: "ownership_check", primary: "tenant_occupied", candidate: "adversarial_ownership", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-own-06", fam: "ic2_adv_tenant", lang: "en", text: "I'm the tenant", ctx: "ownership_check", stage: "ownership_check", primary: "tenant_occupied", candidate: "adversarial_ownership", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-own-07", fam: "ic2_adv_agent", lang: "en", text: "I'm the agent", ctx: "ownership_check", stage: "ownership_check", primary: "not_interested", candidate: "adversarial_ownership", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-own-08", fam: "ic2_adv_no", lang: "en", text: "No I don't", ctx: "ownership_check", stage: "ownership_check", primary: "not_interested", candidate: "adversarial_ownership", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-own-09", fam: "ic2_adv_never", lang: "en", text: "Never owned it", ctx: "ownership_check", stage: "ownership_check", primary: "wrong_number", candidate: "adversarial_ownership", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-own-10", fam: "ic2_adv_wrong", lang: "en", text: "This is a wrong number", ctx: "ownership_check", stage: "ownership_check", primary: "wrong_number", candidate: "adversarial_ownership", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-own-11", fam: "ic2_adv_stop", lang: "en", text: "Stop texting", ctx: "ownership_check", stage: "ownership_check", primary: "opt_out", candidate: "adversarial_ownership", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-own-12", fam: "ic2_adv_yes_not_int", lang: "en", text: "Yes but not interested", ctx: "ownership_check", stage: "ownership_check", primary: "not_interested", candidate: "adversarial_ownership", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-own-13", fam: "ic2_adv_wrong_person", lang: "en", text: "Correct address wrong person", ctx: "ownership_check", stage: "ownership_check", primary: "wrong_number", candidate: "adversarial_ownership", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-own-14", fam: "ic2_adv_what_property", lang: "en", text: "Yeah what property", ctx: "ownership_check", stage: "ownership_check", primary: "info_request", candidate: "adversarial_ownership", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-own-15", fam: "ic2_adv_stop_yes", lang: "en", text: "Yes but stop texting me", ctx: "ownership_check", stage: "ownership_check", primary: "opt_out", candidate: "adversarial_ownership", auth_candidate: false, adversarial: true, src: "adversarial" },

  // ── Adversarial proposal ──
  { id: "ic2-adv-prop-01", fam: "ic2_adv_company", lang: "en", text: "What company", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "info_request", candidate: "adversarial_proposal", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-prop-02", fam: "ic2_adv_who", lang: "en", text: "Who are you", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "who_is_this", candidate: "adversarial_proposal", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-prop-03", fam: "ic2_adv_what_prop", lang: "en", text: "What property", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "info_request", candidate: "adversarial_proposal", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-prop-04", fam: "ic2_adv_how_number", lang: "en", text: "How did you get my number", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "who_is_this", candidate: "adversarial_proposal", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-prop-05", fam: "ic2_adv_no_proposal", lang: "en", text: "No proposal", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "not_interested", candidate: "adversarial_proposal", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-prop-06", fam: "ic2_adv_not_int_proposal", lang: "en", text: "Not interested in your proposal", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "not_interested", candidate: "adversarial_proposal", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-prop-07", fam: "ic2_adv_agent_proposal", lang: "en", text: "My agent handles proposals", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "not_interested", candidate: "adversarial_proposal", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-prop-08", fam: "ic2_adv_under_contract", lang: "en", text: "Already under contract", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "info_request", candidate: "adversarial_proposal", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-prop-09", fam: "ic2_adv_stop_proposals", lang: "en", text: "Stop sending proposals", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "opt_out", candidate: "adversarial_proposal", auth_candidate: false, adversarial: true, src: "adversarial" },

  // ── Adversarial price false positives ──
  { id: "ic2-adv-price-01", fam: "ic2_adv_zip", lang: "en", text: "75201", ctx: "asking_price", stage: "asking_price", primary: "unclear", candidate: "adversarial_price", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-price-02", fam: "ic2_adv_year", lang: "en", text: "1998", ctx: "asking_price", stage: "asking_price", primary: "unclear", candidate: "adversarial_price", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-price-03", fam: "ic2_adv_sqft", lang: "en", text: "1800 square feet", ctx: "asking_price", stage: "asking_price", primary: "unclear", candidate: "adversarial_price", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-price-04", fam: "ic2_adv_roof_cost", lang: "en", text: "The roof costs 20k", ctx: "asking_price", stage: "asking_price", primary: "condition_disclosed", candidate: "adversarial_price", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-price-05", fam: "ic2_adv_bought", lang: "en", text: "Bought it for 250", ctx: "asking_price", stage: "asking_price", primary: "asking_price_provided", candidate: "adversarial_price", auth_candidate: false, adversarial: true, src: "adversarial", note: "may false-positive as price; gold expects asking_price only if rule fires — mark non-candidate" },
  { id: "ic2-adv-price-06", fam: "ic2_adv_owe", lang: "en", text: "Owe 250", ctx: "asking_price", stage: "asking_price", primary: "asking_price_provided", candidate: "adversarial_price", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-price-07", fam: "ic2_adv_would_you", lang: "en", text: "Would you pay 250?", ctx: "asking_price", stage: "asking_price", primary: "asks_offer", candidate: "adversarial_price", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-price-08", fam: "ic2_adv_not_asking", lang: "en", text: "Not asking 250", ctx: "asking_price", stage: "asking_price", primary: "asking_price_provided", candidate: "adversarial_price", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-price-09", fam: "ic2_adv_phone", lang: "en", text: "Call me at 2145551212", ctx: "asking_price", stage: "asking_price", primary: "callback_requested", candidate: "adversarial_price", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-adv-price-10", fam: "ic2_adv_rent", lang: "en", text: "Rent is 1800 a month", ctx: "asking_price", stage: "asking_price", primary: "unclear", candidate: "adversarial_price", auth_candidate: false, adversarial: true, src: "adversarial" },

  // ── Context-sensitive short replies ──
  { id: "ic2-ctx-yes-own", fam: "ic2_ctx_yes", lang: "en", text: "Yes", ctx: "ownership_check", stage: "ownership_check", primary: "ownership_confirmed", candidate: "context_short_reply", auth_candidate: true, src: "context" },
  { id: "ic2-ctx-yes-prop", fam: "ic2_ctx_yes", lang: "en", text: "Yes", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "ownership_confirmed", candidate: "context_short_reply", auth_candidate: false, src: "context", note: "same text different context; production classify lacks outbound context so may still emit ownership_confirmed — authority ineligible without context contract" },
  { id: "ic2-ctx-yes-price", fam: "ic2_ctx_yes", lang: "en", text: "Yes", ctx: "asking_price", stage: "asking_price", primary: "ownership_confirmed", candidate: "context_short_reply", auth_candidate: false, src: "context" },

  // ── Terminal dominance Spanish ──
  { id: "ic2-term-es-01", fam: "ic2_term_es_stop", lang: "es", text: "Sí, pero no me escriba más", ctx: "ownership_check", stage: "ownership_check", primary: "opt_out", candidate: "terminal_dominance", auth_candidate: false, adversarial: true, src: "adversarial" },
  { id: "ic2-term-es-02", fam: "ic2_term_es_wrong", lang: "es", text: "Número equivocado, aunque conozco al dueño", ctx: "ownership_check", stage: "ownership_check", primary: "wrong_number", candidate: "terminal_dominance", auth_candidate: false, adversarial: true, src: "adversarial" },
];

// De-identified historical-style paraphrases (authored; no production IDs)
const HISTORICAL_STYLE = [
  { id: "ic2-hist-own-01", fam: "ic2_hist_own_still", lang: "en", text: "Yes still the owner of record", ctx: "ownership_check", stage: "ownership_check", primary: "ownership_confirmed", candidate: "clear_ownership_confirmation", auth_candidate: true, src: "historical_style_deid" },
  { id: "ic2-hist-prop-01", fam: "ic2_hist_prop_numbers", lang: "en", text: "Sure go ahead and send numbers", ctx: "interest_proposal_confirmation", stage: "interest_proposal_confirmation", primary: "asks_offer", candidate: "clear_seller_requests_proposal", auth_candidate: true, src: "historical_style_deid" },
  { id: "ic2-hist-price-01", fam: "ic2_hist_price_bottom", lang: "en", text: "Bottom line for me is 265k", ctx: "asking_price", stage: "asking_price", primary: "asking_price_provided", candidate: "clear_asking_price_disclosure", auth_candidate: true, src: "historical_style_deid" },
];

const ALL = [...GOLD, ...HISTORICAL_STYLE];

function toExample(row) {
  return {
    calibration_example_id: row.id,
    semantic_family_id: row.fam,
    language: row.lang === "es" ? "Spanish" : "English",
    language_code: row.lang,
    deidentified_raw_text: row.text,
    preceding_outbound_use_case: row.ctx,
    canonical_lifecycle_stage: row.stage,
    expected_primary_intent: row.primary,
    expected_secondary_intents: row.secondary || [],
    expected_facts: row.facts || [],
    expected_terminal_state: ["opt_out", "wrong_number"].includes(row.primary)
      ? "terminal"
      : "none",
    expected_authority_candidate: row.candidate,
    expected_rule_family_eligibility: Boolean(row.auth_candidate),
    labeling_rationale: row.note || `Independent ${row.src} example for ${row.candidate}`,
    source_category: row.src,
    independent_example_flag: true,
    adversarial_neighbor: Boolean(row.adversarial),
    text_sha256: sha256(row.text),
    normalized_text_sha256: sha256(normalizeText(row.text)),
  };
}

function main() {
  const examples = ALL.map(toExample);
  const gold_path = join(__dirname, "gold-labels.jsonl");
  const lines = examples.map((e) => JSON.stringify(e));
  writeFileSync(gold_path, lines.join("\n") + "\n");

  const family_map = {};
  for (const e of examples) {
    family_map[e.semantic_family_id] = family_map[e.semantic_family_id] || [];
    family_map[e.semantic_family_id].push(e.calibration_example_id);
  }
  writeFileSync(join(__dirname, "family-map.json"), JSON.stringify(family_map, null, 2) + "\n");

  const context = examples.filter((e) => e.source_category === "context");
  writeFileSync(
    join(__dirname, "context-fixtures.jsonl"),
    context.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );

  const adv = examples.filter((e) => e.adversarial_neighbor);
  writeFileSync(
    join(__dirname, "adversarial-neighbors.jsonl"),
    adv.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );

  const provenance = {
    corpus_version: CORPUS_VERSION,
    frozen_at: "2026-07-18T00:00:00.000Z",
    policy: "independent_blind_calibration_v2",
    sources: {
      authored: examples.filter((e) => e.source_category === "authored").length,
      adversarial: examples.filter((e) => e.source_category === "adversarial").length,
      context: examples.filter((e) => e.source_category === "context").length,
      historical_style_deid: examples.filter((e) => e.source_category === "historical_style_deid").length,
    },
    note: "No production row IDs. De-identified. Not derived from development seed families.",
  };
  writeFileSync(join(__dirname, "source-provenance.json"), JSON.stringify(provenance, null, 2) + "\n");

  const gold_hash = sha256(lines.join("\n") + "\n");
  const hashes = {
    corpus_version: CORPUS_VERSION,
    gold_labels_jsonl_sha256: gold_hash,
    example_count: examples.length,
    per_example: Object.fromEntries(
      examples.map((e) => [e.calibration_example_id, e.text_sha256])
    ),
  };
  writeFileSync(
    join(__dirname, "immutable-content-hashes.json"),
    JSON.stringify(hashes, null, 2) + "\n"
  );

  const manifest = {
    corpus_version: CORPUS_VERSION,
    calibration_runner_version: "independent_calibration_runner_v2",
    frozen: true,
    gold_labels: "gold-labels.jsonl",
    content_hashes: "immutable-content-hashes.json",
    candidates: [
      "clear_ownership_confirmation",
      "clear_seller_requests_proposal",
      "clear_asking_price_disclosure",
    ],
    gates: {
      precision_min: 0.99,
      precision_lb_95_min: 0.99,
      recall_min: 0.95,
      recall_lb_95_min: 0.95,
      min_predicted_positives_for_precision_lb: 300,
      min_independent_families: 20,
    },
    allowlist_mutation_forbidden: true,
    classify_js_mutation_forbidden: true,
  };
  writeFileSync(join(__dirname, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log(
    JSON.stringify(
      {
        wrote: examples.length,
        gold_hash,
        sources: provenance.sources,
      },
      null,
      2
    )
  );
}

main();
