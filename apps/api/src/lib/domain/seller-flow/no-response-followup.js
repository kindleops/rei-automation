// ─── no-response-followup.js ─────────────────────────────────────────────────
// NO-RESPONSE FOLLOW-UPS (owner, 2026-10-06): when the seller goes silent after
//   • S2  — our "are you open to a proposal / interested in selling?" question, or
//   • OFFER — an offer we sent (automated OR typed by the owner in the Inbox),
// the system follows up on its own:
//
//     FU1  +24h after the anchor (our question / our offer)
//     FU2  +72h after FU1, different wording
//     NURTURE  +30 days after FU2, then the chain stops
//
// This module is a POLICY + DISPATCH layer on the EXISTING machinery, never a
// second scheduler:
//   • trigger    delivery-triggered-followup.js (provider-confirmed delivery of
//                the anchor, then of each follow-up — the chain advances one
//                delivered touch at a time);
//   • write      seller-followup-scheduler.scheduleFollowUp (canonical
//                send-queue writer, dedupe, 21610 suppression);
//   • dispatch   process-send-queue → resolve-deferred-queue-message → here
//                (contact window 8am–9pm recipient-local, suppression, sender
//                routing, caps — all the processor's gates run unchanged);
//   • cancel     the inbound takeover in process-seller-inbound-message cancels
//                every pending follow-up on any inbound (these rows are not
//                `nurture_followup:` rows, so nothing spares them).
//
// Gate: system_control `followup_no_response_mode` — disabled (default, also
// for missing/blank/invalid/unreadable) | dry_run | live — AND the existing
// followup_automation_mode must be a scheduling mode. Deploying this file
// changes nothing until the owner sets the key.

import { extractMonetaryMentions } from "@/lib/domain/seller-flow/monetary-understanding.js";
import { identifyReplyLanguage } from "@/lib/domain/classification/seller-reply-language.js";
import { personalizeTemplate } from "@/lib/sms/personalize_template.js";
import { prepareRenderedSmsForQueue } from "@/lib/sms/sanitize.js";
import {
  canonicalPropertyGroupOf,
  filterTemplatesForProperty,
} from "@/lib/domain/templates/template-asset-compatibility.js";

export const NO_RESPONSE_FOLLOWUP_VERSION = "no_response_followup_v1_2026_10_06";
export const NO_RESPONSE_MODE_KEY = "followup_no_response_mode";
export const NO_RESPONSE_CONFIG_KEY = "followup_no_response_config";
export const NO_RESPONSE_MODES = Object.freeze(["disabled", "dry_run", "live"]);

export const NO_RESPONSE_KINDS = Object.freeze({ S2_INTEREST: "s2_interest", OFFER: "offer" });

/** Step → template use case. Step index 0 = FU1. */
export const NO_RESPONSE_USE_CASES = Object.freeze({
  [NO_RESPONSE_KINDS.S2_INTEREST]: Object.freeze(["s2_no_response_fu1", "s2_no_response_fu2", "s2_no_response_nurture"]),
  [NO_RESPONSE_KINDS.OFFER]: Object.freeze(["offer_no_response_fu1", "offer_no_response_fu2", "offer_no_response_nurture"]),
});
/** The offer follow-up used when the number is ambiguous / unusable (never quotes money). */
export const OFFER_NO_NUMBER_USE_CASE = "offer_no_response_no_number";
/** Steps whose copy quotes the offer number (nurture never re-quotes a 30-day-old number). */
const OFFER_NUMBER_STEPS = new Set([0, 1]);

export const ALL_NO_RESPONSE_USE_CASES = Object.freeze(
  new Set([...Object.values(NO_RESPONSE_USE_CASES).flat(), OFFER_NO_NUMBER_USE_CASE])
);

export const DEFAULT_NO_RESPONSE_CONFIG = Object.freeze({
  // delays_hours[n] = wait before step n+1, measured from the previous delivered touch.
  [NO_RESPONSE_KINDS.S2_INTEREST]: Object.freeze({ enabled: true, delays_hours: Object.freeze([24, 72, 30 * 24]) }),
  [NO_RESPONSE_KINDS.OFFER]: Object.freeze({ enabled: true, delays_hours: Object.freeze([24, 72, 30 * 24]) }),
  // Reply languages with reviewed copy. Anything else (or unknown) is skipped,
  // never answered in English.
  languages: Object.freeze(["English", "Spanish"]),
  // An anchor older than this when delivered is not a live conversation.
  max_anchor_age_hours: 24 * 14,
});

/** Our templated S2 interest question. */
export const S2_QUESTION_USE_CASES = Object.freeze(new Set(["consider_selling", "consider_selling_follow_up"]));
/** Templated outbounds that carry an offer number. */
export const OFFER_USE_CASES = Object.freeze(
  new Set([
    "initial_offer", "conditional_offer", "counter_offer", "final_offer", "offer_reveal_cash",
    "as_is_comp_anchor", "price_anchor_above_max", "comp_anchor",
  ])
);

/** Last seller intents that hand the thread to the disposition rules instead. */
const DISQUALIFYING_INTENTS = new Set([
  "opt_out", "wrong_number", "wrong_person", "hostile_or_legal", "timing_complaint",
  "not_interested", "need_time", "listed_or_unavailable", "property_specific_non_owner",
  "former_owner_respondent", "non_owner_referral",
]);
/** "please don't call", "stop texting me", "no me escriba" — never nudge them. */
const NO_CONTACT_REQUEST_RE =
  /\b(?:do\s*n['’]?o?t|dont|stop|quit)\s+(?:call|text|contact|messag|bother|reach)|leave me alone|remove (?:me|my number)|take me off|no (?:me )?(?:llame|escriba|moleste|contacte)|deje de (?:llamar|escribir)/i;
const BLOCKED_CONTACTABILITY = new Set([
  "opted_out", "dnc", "do_not_text", "invalid_number", "provider_blacklisted", "wrong_number", "suppressed",
]);

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const HOUR_MS = 3_600_000;

function addHours(iso, hours) {
  const base = Date.parse(clean(iso));
  if (!Number.isFinite(base)) return null;
  return new Date(base + hours * HOUR_MS).toISOString();
}

// ── Gate + config ───────────────────────────────────────────────────────────

export function normalizeNoResponseMode(value) {
  const v = lower(value).replace(/[-\s]+/g, "_");
  return NO_RESPONSE_MODES.includes(v) ? v : "disabled";
}

/** Merge a system_control JSON override onto the defaults. Invalid parts are ignored. */
export function resolveNoResponseConfig(override = null) {
  let raw = override;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  const out = {
    [NO_RESPONSE_KINDS.S2_INTEREST]: { ...DEFAULT_NO_RESPONSE_CONFIG[NO_RESPONSE_KINDS.S2_INTEREST] },
    [NO_RESPONSE_KINDS.OFFER]: { ...DEFAULT_NO_RESPONSE_CONFIG[NO_RESPONSE_KINDS.OFFER] },
    languages: [...DEFAULT_NO_RESPONSE_CONFIG.languages],
    max_anchor_age_hours: DEFAULT_NO_RESPONSE_CONFIG.max_anchor_age_hours,
  };
  if (!raw || typeof raw !== "object") return out;
  for (const kind of Object.values(NO_RESPONSE_KINDS)) {
    const k = raw[kind];
    if (!k || typeof k !== "object") continue;
    if (typeof k.enabled === "boolean") out[kind].enabled = k.enabled;
    if (Array.isArray(k.delays_hours)) {
      const max_steps = NO_RESPONSE_USE_CASES[kind].length;
      const delays = k.delays_hours.map(Number).filter((h) => Number.isFinite(h) && h > 0).slice(0, max_steps);
      if (delays.length > 0) out[kind].delays_hours = delays;
    }
  }
  if (Array.isArray(raw.languages)) {
    const langs = raw.languages.map(clean).filter(Boolean);
    if (langs.length > 0) out.languages = langs;
  }
  const age = Number(raw.max_anchor_age_hours);
  if (Number.isFinite(age) && age > 0) out.max_anchor_age_hours = age;
  return out;
}

// ── Anchor classification (pure) ────────────────────────────────────────────

const S2_EN_VERB = /\b(open to|consider|entertain|interested in|let it go|take a look|thinking (?:about|of) selling)\b/i;
const S2_EN_OBJECT = /\b(proposal|offer|sale|selling|sell|numbers)\b/i;
const S2_ES_VERB = /(abiert[oa]s?|considerar[ií]a|interesad[oa]|interesa|vistazo|soltar[ií]a)/i;
const S2_ES_OBJECT = /(propuesta|oferta|vender|venta|n[uú]meros|opciones|vistazo|soltar[ií]a)/i;
const PRICE_QUESTION = /(asking price|price in mind|precio)/i;

/** Is this outbound our S2 interest question (templated or typed)? Pure. */
export function isS2InterestQuestion({ use_case = null, message_body = "" } = {}) {
  if (S2_QUESTION_USE_CASES.has(lower(use_case))) return true;
  const body = clean(message_body);
  if (!body || !body.includes("?")) return false;
  if (PRICE_QUESTION.test(body)) return false; // that is S3
  if (/\$|\d{2,3}\s?k\b|\d{1,3}(?:,\d{3})+/i.test(body)) return false; // that is an offer
  return (S2_EN_VERB.test(body) && S2_EN_OBJECT.test(body)) || (S2_ES_VERB.test(body) && S2_ES_OBJECT.test(body));
}

const OFFER_CUE = /\b(offer|move forward at|good to go at|i'?d be at|i’d be at|i can do|i could do|we can do|we could do|we could offer|i can offer|i could offer|my number|cash|pay you|close in|oferta|ofrecer|ofrezco|puedo pagar|en efectivo)\b/i;
// Price-shaped tokens: $X, 3,3-grouped, NNNk. A bare 3-digit number is only a
// price through the canonical parser's v3 rule (and only beside an offer cue).
const PRICE_TOKEN_RE = /\$\s?\d[\d,.]*\s*(?:k|m|mil)?\b|\b\d{1,3}(?:,\d{3})+\b|\b\d{2,4}(?:\.\d)?\s?k\b/gi;
const PER_QUALIFIER_AFTER_RE = /^\s*(?:cash\s*)?(?:per|a|\/|each|por)\s*(?:unit|door|month|mo\b|year|sq|unidad|puerta|mes)|^\s*(?:each|monthly|in repairs|of repairs|repairs|en reparaciones|al mes|mensual)/i;
const QUALIFIER_BEFORE_RE = /(repairs?|reparaci[oó]n(?:es)?|arv|assessed|taxes|rent|renta|payoff|owe|debe)[^$\d]{0,14}$/i;
const RANGE_RE = /\b(between|to|or|entre|y|o)\b|[-–]/i;
const MIN_OFFER_AMOUNT = 10_000;

/**
 * Detect an offer in one of OUR outbound messages. Pure.
 * Uses the single money parser (monetary-understanding.js, v3 number rules:
 * 3-digit = thousands). Returns
 *   { is_offer: false }
 *   { is_offer: true, mode: "number", amount, raw, confidence }
 *   { is_offer: true, mode: "no_number", reason }   ambiguous → never quote a number
 */
export function detectOutboundOffer({ message_body = "", use_case = null } = {}) {
  const body = clean(message_body);
  if (!body) return { is_offer: false };
  const templated_offer = OFFER_USE_CASES.has(lower(use_case));
  const cue = OFFER_CUE.test(body);
  if (!templated_offer && !cue) return { is_offer: false };
  // A question about THEIR price is not our offer.
  if (!templated_offer && /\?/.test(body) && PRICE_QUESTION.test(body) && !/\$/.test(body)) return { is_offer: false };

  let mentions = [];
  try {
    mentions = extractMonetaryMentions(body, { numberRules: "v3" });
  } catch {
    mentions = [];
  }
  // A per-unit / monthly / repair figure qualifies the offer; it is not a
  // second offer ("$825,000 cash, which is $75,000 per unit").
  const isQualifier = (raw) => {
    const at = body.indexOf(clean(raw));
    if (at < 0) return false;
    const after = body.slice(at + clean(raw).length, at + clean(raw).length + 28);
    const before = body.slice(Math.max(0, at - 24), at);
    return PER_QUALIFIER_AFTER_RE.test(after) || QUALIFIER_BEFORE_RE.test(before);
  };
  if (mentions.some((m) => m.range || m.qualifiers?.range)) {
    return { is_offer: true, mode: "no_number", reason: "offer_range_or_multiple_numbers" };
  }
  const prices = mentions.filter((m) => Number(m.value) >= MIN_OFFER_AMOUNT && !isQualifier(m.raw));
  const distinct = [...new Set(prices.map((m) => Math.round(Number(m.value))))];
  const raw_tokens = [
    ...new Set(
      (body.match(PRICE_TOKEN_RE) || [])
        .filter((t) => !isQualifier(t))
        .map((t) => t.replace(/\s+/g, "").toLowerCase())
    ),
  ];

  if (distinct.length === 0) {
    return templated_offer || raw_tokens.length > 0
      ? { is_offer: true, mode: "no_number", reason: "offer_amount_not_extracted" }
      : { is_offer: false };
  }
  if (distinct.length > 1 || raw_tokens.length > 1) {
    return {
      is_offer: true,
      mode: "no_number",
      reason: RANGE_RE.test(body) ? "offer_range_or_multiple_numbers" : "offer_multiple_numbers",
      candidates: distinct,
    };
  }
  const m = prices[0];
  const explicit = /\$|,\d{3}|k\b/i.test(clean(m.raw));
  return {
    is_offer: true,
    mode: "number",
    amount: distinct[0],
    raw: clean(m.raw),
    confidence: explicit ? "high" : "medium",
  };
}

const ENTITY_NAME_PATTERN =
  /(\bllc\b|l\.l\.c|\binc\b|\bcorp\b|corporation|company|\bco\b|trust|\btr\b|rev liv|properties|holdings|group|partners|\blp\b|\bltd\b|estate|bank|associates|management|realty|investments?|\bowner\b|resident|there)/i;

/** A first name we may greet with: a single person-shaped token, never an entity. Pure. */
export function confidentFirstName(value) {
  const raw = clean(value);
  if (!raw || /\d/.test(raw) || ENTITY_NAME_PATTERN.test(raw)) return null;
  const first = raw.split(/\s+/)[0];
  if (!/^[\p{L}][\p{L}'’-]{1,19}$/u.test(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/**
 * Which no-response chain (if any) a delivered outbound starts or continues. Pure.
 * anchor = { use_case, message_body, metadata } from the outbound's send_queue row.
 * Returns { kind, step, chain_root_id?, offer? } or { kind: null, reason }.
 *   step is the index of the follow-up to schedule NEXT (0 = FU1).
 */
export function classifyNoResponseAnchor(anchor = {}, config = resolveNoResponseConfig()) {
  const meta = anchor?.metadata && typeof anchor.metadata === "object" ? anchor.metadata : {};
  const prior = meta.no_response_followup && typeof meta.no_response_followup === "object" ? meta.no_response_followup : null;
  const use_case = lower(anchor.use_case);

  // A delivered follow-up of ours continues its own chain.
  if (prior && Object.values(NO_RESPONSE_KINDS).includes(prior.kind)) {
    const next = Number(prior.step) + 1;
    const delays = config[prior.kind]?.delays_hours || [];
    if (!config[prior.kind]?.enabled) return { kind: null, reason: `no_response_kind_disabled:${prior.kind}` };
    if (!Number.isInteger(next) || next >= delays.length) return { kind: null, reason: "no_response_chain_complete" };
    return { kind: prior.kind, step: next, chain_root_id: clean(prior.chain_root_id) || null, offer: prior.offer || null };
  }
  // Any other follow-up (a not-interested nurture, a stage nudge) belongs to
  // its own policy: it never starts a no-response chain.
  if (lower(anchor.type) === "followup") {
    return { kind: null, reason: "anchor_is_other_followup" };
  }
  if (ALL_NO_RESPONSE_USE_CASES.has(use_case)) {
    // Our follow-up use case without chain metadata: never guess a step.
    return { kind: null, reason: "no_response_chain_metadata_missing" };
  }

  const offer = detectOutboundOffer({ message_body: anchor.message_body, use_case });
  if (offer.is_offer) {
    if (!config[NO_RESPONSE_KINDS.OFFER].enabled) return { kind: null, reason: "no_response_kind_disabled:offer" };
    return { kind: NO_RESPONSE_KINDS.OFFER, step: 0, offer };
  }
  if (isS2InterestQuestion({ use_case, message_body: anchor.message_body })) {
    if (!config[NO_RESPONSE_KINDS.S2_INTEREST].enabled) return { kind: null, reason: "no_response_kind_disabled:s2_interest" };
    return { kind: NO_RESPONSE_KINDS.S2_INTEREST, step: 0 };
  }
  return { kind: null, reason: "not_a_no_response_anchor" };
}

/** The template use case for a step (offer steps fall to the no-number copy when needed). */
export function useCaseForStep(kind, step, offer = null) {
  const list = NO_RESPONSE_USE_CASES[kind] || [];
  const uc = list[step] || null;
  if (!uc) return null;
  if (kind === NO_RESPONSE_KINDS.OFFER && OFFER_NUMBER_STEPS.has(step) && offer?.mode !== "number") {
    return OFFER_NO_NUMBER_USE_CASE;
  }
  return uc;
}

/** The reply language: the seller's latest identifiable reply, then the anchor row, then our own text. */
export function resolveFollowUpLanguage({ inbound_rows_newest_first = [], anchor_language = null, anchor_body = "" } = {}) {
  // Newest first: the latest identifiable reply wins; short / emoji replies are
  // skipped; but if the latest SUBSTANTIVE reply cannot be identified, unknown
  // stays unknown — never an older reply's or our own message's language.
  for (const row of inbound_rows_newest_first || []) {
    // Text only: a stored detector label on a row has called Spanish text
    // English in prod ("Si- estoy pidiendo un millón" → English).
    const language = identifyReplyLanguage(row?.message_body);
    if (language) return { language, source: "seller_reply" };
    const words = (String(row?.message_body ?? "").match(/\p{L}{2,}/gu) || []).length;
    if (words >= 3) return { language: null, source: "seller_reply_unidentified" };
  }
  if (clean(anchor_language)) return { language: clean(anchor_language), source: "anchor_row" };
  const ours = identifyReplyLanguage(anchor_body);
  if (ours) return { language: ours, source: "anchor_body" };
  return { language: null, source: "unknown" };
}

/**
 * Every gate for one candidate. Pure — the loaders below only gather facts.
 * Returns { eligible, reason, plan? }.
 */
export function evaluateNoResponseCandidate(facts = {}, { config = resolveNoResponseConfig(), now = new Date() } = {}) {
  const {
    anchor = {},
    anchor_sent_at = null,
    anchor_message_event_id = null,
    thread_key = null,
    has_inbound_before_anchor = false,
    has_inbound_after_anchor = false,
    has_newer_outbound = false,
    thread_state = {},
    on_suppression_list = false,
    inbound_rows_newest_first = [],
  } = facts;

  const classification = classifyNoResponseAnchor(anchor, config);
  if (!classification.kind) return { eligible: false, reason: classification.reason };
  if (!clean(thread_key)) return { eligible: false, reason: "missing_thread_key" };
  if (has_inbound_after_anchor) return { eligible: false, reason: "inbound_reply_received" };
  if (has_newer_outbound) return { eligible: false, reason: "newer_outbound_exists" };
  if (!has_inbound_before_anchor) return { eligible: false, reason: "seller_never_replied" };
  if (on_suppression_list) return { eligible: false, reason: "phone_suppressed" };
  if (thread_state.is_suppressed === true) return { eligible: false, reason: "thread_suppressed" };
  if (thread_state.is_archived === true) return { eligible: false, reason: "thread_archived" };
  if (BLOCKED_CONTACTABILITY.has(lower(thread_state.contactability_status))) {
    return { eligible: false, reason: `contact_blocked:${lower(thread_state.contactability_status)}` };
  }
  const last_seller_text = clean(inbound_rows_newest_first?.[0]?.message_body);
  if (NO_CONTACT_REQUEST_RE.test(last_seller_text)) {
    return { eligible: false, reason: "seller_asked_not_to_be_contacted" };
  }
  if (DISQUALIFYING_INTENTS.has(lower(thread_state.last_intent))) {
    return { eligible: false, reason: `disposition_rules_own_thread:${lower(thread_state.last_intent)}` };
  }
  if (["closed", "dead", "closed_lost", "archived"].includes(lower(thread_state.lifecycle_stage))) {
    return { eligible: false, reason: `terminal_stage:${lower(thread_state.lifecycle_stage)}` };
  }
  const sent_ms = Date.parse(clean(anchor_sent_at));
  if (!Number.isFinite(sent_ms)) return { eligible: false, reason: "anchor_sent_at_missing" };
  const now_ms = now instanceof Date ? now.getTime() : Date.parse(now);
  if (classification.step === 0 && now_ms - sent_ms > config.max_anchor_age_hours * HOUR_MS) {
    return { eligible: false, reason: "anchor_too_old" };
  }

  const lang = resolveFollowUpLanguage({
    inbound_rows_newest_first,
    anchor_language: anchor.language,
    anchor_body: anchor.message_body,
  });
  if (!lang.language) return { eligible: false, reason: "language_unknown" };
  if (!config.languages.some((l) => lower(l) === lower(lang.language))) {
    return { eligible: false, reason: `language_not_enabled:${lang.language}` };
  }

  const delays = config[classification.kind].delays_hours;
  const delay_hours = delays[classification.step];
  const offer = classification.offer || null;
  const use_case = useCaseForStep(classification.kind, classification.step, offer);
  if (!use_case || !Number.isFinite(delay_hours)) return { eligible: false, reason: "no_response_step_unresolved" };

  const chain_root_id = classification.chain_root_id || clean(anchor_message_event_id) || null;
  return {
    eligible: true,
    reason: "no_response_followup_eligible",
    plan: {
      kind: classification.kind,
      step: classification.step,
      step_label: ["fu1", "fu2", "nurture"][classification.step] || `step_${classification.step + 1}`,
      use_case,
      delay_hours,
      anchor_at: new Date(sent_ms).toISOString(),
      scheduled_for: addHours(new Date(sent_ms).toISOString(), delay_hours),
      chain_root_id,
      dedupe_scope: `${classification.kind}:${chain_root_id || "unknown"}:${classification.step}`,
      language: lang.language,
      language_source: lang.source,
      seller_first_name: confidentFirstName(anchor.seller_first_name),
      offer: offer
        ? { mode: offer.mode, amount: offer.amount ?? null, raw: offer.raw ?? null, confidence: offer.confidence ?? null, reason: offer.reason ?? null }
        : null,
    },
  };
}

/** The scheduleFollowUp context for an eligible plan. Pure. */
export function buildNoResponseScheduleContext(plan, { thread_key, anchor = {}, anchor_message_event_id = null, delivered_provider_message_sid = null } = {}) {
  return {
    source: "no_response_followup",
    stage: plan.kind,
    stage_no_reply_hours: plan.delay_hours,
    followup_anchor_at: plan.anchor_at,
    followup_use_case: plan.use_case,
    followup_dedupe_scope: plan.dedupe_scope,
    skip_email_lane: true,
    language: plan.language,
    seller_first_name: plan.seller_first_name || null,
    property_address: clean(anchor.property_address) || null,
    property_city: clean(anchor.property_city) || null,
    timezone: clean(anchor.timezone) || null,
    market: clean(anchor.market) || null,
    agent_name: clean(anchor.agent_name) || null,
    master_owner_id: clean(anchor.master_owner_id) || null,
    property_id: clean(anchor.property_id) || null,
    delivered_provider_message_sid,
    outbound_message_event_id: anchor_message_event_id,
    no_response_followup: {
      version: NO_RESPONSE_FOLLOWUP_VERSION,
      kind: plan.kind,
      step: plan.step,
      step_label: plan.step_label,
      chain_root_id: plan.chain_root_id,
      anchor_message_event_id,
      anchor_at: plan.anchor_at,
      anchor_queue_row_id: clean(anchor.id) || null,
      language: plan.language,
      offer: plan.offer,
    },
    thread_key,
  };
}

// ── Observed offer record (negotiation_quotes, PROPOSED amendment) ──────────

/**
 * The offer we detected in our own outbound, recorded like an automated quote.
 * quote_type 'observed_offer' needs PROPOSED_20261007042000_negotiation_quotes_observed_offer.sql
 * (on top of the PROPOSED negotiation_quotes table); until both are applied the
 * write fails and is ignored — the follow-up itself never depends on it. Pure.
 */
export function buildObservedOfferQuote({ thread_key, message_event_id, offer, anchor = {}, language = null, quoted_at = null } = {}) {
  if (!offer || offer.mode !== "number" || !clean(thread_key) || !clean(message_event_id)) return null;
  const manual = lower(anchor.use_case || anchor.use_case_template) === "manual_reply" ||
    lower(anchor?.metadata?.template_source) === "manual_composer";
  return {
    quote_key: `observed_offer:${clean(message_event_id)}`,
    quote_type: "observed_offer",
    quote_source: manual ? "manual" : "automated",
    message_event_id: clean(message_event_id),
    extraction_confidence: clean(offer.confidence) || null,
    amount: Number(offer.amount),
    rule_branch: "observed_outbound_offer",
    template_id: clean(anchor.template_id) || null,
    use_case: clean(anchor.use_case || anchor.use_case_template) || null,
    language: clean(language) || null,
    thread_key: clean(thread_key),
    property_id: clean(anchor.property_id) || null,
    master_owner_id: clean(anchor.master_owner_id) || null,
    send_queue_key: clean(anchor.queue_key) || null,
    evidence: { raw: offer.raw || null, extractor: NO_RESPONSE_FOLLOWUP_VERSION },
    quoted_at: quoted_at || new Date().toISOString(),
  };
}

// ── Fact loaders (read-only) ────────────────────────────────────────────────

export async function loadAnchorQueueRow(supabase, queue_id) {
  if (!clean(queue_id)) return null;
  const { data, error } = await supabase
    .from("send_queue")
    .select(
      "id,queue_key,thread_key,type,use_case_template,message_body,template_id,language,seller_first_name,property_address,property_type,timezone,market,agent_name,master_owner_id,property_id,metadata"
    )
    .eq("id", queue_id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { ...data, use_case: data.use_case_template };
}

export async function loadNoResponseThreadFacts(supabase, { thread_key, anchor_sent_at, anchor_message_event_id = null }) {
  const [state, supp, inbound] = await Promise.all([
    supabase
      .from("inbox_thread_state")
      .select("is_suppressed,is_archived,contactability_status,last_intent,lifecycle_stage")
      .eq("thread_key", thread_key)
      .maybeSingle(),
    supabase
      .from("sms_suppression_list")
      .select("id,is_active")
      .or(`phone_e164.eq.${thread_key},phone_number.eq.${thread_key}`)
      .limit(5),
    supabase
      .from("message_events")
      .select("id,message_body,language,event_timestamp,created_at")
      .eq("thread_key", thread_key)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);
  if (state.error) throw state.error;
  if (supp.error) throw supp.error;
  if (inbound.error) throw inbound.error;
  const anchor_ms = Date.parse(clean(anchor_sent_at));
  const inbound_rows = (inbound.data || []).filter((r) => r.id !== anchor_message_event_id);
  const at = (r) => Date.parse(clean(r.event_timestamp || r.created_at));
  return {
    thread_state: state.data || {},
    on_suppression_list: (supp.data || []).some((r) => r.is_active !== false),
    has_inbound_before_anchor: inbound_rows.some((r) => at(r) < anchor_ms),
    has_inbound_after_anchor: inbound_rows.some((r) => at(r) >= anchor_ms),
    inbound_rows_newest_first: inbound_rows.filter((r) => at(r) < anchor_ms),
  };
}

// ── Dispatch-time resolution (called from resolve-deferred-queue-message) ───

export function isNoResponseFollowUpRow(queue_row = {}) {
  const meta = queue_row?.metadata && typeof queue_row.metadata === "object" ? queue_row.metadata : {};
  return Boolean(meta.no_response_followup && typeof meta.no_response_followup === "object" && meta.no_response_followup.kind);
}

/** Order templates: named copy first when we have a confident name, else unnamed first. */
function orderForName(templates, has_name) {
  const named = (t) => /\{\{\s*seller_first_name\s*\}\}/.test(String(t.template_body || ""));
  return [...templates].sort((a, b) => (has_name ? Number(named(b)) - Number(named(a)) : Number(named(a)) - Number(named(b))));
}

async function loadMaxOffer(supabase, property_id) {
  if (!clean(property_id)) return null;
  try {
    const { data } = await supabase
      .from("property_acquisition_scores")
      .select("mao:evidence->offer_calculation->>effective_authorized_ceiling,computed_at")
      .eq("property_id", property_id)
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const n = Number(data?.mao);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Re-validate and render a no-response follow-up at dispatch. Fails closed:
 * any doubt returns { ok:false, resolved:false, reason } and the processor
 * parks the row as paused_deferred_unresolved (never sends blank or wrong copy).
 */
export async function resolveNoResponseFollowUpMessage(queue_row = {}, { supabase, loadPropertyAssetRecord = null } = {}) {
  const meta = queue_row.metadata || {};
  const nr = meta.no_response_followup || {};
  const thread_key = clean(queue_row.thread_key || queue_row.to_phone_number);
  const anchor_at = clean(nr.anchor_at);
  if (!supabase || !thread_key || !anchor_at) return { ok: false, resolved: false, reason: "no_response_row_incomplete" };

  // 1. The seller must still be silent, and nobody else may have written since.
  try {
    const [inb, outb] = await Promise.all([
      supabase.from("message_events").select("id").eq("thread_key", thread_key).eq("direction", "inbound").gte("event_timestamp", anchor_at).limit(1),
      supabase.from("message_events").select("id").eq("thread_key", thread_key).eq("direction", "outbound").gt("event_timestamp", anchor_at).limit(5),
    ]);
    if (inb.error || outb.error) return { ok: false, resolved: false, reason: "no_response_revalidation_failed" };
    if ((inb.data || []).length > 0) return { ok: false, resolved: false, reason: "seller_replied_since_anchor" };
    const others = (outb.data || []).filter((r) => r.id !== nr.anchor_message_event_id);
    if (others.length > 0) return { ok: false, resolved: false, reason: "newer_outbound_since_anchor" };
  } catch {
    return { ok: false, resolved: false, reason: "no_response_revalidation_failed" };
  }

  // 2. Which copy. An offer number is quoted only as sent, only when unambiguous,
  //    and never above the engine's authorized max when one exists.
  let use_case = lower(meta.followup_use_case || queue_row.use_case_template);
  let offer_price = null;
  if (nr.kind === NO_RESPONSE_KINDS.OFFER && use_case !== OFFER_NO_NUMBER_USE_CASE && OFFER_NUMBER_STEPS.has(Number(nr.step))) {
    const amount = Number(nr.offer?.amount);
    const mao = Number.isFinite(amount) ? await loadMaxOffer(supabase, queue_row.property_id) : null;
    if (nr.offer?.mode === "number" && Number.isFinite(amount) && amount >= MIN_OFFER_AMOUNT && (mao == null || amount <= mao)) {
      offer_price = amount;
    } else {
      use_case = OFFER_NO_NUMBER_USE_CASE;
    }
  }
  if (!ALL_NO_RESPONSE_USE_CASES.has(use_case)) return { ok: false, resolved: false, reason: "no_response_use_case_invalid" };

  // 3. Strict language: the seller's language or nothing.
  const language = clean(nr.language || queue_row.language);
  if (!language) return { ok: false, resolved: false, reason: "language_unknown" };
  const { data, error } = await supabase
    .from("sms_templates")
    .select("template_id,template_body,use_case,language,stage_code,property_type_scope,allowed_property_groups,prohibited_property_groups,is_active,safe_for_auto_reply,quarantine_state")
    .eq("is_active", true)
    .eq("safe_for_auto_reply", true)
    .eq("use_case", use_case)
    .eq("language", language)
    .limit(50);
  if (error) return { ok: false, resolved: false, reason: "template_lookup_failed" };
  let templates = (data || []).filter((t) => !t.quarantine_state || lower(t.quarantine_state) === "active");

  let asset_record = null;
  try {
    asset_record = loadPropertyAssetRecord ? await loadPropertyAssetRecord(supabase, queue_row.property_id) : null;
  } catch {
    asset_record = null;
  }
  const group = canonicalPropertyGroupOf(asset_record || { property_type: queue_row.property_type });
  templates = filterTemplatesForProperty(templates, { propertyGroup: group }).kept;

  const first = confidentFirstName(queue_row.seller_first_name);
  const ordered = orderForName(templates, Boolean(first));
  const personalization = {
    seller_first_name: first,
    first_name: first,
    agent_name: clean(queue_row.agent_name) || null,
    property_address: clean(queue_row.property_address) || null,
    property_city: clean(queue_row.property_city) || null,
    offer_price,
  };
  for (const template of ordered) {
    if (!clean(template.template_body)) continue;
    const rendered = personalizeTemplate(template.template_body, personalization);
    if (!rendered.ok || !clean(rendered.text)) continue;
    const prepared = prepareRenderedSmsForQueue({
      rendered_message_text: rendered.text,
      template_id: template.template_id,
      template_source: "sms_templates",
    });
    if (!prepared.ok || !clean(prepared.text)) continue;
    return {
      ok: true,
      resolved: true,
      message_body: prepared.text,
      template_id: clean(template.template_id) || null,
      use_case: clean(template.use_case) || use_case,
      stage_code: clean(template.stage_code) || null,
      language: clean(template.language) || language,
      intent: "stage_no_reply",
      offer_price_quoted: offer_price,
      reason: "no_response_template_resolved",
    };
  }
  return { ok: false, resolved: false, intent: "stage_no_reply", reason: "no_renderable_no_response_template" };
}
