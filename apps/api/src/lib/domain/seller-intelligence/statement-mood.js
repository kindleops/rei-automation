/**
 * statement-mood.js
 *
 * "IS YOUR OFFER 175?" IS NOT "I'LL TAKE 175."
 *
 * These four sentences all contain 175, and only one of them is a seller price:
 *
 *   Is your offer 175?          a QUESTION about our number
 *   Could you do 175?           a REQUEST — testing whether we will
 *   I'll take 175.              an ACCEPTANCE at that number
 *   I need 175.                 a REQUIREMENT — their floor
 *
 * An extractor that sees "175 appears near price words" produces a seller
 * asking price for all four. Two of those are fabricated, and one of them --
 * reading a question as an answer -- means we stop asking a question the seller
 * never answered.
 *
 * ── WHY DETERMINISTIC ──────────────────────────────────────────────────────
 *
 * Mood is grammar, not meaning. A question mark, an interrogative opener, a
 * modal verb: these are protocol-level facts a regular expression reads as
 * reliably as a model does, and far more repeatably. Asking a model to
 * rediscover them each time costs money, adds variance, and gives a
 * prompt-injected message a place to argue.
 *
 * The model's job is what the seller MEANT. This module's job is what kind of
 * sentence they wrote.
 *
 * ── NEGATION AND CORRECTION ────────────────────────────────────────────────
 *
 *   It is NOT vacant.                   negates a fact
 *   I don't need 200 anymore.           retires a previous requirement
 *   Sorry, I meant 190, not 290.        corrects a previous value
 *   The tenant USED TO live there.      a past state, not a current one
 *
 * Each has to survive intact into reconciliation, because each is the seller
 * telling us something we already believe is wrong. Getting these backwards is
 * worse than missing them: it re-asserts the thing being denied.
 */

import { asObject } from "@/lib/hostile-input.js";

export const STATEMENT_MOOD_POLICY_VERSION = "statement_mood_v1";

export const MOOD = Object.freeze({
  ASSERTION: "assertion",
  QUESTION: "question",
  REQUEST: "request",
  HYPOTHETICAL: "hypothetical",
  NEGATION: "negation",
  CORRECTION: "correction",
  PAST_STATE: "past_state",
});

/** Moods that may NOT become an explicit seller fact on their own. */
export const NON_ASSERTIVE_MOODS = Object.freeze(new Set([
  MOOD.QUESTION,
  MOOD.REQUEST,
  MOOD.HYPOTHETICAL,
  MOOD.PAST_STATE,
]));

function clean(value) {
  return String(value ?? "").trim();
}

/** "Sorry, I meant 190, not 290." — checked first; a correction outranks all. */
const CORRECTION = [
  /\b(?:i\s+)?meant\b/i,
  /\bsorry,?\s+(?:i\s+)?(?:meant|that should|make that)\b/i,
  /\bcorrection\b/i,
  /\bmake that\b/i,
  /\bscratch that\b/i,
  /\btypo\b/i,
  /\bi\s+mis(?:spoke|typed|wrote)\b/i,
  /\bnot\s+\$?[\d,.]+\s*(?:k\b)?[\s,.]*(?:i\s+meant|but)\b/i,
];

/** "The tenant used to live there, but they moved out." */
const PAST_STATE = [
  /\bused\s+to\b/i,
  /\bno\s+longer\b/i,
  /\bnot\s+any\s*more\b/i,
  /\banymore\b/i,
  /\bpreviously\b/i,
  /\bat\s+the\s+time\b/i,
  /\bback\s+then\b/i,
  /\bhas\s+since\b/i,
];

/** "It is not vacant." / "I don't need 200." */
const NEGATION = [
  /\b(?:is|are|was|were|am)\s*n[o']t\b/i,
  /\b(?:do|does|did|will|would|can|could|should|have|has|had)\s*n[o']t\b/i,
  /\bnot\s+(?:vacant|occupied|interested|the\s+owner|for\s+sale|listed|selling)\b/i,
  /\bnever\b/i,
  /\bno\s+longer\s+(?:need|want|interested)\b/i,
  /\bi\s+don'?t\s+own\b/i,
];

/** Interrogative openers. A question mark is sufficient but not necessary. */
const QUESTION_OPENER = /^\s*(?:is|are|was|were|do|does|did|can|could|would|will|should|have|has|what|when|where|who|whom|whose|why|how|which)\b/i;

/** "Could you do 175?" — a request tests us; it does not state their number. */
const REQUEST = [
  /\b(?:could|can|would|will)\s+you\b/i,
  /\bany\s+(?:chance|way)\b/i,
  /\bwhat\s+(?:about|if)\b/i,
  /\bhow\s+about\b/i,
  /\bwould\s+you\s+(?:consider|take|do|go)\b/i,
];

/** "If you close before the 20th" — a term offered, conditional on something. */
const HYPOTHETICAL = [
  /\bif\s+you\b/i,
  /\bwhat\s+if\b/i,
  /\bsuppose\b/i,
  /\bhypothetically\b/i,
  /\bdepends\s+on\b/i,
];

/** "I'll take 175." / "I need 175." — the seller committing to a number. */
const ASSERTIVE_COMMIT = [
  /\bi(?:'| a)?ll\s+take\b/i,
  /\bi\s+(?:need|want|require)\b/i,
  /\bi(?:'d| would)\s+(?:take|do|accept|sell)\b/i,
  // Requires a copula. Bare "my number" fires on "how did you get my number",
  // which is a seller asking how we found them -- a canonical intent of its own
  // (asks_how_number_obtained) and the opposite of a commitment.
  /\bmy\s+(?:asking\s+)?(?:price|number|bottom\s+line)\s+(?:is|was|would\s+be|'s)\b/i,
  /\bit'?s\s+yours\b/i,
  /\bthat\s+works\b/i,
];

function matchesAny(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * What kind of sentence is this?
 *
 * Order is deliberate and is the module's actual content:
 *
 *   1 CORRECTION  outranks everything. "Sorry, I meant 190, not 290" contains a
 *                 negation and two numbers; reading it as a negation would
 *                 retire 290 without ever recording 190.
 *   2 PAST_STATE  before NEGATION. "The tenant used to live there" is not a
 *                 denial that anyone lives there; it is a statement about then.
 *   3 QUESTION    before REQUEST and before assertion. A question mark settles
 *                 it: no sentence ending in '?' states a seller fact.
 *   4 NEGATION    before the assertive forms, because "I don't need 200" DOES
 *                 contain "I need 200" and must not read as a requirement.
 *   5 REQUEST / HYPOTHETICAL, then assertion as the default.
 *
 * @returns {{mood, assertive, reasons:string[], policy_version}}
 */
export function classifyStatementMood(raw_text) {
  const text = clean(typeof raw_text === "string" ? raw_text : asObject(raw_text).text);
  if (!text) {
    return verdict(MOOD.ASSERTION, [], { empty: true });
  }

  // MULTI-SENTENCE INPUT IS AGGREGATED, NOT JUDGED AS ONE SENTENCE.
  //
  // "Would you take 185? I'd do 185." is a question AND a commitment. Read as a
  // single string it looks like a request, because it opens like one -- and the
  // commitment, which is the half with consequences, would be lost.
  //
  // Callers that care about WHICH fact came from WHICH sentence should split
  // first; this aggregate exists so that a caller who does not split still
  // cannot silently drop a commitment.
  const sentences = splitSentences(text);
  if (sentences.length > 1) return aggregateMood(sentences);

  const reasons = [];

  if (matchesAny(CORRECTION, text)) return verdict(MOOD.CORRECTION, ["correction_marker"]);

  if (matchesAny(PAST_STATE, text)) {
    // A past-state sentence can still carry a live correction of our belief,
    // which is why it is reported rather than discarded.
    reasons.push("past_state_marker");
    return verdict(MOOD.PAST_STATE, reasons);
  }

  const ends_in_question = /\?\s*$/.test(text);
  if (ends_in_question || QUESTION_OPENER.test(text)) {
    // A question mark is decisive. An interrogative opener is decisive UNLESS
    // the sentence also commits -- "Would you take 185? I'd do 185" is both,
    // and the commitment is the part with consequences.
    if (ends_in_question && !matchesAny(ASSERTIVE_COMMIT, text)) {
      return verdict(MOOD.QUESTION, ["question_mark"]);
    }
    if (!ends_in_question && !matchesAny(ASSERTIVE_COMMIT, text)) {
      return verdict(MOOD.QUESTION, ["interrogative_opener"]);
    }
    reasons.push("interrogative_with_commitment");
  }

  if (matchesAny(NEGATION, text)) return verdict(MOOD.NEGATION, [...reasons, "negation_marker"]);

  if (matchesAny(REQUEST, text)) return verdict(MOOD.REQUEST, [...reasons, "request_form"]);

  if (matchesAny(HYPOTHETICAL, text)) {
    // Conditional, not hypothetical-in-the-idle-sense: "I'd do 185 if you close
    // Friday" is a real offer WITH a condition. Only the commitment settles it.
    if (matchesAny(ASSERTIVE_COMMIT, text)) {
      return verdict(MOOD.ASSERTION, [...reasons, "conditional_commitment"]);
    }
    return verdict(MOOD.HYPOTHETICAL, [...reasons, "conditional_form"]);
  }

  return verdict(MOOD.ASSERTION, reasons);
}

/**
 * Combine per-sentence moods into one verdict, most consequential first.
 *
 * A correction outranks everything: it is the seller telling us a thing we
 * already believe is wrong. A commitment outranks a question, because the cost
 * of missing a stated number is higher than the cost of also noticing a
 * question. A negation outranks the remaining non-assertive forms, because it
 * still has to reach reconciliation to retire what it denies.
 */
function aggregateMood(sentences) {
  const verdicts = sentences.map((sentence) => classifyStatementMood(sentence));

  const correction = verdicts.find((v) => v.mood === MOOD.CORRECTION);
  if (correction) return { ...correction, reasons: [...correction.reasons, "aggregated"] };

  const assertive = verdicts.find((v) => v.mood === MOOD.ASSERTION);
  if (assertive) return { ...assertive, reasons: [...assertive.reasons, "aggregated"] };

  const negation = verdicts.find((v) => v.mood === MOOD.NEGATION);
  if (negation) return { ...negation, reasons: [...negation.reasons, "aggregated"] };

  return { ...verdicts[0], reasons: [...verdicts[0].reasons, "aggregated"] };
}

function verdict(mood, reasons = [], extra = {}) {
  return {
    mood,
    assertive: !NON_ASSERTIVE_MOODS.has(mood),
    reasons,
    policy_version: STATEMENT_MOOD_POLICY_VERSION,
    ...extra,
  };
}

/**
 * May a value found in this sentence become an EXPLICIT seller fact?
 *
 * The single question an extractor asks. A question, a request, a hypothetical
 * or a statement about the past may still produce an assertion -- but never an
 * explicit one, because the seller did not state the thing.
 */
export function permitsExplicitAssertion(raw_text) {
  return classifyStatementMood(raw_text).assertive;
}

/**
 * Split a message into sentences for mood analysis.
 *
 * Mood is per sentence, not per message: "Is your offer 175? I need 195." holds
 * a question and a requirement, and judging the whole message by its first
 * sentence loses the requirement.
 */
export function splitSentences(raw_text) {
  const text = clean(raw_text);
  if (!text) return [];
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export default classifyStatementMood;
