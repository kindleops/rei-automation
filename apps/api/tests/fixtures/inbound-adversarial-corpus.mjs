// ─── inbound-adversarial-corpus.mjs ─────────────────────────────────────────
//
// Synthetic adversarial corpus for replay-testing the seller-inbound SMS
// engine end-to-end (webhook ingest → classification → compliance gating →
// reply/suppression → terminal disposition).
//
// Expectations are recorded against the classification contract in
// src/lib/domain/classification/classify.js (classifyHeuristic returns
// { primary_intent, compliance_flag, confidence, language, ... }); each case
// lists `expected.intent_any_of` drawn from the classifier's exported
// INTENT_PRIORITY vocabulary rather than pinning a single intent, so the
// corpus survives classifier refinements while still catching category-level
// regressions. BOTH `intent_any_of` AND `disposition_any_of` are ASSERTED
// per-case by tests/critical/inbound-adversarial-replay-coverage.test.mjs.
//
// Disposition note ("replay placeholder-degrade"): the replay harness has no
// property/template context, so a live would-reply whose template needs
// placeholders (property_address etc.) deterministically degrades to
// human_review_required in replay. Cases that would send in production
// therefore list human_review_required alongside reply_sent — that is the
// engine's real, safe replay outcome, not a loosened expectation.
//
// No case in this file is a real message; all phone numbers use reserved
// fictional ranges (555-01xx) and all bodies are synthetic.

import { INTENT_PRIORITY } from "@/lib/domain/classification/classify.js";

export const CORPUS_VERSION = "adversarial_corpus_v1";

/**
 * Classifier intent vocabulary — re-exported from classify.js's REAL exported
 * INTENT_PRIORITY (never a hand-copied mirror that can drift). Replay
 * harnesses validate `expected.intent_any_of` against this.
 */
export const CLASSIFIER_INTENTS = INTENT_PRIORITY;

export const CORPUS_CATEGORIES = Object.freeze([
  "re_engagement",
  "contradiction",
  "short_reply",
  "long_rambling",
  "multi_question",
  "slang",
  "typos",
  "sarcasm",
  "spanish",
  "language_switch",
  "hostile",
  "opt_out",
  "wrong_number",
  "referral",
  "multiple_owners",
  "old_campaign",
  "duplicate_webhook",
  "reordered_webhook",
  "burst",
  "delayed_delivery",
  "missing_timestamp",
  "empty_body",
  "media_only",
  "identity",
  "legal_financial",
  "negotiation",
  // Detector-completion pass: contact-modality logistics + explicit
  // compound-intent preservation cases.
  "logistics",
  "compound",
]);

export const TERMINAL_DISPOSITIONS = Object.freeze([
  "reply_sent",
  "reply_deferred_compliance",
  "suppressed_opt_out",
  "suppressed_wrong_number",
  "suppressed_policy",
  "human_review_required",
  "duplicate_ignored",
  "no_reply_required",
  "failed_retriable",
  "failed_terminal",
]);

const PRIOR_CONTEXT_DEFAULTS = Object.freeze({
  prior_disposition: null,
  prior_intent: null,
  thread_age_days: 2,
  last_outbound_days_ago: 1,
  suppressed: false,
  suppression_reason: null,
});

const PROVIDER_QUIRK_DEFAULTS = Object.freeze({
  duplicate_of: null,
  out_of_order: false,
  missing_timestamp: false,
  delayed_hours: 0,
});

function makeCase({
  case_id,
  category,
  message_body,
  media_urls = [],
  prior_context = {},
  provider_quirks = {},
  expected,
  notes,
}) {
  return {
    case_id,
    category,
    message_body,
    media_urls,
    prior_context: { ...PRIOR_CONTEXT_DEFAULTS, ...prior_context },
    provider_quirks: { ...PROVIDER_QUIRK_DEFAULTS, ...provider_quirks },
    expected: {
      intent_any_of: expected.intent_any_of,
      must_not_auto_reply: expected.must_not_auto_reply,
      must_reach_terminal_disposition: true,
      disposition_any_of: expected.disposition_any_of,
      re_engagement_expected: expected.re_engagement_expected ?? false,
      supersedes_prior_state: expected.supersedes_prior_state ?? false,
    },
    notes,
  };
}

export const ADVERSARIAL_INBOUND_CASES = [
  // ── re_engagement ─────────────────────────────────────────────────────────
  makeCase({
    case_id: "re-engagement-pair-prior-decline",
    category: "re_engagement",
    message_body: "Not interested in selling.",
    prior_context: { thread_age_days: 1, last_outbound_days_ago: 0 },
    expected: {
      intent_any_of: ["not_interested"],
      must_not_auto_reply: false,
      disposition_any_of: ["no_reply_required", "reply_sent", "suppressed_policy"],
      // A fresh decline with no prior positive state is normal state-writing,
      // not supersession — there is nothing stale to supersede. (Reversal
      // supersession requires a prior positive; see the reordered-webhook
      // decline-over-latent_interest case.)
      supersedes_prior_state: false,
    },
    notes: "First leg of the canonical re-engagement pair: a clean decline that should set prior_disposition=not_interested.",
  }),
  makeCase({
    case_id: "re-engagement-pair-canonical-return",
    category: "re_engagement",
    message_body: "Are you still interested in buying?",
    prior_context: {
      prior_disposition: "not_interested",
      prior_intent: "not_interested",
      thread_age_days: 95,
      last_outbound_days_ago: 94,
      suppressed: true,
      suppression_reason: "not_interested",
    },
    expected: {
      intent_any_of: ["seller_interested", "asks_offer", "latent_interest", "info_request"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"],
      re_engagement_expected: true,
      supersedes_prior_state: true,
    },
    notes: "Canonical re-engagement: prior 'Not interested in selling.' must NOT keep a soft-suppressed seller from re-opening the thread.",
  }),
  makeCase({
    case_id: "re-engagement-need-time-followthrough",
    category: "re_engagement",
    message_body: "Ok I've thought it over. Let's talk numbers on the house.",
    prior_context: {
      prior_disposition: "no_reply_required",
      prior_intent: "need_time",
      thread_age_days: 45,
      last_outbound_days_ago: 44,
    },
    expected: {
      intent_any_of: ["seller_interested", "asks_offer", "callback_requested", "latent_interest"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
      re_engagement_expected: true,
      supersedes_prior_state: true,
    },
    notes: "A 'need time' seller returning warm should supersede the stale need_time state and resume the funnel.",
  }),
  makeCase({
    case_id: "re-engagement-positive-after-opt-out",
    category: "re_engagement",
    message_body: "Hey I know I said stop before, but things changed and we're ready to sell the house now.",
    prior_context: {
      prior_disposition: "suppressed_opt_out",
      prior_intent: "opt_out",
      thread_age_days: 120,
      last_outbound_days_ago: 119,
      suppressed: true,
      suppression_reason: "opt_out",
    },
    expected: {
      // opt_out: the classifier deliberately re-honors the quoted "I said
      // stop" as a compliance echo (TCPA-conservative). Either reading keeps
      // automation silent; neither may clear the standing STOP record.
      intent_any_of: ["seller_interested", "latent_interest", "unclear", "opt_out"],
      must_not_auto_reply: true,
      // suppressed_opt_out: the conservative opt_out reading re-affirms the
      // existing suppression instead of routing to review — equally silent,
      // and the prior STOP stays authoritative either way.
      disposition_any_of: ["human_review_required", "suppressed_opt_out"],
      re_engagement_expected: true,
      supersedes_prior_state: false,
    },
    notes: "Seller-initiated positive text AFTER an opt-out: automation must stay silent (human review or re-affirmed opt-out suppression); the STOP record is never auto-cleared.",
  }),

  // ── contradiction ─────────────────────────────────────────────────────────
  makeCase({
    case_id: "contradiction-not-selling-but-asks-price",
    category: "contradiction",
    message_body: "I'm not selling. How much would you offer though?",
    expected: {
      intent_any_of: ["not_interested", "asks_offer", "latent_interest", "unclear"],
      must_not_auto_reply: false,
      // no_reply_required: when the decline leg wins intent precedence the
      // engine deliberately stays quiet — a safe terminal, not a drop.
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required", "no_reply_required"],
    },
    notes: "Self-contradicting decline + price curiosity; the curiosity leg is the actionable signal but either intent is defensible.",
  }),
  makeCase({
    case_id: "contradiction-stop-then-question",
    category: "contradiction",
    message_body: "Stop texting me. Actually wait, how much are we even talking here?",
    expected: {
      intent_any_of: ["opt_out", "asks_offer", "hostile_or_legal"],
      must_not_auto_reply: true,
      disposition_any_of: ["suppressed_opt_out", "human_review_required"],
    },
    notes: "Opt-out language followed by interest in one message: compliance precedence must win; no automated reply.",
  }),
  makeCase({
    case_id: "contradiction-sold-but-owns-another",
    category: "contradiction",
    message_body: "I sold that property already but I do have another rental I'd maybe let go of.",
    expected: {
      // Certification pass 2026-08-25: sold is the property-scoped
      // sold_property lane, and the second-clause opportunity is preserved —
      // the compound routes to human review (sold_with_new_opportunity) with
      // the contact NEVER suppressed.
      intent_any_of: ["sold_property", "seller_interested", "latent_interest"],
      must_not_auto_reply: false,
      disposition_any_of: ["human_review_required", "reply_sent", "reply_deferred_compliance"],
    },
    notes: "Sold-the-target-property plus a new opportunity: property-A pairing closes (disposition sold), the seller stays reachable, and the new-opportunity clause reaches a human with the compound payload.",
  }),

  // ── short_reply ───────────────────────────────────────────────────────────
  makeCase({
    case_id: "short-reply-yes",
    category: "short_reply",
    message_body: "Yes",
    prior_context: { prior_intent: "info_request", last_outbound_days_ago: 0 },
    expected: {
      intent_any_of: ["acknowledgement", "seller_interested", "ownership_confirmed", "unclear"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "no_reply_required", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Bare 'Yes' is context-bound; without validated context it must stay low-confidence rather than assert ownership/interest.",
  }),
  makeCase({
    case_id: "short-reply-no",
    category: "short_reply",
    message_body: "No",
    prior_context: { last_outbound_days_ago: 0 },
    expected: {
      intent_any_of: ["not_interested", "unclear"],
      must_not_auto_reply: false,
      disposition_any_of: ["no_reply_required", "reply_sent"],
    },
    notes: "Bare 'No' most plausibly declines the last outbound question; must not be treated as an opt-out.",
  }),
  makeCase({
    case_id: "short-reply-maybe",
    category: "short_reply",
    message_body: "Maybe",
    expected: {
      intent_any_of: ["unclear", "latent_interest", "need_time"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "no_reply_required", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Hedged single word: the short-utterance guard should keep it unclear/latent, never a confident seller_interested.",
  }),
  makeCase({
    case_id: "short-reply-k",
    category: "short_reply",
    message_body: "K",
    expected: {
      intent_any_of: ["acknowledgement", "unclear"],
      must_not_auto_reply: false,
      // Low-confidence one-letter reply routes to review in replay — safe.
      disposition_any_of: ["no_reply_required", "reply_sent", "human_review_required"],
    },
    notes: "One-letter acknowledgement; replying at all is optional, re-pitching would be wrong.",
  }),
  makeCase({
    case_id: "short-reply-emoji-thumbs-up",
    category: "short_reply",
    message_body: "\u{1F44D}",
    expected: {
      intent_any_of: ["acknowledgement", "reaction_only", "unclear"],
      must_not_auto_reply: false,
      // reaction_only is not auto-replyable, so replay routes it to review.
      disposition_any_of: ["no_reply_required", "reply_sent", "human_review_required"],
    },
    notes: "Emoji-only positive reaction; a terminal no_reply_required is acceptable, a hard failure is not.",
  }),

  // ── long_rambling ─────────────────────────────────────────────────────────
  makeCase({
    case_id: "long-rambling-life-story-maybe-sell",
    category: "long_rambling",
    message_body:
      "Well its funny you text because my late husband and I bought that place back in 1998 and we raised all three kids there, the big oak out front he planted himself, anyway after he passed I moved in with my daughter in Franklin and we been renting it to a nice family but the roof started leaking last spring and honestly I am getting too old to deal with tenants calling about every little thing so I dont know, maybe it is time, what is it you all do exactly?",
    expected: {
      intent_any_of: ["seller_interested", "latent_interest", "condition_disclosed", "tenant_occupied", "info_request"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"],
    },
    notes: "Buried lede: tired-landlord motivation + tenant + roof condition inside a life story; engine must extract, not stall on length.",
  }),
  makeCase({
    case_id: "long-rambling-no-clear-ask",
    category: "long_rambling",
    message_body:
      "You know everybody keeps texting about that house, must have got my number off some list, the county has it all wrong anyway the taxes went up twice, my neighbor sold his and regretted it, market is crazy, nobody knows what anything is worth anymore, they built those new townhomes down the street and now the traffic is terrible, anyway that is all I will say about that.",
    expected: {
      intent_any_of: ["unclear", "latent_interest", "reaction_only", "who_is_this"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "human_review_required", "no_reply_required"],
    },
    notes: "Long venting with no actionable ask; safe outcome is a gentle clarifier or graceful no-op, never a price pitch.",
  }),

  // ── multi_question ────────────────────────────────────────────────────────
  makeCase({
    case_id: "multi-question-who-price-roof",
    category: "multi_question",
    message_body: "Who is this? And how much would you pay? House needs a new roof btw",
    expected: {
      intent_any_of: ["who_is_this", "asks_offer", "condition_disclosed"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Compound identity + offer + condition in one SMS; reply should answer identity and advance the offer conversation.",
  }),
  makeCase({
    case_id: "multi-question-process-fees-timeline",
    category: "multi_question",
    message_body: "How does this actually work? Do you charge any fees or commissions? And how fast could you close if we agreed?",
    expected: {
      intent_any_of: ["info_request", "asks_offer", "seller_interested"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Three process questions from a warm seller; all-question messages must not fall through to unclear.",
  }),

  // ── slang ─────────────────────────────────────────────────────────────────
  makeCase({
    case_id: "slang-mite-sell-depends-payin",
    category: "slang",
    message_body: "ya i mite sell idk depends wat u payin",
    expected: {
      intent_any_of: ["seller_interested", "asks_offer", "latent_interest"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Heavy slang/abbreviation conditional interest; must be read as price-contingent interest, not unclear.",
  }),
  makeCase({
    case_id: "slang-hw-much",
    category: "slang",
    message_body: "hw much",
    expected: {
      intent_any_of: ["asks_offer", "info_request", "unclear"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Two-token vowel-dropped price ask; the highest-value two-word inbound in the funnel.",
  }),

  // ── typos ─────────────────────────────────────────────────────────────────
  makeCase({
    case_id: "typos-intrested-seling",
    category: "typos",
    message_body: "Im intrested in seling how mch wuld u pay",
    expected: {
      intent_any_of: ["seller_interested", "asks_offer", "latent_interest", "unclear"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Every keyword misspelled; keyword-exact matchers will miss it, so the fuzzy/AI path must carry it.",
  }),
  makeCase({
    case_id: "typos-not-intersted-sry",
    category: "typos",
    message_body: "not intersted sry",
    expected: {
      intent_any_of: ["not_interested"],
      must_not_auto_reply: false,
      disposition_any_of: ["no_reply_required", "reply_sent"],
    },
    notes: "Misspelled decline ('intersted' is in the known-misspelling list); should close politely, not re-pitch.",
  }),

  // ── sarcasm ───────────────────────────────────────────────────────────────
  makeCase({
    case_id: "sarcasm-just-give-you-my-house",
    category: "sarcasm",
    message_body: "Oh sure, I'll just GIVE you my house lol",
    expected: {
      intent_any_of: ["reaction_only", "not_interested", "unclear"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "no_reply_required", "human_review_required"],
    },
    notes: "Sarcasm that literally reads as agreement; classifying it as seller_interested would be a category error.",
  }),
  makeCase({
    case_id: "sarcasm-whats-the-catch",
    category: "sarcasm",
    message_body: "lol yeah right, another 'cash offer' huh. whats the catch",
    expected: {
      intent_any_of: ["reaction_only", "who_is_this", "info_request", "unclear"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "no_reply_required", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Skeptical sarcasm with a genuine embedded question; the 'whats the catch' leg is answerable.",
  }),

  // ── spanish ───────────────────────────────────────────────────────────────
  makeCase({
    case_id: "spanish-no-me-interesa",
    category: "spanish",
    message_body: "No me interesa gracias",
    expected: {
      intent_any_of: ["not_interested"],
      must_not_auto_reply: false,
      disposition_any_of: ["no_reply_required", "reply_sent"],
    },
    notes: "Polite Spanish decline; language should detect Spanish and it must NOT be read as a compliance opt-out.",
  }),
  makeCase({
    case_id: "spanish-cuanto-ofrecen",
    category: "spanish",
    message_body: "¿Cuánto ofrecen por la casa?",
    expected: {
      intent_any_of: ["asks_offer", "info_request"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Spanish price ask; reply should continue in Spanish per language detection.",
  }),
  makeCase({
    case_id: "spanish-ya-la-vendi",
    category: "spanish",
    message_body: "Ya la vendí",
    expected: {
      // Certification pass 2026-08-25: Spanish sold reports land on the
      // property-scoped sold_property lane; the phone is never suppressed.
      intent_any_of: ["sold_property", "unclear"],
      must_not_auto_reply: true,
      disposition_any_of: ["no_reply_required", "human_review_required"],
    },
    notes: "Spanish 'already sold it' (feminine object); property-scoped sold disposition, contact stays reachable.",
  }),

  // ── language_switch ───────────────────────────────────────────────────────
  makeCase({
    case_id: "language-switch-english-to-spanish",
    category: "language_switch",
    message_body: "Mejor hablemos en español. ¿Cuánto me dan por la casa?",
    prior_context: { prior_intent: "info_request", thread_age_days: 3, last_outbound_days_ago: 0 },
    expected: {
      intent_any_of: ["asks_offer", "seller_interested", "info_request"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Mid-thread switch from English to Spanish with a live price ask; language preference should update, funnel continues.",
  }),
  makeCase({
    case_id: "language-switch-spanglish-family-gate",
    category: "language_switch",
    message_body: "Ok that price could work pero necesito hablar con mi esposo first",
    prior_context: { prior_intent: "asks_offer", last_outbound_days_ago: 0 },
    expected: {
      intent_any_of: ["need_time", "latent_interest", "seller_interested", "unclear"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "no_reply_required", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Spanglish spouse-approval gate; positive lean but blocked on family sign-off, must not force a close.",
  }),

  // ── hostile ───────────────────────────────────────────────────────────────
  makeCase({
    case_id: "hostile-lawyer-threat-harassment",
    category: "hostile",
    message_body: "stop harassing me or I'll call my lawyer",
    expected: {
      intent_any_of: ["opt_out", "hostile_or_legal"],
      must_not_auto_reply: true,
      disposition_any_of: ["suppressed_opt_out", "suppressed_policy", "human_review_required"],
    },
    notes: "Harassment + legal threat; 'stop harassing me' is in the compliance phrase list, so terminal opt-out semantics apply.",
  }),
  makeCase({
    case_id: "hostile-profanity-no-optout",
    category: "hostile",
    message_body: "f*** off with these texts man, you vultures are buying up the whole damn neighborhood",
    expected: {
      intent_any_of: ["hostile_or_legal", "not_interested", "unclear"],
      must_not_auto_reply: true,
      disposition_any_of: ["human_review_required", "suppressed_policy", "no_reply_required"],
    },
    notes: "Profanity-laced anger without carrier opt-out keywords; auto-replying into hostility is a brand/compliance hazard.",
  }),
  makeCase({
    case_id: "hostile-emoji-middle-finger",
    category: "hostile",
    message_body: "\u{1F595}",
    expected: {
      intent_any_of: ["hostile_or_legal", "reaction_only", "unclear"],
      must_not_auto_reply: true,
      disposition_any_of: ["no_reply_required", "human_review_required", "suppressed_policy"],
    },
    notes: "Emoji-only hostility; must terminate quietly rather than trigger a cheery template.",
  }),

  // ── opt_out ───────────────────────────────────────────────────────────────
  makeCase({
    case_id: "opt-out-stop-uppercase",
    category: "opt_out",
    message_body: "STOP",
    expected: {
      intent_any_of: ["opt_out"],
      must_not_auto_reply: true,
      disposition_any_of: ["suppressed_opt_out"],
    },
    notes: "Carrier-standard STOP keyword; compliance_flag=stop_texting, immediate suppression.",
  }),
  makeCase({
    case_id: "opt-out-stop-lowercase",
    category: "opt_out",
    message_body: "stop",
    expected: {
      intent_any_of: ["opt_out"],
      must_not_auto_reply: true,
      disposition_any_of: ["suppressed_opt_out"],
    },
    notes: "Lowercase stop must be honored identically to STOP (case-insensitive exact match).",
  }),
  makeCase({
    case_id: "opt-out-stop-texting-me",
    category: "opt_out",
    message_body: "Stop texting me",
    expected: {
      intent_any_of: ["opt_out"],
      must_not_auto_reply: true,
      disposition_any_of: ["suppressed_opt_out"],
    },
    notes: "Phrase-intent opt-out (TCPA 'any reasonable means'), not just the bare keyword.",
  }),
  makeCase({
    case_id: "opt-out-unsubscribe",
    category: "opt_out",
    message_body: "unsubscribe",
    expected: {
      intent_any_of: ["opt_out"],
      must_not_auto_reply: true,
      disposition_any_of: ["suppressed_opt_out"],
    },
    notes: "Email-style unsubscribe keyword is in the carrier exact set; same terminal handling.",
  }),
  makeCase({
    case_id: "opt-out-quit-please",
    category: "opt_out",
    message_body: "QUIT PLEASE",
    expected: {
      intent_any_of: ["opt_out"],
      must_not_auto_reply: true,
      disposition_any_of: ["suppressed_opt_out"],
    },
    notes: "Carrier keyword QUIT with a trailing word; starts-with-keyword handling must still fire.",
  }),

  // ── wrong_number ──────────────────────────────────────────────────────────
  makeCase({
    case_id: "wrong-number-plain",
    category: "wrong_number",
    message_body: "wrong number",
    expected: {
      intent_any_of: ["wrong_number"],
      must_not_auto_reply: true,
      disposition_any_of: ["suppressed_wrong_number"],
    },
    notes: "Canonical wrong-number; suppress the phone-property link, do not send follow-ups.",
  }),
  makeCase({
    case_id: "wrong-number-who-dis-never-owned",
    category: "wrong_number",
    message_body: "who dis? I never owned that",
    expected: {
      intent_any_of: ["wrong_number", "who_is_this"],
      must_not_auto_reply: true,
      disposition_any_of: ["suppressed_wrong_number", "human_review_required"],
    },
    notes: "Slang identity question plus never-owned denial; ownership disconnect outranks the identity question.",
  }),
  makeCase({
    case_id: "wrong-number-wrong-person-bro",
    category: "wrong_number",
    message_body: "u got the wrong person bro",
    expected: {
      intent_any_of: ["wrong_number"],
      must_not_auto_reply: true,
      disposition_any_of: ["suppressed_wrong_number"],
    },
    notes: "True wrong-person at this phone (matchesTrueWrongNumber territory); terminal suppression.",
  }),
  makeCase({
    case_id: "wrong-number-sold-last-year",
    category: "wrong_number",
    message_body: "I sold that house last year",
    expected: {
      // Certification pass 2026-08-25: right person, sold property —
      // sold_property closes the pairing (deliberate no-reply with durable
      // reason) and never suppresses the contact.
      intent_any_of: ["sold_property"],
      must_not_auto_reply: true,
      disposition_any_of: ["no_reply_required", "human_review_required"],
    },
    notes: "Sold-property report: property pairing closes; the person remains a legitimate contact for other properties.",
  }),
  makeCase({
    case_id: "wrong-number-closed-in-march",
    category: "wrong_number",
    message_body: "we closed on it in March",
    expected: {
      intent_any_of: ["wrong_number", "unclear"],
      must_not_auto_reply: true,
      disposition_any_of: ["suppressed_wrong_number", "human_review_required", "no_reply_required"],
    },
    notes: "Indirect 'already sold' phrasing with no sold-keyword; tests inference beyond the phrase list.",
  }),

  // ── referral ──────────────────────────────────────────────────────────────
  makeCase({
    case_id: "referral-brother-handles-it",
    category: "referral",
    message_body: "Talk to my brother he handles it 612-555-0142",
    expected: {
      intent_any_of: ["callback_requested", "need_time", "unclear", "info_request"],
      must_not_auto_reply: false,
      disposition_any_of: ["human_review_required", "reply_sent", "reply_deferred_compliance"],
    },
    notes: "Third-party referral with a new phone number; auto-texting the referred number without consent is a TCPA trap, so human review is preferred.",
  }),
  makeCase({
    case_id: "referral-wife-makes-decisions",
    category: "referral",
    message_body: "my wife makes those decisions",
    expected: {
      intent_any_of: ["unclear", "need_time", "latent_interest"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "no_reply_required", "human_review_required"],
    },
    notes: "Spouse-deferral; classify.js deliberately leaves spouse-only language unclear (no false ownership, no forced decline).",
  }),

  // ── multiple_owners ───────────────────────────────────────────────────────
  makeCase({
    case_id: "multiple-owners-siblings-on-deed",
    category: "multiple_owners",
    message_body: "There's 4 of us on the deed, all my siblings would have to agree before anything gets signed",
    expected: {
      intent_any_of: ["need_time", "ownership_confirmed", "latent_interest", "unclear"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"],
    },
    notes: "Multi-owner consensus gate; a real ownership confirmation wrapped in a coordination blocker.",
  }),
  makeCase({
    case_id: "multiple-owners-ex-on-title",
    category: "multiple_owners",
    message_body: "me and my ex are both still on title, its complicated right now",
    expected: {
      intent_any_of: ["ownership_confirmed", "need_time", "unclear", "condition_disclosed"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "human_review_required", "no_reply_required"],
    },
    notes: "Divorce-entangled title; sensitive situation where a pushy automated cadence would be tone-deaf.",
  }),

  // ── old_campaign ──────────────────────────────────────────────────────────
  makeCase({
    case_id: "old-campaign-8-months-offer-still-good",
    category: "old_campaign",
    message_body: "Hey is that offer you texted about the Maple St house still on the table?",
    prior_context: {
      prior_disposition: "no_reply_required",
      prior_intent: null,
      thread_age_days: 243,
      last_outbound_days_ago: 240,
    },
    provider_quirks: { delayed_hours: 0 },
    expected: {
      intent_any_of: ["asks_offer", "seller_interested", "latent_interest"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"],
      re_engagement_expected: true,
    },
    notes: "Reply to an 8-month-old campaign; any quoted numbers are stale, so the engine must re-anchor rather than confirm the old offer.",
  }),
  makeCase({
    case_id: "old-campaign-circumstances-changed",
    category: "old_campaign",
    message_body: "Circumstances have changed since last year. What could you pay for it now?",
    prior_context: {
      prior_disposition: "no_reply_required",
      prior_intent: "not_interested",
      thread_age_days: 310,
      last_outbound_days_ago: 300,
      suppressed: true,
      suppression_reason: "not_interested",
    },
    expected: {
      intent_any_of: ["seller_interested", "asks_offer", "latent_interest"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"],
      re_engagement_expected: true,
      supersedes_prior_state: true,
    },
    notes: "Ten-month-old not_interested suppression re-opened by the seller; the new interest supersedes the stale decline.",
  }),

  // ── duplicate_webhook ─────────────────────────────────────────────────────
  makeCase({
    case_id: "duplicate-webhook-spanish-asks-offer",
    category: "duplicate_webhook",
    message_body: "¿Cuánto ofrecen por la casa?",
    prior_context: { prior_intent: "asks_offer", last_outbound_days_ago: 0 },
    provider_quirks: { duplicate_of: "spanish-cuanto-ofrecen" },
    expected: {
      intent_any_of: ["asks_offer", "info_request"],
      must_not_auto_reply: true,
      disposition_any_of: ["duplicate_ignored"],
      supersedes_prior_state: false,
    },
    notes: "Provider redelivers the same webhook (same provider message id as spanish-cuanto-ofrecen); exactly one reply may ever exist.",
  }),
  makeCase({
    case_id: "duplicate-webhook-opt-out-redelivery",
    category: "duplicate_webhook",
    message_body: "STOP",
    prior_context: {
      prior_disposition: "suppressed_opt_out",
      prior_intent: "opt_out",
      suppressed: true,
      suppression_reason: "opt_out",
      last_outbound_days_ago: 0,
    },
    provider_quirks: { duplicate_of: "opt-out-stop-uppercase" },
    expected: {
      intent_any_of: ["opt_out"],
      must_not_auto_reply: true,
      disposition_any_of: ["duplicate_ignored", "suppressed_opt_out"],
      supersedes_prior_state: false,
    },
    notes: "Redelivered STOP webhook; idempotent — suppression already recorded, no second confirmation SMS.",
  }),

  // ── reordered_webhook ─────────────────────────────────────────────────────
  makeCase({
    case_id: "reordered-webhook-newer-decline-arrives-first",
    category: "reordered_webhook",
    message_body: "Actually forget it, we're not selling.",
    prior_context: { prior_intent: "latent_interest", last_outbound_days_ago: 0 },
    provider_quirks: { out_of_order: false },
    expected: {
      intent_any_of: ["not_interested"],
      must_not_auto_reply: false,
      disposition_any_of: ["no_reply_required", "reply_sent"],
      supersedes_prior_state: true,
    },
    notes: "Chronologically NEWER decline that the provider delivers first; pairs with reordered-webhook-stale-interest-arrives-late.",
  }),
  makeCase({
    case_id: "reordered-webhook-stale-interest-arrives-late",
    category: "reordered_webhook",
    message_body: "Yes I'd consider selling for the right price",
    prior_context: { prior_disposition: "no_reply_required", prior_intent: "not_interested", last_outbound_days_ago: 0 },
    provider_quirks: { out_of_order: true },
    expected: {
      intent_any_of: ["seller_interested", "latent_interest"],
      must_not_auto_reply: true,
      disposition_any_of: ["no_reply_required", "duplicate_ignored", "human_review_required"],
      supersedes_prior_state: false,
    },
    notes: "OLDER message delivered after the newer decline (out_of_order); latest-send-wins — it must not clobber the decline or trigger a pitch.",
  }),

  // ── burst (3 messages within seconds) ─────────────────────────────────────
  makeCase({
    case_id: "burst-fragment-1-of-3",
    category: "burst",
    message_body: "Yeah",
    prior_context: { prior_intent: "info_request", last_outbound_days_ago: 0 },
    expected: {
      intent_any_of: ["acknowledgement", "ownership_confirmed", "unclear"],
      must_not_auto_reply: false,
      disposition_any_of: ["no_reply_required", "reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "First fragment of a 3-message burst arriving within seconds; debounce should hold the reply for the full burst.",
  }),
  makeCase({
    case_id: "burst-fragment-2-of-3",
    category: "burst",
    message_body: "I mean we might sell it",
    prior_context: { prior_intent: "info_request", last_outbound_days_ago: 0 },
    expected: {
      intent_any_of: ["latent_interest", "seller_interested", "unclear"],
      must_not_auto_reply: false,
      disposition_any_of: ["no_reply_required", "reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Middle fragment of the burst; still incomplete thought, one aggregated reply is the goal.",
  }),
  makeCase({
    case_id: "burst-fragment-3-of-3",
    category: "burst",
    message_body: "what would u offer for it? it needs some work tho",
    prior_context: { prior_intent: "info_request", last_outbound_days_ago: 0 },
    expected: {
      intent_any_of: ["asks_offer", "condition_disclosed", "seller_interested"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Final burst fragment carrying the real ask; exactly one reply for the whole burst, anchored on this fragment.",
  }),

  // ── delayed_delivery ──────────────────────────────────────────────────────
  makeCase({
    case_id: "delayed-delivery-26h-callback",
    category: "delayed_delivery",
    message_body: "Sure, call me tomorrow around noon",
    prior_context: { prior_intent: "callback_requested", last_outbound_days_ago: 1 },
    provider_quirks: { delayed_hours: 26 },
    expected: {
      intent_any_of: ["callback_requested", "acknowledgement", "seller_interested"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"],
    },
    notes: "Provider delivered 26h late so 'tomorrow at noon' has already passed; naive scheduling off message text would book the wrong day.",
  }),

  // ── missing_timestamp ─────────────────────────────────────────────────────
  makeCase({
    case_id: "missing-timestamp-owner-confirms",
    category: "missing_timestamp",
    message_body: "Yes this is the owner, what do you want to know",
    provider_quirks: { missing_timestamp: true },
    expected: {
      intent_any_of: ["ownership_confirmed", "info_request", "seller_interested"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Webhook payload missing the provider timestamp; ingest must fall back to receipt time, not crash or drop the message.",
  }),

  // ── empty_body ────────────────────────────────────────────────────────────
  makeCase({
    case_id: "empty-body-blank-sms",
    category: "empty_body",
    message_body: "",
    expected: {
      intent_any_of: ["unclear"],
      must_not_auto_reply: true,
      disposition_any_of: ["no_reply_required", "human_review_required", "failed_terminal"],
    },
    notes: "Zero-length body (carrier artifact or pocket send); must reach a quiet terminal state, never an auto-reply to nothing.",
  }),

  // ── media_only ────────────────────────────────────────────────────────────
  makeCase({
    case_id: "media-only-property-photo",
    category: "media_only",
    message_body: "",
    media_urls: ["https://mms.provider.invalid/media/msg-8f3a/photo-1.jpg"],
    expected: {
      intent_any_of: ["unclear", "condition_disclosed"],
      must_not_auto_reply: true,
      disposition_any_of: ["human_review_required", "no_reply_required"],
    },
    notes: "MMS with an image and no text (likely a house/condition photo); replying without seeing the media is guessing.",
  }),

  // ── identity ──────────────────────────────────────────────────────────────
  makeCase({
    case_id: "identity-who-is-this-how-got-number",
    category: "identity",
    message_body: "Who is this and how did you get my number?",
    expected: {
      intent_any_of: ["who_is_this"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Identity + data-provenance question; reply must identify the sender honestly (CTIA identification requirement).",
  }),
  makeCase({
    case_id: "identity-is-this-a-scam",
    category: "identity",
    message_body: "Is this a scam? are you even a real company",
    expected: {
      intent_any_of: ["who_is_this", "info_request", "unclear"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Scam suspicion is an identity challenge, not hostility; a verifiable-identity reply can convert it.",
  }),

  // ── legal_financial ───────────────────────────────────────────────────────
  makeCase({
    case_id: "legal-probate-mother-passed",
    category: "legal_financial",
    message_body: "My mother passed, the house is in probate",
    expected: {
      intent_any_of: ["ownership_confirmed", "unclear", "latent_interest", "condition_disclosed"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "human_review_required", "reply_deferred_compliance"],
    },
    notes: "Grief + probate identity complexity; classify.js keeps probate/estate as ownership_confirmed, tone must be condolence-first.",
  }),
  makeCase({
    case_id: "legal-trust-llc-trustee",
    category: "legal_financial",
    message_body: "The property is held in our family trust, I'm the trustee. It would be an LLC-to-LLC sale. What are you offering?",
    expected: {
      // trust_ownership/llc_corporation added (detector-completion pass):
      // entity-held title now resolves to the finer legal/authority label —
      // human verification lane per the ontology — instead of a bare
      // ownership/offer read. The offer ask is preserved as a secondary
      // intent (compound preservation).
      intent_any_of: ["trust_ownership", "llc_corporation", "ownership_confirmed", "asks_offer", "info_request"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"],
    },
    notes: "Entity-held title with an authorized signer asking for the offer; sophisticated seller, entity paperwork implications.",
  }),
  makeCase({
    case_id: "legal-tax-lien-still-buy",
    category: "legal_financial",
    message_body: "Theres a tax lien on it from 2023, would you still buy it?",
    expected: {
      // lien_tax_issue added (detector-completion pass): a lien disclosure is
      // now the finer legal/authority label (human scopes payoff feasibility
      // per the ontology) instead of folding into generic condition facts.
      // The live interest is preserved as a secondary intent.
      intent_any_of: ["lien_tax_issue", "condition_disclosed", "seller_interested", "info_request"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Lien disclosure paired with live interest; distress signal that raises motivation, not a disqualifier.",
  }),
  makeCase({
    case_id: "legal-foreclosure-close-this-week",
    category: "legal_financial",
    message_body: "The bank is about to take it, can you close this week??",
    expected: {
      intent_any_of: ["seller_interested", "callback_requested", "condition_disclosed"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"],
    },
    notes: "Foreclosure urgency with an impossible-timeline ask; highest-motivation seller in the corpus, needs fast human escalation.",
  }),

  // ── legal_financial: detector-completion pass (title/lien/bankruptcy/
  //    trust/entity + negation guards) ────────────────────────────────────────
  makeCase({
    case_id: "legal-title-cloud-quiet-title",
    category: "legal_financial",
    // "lawyer says" would rank hostile_or_legal first (any legal-counsel
    // mention is conservatively a human lane) — this case pins the title
    // detector itself.
    message_body: "Theres a cloud on the title from my late husbands name, we need a quiet title action first",
    expected: {
      intent_any_of: ["title_issue"],
      must_not_auto_reply: true,
      disposition_any_of: ["human_review_required"],
    },
    notes: "Clouded title requiring legal cure; human lane before any offer per the legal_financial ontology contract.",
  }),
  makeCase({
    case_id: "legal-bankruptcy-chapter13-wants-sale",
    category: "legal_financial",
    message_body: "Im in chapter 13 right now but I was told I can sell the house, how fast could you close?",
    expected: {
      intent_any_of: ["bankruptcy_disclosed"],
      must_not_auto_reply: true,
      disposition_any_of: ["human_review_required"],
    },
    notes: "Bankruptcy disclosure: automatic-stay/trustee-approval implications force a human verification lane despite the live interest.",
  }),
  makeCase({
    case_id: "legal-corporation-authorized-signer",
    category: "legal_financial",
    message_body: "That property belongs to our corporation. I am the authorized signer so you can deal with me directly",
    expected: {
      intent_any_of: ["llc_corporation"],
      must_not_auto_reply: true,
      disposition_any_of: ["human_review_required"],
    },
    notes: "Entity-held ownership with an authorized-signer claim; signing authority must be verified by a human.",
  }),
  makeCase({
    case_id: "legal-spanish-tax-lien",
    category: "legal_financial",
    message_body: "La casa tiene un gravamen de impuestos, ¿todavía la quieren comprar?",
    expected: {
      intent_any_of: ["lien_tax_issue"],
      must_not_auto_reply: true,
      disposition_any_of: ["human_review_required"],
    },
    notes: "Spanish lien disclosure (gravamen) with live interest; legal lane wins, interest preserved as secondary.",
  }),
  makeCase({
    case_id: "legal-negated-lien-clean-title-guard",
    category: "legal_financial",
    message_body: "No liens on it and taxes are current. what would you offer for it?",
    expected: {
      // Negation guard: assurances must NOT trip the lien/title detectors —
      // this is a clean offer ask.
      intent_any_of: ["asks_offer", "seller_interested", "info_request"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"],
    },
    notes: "Lien/tax negation guard: 'no liens' + 'taxes are current' is an assurance, not a disclosure.",
  }),
  makeCase({
    case_id: "legal-trust-me-sense-guard",
    category: "legal_financial",
    message_body: "trust me you dont want this place lol it needs everything",
    expected: {
      // Sense guard: conversational "trust me" must never trip trust_ownership.
      intent_any_of: ["condition_disclosed", "not_interested", "unclear"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "no_reply_required", "human_review_required"],
    },
    notes: "Trust-ownership sense guard: 'trust me' is conversation, not a trust-held title.",
  }),

  // ── logistics: contact modality + language switch (detector-completion) ───
  makeCase({
    case_id: "logistics-voicemail-callback",
    category: "logistics",
    message_body: "Just call and leave a voicemail if I dont pick up, I do want to hear the number",
    expected: {
      intent_any_of: ["voicemail_call_request", "callback_requested", "asks_offer"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"],
    },
    notes: "Voicemail-mediated callback ask; routes with the callback family (SMS acknowledges, human calls).",
  }),
  makeCase({
    case_id: "logistics-email-preference",
    category: "logistics",
    message_body: "Can you email me the details instead? I prefer email over texting",
    expected: {
      intent_any_of: ["requests_email"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"],
    },
    notes: "Email-preference lane (ontology requests_email) — no longer folded into callback_requested.",
  }),
  makeCase({
    case_id: "logistics-dont-email-guard",
    category: "logistics",
    message_body: "do not email me, text is fine. what is your offer?",
    expected: {
      // Refusal guard: "do not email" must not become requests_email.
      intent_any_of: ["asks_offer", "info_request", "seller_interested"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"],
    },
    notes: "Email-refusal guard: a channel refusal is not a channel request; the offer ask should drive.",
  }),
  makeCase({
    case_id: "logistics-language-switch-solo",
    category: "language_switch",
    message_body: "No hablo ingles. En español por favor",
    expected: {
      intent_any_of: ["language_switch"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"],
    },
    notes: "Pure language-switch request with no other content; conversation continues in Spanish via language continuity.",
  }),

  // ── compound: multi-family preservation (detector-completion) ─────────────
  makeCase({
    case_id: "compound-probate-executor-price",
    category: "compound",
    message_body: "Property is in probate, my sister is the executor, and we want 150k for it",
    expected: {
      // Compound preservation: price + ownership/authority components must
      // both survive; primary is the price (INTENT_PRIORITY), the probate
      // objection + executor relationship carry the authority state.
      intent_any_of: ["asking_price_provided", "ownership_confirmed"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"],
    },
    notes: "Canonical compound message: probate authority + executor identity + asking price in one turn; nothing may be flattened away.",
  }),
  makeCase({
    case_id: "compound-lien-plus-interest",
    category: "compound",
    message_body: "Yes id sell. Heads up there is an IRS lien on it though",
    expected: {
      intent_any_of: ["lien_tax_issue"],
      must_not_auto_reply: true,
      disposition_any_of: ["human_review_required"],
    },
    notes: "Interest + lien: the legal tier outranks engagement so payoff feasibility is scoped by a human; interest survives as secondary.",
  }),
  makeCase({
    case_id: "legal-cease-and-desist-attorney",
    category: "legal_financial",
    message_body: "Any further contact must go through my attorney. Consider this a cease and desist.",
    expected: {
      intent_any_of: ["hostile_or_legal", "opt_out"],
      must_not_auto_reply: true,
      disposition_any_of: ["suppressed_policy", "suppressed_opt_out", "human_review_required"],
    },
    notes: "Formal legal revocation of contact; must be honored as terminally as STOP even without carrier keywords.",
  }),

  // ── negotiation ───────────────────────────────────────────────────────────
  makeCase({
    case_id: "negotiation-450k-firm",
    category: "negotiation",
    message_body: "I want 450k firm",
    prior_context: { prior_intent: "asks_offer", last_outbound_days_ago: 0 },
    expected: {
      intent_any_of: ["asking_price_provided"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Explicit firm anchor with k-suffix; price_parse should yield 450000 with a 'firm' qualifier.",
  }),
  makeCase({
    case_id: "negotiation-zillow-says-500",
    category: "negotiation",
    message_body: "Zillow says its worth 500",
    prior_context: { prior_intent: "asks_offer", last_outbound_days_ago: 0 },
    expected: {
      intent_any_of: ["asking_price_provided", "seller_interested", "info_request"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Third-party-anchored bare '500' (means 500k in REI SMS); note 'zillow' also lives in the already_listed phrase list — a known trap.",
  }),
  makeCase({
    case_id: "negotiation-lowball-reaction-insulting",
    category: "negotiation",
    message_body: "450?? insulting",
    prior_context: { prior_intent: "asking_price_provided", last_outbound_days_ago: 0 },
    expected: {
      intent_any_of: ["reaction_only", "unclear", "not_interested"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "human_review_required", "no_reply_required"],
    },
    notes: "Insulted lowball reaction (need_more_money objection); the number is OUR offer being rejected, not their asking price.",
  }),
  makeCase({
    case_id: "negotiation-counter-380-floor",
    category: "negotiation",
    message_body: "cant do less than 380 but ill listen to what you got",
    prior_context: { prior_intent: "asking_price_provided", last_outbound_days_ago: 0 },
    expected: {
      intent_any_of: ["asking_price_provided", "seller_interested"],
      must_not_auto_reply: false,
      disposition_any_of: ["reply_sent", "reply_deferred_compliance", "human_review_required"], // review = replay placeholder-degrade (see header)
    },
    notes: "Floor-with-flexibility counter; live negotiation state that must keep the thread hot.",
  }),
];

/**
 * Group the corpus by category.
 * @returns {Record<string, Array<object>>} category → cases (insertion order preserved)
 */
export function listCasesByCategory() {
  const by_category = {};
  for (const category of CORPUS_CATEGORIES) by_category[category] = [];
  for (const c of ADVERSARIAL_INBOUND_CASES) {
    if (!by_category[c.category]) by_category[c.category] = [];
    by_category[c.category].push(c);
  }
  return by_category;
}
