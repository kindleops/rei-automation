// Builds the `conversation_context_v1` object that classify.js already knows how
// to consume.
//
// Production incident 2026-08-03: the outbound "Do you still own 4157 Pillsbury
// Ave S Unit B?" was delivered and persisted, the seller replied "Yeah", and
// conversation-context.js already contained a complete resolver
// (applyContextualShortReply → ownership_confirmed @ 0.88). But NO caller ever
// constructed the context object, so validateConversationContext always returned
// `unavailable`, classify.js capped confidence at 0.72
// (short_reply_without_validated_context), and the 0.82 automation gate routed a
// perfectly unambiguous answer to human review. The context was available in the
// database the whole time — `context_status: unavailable` was simply wrong.
//
// This module never fabricates context from message text. If the last outbound
// cannot be resolved, or its use case is not an approved one, it returns null and
// the classifier keeps its existing `unavailable` behaviour.

import {
  APPROVED_OUTBOUND_USE_CASES,
  CONTEXT_VERSION,
  isCanonicalE164,
} from "./conversation-context.js";
import { extractAddresseeName, extractSenderName, detectMessageLanguage } from "./reply-disposition-signals.js";
import { describeLastQuestion } from "./last-question.js";
import { parsePlatformReaction } from "./emoji-interpretation.js";
import { latestIdentifiableSellerLanguage } from "./seller-reply-language.js";
import { isSellerAutopilotV2Enabled, V2_CONTEXT_ALIASES } from "@/lib/domain/seller-flow/seller-autopilot-v2.js";
import { isSellerConversationV3Active, V3_CONTEXT_ALIASES } from "@/lib/domain/seller-flow/seller-conversation-v3.js";

/**
 * Maps a persisted send_queue.message_type onto an approved outbound use case.
 * Unknown types return null — an unmapped question must not be guessed at.
 */
export function mapMessageTypeToUseCase(message_type) {
  const raw = String(message_type ?? "").trim().toLowerCase();
  if (!raw) return null;

  const direct = raw.replace(/[\s-]+/g, "_");
  if (APPROVED_OUTBOUND_USE_CASES.includes(direct)) return direct;

  const aliases = {
    ownership: "ownership_check",
    ownership_verification: "ownership_check",
    owner_check: "ownership_check",
    follow_up: "general_followup",
    followup: "general_followup",
    proposal: "proposal_interest",
    offer_interest: "proposal_interest",
    price_check: "asking_price",
    price: "asking_price",
    condition: "condition_check",
    motivation: "motivation_check",
    timeline: "timeline_check",
    // sms_templates.use_case names (the template we actually sent), so a
    // campaign / auto-reply row whose message_type is NULL still names its
    // question through its template_id.
    consider_selling: "proposal_interest",
    consider_selling_follow_up: "proposal_interest",
    seller_asking_price: "asking_price",
    asking_price_follow_up: "asking_price",
    ownership_check_follow_up: "ownership_check",
    late_reply_confirm_ownership: "ownership_check",
    ask_timeline: "timeline_check",
    ask_condition_clarifier: "condition_check",
    mf_rents: "rent_check",
    mf_occupancy: "occupancy_check",
  };
  // SELLER AUTOPILOT V2 (flag SELLER_AUTOPILOT_V2, default OFF): the v2
  // questions name their question through template_id in every language (the
  // body fallback below only reads English/Spanish wording).
  const v2_mapped =
    !aliases[direct] && isSellerAutopilotV2Enabled() ? V2_CONTEXT_ALIASES[direct] || null : null;
  // SELLER CONVERSATION v3 (flags SELLER_CONVERSATION_V3 + SELLER_AUTOPILOT_V2):
  // the v3 questions (occupancy, re-asks, referral, update years) bind too.
  const v3_mapped =
    !aliases[direct] && !v2_mapped && isSellerConversationV3Active() ? V3_CONTEXT_ALIASES[direct] || null : null;
  const mapped = aliases[direct] || v2_mapped || v3_mapped || null;
  return mapped && APPROVED_OUTBOUND_USE_CASES.includes(mapped) ? mapped : null;
}

// Use cases that do not name a question.
const GENERIC_USE_CASES = new Set(["general_followup"]);

const USE_CASE_QUESTION_TYPE = {
  ownership_check: "ownership",
  proposal_interest: "proposal_interest",
  proposal_request: "proposal_request",
  asking_price: "asking_price",
  condition_check: "condition",
  motivation_check: "motivation",
  timeline_check: "timeline",
  rent_check: "rent",
  occupancy_check: "occupancy",
  general_followup: "other",
};

// MANUAL SENDS HAD NO QUESTION TYPE AT ALL. Measured over the 7 days to
// 2026-09-10, production outbound message_type was: ownership_check (337),
// manual_scheduled_reply (19), manual_reply (17), Follow-Up (12). The two manual
// types are unmapped, so mapMessageTypeToUseCase returned null, the whole
// context returned null, and EVERY question an operator typed by hand was
// invisible to the classifier -- including "Do you have an asking price in
// mind?" and "Thanks, what are the current monthly rents?".
//
// The question we asked is right there in the body we sent. Read it. Ordered
// most specific first; rent before price, because "what are the monthly rents"
// contains neither the word price nor a dollar sign but IS a money question.
const BODY_QUESTION_PATTERNS = [
  [/\brents?\b[^.?!]{0,40}\?|what\s+(?:are|is)\s+the\s+(?:current\s+)?(?:monthly\s+)?rents?|how\s+much\s+(?:is|are|does)\s+(?:it|they|the\s+units?)\s+rent|bringing\s+in\s+per\s+month/i, "rent_check"],
  [/\b(?:vacant|occupied|tenanted|occupancy)\b/i, "occupancy_check"],
  [/asking\s+price|price\s+in\s+mind|number\s+in\s+mind|ballpark|what\s+(?:would|do)\s+you\s+want\s+for|how\s+much\s+are\s+you\s+(?:asking|looking)/i, "asking_price"],
  [/\b(?:condition|repairs?|needs?\s+work|shape\s+is\s+it|roof|hvac)\b/i, "condition_check"],
  [/\bhow\s+soon|timeline|when\s+(?:would|do)\s+you\s+want\s+to\s+close|closing\s+timeline/i, "timeline_check"],
  [/\b(?:still\s+the\s+owner|are\s+you\s+the\s+owner|do\s+you\s+(?:still\s+)?own|is\s+.{0,60}\s+yours|(?:correct|right)\s+number\s+for\s+the\s+owner)\b/i, "ownership_check"],
  // 2026-10-05 (+18177347618): the operator typed "Thanks. Just curious, would
  // you be open to a sale?" -- not a "proposal" or an "offer", so no pattern
  // matched, the context was null and the seller's "Yes" fell to the
  // context-free default (ownership_confirmed) instead of answering the
  // sale-interest question.
  [/\bopen\s+to\s+(?:a\s+|an\s+)?(?:proposal|offer|sale|selling|sell)\b|consider\s+(?:a\s+|an\s+)?(?:proposal|offer|sale|selling)\b|would\s+you\s+(?:ever\s+)?(?:consider\s+|be\s+(?:willing|open)\s+to\s+|like\s+to\s+|want\s+to\s+)?sell(?:ing)?\b|interested\s+in\s+(?:selling|a\s+sale|an?\s+(?:offer|proposal))\b|(?:thinking|thought)\s+(?:about|of)\s+selling\b/i, "proposal_interest"],
  // Our multilingual first touches (2026-10-01 corpus). Without these a reply
  // to a Spanish / Portuguese / Vietnamese / French / Arabic-transliterated
  // question had no context at all, so "No" or "Không phải" could not be read
  // against the question that produced it.
  [/precio\s+en\s+mente|prix\s+(?:demand[eé]|en\s+t[eê]te)/i, "asking_price"],
  [/(?:eres|es\s+usted|sigues\s+siendo|todav[ií]a\s+eres|todav[ií]a\s+es)\s+(?:el\s+|la\s+)?due[ñn][oa]|\bes\s+(?:tu|su)\s+propiedad|voc[eê]\s+ainda\s+[eé]\s+(?:o|a)\s+(?:propriet[aá]ri[oa]|don[oa])|\b[eé]\s+sua\s+propriedade|c[oó]\s+ph[aả]i\s+l[aà]\s+c[uủ]a\s+b[aạ]n|\bhal\s+.{1,80}\s+lak\b/i, "ownership_check"],
  // Our romanised ownership openers in the other templated languages
  // (2026-10-06 sms_templates audit). Campaign rows normally name the question
  // through template_id; this is the body fallback.
  [/\bnin hai (?:yongyou|shi)\b|\bvy vse eshche vlad|\bata adayin baal|\bkya aap abhi bhi\b|\bajik soyu\b|\bczy nadal jeste[sś]\s+w[lł]a[sś]ciciel|\bpossiedi\b|\bsind sie (?:noch )?(?:der )?eigent|\best a vous\b|\bexeis akoma\b|\bvoce ainda e\b|\bban van la chu\b/i, "ownership_check"],
  [/abiert[oa]\s+a\s+(?:una\s+)?(?:propuesta|oferta|venta|vender)|considerar[ií]a\s+(?:una\s+)?(?:propuesta|oferta|venta|vender)|(?:le|te)\s+interesar[ií]a\s+vender|(?:quiere|quieres|quisiera|quisieras)\s+vender|discutir\s+n[uú]meros|abert[oa]\s+(?:a|para)\s+(?:uma\s+)?(?:proposta|discutir)/i, "proposal_interest"],
];

/**
 * Derive the outbound use case from the message we actually sent. Used when
 * message_type does not map, which is every manual operator reply.
 */
export function deriveUseCaseFromBody(body) {
  const text = String(body ?? "").trim();
  if (!text) return null;
  for (const [re, useCase] of BODY_QUESTION_PATTERNS) {
    if (re.test(text)) return useCase;
  }
  return null;
}

/**
 * Loads the latest delivered/sent outbound on the thread and returns a
 * conversation_context_v1 object, or null when it cannot be resolved.
 *
 * @param {object} args
 * @param {string} args.thread_key            canonical E.164 thread
 * @param {string} args.inbound_received_at   ISO timestamp of the inbound
 * @param {object} args.supabase              supabase client
 * @param {string} [args.canonical_stage]     lifecycle stage, when known
 * @param {string} [args.language]
 */
// Reaction families that are consistent with (or neutral to) a yes. A tapback
// in one of these families does not ANSWER the question it points at: it is an
// emoji, never a fact (emoji-interpretation.js), and "Removed 👍" retracts one.
// Negative / hostile / laughter / confusion reactions still count as answers,
// so a later bare "Yes" after a 👎 stays unbound and goes to review.
const NON_ANSWER_REACTION_FAMILIES = new Set(["affirmative", "emphasis", "heart", "removed"]);

// A one-word fragment the classifier could not read ("Vues", "Hm") said nothing
// about the question, so it cannot have settled it. Bounded tightly: one token,
// letters only, short, and the stored classification must be exactly
// `unclear`. A fragment with any recognised intent (opt-out, wrong number,
// who-is-this, not interested ...) or with no stored classification yet still
// counts as an answer (fail closed).
const UNREADABLE_FRAGMENT_RE = /^\p{L}{1,8}[.!?]*$/u;

/**
 * Does this intervening inbound answer our open question?
 *
 * 2026-10-05 Fort Worth (+18177347618): "Sigues siendo el dueno de 2832 Milam
 * St?" got five iOS/Android tapbacks ("👍 to “…”", "Removed 👍 from “…”") and a
 * stray "Vues", then a plain "Yes". Every one of those rows counted as an
 * answer, so the question was "already answered", the context went stale, the
 * "Yes" was capped at 0.72 (short_reply_without_validated_context) and the
 * seller got no reply.
 */
export function isInterveningAnswer(row) {
  const body = String(row?.message_body ?? "").trim();
  // No body to read: we cannot prove it said nothing. Count it.
  if (!body) return true;
  const reaction = parsePlatformReaction(body);
  if (reaction) {
    const family = reaction.family || null;
    return !NON_ANSWER_REACTION_FAMILIES.has(family);
  }
  const intent = String(row?.detected_intent ?? "").trim().toLowerCase();
  if (intent === "unclear" && UNREADABLE_FRAGMENT_RE.test(body)) return false;
  return true;
}

/**
 * sms_templates.use_case of the template a send_queue row was rendered from,
 * mapped onto an approved outbound use case. Best effort: any failure returns
 * null and the body decides.
 */
async function loadTemplateUseCaseRaw(supabase, template_id) {
  const id = String(template_id ?? "").trim();
  if (!id) return null;
  try {
    const { data, error } = await supabase
      .from("sms_templates")
      .select("use_case")
      .eq("template_id", id)
      .limit(1);
    if (error || !Array.isArray(data) || !data[0]) return null;
    return String(data[0].use_case ?? "").trim() || null;
  } catch {
    return null;
  }
}

function phoneVariants(e164) {
  const digits = String(e164 ?? "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return [...new Set([String(e164), `+1${ten}`, `1${ten}`, ten].filter(Boolean))];
}

export async function buildConversationContext({
  thread_key,
  inbound_received_at,
  supabase,
  canonical_stage = null,
  language = null,
  current_inbound_event_id = null,
  burst_event_ids = [],
} = {}) {
  if (!supabase || !isCanonicalE164(thread_key) || !inbound_received_at) return null;

  let rows;
  try {
    const { data, error } = await supabase
      .from("send_queue")
      .select("id,message_type,message_body,template_id,property_id,provider_message_id,sent_at,delivered_at,queue_status")
      // Campaign rows were written with a bare 10-digit number ("6125589879")
      // while the thread is E.164, so an exact match found no outbound, the
      // context was "unavailable" and a plain "Yes" to "do you still own…?"
      // was capped at 0.72 and sent to review (2026-09-28). Match every form.
      .in("to_phone_number", phoneVariants(thread_key))
      .in("queue_status", ["sent", "delivered"])
      .not("sent_at", "is", null)
      .lte("sent_at", inbound_received_at)
      .order("sent_at", { ascending: false })
      .limit(2);
    if (error) return null;
    rows = data;
  } catch {
    return null;
  }

  const last_outbound = Array.isArray(rows) ? rows[0] : null;
  if (!last_outbound) return null;

  // message_type first (it is explicit), then the template we sent (campaign
  // and auto-reply rows carry template_id with a NULL message_type), then the
  // body we sent (it is truth -- and the only source for an operator's typed
  // message). Campaign, auto-reply and operator sends are all questions.
  //
  // A GENERIC message_type names no question. Auto-replies are stored with
  // message_type "Follow-Up" -> general_followup, which used to win over the
  // template we actually sent (consider_selling -> proposal_interest), so a
  // "Sure" to "Would you be open to a proposal?" lost its question and went to
  // review (2026-10-05 reply-quality, 5 rows). A specific message_type still
  // wins; general_followup is only the last resort.
  const raw_message_type_use_case = mapMessageTypeToUseCase(last_outbound.message_type);
  const message_type_use_case =
    raw_message_type_use_case && !GENERIC_USE_CASES.has(raw_message_type_use_case)
      ? raw_message_type_use_case
      : null;
  const v2_enabled = isSellerAutopilotV2Enabled();
  // v2 needs the EXACT template we sent (e.g. the one-time ownership
  // clarifier), which the approved vocabulary deliberately folds away.
  const raw_template_use_case =
    v2_enabled || !message_type_use_case ? await loadTemplateUseCaseRaw(supabase, last_outbound.template_id) : null;
  const template_use_case = message_type_use_case
    ? null
    : raw_template_use_case
      ? mapMessageTypeToUseCase(raw_template_use_case)
      : null;
  const body_use_case =
    message_type_use_case || template_use_case ? null : deriveUseCaseFromBody(last_outbound.message_body);
  const use_case =
    message_type_use_case || template_use_case || body_use_case || raw_message_type_use_case;
  if (!use_case) return null;
  const use_case_source = message_type_use_case
    ? "message_type"
    : template_use_case
      ? "template_use_case"
      : body_use_case
        ? "derived_from_body"
        : "message_type";

  // The question is asked when we SEND it. A delivery receipt can arrive after
  // the seller has already answered (2026-10-06: delivered 15:33:38, "Yes" at
  // 15:33:2x), which made the context "inbound_before_outbound" -> invalid and
  // left a bare "Yes" unbound. Use the receipt only when it precedes the reply.
  const inbound_ms = new Date(inbound_received_at).getTime();
  const delivered_ms = last_outbound.delivered_at ? new Date(last_outbound.delivered_at).getTime() : NaN;
  const delivered_at =
    Number.isFinite(delivered_ms) && delivered_ms <= inbound_ms
      ? last_outbound.delivered_at
      : last_outbound.sent_at || last_outbound.delivered_at;
  if (!delivered_at) return null;

  // Has this question already been answered? Any inbound that arrived after the
  // question and before the current message is an answer to it — so a later
  // bare "Yeah" belongs to whatever is being discussed now, not to a settled
  // question. Hard-coding unanswered_question=true would fabricate certainty.
  //
  // Fragments of the CURRENT still-open burst are excluded: two messages sent
  // seconds apart are one thought, and the first must not mark the second's
  // question as already answered.
  const excluded = new Set(
    [...(Array.isArray(burst_event_ids) ? burst_event_ids : []), current_inbound_event_id]
      .filter(Boolean)
      .map(String)
  );

  let intervening_inbound_count = 0;
  let question_status = "unanswered";
  try {
    const { data, error } = await supabase
      .from("message_events")
      .select("id,created_at,direction,message_body,detected_intent:metadata->>detected_intent")
      .eq("thread_key", thread_key)
      .eq("direction", "inbound")
      .gt("created_at", new Date(delivered_at).toISOString())
      .lt("created_at", new Date(inbound_received_at).toISOString())
      .limit(50);
    if (error) return null;
    // Reactions and unreadable one-word fragments are seller activity, not an
    // answer to the question (see isInterveningAnswer).
    const prior_answers = (data || [])
      .filter((row) => !excluded.has(String(row.id)))
      .filter((row) => isInterveningAnswer(row));
    intervening_inbound_count = prior_answers.length;
    if (prior_answers.length > 0) question_status = "answered";
  } catch {
    // Evidence could not be read. Fail closed rather than assert the question
    // is still open.
    return null;
  }

  // The seller's most recent IDENTIFIABLE reply language (owner rule
  // 2026-10-05: reply in the seller's language; a too-short reply such as "ok"
  // or "👍" falls back to this). Best effort: unreadable history is null, never
  // a reason to drop the context.
  let seller_reply_language = null;
  // The seller's recent messages (newest first, this inbound excluded): lets
  // the classifier see an implausible ask earlier in the cycle (round 7).
  let recent_seller_messages = [];
  try {
    const { data, error } = await supabase
      .from("message_events")
      .select("id,created_at,message_body,language:metadata->>language")
      .eq("thread_key", thread_key)
      .eq("direction", "inbound")
      .lt("created_at", new Date(inbound_received_at).toISOString())
      .order("created_at", { ascending: false })
      .limit(15);
    if (!error && Array.isArray(data)) {
      const prior_rows = data.filter((row) => !excluded.has(String(row?.id)));
      seller_reply_language = latestIdentifiableSellerLanguage(prior_rows);
      recent_seller_messages = prior_rows
        .map((row) => String(row?.message_body || "").trim())
        .filter(Boolean)
        .slice(0, 10);
    }
  } catch {
    seller_reply_language = null;
  }

  // The property's own valuation, so an ask far above it ("1 million" on a
  // $182K house) is read as implausible, not as a price (price-plausibility.js).
  // Best effort: unreadable -> null -> no plausibility judgement at all.
  let property_valuation = null;
  const valuation_property_id = String(last_outbound.property_id ?? "").trim();
  if (valuation_property_id) {
    try {
      const { data, error } = await supabase
        .from("properties")
        .select("property_id,estimated_value,arv_estimate")
        .eq("property_id", valuation_property_id)
        .limit(1);
      const row = !error && Array.isArray(data) ? data[0] : null;
      const estimated_value = Number(row?.estimated_value);
      const arv_estimate = Number(row?.arv_estimate);
      if (row && (estimated_value > 0 || arv_estimate > 0)) {
        property_valuation = {
          property_id: valuation_property_id,
          estimated_value: estimated_value > 0 ? estimated_value : null,
          arv_estimate: arv_estimate > 0 ? arv_estimate : null,
          source: "properties",
        };
      }
    } catch {
      property_valuation = null;
    }
  }

  return {
    context_version: CONTEXT_VERSION,
    canonical_thread: thread_key,
    inbound_thread: thread_key,
    canonical_stage: canonical_stage || null,
    last_outbound_message_id: String(
      last_outbound.provider_message_id || last_outbound.id
    ),
    last_outbound_use_case: use_case,
    last_outbound_use_case_source: use_case_source,
    last_outbound_question_type: USE_CASE_QUESTION_TYPE[use_case] || "other",
    last_outbound_delivered_at: new Date(delivered_at).toISOString(),
    current_inbound_received_at: new Date(inbound_received_at).toISOString(),
    // The query is bounded to outbounds at-or-before this inbound and ordered
    // newest-first, so the head IS the live question: a newer question would
    // have been selected instead, which is how supersession is expressed.
    intervening_outbound_count: 0,
    intervening_inbound_count,
    question_status,
    unanswered_question: question_status === "unanswered",
    language: language || null,
    // Read from the body we actually sent (7.2): who we greeted, and in which
    // language. "Not James" answers "Hey James, ..."; "I don't understand"
    // answers a message written in another language.
    last_outbound_addressee: extractAddresseeName(last_outbound.message_body),
    last_outbound_language: detectMessageLanguage(last_outbound.message_body),
    seller_reply_language,
    recent_seller_messages,
    property_valuation,
    // OUR text, so a tapback quoting the SELLER's own words can be told apart
    // from a tapback on our question.
    last_outbound_body: String(last_outbound.message_body || "") || null,
    last_outbound_agent: extractSenderName(last_outbound.message_body),
    // What a bare number in the reply can mean (the ONE money path reads it):
    // "$240k?" sets the thousands scale, "how many square feet?" un-prices it.
    last_outbound_question: describeLastQuestion(last_outbound.message_body),
    ...(v2_enabled ? { last_outbound_template_use_case: raw_template_use_case || null } : {}),
  };
}

export default buildConversationContext;
