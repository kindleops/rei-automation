/**
 * Validated deterministic conversation context for classify.js.
 * Never fabricates context from message text alone.
 * Invalid / missing / stale / conflicting context → status only; no override.
 */

import { matchBareNegative, matchOfferDeflection } from "@/lib/domain/classification/seller-reply-families.js";

/** Strict E.164 for conversation-context binding (matches Brain identity rules). */
export function isCanonicalE164(thread) {
  if (thread == null) return false;
  const s = String(thread).trim();
  return /^\+[1-9]\d{7,14}$/.test(s);
}

export const CONTEXT_VERSION = 'conversation_context_v1';

/** Max age of last outbound question for short-reply binding (ms). */
export const CONTEXT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const APPROVED_OUTBOUND_USE_CASES = Object.freeze([
  'ownership_check',
  'proposal_interest',
  'proposal_request',
  'asking_price',
  'condition_check',
  'motivation_check',
  'timeline_check',
  // Multifamily rent discovery. We ask "what are the current monthly rents?"
  // constantly and had no use case for it, so the answer arrived with no
  // context and a bare "$4100.00 per Month" could not be bound to the question
  // that produced it.
  'rent_check',
  'occupancy_check',
  // RC 8.5.15: "Is it alright if I check back down the road?" (future_nurture /
  // not_interested / not_ready templates) -- permission to contact again.
  'contact_permission',
  'general_followup',
]);

export const APPROVED_QUESTION_TYPES = Object.freeze([
  'ownership',
  'rent',
  'occupancy',
  'proposal_interest',
  'proposal_request',
  'asking_price',
  'condition',
  'motivation',
  'timeline',
  'contact_permission',
  'other',
]);

const STAGE_USE_CASE_AGREEMENT = {
  ownership_check: ['cold', 'ownership', 'new', 'initial', null, undefined, ''],
  proposal_interest: ['engaged', 'proposal', 'interest', 'qualified', null, undefined, ''],
  proposal_request: ['engaged', 'proposal', 'interest', 'qualified', null, undefined, ''],
  asking_price: ['engaged', 'pricing', 'qualified', null, undefined, ''],
  condition_check: ['engaged', 'condition', 'qualified', null, undefined, ''],
};

/**
 * @typedef {object} ConversationContextInput
 * @property {string} [context_version]
 * @property {string} [canonical_thread]
 * @property {string} [canonical_stage]
 * @property {string} [last_outbound_message_id]
 * @property {string} [last_outbound_use_case]
 * @property {string} [last_outbound_question_type]
 * @property {string} [last_outbound_delivered_at]
 * @property {string} [current_inbound_received_at]
 * @property {number} [intervening_outbound_count]
 * @property {number} [intervening_inbound_count]
 * @property {boolean} [unanswered_question]
 * @property {object} [existing_active_facts]
 * @property {string} [language]
 * @property {boolean} [archived_alias]
 * @property {string} [inbound_thread] - must match canonical_thread when provided
 */

/**
 * @returns {{
 *   context_status: 'valid'|'unavailable'|'stale'|'conflicting'|'invalid',
 *   context: object|null,
 *   reasons: string[],
 * }}
 */
export function validateConversationContext(raw) {
  if (raw == null || typeof raw !== 'object') {
    return { context_status: 'unavailable', context: null, reasons: ['missing_context'] };
  }

  const reasons = [];

  if (raw.archived_alias === true) {
    return { context_status: 'invalid', context: null, reasons: ['archived_alias_rejected'] };
  }

  const version = raw.context_version != null ? String(raw.context_version) : '';
  if (version && version !== CONTEXT_VERSION) {
    return { context_status: 'invalid', context: null, reasons: ['unrecognized_context_version'] };
  }
  if (!version) {
    reasons.push('missing_context_version');
  }

  const thread = raw.canonical_thread != null ? String(raw.canonical_thread).trim() : '';
  if (!thread || !isCanonicalE164(thread)) {
    return { context_status: 'invalid', context: null, reasons: ['canonical_thread_not_e164'] };
  }

  if (raw.inbound_thread != null) {
    const inboundThread = String(raw.inbound_thread).trim();
    if (inboundThread !== thread) {
      return { context_status: 'conflicting', context: null, reasons: ['inbound_thread_mismatch'] };
    }
  }

  const useCase = raw.last_outbound_use_case != null ? String(raw.last_outbound_use_case).trim() : '';
  if (!useCase || !APPROVED_OUTBOUND_USE_CASES.includes(useCase)) {
    return { context_status: 'invalid', context: null, reasons: ['unapproved_or_missing_use_case'] };
  }

  const outboundId = raw.last_outbound_message_id != null ? String(raw.last_outbound_message_id).trim() : '';
  if (!outboundId) {
    return { context_status: 'invalid', context: null, reasons: ['missing_last_outbound_message_id'] };
  }

  const outboundAt = parseTs(raw.last_outbound_delivered_at);
  const inboundAt = parseTs(raw.current_inbound_received_at);
  if (!outboundAt || !inboundAt) {
    return { context_status: 'invalid', context: null, reasons: ['invalid_timestamps'] };
  }
  if (inboundAt.getTime() < outboundAt.getTime()) {
    return { context_status: 'invalid', context: null, reasons: ['inbound_before_outbound'] };
  }

  const ageMs = inboundAt.getTime() - outboundAt.getTime();
  if (ageMs > CONTEXT_MAX_AGE_MS) {
    return { context_status: 'stale', context: null, reasons: ['context_age_exceeded'] };
  }

  const interveningOut = Number(raw.intervening_outbound_count ?? 0);
  if (!Number.isFinite(interveningOut) || interveningOut < 0) {
    return { context_status: 'invalid', context: null, reasons: ['invalid_intervening_outbound_count'] };
  }
  if (interveningOut > 0) {
    return {
      context_status: 'stale',
      context: null,
      reasons: ['newer_outbound_superseded_question'],
    };
  }

  if (raw.unanswered_question === false) {
    // The question already got its answer. A later bare "Yeah" belongs to
    // whatever is being discussed now, not to a settled question — binding it
    // would fabricate certainty about something the seller already addressed.
    return {
      context_status: 'stale',
      context: null,
      reasons: ['question_already_answered'],
    };
  }

  const stage = raw.canonical_stage != null ? String(raw.canonical_stage).toLowerCase() : '';
  const agreed = STAGE_USE_CASE_AGREEMENT[useCase];
  if (agreed && stage && !agreed.includes(stage) && !agreed.includes(null)) {
    // Soft: unknown stages allowed; only hard-fail known conflicts
    if (['closed', 'dead', 'dnc', 'opted_out'].includes(stage)) {
      return { context_status: 'conflicting', context: null, reasons: ['stage_use_case_conflict'] };
    }
  }

  if (raw.conflicting_unresolved_question === true) {
    return { context_status: 'conflicting', context: null, reasons: ['conflicting_unresolved_question'] };
  }

  const questionType =
    raw.last_outbound_question_type != null
      ? String(raw.last_outbound_question_type).trim()
      : inferQuestionType(useCase);

  const context = {
    context_version: CONTEXT_VERSION,
    canonical_thread: thread,
    canonical_stage: stage || null,
    last_outbound_message_id: outboundId,
    last_outbound_use_case: useCase,
    last_outbound_question_type: questionType,
    last_outbound_delivered_at: outboundAt.toISOString(),
    current_inbound_received_at: inboundAt.toISOString(),
    context_age_ms: ageMs,
    intervening_outbound_count: interveningOut,
    intervening_inbound_count: Number(raw.intervening_inbound_count ?? 0) || 0,
    unanswered_question: raw.unanswered_question !== false,
    existing_active_facts:
      raw.existing_active_facts && typeof raw.existing_active_facts === 'object'
        ? raw.existing_active_facts
        : {},
    language: raw.language != null ? String(raw.language) : null,
    // Derived from OUR last outbound body by the builder (7.2): the first name
    // we greeted ("Hey James, ...") and the language we wrote in. Used only to
    // read the reply ("Not James", "I don't understand"), never to assert a fact.
    last_outbound_addressee:
      raw.last_outbound_addressee != null && String(raw.last_outbound_addressee).trim()
        ? String(raw.last_outbound_addressee).trim()
        : null,
    last_outbound_language:
      raw.last_outbound_language != null && String(raw.last_outbound_language).trim()
        ? String(raw.last_outbound_language).trim()
        : null,
    last_outbound_agent:
      raw.last_outbound_agent != null && String(raw.last_outbound_agent).trim()
        ? String(raw.last_outbound_agent).trim()
        : null,
    // What a bare number in the reply can mean ({kind, k_amount}; see
    // last-question.js). Read by the ONE money path through the classifier.
    last_outbound_question:
      raw.last_outbound_question && typeof raw.last_outbound_question === 'object' &&
      typeof raw.last_outbound_question.kind === 'string'
        ? {
            kind: raw.last_outbound_question.kind,
            k_amount:
              raw.last_outbound_question.k_amount != null &&
              Number.isFinite(Number(raw.last_outbound_question.k_amount))
                ? Number(raw.last_outbound_question.k_amount)
                : null,
          }
        : null,
  };

  return {
    context_status: 'valid',
    context,
    reasons: reasons.length ? reasons : ['ok'],
  };
}

function parseTs(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function inferQuestionType(useCase) {
  const map = {
    ownership_check: 'ownership',
    proposal_interest: 'proposal_interest',
    proposal_request: 'proposal_request',
    asking_price: 'asking_price',
    condition_check: 'condition',
    motivation_check: 'motivation',
    timeline_check: 'timeline',
    contact_permission: 'contact_permission',
    general_followup: 'other',
  };
  return map[useCase] || 'other';
}

/**
 * True if message is a short affirmative/negative token suitable for context binding.
 */
// Affirmative and negative short-reply vocabularies. A short answer carries the
// full certainty of the question it answers, so these must cover how sellers
// actually reply — not just the canonical dictionary form. Kept as explicit
// alternations (not a fuzzy matcher) so every accepted token is auditable.
// 2026-09-28 Minneapolis: "I am" (to "are you still the owner?"), "Yes is
// what's up?" and "I am and I am selling it now" all fell to unclear@0.6 and
// got no reply. An owner answers "I am" as often as "I do"; a yes followed by
// a curious or selling tail is still a yes.
const AFFIRMATIVE_HEAD =
  "(?:yes this is she|yes this is he|yes this is me|yes this is her|yes this is him|this is she|this is he|this is me|yes speaking|yes it is me|it is me|yes|yep|yeah|yup|yea|ya|yah|yes i do|yeah i do|i do|i still do|still do|still own it|i own it|sure|sure do|absolutely|definitely|correct|correcto|that is right|thats right|right|affirmative|confirmed|si|sí|claro|claro que si|claro que sí|asi es|así es|i am|yes i am|yeah i am|yep i am|i am the owner|yes i am the owner|i'm the owner|yes it is|yeah it is|it is|it is mine|yes it is mine|its mine|that is me|yes that is me|thats me|sim|vâng|vang|dạ|đúng|đúng rồi|dung roi|phải rồi|phai roi)";
const AFFIRMATIVE_TAIL =
  "(?:\\s+(?:is\\s+)?(?:what'?s up|whats up|why|what about it|what do you want|who is this|who'?s this|who are you)|\\s+and\\s+(?:i am|i'm|im)\\s+(?:selling it now|selling it|selling|looking to sell|trying to sell))?";
const AFFIRMATIVE_TOKENS = `(?:${AFFIRMATIVE_HEAD}${AFFIRMATIVE_TAIL})`;
const NEGATIVE_TOKENS =
  '(?:no|nope|nah|nel|no+|no no|no no no|no and no|no not at all|not at all|of course not|absolutely not|hell no|no sir|no ma\'am|no maam|no i never did|i never did|never did|no never|no i never owned it|no i never have|never have|sold|it is sold|it sold|not anymore|no longer|not any more|no i do not|no i dont|i do not|no i am not|not really|do not own it|sold it|i sold it|already sold|sold already|wrong number|wrong house|wrong property|never owned it|never owned|not mine|not my house|ya no|no ya no|không|không phải|khong|khong phai|ko phải|ko phai|não|nao)';

// ABSENCE OF A VALUE IS NOT DISINTEREST. "No I don't have one" answering "do you
// have an asking price in mind?" says the seller has no number yet -- they are
// still fully in the conversation. Before this, it matched the generic bare-no
// fallback, classified not_interested@0.92 and deferred the seller 30 days.
// Live case 2026-09-10, +13058426269, where the operator had to drive the thread
// by hand because the machine had written the seller off.
//
// Deliberately separate from NEGATIVE_TOKENS: these phrases answer a FACT
// question. Nobody replies "I don't have one" to "are you interested in
// selling?", so widening the disinterest tokens instead would have been wrong.
const NO_VALUE_TOKENS =
  "(?:no i do not have one|i do not have one|do not have one|no i do not have a number|" +
  "i do not have a number|do not have a number|no number in mind|no price in mind|" +
  "nothing in mind|no set price|no asking price|i do not have a price|do not have a price|" +
  "no i have not|i have not thought about it|have not thought about it|" +
  "i do not know yet|do not know yet|not yet|no idea|i have no idea|no not really)";

// Negative tokens that EXPLICITLY disown the property: not a bare "no".
const EXPLICIT_DISOWN_RE =
  /^(?:wrong number|wrong house|wrong property|not mine|not my house|never owned(?: it)?|do not own it|sold it|i sold it|already sold|sold already)$/u;
// round 9: "No I never did sorry" to "Are you still the owner?" -- they never
// owned it: a non-owner, closed (owner rule). "Sold 💯" -- a former owner.
export const NEVER_OWNED_LONG_RE = /^(?:no+[\s,.!]*)?(?:i\s+)?(?:have\s+)?never\s+(?:have|did|owned(?:\s+(?:it|that|this|that\s+(?:house|property|home|place)|the\s+(?:house|property|home|place)))?|have\s+owned(?:\s+(?:it|that|this))?)(?:\s+(?:sorry|lol|bro|sir|ma'?am))?[\s.!]*$/iu;
const NEVER_OWNED_RE = /^(?:no i never did|i never did|never did|no never|no i never owned it|no i never have|never have)$/u;
const BARE_SOLD_RE = /^(?:sold|it is sold|it sold)$/u;

/** Normalizes punctuation, contractions and spacing before token matching. */
function normalizeShortReply(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\bcan't\b/g, 'can not')
    .replace(/\bdon't\b/g, 'do not')
    .replace(/\bdont\b/g, 'do not')
    .replace(/\bdoesnt\b/g, 'does not')
    .replace(/\bdidnt\b/g, 'did not')
    .replace(/\bdoesn't\b/g, 'does not')
    .replace(/\bdidn't\b/g, 'did not')
    .replace(/\bit's\b/g, 'it is')
    .replace(/\bthat's\b/g, 'that is')
    .replace(/\bi'm\b/g, 'i am')
    .replace(/\bim\b/g, 'i am')
    // "Hello, yes this is she." (2026-10-06): a greeting in front of the answer.
    .replace(/^(?:hello|hi|hey|hola|ola|good\s+(?:morning|afternoon|evening))[\s,.!]+(?=\S)/, '')
    // round 9: a trailing apology carries no answer ("No I never did sorry").
    // "No thanks" keeps its decline meaning.
    .replace(/[\s,.!]+sorry[\s.!]*$/u, '')
    // Internal punctuation, not just trailing: "No, I don't" normalized to
    // "no, i do not" and matched no token, so a comma was enough to make a
    // seller's answer unreadable. No token contains punctuation.
    .replace(/[.!?,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Bare denials of "do you own / are you the owner / is it yours?". Hedges
// ("not really") stay in the clarification rule below.
// round 9 (2026-10-07 live, all held in New Replies): "No, I'm not", "No not
// at all", "No and no", "Of Course Not", "Noo" answer the ownership question
// exactly like "No".
const BARE_NO_RE = /^(?:no+|nope|nah|nel|no i do not|no i dont|i do not|no i am not|no no|no no no|no and no|no not at all|not at all|of course not|absolutely not|hell no|no sir|no ma'am|no maam|não|nao|không|khong)$/u;
export { BARE_NO_RE };
const NO_LONGER_OWNER_RE = /^(?:not anymore|no longer|not any more|ya no|no ya no)$/u;

// OWNER DECISION 2026-10-14 (RC 8.5.15; supersedes 2026-10-13 and 2026-10-06).
// A bare "No" means what it answers:
//  - to the S1 OWNERSHIP question ("Do you still own 1 Main St?") it DENIES
//    ownership. Ownership is now unverified for this recipient x property:
//    record it, stop property-specific outreach to this recipient for this
//    property pending verification, schedule NO nurture, ask NO further
//    ownership question, and never treat them as a qualified seller. The phone
//    is never suppressed globally (their other properties stay contactable);
//    only an explicit stop/opt-out suppresses.
//    (rule ctx_bare_no_after_ownership_check_ownership_unverified ->
//    primary_intent property_specific_non_owner, labels ownership_denied +
//    ownership_unverified; the existing property-scoped non-owner lane.)
//  - to the S2 "would you consider selling" question it is disinterest: the
//    EXISTING 30-day nurture (owner decision 2026-10-14, locked).
//  - to the condition question it reports no repairs (ctx_no_after_condition_no_repairs).
//  - to "can we check back / contact you again" it ends outreach in that scope
//    (ctx_no_after_contact_permission).
// 8.5.13 had made the S1 bare "No" a not_interested 30-day nurture (rule
// ctx_bare_no_after_ownership_check_not_interested); that is now the explicit
// 'not_interested' mode only. A polite decline ("No thanks", "No gracias
// Carlos!") to the ownership question still reads as a decline (not a denial)
// in every mode: it answers a sales approach, not the ownership fact.
// LC_BARE_NO_OWNERSHIP_MODE: ownership_unverified (default) | not_interested |
// clarify | non_owner (wrong_number lane, owner-scoped).
export const BARE_NO_OWNERSHIP_MODES = Object.freeze(['ownership_unverified', 'not_interested', 'clarify', 'non_owner']);
export const DEFAULT_BARE_NO_OWNERSHIP_MODE = 'ownership_unverified';
export function bareNoOwnershipMode() {
  const raw = String(process.env.LC_BARE_NO_OWNERSHIP_MODE ?? '').trim().toLowerCase();
  if (raw === 'non_owner') return 'non_owner';
  if (raw === 'clarify') return 'clarify';
  if (raw === 'not_interested') return 'not_interested';
  return DEFAULT_BARE_NO_OWNERSHIP_MODE;
}

const POLITE_DECLINE_TAIL_RE = /(?:^|\s)(?:thanks|thank\s+you|thank\s+u|thx|ty|gracias)$/u;
const EMOJI_SENTIMENT_RE = /\p{Extended_Pictographic}/u;
const MARKET_VALUE_ANSWER_RE = /^(?:(?:no+|nope|not\s+really|not\s+yet)[\s,.!]+(?:but\s+|just\s+)?)?(?:(?:the\s+|fair\s+|current\s+)?market\s+(?:value|price|rate)|fmv|whatever\s+(?:it'?s|its|it\s+is)\s+worth|what(?:ever)?\s+it'?s\s+worth|(?:el\s+)?valor\s+(?:de\s+|del\s+)?mercado|precio\s+de\s+mercado)[\s.!]*$/iu;
const NO_SOMEONE_ELSE_OWNS_RE = /^\s*(?:no+|nope|nah)\b[\s,.!-]+(?:it\s+|that\s+)?(?:should\s+be|belongs\s+to|is\s+owned\s+by|owned\s+by|is\s+the\s+city|is\s+the\s+county)\b[^?]{0,80}$/iu;

// "Possibly" / "Maybe" (2026-10-06): to OUR proposal question it is an open
// door on price (latent_interest -> the price question); to anything else it
// binds nothing.
const MAYBE_TOKENS = '(?:possibly|maybe|perhaps|potentially|could be|might be|maybe so|tal vez|talvez|quizas|quizás|puede ser|a lo mejor)';

/** The S1 ownership-denied / unverified result (RC 8.5.15; see bareNoOwnershipMode). */
function ownershipUnverifiedResult(messageText, validated, rule_id) {
  return {
    applied: true,
    primary_intent: 'property_specific_non_owner',
    labels: ['ownership_denied', 'ownership_unverified', 'bare_negative_to_ownership_question'],
    rule_id,
    confidence: 0.86,
    rationale: 'bare_no_to_ownership_question_denies_ownership_unverified_for_this_property',
    evidence_span: String(messageText).trim(),
    context_message_id: validated.context.last_outbound_message_id,
    context_use_case: validated.context.last_outbound_use_case,
    context_age_ms: validated.context.context_age_ms,
  };
}


// rc-8.5.21: engaged replies to the proposal question, and a greeting in front of a short answer
const LISTENING_RE = /^(?:(?:ok(?:ay)?|sure|yes|yeah|go\s+ahead)[\s,.!]+)?(?:i'?m\s+(?:listening|all\s+ears)|im\s+(?:listening|all\s+ears)|listening|all\s+ears|go\s+ahead|tell\s+me\s+more|let'?s\s+hear\s+it|i'?m\s+open|im\s+open|open\s+to\s+it)[\s.!?]*$/iu;
const AMOUNT_QUESTION_RE = /^(?:(?:ok(?:ay)?|sure|yes|yeah|maybe|well)[\s,.!]+)?(?:what\s+(?:amount|number|figure|price|offer)(?:\s+(?:are\s+you|r\s+u|would\s+you|you)\s+(?:thinking|offering|willing\s+to\s+pay))?|what'?s\s+(?:the|your)\s+(?:amount|number|figure|offer)|what\s+(?:are|r)\s+(?:you|u)\s+(?:offering|thinking)|how\s+much\s+(?:are\s+you|r\s+u|would\s+you)\s+(?:offering|thinking|pay|give))[\s.!?]*$/iu;
const GREETING_PREFIX_RE = /^\s*(?:hi|hey|hello|hiya|howdy|good\s+(?:morning|afternoon|evening)|hola|buenos\s+d[ií]as|buenas(?:\s+tardes)?)\b[\s,.!-]*/iu;
export function stripGreetingPrefix(text, names = []) {
  let t = String(text ?? '').trim();
  if (!GREETING_PREFIX_RE.test(t)) return t;
  t = t.replace(GREETING_PREFIX_RE, '');
  for (const n of names) {
    const first = String(n || '').trim().split(/\s+/)[0];
    if (first && first.length >= 2) t = t.replace(new RegExp(`^${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[\\s,.!-]*`, 'iu'), '');
  }
  // any single capitalised token right after the greeting is an addressee ("Hi Jake. Yes")
  t = t.replace(/^(?!(?:Yes|Yeah|Yep|Yup|No|Nope|Nah|Not|Never|Sure|Si|Correct|Ok|Okay|I|Im|It|Its|That|This|We|Maybe)\b)[A-Z][a-z]{1,15}\b[\s,.!-]+(?=\S)/u, '');
  return t.trim();
}

export function isShortContextualReply(text) {
  const t = normalizeShortReply(text);
  if (!t || t.length > 48) return false;
  return (
    new RegExp(`^${MAYBE_TOKENS}$`, 'u').test(t) ||
    new RegExp(`^${AFFIRMATIVE_TOKENS}$`, 'u').test(t) ||
    new RegExp(`^${NEGATIVE_TOKENS}$`, 'u').test(t) ||
    new RegExp(`^${NO_VALUE_TOKENS}$`, 'u').test(t)
  );
}

/**
 * Apply validated context to short yes/no (and similar) replies.
 * @returns {{ applied: boolean, primary_intent?: string, labels?: string[], rule_id?: string, force_unclear?: boolean, confidence?: number, rationale?: string }}
 */
export function applyContextualShortReply(messageText, validated) {
  if (!validated || validated.context_status !== 'valid' || !validated.context) {
    return { applied: false };
  }
  // A bare negative to the S1 ownership question (see bareNoOwnershipMode).
  // Checked before the short-reply gate so a sign-off name ("No gracias
  // Carlos!") cannot hide it.
  {
    const uc = validated.context.last_outbound_use_case;
    const qt = validated.context.last_outbound_question_type;
    const mode = bareNoOwnershipMode();
    if ((uc === 'ownership_check' || qt === 'ownership') && (mode === 'not_interested' || mode === 'ownership_unverified')) {
      const bare = matchBareNegative(messageText, {
        names: [validated.context.last_outbound_agent, validated.context.last_outbound_addressee].filter(Boolean),
      });
      // A thumbs-down / emoji carries sentiment ("No 👎"): a decline, not a denial.
      const polite = Boolean(bare && (POLITE_DECLINE_TAIL_RE.test(bare.canonical) || EMOJI_SENTIMENT_RE.test(String(messageText))));
      // rc-8.5.21 (owner P0 2026-10-16, investigator spec d): ANY bare negative answering OUR
      // ownership question — polite ("No thanks") or with an emoji — is a PROPERTY-SCOPED ownership
      // denial; not_interested only when the previous question was S2 or later.
      if (bare && mode === 'ownership_unverified') {
        return ownershipUnverifiedResult(messageText, validated, polite ? 'ctx_polite_no_after_ownership_check_ownership_unverified' : 'ctx_bare_no_after_ownership_check_ownership_unverified');
      }
      // "Nope should be the city of Jennings" (eval #131): a "No" that names
      // someone else as the owner. A phone number in it is a referral -- not here.
      if (!bare && mode === 'ownership_unverified' && NO_SOMEONE_ELSE_OWNS_RE.test(String(messageText)) && !/\d{3}/.test(String(messageText))) {
        return ownershipUnverifiedResult(messageText, validated, 'ctx_no_someone_else_owns_after_ownership_check');
      }
      if (bare) {
        return {
          applied: true,
          primary_intent: 'not_interested',
          labels: ['not_interested', 'bare_negative_to_ownership_question'],
          rule_id: polite && mode === 'ownership_unverified'
            ? 'ctx_polite_no_after_ownership_check_not_interested'
            : 'ctx_bare_no_after_ownership_check_not_interested',
          confidence: 0.88,
          rationale: 'bare_negative_without_ownership_denial_to_ownership_question_is_a_decline',
          evidence_span: String(messageText).trim(),
          context_message_id: validated.context.last_outbound_message_id,
          context_use_case: uc,
          context_age_ms: validated.context.context_age_ms,
        };
      }
    }
  }
  // RC 8.5.15: a bare / polite negative ("No", "No. Thank you", "Nope thanks")
  // to the S2 interest question is a decline of THAT question -- the same rule
  // as a short "No" (ctx_no_after_proposal_interest): the 30-day nurture.
  // A "Sold" stays with the sold detector.
  {
    const uc = validated.context.last_outbound_use_case;
    if (uc === 'proposal_interest' || uc === 'proposal_request') {
      const bare = matchBareNegative(messageText, {
        names: [validated.context.last_outbound_agent, validated.context.last_outbound_addressee].filter(Boolean),
      });
      if (bare) {
        return {
          applied: true,
          primary_intent: 'not_interested',
          labels: ['not_interested', 'declined_s2_interest_question'],
          rule_id: 'ctx_no_after_proposal_interest',
          confidence: 0.88,
          rationale: 'bare_negative_bound_to_proposal_interest_question',
          evidence_span: String(messageText).trim(),
          context_message_id: validated.context.last_outbound_message_id,
          context_use_case: uc,
          context_age_ms: validated.context.context_age_ms,
        };
      }
    }
  }
  // RC 8.5.15 (eval #20): "market value" / "No but market value" / "whatever
  // it's worth" to OUR asking-price question names no number: an absent value
  // (the flow advances to condition), never latent interest that re-asks price.
  {
    const uc = validated.context.last_outbound_use_case;
    const qt = validated.context.last_outbound_question_type;
    if ((uc === 'asking_price' || qt === 'asking_price') && MARKET_VALUE_ANSWER_RE.test(String(messageText).trim())) {
      return {
        applied: true,
        primary_intent: 'asking_price_absent',
        labels: ['asking_price_absent', 'asking_price_market_value'],
        rule_id: 'ctx_market_value_after_asking_price',
        confidence: 0.86,
        rationale: 'market_value_names_no_number_after_asking_price_question',
        evidence_span: String(messageText).trim(),
        context_message_id: validated.context.last_outbound_message_id,
        context_use_case: uc,
        context_age_ms: validated.context.context_age_ms,
      };
    }
  }
  // 2026-10-13: "You tell me" to OUR asking-price question turns it back on
  // us -- an offer request (asks_offer), never a price and never unclear.
  {
    const uc = validated.context.last_outbound_use_case;
    const qt = validated.context.last_outbound_question_type;
    if ((uc === 'asking_price' || qt === 'asking_price') && matchOfferDeflection(messageText)) {
      return {
        applied: true,
        primary_intent: 'asks_offer',
        labels: ['asks_offer', 'offer_deflection_to_asking_price_question'],
        rule_id: 'ctx_offer_deflection_after_asking_price',
        confidence: 0.86,
        rationale: 'seller_turned_our_asking_price_question_back_as_an_offer_request',
        evidence_span: String(messageText).trim(),
        context_message_id: validated.context.last_outbound_message_id,
        context_use_case: uc,
        context_age_ms: validated.context.context_age_ms,
      };
    }
  }
  // rc-8.5.21 (opportunity desk 2026-10-16): engaged replies to OUR interest question were tagged
  // `unclear` ("I'm listening", "What amount ?"): read against the question they answer.
  {
    const uc = validated.context.last_outbound_use_case;
    const qt = validated.context.last_outbound_question_type;
    if (uc === 'proposal_interest' || uc === 'proposal_request' || qt === 'proposal_interest') {
      const body = String(messageText).trim()
      const ctxBase = { evidence_span: body, context_message_id: validated.context.last_outbound_message_id, context_use_case: uc, context_age_ms: validated.context.context_age_ms }
      if (AMOUNT_QUESTION_RE.test(body)) {
        return { applied: true, primary_intent: 'asks_offer', labels: ['asks_offer', 'amount_question_after_proposal_interest'], rule_id: 'ctx_amount_question_after_proposal_interest', confidence: 0.86, rationale: 'seller_asks_our_number_in_answer_to_the_proposal_question', ...ctxBase }
      }
      if (LISTENING_RE.test(body)) {
        return { applied: true, primary_intent: 'interested', labels: ['interested', 'listening_after_proposal_interest'], rule_id: 'ctx_listening_after_proposal_interest', confidence: 0.86, rationale: 'seller_invites_the_proposal_in_answer_to_the_proposal_question', ...ctxBase }
      }
    }
  }
  // rc-8.5.21: "No never have" / "never owned it" / "I have never owned that" to OUR ownership
  // question: never owned — the property-scoped denial (never `unclear`, never a phone suppression)
  {
    const uc = validated.context.last_outbound_use_case;
    const qt = validated.context.last_outbound_question_type;
    if ((uc === 'ownership_check' || qt === 'ownership') && NEVER_OWNED_LONG_RE.test(String(messageText).trim())) {
      const r = ownershipUnverifiedResult(messageText, validated, 'ctx_never_owned_after_ownership_check');
      return { ...r, labels: [...r.labels, 'never_owned'], confidence: 0.9 };
    }
  }
  // rc-8.5.21: a greeting / our persona's name in front of a short answer ("Hi Jake. Yes",
  // "Hello, no") answers the same question as the bare answer: strip it and read the rest.
  {
    const names = [validated.context.last_outbound_agent, validated.context.last_outbound_addressee].filter(Boolean)
    const stripped = stripGreetingPrefix(messageText, names)
    if (stripped && stripped !== String(messageText).trim()) {
      const r = applyContextualShortReply(stripped, validated)
      if (r?.applied) return { ...r, rule_id: `${r.rule_id}_after_greeting`, evidence_span: String(messageText).trim() }
    }
  }
  if (!isShortContextualReply(messageText)) {
    return { applied: false };
  }

  const t = normalizeShortReply(messageText);
  const isYes = new RegExp(`^${AFFIRMATIVE_TOKENS}$`, 'u').test(t);
  const isNo = new RegExp(`^${NEGATIVE_TOKENS}$`, 'u').test(t);
  const isNoValue = new RegExp(`^${NO_VALUE_TOKENS}$`, 'u').test(t);
  const isMaybe = new RegExp(`^${MAYBE_TOKENS}$`, 'u').test(t);
  if (!isYes && !isNo && !isNoValue && !isMaybe) return { applied: false };
  if (isMaybe) {
    const uc = validated.context.last_outbound_use_case;
    if (uc === 'proposal_interest' || uc === 'proposal_request') {
      return {
        applied: true,
        primary_intent: 'latent_interest',
        labels: ['latent_interest', 'proposal_interest_maybe'],
        rule_id: 'ctx_maybe_after_proposal_interest',
        confidence: 0.85,
        rationale: 'maybe_bound_to_validated_proposal_question',
        evidence_span: String(messageText).trim(),
        context_message_id: validated.context.last_outbound_message_id,
        context_use_case: uc,
        context_age_ms: validated.context.context_age_ms,
      };
    }
    return { applied: false };
  }

  const useCase = validated.context.last_outbound_use_case;
  const qType = validated.context.last_outbound_question_type;
  const base = {
    context_message_id: validated.context.last_outbound_message_id,
    context_use_case: useCase,
    context_age_ms: validated.context.context_age_ms,
  };

  if (isYes) {
    if (useCase === 'ownership_check' || qType === 'ownership') {
      return {
        applied: true,
        primary_intent: 'ownership_confirmed',
        labels: ['owner_confirmed'],
        rule_id: 'ctx_yes_after_ownership_check',
        confidence: 0.88,
        rationale: 'short_yes_bound_to_validated_ownership_question',
        evidence_span: String(messageText).trim(),
        ...base,
      };
    }
    if (useCase === 'proposal_interest' || useCase === 'proposal_request' || qType === 'proposal_interest') {
      return {
        applied: true,
        primary_intent: 'interested',
        labels: ['interested', 'proposal_interest_confirmed'],
        rule_id: 'ctx_yes_after_proposal_interest',
        confidence: 0.86,
        rationale: 'short_yes_bound_to_validated_proposal_interest_question',
        evidence_span: String(messageText).trim(),
        ...base,
      };
    }
    if (useCase === 'asking_price' || qType === 'asking_price') {
      return {
        applied: true,
        primary_intent: 'unclear',
        labels: [],
        rule_id: 'ctx_yes_after_asking_price',
        force_unclear: true,
        confidence: 0.55,
        rationale: 'short_yes_after_asking_price_is_not_ownership_or_price; needs_clarification',
        evidence_span: String(messageText).trim(),
        human_review: true,
        ...base,
      };
    }
    if (useCase === 'contact_permission' || qType === 'contact_permission') {
      // RC 8.5.15: "Yes" to "is it alright if I check back?" grants a later
      // check-in; it never confirms ownership or interest. A person decides
      // (the same review outcome as before this question had a context).
      return {
        applied: true,
        primary_intent: 'unclear',
        labels: ['contact_permission_granted'],
        rule_id: 'ctx_yes_after_contact_permission',
        force_unclear: true,
        confidence: 0.6,
        rationale: 'short_yes_to_permission_to_contact_again_is_not_ownership_or_interest',
        evidence_span: String(messageText).trim(),
        human_review: true,
        ...base,
      };
    }
    if (useCase === 'condition_check' || qType === 'condition') {
      return {
        applied: true,
        primary_intent: 'unclear',
        labels: ['unclear_condition_acknowledgement'],
        rule_id: 'ctx_yes_after_condition',
        force_unclear: true,
        confidence: 0.55,
        rationale: 'short_yes_after_condition_question',
        evidence_span: String(messageText).trim(),
        human_review: true,
        ...base,
      };
    }
  }

  if (isNo) {
    if ((useCase === 'ownership_check' || qType === 'ownership') && NEVER_OWNED_RE.test(t)) {
      // RC 8.5.15 (owner 2026-10-14): "No I never did" is a written ownership
      // denial -- property-scoped, never a wrong-number suppression.
      const r = ownershipUnverifiedResult(messageText, validated, 'ctx_never_owned_after_ownership_check');
      return { ...r, labels: [...r.labels, 'never_owned'], confidence: 0.9 };
    }
    if ((useCase === 'ownership_check' || qType === 'ownership') && BARE_SOLD_RE.test(t)) {
      return {
        applied: true,
        primary_intent: 'sold_property',
        labels: ['ownership_denied', 'no_longer_owner'],
        rule_id: 'ctx_sold_after_ownership_check',
        confidence: 0.9,
        rationale: 'bare_sold_bound_to_validated_ownership_question',
        evidence_span: String(messageText).trim(),
        ...base,
      };
    }
    if ((useCase === 'ownership_check' || qType === 'ownership') && EXPLICIT_DISOWN_RE.test(t)) {
      // "Wrong number" / "Not mine" / "I sold it" / "Never owned it" ANSWER the
      // ownership question explicitly. Binding them to the clarification rule
      // below held every explicit denial as `unclear` whenever the live path had
      // built the context (2026-10-01: they sat in New Replies). Unbound, the
      // classifier's own wrong-number / sold detectors decide.
      return { applied: false };
    }
    if ((useCase === 'ownership_check' || qType === 'ownership') && ['non_owner', 'ownership_unverified'].includes(bareNoOwnershipMode()) && NO_LONGER_OWNER_RE.test(t)) {
      // "Not anymore" / "No longer" / "Ya no" answer "do you STILL own it?":
      // they owned it and do not now. Sold, not a wrong person.
      return {
        applied: true,
        primary_intent: 'sold_property',
        labels: ['ownership_denied', 'no_longer_owner'],
        rule_id: 'ctx_no_longer_after_ownership_check',
        confidence: 0.86,
        rationale: 'not_anymore_bound_to_validated_ownership_question',
        evidence_span: String(messageText).trim(),
        ...base,
      };
    }
    if ((useCase === 'ownership_check' || qType === 'ownership') && bareNoOwnershipMode() === 'ownership_unverified' && BARE_NO_RE.test(t)) {
      // "No I don't" / "No I'm not" / "Of course not": an ownership denial
      // with denial words -- the same unverified-ownership lane as a bare "No".
      return ownershipUnverifiedResult(messageText, validated, 'ctx_no_after_ownership_check_ownership_unverified');
    }
    if ((useCase === 'ownership_check' || qType === 'ownership') && bareNoOwnershipMode() === 'non_owner' && BARE_NO_RE.test(t)) {
      // 2026-10-05 (+18328600523 "Is 2114 Mulberry Ln yours?" -> "No";
      // +12818516193 "do you own 23227 Briarcreek Blvd?" -> "No"): a bare no to
      // the ownership question answers it -- this person is not the owner.
      // Routed as the non-owner / wrong-person lane, exactly like "Not mine".
      return {
        applied: true,
        primary_intent: 'wrong_number',
        labels: ['ownership_denied', 'non_owner'],
        rule_id: 'ctx_no_after_ownership_check_non_owner',
        confidence: 0.86,
        rationale: 'bare_no_bound_to_validated_ownership_question',
        evidence_span: String(messageText).trim(),
        ...base,
      };
    }
    if (useCase === 'ownership_check' || qType === 'ownership') {
      return {
        applied: true,
        primary_intent: 'unclear',
        labels: ['ownership_denial_needs_clarification'],
        rule_id: 'ctx_no_after_ownership_check',
        force_unclear: true,
        confidence: 0.6,
        rationale: 'short_no_after_ownership_requires_relation_evidence_unless_explicit',
        evidence_span: String(messageText).trim(),
        human_review: true,
        ...base,
      };
    }
    // Round 11 (2026-10-09): "Sold" / "It's SOLD" to our interest question is
    // a property transfer, not a decline -- the classifier's sold detector
    // decides (it did before operator interest questions bound a context).
    if ((useCase === 'proposal_interest' || useCase === 'proposal_request') && BARE_SOLD_RE.test(t)) {
      return { applied: false };
    }
    if (useCase === 'proposal_interest' || useCase === 'proposal_request') {
      return {
        applied: true,
        primary_intent: 'not_interested',
        // A "No" to S2 is disinterest: the existing 30-day nurture (owner
        // decision 2026-10-14, locked).
        labels: ['not_interested', 'declined_s2_interest_question'],
        rule_id: 'ctx_no_after_proposal_interest',
        confidence: 0.88,
        rationale: 'short_no_bound_to_proposal_interest_question',
        evidence_span: String(messageText).trim(),
        ...base,
      };
    }
    if (useCase === 'contact_permission' || qType === 'contact_permission') {
      // RC 8.5.15: "No" to "is it alright if I check back down the road?" ends
      // outreach in that scope (this recipient x property): never another
      // automatic check-in. Not an opt-out -- the phone is not suppressed.
      return {
        applied: true,
        primary_intent: 'not_interested',
        labels: ['not_interested', 'contact_permission_declined'],
        rule_id: 'ctx_no_after_contact_permission',
        confidence: 0.88,
        rationale: 'no_to_permission_to_contact_again_ends_outreach_in_scope',
        evidence_span: String(messageText).trim(),
        ...base,
      };
    }
    if (useCase === 'asking_price' || qType === 'asking_price') {
      // The seller has no number YET. That is a fact about the deal, not a
      // decision about us: the flow should advance and come back to price with a
      // real basis. This previously forced unclear + human_review, which in
      // production meant silence.
      return {
        applied: true,
        primary_intent: 'asking_price_absent',
        labels: ['asking_price_absent'],
        rule_id: 'ctx_no_after_asking_price',
        confidence: 0.86,
        rationale: 'no_price_in_mind_is_an_absent_value_not_disinterest',
        evidence_span: String(messageText).trim(),
        ...base,
      };
    }
    if (useCase === 'rent_check' || qType === 'rent') {
      return {
        applied: true,
        primary_intent: 'unclear',
        labels: ['rent_unknown'],
        rule_id: 'ctx_no_after_rent',
        force_unclear: true,
        confidence: 0.6,
        rationale: 'no_after_rent_question_is_missing_rent_data_not_disinterest',
        evidence_span: String(messageText).trim(),
        ...base,
      };
    }
    if (useCase === 'timeline_check' || qType === 'timeline' ||
        useCase === 'motivation_check' || qType === 'motivation' ||
        useCase === 'occupancy_check' || qType === 'occupancy') {
      // Same class of error as condition: a negative answering a FACT question
      // is information, never a decision to stop talking to us.
      return {
        applied: true,
        primary_intent: 'unclear',
        labels: ['fact_question_negative'],
        rule_id: 'ctx_no_after_fact_question',
        force_unclear: true,
        confidence: 0.6,
        rationale: 'negative_answer_to_a_fact_question_is_information_not_disinterest',
        evidence_span: String(messageText).trim(),
        ...base,
      };
    }
    if (useCase === 'condition_check' || qType === 'condition') {
      // "No" answering "does it need repairs? / anything major it needs?" is
      // CONDITION information: no repairs reported -- never disinterest
      // (the old bare-no fallback shelved good-condition sellers for 30 days).
      // RC 8.5.15: it is the same fact as "No repairs needed"
      // (condition_disclosed), so the workflow continues exactly as it does
      // for that reply -- only if the workflow calls for a next step.
      return {
        applied: true,
        primary_intent: 'condition_disclosed',
        labels: ['condition_disclosed', 'no_repairs_reported'],
        rule_id: 'ctx_no_after_condition_no_repairs',
        confidence: 0.86,
        rationale: 'short_no_after_condition_question_reports_no_repairs',
        evidence_span: String(messageText).trim(),
        ...base,
      };
    }
  }

  // "I don't have one" / "no number in mind" -- an ABSENT VALUE. Bound strictly
  // to the question that produced it. Never disinterest, and never reached for a
  // proposal-interest question, where the phrasing would not occur anyway.
  if (isNoValue) {
    if (useCase === 'asking_price' || qType === 'asking_price') {
      return {
        applied: true,
        primary_intent: 'asking_price_absent',
        labels: ['asking_price_absent'],
        rule_id: 'ctx_no_value_after_asking_price',
        confidence: 0.88,
        rationale: 'seller_has_no_price_in_mind_yet_and_remains_active',
        evidence_span: String(messageText).trim(),
        ...base,
      };
    }
    if (useCase === 'rent_check' || qType === 'rent') {
      return {
        applied: true,
        primary_intent: 'unclear',
        labels: ['rent_unknown'],
        rule_id: 'ctx_no_value_after_rent',
        force_unclear: true,
        confidence: 0.6,
        rationale: 'seller_does_not_know_the_rents_yet',
        evidence_span: String(messageText).trim(),
        ...base,
      };
    }
    return {
      applied: true,
      primary_intent: 'unclear',
      labels: ['value_absent'],
      rule_id: 'ctx_no_value_generic',
      force_unclear: true,
      confidence: 0.6,
      rationale: 'absent_value_answer_is_not_disinterest',
      evidence_span: String(messageText).trim(),
      ...base,
    };
  }


  return { applied: false };
}
