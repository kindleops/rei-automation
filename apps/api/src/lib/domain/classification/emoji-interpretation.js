/**
 * EMOJI / REACTION INTERPRETATION — layer 3 of the inbound classifier (7.2).
 *
 * Owner rule (2026-10-01): "PRESERVE THE SIGNAL. UNDERSTAND THE CONTEXT. ASK
 * WHEN UNCERTAIN." An emoji or a tapback is a real seller action. It is never
 * discarded as noise, and it is never promoted to a fact it does not carry.
 *
 * What it reads (all deterministic, no model call, no I/O):
 *   - the emoji themselves, standalone or beside text, every one of them;
 *   - a platform reaction relayed as text and the message it points at;
 *   - the question WE asked last (validated conversation context) and the
 *     seller's lifecycle stage.
 *
 * What it produces is an INTERPRETATION, kept separate from facts:
 *   sentiment            how the seller feels
 *   semantic_signal      what the gesture most likely means in this turn
 *   factual_commitment   LIKELY at most for an emoji. Never CONFIRMED.
 *   clarification        the ONE short question that turns LIKELY into a fact,
 *                        named by an sms_templates use case (the copy lives
 *                        in sms_templates, never here).
 *
 * HOW TEXTGRID DELIVERS REACTIONS (audited on production message_events,
 * 2026-10-01): as ordinary SMS text, with no provider reaction metadata.
 *   Android / Google Messages  "​👍​ to “ <quoted message> ”"
 *   iOS                        "Questioned “<quoted message>”", "Liked “…”"
 * Seven such inbound rows exist (Apr–May 2026). The quoted text is OUR
 * message; reading its words as the seller's ("owner", "I am", "yours") is how
 * a thumbs-up became ownership_confirmed@0.90.
 *
 * NEVER from an emoji alone: ownership confirmed, an asking price, offer
 * acceptance, contract authority, legal consent, DNC reversal. Compliance
 * (STOP / DNC) runs BEFORE this layer in classify.js and nothing here can
 * override it: "Stop texting me 👍" is an opt-out.
 */

import { deriveUseCaseFromBody } from "./build-conversation-context.js";

export const EMOJI_INTERPRETATION_VERSION = "emoji_interpretation_v1";

/** Factual commitment states (shared with the text classifier). */
export const FACTUAL_COMMITMENT = Object.freeze({
  CONFIRMED: "CONFIRMED",
  LIKELY: "LIKELY",
  AMBIGUOUS: "AMBIGUOUS",
  NON_LITERAL: "NON_LITERAL",
  CONTRADICTED: "CONTRADICTED",
  UNKNOWN: "UNKNOWN",
});

/** sms_templates use cases for the emoji confirmation questions (7.2 copy). */
export const EMOJI_CLARIFICATION_USE_CASES = Object.freeze({
  confirm_ownership: "emoji_confirm_ownership",
  confirm_offer_interest: "emoji_confirm_offer_interest",
  confirm_not_interested: "emoji_confirm_not_interested",
});

const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;
const SKIN_TONE_RE = /[\u{1F3FB}-\u{1F3FF}]/gu;
const VARIATION_RE = /️/g;

const FAMILY_MEMBERS = Object.freeze({
  affirmative: ["👍", "✅", "👌", "🙌", "☑", "✔", "🆗", "💯"],
  negative: ["👎", "❌", "✖", "🚫", "⛔", "🙅"],
  // round 9: "👹" alone sat as unclear in New Replies (2026-10-07).
  hostile: ["🖕", "🤬", "😡", "👿", "😠", "💩", "👹", "👺"],
  laughter: ["😂", "🤣", "😆", "😹", "😅", "😝"],
  heart: ["❤", "💙", "💚", "💛", "💜", "🧡", "🤍", "🖤", "💕", "💖", "💗", "♥", "🙏", "😊", "☺", "🙂", "🥰", "😍", "🤗"],
  confusion: ["🤔", "❓", "❔", "😕", "🧐", "🤷", "😐", "😶"],
  money_house: ["💰", "💵", "💸", "🤑", "🏠", "🏡", "🏘", "🔑", "🏚"],
});

const FAMILY_BY_EMOJI = new Map();
for (const [family, list] of Object.entries(FAMILY_MEMBERS)) {
  for (const emoji of list) FAMILY_BY_EMOJI.set(emoji, family);
}

/** Platform reaction verbs (EN / ES / PT) → the emoji family they stand for. */
const REACTION_VERBS = Object.freeze([
  ["liked", "affirmative"],
  ["loved", "heart"],
  ["disliked", "negative"],
  ["laughed at", "laughter"],
  ["emphasized", "emphasis"],
  ["emphasised", "emphasis"],
  ["questioned", "confusion"],
  ["le gusto", "affirmative"],
  ["le encanto", "heart"],
  ["no le gusto", "negative"],
  ["se rio de", "laughter"],
  ["enfatizo", "emphasis"],
  ["cuestiono", "confusion"],
  ["curtiu", "affirmative"],
  ["amou", "heart"],
  ["nao curtiu", "negative"],
  ["riu de", "laughter"],
  ["enfatizou", "emphasis"],
  ["questionou", "confusion"],
]);

function normalize(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(ZERO_WIDTH_RE, "")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function fold(value) {
  return normalize(value).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const SEGMENTER = typeof Intl !== "undefined" && Intl.Segmenter
  ? new Intl.Segmenter("en", { granularity: "grapheme" })
  : null;

function graphemes(text) {
  if (SEGMENTER) return [...SEGMENTER.segment(text)].map((s) => s.segment);
  return Array.from(text);
}

/** Every emoji grapheme in order, skin tones and variation selectors folded. */
export function extractEmojis(message) {
  const text = normalize(message);
  const out = [];
  for (const g of graphemes(text)) {
    if (!/\p{Extended_Pictographic}/u.test(g)) continue;
    if (/^[©®™]$/.test(g)) continue;
    out.push(g.replace(SKIN_TONE_RE, "").replace(VARIATION_RE, ""));
  }
  return out;
}

export function emojiFamily(emoji) {
  const base = String(emoji ?? "").replace(SKIN_TONE_RE, "").replace(VARIATION_RE, "");
  if (FAMILY_BY_EMOJI.has(base)) return FAMILY_BY_EMOJI.get(base);
  const first = Array.from(base)[0];
  return FAMILY_BY_EMOJI.get(first) || "other";
}

/** Text with emoji, punctuation and whitespace removed: what the seller WROTE. */
export function textWithoutEmoji(message) {
  return graphemes(normalize(message))
    .filter((g) => !/\p{Extended_Pictographic}/u.test(g) && !/[\u{1F3FB}-\u{1F3FF}️‍]/u.test(g))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function hasWords(text) {
  return /[\p{L}\p{N}]/u.test(String(text || ""));
}

/**
 * A platform reaction relayed as SMS text.
 * Returns { verb, emoji, family, target_text } or null.
 */
export function parsePlatformReaction(message) {
  const raw = normalize(message);
  if (!raw.includes('"')) return null;

  // Android: `👍 to "…"` (zero-width spaces already stripped)
  const emojiMatch = /^((?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|️|‍)+)\s*to\s+"\s*([\s\S]*?)\s*"?\s*$/u.exec(raw);
  if (emojiMatch) {
    const emoji = extractEmojis(emojiMatch[1])[0] || emojiMatch[1];
    return { verb: null, emoji, family: emojiFamily(emoji), target_text: emojiMatch[2].replace(/"\s*$/, "").trim() };
  }
  // Retractions, BEFORE the add forms: `Removed 👍 from "…"` (Android /
  // Google Messages, zero-width joiners already stripped), `Removed a like
  // from "…"`, `Removed a question mark from "…"` (iOS). Live on
  // +18177347618 2026-10-05; the old pattern required "a"/"an" and missed the
  // emoji form, so each retraction was read as new, unclear seller text.
  const removedEmoji = /^removed\s+((?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|️|‍)+)\s+from\s+"\s*([\s\S]*?)\s*"?\s*$/iu.exec(raw);
  if (removedEmoji) {
    const emoji = extractEmojis(removedEmoji[1])[0] || removedEmoji[1];
    return { verb: "removed", emoji, family: "removed", removed_family: emojiFamily(emoji), target_text: removedEmoji[2].replace(/"\s*$/, "").trim() };
  }
  // `Reacted 👍 to "…"` / `Reacted with 👍 to "…"`
  const reacted = /^reacted\s+(?:with\s+)?(\S{1,16})\s+to\s+"\s*([\s\S]*?)\s*"?\s*$/iu.exec(raw);
  if (reacted) {
    const emoji = extractEmojis(reacted[1])[0] || reacted[1];
    return { verb: "reacted", emoji, family: emojiFamily(emoji), target_text: reacted[2].replace(/"\s*$/, "").trim() };
  }
  // iOS / localized verbs: `Liked "…"`
  const folded = fold(raw);
  for (const [verb, family] of REACTION_VERBS) {
    if (folded.startsWith(`${verb} "`)) {
      const start = raw.indexOf('"');
      const target = raw.slice(start + 1).replace(/"\s*$/, "").trim();
      return { verb, emoji: null, family, target_text: target };
    }
  }
  if (/^(?:removed\s+(?:an?\s+)?[^"]{1,24}?\s+from|(?:elimino|quito)\s+(?:un|el|una)?\s*[^"]{0,24}?\s*de)\s+"/.test(folded)) {
    return { verb: "removed", emoji: null, family: "removed", target_text: raw.slice(raw.indexOf('"') + 1).replace(/"\s*$/, "").trim() };
  }
  return null;
}

const ACKNOWLEDGEMENT_TARGET_RE =
  /\b(?:i'?ll|i will|we'?ll|will)\s+(?:follow up|check back|reach out|be in touch|get back|circle back|touch base|text you)\b|\b(?:sounds good|no problem|thanks|thank you|have a (?:good|great))\b/i;

/** What kind of message the reaction (or the emoji) answers. */
export function describeTargetMessage(text) {
  const body = normalize(text);
  if (!body) return { kind: "unknown", use_case: null, is_question: false };
  const is_question = /\?\s*(?:\p{Extended_Pictographic}|\s)*$/u.test(body) || /\?/.test(body);
  const use_case = deriveUseCaseFromBody(body);
  if (is_question || use_case) return { kind: "question", use_case, is_question: true };
  if (ACKNOWLEDGEMENT_TARGET_RE.test(body)) return { kind: "acknowledgement", use_case: null, is_question: false };
  return { kind: "statement", use_case: null, is_question: false };
}

/** Lifecycle stage → S-bucket used by the stage rules below. */
function stageBucket(stage) {
  const s = String(stage || "").toLowerCase();
  if (!s) return null;
  if (/(formal_contract|under_contract|prepared_to_close|contract|close|closing|disposition|negotiation)/.test(s)) return "S6";
  if (/(^offer$|offer_reveal|offer positioning|^s5|creative|counter)/.test(s)) return "S5";
  if (/(condition|occupancy|timeline|rents|units|expenses)/.test(s)) return "S4";
  if (/(asking_price|price)/.test(s)) return "S3";
  if (/(offer_interest|consider_selling|proposal)/.test(s)) return "S2";
  if (/(ownership|owner)/.test(s)) return "S1";
  return null;
}

function questionBucket(useCase) {
  switch (String(useCase || "")) {
    case "ownership_check": return "S1";
    case "proposal_interest":
    case "proposal_request": return "S2";
    case "asking_price": return "S3";
    case "condition_check":
    case "occupancy_check":
    case "rent_check":
    case "timeline_check":
    case "motivation_check": return "S4";
    default: return null;
  }
}

function combineFamilies(families) {
  const set = new Set(families);
  if (set.has("hostile")) return "hostile";
  if (set.has("laughter")) return "laughter";
  if (set.has("affirmative") && set.has("negative")) return "mixed";
  if (set.has("negative")) return "negative";
  if (set.has("affirmative")) return "affirmative";
  if (set.has("emphasis")) return "emphasis";
  if (set.has("confusion")) return "confusion";
  if (set.has("heart")) return "heart";
  if (set.has("money_house")) return "money_house";
  if (set.has("removed")) return "removed";
  return set.size ? "other" : null;
}

const SENTIMENT_BY_FAMILY = Object.freeze({
  affirmative: "positive",
  emphasis: "positive",
  negative: "negative",
  hostile: "hostile",
  laughter: "sarcastic",
  heart: "acknowledgment",
  confusion: "uncertain",
  money_house: "positive",
  mixed: "uncertain",
  removed: "neutral",
  other: "neutral",
});

const LAUGHTER_TEXT_RE = /\b(?:lol+|lmao+|lmfao|rofl|ha(?:ha)+|he(?:he)+|ja(?:ja)+|je(?:je)+|k{4,}|rsrs+|hihi+)\b/i;

/** Laughter in emoji OR text ("lol", "jajaja", "kkkk"). */
export function carriesLaughter(message) {
  const fams = extractEmojis(message).map(emojiFamily);
  return fams.includes("laughter") || LAUGHTER_TEXT_RE.test(fold(message));
}

/**
 * Interpret the emoji / reaction content of ONE inbound.
 *
 * @param {string} message
 * @param {object|null} context  VALIDATED conversation context (or null)
 * @returns {object|null}  null when the message has neither emoji nor a reaction
 */
export function interpretEmojiReply(message, context = null) {
  const reaction = parsePlatformReaction(message);
  let emojis = reaction ? (reaction.emoji ? [reaction.emoji] : []) : extractEmojis(message);
  // A typed "?" / "???" is the same gesture as ❓: confusion, keep it active.
  if (!reaction && emojis.length === 0 && /^\?+$/.test(normalize(message))) emojis = ["❓"];
  if (!reaction && emojis.length === 0) return null;

  const written = reaction ? "" : textWithoutEmoji(message);
  const emoji_only = !reaction && !hasWords(written);
  const families = reaction ? [reaction.family] : emojis.map(emojiFamily);
  const family = combineFamilies(families);

  // What was this an answer to? A reaction names its target; a typed emoji
  // answers our last question (validated context only, never guessed).
  const target = reaction ? describeTargetMessage(reaction.target_text) : null;
  const contextUseCase = context?.last_outbound_use_case || null;
  const answers_use_case = target ? target.use_case : contextUseCase;
  const answers_kind = target ? target.kind : (contextUseCase ? "question" : "unknown");
  const lifecycle_bucket = stageBucket(context?.canonical_stage);
  const bucket = lifecycle_bucket && ["S5", "S6"].includes(lifecycle_bucket)
    ? lifecycle_bucket
    : questionBucket(answers_use_case) || lifecycle_bucket;

  const out = {
    version: EMOJI_INTERPRETATION_VERSION,
    emoji_present: emojis.length > 0,
    emoji_only,
    emojis,
    families,
    family,
    reaction_type: reaction ? "platform_reaction" : emojis.length ? "typed_emoji" : null,
    reaction: reaction
      ? {
          verb: reaction.verb,
          emoji: reaction.emoji,
          target_text: reaction.target_text,
          target_kind: target.kind,
          target_use_case: target.use_case,
        }
      : null,
    answers: { kind: answers_kind, use_case: answers_use_case, stage_bucket: bucket },
    semantic_signal: "engagement",
    sentiment: SENTIMENT_BY_FAMILY[family] || "neutral",
    factual_commitment: FACTUAL_COMMITMENT.UNKNOWN,
    hostility: family === "hostile",
    sarcasm_likelihood: family === "laughter" ? 0.7 : 0,
    engagement_signal: true,
    requires_clarification: false,
    clarification: null,
    needs_review: false,
    confidence: 0.6,
    rule_id: null,
  };

  // Emoji beside real words: the words carry the meaning, the emoji only the
  // sentiment. "Yes 👍" is an explicit yes and must not be re-asked.
  if (!reaction && !emoji_only) {
    out.semantic_signal = family === "hostile" ? "hostile" : family === "laughter" ? "amusement" : "sentiment_only";
    out.rule_id = "emoji_with_text_sentiment_only";
    return out;
  }

  const setClarify = (strategy, signal, confidence) => {
    out.semantic_signal = signal;
    out.factual_commitment = FACTUAL_COMMITMENT.LIKELY;
    out.requires_clarification = true;
    out.clarification = {
      strategy,
      template_use_case: EMOJI_CLARIFICATION_USE_CASES[strategy] || null,
      stage: strategy === "confirm_ownership" ? "ownership_confirmation" : "offer_interest",
    };
    out.confidence = confidence;
  };

  switch (family) {
    case "hostile":
      out.semantic_signal = "hostile";
      out.engagement_signal = false;
      out.confidence = 0.9;
      out.rule_id = "emoji_hostile";
      return out;
    case "removed":
      out.semantic_signal = "acknowledgement";
      out.engagement_signal = false;
      out.confidence = 0.9;
      out.rule_id = "reaction_removed";
      return out;
    case "laughter":
      out.semantic_signal = "amusement";
      out.factual_commitment = ["S3", "S5", "S6"].includes(bucket) ? FACTUAL_COMMITMENT.NON_LITERAL : FACTUAL_COMMITMENT.UNKNOWN;
      out.needs_review = true;
      out.rule_id = ["S3", "S5", "S6"].includes(bucket) ? "emoji_laughter_after_price_non_literal" : "emoji_laughter";
      return out;
    case "heart":
      if (answers_kind === "acknowledgement" || answers_kind === "statement") {
        out.semantic_signal = "acknowledgement";
        out.engagement_signal = false;
        out.confidence = 0.85;
        out.rule_id = "emoji_gratitude_closes_turn";
      } else {
        out.semantic_signal = "acknowledgement";
        out.needs_review = answers_kind === "question";
        out.rule_id = "emoji_gratitude_open_question";
      }
      return out;
    case "confusion":
      out.semantic_signal = "confusion";
      out.needs_review = true;
      out.rule_id = "emoji_confusion_keep_active";
      return out;
    case "money_house":
      out.semantic_signal = "engagement";
      out.needs_review = true;
      out.rule_id = bucket === "S3" ? "emoji_money_not_a_price" : "emoji_money_engagement";
      return out;
    case "mixed":
    case "other":
      out.needs_review = true;
      out.rule_id = "emoji_unknown_meaning";
      return out;
    default:
      break;
  }

  // Affirmative / emphasis / negative: meaning depends on what we asked.
  if (answers_kind === "acknowledgement" || answers_kind === "statement") {
    // "Liked" on "I'll follow up next month": nothing is unresolved.
    out.semantic_signal = "acknowledgement";
    out.engagement_signal = false;
    out.confidence = 0.85;
    out.rule_id = "reaction_on_statement_closes_turn";
    return out;
  }
  if (answers_kind !== "question" || !bucket) {
    // We cannot tell what it answers: never invent a disposition.
    out.semantic_signal = family === "negative" ? "likely_negative" : "likely_affirmative";
    out.factual_commitment = FACTUAL_COMMITMENT.AMBIGUOUS;
    out.needs_review = true;
    out.rule_id = "emoji_without_question_context";
    return out;
  }

  if (family === "negative") {
    if (bucket === "S2" || bucket === "S5") {
      setClarify("confirm_not_interested", "likely_negative", 0.7);
      out.rule_id = "emoji_negative_after_offer_question";
      return out;
    }
    // 👎 to "are you the owner?": likely "no" -- a short ownership denial,
    // which the calibrated rule holds for a human.
    out.semantic_signal = "likely_negative";
    out.factual_commitment = FACTUAL_COMMITMENT.LIKELY;
    out.needs_review = true;
    out.rule_id = bucket === "S1" ? "emoji_negative_after_ownership_question" : "emoji_negative_after_fact_question";
    return out;
  }

  // affirmative / emphasis
  switch (bucket) {
    case "S1":
      setClarify("confirm_ownership", "likely_affirmative", 0.7);
      out.rule_id = "emoji_affirmative_after_ownership_question";
      return out;
    case "S2":
      setClarify("confirm_offer_interest", "likely_affirmative", 0.7);
      out.rule_id = "emoji_affirmative_after_offer_interest_question";
      return out;
    case "S3":
      out.semantic_signal = "acknowledgement";
      out.factual_commitment = FACTUAL_COMMITMENT.UNKNOWN;
      out.needs_review = true;
      out.rule_id = "emoji_affirmative_gives_no_price";
      return out;
    case "S4":
      out.semantic_signal = "acknowledgement";
      out.needs_review = true;
      out.rule_id = "emoji_affirmative_no_condition_fact";
      return out;
    case "S5":
      out.semantic_signal = "likely_affirmative";
      out.factual_commitment = FACTUAL_COMMITMENT.AMBIGUOUS;
      out.needs_review = true;
      out.rule_id = "emoji_affirmative_is_not_offer_acceptance";
      return out;
    case "S6":
      out.semantic_signal = "likely_affirmative";
      out.factual_commitment = FACTUAL_COMMITMENT.AMBIGUOUS;
      out.needs_review = true;
      out.rule_id = "emoji_never_contract_authority";
      return out;
    default:
      out.needs_review = true;
      out.rule_id = "emoji_unmapped_stage";
      return out;
  }
}

/**
 * One logical event per seller action: a reaction delivered twice (provider
 * metadata + its synthetic text, or a webhook replay) collapses to one key.
 */
export function reactionLogicalEventKey({ thread_key, message, received_at } = {}) {
  const reaction = parsePlatformReaction(message);
  if (!reaction) return null;
  const minute = (() => {
    const t = Date.parse(received_at || "");
    return Number.isFinite(t) ? Math.floor(t / 60000) : "na";
  })();
  const target = fold(reaction.target_text).replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  const gesture = reaction.emoji || reaction.verb || "reaction";
  return `reaction:${String(thread_key || "").trim()}:${gesture}:${target}:${minute}`;
}

/** Collapse duplicate reaction rows (same logical key) to the first one. */
export function collapseReactionDuplicates(events = []) {
  const seen = new Set();
  const out = [];
  for (const event of Array.isArray(events) ? events : []) {
    const key = reactionLogicalEventKey({
      thread_key: event?.thread_key,
      message: event?.message_body ?? event?.message,
      received_at: event?.received_at || event?.created_at,
    });
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(event);
  }
  return out;
}

/**
 * Link a reaction to the message it points at: the newest earlier outbound
 * whose text matches the quoted text (prefix-tolerant, punctuation-folded).
 */
export function linkReactionTarget(reactionMessage, events = [], { before = null } = {}) {
  const reaction = parsePlatformReaction(reactionMessage);
  if (!reaction) return null;
  const want = fold(reaction.target_text).replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
  if (!want) return null;
  const cutoff = before ? Date.parse(before) : Infinity;
  const candidates = (Array.isArray(events) ? events : [])
    .filter((e) => (Date.parse(e?.sent_at || e?.created_at || "") || 0) <= cutoff)
    .slice()
    .reverse();
  for (const e of candidates) {
    const have = fold(e?.message_body || "").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
    if (!have) continue;
    if (have === want || have.startsWith(want.slice(0, 60)) || want.startsWith(have.slice(0, 60))) {
      return { message_event_id: e.id || null, direction: e.direction || null, matched_text: e.message_body };
    }
  }
  return null;
}

export default interpretEmojiReply;
