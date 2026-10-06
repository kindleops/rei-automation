// ─── seller-autopilot-v2.js ──────────────────────────────────────────────────
// SELLER AUTOPILOT S1–S4 v2 (owner brief 2026-10-06): "every seller reply gets
// an automated response" through ownership → interest → asking price →
// condition/anchor, in the seller's own language.
//
// PURE module (no I/O, no AI). Everything here is OFF unless the env flag
// SELLER_AUTOPILOT_V2 is truthy; the orchestrator calls nothing in this file
// when the flag is off, so today's behaviour is byte-identical.
//
// What it decides, and what it never decides:
//   • It READS the question we asked last (conversation context) and the
//     seller's reply, and names ONE template use case (plus approved
//     fallbacks) for the answer. It never writes stage: the lifecycle
//     resolver stays the only stage authority.
//   • Compliance always wins. Opt-out, wrong number, hostile/legal, DNC /
//     suppression, "not interested" (30-day nurture) and every review-only
//     relationship intent (referral, sold, trust/executor, non-owner, entity)
//     are DEFERRED to the existing pipeline untouched. The executor's
//     suppression and classifier-verdict gates still run after this layer.
//   • Money comes only from the authoritative Decision Engine snapshot
//     (property_acquisition_scores / scoreProperty — the same pool Deal
//     Intelligence shows). Valuation v2 is never read. No offer, a
//     non-authoritative tier, a pre-2026-09-12 snapshot, a non-single-family
//     asset, missing comps or an inconsistent price → human review with a
//     named reason, never a number.
//   • A number is NEVER above MAO (= evidence.offer_calculation
//     .effective_authorized_ceiling) and is rounded DOWN, so rounding can
//     never push it over.

import { validateConversationContext } from "@/lib/domain/classification/conversation-context.js";
import { canonicalizeMultilingualReply } from "@/lib/domain/classification/multilingual-short-replies.js";
import { evaluateOfferReadiness, OFFER_READY_REASONS, OFFER_POLICY_EPOCH } from "@/lib/acquisition/offerReadiness.js";

export const SELLER_AUTOPILOT_V2_VERSION = "seller_autopilot_s1_s4_v2_2026_10_06";
export const SELLER_AUTOPILOT_V2_FLAG = "SELLER_AUTOPILOT_V2";

/** The flag defaults OFF. Only an explicit truthy value turns it on. */
export function isSellerAutopilotV2Enabled(env = process.env) {
  const raw = String(env?.[SELLER_AUTOPILOT_V2_FLAG] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

function clean(value) {
  return String(value ?? "").trim();
}
function lower(value) {
  return clean(value).toLowerCase();
}
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ══════════════════════════════════════════════════════════════════════════
// STAGES — read from the question we asked, not guessed from the reply
// ══════════════════════════════════════════════════════════════════════════

export const V2_STAGES = Object.freeze({
  S1: "S1_ownership",
  S2: "S2_interest",
  S3: "S3_asking_price",
  S4: "S4_condition",
  S4_BASICS: "S4_confirm_basics",
  BEYOND: "S5_plus",
  UNKNOWN: "unknown",
});

/** conversation_context_v1 use case (the question we asked) → v2 stage. */
const CONTEXT_USE_CASE_STAGE = Object.freeze({
  ownership_check: V2_STAGES.S1,
  proposal_interest: V2_STAGES.S2,
  proposal_request: V2_STAGES.S2,
  asking_price: V2_STAGES.S3,
  condition_check: V2_STAGES.S4,
  occupancy_check: V2_STAGES.S4_BASICS,
});

/** Persisted lifecycle stage → v2 stage (fallback when the context is not valid). */
const LIFECYCLE_STAGE_V2 = Object.freeze({
  ownership_confirmation: V2_STAGES.S1,
  offer_interest: V2_STAGES.S2,
  asking_price: V2_STAGES.S3,
  property_condition: V2_STAGES.S4,
  offer: V2_STAGES.BEYOND,
  formal_contract: V2_STAGES.BEYOND,
  under_contract: V2_STAGES.BEYOND,
  disposition: V2_STAGES.BEYOND,
  prepared_to_close: V2_STAGES.BEYOND,
  closed: V2_STAGES.BEYOND,
});

/**
 * v2 use cases → the conversation_context question they ask, so the NEXT
 * reply binds to them in every language (the body-pattern fallback only reads
 * English/Spanish). Consumed by build-conversation-context only when the flag
 * is on.
 */
export const V2_CONTEXT_ALIASES = Object.freeze({
  price_high_condition_probe: "condition_check",
  no_price_condition_probe: "condition_check",
  condition_probe: "condition_check",
  price_works_confirm_basics: "occupancy_check",
  who_is_this_resume_ownership: "ownership_check",
  who_is_this: "proposal_interest",
  who_is_this_resume_price: "asking_price",
  who_is_this_resume_condition: "condition_check",
  ownership_connection_clarifier: "ownership_check",
});

export function resolveV2Stage({ conversation_context = null, stage_before = null } = {}) {
  const validated = validateConversationContext(conversation_context);
  if (validated.context_status === "valid") {
    const stage = CONTEXT_USE_CASE_STAGE[clean(conversation_context?.last_outbound_use_case)];
    if (stage) return { stage, source: "question_context", context_status: "valid" };
  }
  const fromLifecycle = LIFECYCLE_STAGE_V2[lower(stage_before)];
  if (fromLifecycle) return { stage: fromLifecycle, source: "lifecycle_stage", context_status: validated.context_status };
  return { stage: V2_STAGES.UNKNOWN, source: "none", context_status: validated.context_status };
}

// ══════════════════════════════════════════════════════════════════════════
// INTENTS
// ══════════════════════════════════════════════════════════════════════════

export const V2_INTENTS = Object.freeze({
  AFFIRMATIVE: "affirmative",
  INTEREST: "interest",
  CONDITIONAL_INTEREST: "conditional_interest",
  PRICE_GIVEN: "price_given",
  NO_PRICE: "no_price",
  OFFER_REQUEST: "offer_request",
  CONDITION_ANSWER: "condition_answer",
  WHO_WHY: "who_why",
  CAPITAL_GAINS: "capital_gains",
  NOT_NOW: "not_now",
  NOT_INTERESTED: "not_interested",
  REFERRAL: "referral",
  SOLD_FORMER_OWNER: "sold_former_owner",
  TRUST_EXECUTOR: "trust_executor",
  NON_OWNER: "non_owner",
  ENTITY_LEGAL: "entity_or_legal",
  WRONG_NUMBER: "wrong_number",
  OPT_OUT: "opt_out",
  HOSTILE_LEGAL: "hostile_legal",
  ACKNOWLEDGEMENT: "acknowledgement",
  LANGUAGE_SWITCH: "language_switch",
  CALLBACK: "callback",
  LISTED: "listed",
  REACTION: "reaction",
  BARE_NO_OWNERSHIP: "bare_no_to_ownership",
  BARE_NO_AFTER_CLARIFIER: "bare_no_after_ownership_clarifier",
  IDENTITY_STATEMENT: "identity_statement",
  UNCLEAR: "unclear",
});

const I = V2_INTENTS;

/** Classifier primary_intent → v2 intent. Unknown intents are UNCLEAR. */
const CLASSIFIER_INTENT_MAP = Object.freeze({
  opt_out: I.OPT_OUT,
  wrong_number: I.WRONG_NUMBER,
  wrong_person: I.WRONG_NUMBER,
  hostile_or_legal: I.HOSTILE_LEGAL,
  not_interested: I.NOT_INTERESTED,
  need_time: I.NOT_NOW,
  non_owner_referral: I.REFERRAL,
  former_owner_respondent: I.SOLD_FORMER_OWNER,
  property_sold: I.SOLD_FORMER_OWNER,
  sold_property: I.SOLD_FORMER_OWNER,
  executor_heir_respondent: I.TRUST_EXECUTOR,
  trust_ownership: I.TRUST_EXECUTOR,
  property_specific_non_owner: I.NON_OWNER,
  non_owner: I.NON_OWNER,
  llc_corporation: I.ENTITY_LEGAL,
  title_issue: I.ENTITY_LEGAL,
  lien_tax_issue: I.ENTITY_LEGAL,
  bankruptcy_disclosed: I.ENTITY_LEGAL,
  who_is_this: I.WHO_WHY,
  info_request: I.WHO_WHY,
  how_got_number: I.WHO_WHY,
  ownership_confirmed: I.AFFIRMATIVE,
  seller_interested: I.INTEREST,
  latent_interest: I.INTEREST,
  open_to_offer: I.INTEREST,
  consider_selling: I.INTEREST,
  asks_offer: I.OFFER_REQUEST,
  offer_request: I.OFFER_REQUEST,
  asking_price_absent: I.NO_PRICE,
  asking_price_provided: I.PRICE_GIVEN,
  counter_offer: I.PRICE_GIVEN,
  price_given: I.PRICE_GIVEN,
  condition_disclosed: I.CONDITION_ANSWER,
  tenant_occupied: I.CONDITION_ANSWER,
  acknowledgement: I.ACKNOWLEDGEMENT,
  language_switch: I.LANGUAGE_SWITCH,
  callback_requested: I.CALLBACK,
  needs_call: I.CALLBACK,
  voicemail_call_request: I.CALLBACK,
  already_listed: I.LISTED,
  going_to_market: I.LISTED,
  unclear: I.UNCLEAR,
});

/**
 * Intents this layer NEVER answers — the existing pipeline keeps them exactly
 * as today (suppression, 30-day nurture, review lanes, referral automation).
 */
export const V2_DEFERRED_INTENTS = Object.freeze(new Set([
  I.OPT_OUT,
  I.WRONG_NUMBER,
  I.HOSTILE_LEGAL,
  I.NOT_INTERESTED,
  I.NOT_NOW,
  I.REFERRAL,
  I.SOLD_FORMER_OWNER,
  I.TRUST_EXECUTOR,
  I.NON_OWNER,
  I.ENTITY_LEGAL,
  I.LANGUAGE_SWITCH,
  I.CALLBACK,
  I.LISTED,
  I.REACTION,
]));

// ── Deterministic text rules (rules-only; the AI classifier stays off) ──────
// English + Spanish here; the other 14 template languages arrive through the
// multilingual canonicaliser (canonical English phrase) before these run.
const OPT_OUT_GUARD_RE =
  /\b(stop|unsubscribe|remove me|take me off|do ?n[o']?t (?:text|contact|message)|quit (?:texting|messaging)|no more (?:texts|messages)|lose (?:this|my) number|delete (?:this|my) number|leave me alone|cancel)\b|no me (?:escrib|mand|textee)|ya no me|d[eé]j(?:e|en|a|ar)(?:me)? (?:de|en paz)|no (?:escriba|manden)|basta|quita(?:r)? mi n[uú]mero|borra(?:r)? mi n[uú]mero|te (?:bloqueo|blokeo)|block(?:ing)? (?:you|this|your)/i;
const HOSTILE_GUARD_RE = /chinga|pendej|cabr[oó]n|tu madre|fuck|shit|\bdie\b|go to hell|vete a la|attorney|lawyer|abogado|sue you|harass/i;
const NEGATIVE_LEAD_RE = /^\s*(?:no|nope|nah|not|never|nunca|jam[aá]s)\b/i;

export const V2_TEXT_RULES = Object.freeze([
  {
    id: "v2_capital_gains",
    intent: I.CAPITAL_GAINS,
    // Tax objection: wins over a soft "no" (the owner wants the creative probe
    // exactly when taxes are why they say no), never over opt-out / hostile.
    re: /\bcapital\s+gains?\b|\bcap\s+gains\b|\b1031\b|depreciation\s+recapture|\btax(?:es)?\s+(?:hit|bill|burden|implications?|consequences?|liability)\b|\b(?:pay|owe)\s+(?:a\s+lot\s+(?:of|in)\s+)?taxes\b|ganancias?\s+de\s+capital|impuestos?\s+(?:de|sobre)\s+(?:la\s+)?(?:ganancia|venta)|pagar\s+(?:muchos\s+)?impuestos/i,
    allow_negative_lead: true,
  },
  {
    id: "v2_offer_request",
    intent: I.OFFER_REQUEST,
    re: /\b(?:send|give|text)\s+(?:me\s+)?(?:a|an|your)?\s*(?:bid|offer|number|proposal)\b|\bmake\s+(?:me\s+)?(?:an?\s+)?offer\b|\boffer\s+me\b|\bwhat(?:'?s|\s+is|\s+would\s+be)?\s+(?:your|ur|the)\s+(?:offer|bid|proposal|best\s+offer)\b|\bwhat\s+(?:would|will|can|do)\s+you\s+(?:offer|pay|give)\b|\bhow\s+much\s+(?:would|will|are|can|do)\s+you\b|\bwhat\s+(?:your|ur)\s+price\b|\b(?:you|u)\s+(?:like|want|wanna)\s+(?:to\s+)?buy\b|\btake\s+(?:a\s+)?look\s+and\s+offer\b|\bwhat(?:'?s|\s+is)\s+(?:your|ur)\s+proposal\b|cu[aá]nto\s+(?:me\s+)?(?:ofrece|pagar[ií]a|dar[ií]a|da)|(?:m[aá]nde|env[ií]e)(?:me)?\s+(?:una\s+)?(?:oferta|propuesta)|haga(?:me)?\s+(?:una\s+)?oferta|^what is your offer\?$/i,
    // Latin-script template languages (FR/PT/DE/IT/PL); the non-Latin ones
    // arrive as "what is your offer?" through the multilingual canonicaliser.
    re_multilingual: /faites[\s-]+moi\s+une\s+(?:offre|proposition)|quelle\s+est\s+votre\s+(?:offre|proposition)|combien\s+(?:vous\s+)?(?:offrez|proposez|payez)|(?:me\s+)?(?:fa[cç]a|faz|mande|manda)\s+(?:uma\s+)?(?:oferta|proposta)|qual\s+(?:[eé]\s+)?(?:a\s+)?sua\s+(?:oferta|proposta)|quanto\s+(?:voc[eê]\s+)?(?:oferece|paga)|machen\s+sie\s+mir\s+ein\s+angebot|was\s+(?:ist\s+)?ihr\s+angebot|wie\s*viel\s+(?:bieten|zahlen)\s+sie|(?:mi\s+)?faccia\s+(?:un['’]?\s*)?offerta|qual\s+[eè]\s+la\s+sua\s+offerta|quanto\s+(?:mi\s+)?offre|z[lł][oó][zż](?:cie)?\s+ofert[eę]|jaka\s+jest\s+(?:twoja|pana|pani)\s+oferta|ile\s+(?:pan\s+|pani\s+)?(?:oferujesz|zap[lł]acisz|dasz|dacie)/i,
  },
  {
    id: "v2_no_price",
    intent: I.NO_PRICE,
    re: /^\s*(?:i\s+)?(?:have\s+)?no\s+idea\b|^\s*no\s+price\b|\bi\s+(?:don'?t|do\s+not)\s+know\b|\bnot\s+sure\s+(?:what|how\s+much)\b|\byou\s+tell\s+me\b|\bno\s+(?:price|number)\s+(?:in\s+mind|yet)\b|\bhaven'?t\s+(?:thought|decided)\b|\bwhatever\s+(?:it'?s|its)\s+worth\b|\bmarket\s+value\b|^\s*no\s+s[eé][\s.!]*$|\bno\s+(?:lo\s+)?s[eé]\s+(?:cu[aá]nto|qu[eé]\s+precio)|\bno\s+tengo\s+(?:idea|precio)\b|\busted\s+d[ií]game\b/i,
    re_multilingual: /^\s*je\s+ne\s+sais\s+pas\b|aucune\s+id[eé]e|^\s*n[aã]o\s+sei\b|nenhuma\s+ideia|^\s*ich\s+wei[sß]+\s+(?:es\s+)?nicht\b|keine\s+ahnung|^\s*non\s+(?:lo\s+)?so\b|nessuna\s+idea|^\s*nie\s+wiem\b|nie\s+mam\s+poj[eę]cia/i,
    allow_negative_lead: true,
  },
  {
    id: "v2_conditional_interest",
    intent: I.CONDITIONAL_INTEREST,
    re: /^\s*(?:maybe|possibly|perhaps|depends|it\s+depends)\b|\bfor\s+the\s+right\s+(?:price|offer|number)\b|\bif\s+(?:the\s+)?(?:price|offer|number)\s+is\s+right\b|\bif\s+it'?s\s+a\s+good\s+(?:offer|price|number)\b|\bdepends\s+on\s+(?:the\s+)?(?:price|offer|number)\b|\bopen\s+to\s+(?:offers|it|an?\s+offer)\b|\bwilling\s+to\s+(?:listen|hear)\b|^\s*(?:tal\s+vez|quiz[aá]s?|depende)\b|si\s+es\s+(?:una\s+)?buena\s+(?:propuesta|oferta)|podr[ií]a\s+considerar/i,
  },
  {
    id: "v2_who_why",
    intent: I.WHO_WHY,
    re: /\bwhy\s+(?:are|r|do|did)\s+(?:you|u)\s+(?:asking|ask|want\s+to\s+know)\b|\bwhy\s+do\s+you\s+ask\b|^\s*why\s*\??\s*$|\bhow'?d?\s+(?:did\s+)?(?:you|u)\s+get\s+(?:my|this)\s+(?:number|info)\b|\bwho\s+(?:is\s+this|are\s+you|r\s+u)\b|\bwhom\b|qui[eé]n\s+(?:eres|es|habla)|no\s+s[eé]\s+qui[eé]n\s+(?:eres|es)|c[oó]mo\s+(?:conseguiste|obtuviste|tienes)\s+mi\s+n[uú]mero|para\s+qu[eé]\b|^\s*porque\s*\??\s*$|^\s*por\s*qu[eé]\s*\??\s*$/i,
  },
  {
    id: "v2_not_now",
    intent: I.NOT_NOW,
    // Timing deferral, not a decline: the existing need_time lane answers it
    // (future_nurture acknowledgement + the scheduled later follow-up).
    re: /^\s*not\s+(?:right\s+)?(?:now|yet|at\s+(?:this|the)\s+(?:time|point|moment))[\s.!]*$|^\s*maybe\s+later\b|^\s*(?:ahorita|ahora)\s+no[\s.!]*$|^\s*(?:todav[ií]a|a[uú]n)\s+no[\s.!]*$|^\s*por\s+ahora\s+no[\s.!]*$/i,
    allow_negative_lead: true,
  },
  {
    id: "v2_bare_affirmative",
    intent: I.AFFIRMATIVE,
    re: /^\s*(?:y(?:es|ea|eah|ep|up|essir)|si|s[ií]|correct|sure|absolutely|of\s+course|definitely|ok(?:ay)?|claro|por\s+supuesto|yes\s+(?:sir|ma'?am))[\s.!👍]*$/iu,
  },
]);

/** Run the text rules over the seller's reply (and its multilingual canonical form). */
export function detectV2TextIntent(message = "", { thread_language = null } = {}) {
  const text = clean(message);
  if (!text) return null;
  const multilingual = canonicalizeMultilingualReply(text, { thread_language });
  const forms = [text, multilingual?.canonical_text].filter(Boolean);
  if (forms.some((f) => OPT_OUT_GUARD_RE.test(f))) return { rule_id: "v2_opt_out_guard", intent: I.OPT_OUT, guard: true };
  if (forms.some((f) => HOSTILE_GUARD_RE.test(f))) return { rule_id: "v2_hostile_guard", intent: I.HOSTILE_LEGAL, guard: true };
  for (const rule of V2_TEXT_RULES) {
    for (const form of forms) {
      if (!rule.re.test(form) && !(rule.re_multilingual && rule.re_multilingual.test(form))) continue;
      if (!rule.allow_negative_lead && NEGATIVE_LEAD_RE.test(form) && rule.intent !== I.WHO_WHY) continue;
      return { rule_id: rule.id, intent: rule.intent, matched_form: form === text ? "seller_text" : "multilingual_canonical" };
    }
  }
  return null;
}

// ── Bare "No" to the ownership question (owner 2026-10-06) ─────────────────
// Replaces the LC_BARE_NO_OWNERSHIP_MODE review default for v2: ask ONCE
// "Are you connected to the property, or do I have the wrong number?"; the
// next inbound decides (wrong number → suppression, "I manage it / my wife
// owns it / my LLC owns it" → identity review with a tag, silence → stop).
// Never a second clarification.
const BARE_NO_RE = /^\s*(?:no+|nope|nah|negative|no\s+(?:sir|ma'?am)|n)[\s.!]*$/i;

export const V2_IDENTITY_KINDS = Object.freeze({
  MANAGER: "property_manager",
  FAMILY: "family_owner",
  ENTITY: "entity_owner",
  OCCUPANT: "occupant",
});

const IDENTITY_RULES = [
  [V2_IDENTITY_KINDS.ENTITY, /\bmy\s+(?:llc|company|business|corporation|corp|trust|partnership)\b|\b(?:an?\s+|the\s+|our\s+)?(?:llc|trust|corporation|company)\s+owns\b|\bowned\s+by\s+(?:an?\s+|my\s+|our\s+|the\s+)?(?:llc|company|trust|corporation)|\b(?:es|est[aá])\s+a\s+nombre\s+de\s+(?:mi|la|una)\s+(?:compa[nñ][ií]a|empresa|llc)/i],
  [V2_IDENTITY_KINDS.MANAGER, /\bi\s+(?:just\s+|only\s+)?manage\b|\bproperty\s+manager\b|\bi'?m\s+the\s+manager\b|\bmanag(?:e|ing)\s+(?:it|the\s+(?:property|house))\b|\b(?:yo\s+)?la\s+administro\b|\bsoy\s+(?:el|la)\s+administrador/i],
  [V2_IDENTITY_KINDS.FAMILY, /\bmy\s+(?:wife|husband|spouse|mom|mother|dad|father|son|daughter|brother|sister|grand(?:ma|pa|mother|father|son|daughter)|aunt|uncle|family|partner|parents)\b[^.?!]{0,40}\b(?:owns?|is\s+the\s+owner|has\s+it|it'?s\s+(?:hers|his|theirs))\b|\b(?:it'?s|it\s+is|belongs\s+to|in)\s+my\s+(?:wife|husband|mom|mother|dad|father|son|daughter|family|parents)(?:'s)?\b|\bes\s+de\s+mi\s+(?:esposa|esposo|mam[aá]|madre|pap[aá]|padre|hij[oa]|herman[oa]|familia)/i],
  [V2_IDENTITY_KINDS.OCCUPANT, /\bi\s+(?:rent|lease)\b|\b(?:i'?m\s+(?:a|the)\s+)?(?:tenant|renter)\b|\bi'?m\s+renting\b|\bi\s+(?:just\s+)?live\s+(?:there|here)\b|\b(?:yo\s+)?(?:rento|alquilo)\b/i],
];

/** "I manage it" / "my wife owns it" / "my LLC owns it" / "I rent" → the identity kind, else null. */
export function detectIdentityStatement(message = "") {
  const text = clean(message);
  if (!text) return null;
  for (const [kind, re] of IDENTITY_RULES) if (re.test(text)) return kind;
  return null;
}

export function isBareNo(message = "", { thread_language = null } = {}) {
  const text = clean(message);
  if (BARE_NO_RE.test(text)) return true;
  const ml = canonicalizeMultilingualReply(text, { thread_language });
  return ml?.category === "negative" && ml.canonical_text === "no";
}

/**
 * The v2 intent for this turn: classifier verdict first (it is the canonical
 * rules engine), then the v2 text rules fill the gaps the classifier leaves as
 * unclear / review. Compliance intents from the classifier are never replaced.
 */
export function resolveV2Intent({ classification = null, message = "", stage = V2_STAGES.UNKNOWN, thread_language = null, prior_template_use_case = null } = {}) {
  const primary = lower(classification?.primary_intent) || "unclear";
  const from_classifier = CLASSIFIER_INTENT_MAP[primary] || I.UNCLEAR;
  const compliance = clean(classification?.compliance_flag);
  // The reply to our ONE-TIME ownership clarifier decides; wrong number /
  // opt-out / hostile keep their existing lanes (suppression wins).
  const after_clarifier = lower(prior_template_use_case) === "ownership_connection_clarifier";
  if (after_clarifier && !compliance && ![I.OPT_OUT, I.WRONG_NUMBER, I.HOSTILE_LEGAL].includes(from_classifier)) {
    const kind = detectIdentityStatement(message);
    if (kind) return { intent: I.IDENTITY_STATEMENT, source: `v2_identity_${kind}`, identity_kind: kind, classifier_intent: primary };
    if (isBareNo(message, { thread_language })) return { intent: I.BARE_NO_AFTER_CLARIFIER, source: "v2_bare_no_after_clarifier", classifier_intent: primary };
  }
  if (!after_clarifier && stage === V2_STAGES.S1 && !compliance && [I.UNCLEAR, I.NON_OWNER].includes(from_classifier) && isBareNo(message, { thread_language })) {
    return { intent: I.BARE_NO_OWNERSHIP, source: "v2_bare_no_to_ownership", classifier_intent: primary };
  }
  if (compliance || V2_DEFERRED_INTENTS.has(from_classifier)) {
    // Capital gains is the one owner-sanctioned override of a soft decline
    // ("no — the taxes would kill me"); compliance / relationship intents are
    // never overridden.
    if (from_classifier === I.NOT_INTERESTED && !compliance) {
      const text_rule = detectV2TextIntent(message, { thread_language });
      if (text_rule?.intent === I.CAPITAL_GAINS) return { intent: I.CAPITAL_GAINS, source: text_rule.rule_id, classifier_intent: primary };
    }
    return { intent: from_classifier, source: "classifier", classifier_intent: primary };
  }
  const text_rule = detectV2TextIntent(message, { thread_language });
  if (text_rule?.guard) return { intent: text_rule.intent, source: text_rule.rule_id, classifier_intent: primary };
  if (text_rule?.intent === I.CAPITAL_GAINS) return { intent: I.CAPITAL_GAINS, source: text_rule.rule_id, classifier_intent: primary };
  // A committed price is the classifier's call (the one money path parses it).
  if (from_classifier === I.PRICE_GIVEN) return { intent: I.PRICE_GIVEN, source: "classifier", classifier_intent: primary };
  // The classifier named the same meaning but held it for review (e.g. "I have
  // no idea" → asking_price_absent @ human_review): the rule corroborates it.
  if (text_rule && text_rule.intent === from_classifier && classification?.automation_decision?.human_review_required === true) {
    return { intent: text_rule.intent, source: `${text_rule.rule_id}_corroborates_classifier`, classifier_intent: primary };
  }
  if (text_rule && (from_classifier === I.UNCLEAR || from_classifier === I.ACKNOWLEDGEMENT || from_classifier === I.AFFIRMATIVE)) {
    // "ok" is only a yes to the interest question or as a condition answer.
    if (text_rule.intent === I.AFFIRMATIVE && /^\s*ok(?:ay)?[\s.!]*$/i.test(message) && ![V2_STAGES.S2, V2_STAGES.S4].includes(stage)) {
      return { intent: from_classifier, source: "classifier", classifier_intent: primary };
    }
    return { intent: text_rule.intent, source: text_rule.rule_id, classifier_intent: primary };
  }
  if (from_classifier === I.ACKNOWLEDGEMENT && stage === V2_STAGES.S2 && /^\s*ok(?:ay)?[\s.!]*$/i.test(message)) {
    return { intent: I.AFFIRMATIVE, source: "v2_ok_to_interest_question", classifier_intent: primary };
  }
  // At the condition question, ANY substantive answer is a condition answer
  // (owner: "whatever they answer, we already have our number").
  if (stage === V2_STAGES.S4 && (from_classifier === I.UNCLEAR || from_classifier === I.ACKNOWLEDGEMENT) && /\p{L}{2,}/u.test(message)) {
    return { intent: I.CONDITION_ANSWER, source: "v2_any_answer_to_condition_question", classifier_intent: primary };
  }
  return { intent: from_classifier, source: "classifier", classifier_intent: primary };
}

// ══════════════════════════════════════════════════════════════════════════
// CLASSIFICATION OVERLAY (rules-only extension, flag-gated)
// ══════════════════════════════════════════════════════════════════════════

/** v2 intent → the canonical classifier intent the existing pipeline already routes. */
const OVERLAY_PRIMARY_INTENT = Object.freeze({
  [I.AFFIRMATIVE]: null, // stage-dependent, see below
  [I.INTEREST]: "seller_interested",
  [I.CONDITIONAL_INTEREST]: "seller_interested",
  [I.OFFER_REQUEST]: "asks_offer",
  [I.NO_PRICE]: "asking_price_absent",
  [I.CONDITION_ANSWER]: "condition_disclosed",
  [I.WHO_WHY]: "who_is_this",
  // Capital gains keeps the classifier's own label (unclear / not_interested
  // becomes unclear) so no stage advances; the v2 directive names the probe.
  [I.CAPITAL_GAINS]: "unclear",
  // Hands the turn to the EXISTING need_time lane (unchanged handling).
  [I.NOT_NOW]: "need_time",
  // A bare "No" to "do you own …?" stays unclear (no stage moves) but may be
  // answered once with the connection clarifier.
  [I.BARE_NO_OWNERSHIP]: "unclear",
});

/**
 * Overlay the v2 reading onto the classifier verdict. Returns the SAME object
 * when nothing applies. Applies only when the question context is VALID (open
 * question, ≤ 7 days, not superseded) — that is what makes a bare "yes"
 * context-bound — or for context-free intents (who/why, offer request,
 * capital gains).
 */
// English function words / seller vocabulary. A reply with none of these is
// not evidence of English, so it cannot override the seller's established
// non-English language ("Necesita techo nuevo" detected English, 2026-10-06).
const ENGLISH_EVIDENCE_RE =
  /\b(?:the|is|it|it'?s|its|yes|yeah|yep|no|not|and|you|your|my|i|i'?m|we|need|needs|good|bad|fair|ok|okay|house|home|property|roof|shape|condition|work|repairs?|new|old|great|fine|price|offer|sell|selling|thanks?|what|who|why|how|send|bid|maybe)\b/i;

/**
 * Owner rule (2026-10-05): reply in the seller's language. When the
 * classifier labels a reply English with no English evidence while the
 * seller's previous identifiable replies were another language, keep the
 * seller's language. Returns null when nothing changes.
 */
export function resolveV2LanguageContinuity(classification = null, conversation_context = null, message = "") {
  const detected = clean(classification?.language);
  const history = clean(conversation_context?.seller_reply_language);
  if (lower(detected) !== "english" || !history || lower(history) === "english") return null;
  if (clean(classification?.reply_language_source) === "language_switch_request") return null;
  if (ENGLISH_EVIDENCE_RE.test(String(message || ""))) return null;
  if (!/\p{L}/u.test(String(message || ""))) return null;
  return { language: history, reply_language_source: "seller_history", previous_language: detected };
}

/**
 * The asking price stated in THIS message: the one money path's committed
 * value, else (only when the classifier already read a price) a local-unit
 * amount from the multilingual canonicaliser ("24万", "3 triệu", "2 lakh"),
 * which the English money parser cannot read.
 */
export function resolveV2AskingPriceThisTurn({ committed_value = null, classification = null, message = "", thread_language = null } = {}) {
  const v = num(committed_value);
  if (v != null && v > 0) return { amount: v, source: "canonical_money_path" };
  if (lower(classification?.primary_intent) !== "asking_price_provided") return { amount: null, source: null };
  const ml = canonicalizeMultilingualReply(message, { thread_language });
  const amount = num(ml?.amount);
  if (ml?.category === "price" && amount != null && amount > 0) return { amount, source: "multilingual_local_amount" };
  return { amount: null, source: null };
}

export function applySellerAutopilotV2Overlay(classification = null, {
  message = "",
  conversation_context = null,
  stage_before = null,
} = {}) {
  if (!classification || typeof classification !== "object") return { classification, overlay: null };
  const language_patch = resolveV2LanguageContinuity(classification, conversation_context, message);
  if (language_patch) {
    classification = {
      ...classification,
      language: language_patch.language,
      reply_language_source: language_patch.reply_language_source,
    };
  }
  const language_only = language_patch
    ? {
        overlay: {
          version: SELLER_AUTOPILOT_V2_VERSION,
          rule_id: "v2_language_continuity",
          language_patch,
        },
        classification: { ...classification, seller_autopilot_v2: { version: SELLER_AUTOPILOT_V2_VERSION, rule_id: "v2_language_continuity", language_patch } },
      }
    : { classification, overlay: null };
  const stage_info = resolveV2Stage({ conversation_context, stage_before });
  const thread_language = conversation_context?.last_outbound_language || null;
  const resolved = resolveV2Intent({
    classification,
    message,
    stage: stage_info.stage,
    thread_language,
    prior_template_use_case: conversation_context?.last_outbound_template_use_case || null,
  });
  if (resolved.source === "classifier") return language_only;
  // Identity / second-"No" turns are decided by the planner (review); the
  // classifier verdict is left as it is.
  if ([I.IDENTITY_STATEMENT, I.BARE_NO_AFTER_CLARIFIER].includes(resolved.intent)) return language_only;

  const context_free = [I.WHO_WHY, I.OFFER_REQUEST, I.CAPITAL_GAINS, I.NOT_NOW].includes(resolved.intent);
  if (!context_free && stage_info.context_status !== "valid") return language_only;
  if ([I.OPT_OUT, I.HOSTILE_LEGAL].includes(resolved.intent)) return language_only;

  let primary_intent = OVERLAY_PRIMARY_INTENT[resolved.intent];
  if (resolved.intent === I.AFFIRMATIVE) {
    primary_intent =
      stage_info.stage === V2_STAGES.S1 ? "ownership_confirmed"
      : stage_info.stage === V2_STAGES.S2 ? "seller_interested"
      : stage_info.stage === V2_STAGES.S4 ? "condition_disclosed"
      : stage_info.stage === V2_STAGES.S3 ? "seller_interested"
      : null;
  }
  if (!primary_intent) return language_only;

  const overlay = {
    version: SELLER_AUTOPILOT_V2_VERSION,
    rule_id: resolved.source,
    v2_intent: resolved.intent,
    v2_stage: stage_info.stage,
    stage_source: stage_info.source,
    previous_primary_intent: classification.primary_intent || null,
    previous_confidence: classification.confidence ?? null,
    previous_automation_decision: classification.automation_decision || null,
    ...(language_patch ? { language_patch } : {}),
  };
  return {
    overlay,
    classification: {
      ...classification,
      primary_intent,
      confidence: Math.max(Number(classification.confidence) || 0, 0.86),
      automation_decision: {
        ...(classification.automation_decision || {}),
        auto_reply_allowed: true,
        human_review_required: false,
        decided_by: "seller_autopilot_v2_rules",
      },
      seller_autopilot_v2: overlay,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// OFFER AUTHORITY (authoritative Decision Engine only)
// ══════════════════════════════════════════════════════════════════════════

/** Snapshots computed before this date do not replay under today's offer policy (Deal Intelligence 09-27). */
export const V2_OFFER_POLICY_EPOCH = OFFER_POLICY_EPOCH;

export const V2_HOLD_REASONS = Object.freeze({
  NO_OFFER: "v2_hold_no_offer_engine_result",
  NOT_SFR: "v2_hold_not_single_family",
  ASSET_UNKNOWN: "v2_hold_asset_class_unknown",
  STALE: "v2_hold_offer_predates_current_policy",
  NOT_AUTHORITATIVE: "v2_hold_offer_not_authoritative",
  MAO_MISSING: "v2_hold_mao_missing",
  OFFER_ABOVE_MAO: "v2_hold_offer_above_mao_inconsistent",
  MAO_ABOVE_VALUE: "v2_hold_mao_above_valuation_inconsistent",
  ASK_INCONSISTENT: "v2_hold_asking_price_inconsistent",
  FEW_COMPS: "v2_hold_insufficient_nearby_as_is_comps",
  FEW_CLEAN_COMPS: "v2_hold_insufficient_non_outlier_comps",
  ANCHOR_NON_POSITIVE: "v2_hold_anchor_not_positive",
});

const MULTIFAMILY_TYPE_RE = /multi|duplex|triplex|fourplex|quadplex|apartment|5\+|2-4|units?\b/i;

/** Single-family gate. Multifamily (2-4 and 5+), commercial, land and unknown are held. */
export function resolveV2AssetGate({ ade_snapshot = null, property_metadata = {} } = {}) {
  const subject = ade_snapshot?.evidence?.subject || {};
  const units = num(property_metadata?.unit_count ?? property_metadata?.units_count ?? subject?.normalized_features?.units);
  const type = clean(property_metadata?.property_type);
  const asset = lower(subject.asset_type || subject.normalized_features?.asset_class);
  if (units != null && units > 1) return { sfr: false, reason: V2_HOLD_REASONS.NOT_SFR, asset: `units_${units}` };
  if (type && MULTIFAMILY_TYPE_RE.test(type)) return { sfr: false, reason: V2_HOLD_REASONS.NOT_SFR, asset: type };
  if (asset && asset !== "single_family") return { sfr: false, reason: V2_HOLD_REASONS.NOT_SFR, asset };
  if (subject?.asset_identity_conflict === true) return { sfr: false, reason: V2_HOLD_REASONS.NOT_SFR, asset: "asset_identity_conflict" };
  if (!asset && !/single|sfr|residential/i.test(type)) return { sfr: false, reason: V2_HOLD_REASONS.ASSET_UNKNOWN, asset: type || null };
  return { sfr: true, reason: null, asset: asset || type };
}

/**
 * Authoritative offer for the price branches. `spendability` is the live
 * path's resolveValuationSpendability() verdict for the SAME snapshot (tier ∈
 * AUTO_HARD_OFFER/AUTO_RANGE_OFFER + a contamination defense ran).
 */
export function resolveV2OfferAuthority({
  ade_snapshot = null,
  spendability = null,
  property_metadata = {},
  now = Date.now(),
} = {}) {
  if (!ade_snapshot) return { ok: false, reason: V2_HOLD_REASONS.NO_OFFER };
  const asset = resolveV2AssetGate({ ade_snapshot, property_metadata });
  const base = {
    snapshot_id: ade_snapshot?.evidence?.immutable_snapshot_id ?? ade_snapshot?.id ?? null,
    property_id: clean(ade_snapshot?.property_id) || null,
    computed_at: ade_snapshot?.computed_at || ade_snapshot?.created_at || null,
    engine_version: ade_snapshot?.evidence?.engine?.version ?? null,
    decision_tier: clean(ade_snapshot?.decision_tier) || null,
    confidence: num(ade_snapshot?.confidence),
    valuation_confidence: num(ade_snapshot?.valuation_confidence),
    valuation_mid: num(ade_snapshot?.valuation_mid),
    asset: asset.asset,
  };
  if (!asset.sfr) return { ok: false, reason: asset.reason, ...base };
  const computed = Date.parse(base.computed_at || "");
  if (Number.isFinite(computed) && computed < Date.parse(V2_OFFER_POLICY_EPOCH)) {
    return { ok: false, reason: V2_HOLD_REASONS.STALE, ...base };
  }
  // The SAME offer-ready predicate the Composer preflight counts (freshness +
  // authoritative tier + positive offer and ceiling).
  const readiness = evaluateOfferReadiness(ade_snapshot, { now });
  if (!readiness.ready) {
    const map = {
      [OFFER_READY_REASONS.PREDATES_POLICY]: V2_HOLD_REASONS.STALE,
      [OFFER_READY_REASONS.STALE]: V2_HOLD_REASONS.STALE,
      [OFFER_READY_REASONS.NO_OFFER]: V2_HOLD_REASONS.NO_OFFER,
      [OFFER_READY_REASONS.NO_CEILING]: V2_HOLD_REASONS.MAO_MISSING,
    };
    return {
      ok: false,
      reason: map[readiness.reason] || `${V2_HOLD_REASONS.NOT_AUTHORITATIVE}:${readiness.reason}`,
      offer_ready: readiness,
      ...base,
    };
  }
  if (spendability?.spendable !== true) {
    return { ok: false, reason: `${V2_HOLD_REASONS.NOT_AUTHORITATIVE}:${clean(spendability?.reason) || "unknown"}`, ...base };
  }
  const offer = num(ade_snapshot?.recommended_cash_offer);
  if (offer == null || offer <= 0) return { ok: false, reason: V2_HOLD_REASONS.NO_OFFER, ...base };
  const mao = num(ade_snapshot?.evidence?.offer_calculation?.effective_authorized_ceiling);
  if (mao == null || mao <= 0) return { ok: false, reason: V2_HOLD_REASONS.MAO_MISSING, offer, ...base };
  if (offer > mao) return { ok: false, reason: V2_HOLD_REASONS.OFFER_ABOVE_MAO, offer, mao, ...base };
  if (base.valuation_mid != null && mao > base.valuation_mid) {
    return { ok: false, reason: V2_HOLD_REASONS.MAO_ABOVE_VALUE, offer, mao, ...base };
  }
  return {
    ok: true,
    reason: "v2_offer_authoritative",
    offer,
    mao,
    range: { low: num(ade_snapshot?.minimum_acceptable_offer) ?? offer, high: mao },
    comps: Array.isArray(ade_snapshot?.evidence?.selected_comps) ? ade_snapshot.evidence.selected_comps : [],
    ...base,
  };
}

/** An asking price that cannot be a real ask for this house (parse junk, wrong property). */
export function isAskingPriceInconsistent(asking, authority = {}) {
  const ask = num(asking);
  if (ask == null || ask < 10_000) return true;
  const value = num(authority?.valuation_mid);
  if (value != null && value > 0 && (ask < value * 0.2 || ask > value * 5)) return true;
  return false;
}

// ══════════════════════════════════════════════════════════════════════════
// AS-IS ANCHOR (the "around $X" number)
// ══════════════════════════════════════════════════════════════════════════

export const V2_ANCHOR_RULES = Object.freeze({
  nearby_miles: 1.0,
  max_age_months: 12,
  min_sale_price: 10_000,
  min_comps: 3,
  outlier_fraction_of_median: 0.75, // lowest < 75% of the median → outlier
  tukey_min_n: 5, // with ≥5 comps, also lowest < Q1 − 1.5·IQR → outlier
  average_of: 3,
  round_down_large: 5_000, // X ≥ $100K → floor to $5K
  round_down_small: 1_000, // X < $100K → floor to $1K
  large_threshold: 100_000,
});

const PACKAGE_HINTS = ["package", "portfolio", "bulk", "multi_parcel", "multi-parcel"];

function monthsSince(dateIso, nowMs) {
  const t = Date.parse(dateIso || "");
  if (!Number.isFinite(t)) return null;
  return (nowMs - t) / (1000 * 60 * 60 * 24 * 30.44);
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function roundAnchorDown(value, rules = V2_ANCHOR_RULES) {
  const v = num(value);
  if (v == null || v <= 0) return null;
  const step = v >= rules.large_threshold ? rules.round_down_large : rules.round_down_small;
  return Math.floor(v / step) * step;
}

/**
 * X = the LOWEST nearby as-is comp; when that comp is an outlier, the average
 * of the 3 lowest non-outlier comps. Capped at MAO and rounded DOWN.
 *
 * Comps are the Decision Engine's own selected_comps (from the investor
 * buyer-comp pool v_recent_sold_comps that Deal Intelligence shows — not the
 * v2 shadow corpus). "Nearby as-is" = raw sale_price ≥ $10K, ≤ 1.0 mi,
 * sold ≤ 12 months ago, not a package/portfolio/bulk deed.
 *
 * Outlier (explicit): lowest < 0.75 × median of the nearby set, OR (n ≥ 5 and
 * lowest < Q1 − 1.5·IQR). A percentile floor alone (e.g. "below P15") is
 * degenerate for the minimum of a small set — the minimum IS the low
 * percentile — so it is not used.
 */
export function computeAsIsAnchor({ comps = [], mao = null, now = Date.now(), rules = V2_ANCHOR_RULES } = {}) {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const cap = num(mao);
  const screened = [];
  const excluded = [];
  for (const comp of Array.isArray(comps) ? comps : []) {
    const price = num(comp?.sale_price);
    const distance = num(comp?.distance_miles);
    const age = monthsSince(comp?.sale_date || comp?.sold_date, nowMs);
    const source = lower(comp?.source || comp?.sale_source);
    const id = clean(comp?.comp_id || comp?.id || comp?.property_id) || null;
    const reasons = [];
    if (price == null || price < rules.min_sale_price) reasons.push("invalid_sale_price");
    if (distance == null) reasons.push("unknown_distance");
    else if (distance > rules.nearby_miles) reasons.push("not_nearby");
    if (age == null) reasons.push("unknown_sale_date");
    else if (age > rules.max_age_months) reasons.push("sale_too_old");
    if (PACKAGE_HINTS.some((h) => source.includes(h))) reasons.push("package_or_portfolio_sale");
    if (reasons.length) excluded.push({ comp_id: id, reasons });
    else screened.push({ comp_id: id, property_id: clean(comp?.property_id) || null, sale_price: price, distance_miles: distance, sale_date: comp?.sale_date || comp?.sold_date || null });
  }
  const evidence_base = { rules, mao: cap, eligible_count: screened.length, excluded };
  if (screened.length < rules.min_comps) {
    return { ok: false, reason: V2_HOLD_REASONS.FEW_COMPS, ...evidence_base };
  }
  const sorted = [...screened].sort((a, b) => a.sale_price - b.sale_price);
  const prices = sorted.map((c) => c.sale_price);
  const median = quantile(prices, 0.5);
  const q1 = quantile(prices, 0.25);
  const q3 = quantile(prices, 0.75);
  const fence = sorted.length >= rules.tukey_min_n ? q1 - 1.5 * (q3 - q1) : null;
  const isOutlier = (p) => p < median * rules.outlier_fraction_of_median || (fence != null && p < fence);
  const lowest = sorted[0];
  let raw;
  let rule;
  let used;
  if (!isOutlier(lowest.sale_price)) {
    raw = lowest.sale_price;
    rule = "lowest_nearby_as_is_comp";
    used = [lowest];
  } else {
    const clean_set = sorted.filter((c) => !isOutlier(c.sale_price));
    if (clean_set.length < rules.average_of) {
      return { ok: false, reason: V2_HOLD_REASONS.FEW_CLEAN_COMPS, median, fence, ...evidence_base };
    }
    used = clean_set.slice(0, rules.average_of);
    raw = used.reduce((s, c) => s + c.sale_price, 0) / used.length;
    rule = "average_of_3_lowest_non_outlier_comps";
  }
  const capped = cap != null && raw > cap;
  const pre_round = capped ? cap : raw;
  const amount = roundAnchorDown(pre_round, rules);
  if (amount == null || amount <= 0) return { ok: false, reason: V2_HOLD_REASONS.ANCHOR_NON_POSITIVE, ...evidence_base };
  if (cap != null && amount > cap) return { ok: false, reason: V2_HOLD_REASONS.ANCHOR_NON_POSITIVE, ...evidence_base }; // unreachable: floor ≤ cap
  return {
    ok: true,
    amount,
    raw_comp_value: Math.round(raw),
    capped_at_mao: capped,
    rule,
    lowest_was_outlier: rule !== "lowest_nearby_as_is_comp",
    median,
    tukey_fence: fence,
    comp_ids: used.map((c) => c.comp_id),
    comp_prices: used.map((c) => c.sale_price),
    ...evidence_base,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// USE CASES + THE MATRIX
// ══════════════════════════════════════════════════════════════════════════

export const V2_USE_CASES = Object.freeze({
  ASK_INTEREST: "consider_selling",
  ASK_PRICE: "seller_asking_price",
  PRICE_ACCEPT: "price_works_confirm_basics",
  PRICE_HIGH_CONDITION: "price_high_condition_probe",
  NO_PRICE_CONDITION: "no_price_condition_probe", // PROPOSED (inactive)
  CONDITION_CLARIFIER: "ask_condition_clarifier",
  ANCHOR_COMPS: "as_is_comp_anchor", // PROPOSED (inactive)
  // Comps sit ABOVE our max: no comp language at all (owner 2026-10-06).
  ANCHOR_ABOVE_MAX: "price_anchor_above_max", // PROPOSED (inactive)
  OWNERSHIP_CLARIFIER: "ownership_connection_clarifier", // PROPOSED (inactive) — one-time, after a bare "No" at S1
  WHO_S1: "who_is_this_resume_ownership", // PROPOSED (inactive)
  WHO_S2: "who_is_this",
  WHO_S3: "who_is_this_resume_price", // PROPOSED (inactive)
  WHO_S4: "who_is_this_resume_condition", // PROPOSED (inactive)
  CAPITAL_GAINS: "capital_gains_creative_probe", // PROPOSED (inactive)
});

const U = V2_USE_CASES;

/** Anchor use cases send a number → they go through the Offer Term Authority (persist before send). */
export const V2_MONETARY_USE_CASES = Object.freeze([U.ANCHOR_COMPS, U.ANCHOR_ABOVE_MAX]);

/** Who/why: answer, then re-ask the question of the CURRENT stage. Existing who_is_this is the approved fallback. */
const WHO_BY_STAGE = Object.freeze({
  [V2_STAGES.S1]: [U.WHO_S1, U.WHO_S2],
  [V2_STAGES.S2]: [U.WHO_S2],
  [V2_STAGES.S3]: [U.WHO_S3, U.WHO_S2],
  [V2_STAGES.S4]: [U.WHO_S4, U.WHO_S2],
});

/**
 * The INTENT × STAGE matrix (documentation + MATRIX.csv source). `price` and
 * `anchor` cells are resolved by the price logic below.
 */
export const V2_MATRIX = Object.freeze({
  [I.AFFIRMATIVE]: { S1: [U.ASK_INTEREST], S2: [U.ASK_PRICE], S3: [U.ASK_PRICE], S4: "anchor" },
  [I.INTEREST]: { S1: [U.ASK_PRICE], S2: [U.ASK_PRICE], S3: [U.ASK_PRICE], S4: "anchor" },
  [I.CONDITIONAL_INTEREST]: { S1: [U.ASK_PRICE], S2: [U.ASK_PRICE], S3: [U.ASK_PRICE], S4: "anchor" },
  [I.PRICE_GIVEN]: { S1: "price", S2: "price", S3: "price", S4: "price" },
  [I.NO_PRICE]: { S1: [U.NO_PRICE_CONDITION, U.CONDITION_CLARIFIER], S2: [U.NO_PRICE_CONDITION, U.CONDITION_CLARIFIER], S3: [U.NO_PRICE_CONDITION, U.CONDITION_CLARIFIER], S4: "anchor" },
  [I.OFFER_REQUEST]: { S1: [U.NO_PRICE_CONDITION, U.CONDITION_CLARIFIER], S2: [U.NO_PRICE_CONDITION, U.CONDITION_CLARIFIER], S3: [U.NO_PRICE_CONDITION, U.CONDITION_CLARIFIER], S4: "anchor" },
  [I.CONDITION_ANSWER]: { S1: "defer", S2: "defer", S3: "defer", S4: "anchor" },
  [I.WHO_WHY]: { S1: WHO_BY_STAGE[V2_STAGES.S1], S2: WHO_BY_STAGE[V2_STAGES.S2], S3: WHO_BY_STAGE[V2_STAGES.S3], S4: WHO_BY_STAGE[V2_STAGES.S4] },
  [I.CAPITAL_GAINS]: { S1: [U.CAPITAL_GAINS], S2: [U.CAPITAL_GAINS], S3: [U.CAPITAL_GAINS], S4: [U.CAPITAL_GAINS] },
  [I.BARE_NO_OWNERSHIP]: { S1: [U.OWNERSHIP_CLARIFIER], S2: "defer", S3: "defer", S4: "defer" },
});

const STAGE_KEY = Object.freeze({
  [V2_STAGES.S1]: "S1",
  [V2_STAGES.S2]: "S2",
  [V2_STAGES.S3]: "S3",
  [V2_STAGES.S4]: "S4",
});

// ══════════════════════════════════════════════════════════════════════════
// THE PLANNER
// ══════════════════════════════════════════════════════════════════════════

function defer(base, reason) {
  return { ...base, handled: false, action: "defer", reasoning_code: reason };
}
function review(base, reason, extra = {}) {
  return { ...base, handled: true, action: "review", review_reason: reason, reasoning_code: reason, ...extra };
}
function reply(base, preference, reason, extra = {}) {
  return {
    ...base,
    handled: true,
    action: "reply",
    template_use_case: preference[0],
    template_preference: preference,
    reasoning_code: reason,
    ...extra,
  };
}

/**
 * Plan one turn. Inputs are already-computed facts from the live path; the
 * planner adds no I/O.
 *
 * @param {object} p
 * @param {object} p.classification      classifier verdict (after the v2 overlay)
 * @param {string} p.message             seller text
 * @param {object} p.conversation_context conversation_context_v1 (the question we asked)
 * @param {string} p.stage_before        persisted lifecycle stage
 * @param {number|null} p.asking_price_this_turn committed asking price parsed from THIS message
 * @param {number|null} p.known_asking_price     committed asking price from earlier turns
 * @param {object} p.offer_authority     resolveV2OfferAuthority() result (null when no snapshot)
 */
export function planSellerAutopilotV2({
  classification = null,
  message = "",
  conversation_context = null,
  stage_before = null,
  asking_price_this_turn = null,
  known_asking_price = null,
  offer_authority = null,
  now = Date.now(),
} = {}) {
  const stage_info = resolveV2Stage({ conversation_context, stage_before });
  const thread_language = conversation_context?.last_outbound_language || null;
  const prior_template_use_case = conversation_context?.last_outbound_template_use_case || null;
  const fresh_intent = resolveV2Intent({ classification, message, stage: stage_info.stage, thread_language, prior_template_use_case });
  const intent_info = [I.IDENTITY_STATEMENT, I.BARE_NO_AFTER_CLARIFIER].includes(fresh_intent.intent)
    ? fresh_intent
    : classification?.seller_autopilot_v2?.v2_intent
      ? { intent: classification.seller_autopilot_v2.v2_intent, source: classification.seller_autopilot_v2.rule_id }
      : fresh_intent;
  const base = {
    version: SELLER_AUTOPILOT_V2_VERSION,
    v2_stage: stage_info.stage,
    stage_source: stage_info.source,
    v2_intent: intent_info.intent,
    intent_source: intent_info.source,
    monetary: null,
    price_branch: null,
  };

  // Compliance / relationship / nurture lanes: untouched.
  if (clean(classification?.compliance_flag)) return defer(base, "v2_defer_compliance_flag");
  // Answers to the one-time ownership clarifier: a human resolves identity;
  // a second "No" gets no second clarification.
  if (intent_info.intent === I.IDENTITY_STATEMENT) {
    return review(base, `v2_identity_resolution:${intent_info.identity_kind}`, { identity_kind: intent_info.identity_kind });
  }
  if (intent_info.intent === I.BARE_NO_AFTER_CLARIFIER) return review(base, "v2_bare_no_after_ownership_clarifier");
  if (V2_DEFERRED_INTENTS.has(intent_info.intent)) return defer(base, `v2_defer_${intent_info.intent}`);
  if (intent_info.intent === I.UNCLEAR || intent_info.intent === I.ACKNOWLEDGEMENT) return defer(base, `v2_defer_${intent_info.intent}`);
  // The classifier's own human-review verdict binds (hard invariant): v2 only
  // answers what the rules understood.
  if (classification?.automation_decision?.human_review_required === true) return defer(base, "v2_defer_classifier_review");

  const stage_key = STAGE_KEY[stage_info.stage];
  if (!stage_key) {
    // Beyond S4 (offer, contract…) or no stage at all: the S5+ negotiation engine owns it.
    if (intent_info.intent === I.CAPITAL_GAINS) return reply(base, [U.CAPITAL_GAINS], "v2_capital_gains_creative_probe");
    return defer(base, stage_info.stage === V2_STAGES.S4_BASICS ? "v2_defer_confirm_basics_answer_to_s5" : "v2_defer_stage_out_of_scope");
  }

  const cell = V2_MATRIX[intent_info.intent]?.[stage_key];
  if (!cell || cell === "defer") return defer(base, `v2_defer_no_cell_${intent_info.intent}_${stage_key}`);

  if (Array.isArray(cell)) {
    return reply(base, cell, `v2_${stage_key}_${intent_info.intent}`);
  }

  // ── price logic (S3 → S4), SFR only ──────────────────────────────────────
  const ask_now = num(asking_price_this_turn);
  const ask = ask_now ?? num(known_asking_price);
  if (cell === "price" && ask_now == null) {
    // The classifier saw a price but the one money path did not commit it
    // (ambiguous / joke / URL): the existing clarifier path owns it.
    return defer(base, "v2_defer_price_not_committed");
  }
  if (!offer_authority?.ok) {
    const hold_reason = offer_authority?.reason || V2_HOLD_REASONS.NO_OFFER;
    const not_sfr = hold_reason === V2_HOLD_REASONS.NOT_SFR || hold_reason === V2_HOLD_REASONS.ASSET_UNKNOWN;
    const ask_bad = ask != null && isAskingPriceInconsistent(ask, offer_authority || {});
    // A price arrived but we cannot compare it (no / non-authoritative /
    // stale offer). The condition question carries NO number, so the
    // conversation keeps moving exactly as the engine's own non-spendable
    // route does (resolveNonSpendableNextAction → condition probe); the number
    // step (anchor) is where the hold binds. Multifamily / unknown asset and
    // an implausible ask go straight to a human.
    if (cell === "price" && !not_sfr && !ask_bad) {
      return reply(base, [U.PRICE_HIGH_CONDITION], "v2_price_unverifiable_condition_probe", {
        price_branch: "price_given_offer_unavailable",
        asking_price: ask,
        hold_note: hold_reason,
        authority: offer_authority || null,
      });
    }
    return review(base, ask_bad && !not_sfr ? V2_HOLD_REASONS.ASK_INCONSISTENT : hold_reason, {
      price_branch: cell === "price" ? "price_given_hold" : "anchor_hold",
      asking_price: ask,
      authority: offer_authority || null,
    });
  }
  const authority_evidence = {
    offer: offer_authority.offer,
    mao: offer_authority.mao,
    range: offer_authority.range,
    decision_tier: offer_authority.decision_tier,
    confidence: offer_authority.confidence,
    snapshot_id: offer_authority.snapshot_id,
    computed_at: offer_authority.computed_at,
    engine_version: offer_authority.engine_version,
  };
  if (ask != null && isAskingPriceInconsistent(ask, offer_authority)) {
    return review(base, V2_HOLD_REASONS.ASK_INCONSISTENT, { price_branch: "price_inconsistent", asking_price: ask, authority: authority_evidence });
  }

  if (cell === "price") {
    if (ask <= offer_authority.mao) {
      return reply(base, [U.PRICE_ACCEPT], "v2_price_within_offer_range_confirm_basics", {
        price_branch: ask <= offer_authority.offer ? "ask_at_or_below_offer" : "ask_within_range",
        asking_price: ask,
        authority: authority_evidence,
      });
    }
    return reply(base, [U.PRICE_HIGH_CONDITION], "v2_price_above_range_condition_probe", {
      price_branch: "ask_above_range",
      asking_price: ask,
      authority: authority_evidence,
    });
  }

  // cell === "anchor": S4 — any answer to the condition question.
  if (ask != null && ask <= offer_authority.mao) {
    return reply(base, [U.PRICE_ACCEPT], "v2_anchor_step_ask_within_range_confirm_basics", {
      price_branch: "ask_within_range_at_condition",
      asking_price: ask,
      authority: authority_evidence,
    });
  }
  const anchor = computeAsIsAnchor({ comps: offer_authority.comps, mao: offer_authority.mao, now });
  if (!anchor.ok) {
    return review(base, anchor.reason, { price_branch: "anchor_hold", asking_price: ask, authority: authority_evidence, anchor });
  }
  const offer_version = {
    snapshot_id: offer_authority.snapshot_id,
    computed_at: offer_authority.computed_at,
    engine_version: offer_authority.engine_version,
    decision_tier: offer_authority.decision_tier,
    recommended_offer: offer_authority.offer,
  };
  if (anchor.capped_at_mao) {
    // ABOVE MAX: the nearby as-is comps are above what we can pay, so the
    // message makes NO comp claim. X is the production engine's own opening
    // number per the negotiation rule (recommended_cash_offer — the ladder
    // opens there and concedes toward the margin-protected ceiling), never
    // above MAO, floored to $5K/$1K.
    const amount = roundAnchorDown(Math.min(offer_authority.offer, offer_authority.mao));
    if (amount == null || amount <= 0 || amount > offer_authority.mao) {
      return review(base, V2_HOLD_REASONS.ANCHOR_NON_POSITIVE, { price_branch: "anchor_hold", asking_price: ask, authority: authority_evidence });
    }
    return reply(base, [U.ANCHOR_ABOVE_MAX], "v2_anchor_above_max_engine_offer", {
      price_branch: ask == null ? "no_price_anchor" : "ask_above_range_anchor",
      asking_price: ask,
      authority: authority_evidence,
      monetary: {
        kind: "negotiation_anchor",
        amount,
        ceiling: offer_authority.mao,
        rule: "above_max",
        capped_at_mao: true,
        raw_comp_value: anchor.raw_comp_value,
        comp_ids: anchor.comp_ids,
        comp_prices: anchor.comp_prices,
        median: anchor.median,
        offer_version,
      },
    });
  }
  const anchor_reason = anchor.lowest_was_outlier ? "v2_anchor_avg3_non_outlier_comps" : "v2_anchor_lowest_as_is_comp";
  return reply(base, [U.ANCHOR_COMPS], anchor_reason, {
    price_branch: ask == null ? "no_price_anchor" : "ask_above_range_anchor",
    asking_price: ask,
    authority: authority_evidence,
    monetary: {
      kind: "negotiation_anchor",
      amount: anchor.amount,
      ceiling: offer_authority.mao,
      rule: anchor.rule,
      capped_at_mao: false,
      raw_comp_value: anchor.raw_comp_value,
      comp_ids: anchor.comp_ids,
      comp_prices: anchor.comp_prices,
      median: anchor.median,
      offer_version,
    },
  });
}

/**
 * Translate a plan into the executor's existing directive vocabulary. A reply
 * becomes an immediate-send strategy directive with an exact template
 * preference; a review becomes a review directive. The executor's
 * suppression, classifier-verdict, language fail-closed, render, Offer Term
 * Authority and auto_reply_mode gates all still run.
 */
export function buildV2ExecutionDirectives(plan = null) {
  if (!plan?.handled) return null;
  if (plan.action === "review") {
    return {
      strategyDirective: {
        strategy: "seller_autopilot_v2",
        reason_code: plan.reasoning_code,
        review_required: true,
        review_reason: plan.review_reason,
        v2_plan: plan,
      },
      dealAuthorityPatch: null,
    };
  }
  const monetary = plan.monetary;
  return {
    strategyDirective: {
      strategy: "seller_autopilot_v2",
      reason_code: plan.reasoning_code,
      template_use_case: plan.template_use_case,
      allowed_template_use_cases: plan.template_preference,
      template_preference: plan.template_preference,
      review_required: false,
      next_action: "send_message_now",
      monetary_amount: monetary?.amount ?? null,
      v2_plan: plan,
    },
    dealAuthorityPatch: monetary
      ? {
          // Rendered as {{offer_price}} and persisted as the active offer
          // version BEFORE the send (Offer Term Authority). Bounded twice: the
          // planner capped it at MAO and resolveAuthorizedOfferAmount re-checks
          // it against the same ceiling.
          authorized_offer_amount: monetary.amount,
          authorized_offer_ceiling: monetary.ceiling,
          v2_anchor_evidence: monetary,
        }
      : null,
  };
}

export default planSellerAutopilotV2;

// ══════════════════════════════════════════════════════════════════════════
// PER-LANGUAGE ENABLEMENT (owner 2026-10-06)
// ══════════════════════════════════════════════════════════════════════════
// system_control[seller_autopilot_v2_languages] = "English,Spanish" (the
// default when the key is absent). An auto-reply in any other language goes
// to human review WHATEVER its templates say — a language is enabled only
// after its copy was natively reviewed. Editable through the queue-control
// route; shown in its GET as `seller_autopilot`.

export const V2_LANGUAGES_KEY = "seller_autopilot_v2_languages";
export const V2_DEFAULT_ENABLED_LANGUAGES = Object.freeze(["English", "Spanish"]);
export const V2_TEMPLATE_LANGUAGES = Object.freeze([
  "English", "Spanish", "Portuguese", "French", "German", "Italian", "Polish", "Vietnamese",
  "Mandarin", "Korean", "Japanese", "Hebrew", "Arabic", "Russian", "Greek", "Indian (Hindi or Other)",
]);
const LANGUAGE_ALIASES = Object.freeze({
  hindi: "Indian (Hindi or Other)", indian: "Indian (Hindi or Other)", chinese: "Mandarin", zh: "Mandarin",
  en: "English", es: "Spanish", pt: "Portuguese", fr: "French", de: "German", it: "Italian", pl: "Polish",
  vi: "Vietnamese", ko: "Korean", ja: "Japanese", he: "Hebrew", ar: "Arabic", ru: "Russian", el: "Greek", hi: "Indian (Hindi or Other)",
});

export function canonicalTemplateLanguage(value) {
  const raw = clean(value);
  if (!raw) return null;
  const hit = V2_TEMPLATE_LANGUAGES.find((l) => l.toLowerCase() === raw.toLowerCase());
  return hit || LANGUAGE_ALIASES[raw.toLowerCase()] || null;
}

/** Parse the switch. Absent / blank ⇒ the EN+ES default; unknown names are ignored, never enabled. */
export function parseEnabledLanguages(raw = null) {
  if (raw == null || !clean(Array.isArray(raw) ? raw.join(",") : raw)) return [...V2_DEFAULT_ENABLED_LANGUAGES];
  const list = (Array.isArray(raw) ? raw : String(raw).split(/[,;|]/)).map(canonicalTemplateLanguage).filter(Boolean);
  return [...new Set(list)];
}

export function isReplyLanguageEnabled(language, enabled = V2_DEFAULT_ENABLED_LANGUAGES) {
  const lang = canonicalTemplateLanguage(language) || "English";
  return enabled.includes(lang);
}

export function summarizeAutopilotLanguageStatus({ flag = isSellerAutopilotV2Enabled(), raw = null } = {}) {
  const enabled = parseEnabledLanguages(raw);
  return {
    flag: SELLER_AUTOPILOT_V2_FLAG,
    flag_enabled: flag,
    languages_key: V2_LANGUAGES_KEY,
    languages_enabled: enabled,
    languages_review_only: V2_TEMPLATE_LANGUAGES.filter((l) => !enabled.includes(l)),
    source: raw == null || !clean(raw) ? "default" : "system_control",
  };
}
