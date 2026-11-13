// ─── seller-reply-language.js ────────────────────────────────────────────────
// OWNER RULE (2026-10-05): an auto-reply is written in the language the SELLER
// replied in -- not the language of our opener.
//
//   1. The seller's latest substantive reply decides ("Yes" is English, "Sí" is
//      Spanish, "Estoy interesado en vender" is Spanish).
//   2. A reply too short or ambiguous to tell ("ok", "no", "👍", "250k", a
//      tapback) falls back to the seller's most recent IDENTIFIABLE reply.
//   3. With no identifiable seller text at all, the thread / opener language.
//
// Reactions never count: a tapback quotes OUR message, so its words are ours.
//
// Live case +18177347618: Spanish opener, the seller tapped 👍 several times and
// then typed "Yes". The reply goes in English.

import { parsePlatformReaction } from "./emoji-interpretation.js";
import { detectMessageLanguage, foldReplyText } from "./reply-disposition-signals.js";
import { canonicalizeMultilingualReply } from "./multilingual-short-replies.js";

export const SELLER_REPLY_LANGUAGE_VERSION = "seller_reply_language_v1";

// Short replies that identify their language on their own. Folded (accents
// stripped, lower case, punctuation removed). Deliberately NOT here: "ok",
// "okay", "k", "no" (English AND Spanish), "lol", numbers, emoji.
const SHORT_REPLY_LEXICON = new Map(
  Object.entries({
    English: [
      "yes", "yeah", "yep", "yup", "yea", "yah", "correct", "sure", "right",
      "nope", "nah", "i do", "i am", "still do", "i still do", "yes i do", "yes sir",
      "yes maam", "absolutely", "definitely", "of course", "thanks", "thank you",
      "who is this", "who", "wrong number", "not interested", "sold", "sold it",
      "maybe", "possibly", "how much", "what", "why", "not anymore", "no thanks",
      "no thank you", "yes please", "sounds good", "call me", "huh", "hmm", "what?", "huh?", "whats up",
    ],
    Spanish: [
      "si", "claro", "claro que si", "correcto", "asi es", "gracias", "bueno",
      "quien", "quien es", "no gracias", "ya no", "tal vez", "cuanto", "por que",
      "si senor", "si senora", "de acuerdo", "esta bien", "llamame", "vendido",
      "no se", "nel", "simon", "aja",
    ],
    Portuguese: ["sim", "nao", "obrigado", "obrigada", "talvez"],
    Vietnamese: ["vang", "da", "dung", "dung roi", "khong", "khong phai"],
  }).map(([language, list]) => [language, new Set(list)])
);

const HAITIAN_CREOLE_TOKENS = Object.freeze([
  /\bmwen\b/, /\bnou\b(?!\s+(?:es|son))/, /\bkonnen\b/, /\bvle\b/, /\bvann\b/, /\bkounye\s?a\b/, /\bmesi\b/, /\bkay\s+la\b/,
  /\bpa\s+(?:vle|konnen|bezwen|gen)\b/, /\bbezwen\b/, /\bpou\s+kounye\b/, /\bmen\s+mwen\b/, /\bm\s+(?:vle|pa|konnen)\b/, /\bsa\s+a\b/, /\bkisa\b/, /\bpoukisa\b/,
]);

function foldShort(text) {
  return foldReplyText(text)
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/'/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function letterWords(text) {
  return String(text ?? "")
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w));
}

/**
 * The language ONE seller message identifies, or null when it cannot tell.
 *
 * @param {string} message
 * @param {object} [opts]
 * @param {string|null} [opts.detected_language]  the classifier's detection
 * @param {boolean} [opts.explicit]  the detection came from script / keyword
 *   evidence (not the classifier's English default)
 */
export function identifyReplyLanguage(message, { detected_language = null, explicit = false } = {}) {
  const raw = String(message ?? "").trim();
  if (!raw) return null;
  // A tapback quotes our message: never the seller's language.
  if (parsePlatformReaction(raw)) return null;
  const words = letterWords(raw);
  if (words.length === 0) return null; // emoji, numbers, punctuation

  const detected = String(detected_language ?? "").trim() || null;
  if (explicit && detected) return detected;

  // The other templated languages ("是", "Tak", "Merci") name themselves.
  const multilingual = canonicalizeMultilingualReply(raw);
  if (multilingual?.language) return multilingual.language;

  const folded = foldShort(raw);
  for (const [language, set] of SHORT_REPLY_LEXICON) {
    if (set.has(folded)) return language;
  }

  // Short English real-estate words ("199k sale", "cash offer") identify
  // English even in a thread we opened in another language (round 8).
  if (/^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]+$/u.test(raw) && /\b(?:sale|sell|selling|sold|price|offer|house|home|property|owner|interested|million|thousand|cash|buy|buyer)\b/i.test(folded)) {
    return "English";
  }

  // rc-8.5.21 v3 (RT-46): Haitian Creole shares short function words with Spanish / French ("se", "si",
  // "la", "men") and was read as Spanish — a Creole seller would have been answered in Spanish. Two or
  // more distinctive Creole tokens name the language (an identified, NOT enabled language: held for a
  // person, never Spanish, never English).
  if (HAITIAN_CREOLE_TOKENS.filter((re) => re.test(folded)).length >= 2) return "Haitian Creole";

  const fromWords = detectMessageLanguage(raw);
  if (fromWords) return fromWords;

  // Three or more words is real text (resolve-thread-language.js uses the same
  // threshold for trusting an English detection).
  if (words.length >= 3 && detected) return detected;
  return null;
}

/**
 * The language of the seller's most recent identifiable reply.
 * @param {Array<{message_body?: string, language?: string|null}>} rows  newest first
 */
export function latestIdentifiableSellerLanguage(rows = []) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const language = identifyReplyLanguage(row?.message_body, {
      detected_language: row?.language || null,
      explicit: false,
    });
    if (language) return language;
  }
  return null;
}

/**
 * Resolve the language the reply to THIS inbound must be written in.
 * Returns { language, source } where source is one of
 *   seller_reply | seller_history | thread | detected
 */
export function resolveSellerReplyLanguage({
  message,
  detected_language = null,
  explicit = false,
  seller_history_language = null,
  thread_language = null,
} = {}) {
  const current = identifyReplyLanguage(message, { detected_language, explicit });
  if (current) return { language: current, source: "seller_reply" };
  const history = String(seller_history_language ?? "").trim();
  if (history) return { language: history, source: "seller_history" };
  const thread = String(thread_language ?? "").trim();
  if (thread) return { language: thread, source: "thread" };
  return { language: detected_language || null, source: "detected" };
}

export default resolveSellerReplyLanguage;
